#!/usr/bin/env bash
# Shared configuration for the T3 Mesh E2E test bed. Source, do not execute.
set -euo pipefail

MESH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$MESH_DIR/../.." && pwd)"

if [ -f "$MESH_DIR/local.env" ]; then
  . "$MESH_DIR/local.env"
fi
: "${NODE_B_SSH_CONFIG:?Set NODE_B_SSH_CONFIG in scripts/mesh-e2e/local.env}"
: "${NODE_B_SSH_KEY:?Set NODE_B_SSH_KEY in scripts/mesh-e2e/local.env}"
: "${NODE_B_HOST:?Set NODE_B_HOST in scripts/mesh-e2e/local.env}"
: "${CLOUD_SSH_CONFIG:?Set CLOUD_SSH_CONFIG in scripts/mesh-e2e/local.env}"
: "${CLOUD_HOST:?Set CLOUD_HOST in scripts/mesh-e2e/local.env}"
: "${CLOUD_KNOWN_HOSTS:?Set CLOUD_KNOWN_HOSTS in scripts/mesh-e2e/local.env}"
: "${NODE_A_PUBLIC_IP:?Set NODE_A_PUBLIC_IP in scripts/mesh-e2e/local.env}"
: "${NODE_B_PUBLIC_IP:?Set NODE_B_PUBLIC_IP in scripts/mesh-e2e/local.env}"
: "${NODE_A_NODE_BIN_DIR:?Set NODE_A_NODE_BIN_DIR in scripts/mesh-e2e/local.env}"
: "${NODE_B_NODE_BIN_DIR:?Set NODE_B_NODE_BIN_DIR in scripts/mesh-e2e/local.env}"
: "${NODE_B_STATE_DIR:?Set NODE_B_STATE_DIR in scripts/mesh-e2e/local.env}"
: "${NODE_B_DEMO_DIR:?Set NODE_B_DEMO_DIR in scripts/mesh-e2e/local.env}"
: "${CLOUD_DIR:?Set CLOUD_DIR in scripts/mesh-e2e/local.env}"
: "${CLOUD_SSH_USER:?Set CLOUD_SSH_USER in scripts/mesh-e2e/local.env}"

export PATH="$NODE_A_NODE_BIN_DIR:$PATH"
STATE_DIR="${MESH_E2E_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/t3-mesh-e2e}"
ARTIFACTS_DIR="${MESH_E2E_ARTIFACTS:-$STATE_DIR/artifacts}"
BUILD_DIR="${MESH_E2E_BUILD_DIR:-$STATE_DIR/build}"
BUILD_ENV="$ARTIFACTS_DIR/build.env"
NODE_A_PORT="${NODE_A_PORT:-3795}"
NODE_B_PORT="${NODE_B_PORT:-3797}"
CLOUD_PORT="${CLOUD_PORT:-3791}"
NODE_A_LOCAL="${NODE_A_LOCAL:-$NODE_A_PORT}"
NODE_B_LOCAL="${NODE_B_LOCAL:-13797}"
CLOUD_LOCAL="${CLOUD_LOCAL:-13791}"
CLOUD_BIND="${CLOUD_BIND:-172.17.0.1}"
CLOUD_SSH_NODE_B="${CLOUD_SSH_NODE_B:-22022}"
CLOUD_SSH_NODE_A="${CLOUD_SSH_NODE_A:-22023}"
NODE_A_SSHD_PORT="${NODE_A_SSHD_PORT:-22295}"
NODE_B_SSHD_PORT="${NODE_B_SSHD_PORT:-22297}"
NODE_A_BASE_DIR="${NODE_A_BASE_DIR:-$STATE_DIR/nodeA/server}"
NODE_A_RUNTIME_ROOT="${NODE_A_RUNTIME_ROOT:-$STATE_DIR/nodeA/runtime}"
NODE_B_BASE_DIR="${NODE_B_BASE_DIR:-$NODE_B_STATE_DIR/server}"
NODE_B_RUNTIME_ROOT="${NODE_B_RUNTIME_ROOT:-$NODE_B_STATE_DIR/runtime}"
CLOUD_DATA="$CLOUD_DIR/home"
NODE_A_UNIT="${NODE_A_UNIT:-t3-mesh-e2e-nodeA.service}"
NODE_B_UNIT="${NODE_B_UNIT:-t3-mesh-e2e-nodeB.service}"
NODE_A_TUNNEL_UNIT="${NODE_A_TUNNEL_UNIT:-t3-mesh-e2e-nodeA-tunnels.service}"
NODE_B_TUNNEL_UNIT="${NODE_B_TUNNEL_UNIT:-t3-mesh-e2e-nodeB-tunnels.service}"
IMAGE="${MESH_E2E_IMAGE:-t3-mesh-e2e:dev}"
MUTAGEN_VERSION=0.18.1
MUTAGEN_SHA256=7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f
KEY_TAG=t3-mesh-e2e
REVERSE_KEY_NODE_A="$STATE_DIR/ssh/cloud"
REVERSE_KEY_NODE_B="$NODE_B_STATE_DIR/ssh/cloud"
SELF_KEY="$STATE_DIR/ssh/self"

if [ "${MESH_E2E_ALLOW_LIVE:-0}" != 1 ]; then
  for unit in "$NODE_A_UNIT" "$NODE_B_UNIT"; do
    case "$unit" in t3-mesh-e2e-*.service) ;; *) echo 'Live service action requires MESH_E2E_ALLOW_LIVE=1' >&2; exit 1 ;; esac
  done
  for port in "$NODE_A_PORT" "$NODE_B_PORT" "$CLOUD_PORT"; do
    [ "$port" != 3774 ] || { echo 'Live port requires MESH_E2E_ALLOW_LIVE=1' >&2; exit 1; }
  done
  for directory in "$STATE_DIR" "$NODE_A_BASE_DIR" "$NODE_B_STATE_DIR" "$NODE_B_BASE_DIR" "$CLOUD_DIR"; do
    case "$directory" in */.t3|*/.t3/*|*/.t3-sidebar|*/.t3-sidebar/*|*/.t3-sidebar-*|*/.t3-sidebar-*/*|*/t3-ws|/|"$HOME")
      echo 'Live data requires MESH_E2E_ALLOW_LIVE=1' >&2; exit 1 ;;
    esac
  done
fi
case "$NODE_B_DEMO_DIR" in "$NODE_B_STATE_DIR"/*) ;; *) echo 'Demo must be inside NODE_B_STATE_DIR' >&2; exit 1 ;; esac

log() { printf '[mesh-e2e] %s\n' "$*"; }
warn() { printf '[mesh-e2e] WARN: %s\n' "$*" >&2; }
die() {
  printf '[mesh-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

nodeB_ssh() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/nodeB")
  fi
  ssh -F "$NODE_B_SSH_CONFIG" -i "$NODE_B_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
    -o ConnectTimeout=10 "${control[@]}" "$NODE_B_HOST" "$@"
}

nodeB_scp() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/nodeB")
  fi
  scp -F "$NODE_B_SSH_CONFIG" -i "$NODE_B_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
    -o ConnectTimeout=10 "${control[@]}" "$@"
}

cloud_ssh() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/cloud")
  fi
  local remote_command
  if [ "${MESH_E2E_CLOUD_SUDO:-0}" = 1 ]; then
    printf -v remote_command '%q' "$*"
    ssh -F "$CLOUD_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ConnectTimeout=10 "${control[@]}" "$CLOUD_HOST" "sudo -n bash -c $remote_command"
  else
    ssh -F "$CLOUD_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ConnectTimeout=10 "${control[@]}" "$CLOUD_HOST" "$@"
  fi
}

cloud_put() {
  local destination
  printf -v destination '%q' "$2"
  cloud_ssh "cat > $destination" < "$1"
}

require_bins() {
  local missing=0 bin
  for bin in ssh scp curl git jq docker tar; do
    command -v "$bin" >/dev/null 2>&1 || {
      warn "missing required command: $bin"
      missing=1
    }
  done
  [ "$missing" = 0 ] || die "install the missing commands first"
}

load_build_env() {
  [ -f "$BUILD_ENV" ] || die "no build metadata at $BUILD_ENV; run build.sh <ref> first"
  # shellcheck disable=SC1090
  . "$BUILD_ENV"
  : "${BUILD_VERSION:?build.env is missing BUILD_VERSION}"
  : "${ARCHIVE:?build.env is missing ARCHIVE}"
  : "${RUNTIME_DIR:?build.env is missing RUNTIME_DIR}"
}

wait_http() {
  local url=$1 tries=${2:-60} i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# Keep only "type base64" so the tag in authorized_keys appears once.
key_body() { printf '%s\n' "$1" | awk 'NF >= 2 { print $1 " " $2; exit }'; }

ensure_local_key() {
  local key=$1 comment=$2
  case "$key" in "$STATE_DIR/ssh/"*) ;; *) die "Bed keys must be inside STATE_DIR/ssh" ;; esac
  if [ ! -f "$key" ]; then
    mkdir -p "$(dirname "$key")"
    chmod 700 "$(dirname "$key")"
    ssh-keygen -q -t ed25519 -N '' -C "$comment" -f "$key"
  fi
  chmod 600 "$key"
  chmod 644 "$key.pub"
}


MESH_E2E_LIB_LOADED=1
source "$MESH_DIR/bed-config.sh"
