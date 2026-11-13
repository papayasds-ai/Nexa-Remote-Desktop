param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid broker version: $Version" }
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'desktop\inputbroker\NexaDeskInputBroker.cs'
$dist = Join-Path $root 'desktop\inputbroker\dist'
$build = Join-Path $root 'desktop\inputbroker\build'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw ".NET Framework 4.x C# compiler was not found: $csc" }
if (-not (Test-Path $source)) { throw "Input broker source was not found: $source" }
New-Item -ItemType Directory -Force $dist | Out-Null
New-Item -ItemType Directory -Force $build | Out-Null
$versionSource = Join-Path $build 'BrokerVersion.g.cs'
$exe = Join-Path $dist "NexaDeskInputBroker-$Version.exe"
$assemblyVersion = $Version + '.0'
$attributes = @"
using System.Reflection;
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyProduct("NexaDesk Elevated Input Broker")]
"@
[IO.File]::WriteAllText($versionSource, $attributes, (New-Object Text.UTF8Encoding $false))
Get-ChildItem $dist -File -Filter 'NexaDeskInputBroker-*.exe' | Where-Object { $_.Name -ne (Split-Path $exe -Leaf) } | Remove-Item -Force
& $csc /nologo /target:winexe /platform:x64 "/out:$exe" /reference:System.ServiceProcess.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Security.dll /reference:System.Core.dll $source $versionSource
if ($LASTEXITCODE -ne 0) { throw "Input broker compiler returned $LASTEXITCODE." }
$fileVersion = (Get-Item $exe).VersionInfo.FileVersion
if ($fileVersion -notlike "$Version*") { throw "Broker file version '$fileVersion' does not match $Version." }
Write-Host "Built $exe (file version $fileVersion)" -ForegroundColor Green
