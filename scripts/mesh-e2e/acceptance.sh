#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(dirname "$0")/lib.sh"
if [ "${1:-}" = --plan ]; then
  printf '%s\n' 'build deploy network-proxies round1 round2 config network-nat network-ssh network-faults round3 stage-m real-provider-guards realistic-matrix'
  exit 0
fi
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
owner="mesh-nightly-$run_id"
root="$BED_NIGHTLY_ROOT/runs/$run_id"
mkdir -p "$root"
chmod 700 "$root"
export MESH_E2E_LOCK_OWNER="$owner"
while :; do
  set +e
  worker_ssh "mkdir /tmp/mesh-bed.lock && printf '%s' '$owner' > /tmp/mesh-bed.lock/owner"
  rc=$?
  set -e
  [ "$rc" = 0 ] && break
  [ "$rc" != 255 ] || die 'The nightly worker is unreachable'
  printf 'Bed busy; waiting five minutes.\n'
  sleep 300
done
cleanup() {
  local rc=$?
  if [ -f "$root/proxies-up" ]; then
    "$MESH_DIR/network-bed.sh" restore || rc=1
    "$MESH_DIR/network-proxies.sh" down || rc=1
  fi
  worker_ssh "if test \"\$(cat /tmp/mesh-bed.lock/owner)\" = '$owner'; then rm /tmp/mesh-bed.lock/owner; rmdir /tmp/mesh-bed.lock; else exit 1; fi" || rc=1
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$BED_NIGHTLY_ROOT/state/legacy"
for file in "$LEGACY_STUDIO_FILE" "$LEGACY_REMOTE_FILE"; do cp "$STATE_DIR/legacy/$file" "$BED_NIGHTLY_ROOT/state/legacy/$file"; done
export MESH_E2E_ARTIFACTS="$BED_NIGHTLY_ROOT/artifacts"
export MESH_E2E_BUILD_DIR="$BED_NIGHTLY_ROOT/build"
export MESH_E2E_STATE_DIR="$BED_NIGHTLY_ROOT/state"
export MESH_E2E_IMAGE=t3-mesh-e2e:nightly
export MESH_E2E_REUSE_NETWORK=1
export MESH_E2E_LIVE_REPORTS=1
export MESH_E2E_SESSION_TTL=4h
export MESH_E2E_ROUND1_WORK="$root/round1"
export MESH_E2E_RUN_PREFIX="T1-nightly-$run_id"
export MESH_E2E_LOCAL_PRIMARY_ROOT="$root/second-primary"
export MESH_E2E_REVERSE_ROOT="/tmp/T1-nightly-$run_id/reverse"
export MESH_E2E_REVERSE_TITLE="T1-nightly-$run_id-reverse"
export MESH_E2E_DEMO_ROOT="$WORKER_HOME/t1-nightly-$run_id/demo"
export MESH_E2E_DEMO_TITLE="T1-nightly-$run_id"
export MESH_E2E_ROUND2_WORK="$root/round2"
export MESH_E2E_ROUND3_WORK="$root/round3"
export MESH_E2E_CONFIG_WORK="$root/config"
export MESH_E2E_STAGE_M_WORK="$root/agents"
export N1_BED_OPS="$root/network"
export RUSTUP_HOME="$BED_NIGHTLY_ROOT/toolchain/rustup"
export CARGO_HOME="$BED_NIGHTLY_ROOT/toolchain/cargo"
mkdir -p "$CARGO_HOME/bin"
if [ ! -f "$CARGO_HOME/bin/rustup" ]; then cp "$(command -v rustup)" "$CARGO_HOME/bin/rustup"; fi
for tool in cargo rustc rustdoc; do ln -sf rustup "$CARGO_HOME/bin/$tool"; done
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$CARGO_HOME/bin:$PATH
rustup toolchain install 1.95.0 --profile minimal
export RUSTUP_TOOLCHAIN=1.95.0
"$MESH_DIR/build.sh" "${MESH_E2E_NIGHTLY_REF:-xdev}"
export MESH_FAST_PRODUCT_ROOT="$MESH_E2E_BUILD_DIR"
"$MESH_DIR/deploy.sh"
systemctl --user start "$STUDIO_TUNNEL_UNIT"
worker_ssh "systemctl --user start $WORKER_TUNNEL_UNIT"
"$MESH_DIR/tunnels.sh" status
"$MESH_DIR/network-proxies.sh" up
touch "$root/proxies-up"
"$MESH_DIR/network-proxies.sh" block
"$MESH_DIR/round1.sh"
"$MESH_DIR/network-bed.sh" nat
"$MESH_DIR/round2.sh"
"$MESH_DIR/config.sh"
"$MESH_DIR/network-bed.sh" ssh
"$MESH_DIR/network-bed.sh" faults
"$MESH_DIR/round3.sh"
"$MESH_DIR/stage-m.sh"
export R1_CODEX_BINARY="${R1_CODEX_BINARY:-$(command -v codex)}"
export R1_OPENCODE_BINARY="${R1_OPENCODE_BINARY:-$(command -v opencode)}"
R1_HARNESS_EVIDENCE="$root/real-provider-guards" node "$MESH_DIR/r1-harness.mjs"
"$MESH_DIR/c2-bed.sh"
"$MESH_DIR/f1-bed.sh"
MESH_FAST_REALISTIC=1 "$REPO_ROOT/scripts/mesh-fast/run.sh" --jobs 1
printf 'PASS nightly realistic mesh suite; evidence %s\n' "$root"
