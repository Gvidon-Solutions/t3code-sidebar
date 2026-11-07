#!/usr/bin/env bash
# One command: build a ref, deploy it to worker + isolated studio + VPS, bring
# tunnels up, print health.
#
# Usage: up.sh [--no-build] [ref]     (default ref: xdev)
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

BUILD=1
if [ "${1:-}" = "--no-build" ]; then
  BUILD=0
  shift
fi
REF="${1:-xdev}"

if [ "$BUILD" = 1 ]; then
  "$MESH_DIR/build.sh" "$REF"
else
  log "skipping build; using $BUILD_ENV"
fi

"$MESH_DIR/deploy.sh"
"$MESH_DIR/status.sh"
