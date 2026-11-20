# One-time setup of a TURN relay (Cloudflare Realtime TURN) on your NexaDesk server.
# Why: phones on mobile data (5G/4G) and many hotel/office networks cannot connect directly to your PC. Without a relay the phone
# says "connected" (it reached the server) and then nothing happens until the attempt times out. With the relay the traffic is
# forwarded (still end-to-end encrypted: the relay only sees ciphertext).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cf = Join-Path $root 'cloudflare'
Write-Host @"

  1. Open  https://dash.cloudflare.com  ->  Realtime  ->  TURN Server  ->  Create   (any name).
  2. Copy the TURN Key ID and the API Token it shows (the token is shown only once).

  Cloudflare bills relayed traffic (about 0.05 USD per GB at the time of writing - check their pricing page).
  It is only used when a direct connection is impossible; a 3-10 Mbit/s screen session is roughly 1.5-4.5 GB per hour.
"@ -ForegroundColor Cyan
$id = (Read-Host 'TURN Key ID').Trim()
$plain = [System.Net.NetworkCredential]::new('', (Read-Host 'TURN API Token' -AsSecureString)).Password.Trim()
if (-not $id -or -not $plain) { throw 'Key ID and API Token are both required.' }
Write-Host 'Checking the key with Cloudflare...' -ForegroundColor DarkGray
try { $r = Invoke-RestMethod -Method Post -Uri "https://rtc.live.cloudflare.com/v1/turn/keys/$id/credentials/generate-ice-servers" -Headers @{ Authorization = "Bearer $plain" } -ContentType 'application/json' -Body '{"ttl":600}' -TimeoutSec 20 }
catch { throw "Cloudflare rejected the Key ID / API Token: $($_.Exception.Message)" }
if (-not @($r.iceServers | Where-Object { $_.username }).Count) { throw 'Cloudflare answered but returned no TURN credentials. Check that you copied the TURN key (not another token).' }
Push-Location $cf
try {
  $ErrorActionPreference = 'Continue'
  # a secret change goes live by itself (no redeploy, so the published update files are not touched)
  $id | npx wrangler secret put TURN_KEY_ID | Out-Null
  $plain | npx wrangler secret put TURN_API_TOKEN | Out-Null
  $names = (cmd /c "npx wrangler secret list 2>&1") -join ' '
} finally { Pop-Location }
if ($names -match 'TURN_KEY_ID' -and $names -match 'TURN_API_TOKEN') {
  Write-Host "`nRelay is set up. Devices pick it up when they reconnect (within a minute, or restart the app). Try the phone on 5G again." -ForegroundColor Green
} else { Write-Host "`nCould not confirm the secrets. Run START-HERE option 8 (repair the server) and then this again.`n$names" -ForegroundColor Red }
