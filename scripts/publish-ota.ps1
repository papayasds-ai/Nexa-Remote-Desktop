# Publishes a signed OTA bundle and Android APK to Cloudflare, optionally mirrors source and installers to GitHub,
# then pings online devices. GitHub login is not required for Android updates.
param([switch]$NoBump, [switch]$Force, [switch]$WithPortable, [switch]$RetryUpload, [string]$AppKey = '', [string]$RecoveryKey = '', [string]$CloudSha = '')   # -CloudSha: SHA256 of the Setup built on GitHub (set by release-all.ps1)   # -RecoveryKey <file>: publish with the offline recovery key (daily key lost)   # -AppKey <id|none>: legacy bridge for apps installed before signing was removed
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
$repoSlug = Resolve-GitHubRepo $root
$repoUrl = if ($repoSlug) { "https://github.com/$repoSlug.git" } else { '' }
$githubReady = $false
if ($repoSlug -and (Get-Command git.exe -ErrorAction SilentlyContinue) -and (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
  $ErrorActionPreference = 'Continue'; & gh.exe auth status *> $null; $githubReady = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
}
if (-not $githubReady) { Write-Host 'GitHub mirror skipped; Cloudflare will serve the Android update directly.' -ForegroundColor Yellow }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Write-Host 'Git is unavailable; GitHub source sync will be skipped.' -ForegroundColor Yellow }
function Invoke-Git { $ErrorActionPreference = 'Continue'; & git.exe @args; if ($LASTEXITCODE) { throw "git $($args -join ' ') failed" } }
# gh.exe (GitHub CLI) with stderr captured; returns its exit code. Output is kept in $script:ghOut.
function Invoke-Gh { $ErrorActionPreference = 'Continue'; $script:ghOut = & gh.exe @args 2>&1; return $LASTEXITCODE }

# Updates the GitHub release 'ota' IN PLACE: the release (also one you created by hand) and its tag are kept, files of older versions are removed,
# and this version's files are uploaded one by one with retries (a failed upload no longer restarts the others).
# Only the Setup EXE and the APK are uploaded (the in-app updater uses just these); the 75 MB Portable EXE only with -WithPortable.
function Publish-OtaRelease([string]$ver, [string]$sha, [string]$outDir) {
  $names = @("NexaDesk-Setup-$ver.exe", "NexaDesk-$ver.apk"); if ($WithPortable -or $CloudSha) { $names += "NexaDesk-Portable-$ver.exe" }   # with a cloud build the Setup/Portable are already on the release and must be kept
  $files = @(Get-ChildItem $outDir -File -ErrorAction SilentlyContinue | Where-Object { ($names -contains $_.Name) -and -not ($CloudSha -and $_.Name -like 'NexaDesk-*.exe') })   # cloud build: Setup/Portable are already on the release, never re-upload them
  if ($files.Count -eq 0) { Write-Host "GitHub 'ota' release left unchanged: no v$ver builds in output\ (a quick update only changes the web layer)." -ForegroundColor Yellow; return }
  if ($names[1] -notin $files.Name) { Write-Host "Note: no Android APK for v$ver, so the release will not contain one." -ForegroundColor Yellow }
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { Write-Host "GitHub 'ota' release NOT updated: GitHub CLI is not installed. Run: winget install GitHub.cli   then: gh auth login   then run this again." -ForegroundColor Red; return }
  if ((Invoke-Gh auth status) -ne 0) { Write-Host "GitHub 'ota' release NOT updated: run 'gh auth login' once, then run this again." -ForegroundColor Red; return }
  $repo = $repoSlug
  $notes = "NexaDesk v$ver`n`nWindows: NexaDesk-Setup-$ver.exe (installer)`nAndroid: NexaDesk-$ver.apk"
  if ((Invoke-Gh release view ota --repo $repo) -eq 0) {
    if ((Invoke-Gh release view ota --repo $repo --json assets --jq '.assets[].name') -eq 0) {
      foreach ($old in @($script:ghOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and ($names -notcontains $_) })) { [void](Invoke-Gh release delete-asset ota $old --repo $repo --yes) }
    }
    [void](Invoke-Gh release edit ota --repo $repo --title "NexaDesk v$ver" --notes $notes)
  } else {
    if ((Invoke-Gh release create ota --repo $repo --target $sha --title "NexaDesk v$ver" --notes $notes) -ne 0) { Write-Host "GitHub 'ota' release FAILED:`n$($script:ghOut)" -ForegroundColor Red; return }
  }
  $okCount = 0
  foreach ($f in $files) {
    $done = $false
    for ($try = 1; $try -le 3 -and -not $done; $try++) {
      Write-Host ("  uploading {0} ({1:N0} MB){2}..." -f $f.Name, ($f.Length / 1MB), $(if ($try -gt 1) { " attempt $try" } else { '' })) -ForegroundColor DarkGray
      $t0 = Get-Date
      if ((Invoke-Gh release upload ota $f.FullName --repo $repo --clobber) -eq 0) { $done = $true; $okCount++; Write-Host ("  done in {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds) -ForegroundColor DarkGray }
      else { Write-Host "  upload failed: $($script:ghOut | Select-Object -Last 1)" -ForegroundColor Yellow }
    }
  }
  if ($okCount -eq $files.Count) { Write-Host "GitHub 'ota' release now holds v$ver ($okCount file(s)): https://github.com/$repo/releases/tag/ota" -ForegroundColor Green }
  else { Write-Host "GitHub 'ota' release: only $okCount of $($files.Count) file(s) uploaded. Run  NexaDesk.bat update -RetryUpload  to upload the missing file(s) again." -ForegroundColor Red }
}

if ($RetryUpload) {   # only re-send this version's installers to the GitHub release (after a failed or interrupted upload)
  Publish-OtaRelease ((Get-Content (Join-Path $root 'VERSION') -Raw).Trim()) 'main' (Join-Path $root 'output')
  return
}
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
if (-not $NoBump) { & "$PSScriptRoot\bump-version.ps1" }
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
$haveSetup = (Test-Path (Join-Path $outDir $setupName)) -or [bool]$CloudSha; $haveApk = Test-Path (Join-Path $outDir $apkName)
# Installers for in-app updates are served from the release host (release-host.txt, R2) or - when that file is missing - from the GitHub 'ota' release,
# which only works while the repository is public (anonymous downloads).
$useGh = $false
if ($haveSetup -and -not (Test-Path $relFile) -and $githubReady) {
  $ErrorActionPreference = 'Continue'; $vis = ([string](& gh.exe repo view $repoSlug --json visibility --jq .visibility 2>$null)).Trim(); $ErrorActionPreference = 'Stop'
  if ($vis -eq 'PUBLIC') { $useGh = $true; Write-Host "Installers will be offered from the public GitHub release of $repoSlug." -ForegroundColor DarkGray }
  else { Write-Host "Windows installer update is not hosted (no release-host.txt and $repoSlug is not public); keeping the previous Windows installer link." -ForegroundColor Yellow }
}
if ($haveSetup -and -not (Test-Path $relFile) -and -not $useGh) { $haveSetup = $false }
if ($haveSetup -or $haveApk) {
  $winVer = if ($haveSetup) { $ver } elseif ($liveNow.native.version) { $liveNow.native.version } else { $ver }
  $native = [ordered]@{ version = $winVer }
  if ($haveSetup) {
    $rh = if (Test-Path $relFile) { (Get-Content $relFile -Raw).Trim().TrimEnd('/') } else { "https://github.com/$repoSlug/releases/download/ota" }
    $file = Join-Path $outDir $setupName
    $h = if ($CloudSha) { $CloudSha.ToLower() } else { (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() }
    $native.windows = [ordered]@{ url = "$rh/$setupName"; sha256 = $h }
    if (Test-Path $relFile) {
      Push-Location (Join-Path $root 'cloudflare')
      try { & npx wrangler r2 object put "nexadesk-releases/$setupName" --file $file --remote; $code = $LASTEXITCODE } finally { Pop-Location }
      if ($code) { throw "Upload of $setupName to the release host failed" }
    }
  } elseif ($liveNow.native.windows) { $native.windows = $liveNow.native.windows }
  if ($haveApk) {
    $file = Join-Path $outDir $apkName
    $h = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    $native.android = [ordered]@{ url = "$httpBase/$apkName"; sha256 = $h; version = $ver; minUpdaterVersion = '1.0.124' }
  } elseif ($liveNow.native.android) { $native.android = $liveNow.native.android }
}
if (-not $native -and $liveNow -and $liveNow.native) { $native = $liveNow.native; Write-Host "Keeping the app-installer info of v$($native.version) in the manifest (no new installers in this run)." -ForegroundColor DarkGray }
$mirrors = if ($githubReady -and $repoSlug) { [ordered]@{ web = "https://raw.githubusercontent.com/$repoSlug/HEAD/ota/"; app = "https://github.com/$repoSlug/releases/download/ota/" } } else { [ordered]@{ web = ''; app = '' } }
$manifest = [ordered]@{ version = $ver; bundle = "www-$ver.zip"; sha256 = $sha; server = $server; released = (Get-Date).ToUniversalTime().ToString('o'); mirrors = $mirrors; trust = @($keys.Trust); keyId = "$legacyId"; force = [bool]$Force; native = $native } | ConvertTo-Json -Depth 5
$manifestPath = Join-Path $build 'update.json'
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
$sigPath = Join-Path $build 'update.sig'; $sig2Path = Join-Path $build 'update.sig2'
& node "$PSScriptRoot\sign-manifest.js" sign2 $manifestPath $RecoveryKey; if ($LASTEXITCODE) { throw 'signing failed' }
if ($legacyId) { & node "$PSScriptRoot\sign-manifest.js" sign $manifestPath $legacyId; if ($LASTEXITCODE) { throw 'legacy signing failed' } }

# ---- 2) Optional GitHub source mirror ----
$relSha = 'main'
$githubSourceReady = $false
if ($githubReady) {
  try {
    Write-Host "Syncing the optional GitHub mirror for v$ver..." -ForegroundColor Cyan
    $clone = Join-Path $build 'repo'
    [void](Invoke-Gh auth setup-git)
    Invoke-Git clone --depth 1 $repoUrl $clone
    $ota = Join-Path $clone 'ota'; New-Item -ItemType Directory -Force $ota | Out-Null
    Get-ChildItem $ota -File | Remove-Item -Force
    Copy-Item $zip $ota; Copy-Item $manifestPath $ota; Copy-Item $sig2Path $ota; if (Test-Path $sigPath) { Copy-Item $sigPath $ota }
    $skip = @('.git', 'node_modules', 'build', 'output', 'signing', '.wrangler') + @('desktop\www', 'android-app\www', 'android-app\android', 'ota' | ForEach-Object { Join-Path $root $_ })
    robocopy $root $clone /E /XD @skip /XF .server-secret server-url.txt notify-token.txt token.txt config.json keystore-password.txt *.jks *.keystore *.pem /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Copying source files failed' }
    Push-Location $clone
    try {
      foreach ($f in @(& git.exe ls-files)) {
        if ($f -like 'ota/*' -or $f -like '.git*') { continue }
        if (-not (Test-Path (Join-Path $root $f))) { Invoke-Git rm -q $f }
      }
      Invoke-Git add -A
      $tracked = (& git.exe ls-files) -join "`n"
      if ($tracked -match '\.jks|\.pem|\.keystore|\.server-secret|notify-token|(^|\n)token\.txt(\n|$)|keystore-password') { throw 'Refusing to publish: a secret file would be uploaded.' }
      Invoke-Git -c user.name=NexaDesk -c user.email=release@nexadesk.local commit -m "Release v$ver"
      Invoke-Git push origin HEAD:main
      $relSha = (& git.exe rev-parse HEAD).Trim()
      $githubSourceReady = $true
    } finally { Pop-Location }
  } catch {
    Write-Host "GitHub source mirror was skipped: $($_.Exception.Message). The signed Cloudflare release will continue." -ForegroundColor Yellow
    if ($clone -and (Test-Path -LiteralPath $clone)) { Remove-Item -LiteralPath $clone -Recurse -Force }
  }
} else { Write-Host 'GitHub source/release mirror skipped; the signed update will still be published to Cloudflare.' -ForegroundColor Yellow }

# If source mirroring failed, do not advertise its stale OTA bundle as a download fallback.
if (-not $githubSourceReady -and $githubReady) {
  $manifestObject = ConvertFrom-Json $manifest
  $manifestObject.mirrors.web = ''
  $manifest = $manifestObject | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
  & node "$PSScriptRoot\sign-manifest.js" sign2 $manifestPath $RecoveryKey; if ($LASTEXITCODE) { throw 're-signing manifest after GitHub mirror skip failed' }
  if ($legacyId) { & node "$PSScriptRoot\sign-manifest.js" sign $manifestPath $legacyId; if ($LASTEXITCODE) { throw 'legacy re-signing after GitHub mirror skip failed' } }
}

# Keep the local ota\ folder current for diagnostics and manual release review.
$localOta = Join-Path $root 'ota'; New-Item -ItemType Directory -Force $localOta | Out-Null
Get-ChildItem $localOta -File | Remove-Item -Force
Copy-Item @($zip, $manifestPath, $sig2Path) $localOta -Force; if (Test-Path $sigPath) { Copy-Item $sigPath $localOta -Force }

# ---- 3) Worker assets: preserve the current APK on quick web-only updates ----
$pubDir = Join-Path $root 'cloudflare\public'; New-Item -ItemType Directory -Force $pubDir | Out-Null
if ($haveApk) { $keepApk = $apkName }
elseif ($liveNow.native.android.version) { $keepApk = 'NexaDesk-' + $liveNow.native.android.version + '.apk' }
else { $keepApk = '' }
Get-ChildItem $pubDir -File | Where-Object { $_.Name -ne 'robots.txt' -and $_.Name -ne $keepApk } | Remove-Item -Force
Copy-Item @($zip, $manifestPath, $sig2Path) $pubDir -Force; if (Test-Path $sigPath) { Copy-Item $sigPath $pubDir -Force }
if ($haveApk) { Copy-Item (Join-Path $outDir $apkName) (Join-Path $pubDir $apkName) -Force }

# ---- 4) Optional GitHub release mirror ----
if ($githubReady) { Publish-OtaRelease $ver $relSha (Join-Path $root 'output') }

# ---- 5) Deploy Worker code + signed assets using the narrowly scoped token ----
& "$PSScriptRoot\deploy-cloudflare-narrow.ps1"
if ($LASTEXITCODE) { throw 'Cloudflare Worker deployment failed.' }

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
