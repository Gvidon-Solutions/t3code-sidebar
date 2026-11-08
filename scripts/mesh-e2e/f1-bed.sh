#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
source "$(dirname "$0")/bed-config.sh"
export MESH_FAST_MUTAGEN_CACHE="$BED_FAST_TOOLS"
export PLAYWRIGHT_BROWSERS_PATH="$BED_FAST_TOOLS/browsers"
pnpm --dir "$REPO_ROOT/scripts" exec playwright-core install chromium
MESH_FAST_REALISTIC=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario f1- --jobs 1
MESH_FAST_REALISTIC=1 MESH_FAST_REAL_PROVIDERS=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario f1-replica-content --jobs 1
