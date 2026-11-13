# Creates / repairs the NexaDesk server on Cloudflare Workers (free plan). Safe to run repeatedly.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$cf = Join-Path $root 'cloudflare'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Install Node.js 18+ first: https://nodejs.org' -ForegroundColor Red; exit 1 }
Push-Location $cf
try {
  npm install --no-audit --no-fund | Out-Null
  $who = (cmd /c "npx wrangler whoami 2>&1") -join ' '
  if ($who -match 'not authenticated|You are not|Not logged') {
    Write-Host "`nA browser window will open to log in to Cloudflare (first time only)..." -ForegroundColor Cyan
    cmd /c "npx wrangler login"
  }
  # A deploy replaces everything the server hosts with cloudflare\public. In a fresh project folder that is empty, which would erase the
  # update that is already live - so fetch the live files first, byte for byte.
  $urlF = Join-Path $root 'server-url.txt'; $pubDir = Join-Path $cf 'public'
  if ((Test-Path $urlF) -and -not (Test-Path (Join-Path $pubDir 'update.json'))) {
    try {
      $o = (Get-Content $urlF -Raw).Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://'
      New-Item -ItemType Directory -Force $pubDir | Out-Null
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop -Uri "$o/update.json" -OutFile (Join-Path $pubDir 'update.json')
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop -Uri "$o/update.sig" -OutFile (Join-Path $pubDir 'update.sig') } catch { Remove-Item (Join-Path $pubDir 'update.sig') -Force -ErrorAction SilentlyContinue }
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop -Uri "$o/update.sig2" -OutFile (Join-Path $pubDir 'update.sig2') } catch { Remove-Item (Join-Path $pubDir 'update.sig2') -Force -ErrorAction SilentlyContinue }
      $bn = (Get-Content (Join-Path $pubDir 'update.json') -Raw | ConvertFrom-Json).bundle
      if ($bn -match '^www-\d+\.\d+\.\d+\.zip$') { Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop -Uri "$o/$bn" -OutFile (Join-Path $pubDir $bn) }
      Write-Host 'Kept the update files that are already published.' -ForegroundColor DarkGray
    } catch { Remove-Item (Join-Path $pubDir 'update.*'), (Join-Path $pubDir 'www-*.zip') -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "`nDeploying server..." -ForegroundColor Cyan
  $out = cmd /c "npx wrangler deploy 2>&1"
  $out | ForEach-Object { Write-Host $_ }
  $m = [regex]::Match(($out -join "`n"), 'https://[A-Za-z0-9.-]+\.workers\.dev')
  if (-not $m.Success) { Write-Host 'Deploy failed or URL not found - see messages above.' -ForegroundColor Red; exit 1 }

  function NewHex { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
  $existing = (cmd /c "npx wrangler secret list 2>&1") -join ' '
  if ($existing -notmatch 'SERVER_SECRET') { NewHex | npx wrangler secret put SERVER_SECRET | Out-Null; Write-Host 'SERVER_SECRET created.' -ForegroundColor Green }
  $tokFile = Join-Path $root 'notify-token.txt'
  if (-not (Test-Path $tokFile) -or $existing -notmatch 'OTA_NOTIFY_TOKEN') {
    $tok = NewHex; $tok | npx wrangler secret put OTA_NOTIFY_TOKEN | Out-Null; $tok | Set-Content $tokFile -Encoding ASCII
    Write-Host 'Instant-update key created.' -ForegroundColor Green
  }
  $wss = $m.Value -replace '^https://', 'wss://'
  $wss | Set-Content (Join-Path $root 'server-url.txt') -Encoding ASCII
  Write-Host "`nServer ready: $wss  (saved automatically - apps receive it by themselves)" -ForegroundColor Green
} finally { Pop-Location }
