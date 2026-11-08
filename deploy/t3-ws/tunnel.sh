#!/usr/bin/env bash
# Opens http://localhost:3790 -> t3-ws on the VPS (loopback only there).
set -euo pipefail
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/mesh-e2e" && pwd)/local.env"
[ -f "$LOCAL_ENV" ] || { echo "Create $LOCAL_ENV from local.env.example" >&2; exit 1; }
. "$LOCAL_ENV"
: "${CLOUD_SSH_CONFIG:?Set CLOUD_SSH_CONFIG in local.env}"
: "${CLOUD_HOST:?Set CLOUD_HOST in local.env}"
exec ssh -F "$CLOUD_SSH_CONFIG" -N \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3790:127.0.0.1:3790 "$CLOUD_HOST"
