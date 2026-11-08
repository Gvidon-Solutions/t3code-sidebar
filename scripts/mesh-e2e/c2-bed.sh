#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
source "$(dirname "$0")/bed-config.sh"
mkdir -p "$BED_NIGHTLY_ROOT/isolated-c2"
export MESH_FAST_MUTAGEN_CACHE="$BED_FAST_TOOLS"
export TMPDIR="$BED_NIGHTLY_ROOT/isolated-c2"
MESH_FAST_REALISTIC=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario c2-concurrent --jobs 1
