# Re-uploads the ALREADY BUILT files of the current version to the GitHub release 'ota' (no rebuild, no version bump).
# Use it when an upload failed (for example HTTP 408 on a slow connection). Files already on GitHub with the same checksum are skipped.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-release.ps1                (APK + Setup exe + the small update files)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-release.ps1 -WithPortable  (also the big Portable exe)
# Note: this does not change update.json. To make apps install a new app package, publish a new full release (START-HERE option 1).
param([switch]$WithPortable)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
try {
  $ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  $out = Join-Path $root 'output'
  $extra = @(Get-ChildItem (Join-Path $root 'ota') -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
  Write-Host "Uploading v$ver to the GitHub release 'ota' (the release itself is never deleted)..." -ForegroundColor Cyan
  $r = @(Publish-OtaInstallers $ver $out); Write-Host "APK + Setup exe complete on GitHub: $($r[-1])"
  if ($WithPortable) { $r2 = @(Publish-OtaInstallers $ver $out -Portable); Write-Host "Portable exe complete on GitHub: $($r2[-1])" }
  Publish-OtaRelease $ver 'main' $out $extra -NoInstallers
} catch {
  Write-Host "`nUPLOAD FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
exit 0
