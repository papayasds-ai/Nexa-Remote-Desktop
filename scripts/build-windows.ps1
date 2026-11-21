# Builds NexaDesk for Windows -> output\NexaDesk-Setup-<version>.exe and output\NexaDesk-Portable-<version>.exe
param([switch]$NoBump, [string]$ServerUrl = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
Initialize-UpdateKeys $root | Out-Null
foreach ($c in 'node', 'npm') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c not found. Install Node.js 18+ LTS from https://nodejs.org" } }
$nodeVer = [version]((node -v).TrimStart('v'))
if ($nodeVer -lt [version]'22.12.0') { throw "Node.js 22.12 or newer is required (found $nodeVer). Install the current LTS from https://nodejs.org" }
$urlFile = Join-Path $root 'server-url.txt'
if (-not $ServerUrl -and (Test-Path $urlFile)) { $ServerUrl = (Get-Content $urlFile -Raw).Trim() }
if ($ServerUrl -and $ServerUrl -notmatch '^wss?://') { throw 'Server URL must start with wss:// or ws://' }
if (-not $NoBump) { & "$PSScriptRoot\bump-version.ps1" }
$ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()

$desk = Join-Path $root 'desktop'
Remove-Item (Join-Path $desk 'www') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'app\www') (Join-Path $desk 'www') -Recurse
"window.NEXA_DEFAULT_SERVER = $(ConvertTo-Json $ServerUrl -Compress); window.NEXA_VERSION = `"$ver`";" | Set-Content (Join-Path $desk 'www\config.js') -Encoding UTF8
$origin = ($ServerUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://')
$idx = Join-Path $desk 'www\index.html'; [IO.File]::WriteAllText($idx, [IO.File]::ReadAllText($idx).Replace('__OTA_ORIGIN__', $origin), (New-Object Text.UTF8Encoding $false))
$prefix = if ($origin -match '^https://') { "$origin/" } else { '' }
$relFile = Join-Path $root 'release-host.txt'
$relPrefix = if (Test-Path $relFile) { (Get-Content $relFile -Raw).Trim().TrimEnd('/') + '/' } else { $g = Resolve-GitHubRepo $root -Create; if ($g) { "https://github.com/$g/releases/download/ota/" } else { '' } }
[IO.File]::WriteAllText((Join-Path $desk 'build-config.json'), (@{ otaPrefix = $prefix; releasePrefix = $relPrefix } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))

Push-Location $desk
try {
  Install-Packages $desk -Block runtime    # Electron itself ships inside the app, so its advisories block; build tools (electron-builder) never ship
  npm version $ver --no-git-tag-version --allow-same-version | Out-Null
  Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
  $pfx = Join-Path $root 'signing\codesign.pfx'
  if (Test-Path $pfx) {
    $env:CSC_LINK = $pfx
    $env:CSC_KEY_PASSWORD = (Get-Content (Join-Path $root 'signing\codesign-password.txt') -Raw).Trim()
    Write-Host 'Code signing: signing\codesign.pfx' -ForegroundColor Cyan
  } else { Write-Host 'Code signing: no certificate (signing\codesign.pfx), the EXE will be unsigned' -ForegroundColor Yellow }
  npm run dist
  if ($LASTEXITCODE) { throw 'electron-builder failed' }
  $out = Join-Path $root 'output'; New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -Filter 'NexaDesk*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force   # previous builds
  $setup = Get-ChildItem dist -Filter 'NexaDesk-Setup-*.exe' | Select-Object -First 1
  $port  = Get-ChildItem dist -Filter 'NexaDesk-Portable-*.exe' | Select-Object -First 1
  $copies = @()
  if ($setup) { $copies += Join-Path $out "NexaDesk-Setup-$ver.exe";    Copy-Item $setup.FullName $copies[-1] -Force }
  if ($port)  { $copies += Join-Path $out "NexaDesk-Portable-$ver.exe"; Copy-Item $port.FullName  $copies[-1] -Force }
  foreach ($c in $copies) {
    $fv = (Get-Item $c).VersionInfo.FileVersion
    Write-Host ("  {0}  (file version inside: {1})" -f (Split-Path $c -Leaf), $fv) -ForegroundColor DarkGray
    if ($fv -notlike "$ver*") { Write-Host "  WARNING: version inside the EXE is '$fv', expected $ver" -ForegroundColor Yellow }
  }
  # Fast portable: the unpacked app folder as a ZIP. Extract it anywhere and run NexaDesk.exe - it starts instantly, because nothing is unpacked at launch
  # (the Portable .exe unpacks ~150 MB into a temp folder on EVERY launch, and Windows scans all of it each time).
  try {
    $unpacked = Join-Path (Get-Location).Path 'dist\win-unpacked'
    if (Test-Path (Join-Path $unpacked 'NexaDesk.exe')) {
      Get-ChildItem $out -Filter 'NexaDesk-Portable-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force
      $pz = Join-Path $out "NexaDesk-Portable-$ver.zip"
      $stage = Join-Path $env:TEMP 'nexadesk-zip-stage'; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force $stage | Out-Null
      Copy-Item $unpacked (Join-Path $stage 'NexaDesk') -Recurse
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $pz, [System.IO.Compression.CompressionLevel]::Optimal, $false)
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "  NexaDesk-Portable-$ver.zip  (fast portable: extract anywhere, run NexaDesk.exe)" -ForegroundColor DarkGray
    }
  } catch { Write-Host "  Could not create the portable ZIP: $($_.Exception.Message)" -ForegroundColor Yellow }
  Get-NativeFingerprint $root | Set-Content (Join-Path $root 'native-build.hash') -Encoding ASCII   # remembers what this EXE contains
  Write-Host "`nDone (v$ver). Windows builds are in: $out" -ForegroundColor Green
} finally { Pop-Location }
