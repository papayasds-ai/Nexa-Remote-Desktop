# Checks (and with -Fix repairs) every package folder: install from the lockfile, npm audit, safe fixes, deprecated packages.
#   NexaDesk.bat security          report
#   NexaDesk.bat security -Force   also apply fixes that need MAJOR upgrades (backups are made; test the app afterwards)
#   NexaDesk.bat security -Fix     also update packages within their allowed version ranges and apply npm audit fix
param([switch]$Fix, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required: winget install OpenJS.NodeJS.LTS' }
$failed = @()
foreach ($p in @(@('desktop', 'runtime'), @('android-app', 'shipped'), @('server', 'shipped'), @('cloudflare', 'none'))) {
  $d = Join-Path $root $p[0]
  if (-not (Test-Path (Join-Path $d 'package.json'))) { continue }
  Write-Host "`n== $($p[0])" -ForegroundColor Cyan
  try { Install-Packages $d -Block $p[1] -Update:$Fix -Fix:$Fix -ForceFix:$Force } catch { $failed += $p[0]; Write-Host "  $($_.Exception.Message)" -ForegroundColor Red }
}
if ($failed.Count) { Write-Host "`nNeeds attention: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host "`nAll package folders are clean (or only have the warnings listed above)." -ForegroundColor Green
