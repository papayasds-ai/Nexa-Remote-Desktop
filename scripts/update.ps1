# The ONE way to publish an update to all devices (Windows PCs + Android). Started by START-HERE.bat options 1-3.
#   -Mode auto    the version number is chosen for you (next one up)
#   -Mode manual  you type the version number (must be higher than the live one) and pick the options
#   -Scope quick  UI/logic only (app\www): no rebuild, devices update in seconds
#   -Scope full   also rebuilds the EXE + APK (needed after changes in desktop\ or the Android plugins)
#   -Optional     NORMAL release: each device follows its own setting (automatic when idle, or waits for its Install button).
#                 Without it the release is FORCED: every device installs it after a short warning, whatever its setting.
param([ValidateSet('auto', 'manual')][string]$Mode = 'auto', [ValidateSet('quick', 'full', '')][string]$Scope = '', [string]$Version = '', [switch]$Optional, [string]$Notes = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
$pub = Get-PublishedManifest $root
$live = if ($pub -and $pub.version) { 'v' + $pub.version } else { 'nothing yet' }
Write-Host "Live on the server: $live   |   this folder: v$((Get-Content (Join-Path $root 'VERSION') -Raw).Trim())" -ForegroundColor Cyan
try {   # a missing relay is the usual reason a phone on mobile data cannot connect
  $u = (Get-Content (Join-Path $root 'server-url.txt') -Raw).Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://'
  if ((Invoke-RestMethod "$u/health" -TimeoutSec 8).turn -eq $false) { Write-Host 'WARNING: the server has no TURN relay, so phones on 5G/4G and strict networks cannot connect. Run START-HERE option T once.' -ForegroundColor Yellow }
} catch { }
if ($Mode -eq 'manual') {
  if (-not $Version) { $Version = (Read-Host 'Version number to publish (example 1.0.35, must be higher than the live one)').Trim() }
  if (-not $Scope) { $Scope = if ((Read-Host 'Update type: [Q] quick (UI/logic only)   [F] full (rebuild EXE + APK)   [Q/F]') -match '^[Ff]') { 'full' } else { 'quick' } }
  if (-not $PSBoundParameters.ContainsKey('Optional')) { if ((Read-Host 'Forced? Every device installs it after a short warning [Y/n]') -match '^[Nn]') { $Optional = [switch]$true } }
  if (-not $Notes) { $Notes = Read-Host 'Short release notes the users will see (optional, Enter to skip)' }
} elseif (-not $Scope) { $Scope = 'quick' }
$a = @{}
if ($Version) { $a.Version = $Version }
if ($Notes) { $a.Notes = $Notes.Trim() }
if ($Optional) { $a.NoForce = $true }
Write-Host ('Publishing: ' + $Scope + ' update, ' + $(if ($Optional) { 'normal (each device decides)' } else { 'FORCED' }) + ', version ' + $(if ($Version) { $Version } else { 'chosen automatically' })) -ForegroundColor Cyan
if ($Scope -eq 'full') { & "$PSScriptRoot\release-all.ps1" @a } else { & "$PSScriptRoot\publish-ota.ps1" @a }
if ($LASTEXITCODE) { Write-Host "`nUpdate did not complete (exit $LASTEXITCODE). Read the red lines above." -ForegroundColor Red; exit $LASTEXITCODE }
exit 0
