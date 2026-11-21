# New-PC readiness check (read-only, changes nothing): lists what is missing before you build from scratch on another computer.
#   NexaDesk.bat setup
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\common.ps1"
$script:block = @(); $script:notes = 0
function Good([string]$m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Need([string]$m, [string]$fix) { $script:block += $m; Write-Host "  [FIX]  $m" -ForegroundColor Red; Write-Host "         $fix" -ForegroundColor Yellow }
function Note([string]$m, [string]$fix = '') { $script:notes++; Write-Host "  [note] $m" -ForegroundColor Yellow; if ($fix) { Write-Host "         $fix" -ForegroundColor DarkGray } }

Write-Host "`nTools" -ForegroundColor Cyan
if (Get-Command node -ErrorAction SilentlyContinue) {
  $nv = [version]((node -v).TrimStart('v'))
  if ($nv -ge [version]'22.12.0') { Good "Node.js $nv" } else { Need "Node.js $nv is too old (22.12 or newer needed)" 'winget install OpenJS.NodeJS.LTS' }
} else { Need 'Node.js is missing' 'winget install OpenJS.NodeJS.LTS' }
if (Get-Command git -ErrorAction SilentlyContinue) { Good 'Git' } else { Need 'Git is missing' 'winget install Git.Git' }
if (Get-Command gh.exe -ErrorAction SilentlyContinue) {
  & gh.exe auth status *> $null
  if ($LASTEXITCODE -eq 0) { Good 'GitHub CLI, logged in' } else { Need 'GitHub CLI is not logged in' 'gh auth login   (GitHub.com, HTTPS, log in with the browser)' }
} else { Need 'GitHub CLI is missing' 'winget install GitHub.cli' }
if (Get-Command java -ErrorAction SilentlyContinue) { Good 'JDK found (the Android APK can be built)' }
else { Note 'JDK 17 not found: the Android APK will be skipped' 'winget install EclipseAdoptium.Temurin.17.JDK   (the Android SDK itself is installed automatically)' }

Write-Host "`nServer" -ForegroundColor Cyan
$pub = Get-PublishedManifest $root
switch ($script:ManifestStatus) {
  'ok'          { Good "server answers ($(Get-ServerOrigin $root)), published version v$($pub.version)" }
  'none'        { Note 'server answers but nothing is published yet' 'Full release or Quick update publishes the first version' }
  'unreachable' { Need 'server-url.txt is set but the server cannot be reached' 'check the internet connection, or run  NexaDesk.bat server  to redeploy it' }
  default       { Note 'no server-url.txt: Full release creates the Cloudflare server (a browser opens once to log in to Cloudflare)' }
}
if (Test-Path (Join-Path $root 'notify-token.txt')) { Good 'notify-token.txt (instant ping to devices)' }
elseif ($script:ManifestStatus -eq 'ok') { Note 'notify-token.txt is missing: devices still update within a minute, just not instantly' 'NexaDesk.bat server  creates a new one' }

Write-Host "`nUpdate keys" -ForegroundColor Cyan
$daily = Join-Path $env:USERPROFILE '.nexadesk\update-key.pem'
$trust = if ($pub -and $pub.trust) { @($pub.trust) } else { @() }
if (Test-Path $daily) {
  $id = ([string](& node "$PSScriptRoot\sign-manifest.js" keyid $daily 2>$null)).Trim()
  if (-not $trust.Count) { Good "daily update key $id (nothing published yet, so nothing to match)" }
  elseif ($trust -contains $id) { Good "daily update key $id matches what your devices trust" }
  else { Need "your daily key ($id) is NOT what the devices trust ($($trust -join ', '))" 'copy the right update-key.pem from the old PC into %USERPROFILE%\.nexadesk, or run once:  NexaDesk.bat update -RecoveryKey <your recovery .pem file>' }
} elseif ($trust.Count) {
  Need "update-key.pem is missing, but the devices already trust $($trust -join ', ')" 'copy %USERPROFILE%\.nexadesk\update-key.pem from the old PC, or run once:  NexaDesk.bat update -RecoveryKey <your recovery .pem file>'
} else { Note 'no update key yet: the first release creates it, plus a recovery key that you must move to a password manager or USB stick' }

Write-Host "`nAndroid" -ForegroundColor Cyan
if (Test-Path (Join-Path $root 'signing\nexadesk.jks')) { Good 'Android keystore found: new APKs install over the old one' }
else { Note 'no Android keystore (signing\nexadesk.jks): a NEW one is created, and phones that have the old APK must uninstall it first' 'to keep updating existing phones copy signing\ from the old PC:  NexaDesk.bat migrate' }

Write-Host "`nGitHub and installers" -ForegroundColor Cyan
$repo = Resolve-GitHubRepo $root
if ($repo) { Good "GitHub repository: $repo" } else { Note 'no GitHub repository known yet' 'it is found or created on the first release (needs the gh login above)' }
if (Test-Path (Join-Path $root 'release-host.txt')) { Good 'release-host.txt: installers are served from your release host' }
elseif ($repo -and (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
  $vis = ([string](& gh.exe repo view $repo --json visibility --jq .visibility 2>$null)).Trim()
  if ($vis -eq 'PUBLIC') { Good 'repository is public: installers download without a login' }
  else { Note 'repository is private and there is no release-host.txt: devices still get instant screen updates, but new Setup/APK files must be installed by hand' "copy release-host.txt from the old PC, or: gh repo edit $repo --visibility public --accept-visibility-change-consequences" }
}

$local = if (Test-Path (Join-Path $root 'VERSION')) { (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() } else { '1.0.0' }
Write-Host "`nVersion: local $local, published $(if ($pub -and $pub.version) { $pub.version } else { 'none' }). The next release is one patch above the higher of the two." -ForegroundColor DarkGray
Write-Host ''
if ($script:block.Count) { Write-Host "Not ready: fix the $($script:block.Count) item(s) marked [FIX], then run  NexaDesk.bat setup  again." -ForegroundColor Red; exit 1 }
Write-Host 'Ready. Run NexaDesk.bat and choose 1 (Full release) or 2 (Quick update).' -ForegroundColor Green
if ($script:notes) { Write-Host "($($script:notes) note(s) above are optional or happen automatically.)" -ForegroundColor DarkGray }
