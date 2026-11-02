#!/usr/bin/env bash
# Shared configuration for the T3 Mesh E2E test bed. Source, do not execute.
set -euo pipefail

MESH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$MESH_DIR/../.." && pwd)"

STATE_DIR="${MESH_E2E_STATE_DIR:-$HOME/.local/share/t3-mesh-e2e}"
ARTIFACTS_DIR="${MESH_E2E_ARTIFACTS:-$HOME/.cache/t3-mesh-e2e/artifacts}"
BUILD_DIR="${MESH_E2E_BUILD_DIR:-$HOME/.cache/t3-mesh-e2e/build}"
BUILD_ENV="$ARTIFACTS_DIR/build.env"

GOR_SSH_CONFIG="${GOR_SSH_CONFIG:-$HOME/.local/share/gor-transfer/ssh_config}"
GOR_SSH_KEY="${GOR_SSH_KEY:-$HOME/.ssh/id_malaniya_25519}"
VPS_SSH_CONFIG="${VPS_SSH_CONFIG:-$HOME/.local/share/vpn-ops/ssh_config}"
VPS_HOST="${VPS_HOST:-152.89.244.57}"
GOR_HOST="${GOR_HOST:-gor}"
# Egress IPs as seen by the VPS. gor exits through its own route, which is not
# the home IP gvidon uses.
GVIDON_PUBLIC_IP="${MESH_E2E_GVIDON_IP:-78.17.147.89}"
GOR_PUBLIC_IP="${MESH_E2E_GOR_IP:-91.77.163.152}"

GV_PORT=3795
GOR_PORT=3797
VPS_PORT=3791
GV_LOCAL=13795
GOR_LOCAL=13797
VPS_LOCAL=13791
VPS_BIND=172.17.0.1
VPS_SSH_GOR=22022
VPS_SSH_GV=22023

GV_BASE_DIR=/tmp/t3-mesh-e2e-gv
GV_RUNTIME_ROOT="$HOME/.t3-mesh-e2e-gv-runtime"
GOR_BASE_DIR="$HOME/.t3-mesh-e2e"
GOR_RUNTIME_ROOT="$HOME/.t3-mesh-e2e/runtime"
VPS_DIR=/opt/t3-mesh-e2e
VPS_DATA="$VPS_DIR/home"

GV_UNIT=t3-mesh-e2e-gv.service
GOR_UNIT=t3-mesh-e2e.service
GV_TUNNEL_UNIT=t3-mesh-e2e-tunnels.service
GOR_TUNNEL_UNIT=t3-mesh-e2e-tunnels.service
IMAGE=t3-mesh-e2e:dev
MUTAGEN_VERSION=0.18.1
MUTAGEN_SHA256=7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f

KEY_TAG=t3-mesh-e2e
CONTAINER_KEY_GOR="$VPS_DATA/.ssh/id_mesh_gor"
CONTAINER_KEY_GV="$VPS_DATA/.ssh/id_mesh_gvidon"
REVERSE_KEY_GV="$HOME/.ssh/id_t3_mesh_e2e_vps"
REVERSE_KEY_GOR='$HOME/.ssh/id_t3_mesh_e2e_vps'
SELF_KEY="$HOME/.ssh/id_t3_mesh_e2e_self"

log() { printf '[mesh-e2e] %s\n' "$*"; }
warn() { printf '[mesh-e2e] WARN: %s\n' "$*" >&2; }
die() {
  printf '[mesh-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

gor_ssh() {
  ssh -F "$GOR_SSH_CONFIG" -i "$GOR_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ConnectTimeout=10 "$GOR_HOST" "$@"
}

gor_scp() {
  scp -F "$GOR_SSH_CONFIG" -i "$GOR_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ConnectTimeout=10 "$@"
}

vps_ssh() {
  ssh -F "$VPS_SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=10 "$VPS_HOST" "$@"
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

ensure_local_key() {
  local key=$1 comment=$2
  if [ ! -f "$key" ]; then
    mkdir -p "$(dirname "$key")"
    chmod 700 "$(dirname "$key")"
    ssh-keygen -q -t ed25519 -N '' -C "$comment" -f "$key"
  fi
  chmod 600 "$key"
  chmod 644 "$key.pub"
}

# Remove lines carrying our tag, then append one line with options. Keeps a
# timestamped backup the first time a file is touched in this run.
authorize_line() {
  local file=$1 options=$2 pubkey=$3 comment=$4
  local backup="$file.bak-t3-mesh-e2e-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file"
  cp -p "$file" "$backup" 2>/dev/null || true
  local tmp
  tmp=$(mktemp)
  grep -vF " $comment" "$file" >"$tmp" || true
  printf '%s %s %s\n' "$options" "$pubkey" "$comment" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
  chmod 600 "$file"
}

remove_authorized_lines() {
  local file=$1 comment=$2
  [ -f "$file" ] || return 0
  local backup="$file.bak-t3-mesh-e2e-remove-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$file" "$backup" 2>/dev/null || true
  local tmp
  tmp=$(mktemp)
  grep -vF " $comment" "$file" >"$tmp" || true
  cat "$tmp" >"$file"
  rm -f "$tmp"
  chmod 600 "$file"
}
