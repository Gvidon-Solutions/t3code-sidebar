#!/usr/bin/env bash
# Opens the VPS T3 server in the local browser: ensures the SSH tunnel to
# 127.0.0.1:3790 is up, mints a one-time pairing token and opens the pair URL.
set -euo pipefail
CFG="$HOME/.local/share/vpn-ops/ssh_config"
HOST=152.89.244.57
PORT=3790

if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/"; then
  ssh -F "$CFG" -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L "127.0.0.1:$PORT:127.0.0.1:$PORT" "$HOST"
fi

token=$(ssh -F "$CFG" "$HOST" \
  "docker exec t3-ws node /opt/t3/dist/bin.mjs pair --ttl 10m --label ${1:-browser}" 2>&1 |
  grep -o 'token=[A-Z0-9]*' | head -1)
[ -n "$token" ] || { echo "failed to mint a pairing token" >&2; exit 1; }

url="http://localhost:$PORT/pair#$token"
xdg-open "$url" >/dev/null 2>&1 || echo "$url"
