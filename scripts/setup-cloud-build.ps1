# One-time setup of the CLOUD BUILD: GitHub builds the Windows + Android apps for every release, so the big installers are never uploaded from this PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-cloud-build.ps1
# What it does: lets the GitHub CLI push workflow files, stores your server address and the Android signing key as GitHub repository secrets
# (GitHub keeps them encrypted; they are only used by the build), and switches the release scripts to cloud mode.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
$repo = 'papayasds-ai/NexaDesk'
try {
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw 'GitHub CLI is not installed: winget install GitHub.cli, then gh auth login' }
  if ((Invoke-Gh auth status) -ne 0) { throw "Run 'gh auth login' first." }
  $urlFile = Join-Path $root 'server-url.txt'
  if (-not (Test-Path $urlFile)) { throw 'server-url.txt is missing (run START-HERE option 8 first).' }
  $ks = Join-Path $root 'signing\nexadesk.jks'; $pw = Join-Path $root 'signing\keystore-password.txt'
  if (-not (Test-Path $ks) -or -not (Test-Path $pw)) { throw 'The Android signing key (signing\nexadesk.jks) does not exist yet: build the APK once with START-HERE option 7, then run this again.' }
  Write-Host "`n1/4  Allowing the GitHub CLI to push workflow files. A code + browser page may open: approve it, then come back here." -ForegroundColor Cyan
  & gh.exe auth refresh -h github.com -s workflow
  if ($LASTEXITCODE) { throw 'gh auth refresh failed' }
  Write-Host "2/4  Storing the server address (a repository variable)..." -ForegroundColor Cyan
  $u = (Get-Content $urlFile -Raw).Trim()
  if ((Invoke-Gh variable set NEXA_SERVER --repo $repo --body $u) -ne 0) { throw "Could not set the variable: $($script:ghOut)" }
  Write-Host "3/4  Storing the Android signing key as encrypted repository secrets..." -ForegroundColor Cyan
  [Convert]::ToBase64String([IO.File]::ReadAllBytes($ks)) | & gh.exe secret set ANDROID_KEYSTORE_B64 --repo $repo
  if ($LASTEXITCODE) { throw 'Could not store ANDROID_KEYSTORE_B64' }
  (Get-Content $pw -Raw).Trim() | & gh.exe secret set ANDROID_KEYSTORE_PASSWORD --repo $repo
  if ($LASTEXITCODE) { throw 'Could not store ANDROID_KEYSTORE_PASSWORD' }
  Write-Host "4/4  Switching the release scripts to cloud mode..." -ForegroundColor Cyan
  'https://github.com/papayasds-ai/NexaDesk/releases/download/ota' | Set-Content (Join-Path $root 'release-host.txt') -Encoding ASCII
  'Cloud build is ON: releases are built on GitHub (.github\workflows\native-build.yml). Delete this file to go back to local builds.' | Set-Content (Join-Path $root 'cloud-build.txt') -Encoding ASCII
  Remove-Item (Join-Path $root 'skip-installer-upload.txt') -Force -ErrorAction SilentlyContinue
  Write-Host "`nDone. Now run START-HERE option 3 (or 1/2): every release builds the EXE + APK on GitHub and the installed apps update themselves." -ForegroundColor Green
  Write-Host "ONE-TIME: after the first cloud release, download NexaDesk-Setup-<version>.exe from https://github.com/$repo/releases/tag/ota and install it once on each PC (older apps cannot trust the new installer address); from then on updates are automatic." -ForegroundColor Yellow
} catch {
  Write-Host "`nSETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
exit 0
