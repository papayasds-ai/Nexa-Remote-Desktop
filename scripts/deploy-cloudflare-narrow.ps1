# One-time deployment helper for an existing NexaDesk Cloudflare Worker.
# Create a Cloudflare API token scoped to Workers Editor for only nexadesk-signaling.
# This script prompts securely and keeps the token only in this process environment.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$secureToken = Read-Host 'Cloudflare API token (input hidden; not saved)' -AsSecureString
$accountId = (Read-Host 'Cloudflare account ID').Trim()
if ($accountId -notmatch '^[0-9a-fA-F]{32}$') { throw 'Cloudflare account ID must be 32 hexadecimal characters.' }
$ptr = [IntPtr]::Zero
$pushed = $false
try {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $env:CLOUDFLARE_ACCOUNT_ID = $accountId
  Push-Location (Join-Path $root 'cloudflare')
  $pushed = $true
  & npx.cmd wrangler deploy
  if ($LASTEXITCODE) { throw "Wrangler deploy failed with exit code $LASTEXITCODE." }
} finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($pushed) { Pop-Location }
  $secureToken.Dispose()
}
