#!/bin/sh
# Detects the PUBLIC ip (and the private one) at every start, then runs coturn. Needs TURN_SECRET in the environment (docker-compose .env).
set -e
[ -n "$TURN_SECRET" ] || { echo "TURN_SECRET is not set (put it in server/deploy/.env and in server/config.json -> turn.secret)"; exit 1; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 "$1"; else wget -qO- -T 5 "$1"; fi; }
PUB="$EXTERNAL_IP"
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do [ -n "$PUB" ] && break; PUB=$(fetch "$u" 2>/dev/null | tr -d ' \r\n' || true); done
[ -n "$PUB" ] || { echo "Could not detect the public IP. Set EXTERNAL_IP in .env"; exit 1; }
PRIV=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)
if [ -n "$PRIV" ] && [ "$PRIV" != "$PUB" ]; then EXT="$PUB/$PRIV"; else EXT="$PUB"; fi
echo "coturn external-ip=$EXT"
exec turnserver -c /etc/coturn/turnserver.conf --external-ip="$EXT" --static-auth-secret="$TURN_SECRET" --log-file=stdout
