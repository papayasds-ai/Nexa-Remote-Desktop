# Builds NexaDesk for Windows -> output\NexaDesk-Setup-<version>.exe and output\NexaDesk-Portable-<version>.exe
param([switch]$NoBump, [string]$ServerUrl = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ownLog = $false; try { New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null; Start-Transcript -Path (Join-Path $root 'logs\build-windows.log') -Force | Out-Null; $ownLog = $true } catch { }   # full build output is saved to logs\build-windows.log
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

$brokerName = "NexaDeskInputBroker-$ver.exe"
& "$PSScriptRoot\build-input-broker.ps1" -Version $ver

$desk = Join-Path $root 'desktop'
Remove-Item (Join-Path $desk 'www') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'app\www') (Join-Path $desk 'www') -Recurse
"window.NEXA_DEFAULT_SERVER = $(ConvertTo-Json $ServerUrl -Compress); window.NEXA_VERSION = `"$ver`";" | Set-Content (Join-Path $desk 'www\config.js') -Encoding UTF8
$origin = ($ServerUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://')
$idx = Join-Path $desk 'www\index.html'; [IO.File]::WriteAllText($idx, [IO.File]::ReadAllText($idx).Replace('__OTA_ORIGIN__', $origin), (New-Object Text.UTF8Encoding $false))
$prefix = if ($origin -match '^https://') { "$origin/" } else { '' }
$relFile = Join-Path $root 'release-host.txt'
$relPrefix = if (Test-Path $relFile) { (Get-Content $relFile -Raw).Trim().TrimEnd('/') + '/' } else { '' }
[IO.File]::WriteAllText((Join-Path $desk 'build-config.json'), (@{ otaPrefix = $prefix; releasePrefix = $relPrefix; inputBrokerName = $brokerName } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
$installerInclude = @"
!macro customInstall
  ExecWait '"`$INSTDIR\resources\inputbroker\$brokerName" --install-service "`$INSTDIR\resources\inputbroker\$brokerName" "`$INSTDIR\`${APP_EXECUTABLE_FILENAME}"' `$R0
  `${If} `$R0 != 0
    MessageBox MB_ICONSTOP|MB_OK "NexaDesk could not install or start its elevated input service (exit `$R0). Setup will stop."
    Abort "Could not install NexaDesk elevated input service."
  `${EndIf}
!macroend

!macro customUnInstall
  `${IfNot} `${isUpdated}
    ExecWait '"`$INSTDIR\resources\inputbroker\$brokerName" --uninstall-service' `$R1
  `${EndIf}
!macroend
"@
$buildDir = Join-Path $desk 'build'; New-Item -ItemType Directory -Force $buildDir | Out-Null
[IO.File]::WriteAllText((Join-Path $buildDir 'installer.nsh'), $installerInclude, (New-Object Text.UTF8Encoding $false))

Push-Location $desk
try {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm install failed' }
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
  Get-ChildItem $out -Filter "NexaDesk-Setup-$ver.exe" -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem $out -Filter "NexaDesk-Portable-$ver.exe" -ErrorAction SilentlyContinue | Remove-Item -Force
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
  Get-ChildItem $out -Filter 'NexaDesk-Portable-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force   # the portable build is now the single-file Portable .exe
  Write-Host "`nDone (v$ver). Windows builds are in: $out" -ForegroundColor Green
} finally { Pop-Location; if ($ownLog) { try { Stop-Transcript | Out-Null } catch { } } }
