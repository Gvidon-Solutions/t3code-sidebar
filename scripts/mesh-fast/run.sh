#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
cd "$(dirname "$0")/../.."
exec node scripts/mesh-fast/run.mjs "$@"
