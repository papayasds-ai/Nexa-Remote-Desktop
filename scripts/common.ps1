# Shared helpers for the NexaDesk scripts. Use: . "$PSScriptRoot\common.ps1"

function Get-ServerOrigin([string]$root) {
  $u = Join-Path $root 'server-url.txt'
  if (-not (Test-Path $u)) { return '' }
  return ((Get-Content $u -Raw).Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://')
}

# Makes sure the daily + recovery update keys exist (in your user profile, NOT in the project folder) and writes app\www\update-keys.js.
# Stops before building/publishing when the keys do not match what devices trust. Returns @{ Id = daily key id; Trust = ids the apps trust }.
function Initialize-UpdateKeys([string]$root, [string]$RecoveryKey = '') {
  $pub = Get-PublishedManifest $root
  $live = if ($pub -and $pub.trust) { (@($pub.trust) -join ',') } else { '-' }
  $rk = if ($RecoveryKey) { $RecoveryKey } else { '-' }
  $ErrorActionPreference = 'Continue'
  $out = @(& node "$PSScriptRoot\sign-manifest.js" ensure $live $rk 2>&1)
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $out | ForEach-Object { Write-Host "  $_" -ForegroundColor $(if ($_ -match 'RECOVERY|Move this file') { 'Yellow' } else { 'DarkGray' }) }
  if ($code) { throw 'Update key check failed (see above). Nothing was built or published.' }
  $kj = Join-Path $root 'app\www\update-keys.js'
  if (-not (Test-Path $kj) -or ((Get-Content $kj -Raw) -notmatch '"[A-Za-z0-9+/=]{300,}"')) { throw 'app\www\update-keys.js has no keys, so this build would reject every update. Nothing was built or published.' }
  $id = ((@($out) | Where-Object { $_ -match '^KEYID=' }) -replace '^KEYID=', '').Trim()
  $trust = (((@($out) | Where-Object { $_ -match '^TRUST=' }) -replace '^TRUST=', '').Trim()) -split ','
  return [pscustomobject]@{ Id = $id; Trust = $trust }
}

# The manifest the server publishes right now, or $null when there is none or the server cannot be reached.
# $script:ManifestStatus tells which: 'ok', 'nourl' (no server-url.txt), 'none' (server answered, nothing published yet), 'unreachable'.
function Get-PublishedManifest([string]$root) {
  $script:ManifestStatus = 'nourl'
  $origin = Get-ServerOrigin $root
  if (-not $origin) { return $null }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' } -Uri "$origin/update.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $script:ManifestStatus = 'ok'
    return ConvertFrom-Json $r.Content
  } catch {
    $script:ManifestStatus = if ($_.Exception.Response) { 'none' } else { 'unreachable' }
    return $null
  }
}

# Tools installed while a window (or Explorer) was already open are missing from its PATH. Reload PATH from Windows and add the usual
# install folders, so Git, GitHub CLI, Node and the JDK are found without reopening anything. Runs whenever a script loads this file.
function Sync-Path {
  try {
  $parts = @($env:Path -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
  $parts += 'C:\Program Files\Git\cmd', 'C:\Program Files\GitHub CLI', 'C:\Program Files\nodejs'
  if ($env:LOCALAPPDATA) { $parts += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd') }
  foreach ($base in 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft') {
    if (-not (Test-Path $base)) { continue }
    $parts += @(Get-ChildItem $base -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'bin' })
  }
  $seen = @{}; $keep = foreach ($d in $parts) { if ($d -and -not $seen.ContainsKey($d.ToLower()) -and (Test-Path $d -ErrorAction SilentlyContinue)) { $seen[$d.ToLower()] = 1; $d } }
  if ($keep) { $env:Path = $keep -join ';' }
  if (-not $env:JAVA_HOME -and (Get-Command java -ErrorAction SilentlyContinue)) { $j = (Get-Command java).Source; if ($j -match '^(.*)\\bin\\java(\.exe)?$') { $env:JAVA_HOME = $Matches[1] } }
  } catch { }   # never let this convenience break a script
}
Sync-Path

# ---- GitHub repository: github-repo.txt (owner/name) if present, otherwise the current one ----
function Get-RepoName([string]$root) {
  $f = Join-Path $root 'github-repo.txt'
  if (Test-Path $f) { $n = ((Get-Content $f -Raw) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1); if ($n -match '^[\w.-]+/[\w.-]+$') { return $n.Trim() } }
  return 'papayasds-ai/Nexa-Remote-Desktop'
}
# ---- where devices download the installers from ----
#   release-host.txt present -> that public address (R2 bucket), files are uploaded there
#   otherwise                -> the PUBLIC repository's 'ota' release (nothing to set up, publish-ota uploads them there)
function Get-ReleaseHost([string]$root) {
  $f = Join-Path $root 'release-host.txt'
  if (Test-Path $f) { $u = (Get-Content $f -Raw).Trim().TrimEnd('/'); if ($u) { return @{ Url = $u; R2 = $true } } }
  return @{ Url = "https://github.com/$(Get-RepoName $root)/releases/download/ota"; R2 = $false }
}
# ---- Android signing key: lives in your user profile (like the update keys), so a new zip or project folder never loses it ----
# An APK signed with a different key cannot be installed over the old one, so a NEW key is refused when an APK was already published.
function Resolve-Keystore([string]$root) {
  $dir = Join-Path $env:USERPROFILE '.nexadesk'; New-Item -ItemType Directory -Force $dir | Out-Null
  $ks = Join-Path $dir 'nexadesk.jks'; $pw = Join-Path $dir 'keystore-password.txt'
  $oldKs = Join-Path $root 'signing\nexadesk.jks'; $oldPw = Join-Path $root 'signing\keystore-password.txt'
  if (-not (Test-Path $ks) -and (Test-Path $oldKs) -and (Test-Path $oldPw)) {
    Copy-Item $oldKs $ks; Copy-Item $oldPw $pw
    Write-Host "Your Android signing key was moved to $dir - every future project folder finds it there." -ForegroundColor Green
  }
  if (-not (Test-Path $ks) -and $env:NEXA_NEW_KEYS -ne '1') {
    $published = $false
    try {
      $r = Invoke-RestMethod "https://api.github.com/repos/$(Get-RepoName $root)/releases/tags/ota" -Headers @{ 'User-Agent' = 'NexaDesk' } -TimeoutSec 15
      $published = @($r.assets | Where-Object { $_.name -like '*.apk' }).Count -gt 0
    } catch {}
    if ($published) { throw "STOP: an APK was already published, but there is no Android signing key on this PC. A new key would make every installed app refuse the update.`nPut nexadesk.jks and keystore-password.txt from your old project's 'signing' folder into $dir and run again.`n(Only to start over with a new key and reinstall the app everywhere: set NEXA_NEW_KEYS=1 first.)" }
  }
  return @{ Dir = $dir; Ks = $ks; Pw = $pw }
}
