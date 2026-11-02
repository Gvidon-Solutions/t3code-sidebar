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
gv_state="$(systemctl --user is-active "$GV_UNIT" 2>/dev/null || true)"
gv_tunnel_state="$(systemctl --user is-active "$GV_TUNNEL_UNIT" 2>/dev/null || true)"
gor_state="$(gor_ssh "systemctl --user is-active $GOR_UNIT" 2>/dev/null || true)"
gor_tunnel_state="$(gor_ssh "systemctl --user is-active $GOR_TUNNEL_UNIT" 2>/dev/null || true)"
vps_state="$(vps_ssh "docker inspect -f '{{.State.Status}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' t3-mesh-e2e" 2>/dev/null || true)"
[ "$gv_state" = active ] && pass "gvidon server unit $GV_UNIT active" || fail "gvidon server unit $GV_UNIT: ${gv_state:-missing}"
[ "$gv_tunnel_state" = active ] && pass "gvidon tunnel unit active" || fail "gvidon tunnel unit: ${gv_tunnel_state:-missing}"
[ "$gor_state" = active ] && pass "gor server unit $GOR_UNIT active" || fail "gor server unit $GOR_UNIT: ${gor_state:-missing}"
[ "$gor_tunnel_state" = active ] && pass "gor tunnel unit active" || fail "gor tunnel unit: ${gor_tunnel_state:-missing}"
case "$vps_state" in
  running*) pass "VPS container t3-mesh-e2e $vps_state" ;;
  *) fail "VPS container t3-mesh-e2e: ${vps_state:-missing}" ;;
esac
echo ""

echo "== servers directly on their machines =="
check_http "gv direct" "http://127.0.0.1:$GV_PORT/.well-known/t3/environment"
check_http_cmd "gor direct" gor_ssh "curl -fsS --max-time 5 http://127.0.0.1:$GOR_PORT/.well-known/t3/environment"
check_http_cmd "vps direct (host)" vps_ssh "curl -fsS --max-time 5 http://127.0.0.1:$VPS_PORT/.well-known/t3/environment"
echo ""

echo "== gvidon client view via tunnels =="
check_http "gv tunnel" "http://127.0.0.1:$GV_LOCAL/.well-known/t3/environment"
check_http "gor tunnel" "http://127.0.0.1:$GOR_LOCAL/.well-known/t3/environment"
check_http "vps tunnel" "http://127.0.0.1:$VPS_LOCAL/.well-known/t3/environment"
echo ""

echo "== cross-machine reachability =="
check_http_cmd "gor -> vps" gor_ssh "curl -fsS --max-time 5 http://127.0.0.1:$VPS_LOCAL/.well-known/t3/environment"
check_http_cmd "gor -> gvidon live (13773)" gor_ssh "curl -fsS --max-time 5 http://127.0.0.1:13773/.well-known/t3/environment"
check_http_cmd "vps container -> gor" vps_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$VPS_BIND:$GOR_LOCAL/.well-known/t3/environment"
check_http_cmd "vps container -> gvidon" vps_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$VPS_BIND:$GV_LOCAL/.well-known/t3/environment"

if vps_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes gor hostname" 2>/dev/null | grep -qx gor; then
  pass "vps container ssh -> gor"
else
  fail "vps container ssh -> gor"
fi
if vps_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes gvidon hostname" 2>/dev/null | grep -qx gvidon; then
  pass "vps container ssh -> gvidon"
else
  fail "vps container ssh -> gvidon"
fi
echo ""

echo "== mutagen =="
gor_mutagen="$(gor_ssh '~/.local/bin/mutagen version' 2>/dev/null || true)"
vps_mutagen="$(vps_ssh "docker exec t3-mesh-e2e mutagen version" 2>/dev/null || true)"
[ "$gor_mutagen" = "$MUTAGEN_VERSION" ] && pass "gor mutagen $gor_mutagen" || fail "gor mutagen: ${gor_mutagen:-missing}"
[ "$vps_mutagen" = "$MUTAGEN_VERSION" ] && pass "vps mutagen $vps_mutagen" || fail "vps mutagen: ${vps_mutagen:-missing}"
echo ""

echo "== ports =="
echo "gvidon:"; ss -H -ltn | grep -E ":($GV_PORT|$GV_LOCAL|$GOR_LOCAL|$VPS_LOCAL) " || true
echo "gor:"; gor_ssh "ss -H -ltn | grep -E ':($GOR_PORT|$VPS_LOCAL) ' || true"
echo "vps host:"; vps_ssh "ss -H -ltn | grep -E '($VPS_BIND):($VPS_SSH_GOR|$VPS_SSH_GV|$GOR_LOCAL|$GV_LOCAL) |:$VPS_PORT ' || true"
echo ""

if [ "$FAIL" = 0 ]; then
  echo "RESULT: all checks passed"
else
  echo "RESULT: failures above"
  exit 1
fi
