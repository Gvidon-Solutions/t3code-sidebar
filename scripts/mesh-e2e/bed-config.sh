#!/usr/bin/env bash
# Compatibility role names for realistic scenarios; all physical values come from lib.sh/local.env.
set -euo pipefail
if [ "${MESH_E2E_LIB_LOADED:-0}" != 1 ]; then
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fi
BED_MACHINES=(studio worker cloudbox)
BED_NIGHTLY_ROOT="${BED_NIGHTLY_ROOT:-$HOME/.local/share/t3-mesh-nightly}"
BED_FAST_TOOLS="${MESH_FAST_MUTAGEN_CACHE:-$BED_NIGHTLY_ROOT/tools}"
BED_NIGHTLY_CALENDAR="${BED_NIGHTLY_CALENDAR:-*-*-* 03:30:00}"
BED_CONTROLLER_RUNTIME_DIR="${BED_CONTROLLER_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-}}"
WORKER_HOST="$NODE_B_HOST"
WORKER_BASE_DIR="$NODE_B_BASE_DIR"
WORKER_PORT="$NODE_B_PORT"
WORKER_HOME="${WORKER_HOME:-$NODE_B_STATE_DIR}"
WORKER_TUNNEL_UNIT="$NODE_B_TUNNEL_UNIT"
STUDIO_TUNNEL_UNIT="$NODE_A_TUNNEL_UNIT"
worker_ssh() { nodeB_ssh "$@"; }
worker_scp() { nodeB_scp "$@"; }
cloudbox_ssh() { cloud_ssh "$@"; }
