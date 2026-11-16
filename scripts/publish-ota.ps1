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
$setupName = "NexaDesk-Setup-$ver.exe"; $apkName = "NexaDesk-$ver.apk"
$haveSetup = Test-Path (Join-Path $outDir $setupName); $haveApk = Test-Path (Join-Path $outDir $apkName)
# Installer host: release-host.txt (Cloudflare R2) when present, otherwise the GitHub release 'ota'. For a REAL update the installers must be on the host
# (and verified) BEFORE the signed manifest announces them, so the apps never get a download link that does not work yet.
$rh = Get-ReleaseHost $root
$useGh = ($rh -like 'https://github.com/*')
$cloudWin = ($useGh -and (Test-Path (Join-Path $root 'cloud-windows.txt')))   # Windows installers are built ON GITHUB (a slow upload line cannot send 100+ MB)
$cloudInfo = $null
if ($cloudWin) {
  $cr = @(Invoke-CloudWindowsBuild $root $ver $server $build)
  $cloudInfo = $cr[-1]
  $haveSetup = [bool]($cloudInfo -and $cloudInfo.ok)
  if (-not $haveSetup) { Write-Host "`nWARNING: the cloud build of the Windows installers did not finish, so v$ver cannot update the Windows app package (see above)." -ForegroundColor Red }
}
$skipInst = (Test-Path (Join-Path $root 'skip-installer-upload.txt')) -and -not $cloudWin
$instOk = $true
if (($haveSetup -or $haveApk) -and $useGh) {
  if ($skipInst) { $instOk = $false; Write-Host 'skip-installer-upload.txt exists: installers NOT uploaded, so apps cannot install an app-package update this time. Delete that file to enable it.' -ForegroundColor Yellow }
  else {
    if ($haveApk -or -not $cloudWin) { $upRes = @(Publish-OtaInstallers $ver $outDir -ApkOnly:$cloudWin); $instOk = ($upRes.Count -gt 0 -and $upRes[-1] -eq $true) }
    if ($cloudWin -and -not $haveSetup) { $instOk = $false }
  }
  if (-not $instOk) { Write-Host "`nWARNING: v$ver is published as a WEB-ONLY update (the app installers are not on GitHub). Apps will not install a new app package. Run it again from a faster connection." -ForegroundColor Red }
}
if (($haveSetup -or $haveApk) -and $instOk) {
  # $rh (installer host) was chosen above
  $native = [ordered]@{ version = $ver }
  foreach ($item in @(@('windows', $setupName, $haveSetup), @('android', $apkName, $haveApk))) {
    if (-not $item[2]) { continue }
    $file = Join-Path $outDir $item[1]
    $h = if ($item[0] -eq 'windows' -and $cloudInfo -and $cloudInfo.ok) { $cloudInfo.setupSha } else { (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() }
    if (-not $useGh) {   # R2 host (release-host.txt); with the GitHub host the files were uploaded above
      Push-Location (Join-Path $root 'cloudflare')
      try { & npx wrangler r2 object put "nexadesk-releases/$($item[1])" --file $file --remote; $code = $LASTEXITCODE } finally { Pop-Location }
      if ($code) { throw "Upload of $($item[1]) to the release host failed" }
    }
    $native[$item[0]] = [ordered]@{ url = "$rh/$($item[1])"; sha256 = $h }
  }
}
if (-not $native -and $liveNow -and $liveNow.native) { $native = $liveNow.native; Write-Host "Keeping the app-installer info of v$($native.version) in the manifest (no new installers in this run)." -ForegroundColor DarkGray }
$manifest = [ordered]@{ version = $ver; bundle = "www-$ver.zip"; sha256 = $sha; server = $server; released = (Get-Date).ToUniversalTime().ToString('o'); trust = @($keys.Trust); keyId = "$legacyId"; force = (-not $NoForce); notes = $(if ($Notes) { $Notes.Substring(0, [Math]::Min(300, $Notes.Length)) } else { '' }); native = $native } | ConvertTo-Json -Depth 5
$manifestPath = Join-Path $build 'update.json'
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
$sigPath = Join-Path $build 'update.sig'; $sig2Path = Join-Path $build 'update.sig2'
& node "$PSScriptRoot\sign-manifest.js" sign2 $manifestPath $RecoveryKey; if ($LASTEXITCODE) { throw 'signing failed' }
if ($legacyId) { & node "$PSScriptRoot\sign-manifest.js" sign $manifestPath $legacyId; if ($LASTEXITCODE) { throw 'legacy signing failed' } }

# ---- 2) GitHub: erase old packages, add new, sync source ----
Write-Host "Publishing v$ver to GitHub..." -ForegroundColor Cyan
$clone = Join-Path $build 'repo'
Invoke-Git clone --depth 1 $repoUrl $clone
$ota = Join-Path $clone 'ota'; New-Item -ItemType Directory -Force $ota | Out-Null
Get-ChildItem $ota -File | Remove-Item -Force
Copy-Item $zip $ota; Copy-Item $manifestPath $ota; Copy-Item $sig2Path $ota; if (Test-Path $sigPath) { Copy-Item $sigPath $ota }
$skip = @('.git', 'node_modules', 'build', 'output', 'signing', '.wrangler') + @('desktop\www', 'android-app\www', 'android-app\android', 'ota' | ForEach-Object { Join-Path $root $_ })
robocopy $root $clone /E /XD @skip /XF .server-secret server-url.txt notify-token.txt config.json keystore-password.txt *.jks *.keystore *.pem /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Copying source files failed' }
# mirror: files you deleted from the project are removed from the repo too (ota/ is managed separately)
Push-Location $clone
try {
  foreach ($f in @(& git.exe ls-files)) {
    if ($f -like 'ota/*' -or $f -like '.git*') { continue }
    if (-not (Test-Path (Join-Path $root $f))) { Invoke-Git rm -q $f }
  }
} finally { Pop-Location }
Push-Location $clone
try {
  Invoke-Git add -A
  $tracked = (& git.exe ls-files) -join "`n"
  if ($tracked -match '\.jks|\.pem|\.keystore|\.server-secret|notify-token|keystore-password') { throw 'Refusing to publish: a secret file would be uploaded.' }
  Invoke-Git -c user.name=NexaDesk -c user.email=release@nexadesk.local commit -m "Release v$ver"
  Invoke-Git push origin HEAD:main
  $relSha = (& git.exe rev-parse HEAD).Trim()
} finally { Pop-Location }

# keep the local ota\ folder identical to what was published (it was going stale before)
$localOta = Join-Path $root 'ota'; New-Item -ItemType Directory -Force $localOta | Out-Null
Get-ChildItem $localOta -File | Remove-Item -Force
Copy-Item (Join-Path $ota '*') $localOta -Force

# ---- 2a) the update files go to the Worker (static assets, deployed with the server in step 3) ----
$pubDir = Join-Path $root 'cloudflare\public'; New-Item -ItemType Directory -Force $pubDir | Out-Null
Get-ChildItem $pubDir -File | Where-Object { $_.Name -ne 'robots.txt' } | Remove-Item -Force
Copy-Item @($zip, $manifestPath, $sig2Path) $pubDir -Force; if (Test-Path $sigPath) { Copy-Item $sigPath $pubDir -Force }

# ---- 2b) GitHub release 'ota' (installers + APK of this version) ----
Publish-OtaRelease $ver $relSha (Join-Path $root 'output') @($zip, $manifestPath, $sig2Path, $sigPath) -NoInstallers:$useGh

# ---- 3) server code (keeps /notify and protocol in sync) ----
Write-Host 'Updating server...' -ForegroundColor Cyan
Push-Location (Join-Path $root 'cloudflare')
try {
  if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund | Out-Null }
  cmd /c "npx wrangler deploy 2>&1" | Out-Null
  if ($LASTEXITCODE) { Write-Host 'Server update failed (use option 5 to repair).' -ForegroundColor Yellow }
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
  } catch { Write-Host "`nv$ver is live. Instant ping failed; devices will update within a minute." -ForegroundColor Yellow }
} else { Write-Host "`nv$ver pushed. Devices will pick it up within a minute." -ForegroundColor Yellow }
# last (it is the big one): the Portable exe, so it never delays the update that devices are waiting for
if ($cloudWin -and $instOk) { Remove-OldWinAssets $ver }
if ($useGh -and $instOk -and -not $cloudWin -and (Test-Path (Join-Path $outDir "NexaDesk-Portable-$ver.exe"))) { Write-Host 'Uploading the Portable exe (devices are already updating; you can close this window once it is done)...' -ForegroundColor Cyan; [void](@(Publish-OtaInstallers $ver $outDir -Portable)) }
} catch {
  Write-Host "`nRELEASE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  exit 1
}
exit 0
