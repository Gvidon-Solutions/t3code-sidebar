#!/usr/bin/env bash
# Mint one-time pairing tokens on all three test servers and print ready URLs
# for a browser on studio and for an Android emulator running on studio.
#
# Usage: pair.sh [ttl]        (default 2h)
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_build_env
TTL="${1:-${MESH_E2E_PAIR_TTL:-2h}}"

mint_token() {
  local output token
  output="$1"
  token="$(printf '%s\n' "$output" | sed -n 's/^Token: //p' | head -1)"
  if [ -z "$token" ]; then
    # Older builds may not print the Token line; fall back to the pair URL.
    token="$(printf '%s\n' "$output" | grep -oE 'token=[A-Za-z0-9._~%-]+' | head -1 | cut -d= -f2-)"
  fi
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

mint_nodeA() {
  local label=$1 out token
  out="$("$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3" pair \
    --base-dir "$NODE_A_BASE_DIR" --ttl "$TTL" --label "$label" 2>&1)" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  token="$(mint_token "$out")" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  printf '%s' "$token"
}

mint_nodeB() {
  local label=$1 out token
  out="$(nodeB_ssh "~/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3 pair \
    --base-dir ~/.t3-sidebar-server --ttl $TTL --label '$label'" 2>&1)" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  token="$(mint_token "$out")" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  printf '%s' "$token"
}

mint_cloud() {
  local label=$1 out token
  out="$(cloud_ssh "docker exec t3-mesh-e2e node /opt/t3/dist/bin.mjs pair \
    --base-dir /home/t3/.t3 --ttl $TTL --label '$label'" 2>&1)" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  token="$(mint_token "$out")" || {
    printf '%s\n' "$out" >&2
    return 1
  }
  printf '%s' "$token"
}

print_site() {
  local name=$1 port=$2 mint=$3
  local web_token android_token
  echo ""
  echo "== $name (studio local port $port) =="
  web_token="$($mint "$name-web")" || die "$name: failed to mint a web token"
  android_token="$($mint "$name-android")" || die "$name: failed to mint an Android token"
  echo "web:      http://127.0.0.1:$port/pair#token=$web_token"
  echo "emulator: http://10.0.2.2:$port/pair#token=$android_token"
  echo "token ttl: $TTL (one-time tokens)"
}

require_bins
print_site nodeA "$NODE_A_LOCAL" mint_nodeA
print_site nodeB "$NODE_B_LOCAL" mint_nodeB
print_site cloud "$CLOUD_LOCAL" mint_cloud

echo ""
echo "Android emulator on another host: adb reverse tcp:$NODE_A_LOCAL tcp:$NODE_A_LOCAL and use 127.0.0.1."
echo "Tunnels must be up (tunnels.sh up). Tokens expire after $TTL."
