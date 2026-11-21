# Next version = one patch above the newer of (this folder's VERSION, the version the server publishes).
# The number therefore always goes up, even when the local VERSION file is old.
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
$f = Join-Path $root 'VERSION'
$local = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '1.0.0' }
$pub = Get-PublishedManifest $root
$published = if ($pub -and $pub.version) { [string]$pub.version } else { '' }
if ($script:ManifestStatus -eq 'unreachable') { Write-Host 'Warning: the server could not be reached; using the local VERSION only.' -ForegroundColor Yellow }
$base = $local
if ($published -and ([version]$published -gt [version]$local)) { $base = $published }
# never go backwards: also look at the version named on the GitHub release 'ota', and never go below 1.0.94 (devices already run 1.0.9x)
try { $gr = Resolve-GitHubRepo $root; if ($gr -and (Get-Command gh.exe -ErrorAction SilentlyContinue)) { $ErrorActionPreference = 'Continue'; $rt = [string](& gh.exe release view ota --repo $gr --json name --jq .name 2>$null); $ErrorActionPreference = 'Stop'; if ($rt -match '(\d+\.\d+\.\d+)' -and ([version]$Matches[1] -gt [version]$base)) { $base = $Matches[1] } } } catch { }
if ([version]$base -lt [version]'1.0.94') { $base = '1.0.94' }
$p = $base.Split('.'); $p[2] = [string]([int]$p[2] + 1)
$new = $p -join '.'
$new | Set-Content $f -Encoding ASCII
Write-Host "Version: local $local, published $(if ($published) { $published } else { 'none' }) -> $new" -ForegroundColor Cyan
