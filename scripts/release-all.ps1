# One-click: make sure the server exists, bump version, build EXE + APK, publish OTA to GitHub, ping all devices.
param([switch]$AllowInsecure)
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
$repoSlug = Resolve-GitHubRepo $root
$cloudSha = ''
. "$PSScriptRoot\cloud-windows.ps1"
if (Test-CloudWindows $root $repoSlug) {
  Initialize-UpdateKeys $root | Out-Null   # writes app\www\update-keys.js, which the cloud build needs
  $cv = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  $cw = Invoke-CloudWindowsBuild $root $repoSlug $cv $u (Join-Path $root 'build')
  if ($cw.ok) { $cloudSha = $cw.setupSha; Get-CloudInstallers $root $repoSlug $cv } else { Write-Host 'Cloud build did not work, building on this PC instead.' -ForegroundColor Yellow }
}
if (-not $cloudSha) { & "$PSScriptRoot\build-windows.ps1" -ServerUrl $u -NoBump }
try {
  if ($AllowInsecure) { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump -AllowInsecure } else { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump }
} catch { Write-Host "`nAndroid build skipped: $($_.Exception.Message)" -ForegroundColor Yellow }
if ($cloudSha) { & "$PSScriptRoot\publish-ota.ps1" -NoBump -CloudSha $cloudSha } else { & "$PSScriptRoot\publish-ota.ps1" -NoBump }
Write-Host "`nAll done. Installers are in output\" -ForegroundColor Green
