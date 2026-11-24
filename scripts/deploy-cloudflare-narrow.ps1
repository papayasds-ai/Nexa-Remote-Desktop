# Deployment helper for the existing NexaDesk Cloudflare Worker.
# Create an API token with Workers Editor scoped to the existing nexadesk-signaling Worker.
# Prompts securely by default so a stale environment token cannot silently be reused.
# Pass -UseEnvironment for an unattended deployment using CLOUDFLARE_API_TOKEN.
param([switch]$UseEnvironment)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$oldToken = $env:CLOUDFLARE_API_TOKEN
$oldAccountId = $env:CLOUDFLARE_ACCOUNT_ID
$secureToken = $null
$accountId = $oldAccountId
$token = if ($UseEnvironment) { $oldToken } else { '' }
$promptedToken = -not $token
if (-not $token) {
  $secureToken = Read-Host 'Cloudflare API token (input hidden; not saved)' -AsSecureString
  $promptedToken = $true
  if ($secureToken.Length -eq 0) { $secureToken.Dispose(); throw 'A Cloudflare API token is required.' }
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
  if ($LASTEXITCODE) { throw "Wrangler deploy failed with exit code $LASTEXITCODE. Check that the token is valid and has Workers Editor access to the existing nexadesk-signaling Worker. Run without -UseEnvironment to enter a token securely." }
} finally {
  if ($null -eq $oldToken) { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_API_TOKEN = $oldToken }
  if ($null -eq $oldAccountId) { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_ACCOUNT_ID = $oldAccountId }
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($pushed) { Pop-Location }
  if ($secureToken) { $secureToken.Dispose() }
}
