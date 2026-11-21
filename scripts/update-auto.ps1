# "Update": does the right thing by itself.
#   - only the UI / logic (app\www) changed  -> quick update: no rebuild, every device gets it within a minute
#   - the app package itself changed (desktop\main.js, preload, input helper, icons, build settings, Android package.json)
#     -> FULL release (new EXE + APK + GitHub + server). A quick update cannot deliver those parts: the installed EXE would stay as it is.
param([switch]$Force, [switch]$NoBump, [switch]$WithPortable, [switch]$RetryUpload, [switch]$AllowInsecure, [string]$AppKey = '', [string]$RecoveryKey = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
if ($RetryUpload) { & "$PSScriptRoot\publish-ota.ps1" -RetryUpload; return }
$stamp = Join-Path $root 'native-build.hash'
$now = Get-NativeFingerprint $root
$old = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
if ($old -ne $now) {
  Write-Host "`nThe app package itself changed since the last build (desktop\main.js, preload, input helper, icons or build settings)." -ForegroundColor Yellow
  Write-Host "A quick update cannot deliver that, so this runs the FULL release: new EXE + APK + GitHub + server + devices." -ForegroundColor Yellow
  Write-Host "Afterwards install the new NexaDesk-Setup on this PC (output\) unless it updates itself.`n" -ForegroundColor Yellow
  $a = @{}; if ($Force) { $a.Force = $true }; if ($AllowInsecure) { $a.AllowInsecure = $true }
  & "$PSScriptRoot\release-all.ps1" @a
} else {
  Write-Host "`nOnly the UI/logic changed: quick update (no rebuild)." -ForegroundColor Cyan
  $a = @{}; foreach ($n in 'Force', 'NoBump', 'WithPortable') { if ((Get-Variable $n).Value) { $a[$n] = $true } }
  if ($AppKey) { $a.AppKey = $AppKey }; if ($RecoveryKey) { $a.RecoveryKey = $RecoveryKey }
  & "$PSScriptRoot\publish-ota.ps1" @a
}
