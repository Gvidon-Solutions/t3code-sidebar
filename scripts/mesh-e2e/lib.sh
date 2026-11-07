#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/bed-config.sh"

log() { printf '[mesh-e2e] %s\n' "$*"; }
warn() { printf '[mesh-e2e] WARN: %s\n' "$*" >&2; }
die() {
  printf '[mesh-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

worker_ssh() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/worker")
  fi
  ssh -F "$WORKER_SSH_CONFIG" -i "$WORKER_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
    -o ConnectTimeout=10 "${control[@]}" "$WORKER_HOST" "$@"
}

worker_scp() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/worker")
  fi
  scp -F "$WORKER_SSH_CONFIG" -i "$WORKER_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
    -o ConnectTimeout=10 "${control[@]}" "$@"
}

cloudbox_ssh() {
  local control=()
  if [ -n "${MESH_E2E_SSH_CONTROL_DIR:-}" ]; then
    control=(-o ControlMaster=auto -o ControlPersist=600 -o "ControlPath=$MESH_E2E_SSH_CONTROL_DIR/cloudbox")
  fi
  ssh -F "$CLOUDBOX_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ConnectTimeout=10 "${control[@]}" "$CLOUDBOX_HOST" "$@"
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
