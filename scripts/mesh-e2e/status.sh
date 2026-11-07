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
gv_state="$(systemctl --user is-active "$STUDIO_UNIT" 2>/dev/null || true)"
gv_tunnel_state="$(systemctl --user is-active "$STUDIO_TUNNEL_UNIT" 2>/dev/null || true)"
gor_state="$(worker_ssh "systemctl --user is-active $WORKER_UNIT" 2>/dev/null || true)"
gor_tunnel_state="$(worker_ssh "systemctl --user is-active $WORKER_TUNNEL_UNIT" 2>/dev/null || true)"
vps_state="$(cloudbox_ssh "docker inspect -f '{{.State.Status}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' t3-mesh-e2e" 2>/dev/null || true)"
[ "$gv_state" = active ] && pass "studio server unit $STUDIO_UNIT active" || fail "studio server unit $STUDIO_UNIT: ${gv_state:-missing}"
[ "$gv_tunnel_state" = active ] && pass "studio tunnel unit active" || fail "studio tunnel unit: ${gv_tunnel_state:-missing}"
[ "$gor_state" = active ] && pass "worker server unit $WORKER_UNIT active" || fail "worker server unit $WORKER_UNIT: ${gor_state:-missing}"
[ "$gor_tunnel_state" = active ] && pass "worker tunnel unit active" || fail "worker tunnel unit: ${gor_tunnel_state:-missing}"
case "$vps_state" in
  running*) pass "VPS container t3-mesh-e2e $vps_state" ;;
  *) fail "VPS container t3-mesh-e2e: ${vps_state:-missing}" ;;
esac
echo ""

echo "== servers directly on their machines =="
check_http "studio direct" "http://127.0.0.1:$STUDIO_PORT/.well-known/t3/environment"
check_http_cmd "worker direct" worker_ssh "curl -fsS --max-time 5 http://127.0.0.1:$WORKER_PORT/.well-known/t3/environment"
check_http_cmd "cloudbox direct (host)" cloudbox_ssh "curl -fsS --max-time 5 http://127.0.0.1:$CLOUDBOX_PORT/.well-known/t3/environment"
echo ""

echo "== studio client view via tunnels =="
check_http "studio tunnel" "http://127.0.0.1:$STUDIO_LOCAL/.well-known/t3/environment"
check_http "worker tunnel" "http://127.0.0.1:$WORKER_LOCAL/.well-known/t3/environment"
check_http "cloudbox tunnel" "http://127.0.0.1:$CLOUDBOX_LOCAL/.well-known/t3/environment"
echo ""

echo "== cross-machine reachability =="
check_http_cmd "worker -> cloudbox" worker_ssh "curl -fsS --max-time 5 http://127.0.0.1:$CLOUDBOX_LOCAL/.well-known/t3/environment"
check_http_cmd "cloudbox container -> worker" cloudbox_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$CLOUDBOX_BIND:$WORKER_LOCAL/.well-known/t3/environment"
check_http_cmd "cloudbox container -> studio" cloudbox_ssh "docker exec t3-mesh-e2e curl -fsS --max-time 5 http://$CLOUDBOX_BIND:$STUDIO_LOCAL/.well-known/t3/environment"

if cloudbox_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes worker hostname" 2>/dev/null | grep -qx worker; then
  pass "cloudbox container ssh -> worker"
else
  fail "cloudbox container ssh -> worker"
fi
if cloudbox_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes studio hostname" 2>/dev/null | grep -qx studio; then
  pass "cloudbox container ssh -> studio"
else
  fail "cloudbox container ssh -> studio"
fi
echo ""

echo "== mutagen =="
gor_mutagen="$(worker_ssh '~/.local/bin/mutagen version' 2>/dev/null || true)"
vps_mutagen="$(cloudbox_ssh "docker exec t3-mesh-e2e mutagen version" 2>/dev/null || true)"
[ "$gor_mutagen" = "$MUTAGEN_VERSION" ] && pass "worker mutagen $gor_mutagen" || fail "worker mutagen: ${gor_mutagen:-missing}"
[ "$vps_mutagen" = "$MUTAGEN_VERSION" ] && pass "cloudbox mutagen $vps_mutagen" || fail "cloudbox mutagen: ${vps_mutagen:-missing}"
echo ""

echo "== ports =="
echo "studio:"; ss -H -ltn | grep -E ":($STUDIO_PORT|$STUDIO_LOCAL|$WORKER_LOCAL|$CLOUDBOX_LOCAL) " || true
echo "worker:"; worker_ssh "ss -H -ltn | grep -E ':($WORKER_PORT|$CLOUDBOX_LOCAL) ' || true"
echo "cloudbox host:"; cloudbox_ssh "ss -H -ltn | grep -E '($CLOUDBOX_BIND):($CLOUDBOX_SSH_GOR|$CLOUDBOX_SSH_GV|$WORKER_LOCAL|$STUDIO_LOCAL) |:$CLOUDBOX_PORT ' || true"
echo ""

if [ "$FAIL" = 0 ]; then
  echo "RESULT: all checks passed"
else
  echo "RESULT: failures above"
  exit 1
fi
