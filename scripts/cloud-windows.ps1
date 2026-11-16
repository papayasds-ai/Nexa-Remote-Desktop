# Builds the big Windows installers (Setup + Portable) ON GITHUB instead of uploading them from this PC (loaded by ota-assets.ps1).
# Active while the file cloud-windows.txt exists in the project folder. Delete that file to go back to building and uploading on this PC.
# Keep this file ASCII only (Windows PowerShell 5.1 reads it as ANSI).

function Invoke-GitC { $ErrorActionPreference = 'Continue'; $script:gitOut = & git.exe @args 2>&1; return $LASTEXITCODE }

# Copies the project source (a few MB, no secrets, no build output) into the GitHub repo, the same way publish-ota.ps1 does.
function Sync-SourceToGitHub([string]$root, [string]$dir) {
  $repo = $script:GhRepo
  [void](Invoke-Gh auth setup-git)   # git then uses the GitHub CLI login (it has the 'workflow' permission that pushing .github\workflows needs)
  Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  if ((Invoke-GitC clone --depth 1 "https://github.com/$repo.git" $dir) -ne 0) { Write-Host "git clone failed:`n$($script:gitOut -join "`n")" -ForegroundColor Red; return $false }
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
    if (-not (@($script:gitOut) | Where-Object { "$_".Trim() })) { Write-Host '  source code on GitHub is already up to date' -ForegroundColor DarkGray; return $true }
    $tracked = (& git.exe ls-files) -join "`n"
    if ($tracked -match '\.jks|\.pem|\.keystore|\.server-secret|notify-token|keystore-password') { Write-Host 'Refusing to upload: a secret file would be included.' -ForegroundColor Red; return $false }
    if ((Invoke-GitC -c user.name=NexaDesk -c user.email=release@nexadesk.local commit -m 'Source for cloud build') -ne 0) { Write-Host "git commit failed:`n$($script:gitOut -join "`n")" -ForegroundColor Red; return $false }
    if ((Invoke-GitC push origin HEAD:main) -ne 0) { Write-Host "git push failed:`n$($script:gitOut -join "`n")" -ForegroundColor Red; return $false }
    Write-Host '  source code sent to GitHub' -ForegroundColor DarkGray
    return $true
  } finally { Pop-Location }
}

# Starts the workflow build-windows.yml on GitHub, waits for it, and returns @{ ok; setupSha; portableSha }.
# When it succeeds, NexaDesk-Setup-<ver>.exe and NexaDesk-Portable-<ver>.exe are already on the release 'ota'.
function Invoke-CloudWindowsBuild([string]$root, [string]$ver, [string]$server, [string]$workDir) {
  $repo = $script:GhRepo
  $fail = [pscustomobject]@{ ok = $false; setupSha = ''; portableSha = '' }
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { Write-Host 'GitHub CLI is not installed (winget install GitHub.cli).' -ForegroundColor Red; return $fail }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Write-Host 'Git is not installed (winget install Git.Git).' -ForegroundColor Red; return $fail }
  if ((Invoke-Gh auth status) -ne 0) { Write-Host "Run 'gh auth login' once, then try again." -ForegroundColor Red; return $fail }
  Write-Host 'Cloud build: Windows installers are built on GitHub (nothing big is uploaded from this PC).' -ForegroundColor Cyan
  if (-not (Sync-SourceToGitHub $root (Join-Path $workDir 'srcsync'))) { return $fail }
  $prefix = (Get-ReleaseHost $root).TrimEnd('/') + '/'
  $before = [int64]0
  if ((Invoke-Gh run list --repo $repo --workflow build-windows.yml --limit 1 --json databaseId --jq '.[0].databaseId') -eq 0) { $s = (@($script:ghOut) -join '').Trim(); if ($s -match '^\d+$') { $before = [int64]$s } }
  $started = $false
  for ($i = 1; $i -le 8 -and -not $started; $i++) {   # a workflow that was pushed a moment ago needs a few seconds to be known
    if ((Invoke-Gh workflow run build-windows.yml --repo $repo --ref main -f "version=$ver" -f "server=$server" -f "release_prefix=$prefix") -eq 0) { $started = $true } else { Start-Sleep -Seconds 10 }
  }
  if (-not $started) { Write-Host "Could not start the GitHub build: $(@($script:ghOut) -join ' ')`nCheck that GitHub Actions is enabled: https://github.com/$repo/settings/actions" -ForegroundColor Red; return $fail }
  $id = [int64]0
  for ($i = 0; $i -lt 30 -and -not $id; $i++) {
    Start-Sleep -Seconds 4
    if ((Invoke-Gh run list --repo $repo --workflow build-windows.yml --limit 5 --json databaseId --jq '.[].databaseId') -eq 0) {
      foreach ($l in @($script:ghOut)) { if ("$l".Trim() -match '^\d+$' -and [int64]"$l".Trim() -gt $before) { $id = [Math]::Max($id, [int64]"$l".Trim()) } }
    }
  }
  if (-not $id) { Write-Host "The GitHub build was started but its run was not found. Look at https://github.com/$repo/actions" -ForegroundColor Red; return $fail }
  Write-Host "  GitHub is building v$ver (about 5-10 minutes): https://github.com/$repo/actions/runs/$id" -ForegroundColor Cyan
  $t0 = Get-Date; $lastPrint = $t0; $concl = ''
  while ($true) {
    Start-Sleep -Seconds 15
    $el = [int]((Get-Date) - $t0).TotalSeconds
    if ($el -gt 2700) { Write-Host 'The GitHub build took longer than 45 minutes. Open the run page above to see why.' -ForegroundColor Red; return $fail }
    $rc = Invoke-Gh run view $id --repo $repo --json status,conclusion --jq '.status + " " + .conclusion'
    if ($rc -ne 0) {   # second way to read the status, and say so instead of waiting silently
      $why = (@($script:ghOut) -join ' ')
      $rc = Invoke-Gh run list --repo $repo --workflow build-windows.yml --limit 10 --json databaseId,status,conclusion --jq ".[] | select(.databaseId==$id) | .status + \" \" + .conclusion"
      if ($rc -ne 0 -or -not @($script:ghOut)) { Write-Host "    could not read the build status (${el}s): $why" -ForegroundColor Yellow; continue }
    }
    $st = ("$(@($script:ghOut)[0])").Trim()
    if ($st -like 'completed*') { $concl = ($st -replace '^completed\s*', '').Trim(); break }
    Write-Progress -Activity "GitHub builds NexaDesk v$ver" -Status "$st   elapsed ${el}s" -PercentComplete -1
    if (((Get-Date) - $lastPrint).TotalSeconds -ge 45) { $lastPrint = Get-Date; Write-Host "    building on GitHub ... $st (${el}s)" -ForegroundColor DarkGray }
  }
  Write-Progress -Activity "GitHub builds NexaDesk v$ver" -Completed
  if ($concl -ne 'success') {
    Write-Host "The GitHub build FAILED ($concl). Last lines of its log:" -ForegroundColor Red
    [void](Invoke-Gh run view $id --repo $repo --log-failed)
    @($script:ghOut) | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host "Full log: https://github.com/$repo/actions/runs/$id" -ForegroundColor Yellow
    return $fail
  }
  $dl = Join-Path $workDir 'cloudwin'; New-Item -ItemType Directory -Force $dl | Out-Null
  Remove-Item (Join-Path $dl "win-$ver.json") -Force -ErrorAction SilentlyContinue
  if ((Invoke-Gh release download ota --repo $repo --pattern "win-$ver.json" --dir $dl --clobber) -ne 0) { Write-Host "Could not read win-$ver.json from the release: $(@($script:ghOut) -join ' ')" -ForegroundColor Red; return $fail }
  try { $info = Get-Content (Join-Path $dl "win-$ver.json") -Raw | ConvertFrom-Json } catch { Write-Host 'win json is unreadable.' -ForegroundColor Red; return $fail }
  if ($info.version -ne $ver -or -not $info.setup.sha256) { Write-Host 'The cloud build returned data for a different version.' -ForegroundColor Red; return $fail }
  $v = Get-OtaAssetList
  if (-not $v.ok) { Write-Host 'Could not check the release on GitHub.' -ForegroundColor Red; return $fail }
  foreach ($k in @($info.setup, $info.portable)) {
    $a = @($v.assets | Where-Object { $_.name -eq $k.name }) | Select-Object -First 1
    if (-not $a -or [long]$a.size -ne [long]$k.size) { Write-Host "$($k.name) is not complete on the release." -ForegroundColor Red; return $fail }
  }
  Write-Host "  built and verified on GitHub: $($info.setup.name), $($info.portable.name)" -ForegroundColor Green
  return [pscustomobject]@{ ok = $true; setupSha = [string]$info.setup.sha256; portableSha = [string]$info.portable.sha256 }
}

# After the new version is live: remove the Setup / Portable / json files of older versions from the release (the release itself is never deleted).
function Remove-OldWinAssets([string]$ver) {
  $v = Get-OtaAssetList
  if (-not $v.ok) { return }
  $keep = @("NexaDesk-Setup-$ver.exe", "NexaDesk-Portable-$ver.exe", "win-$ver.json")
  foreach ($n in @($v.assets | ForEach-Object { $_.name } | Where-Object { $_ -match '^NexaDesk-(Setup|Portable)-\d+\.\d+\.\d+\.exe(\.blockmap)?$|^win-\d+\.\d+\.\d+\.json$' -and ($keep -notcontains $_) })) {
    if ((Invoke-Gh release delete-asset ota $n --repo $script:GhRepo --yes) -eq 0) { Write-Host "  removed old asset $n" -ForegroundColor DarkGray }
  }
}
