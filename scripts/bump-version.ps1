# Chooses the version number of the next release and writes it to VERSION. Two procedures:
#   AUTO   (no parameter)  base = the HIGHEST of VERSION, desktop\package.json and the live server (never a lower one).
#                          If that base is not live yet it is used as it is (a pending release); otherwise the next patch number.
#   MANUAL -Set 1.0.35     exactly that number - refused unless it is higher than what is live now (devices never install lower ones).
param([string]$Set = '')
. "$PSScriptRoot\common.ps1"
$root = Split-Path $PSScriptRoot -Parent
$f = Join-Path $root 'VERSION'
function V([string]$s) { if ($s -match '^\d+\.\d+\.\d+$') { [version]$s } else { [version]'0.0.0' } }
$local = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '1.0.0' }
$pkgVer = try { [string](Get-Content (Join-Path $root 'desktop\package.json') -Raw | ConvertFrom-Json).version } catch { '' }
$pub = Get-PublishedManifest $root
$live = if ($pub -and $pub.version) { [string]$pub.version } else { '' }
$unreachable = ($script:ManifestStatus -eq 'unreachable')
if ($unreachable) { Write-Host 'Warning: the server could not be reached, so the live version is unknown.' -ForegroundColor Yellow }
if ($Set) {
  $Set = $Set.Trim().TrimStart('v')
  if ($Set -notmatch '^\d+\.\d+\.\d+$') { throw "Version '$Set' is not valid. Use three numbers, for example 1.0.35" }
  if ($live -and (V $Set) -le (V $live)) { throw "v$Set is not higher than the version that is live now (v$live). Devices only install HIGHER versions - choose a number above v$live." }
  $new = $Set; $how = 'manual'
} else {
  $base = $local
  foreach ($c in @($live, $pkgVer)) { if ((V $c) -gt (V $base)) { $base = $c } }
  if (-not $unreachable -and (V $base) -gt (V $live)) { $new = $base; $how = 'auto, pending release' }
  else { $p = $base.Split('.'); $p[2] = [string]([int]$p[2] + 1); $new = $p -join '.'; $how = 'auto, next number' }
}
$new | Set-Content $f -Encoding ASCII
Write-Host "Version: this folder v$local, live $(if ($live) { 'v' + $live } else { 'none' }) -> v$new [$how]" -ForegroundColor Cyan
