# Shared helpers for the NexaDesk scripts. Use: . "$PSScriptRoot\common.ps1"

function Get-ServerOrigin([string]$root) {
  $u = Join-Path $root 'server-url.txt'
  if (-not (Test-Path $u)) { return '' }
  return ((Get-Content $u -Raw).Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://')
}

# Makes sure the daily + recovery update keys exist (in your user profile, NOT in the project folder) and writes app\www\update-keys.js.
# Stops before building/publishing when the keys do not match what devices trust. Returns @{ Id = daily key id; Trust = ids the apps trust }.
function Initialize-UpdateKeys([string]$root, [string]$RecoveryKey = '') {
  $pub = Get-PublishedManifest $root
  $live = if ($pub -and $pub.trust) { (@($pub.trust) -join ',') } else { '-' }
  $rk = if ($RecoveryKey) { $RecoveryKey } else { '-' }
  $ErrorActionPreference = 'Continue'
  $out = @(& node "$PSScriptRoot\sign-manifest.js" ensure $live $rk 2>&1)
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $out | ForEach-Object { Write-Host "  $_" -ForegroundColor $(if ($_ -match 'RECOVERY|Move this file') { 'Yellow' } else { 'DarkGray' }) }
  if ($code) { throw 'Update key check failed (see above). Nothing was built or published.' }
  $kj = Join-Path $root 'app\www\update-keys.js'
  if (-not (Test-Path $kj) -or ((Get-Content $kj -Raw) -notmatch '"[A-Za-z0-9+/=]{300,}"')) { throw 'app\www\update-keys.js has no keys, so this build would reject every update. Nothing was built or published.' }
  $id = ((@($out) | Where-Object { $_ -match '^KEYID=' }) -replace '^KEYID=', '').Trim()
  $trust = (((@($out) | Where-Object { $_ -match '^TRUST=' }) -replace '^TRUST=', '').Trim()) -split ','
  return [pscustomobject]@{ Id = $id; Trust = $trust }
}

# The manifest the server publishes right now, or $null when there is none or the server cannot be reached.
# $script:ManifestStatus tells which: 'ok', 'nourl' (no server-url.txt), 'none' (server answered, nothing published yet), 'unreachable'.
function Get-PublishedManifest([string]$root) {
  $script:ManifestStatus = 'nourl'
  $origin = Get-ServerOrigin $root
  if (-not $origin) { return $null }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' } -Uri "$origin/update.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $script:ManifestStatus = 'ok'
    return ConvertFrom-Json $r.Content
  } catch {
    $script:ManifestStatus = if ($_.Exception.Response) { 'none' } else { 'unreachable' }
    return $null
  }
}

# Tools installed while a window (or Explorer) was already open are missing from its PATH. Reload PATH from Windows and add the usual
# install folders, so Git, GitHub CLI, Node and the JDK are found without reopening anything. Runs whenever a script loads this file.
function Sync-Path {
  try {
  $parts = @($env:Path -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
  $parts += 'C:\Program Files\Git\cmd', 'C:\Program Files\GitHub CLI', 'C:\Program Files\nodejs'
  if ($env:LOCALAPPDATA) { $parts += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd') }
  foreach ($base in 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft') {
    if (-not (Test-Path $base)) { continue }
    $parts += @(Get-ChildItem $base -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'bin' })
  }
  $seen = @{}; $keep = foreach ($d in $parts) { if ($d -and -not $seen.ContainsKey($d.ToLower()) -and (Test-Path $d -ErrorAction SilentlyContinue)) { $seen[$d.ToLower()] = 1; $d } }
  if ($keep) { $env:Path = $keep -join ';' }
  if (-not $env:JAVA_HOME -and (Get-Command java -ErrorAction SilentlyContinue)) { $j = (Get-Command java).Source; if ($j -match '^(.*)\\bin\\java(\.exe)?$') { $env:JAVA_HOME = $Matches[1] } }
  } catch { }   # never let this convenience break a script
}
Sync-Path

# gh.exe (GitHub CLI) with stderr captured; returns its exit code. Output is kept in $script:ghOut.
function Invoke-Gh { $ErrorActionPreference = 'Continue'; $script:ghOut = & gh.exe @args 2>&1; return $LASTEXITCODE }

# Uploads one file to the 'ota' release and shows a live progress bar + speed. The percentage is measured from the PC's network upload counter
# (gh itself prints nothing when its output is not a terminal), so it is approximate; the speed number tells you if it is slow (a few MB/s) or stuck (~0).
function Send-GhAsset([string]$file, [string]$repo) {
  $size = (Get-Item $file).Length; $name = Split-Path $file -Leaf
  $gh = (Get-Command gh.exe).Source
  $nics = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' })
  $sent = { $t = 0; foreach ($n in $nics) { try { $t += $n.GetIPv4Statistics().BytesSent } catch { } }; $t }
  $base = & $sent; $last = $base; $t0 = Get-Date; $lastT = $t0; $lastPrint = $t0; $slowSince = $null
  $p = Start-Process -FilePath $gh -ArgumentList @('release', 'upload', 'ota', '--repo', $repo, '--clobber', ('"' + $file + '"')) -NoNewWindow -PassThru
  $null = $p.Handle
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 2
    $now = & $sent; $t = Get-Date
    $speed = ($now - $last) / [math]::Max(0.5, ($t - $lastT).TotalSeconds); $last = $now; $lastT = $t
    $done = [math]::Max(0, $now - $base); $pct = [math]::Min(99, [int](100 * $done / $size))
    $el = [int]($t - $t0).TotalSeconds
    $mbps = [math]::Round($speed / 1MB, 2)
    if ($speed -lt 20KB) { if (-not $slowSince) { $slowSince = $t } } else { $slowSince = $null }
    $state = if ($slowSince -and ($t - $slowSince).TotalSeconds -gt 45) { 'NO DATA FLOWING for ' + [int]($t - $slowSince).TotalSeconds + 's - looks stuck (check internet / gh auth)' } else { "$mbps MB/s" }
    Write-Progress -Activity "Uploading $name ($([math]::Round($size / 1MB, 1)) MB)" -Status "$pct%   $state   elapsed ${el}s" -PercentComplete $pct
    if (($t - $lastPrint).TotalSeconds -ge 15) { $lastPrint = $t; Write-Host "    $name  ~$pct%  $state  (${el}s)" -ForegroundColor $(if ($state -like 'NO DATA*') { 'Red' } else { 'DarkGray' }) }
  }
  Write-Progress -Activity "Uploading $name" -Completed
  return $p.ExitCode
}

# Updates the GitHub release 'ota' IN PLACE. The release and its tag are NEVER deleted.
#   1) create the release only if it does not exist yet, otherwise just refresh its title/notes
#   2) upload the new files with --clobber (Setup exe + Portable exe + APK + signed manifest + web bundle)
#   3) only AFTER the upload worked, delete outdated assets: NexaDesk-* binaries (when new binaries were uploaded) and old www-*.zip
# -DryRun prints the plan and changes nothing (use scripts\test-ota-release.ps1).
function Publish-OtaRelease([string]$ver, [string]$sha, [string]$outDir, [string[]]$extra = @(), [switch]$DryRun, [switch]$ForceInstallers) {
  $repo = 'papayasds-ai/Nexa-Remote-Desktop'
  function Get-ReleaseVersion([System.IO.FileInfo]$file) { if ($file.Name -match '-(\d+\.\d+\.\d+)\.(exe|apk)$') { return [version]$Matches[1] }; throw "Unexpected release asset name: $($file.Name)" }
  function Get-LatestReleaseAsset([string]$pattern) { $c = @(Get-ChildItem $outDir -File -Filter $pattern -ErrorAction SilentlyContinue); if (-not $c) { return $null }; return $c | Sort-Object { Get-ReleaseVersion $_ } -Descending | Select-Object -First 1 }
  $setup = Get-LatestReleaseAsset 'NexaDesk-Setup-*.exe'
  $portable = Get-LatestReleaseAsset 'NexaDesk-Portable-*.exe'
  $apk = Get-LatestReleaseAsset 'NexaDesk-*.apk'
  $bins = @($setup, $portable, $apk | Where-Object { $_ })
  $bins = @($bins | Where-Object { $_ })
  if ($setup -and $portable -and (Get-ReleaseVersion $setup) -ne (Get-ReleaseVersion $portable)) { throw 'Setup and Portable EXE versions do not match.' }
  if ($ForceInstallers -and -not ($setup -and $portable -and $apk)) { throw 'Refusing to publish a partial release: Setup EXE, Portable EXE and APK are all required.' }
  # Slow upload line? While the file skip-installer-upload.txt exists in the project folder, the big .exe files are NOT uploaded (only the APK and the small update files);
  # old exe assets stay in the release untouched. Delete that file (or use upload-release.ps1 -WithInstallers) when you are on a fast connection.
  $skipFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'skip-installer-upload.txt'
  $skipped = @()
  if ((Test-Path $skipFile) -and -not $ForceInstallers) {
    $skipped = @($bins | Where-Object { $_.Extension -eq '.exe' }); $bins = @($bins | Where-Object { $_.Extension -ne '.exe' })
    if ($skipped) { Write-Host "Installer .exe files NOT uploaded (skip-installer-upload.txt exists): $(($skipped | ForEach-Object Name) -join ', '). Existing exe assets in the release are kept." -ForegroundColor Yellow }
  }
  $pruneRx = '^www-.*\.zip$'
  if (@($bins | Where-Object { $_.Extension -eq '.exe' }).Count) { $pruneRx += '|^NexaDesk-.*\.(exe|blockmap)$' }
  if (@($bins | Where-Object { $_.Extension -eq '.apk' }).Count) { $pruneRx += '|^NexaDesk-.*\.apk$' }
  $files = New-Object System.Collections.ArrayList
  foreach ($b in $bins) { [void]$files.Add($b.FullName) }
  foreach ($e in $extra) { if ($e -and (Test-Path $e)) { [void]$files.Add($e) } }
  if ($files.Count -eq 0) { Write-Host "GitHub 'ota' release left unchanged: nothing to upload for v$ver." -ForegroundColor Yellow; return }
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw "GitHub CLI is not installed. Run: winget install GitHub.cli" }
  if ((Invoke-Gh auth status -h github.com) -ne 0) { throw "GitHub authentication is invalid. Run 'gh auth login -h github.com' and retry." }
  $keep = @($files | ForEach-Object { Split-Path $_ -Leaf })
  $exists = ((Invoke-Gh release view ota --repo $repo) -eq 0)
  $notes = "NexaDesk OTA v$ver`n`n" + (($bins | ForEach-Object { Split-Path $_.FullName -Leaf }) -join "`n") + "`n`nWindows Setup installs the machine-wide input service and requires Windows administrator approval. Portable runs without installing that service. The Android APK is signed for existing NexaDesk installs."
  if ($DryRun) {
    Write-Host "[dry-run] release 'ota' exists: $exists (it is never deleted)" -ForegroundColor Cyan
    Write-Host "[dry-run] would upload (--clobber): $($keep -join ', ')" -ForegroundColor Cyan
    if ($exists -and ((Invoke-Gh release view ota --repo $repo --json assets --jq '.assets[].name') -eq 0)) {
      $stale = @($script:ghOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and ($keep -notcontains $_) -and ($_ -match $pruneRx) })
      Write-Host "[dry-run] would delete only these outdated assets: $(if ($stale) { $stale -join ', ' } else { '(none)' })" -ForegroundColor Cyan
    }
    return
  }
  if (-not $exists) {
    if ((Invoke-Gh release create ota --repo $repo --target $sha --title "NexaDesk v$ver" --notes $notes) -ne 0) { Write-Host "GitHub 'ota' release could not be created:`n$($script:ghOut)" -ForegroundColor Red; return }
  } elseif ($bins.Count -gt 0) {
    [void](Invoke-Gh release edit ota --repo $repo --title "NexaDesk v$ver" --notes $notes)   # cosmetic: a failure here is not fatal
  }
  # one file at a time, smallest first, with gh's own progress visible (it used to be captured silently, so a ~400 MB upload looked like a hang)
  $upOk = $true
  foreach ($f in @($files | Sort-Object { (Get-Item $_).Length })) {
    $mb = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Write-Host "  uploading $(Split-Path $f -Leaf) ($mb MB) - big files take a few minutes, this is normal..." -ForegroundColor Cyan
    $code = 1
    for ($try = 1; $try -le 3 -and $code; $try++) {   # GitHub drops slow uploads with HTTP 408: retry the same file (--clobber replaces a half-uploaded one)
      if ($try -gt 1) { Write-Host "  retry $try of 3 for $(Split-Path $f -Leaf) ..." -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
      $code = Send-GhAsset $f $repo
    }
    if ($code) { Write-Host "  upload of $(Split-Path $f -Leaf) FAILED (exit $code). The release and its old files were left untouched. Run again to retry." -ForegroundColor Red; $upOk = $false; break }
  }
  if (-not $upOk) { return }
  if ((Invoke-Gh release view ota --repo $repo --json assets --jq '.assets[].name') -eq 0) {
    $stale = @($script:ghOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and ($keep -notcontains $_) -and ($_ -match $pruneRx) })
    foreach ($s in $stale) { if ((Invoke-Gh release delete-asset ota $s --repo $repo --yes) -ne 0) { Write-Host "Could not remove old asset ${s}: $($script:ghOut)" -ForegroundColor Yellow } else { Write-Host "  removed old asset $s" -ForegroundColor DarkGray } }
  }
  Write-Host "GitHub 'ota' release updated in place to v$ver ($($files.Count) file(s)): https://github.com/$repo/releases/tag/ota" -ForegroundColor Green
}
