# Turns automatic web-layer releases on or off for the current Windows user (no administrator rights needed).
#   install-auto-release.ps1            on  (checks every 10 minutes)
#   install-auto-release.ps1 -Remove    off
param([switch]$Remove)
$script = Join-Path $PSScriptRoot 'auto-release.ps1'
$name = 'NexaDesk AutoRelease'
if ($Remove) {
  schtasks /Delete /TN $name /F | Out-Null
  Write-Host 'Automatic releases are off.' -ForegroundColor Yellow
  return
}
$tr = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"' + $script + '\"'
schtasks /Create /F /TN $name /SC MINUTE /MO 10 /TR $tr | Out-Null
if ($LASTEXITCODE) { throw 'Could not create the scheduled task.' }
Write-Host 'Automatic releases are on (every 10 minutes). Log: build\auto-release.log' -ForegroundColor Green
