# One-time deployment helper for an existing NexaDesk Cloudflare Worker.
# Create a Cloudflare API token scoped to Workers Editor for only nexadesk-signaling.
# It uses existing process environment variables for unattended runs, or prompts securely and never saves the token.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$oldToken = $env:CLOUDFLARE_API_TOKEN
$oldAccountId = $env:CLOUDFLARE_ACCOUNT_ID
$secureToken = $null
$accountId = $oldAccountId
$token = $oldToken
$promptedToken = $false
if (-not $token) {
  $secureToken = Read-Host 'Cloudflare API token (input hidden; not saved)' -AsSecureString
  $promptedToken = $true
}
if (-not $accountId) { $accountId = (Read-Host 'Cloudflare account ID').Trim() }
if ($accountId -notmatch '^[0-9a-fA-F]{32}$') { throw 'Cloudflare account ID must be 32 hexadecimal characters.' }
$ptr = [IntPtr]::Zero
$pushed = $false
try {
  if ($promptedToken) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  $env:CLOUDFLARE_API_TOKEN = $token
  $env:CLOUDFLARE_ACCOUNT_ID = $accountId
  Push-Location (Join-Path $root 'cloudflare')
  $pushed = $true
  & npx.cmd wrangler deploy
  if ($LASTEXITCODE) { throw "Wrangler deploy failed with exit code $LASTEXITCODE." }
} finally {
  if ($null -eq $oldToken) { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_API_TOKEN = $oldToken }
  if ($null -eq $oldAccountId) { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_ACCOUNT_ID = $oldAccountId }
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($pushed) { Pop-Location }
  if ($secureToken) { $secureToken.Dispose() }
}
