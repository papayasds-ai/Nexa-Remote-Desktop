# Installs and starts the NexaDesk signaling server on this machine (Windows).
param([int]$Port = 8080, [string]$TurnHost = "", [string]$TurnSecret = "")
$ErrorActionPreference = 'Stop'
$srv = Join-Path (Split-Path $PSScriptRoot -Parent) 'server'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18+ is required: https://nodejs.org' }
Push-Location $srv
try {
  npm install --omit=dev --no-fund
  if ($LASTEXITCODE) { throw 'npm install failed' }
  $cfg = @{ port = $Port; stun = @('stun:stun.l.google.com:19302') }
  if ($TurnHost -and $TurnSecret) {
    $cfg.turn = @{ urls = @("turn:$TurnHost`:3478?transport=udp", "turns:$TurnHost`:5349?transport=tcp"); secret = $TurnSecret }
  }
  $cfg | ConvertTo-Json -Depth 5 | Set-Content config.json -Encoding UTF8
  Write-Host "`nServer starting on port $Port. For internet use put it behind TLS (Caddy/nginx) so clients use wss://" -ForegroundColor Cyan
  Write-Host "Open TCP $Port in the firewall if clients are on other machines.`n"
  node server.js
} finally { Pop-Location }
