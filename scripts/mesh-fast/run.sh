#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/mesh-fast/admission.sh
exec node scripts/mesh-fast/run.mjs "$@"
