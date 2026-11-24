# Android-only release: build the APK with the existing signing key, publish its signed OTA manifest and bundle,
# and deploy them to the Cloudflare Worker. GitHub login is optional.
param([switch]$AllowInsecure, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.12 or newer is required.' }
if ([version]((node -v).TrimStart('v')) -lt [version]'22.12.0') { throw 'Node.js 22.12 or newer is required.' }
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'JDK 17 is required to build the Android APK.' }
$urlFile = Join-Path $root 'server-url.txt'
if (-not (Test-Path $urlFile)) { throw 'The server URL is missing. Run NexaDesk.bat and choose 6 (Repair / create the server) first.' }
$server = (Get-Content $urlFile -Raw).Trim()
$previousVersion = if (Test-Path (Join-Path $root 'VERSION')) { (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() } else { '' }
$releaseVersion = ''
try {
  & "$PSScriptRoot\bump-version.ps1"
  $releaseVersion = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  if ($AllowInsecure) { & "$PSScriptRoot\build-android.ps1" -ServerUrl $server -NoBump -AllowInsecure }
  else { & "$PSScriptRoot\build-android.ps1" -ServerUrl $server -NoBump }
  if ($Force) { & "$PSScriptRoot\publish-ota.ps1" -NoBump -Force }
  else { & "$PSScriptRoot\publish-ota.ps1" -NoBump }
} catch {
  if ($previousVersion -and $releaseVersion) {
    Set-Content -LiteralPath (Join-Path $root 'VERSION') -Value $previousVersion -Encoding ASCII
    Write-Host "Release failed; restored VERSION to $previousVersion so the next attempt reuses v$releaseVersion." -ForegroundColor Yellow
  }
  throw
}
Write-Host "`nAndroid release complete. APK and signed OTA are in output\ and ota\." -ForegroundColor Green
