# Publishes a web-layer OTA update to GitHub: ota/update.json + ota/www-<version>.zip (old packages are erased),
# syncs the source code, updates the server, then pings every online device so they update immediately.
param([switch]$NoBump, [switch]$Force, [switch]$NoForce, [string]$AppKey = '', [string]$RecoveryKey = '', [string]$Version = '', [string]$Notes = '')   # -RecoveryKey <file>: publish with the offline recovery key (daily key lost)   # -AppKey <id|none>: legacy bridge for apps installed before signing was removed
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
$repoUrl = 'https://github.com/papayasds-ai/Nexa-Remote-Desktop.git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required: https://git-scm.com/download/win' }
function Invoke-Git { $ErrorActionPreference = 'Continue'; & git.exe @args; if ($LASTEXITCODE) { throw "git $($args -join ' ') failed" } }
# (Invoke-Gh and Publish-OtaRelease live in common.ps1: the 'ota' release is updated in place, never deleted.)
try {
$nodeVer = [version]((node -v).TrimStart('v'))
if ($nodeVer -lt [version]'22.12.0') { throw "Node.js 22.12 or newer is required (found $nodeVer). Install the current LTS from https://nodejs.org" }
$keys = Initialize-UpdateKeys $root -RecoveryKey $RecoveryKey
# update.sig2 (daily or recovery key) is what current apps verify. update.sig is only a bridge for apps installed BEFORE signing was reworked:
# Only apps installed BEFORE that change still demand a signature: when a key file for them is in signing\
# (your current key, or the one named with -AppKey), the manifest is also signed for them so they can take this update without a reinstall.
$ErrorActionPreference = 'Continue'
$legacyOut = @(& node "$PSScriptRoot\sign-manifest.js" legacy-id $AppKey 2>&1)
$ErrorActionPreference = 'Stop'
$legacyOut | Where-Object { $_ -notmatch '^[0-9a-f]{16}$' -and $_ } | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
$legacyId = [string](@($legacyOut | Where-Object { $_ -match '^[0-9a-f]{16}$' }) | Select-Object -First 1)
$urlFile = Join-Path $root 'server-url.txt'
if (-not (Test-Path $urlFile)) { Write-Host 'No server yet - creating it on Cloudflare first...' -ForegroundColor Yellow; & "$PSScriptRoot\deploy-cloudflare.ps1" }
if (-not (Test-Path $urlFile)) { throw 'Server setup did not finish. Run option 5 and read the messages.' }
$server = (Get-Content $urlFile -Raw).Trim()
$httpBase = $server -replace '^wss://', 'https://' -replace '^ws://', 'http://'
if (-not $NoBump) { if ($Version) { & "$PSScriptRoot\bump-version.ps1" -Set $Version } else { & "$PSScriptRoot\bump-version.ps1" } }   # -Version = MANUAL number, otherwise AUTO
$ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
$liveNow = Get-PublishedManifest $root
if ($liveNow -and $liveNow.version -and ([version]$liveNow.version -ge [version]$ver)) { throw "v$ver is not newer than the live v$($liveNow.version). Nothing was published." }

# ---- 1) web bundle + manifest ----
$build = Join-Path $root 'build'
Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
$stage = Join-Path $build 'www'; New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $root 'app\www\*') $stage -Recurse
"window.NEXA_DEFAULT_SERVER = $(ConvertTo-Json $server -Compress); window.NEXA_VERSION = `"$ver`";" | Set-Content (Join-Path $stage 'config.js') -Encoding UTF8
$origin = ($server -replace '^wss://', 'https://' -replace '^ws://', 'http://')
$idx = Join-Path $stage 'index.html'; [IO.File]::WriteAllText($idx, [IO.File]::ReadAllText($idx).Replace('__OTA_ORIGIN__', $origin), (New-Object Text.UTF8Encoding $false))
$zip = Join-Path $build "www-$ver.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$native = $null
$outDir = Join-Path $root 'output'
$relFile = Join-Path $root 'release-host.txt'
function Get-ArtifactVersion([System.IO.FileInfo]$file) {
  if ($file.Name -match '-(\d+\.\d+\.\d+)\.(exe|apk)$') { return [version]$Matches[1] }
  throw "Unexpected release asset name: $($file.Name)"
}
function Get-LatestArtifact([string]$pattern) {
  $files = @(Get-ChildItem $outDir -File -Filter $pattern -ErrorAction SilentlyContinue)
  if (-not $files) { return $null }
  return $files | Sort-Object { Get-ArtifactVersion $_ } -Descending | Select-Object -First 1
}
$setup = Get-LatestArtifact 'NexaDesk-Setup-*.exe'
$portable = Get-LatestArtifact 'NexaDesk-Portable-*.exe'
$apk = Get-LatestArtifact 'NexaDesk-*.apk'
if (-not ($setup -and $portable -and $apk)) {
  $missing = @(); if (-not $setup) { $missing += 'NexaDesk-Setup-<version>.exe' }; if (-not $portable) { $missing += 'NexaDesk-Portable-<version>.exe' }; if (-not $apk) { $missing += 'NexaDesk-<version>.apk' }
  throw "Refusing to publish a partial release. Missing output files: $($missing -join ', '). Build all three platforms first."
}
$winVer = Get-ArtifactVersion $setup
if ((Get-ArtifactVersion $portable) -ne $winVer) { throw 'Setup and Portable EXE versions do not match.' }
$androidVer = Get-ArtifactVersion $apk
if (-not (Test-Path $relFile)) { throw 'release-host.txt is required so in-app native updates can download the release assets.' }
$rh = (Get-Content $relFile -Raw).Trim().TrimEnd('/')
if ($setup -and $apk) {
  $nativeVersion = if ($winVer -le $androidVer) { $winVer } else { $androidVer }
  $native = [ordered]@{ version = $nativeVersion.ToString() }
  foreach ($item in @(@('windows', $setup, $winVer), @('android', $apk, $androidVer))) {
    $file = $item[1].FullName
    $assetName = $item[1].Name
    $h = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    # Native downloads use the GitHub release URL below. This project does not serve
    # the duplicate R2 objects, so avoid re-uploading hundreds of megabytes there.
    $native[$item[0]] = [ordered]@{ version = $item[2].ToString(); url = "$rh/$assetName"; sha256 = $h }
  }
}
if (-not $native -and $liveNow -and $liveNow.native) { $native = $liveNow.native; Write-Host "Keeping the app-installer info of v$($native.version) in the manifest (no new installers in this run)." -ForegroundColor DarkGray }
$manifest = [ordered]@{ version = $ver; bundle = "www-$ver.zip"; sha256 = $sha; server = $server; released = (Get-Date).ToUniversalTime().ToString('o'); trust = @($keys.Trust); keyId = "$legacyId"; force = (-not $NoForce); notes = $(if ($Notes) { $Notes.Substring(0, [Math]::Min(300, $Notes.Length)) } else { '' }); native = $native } | ConvertTo-Json -Depth 5
$manifestPath = Join-Path $build 'update.json'
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
$sigPath = Join-Path $build 'update.sig'; $sig2Path = Join-Path $build 'update.sig2'
& node "$PSScriptRoot\sign-manifest.js" sign2 $manifestPath $RecoveryKey; if ($LASTEXITCODE) { throw 'signing failed' }
if ($legacyId) { & node "$PSScriptRoot\sign-manifest.js" sign $manifestPath $legacyId; if ($LASTEXITCODE) { throw 'legacy signing failed' } }

# ---- 2) GitHub: add the root OTA files and sync source ----
Write-Host "Publishing v$ver to GitHub..." -ForegroundColor Cyan
$clone = Join-Path $build 'repo'
Invoke-Git clone --depth 1 $repoUrl $clone
Get-ChildItem $clone -Filter 'www-*.zip' -File -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item (Join-Path $clone 'update.json'), (Join-Path $clone 'update.sig'), (Join-Path $clone 'update.sig2') -Force -ErrorAction SilentlyContinue
Copy-Item $zip $clone -Force; Copy-Item $manifestPath $clone -Force; Copy-Item $sig2Path $clone -Force
if (Test-Path $sigPath) { Copy-Item $sigPath $clone -Force }
$skip = @('.git', 'node_modules', 'build', 'output', 'signing', '.wrangler', '.cache-electron-builder', '.cache-local', '.npm-cache', '.gradle-home', '.android-home', '.tmp', 'logs') + @('desktop\www', 'desktop\dist', 'desktop\build', 'desktop\inputbroker\build', 'desktop\inputbroker\dist', 'android-app\www', 'android-app\android', 'ota' | ForEach-Object { Join-Path $root $_ })
robocopy $root $clone /E /XD @skip /XF .server-secret server-url.txt notify-token.txt config.json keystore-password.txt *.jks *.keystore *.pem /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Copying source files failed' }
# mirror: files you deleted from the project are removed, but keep the root OTA artifacts managed above
Push-Location $clone
try {
  foreach ($f in @(& git.exe ls-files)) {
    if ($f -like 'www-*.zip' -or $f -in @('update.json', 'update.sig', 'update.sig2') -or $f -like '.git*') { continue }
    if (-not (Test-Path (Join-Path $root $f))) { Invoke-Git rm -q $f }
  }
} finally { Pop-Location }
Push-Location $clone
try {
  Invoke-Git add -A
  $tracked = @(& git.exe ls-files)
  $blocked = @($tracked | Where-Object {
    $leaf = Split-Path $_ -Leaf
    $ext = [IO.Path]::GetExtension($leaf)
    ($ext -in @('.jks', '.pem', '.keystore', '.pfx', '.key')) -or
      ($leaf -like '.env*' -and $leaf -ne '.env.example') -or
      ($leaf -in @('.server-secret', '.dev.vars', 'server-url.txt', 'notify-token.txt', 'config.json')) -or
      ($leaf -like 'keystore-password*')
  })
  if ($blocked) { throw "Refusing to publish: secret or local configuration files are tracked: $($blocked -join ', ')" }
  Invoke-Git -c user.name=NexaDesk -c user.email=release@nexadesk.local commit -m "Release v$ver"
  Invoke-Git push origin HEAD:main
  $relSha = (& git.exe rev-parse HEAD).Trim()
} finally { Pop-Location }

# keep a local copy of the current OTA files for retry tooling
$localOta = Join-Path $root 'ota'; New-Item -ItemType Directory -Force $localOta | Out-Null
Get-ChildItem $localOta -File | Remove-Item -Force
Copy-Item @($zip, $manifestPath, $sig2Path) $localOta -Force
if (Test-Path $sigPath) { Copy-Item $sigPath $localOta -Force }

# ---- 2a) the update files go to the Worker (static assets, deployed with the server in step 3) ----
$pubDir = Join-Path $root 'cloudflare\public'; New-Item -ItemType Directory -Force $pubDir | Out-Null
Get-ChildItem $pubDir -File | Where-Object { $_.Name -ne 'robots.txt' } | Remove-Item -Force
Copy-Item @($zip, $manifestPath, $sig2Path) $pubDir -Force; if (Test-Path $sigPath) { Copy-Item $sigPath $pubDir -Force }

# ---- 2b) GitHub release 'ota' (installers + APK of this version) ----
Publish-OtaRelease $ver $relSha (Join-Path $root 'output') @($zip, $manifestPath, $sig2Path, $sigPath) -ForceInstallers

# ---- 3) server code (keeps /notify and protocol in sync) ----
Write-Host 'Updating server...' -ForegroundColor Cyan
Push-Location (Join-Path $root 'cloudflare')
try {
  if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund | Out-Null }
  cmd /c "npx wrangler deploy 2>&1" | Out-Null
  if ($LASTEXITCODE) { throw 'Cloudflare Worker deployment failed. GitHub has the release files, but OTA is not live yet.' }
} finally { Pop-Location }

# ---- 4) wait until GitHub serves it, then tell every online device to update NOW ----
$live = $false
for ($i = 0; $i -lt 20; $i++) {
  try { $m = Invoke-RestMethod "$httpBase/update.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers @{ 'Cache-Control' = 'no-cache' }; if ($m.version -eq $ver) { $live = $true; break } } catch {}
  Start-Sleep -Seconds 2
}
# self-test: download what the server really serves and check it the way an app does (manifest, bundle hash, installer links)
$selfOk = $false
if ($live) {
  $ErrorActionPreference = 'Continue'
  $st = & node "$PSScriptRoot\check-release.js" $httpBase 2>&1
  $stCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $st | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  if ($stCode) { Write-Host 'Update self-test FAILED: devices cannot install this update. Devices were NOT pinged. Read the lines above.' -ForegroundColor Red } else { $selfOk = $true; Write-Host 'Update self-test passed.' -ForegroundColor Green }
}
$tokFile = Join-Path $root 'notify-token.txt'
if (-not $live) { Write-Host "Warning: the update server has not served v$ver yet (it can take a minute). Check $httpBase/update.json" -ForegroundColor Yellow }
if ($live -and $selfOk -and (Test-Path $tokFile)) {
  $http = $server -replace '^wss://', 'https://' -replace '^ws://', 'http://'
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$http/notify" -Headers @{ Authorization = "Bearer $((Get-Content $tokFile -Raw).Trim())" } -ContentType 'application/json' -Body (@{ version = $ver } | ConvertTo-Json)
    Write-Host "`nv$ver is live. $($r.notified) online device(s) are updating right now." -ForegroundColor Green
  } catch { throw "v$ver is live, but the immediate device notification failed: $($_.Exception.Message)" }
} else { Write-Host "`nv$ver pushed. Devices will pick it up within a minute." -ForegroundColor Yellow }
} catch {
  Write-Host "`nRELEASE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  exit 1
}
exit 0
