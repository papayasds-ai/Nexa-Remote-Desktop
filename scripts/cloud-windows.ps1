# Builds the big Windows installers (Setup + Portable) ON GITHUB instead of uploading them from this PC (used by release-all.ps1).
# Active while the file cloud-windows.txt exists in the project folder (and release-host.txt does not). Delete cloud-windows.txt to build and upload on this PC again.
# Keep this file ASCII only (Windows PowerShell 5.1 reads it as ANSI).

function Invoke-GhC { $ErrorActionPreference = 'Continue'; $script:cwOut = & gh.exe @args 2>&1; return $LASTEXITCODE }
function Invoke-GitC { $ErrorActionPreference = 'Continue'; $script:cwOut = & git.exe @args 2>&1; return $LASTEXITCODE }

# True when the cloud build can and should be used for this project.
function Test-CloudWindows([string]$root, [string]$repo) {
  if (-not (Test-Path (Join-Path $root 'cloud-windows.txt'))) { return $false }
  if (Test-Path (Join-Path $root 'release-host.txt')) { Write-Host 'Cloud build skipped: release-host.txt is set (installers go to your own host).' -ForegroundColor Yellow; return $false }
  if (-not $repo -or -not (Get-Command gh.exe -ErrorAction SilentlyContinue) -or -not (Get-Command git.exe -ErrorAction SilentlyContinue)) { return $false }
  if ((Invoke-GhC repo view $repo --json visibility --jq .visibility) -ne 0 -or (("$(@($script:cwOut)[0])").Trim() -ne 'PUBLIC')) {
    Write-Host "Cloud build skipped: $repo must be a PUBLIC repository so that apps can download the installers." -ForegroundColor Yellow; return $false
  }
  return $true
}

# Copies the project source (a few MB, no secrets, no build output) into the GitHub repo, the same way publish-ota.ps1 does.
function Sync-SourceToGitHub([string]$root, [string]$repo, [string]$dir) {
  [void](Invoke-GhC auth setup-git)
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  if ((Invoke-GitC clone --depth 1 "https://github.com/$repo.git" $dir) -ne 0) { Write-Host "git clone failed:`n$($script:cwOut -join "`n")" -ForegroundColor Red; return $false }
  $skip = @('.git', 'node_modules', 'build', 'output', 'signing', '.wrangler') + @('desktop\www', 'android-app\www', 'android-app\android', 'ota' | ForEach-Object { Join-Path $root $_ })
  robocopy $root $dir /E /XD @skip /XF .server-secret server-url.txt notify-token.txt config.json keystore-password.txt *.jks *.keystore *.pem /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host 'Copying the source files failed.' -ForegroundColor Red; return $false }
  Push-Location $dir
  try {
    foreach ($f in @(& git.exe ls-files)) {
      if ($f -like 'ota/*' -or $f -like '.git*') { continue }
      if (-not (Test-Path (Join-Path $root $f))) { [void](Invoke-GitC rm -q -- $f) }
    }
    [void](Invoke-GitC add -A)
    [void](Invoke-GitC status --porcelain)
    if (-not (@($script:cwOut) | Where-Object { "$_".Trim() })) { Write-Host '  source code on GitHub is already up to date' -ForegroundColor DarkGray; return $true }
    $tracked = (& git.exe ls-files) -join "`n"
    if ($tracked -match '\.jks|\.pem|\.keystore|\.server-secret|notify-token|keystore-password') { Write-Host 'Refusing to upload: a secret file would be included.' -ForegroundColor Red; return $false }
    if ((Invoke-GitC -c user.name=NexaDesk -c user.email=release@nexadesk.local commit -m 'Source for cloud build') -ne 0) { Write-Host "git commit failed:`n$($script:cwOut -join "`n")" -ForegroundColor Red; return $false }
    if ((Invoke-GitC push origin HEAD:main) -ne 0) { Write-Host "git push failed:`n$($script:cwOut -join "`n")" -ForegroundColor Red; return $false }
    Write-Host '  source code sent to GitHub' -ForegroundColor DarkGray
    return $true
  } finally { Pop-Location }
}

# Starts the workflow build-windows.yml on GitHub, waits for it, and returns @{ ok; setupSha; portableSha }.
# When it succeeds, NexaDesk-Setup-<ver>.exe and NexaDesk-Portable-<ver>.exe are already on the release 'ota'.
function Invoke-CloudWindowsBuild([string]$root, [string]$repo, [string]$ver, [string]$server, [string]$workDir) {
  $fail = [pscustomobject]@{ ok = $false; setupSha = ''; portableSha = '' }
  if ((Invoke-GhC auth status) -ne 0) { Write-Host "Run 'gh auth login' once, then try again." -ForegroundColor Red; return $fail }
  Write-Host 'Cloud build: the Windows installers are built on GitHub (nothing big is uploaded from this PC).' -ForegroundColor Cyan
  if (-not (Sync-SourceToGitHub $root $repo (Join-Path $workDir 'srcsync'))) { return $fail }
  if ((Invoke-GhC release view ota --repo $repo) -ne 0) {
    if ((Invoke-GhC release create ota --repo $repo --target main --title "NexaDesk v$ver" --notes "NexaDesk v$ver") -ne 0) { Write-Host "GitHub release 'ota' could not be created:`n$($script:cwOut -join "`n")" -ForegroundColor Red; return $fail }
  }
  $prefix = "https://github.com/$repo/releases/download/ota/"
  $before = [int64]0
  if ((Invoke-GhC run list --repo $repo --workflow build-windows.yml --limit 1 --json databaseId --jq '.[0].databaseId') -eq 0) { $s = (@($script:cwOut) -join '').Trim(); if ($s -match '^\d+$') { $before = [int64]$s } }
  $started = $false
  for ($i = 1; $i -le 8 -and -not $started; $i++) {   # a workflow that was pushed a moment ago needs a few seconds to be known
    if ((Invoke-GhC workflow run build-windows.yml --repo $repo --ref main -f "version=$ver" -f "server=$server" -f "release_prefix=$prefix") -eq 0) { $started = $true } else { Start-Sleep -Seconds 10 }
  }
  if (-not $started) { Write-Host "Could not start the GitHub build: $(@($script:cwOut) -join ' ')`nCheck that GitHub Actions is enabled: https://github.com/$repo/settings/actions" -ForegroundColor Red; return $fail }
  $id = [int64]0
  for ($i = 0; $i -lt 30 -and -not $id; $i++) {
    Start-Sleep -Seconds 4
    if ((Invoke-GhC run list --repo $repo --workflow build-windows.yml --limit 5 --json databaseId --jq '.[].databaseId') -eq 0) {
      foreach ($l in @($script:cwOut)) { if ("$l".Trim() -match '^\d+$' -and [int64]"$l".Trim() -gt $before) { $id = [Math]::Max($id, [int64]"$l".Trim()) } }
    }
  }
  if (-not $id) { Write-Host "The GitHub build was started but its run was not found. Look at https://github.com/$repo/actions" -ForegroundColor Red; return $fail }
  Write-Host "  GitHub is building v$ver (about 2-10 minutes): https://github.com/$repo/actions/runs/$id" -ForegroundColor Cyan
  $t0 = Get-Date; $lastPrint = $t0; $concl = ''
  while ($true) {
    Start-Sleep -Seconds 15
    $el = [int]((Get-Date) - $t0).TotalSeconds
    if ($el -gt 2700) { Write-Host 'The GitHub build took longer than 45 minutes. Open the run page above to see why.' -ForegroundColor Red; return $fail }
    # no quotes inside --jq (Windows PowerShell 5.1 splits such arguments): read the plain JSON and parse it here
    $st = ''
    $rc = Invoke-GhC run view $id --repo $repo --json 'status,conclusion'
    if ($rc -eq 0) { try { $j = ($script:cwOut -join "`n") | ConvertFrom-Json; $st = ("$($j.status) $($j.conclusion)").Trim() } catch { $st = '' } }
    if (-not $st) {
      $why = (@($script:cwOut) -join ' ')
      $rc = Invoke-GhC run list --repo $repo --workflow build-windows.yml --limit 10 --json 'databaseId,status,conclusion'
      if ($rc -eq 0) { try { $j = (($script:cwOut -join "`n") | ConvertFrom-Json) | Where-Object { [int64]$_.databaseId -eq $id } | Select-Object -First 1; if ($j) { $st = ("$($j.status) $($j.conclusion)").Trim() } } catch { $st = '' } }
      if (-not $st) { Write-Host "    could not read the build status (${el}s): $why" -ForegroundColor Yellow; continue }
    }
    if ($st -like 'completed*') { $concl = ($st -replace '^completed\s*', '').Trim(); break }
    if (((Get-Date) - $lastPrint).TotalSeconds -ge 45) { $lastPrint = Get-Date; Write-Host "    building on GitHub ... $st (${el}s)" -ForegroundColor DarkGray }
  }
  if ($concl -ne 'success') {
    Write-Host "The GitHub build FAILED ($concl). Last lines of its log:" -ForegroundColor Red
    [void](Invoke-GhC run view $id --repo $repo --log-failed)
    @($script:cwOut) | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host "Full log: https://github.com/$repo/actions/runs/$id" -ForegroundColor Yellow
    return $fail
  }
  $dl = Join-Path $workDir 'cloudwin'; New-Item -ItemType Directory -Force $dl | Out-Null
  Remove-Item (Join-Path $dl "win-$ver.json") -Force -ErrorAction SilentlyContinue
  if ((Invoke-GhC release download ota --repo $repo --pattern "win-$ver.json" --dir $dl --clobber) -ne 0) { Write-Host "Could not read win-$ver.json from the release: $(@($script:cwOut) -join ' ')" -ForegroundColor Red; return $fail }
  try { $info = Get-Content (Join-Path $dl "win-$ver.json") -Raw | ConvertFrom-Json } catch { Write-Host 'win json is unreadable.' -ForegroundColor Red; return $fail }
  if ($info.version -ne $ver -or -not $info.setup.sha256) { Write-Host 'The cloud build returned data for a different version.' -ForegroundColor Red; return $fail }
  if ((Invoke-GhC release view ota --repo $repo --json assets) -ne 0) { Write-Host 'Could not check the release on GitHub.' -ForegroundColor Red; return $fail }
  try { $assets = @((($script:cwOut -join "`n") | ConvertFrom-Json).assets) } catch { Write-Host 'Could not read the release assets.' -ForegroundColor Red; return $fail }
  foreach ($k in @($info.setup, $info.portable)) {
    $a = @($assets | Where-Object { $_.name -eq $k.name }) | Select-Object -First 1
    if (-not $a -or [long]$a.size -ne [long]$k.size) { Write-Host "$($k.name) is not complete on the release." -ForegroundColor Red; return $fail }
  }
  Write-Host "  built and verified on GitHub: $($info.setup.name), $($info.portable.name)" -ForegroundColor Green
  return [pscustomobject]@{ ok = $true; setupSha = [string]$info.setup.sha256; portableSha = [string]$info.portable.sha256 }
}

# Copies the installers built on GitHub into output\ (downloads are fast), so the folder holds them like after a local build. Best effort.
function Get-CloudInstallers([string]$root, [string]$repo, [string]$ver) {
  $out = Join-Path $root 'output'; New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -Filter 'NexaDesk-Setup-*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "NexaDesk-Setup-$ver.exe" } | Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($n in @("NexaDesk-Setup-$ver.exe", "NexaDesk-Portable-$ver.exe")) {
    if (Test-Path (Join-Path $out $n)) { continue }
    Write-Host "  downloading $n to output\ ..." -ForegroundColor DarkGray
    if ((Invoke-GhC release download ota --repo $repo --pattern $n --dir $out --clobber) -ne 0) { Write-Host "  could not download ${n}: $(@($script:cwOut) -join ' ')" -ForegroundColor Yellow }
  }
}
