# Re-uploads the ALREADY BUILT files of the current version to the GitHub release 'ota' (no rebuild, no version bump, nothing else touched).
# Use it when the upload step of a release failed (for example HTTP 408 on a slow connection).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-release.ps1                  (APK + small files; exes skipped while skip-installer-upload.txt exists)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-release.ps1 -WithInstallers   (also the Setup + Portable exe: needs a fast connection)
param([switch]$WithInstallers)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
try {
  $ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  $extra = @(Get-ChildItem (Join-Path $root 'ota') -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
  Write-Host "Uploading v$ver from output\ to the GitHub release 'ota' (the release itself is never deleted)..." -ForegroundColor Cyan
  Publish-OtaRelease $ver 'main' (Join-Path $root 'output') $extra -ForceInstallers:$WithInstallers
} catch {
  Write-Host "`nUPLOAD FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
exit 0
