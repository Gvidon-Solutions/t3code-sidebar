#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
source "$(dirname "$0")/bed-config.sh"
mkdir -p "$BED_NIGHTLY_ROOT/isolated-f1"
export TMPDIR="$BED_NIGHTLY_ROOT/isolated-f1"
MESH_FAST_REALISTIC=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario f1- --jobs 1
MESH_FAST_REALISTIC=1 MESH_FAST_REAL_PROVIDERS=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario f1-replica-content --jobs 1
