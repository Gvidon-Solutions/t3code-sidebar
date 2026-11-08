#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/bed-config.sh"
export MESH_FAST_MUTAGEN_CACHE="$BED_FAST_TOOLS"
MESH_FAST_REALISTIC=1 "$(dirname "$0")/../mesh-fast/run.sh" --scenario machine-name-concurrent --jobs 1
