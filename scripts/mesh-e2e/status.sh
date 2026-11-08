#!/usr/bin/env bash
# Health of the T3 Mesh E2E bed: units, container, HTTP descriptors, tunnel
# reachability in every required direction, and Mutagen versions.
#
# Exit code is non-zero when any check fails.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_build_env
require_bins

FAIL=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAIL=1
}

descriptor_fields() {
  local json=$1
  printf '%s | %s' "$(printf '%s' "$json" | jq -r '.serverVersion // "?"')" \
    "$(printf '%s' "$json" | jq -r '.environmentId // "?"')"
}

check_http() {
  local name=$1 url=$2 json
  if json="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
    pass "$name HTTP $url  $(descriptor_fields "$json")"
  else
    fail "$name HTTP $url"
  fi
}

check_http_cmd() {
  local name=$1; shift
  local json
  if json="$("$@" 2>/dev/null)"; then
    pass "$name HTTP  $(descriptor_fields "$json")"
  else
    fail "$name HTTP"
  fi
}

echo "== build =="
echo "ref $REF @ $COMMIT"
echo "runtime $BUILD_VERSION"
echo ""

echo "== units / container =="
nodeA_state="$(systemctl --user is-active "$NODE_A_UNIT" 2>/dev/null || true)"
nodeA_tunnel_state="$(systemctl --user is-active "$NODE_A_TUNNEL_UNIT" 2>/dev/null || true)"
nodeB_state="$(nodeB_ssh "systemctl --user is-active $NODE_B_UNIT" 2>/dev/null || true)"
nodeB_tunnel_state="$(nodeB_ssh "systemctl --user is-active $NODE_B_TUNNEL_UNIT" 2>/dev/null || true)"
cloud_state="$(cloud_ssh "docker inspect -f '{{.State.Status}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' t3-mesh-e2e" 2>/dev/null || true)"
[ "$nodeA_state" = active ] && pass "studio server unit $NODE_A_UNIT active" || fail "studio server unit $NODE_A_UNIT: ${nodeA_state:-missing}"
[ "$nodeA_tunnel_state" = active ] && pass "studio tunnel unit active" || fail "studio tunnel unit: ${nodeA_tunnel_state:-missing}"
[ "$nodeB_state" = active ] && pass "nodeB server unit $NODE_B_UNIT active" || fail "nodeB server unit $NODE_B_UNIT: ${nodeB_state:-missing}"
[ "$nodeB_tunnel_state" = active ] && pass "nodeB tunnel unit active" || fail "nodeB tunnel unit: ${nodeB_tunnel_state:-missing}"
case "$cloud_state" in
  running*) pass "CLOUD container t3-mesh-e2e $cloud_state" ;;
  *) fail "CLOUD container t3-mesh-e2e: ${cloud_state:-missing}" ;;
esac
echo ""

echo "== servers directly on their machines =="
check_http "nodeA direct" "http://127.0.0.1:$NODE_A_PORT/.well-known/t3/environment"
check_http_cmd "nodeB direct" nodeB_ssh "curl -fsS --max-time 5 http://127.0.0.1:$NODE_B_PORT/.well-known/t3/environment"
check_http_cmd "cloud direct (host)" cloud_ssh "curl -fsS --max-time 5 http://127.0.0.1:$CLOUD_PORT/.well-known/t3/environment"
echo ""

echo "== studio client view via tunnels =="
check_http "nodeA tunnel" "http://127.0.0.1:$NODE_A_LOCAL/.well-known/t3/environment"
check_http "nodeB tunnel" "http://127.0.0.1:$NODE_B_LOCAL/.well-known/t3/environment"
check_http "cloud tunnel" "http://127.0.0.1:$CLOUD_LOCAL/.well-known/t3/environment"
echo ""

echo "== cross-machine reachability =="
check_http_cmd "nodeB -> cloud" nodeB_ssh "curl -fsS --max-time 5 http://127.0.0.1:$CLOUD_LOCAL/.well-known/t3/environment"
check_http_cmd "cloud container -> nodeB" cloud_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$CLOUD_BIND:$NODE_B_LOCAL/.well-known/t3/environment"
check_http_cmd "cloud container -> studio" cloud_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$CLOUD_BIND:$NODE_A_LOCAL/.well-known/t3/environment"

if cloud_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes nodeB hostname" 2>/dev/null | grep -qx nodeB; then
  pass "cloud container ssh -> nodeB"
else
  fail "cloud container ssh -> nodeB"
fi
if cloud_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes studio hostname" 2>/dev/null | grep -qx studio; then
  pass "cloud container ssh -> studio"
else
  fail "cloud container ssh -> studio"
fi
echo ""

echo "== mutagen =="
nodeB_mutagen="$(nodeB_ssh '~/.local/bin/mutagen version' 2>/dev/null || true)"
cloud_mutagen="$(cloud_ssh "docker exec t3-mesh-e2e mutagen version" 2>/dev/null || true)"
[ "$nodeB_mutagen" = "$MUTAGEN_VERSION" ] && pass "nodeB mutagen $nodeB_mutagen" || fail "nodeB mutagen: ${nodeB_mutagen:-missing}"
[ "$cloud_mutagen" = "$MUTAGEN_VERSION" ] && pass "cloud mutagen $cloud_mutagen" || fail "cloud mutagen: ${cloud_mutagen:-missing}"
echo ""

echo "== ports =="
echo "studio:"; ss -H -ltn | grep -E ":($NODE_A_PORT|$NODE_A_LOCAL|$NODE_B_LOCAL|$CLOUD_LOCAL) " || true
echo "nodeB:"; nodeB_ssh "ss -H -ltn | grep -E ':($NODE_B_PORT|$CLOUD_LOCAL) ' || true"
echo "cloud host:"; cloud_ssh "ss -H -ltn | grep -E '($CLOUD_BIND):($CLOUD_SSH_NODE_B|$CLOUD_SSH_NODE_A|$NODE_B_LOCAL|$NODE_A_LOCAL) |:$CLOUD_PORT ' || true"
echo ""

if [ "$FAIL" = 0 ]; then
  echo "RESULT: all checks passed"
else
  echo "RESULT: failures above"
  exit 1
fi
