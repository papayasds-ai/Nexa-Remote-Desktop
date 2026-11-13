# Automatic releases. Started every few minutes by Task Scheduler once install-auto-release.ps1 has been run.
#   - web layer changed (app\www): quick update (publish-ota)
#   - native sources changed (desktop\, android-app\package.json): full build and release (release-all)
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root 'build'; New-Item -ItemType Directory -Force $build | Out-Null
$lock = Join-Path $build 'publish.lock'
$logFile = Join-Path $build 'auto-release.log'
function Log([string]$m) { "$(Get-Date -Format s)  $m" | Add-Content $logFile }
function Fingerprint([string[]]$paths) {
  $lines = $paths | Where-Object { Test-Path $_ } | Sort-Object | ForEach-Object { $_.Substring($root.Length) + ' ' + (Get-FileHash $_ -Algorithm SHA256).Hash }
  $sha = [Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))))).Replace('-', '').ToLower()
}
$web = @(Get-ChildItem (Join-Path $root 'app\www') -File -Recurse | Where-Object { $_.Name -ne 'update-keys.js' } | ForEach-Object FullName)
$native = @(Get-ChildItem (Join-Path $root 'desktop') -File | Where-Object { $_.Extension -in '.js', '.ps1', '.json', '.ico', '.png' } | ForEach-Object FullName) +
          @((Join-Path $root 'android-app\package.json'))
$webNow = Fingerprint $web; $nativeNow = Fingerprint $native
$webStamp = Join-Path $build 'auto-release.hash'; $nativeStamp = Join-Path $build 'auto-native.hash'
if (-not (Test-Path $webStamp) -or -not (Test-Path $nativeStamp)) {
  $webNow | Set-Content $webStamp -Encoding ASCII; $nativeNow | Set-Content $nativeStamp -Encoding ASCII
  Log 'baseline recorded - nothing published'; exit 0
}
$webChanged = (Get-Content $webStamp -Raw).Trim() -ne $webNow
$nativeChanged = (Get-Content $nativeStamp -Raw).Trim() -ne $nativeNow
if (-not $webChanged -and -not $nativeChanged) { exit 0 }
if (Test-Path $lock) { if (((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 90) { exit 0 }; Remove-Item $lock -Force -ErrorAction SilentlyContinue; Log 'stale lock removed' }
$failStamp = Join-Path $build 'auto-release.failed'; $combined = $webNow + $nativeNow
if ((Test-Path $failStamp) -and ((Get-Content $failStamp -Raw).Trim() -eq $combined)) { exit 0 }   # this exact content already failed: wait for a new change instead of retrying every 10 minutes
& node --check (Join-Path $root 'app\www\app.js'); if ($LASTEXITCODE) { Log 'app.js has a syntax error - not published'; exit 1 }
& node --check (Join-Path $root 'desktop\main.js'); if ($LASTEXITCODE) { Log 'main.js has a syntax error - not published'; exit 1 }

New-Item -ItemType File -Force $lock | Out-Null
try {
  if ($nativeChanged) {
    & "$PSScriptRoot\release-all.ps1"
    if ($LASTEXITCODE) { throw "release-all.ps1 exit $LASTEXITCODE" }
    Log 'native sources changed: full release built and published'
  } else {
    & "$PSScriptRoot\publish-ota.ps1"
    if ($LASTEXITCODE) { throw "publish-ota.ps1 exit $LASTEXITCODE" }
    Log 'web layer changed: update published'
  }
  $webNow | Set-Content $webStamp -Encoding ASCII; $nativeNow | Set-Content $nativeStamp -Encoding ASCII
  Remove-Item $failStamp -Force -ErrorAction SilentlyContinue
} catch {
  $combined | Set-Content $failStamp -Encoding ASCII
  Log ('release failed: ' + $_.Exception.Message); exit 1
} finally { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
