# Safe check of the GitHub 'ota' release logic: prints what WOULD be uploaded/deleted. Changes nothing, deletes nothing.
#   powershell -File scripts\test-ota-release.ps1
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
$ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
$extra = @(Get-ChildItem (Join-Path $root 'ota') -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
Publish-OtaRelease $ver 'HEAD' (Join-Path $root 'output') $extra -DryRun
& node "$PSScriptRoot\check-release.js"
exit $LASTEXITCODE
