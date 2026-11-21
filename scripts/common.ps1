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

# GitHub repository (owner/name) for the source sync, the 'ota' release and the backup downloads.
# github-repo.txt wins; otherwise the first of papayasds-ai/Nexa-Remote-Desktop, papayasds-ai/NexaDesk or <your gh login>/NexaDesk that exists; with -Create a missing
# <your gh login>/NexaDesk is created (private). Returns '' when GitHub CLI is missing / not logged in.
function Resolve-GitHubRepo([string]$root, [switch]$Create) {
  $f = Join-Path $root 'github-repo.txt'
  if (Test-Path $f) { $s = (Get-Content $f -Raw).Trim(); if ($s -match '^[\w.-]+/[\w.-]+$') { return $s } }
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { return '' }
  $ErrorActionPreference = 'Continue'
  $login = ([string](& gh.exe api user --jq .login 2>$null)).Trim()
  $ErrorActionPreference = 'Stop'
  if (-not $login) { return '' }
  foreach ($c in @('papayasds-ai/Nexa-Remote-Desktop', 'papayasds-ai/NexaDesk', "$login/NexaDesk") | Select-Object -Unique) {
    $ErrorActionPreference = 'Continue'; & gh.exe repo view $c *> $null; $ok = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
    if ($ok) { Set-Content $f $c -Encoding ASCII; return $c }
  }
  if (-not $Create) { return '' }
  $slug = "$login/NexaDesk"
  $ErrorActionPreference = 'Continue'; $out = & gh.exe repo create $slug --private --description 'NexaDesk' 2>&1; $code = $LASTEXITCODE; $ErrorActionPreference = 'Stop'
  if ($code) { throw "Could not create the GitHub repository ${slug}: $out" }
  Write-Host "Created the private GitHub repository $slug" -ForegroundColor Green
  Set-Content $f $slug -Encoding ASCII
  return $slug
}

# Secure npm install for one folder (see scripts\npm-secure.js): exact versions from package-lock.json, npm audit on every install with automatic safe
# fixes, a summary of deprecated packages, and a hard stop for high/critical advisories in what ships to users.   -Block: 'all' | 'runtime' | 'shipped' | 'none'
function Install-Packages([string]$dir, [string]$Block = 'none', [switch]$Update, [switch]$Fix, [switch]$ForceFix) {
  $a = @("$PSScriptRoot\npm-secure.js", $dir)
  if ($Block -eq 'all') { $a += '--block-all' } elseif ($Block -eq 'runtime') { $a += '--runtime' } elseif ($Block -eq 'shipped') { $a += '--shipped' }
  if ($Update) { $a += '--update' }
  if ($Fix) { $a += '--fix' }
  if ($ForceFix) { $a += '--force-fix' }
  & node @a | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE) { throw "Package install / security check failed for $dir (see above). Try: NexaDesk.bat security -Fix" }
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
# Fingerprint of the files that end up INSIDE the installed app package (desktop\main.js, preload, input helper, icons, build settings, Android package.json).
# A quick update cannot deliver these; build-windows.ps1 stamps it after every successful build and "NexaDesk.bat update" compares it.
function Get-NativeFingerprint([string]$root) {
  $files = @(Get-ChildItem (Join-Path $root 'desktop') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.js', '.ps1', '.json', '.ico', '.png' -and $_.Name -notin 'package-lock.json', 'build-config.json', 'package.json' } | ForEach-Object FullName)
  $files += @((Join-Path $root 'desktop\package.json'), (Join-Path $root 'android-app\package.json'))
  $lines = foreach ($f in ($files | Where-Object { Test-Path $_ } | Sort-Object)) {
    if ($f -like '*package.json') { $t = [IO.File]::ReadAllText($f) -replace '"version"\s*:\s*"[^"]*"', '"version":""'; $b = [Text.Encoding]::UTF8.GetBytes($t); $h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', '') }   # the version number changes on every build: ignore it
    else { $h = (Get-FileHash $f -Algorithm SHA256).Hash }
    $f.Substring($root.Length) + ' ' + $h
  }
  return ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))))).Replace('-', '').ToLower()
}
Sync-Path
