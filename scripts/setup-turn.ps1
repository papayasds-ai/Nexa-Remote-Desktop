# One-time setup of a TURN relay on your NexaDesk server (Cloudflare Realtime TURN and/or static TURN servers such as ExpressTURN).
# Why: phones on mobile data (5G/4G) and many hotel/office networks cannot connect directly to your PC. Without a relay the phone
# says "connected" (it reached the server) and then nothing happens until the attempt times out. With the relay the traffic is
# forwarded (still end-to-end encrypted: the relay only sees ciphertext).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cf = Join-Path $root 'cloudflare'
Write-Host @"

  Relay options for phones on 5G/4G and strict networks:
   [1] Cloudflare Realtime TURN   (dash.cloudflare.com -> Realtime -> TURN Server -> Create; copy Key ID + API Token)
   [2] Static TURN servers        (ExpressTURN / Metered / your own coturn: a JSON list of { urls, username, credential }; can be a file)
   [3] Both (recommended: Cloudflare first, the static servers as automatic fallback)
"@ -ForegroundColor Cyan
$mode = (Read-Host 'Choose 1, 2 or 3').Trim()
if ($mode -notin '1', '2', '3') { throw 'Choose 1, 2 or 3.' }
$id = ''; $plain = ''; $static = ''
if ($mode -in '1', '3') {
  Write-Host 'Cloudflare bills relayed traffic (about 0.05 USD per GB after the free allowance - check their pricing page).' -ForegroundColor DarkGray
  $id = (Read-Host 'TURN Key ID').Trim()
  $plain = [System.Net.NetworkCredential]::new('', (Read-Host 'TURN API Token' -AsSecureString)).Password.Trim()
  if (-not $id -or -not $plain) { throw 'Key ID and API Token are both required.' }
  Write-Host 'Checking the key with Cloudflare...' -ForegroundColor DarkGray
  try { $r = Invoke-RestMethod -Method Post -Uri "https://rtc.live.cloudflare.com/v1/turn/keys/$id/credentials/generate-ice-servers" -Headers @{ Authorization = "Bearer $plain" } -ContentType 'application/json' -Body '{"ttl":600}' -TimeoutSec 20 }
  catch { throw "Cloudflare rejected the Key ID / API Token: $($_.Exception.Message)" }
  if (-not @($r.iceServers | Where-Object { $_.username }).Count) { throw 'Cloudflare answered but returned no TURN credentials. Check that you copied the TURN key (not another token).' }
}
if ($mode -in '2', '3') {
  $src = (Read-Host 'Path of the JSON file with the TURN servers (e.g. TURN_script.txt)').Trim().Trim('"')
  if (-not (Test-Path $src)) { throw "File not found: $src" }
  try { $list = @(Get-Content $src -Raw | ConvertFrom-Json) } catch { throw 'That file is not valid JSON.' }
  $list = @($list | Where-Object { $_.urls -and $_.username -and $_.credential })
  if (-not $list.Count) { throw 'No usable entries: each needs urls, username and credential.' }
  $static = ConvertTo-Json -InputObject $list -Compress -Depth 4
  Write-Host "$($list.Count) static TURN entr$(if ($list.Count -eq 1) { 'y' } else { 'ies' }) accepted." -ForegroundColor DarkGray
}
Push-Location $cf
try {
  $ErrorActionPreference = 'Continue'
  # a secret change goes live by itself (no redeploy, so the published update files are not touched)
  if ($id) { $id | npx wrangler secret put TURN_KEY_ID | Out-Null; $plain | npx wrangler secret put TURN_API_TOKEN | Out-Null }
  if ($static) { $static | npx wrangler secret put TURN_STATIC | Out-Null }
  $names = (cmd /c "npx wrangler secret list 2>&1") -join ' '
} finally { Pop-Location }
$ok = $true
if ($id -and ($names -notmatch 'TURN_KEY_ID' -or $names -notmatch 'TURN_API_TOKEN')) { $ok = $false }
if ($static -and $names -notmatch 'TURN_STATIC') { $ok = $false }
if ($ok) {
  Write-Host "`nRelay is set up. Devices pick it up when they reconnect (within a minute, or restart the app). Try the phone on 5G again." -ForegroundColor Green
  try { $u = (Get-Content (Join-Path $root 'server-url.txt') -Raw).Trim() -replace '^wss://', 'https://' -replace '^ws://', 'http://'; $h = Invoke-RestMethod "$u/health" -TimeoutSec 10; Write-Host "Server reports relay available: $($h.turn)" -ForegroundColor DarkGray } catch { }
} else { Write-Host "`nCould not confirm the secrets. Run START-HERE option 8 (repair the server) and then this again.`n$names" -ForegroundColor Red; exit 1 }
exit 0
