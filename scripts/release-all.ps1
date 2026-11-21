# One-click: make sure the server exists, bump version, build EXE + APK, publish OTA to GitHub, ping all devices.
param([switch]$AllowInsecure, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"   # also refreshes PATH, so freshly installed tools are found
# Preflight: check everything the release needs BEFORE the long builds and list what is missing in one go.
$need = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $need += 'Node.js 18+        ->  winget install OpenJS.NodeJS.LTS' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $need += 'Git                ->  winget install Git.Git' }
if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { $need += 'GitHub CLI        ->  winget install GitHub.cli' }
else {
  $ErrorActionPreference = 'Continue'; & gh.exe auth status *> $null; $ghOk = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
  if (-not $ghOk) { $need += 'GitHub login      ->  gh auth login   (once; choose GitHub.com, HTTPS, log in with the browser)' }
}
if ($need.Count) { throw ("Install / do these first, then close this window, run NexaDesk.bat again and choose 1:`n  " + ($need -join "`n  ")) }
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { Write-Host "Note: JDK 17 was not found, so the Android APK will be skipped. To include it: winget install EclipseAdoptium.Temurin.17.JDK (then reopen this window)." -ForegroundColor Yellow }
$urlFile = Join-Path $root 'server-url.txt'
if (-not (Test-Path $urlFile)) { & "$PSScriptRoot\deploy-cloudflare.ps1" }
if (-not (Test-Path $urlFile)) { throw 'Server setup did not finish. Read the messages above.' }
& "$PSScriptRoot\bump-version.ps1"
$u = (Get-Content $urlFile -Raw).Trim()
& "$PSScriptRoot\build-windows.ps1" -ServerUrl $u -NoBump
try {
  if ($AllowInsecure) { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump -AllowInsecure } else { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump }
} catch { Write-Host "`nAndroid build skipped: $($_.Exception.Message)" -ForegroundColor Yellow }
& "$PSScriptRoot\publish-ota.ps1" -NoBump -Force:$Force
Write-Host "`nAll done. Installers are in output\" -ForegroundColor Green
