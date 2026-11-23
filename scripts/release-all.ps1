# One-click: build EXE + APK and publish the signed OTA package to Cloudflare; GitHub is an optional mirror.
param([switch]$AllowInsecure, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"   # also refreshes PATH, so freshly installed tools are found
# Preflight: check everything the release needs BEFORE the long builds and list what is missing in one go.
$need = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $need += 'Node.js 22.12+    ->  winget install OpenJS.NodeJS.LTS' }
elseif ([version]((node -v).TrimStart('v')) -lt [version]'22.12.0') { $need += 'Node.js 22.12+    ->  update Node.js LTS, then reopen this window' }
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { $need += 'JDK 17            ->  winget install EclipseAdoptium.Temurin.17.JDK' }
$ghOk = $false
if ((Get-Command gh.exe -ErrorAction SilentlyContinue) -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  $ErrorActionPreference = 'Continue'; & gh.exe auth status *> $null; $ghOk = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
}
if (-not $ghOk) { Write-Host 'GitHub is not signed in; the Cloudflare Android and OTA release will still publish. GitHub mirroring will be skipped.' -ForegroundColor Yellow }
if ($need.Count) { throw ("Install / do these first, then close this window, run NexaDesk.bat again and choose 1:`n  " + ($need -join "`n  ")) }
$urlFile = Join-Path $root 'server-url.txt'
$versionFile = Join-Path $root 'VERSION'
$previousVersion = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { '' }
$releaseVersion = ''
try {
if (-not (Test-Path $urlFile)) { & "$PSScriptRoot\deploy-cloudflare.ps1" }
if (-not (Test-Path $urlFile)) { throw 'Server setup did not finish. Read the messages above.' }
& "$PSScriptRoot\bump-version.ps1"
$releaseVersion = (Get-Content $versionFile -Raw).Trim()
$u = (Get-Content $urlFile -Raw).Trim()
$repoSlug = if ($ghOk) { Resolve-GitHubRepo $root } else { '' }
$cloudSha = ''
. "$PSScriptRoot\cloud-windows.ps1"
if ($ghOk -and (Test-CloudWindows $root $repoSlug)) {
  Initialize-UpdateKeys $root | Out-Null   # writes app\www\update-keys.js, which the cloud build needs
  $cv = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  $cw = Invoke-CloudWindowsBuild $root $repoSlug $cv $u (Join-Path $root 'build')
  if ($cw.ok) { $cloudSha = $cw.setupSha; Get-CloudInstallers $root $repoSlug $cv } else { Write-Host 'Cloud build did not work, building on this PC instead.' -ForegroundColor Yellow }
}
if (-not $cloudSha) { & "$PSScriptRoot\build-windows.ps1" -ServerUrl $u -NoBump }
if ($AllowInsecure) { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump -AllowInsecure } else { & "$PSScriptRoot\build-android.ps1" -ServerUrl $u -NoBump }
if ($cloudSha) {
  if ($Force) { & "$PSScriptRoot\publish-ota.ps1" -NoBump -CloudSha $cloudSha -Force }
  else { & "$PSScriptRoot\publish-ota.ps1" -NoBump -CloudSha $cloudSha }
} else {
  if ($Force) { & "$PSScriptRoot\publish-ota.ps1" -NoBump -Force }
  else { & "$PSScriptRoot\publish-ota.ps1" -NoBump }
}
Write-Host "`nAll done. Installers are in output\" -ForegroundColor Green
} catch {
  if ($previousVersion -and $releaseVersion) {
    $published = Get-PublishedManifest $root
    if (-not $published -or $published.version -ne $releaseVersion) {
      Set-Content -LiteralPath $versionFile -Value $previousVersion -Encoding ASCII
      Write-Host "Release failed before v$releaseVersion went live; restored VERSION to $previousVersion." -ForegroundColor Yellow
    }
  }
  throw
}
