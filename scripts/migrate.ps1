# Brings your local settings from an older NexaDesk folder into this one (a new zip never contains them):
#   server-url.txt, notify-token.txt, release-host.txt, github-repo.txt, signing\ (Android keystore, legacy keys), VERSION (if higher)
#   NexaDesk.bat migrate                 looks for the newest older NexaDesk folder next to this one / in Downloads
#   NexaDesk.bat migrate -From "C:\path\to\old\NexaDesk"
# The update signing keys live in %USERPROFILE%\.nexadesk and need no copying.
param([string]$From = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$mine = $root.TrimEnd('\').ToLower()
function Test-Old([string]$d) { $d -and (Test-Path $d) -and ($d.TrimEnd('\').ToLower() -ne $mine) -and ((Test-Path (Join-Path $d 'server-url.txt')) -or (Test-Path (Join-Path $d 'signing'))) }
if (-not $From) {
  $cands = @()
  $parent = Split-Path $root -Parent
  foreach ($base in @($parent, (Split-Path $parent -Parent), (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:USERPROFILE 'Documents'))) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    $cands += @(Get-ChildItem $base -Directory -Filter 'NexaDesk*' -ErrorAction SilentlyContinue | ForEach-Object FullName)
    $cands += @(Get-ChildItem $base -Directory -Filter 'NexaDesk*' -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem $_.FullName -Directory -Filter 'NexaDesk*' -ErrorAction SilentlyContinue } | ForEach-Object FullName)
  }
  $From = @($cands | Select-Object -Unique | Where-Object { Test-Old $_ } | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1)[0]
}
if (-not (Test-Old $From)) { Write-Host 'No older NexaDesk folder found. Run:  NexaDesk.bat migrate -From "C:\path\to\old\NexaDesk"' -ForegroundColor Yellow; exit 1 }
Write-Host "Importing settings from $From" -ForegroundColor Cyan
foreach ($f in 'server-url.txt', 'notify-token.txt', 'release-host.txt', 'github-repo.txt') {
  $src = Join-Path $From $f; if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $root $f
  if ((Test-Path $dst) -and $f -eq 'github-repo.txt') { continue }          # the new zip knows the repository
  Copy-Item $src $dst -Force; Write-Host "  copied $f" -ForegroundColor DarkGray
}
$sg = Join-Path $From 'signing'
if (Test-Path $sg) { New-Item -ItemType Directory -Force (Join-Path $root 'signing') | Out-Null; Copy-Item (Join-Path $sg '*') (Join-Path $root 'signing') -Recurse -Force; Write-Host '  copied signing\ (Android keystore + legacy keys)' -ForegroundColor DarkGray }
$vOld = Join-Path $From 'VERSION'; $vNew = Join-Path $root 'VERSION'
try {
  $o = [version](Get-Content $vOld -Raw).Trim(); $n = if (Test-Path $vNew) { [version](Get-Content $vNew -Raw).Trim() } else { [version]'0.0.0' }
  if ($o -gt $n) { Copy-Item $vOld $vNew -Force; Write-Host "  VERSION $n -> $o" -ForegroundColor DarkGray }
} catch { }
Write-Host 'Done. Your update keys are in %USERPROFILE%\.nexadesk (nothing to copy).' -ForegroundColor Green
