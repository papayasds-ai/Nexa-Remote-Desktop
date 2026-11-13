# Builds NexaDesk for Android -> output\NexaDesk-<version>.apk (signed, release)
# Requires: Node.js 22+, JDK 17. The Android SDK (command-line tools, platform 35, build-tools) is installed by this script when it is missing.
param([switch]$NoBump, [string]$ServerUrl = "", [switch]$AllowInsecure)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"

# Toolchain versions the generated Android project is upgraded to.
$TargetSdk  = 35
$MinSdk     = 23   # play-services-tasks (used by the updater plugin) needs minSdk 23; Capacitor's template uses 22
$AgpVersion = '8.5.2'
$GradleVer  = '8.7'

function Write-Utf8NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

# Upgrades a Capacitor 6 project (ships AGP 8.2.1 / Gradle 8.2.1 / compileSdk 34) to what current AndroidX libraries need.
# Idempotent: safe to run on fresh and existing android/ folders.
function Update-AndroidToolchain([string]$androidDir, [string]$appVer) {
  $sdkPatterns = @(
    @{ re = '(minSdkVersion\s*=\s*)\d+';     rep = ('${1}' + $MinSdk) },
    @{ re = '(minSdk\s+)\d+';                 rep = ('${1}' + $MinSdk) },
    @{ re = '(compileSdkVersion\s*=\s*)\d+'; rep = ('${1}' + $TargetSdk) },
    @{ re = '(targetSdkVersion\s*=\s*)\d+';  rep = ('${1}' + $TargetSdk) },
    @{ re = '(compileSdk\s+)\d+';            rep = ('${1}' + $TargetSdk) },
    @{ re = '(targetSdk\s+)\d+';             rep = ('${1}' + $TargetSdk) },
    @{ re = 'com\.android\.tools\.build:gradle:[\d.]+'; rep = ('com.android.tools.build:gradle:' + $AgpVersion) }
  )
  foreach ($rel in 'variables.gradle', 'build.gradle', 'app\build.gradle') {
    $f = Join-Path $androidDir $rel
    if (-not (Test-Path $f)) { continue }
    $t = [IO.File]::ReadAllText($f); $n = $t
    foreach ($p in $sdkPatterns) { $n = [regex]::Replace($n, $p.re, $p.rep) }
    # remove the old (ineffective) androidx.work pin from earlier builds
    $n = [regex]::Replace($n, '\r?\n// NexaDesk work pin[\s\S]*$', '')
    if ($n -ne $t) { Write-Utf8NoBom $f $n; Write-Host "  updated $rel" -ForegroundColor DarkGray }
  }
  # AGP 8.5 prints a warning that compileSdk 35 is untested; it is harmless, silence it
  $gp = Join-Path $androidDir 'gradle.properties'
  if (Test-Path $gp) {
    $t = [IO.File]::ReadAllText($gp)
    if ($t -notmatch 'suppressUnsupportedCompileSdk') { Write-Utf8NoBom $gp ($t.TrimEnd() + "`r`nandroid.suppressUnsupportedCompileSdk=$TargetSdk`r`n") }
  }
  # APK version: versionCode must grow on every release or Android refuses to install over the old APK
  $ap = Join-Path $androidDir 'app\build.gradle'
  if (Test-Path $ap) {
    $parts = $appVer.Split('.'); $code = [int]$parts[0] * 10000 + [int]$parts[1] * 100 + [int]$parts[2]
    $t = [IO.File]::ReadAllText($ap)
    $n = [regex]::Replace($t, '(versionCode\s+)\d+', ('${1}' + $code))
    $n = [regex]::Replace($n, '(versionName\s+")[^"]*(")', ('${1}' + $appVer + '${2}'))
    if ($n -ne $t) { Write-Utf8NoBom $ap $n; Write-Host "  APK version $appVer (versionCode $code)" -ForegroundColor DarkGray }
  }
  $wrap = Join-Path $androidDir 'gradle\wrapper\gradle-wrapper.properties'
  if (Test-Path $wrap) {
    $t = [IO.File]::ReadAllText($wrap)
    $n = [regex]::Replace($t, 'gradle-[\d.]+-(bin|all)\.zip', ('gradle-' + $GradleVer + '-bin.zip'))
    if ($n -ne $t) { Write-Utf8NoBom $wrap $n; Write-Host "  updated Gradle wrapper to $GradleVer" -ForegroundColor DarkGray }
  }
}

# Makes sure the SDK platform the project compiles against is installed; installs it with sdkmanager if not.
function Ensure-AndroidPlatform([string]$sdkRoot, [int]$level) {
  $plat = Join-Path $sdkRoot "platforms\android-$level"
  if (Test-Path $plat) { return }
  $sm = Get-ChildItem (Join-Path $sdkRoot 'cmdline-tools') -Recurse -Filter 'sdkmanager.bat' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sm) { throw "Android platform $level is missing. Open Android Studio > SDK Manager and install 'Android API $level' (SDK Platform) plus build-tools." }
  Write-Host "Installing Android platform $level (first time only, may take a few minutes)..." -ForegroundColor Cyan
  (1..60 | ForEach-Object { 'y' }) | & $sm.FullName --licenses | Out-Null
  cmd /c "`"$($sm.FullName)`" `"platforms;android-$level`" `"build-tools;$level.0.0`"" | Out-Null
  if (-not (Test-Path $plat)) { throw "Could not install Android platform $level. Install it from Android Studio > SDK Manager." }
}

# Launcher icon: replace the template icon with NexaDesk's (taskbar-style app icon, recents, Android 12+ splash).
function Set-AndroidIcons([string]$androidDir, [string]$assetsRes) {
  $res = Join-Path $androidDir 'app\src\main\res'
  # the adaptive-icon XML would override the PNGs on Android 8+; remove it so the same PNG shows everywhere
  # Android 8+ gets an ADAPTIVE icon (assets\android\res\mipmap-anydpi-v26 + drawable-nodpi): launcher, recents and the Android 12+ splash all draw it
  # the same way. The template's adaptive XML is replaced by ours; the legacy PNGs only serve Android 7 and older.
  Remove-Item (Join-Path $res 'mipmap-anydpi-v26\ic_launcher.xml'), (Join-Path $res 'mipmap-anydpi-v26\ic_launcher_round.xml') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $assetsRes '*') $res -Recurse -Force
  Write-Host '  launcher icons replaced' -ForegroundColor DarkGray
}
# No Android SDK at all? Install Google's command-line SDK by itself (no Android Studio needed); Ensure-AndroidPlatform then adds platform + build-tools.
function Install-AndroidCmdlineTools([string]$sdkRoot) {
  $url = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
  Write-Host "Android SDK not found: installing Google's command-line tools into $sdkRoot (one time, needs internet)..." -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP 'nexadesk-cmdline-tools.zip'; $x = Join-Path $env:TEMP 'nexadesk-cmdline-tools'
  $oldProgress = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip } finally { $ProgressPreference = $oldProgress }
  Remove-Item $x -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $x -Force
  $dest = Join-Path $sdkRoot 'cmdline-tools\latest'
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item (Join-Path $x 'cmdline-tools') $dest
  Remove-Item $zip, $x -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $dest 'bin\sdkmanager.bat'))) { throw 'The downloaded command-line tools look incomplete.' }
}
foreach ($c in 'node', 'npm', 'java', 'keytool') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c not found. Install Node.js 18+ and JDK 17 (e.g. Temurin) and reopen the terminal." } }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Get-ChildItem (Join-Path $sdk 'cmdline-tools') -Recurse -Filter 'sdkmanager.bat' -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $sdk 'platforms'))) {
  try { Install-AndroidCmdlineTools $sdk } catch { throw "Could not set up the Android SDK automatically ($($_.Exception.Message)). Alternative: winget install --id Google.AndroidStudio -e, open it once so it installs the SDK, then run this again. Looked in: $sdk" }
}
if (-not (Test-Path $sdk)) { throw "Android SDK not found. Install Android Studio and set ANDROID_HOME. Looked in: $sdk" }
$nodeVer = [version]((node -v).TrimStart('v'))
if ($nodeVer -lt [version]'22.12.0') { throw "Node.js 22.12 or newer is required (found $nodeVer). Install the current LTS from https://nodejs.org" }
Initialize-UpdateKeys $root | Out-Null
$urlFile = Join-Path $root 'server-url.txt'
if (-not $ServerUrl -and (Test-Path $urlFile)) { $ServerUrl = (Get-Content $urlFile -Raw).Trim() }
if ($ServerUrl -and $ServerUrl -notmatch '^wss?://') { throw 'Server URL must start with wss:// or ws://' }
if ($ServerUrl -match '^ws://' -and -not $AllowInsecure) { throw 'Android build requires wss:// (TLS). For LAN testing re-run with -AllowInsecure.' }
if (-not $NoBump) { & "$PSScriptRoot\bump-version.ps1" }
$ver = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()

$app = Join-Path $root 'android-app'
Remove-Item (Join-Path $app 'www') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'app\www') (Join-Path $app 'www') -Recurse
"window.NEXA_DEFAULT_SERVER = $(ConvertTo-Json $ServerUrl -Compress); window.NEXA_VERSION = `"$ver`";" | Set-Content (Join-Path $app 'www\config.js') -Encoding UTF8
$origin = ($ServerUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://')
$idx = Join-Path $app 'www\index.html'; [IO.File]::WriteAllText($idx, [IO.File]::ReadAllText($idx).Replace('__OTA_ORIGIN__', $origin), (New-Object Text.UTF8Encoding $false))
$scheme = if ($AllowInsecure) { 'http' } else { 'https' }
@{ appId = 'com.nexadesk.app'; appName = 'NexaDesk'; webDir = 'www';
   server = @{ androidScheme = $scheme; cleartext = [bool]$AllowInsecure };
   android = @{ allowMixedContent = [bool]$AllowInsecure };
   plugins = @{ CapacitorUpdater = @{ autoUpdate = $false } } } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $app 'capacitor.config.json') -Encoding UTF8

Push-Location $app
try {
  # file: dependencies must be packed into node_modules rather than linked; Windows AppContainer / standard users may not create symlinks.
  npm install --no-audit --no-fund --install-links; if ($LASTEXITCODE) { throw 'npm install failed' }
  if (-not (Test-Path 'android')) { npx cap add android; if ($LASTEXITCODE) { throw 'cap add android failed' } }
  npx cap sync android; if ($LASTEXITCODE) { throw 'cap sync failed' }

  # Current AndroidX (pulled in by the OTA updater plugin) needs compileSdk 35; upgrade the generated project to match.
  Write-Host 'Checking Android project toolchain...' -ForegroundColor Cyan
  Update-AndroidToolchain (Join-Path $app 'android') $ver
  Set-AndroidIcons (Join-Path $app 'android') (Join-Path $root 'assets\android\res')
  Ensure-AndroidPlatform $sdk $TargetSdk

  ("sdk.dir=" + ($sdk -replace '\\', '/')) | Set-Content 'android\local.properties' -Encoding ASCII

  Push-Location android
  try { & .\gradlew.bat assembleRelease --no-daemon; if ($LASTEXITCODE) { throw 'Gradle build failed' } } finally { Pop-Location }
  $unsigned = Get-ChildItem 'android\app\build\outputs\apk\release' -Filter '*.apk' | Select-Object -First 1
  if (-not $unsigned) { throw 'Release APK not found' }

  # ---- signing (keystore is generated once; BACK IT UP - you need it for every future APK update) ----
  $signDir = Join-Path $root 'signing'; New-Item -ItemType Directory -Force $signDir | Out-Null
  $ks = Join-Path $signDir 'nexadesk.jks'; $pwFile = Join-Path $signDir 'keystore-password.txt'
  if (-not (Test-Path $ks)) {
    $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $kpw = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x'
    keytool -genkeypair -v -keystore $ks -alias nexadesk -keyalg RSA -keysize 4096 -validity 10000 -storepass $kpw -keypass $kpw -dname 'CN=NexaDesk, O=NexaDesk' | Out-Null
    if ($LASTEXITCODE) { throw 'keytool failed' }
    $kpw | Set-Content $pwFile -Encoding ASCII
    Write-Host "Created signing key: $ks (password in $pwFile). Keep both safe and private." -ForegroundColor Yellow
  }
  $kpw = (Get-Content $pwFile -Raw).Trim()
  $bt = Get-ChildItem (Join-Path $sdk 'build-tools') | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } -Descending | Select-Object -First 1
  if (-not $bt) { throw 'Android build-tools not installed (use SDK Manager).' }
  $aligned = Join-Path $app 'aligned.apk'; Remove-Item $aligned -ErrorAction SilentlyContinue
  & (Join-Path $bt.FullName 'zipalign.exe') -p -f 4 $unsigned.FullName $aligned; if ($LASTEXITCODE) { throw 'zipalign failed' }
  $out = Join-Path $root 'output'; New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -Filter 'NexaDesk*.apk' -ErrorAction SilentlyContinue | Remove-Item -Force   # previous builds
  $final = Join-Path $out "NexaDesk-$ver.apk"
  & (Join-Path $bt.FullName 'apksigner.bat') sign --ks $ks --ks-pass "pass:$kpw" --key-pass "pass:$kpw" --out $final $aligned; if ($LASTEXITCODE) { throw 'apksigner failed' }
  & (Join-Path $bt.FullName 'apksigner.bat') verify $final; if ($LASTEXITCODE) { throw 'APK verification failed' }
  Remove-Item $aligned -ErrorAction SilentlyContinue
  Write-Host "`nDone (v$ver). Android APK: $final" -ForegroundColor Green
} finally { Pop-Location }
