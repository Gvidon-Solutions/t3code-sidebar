#!/usr/bin/env bash
# Optional local staging; servers manage installed skills and instructions.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/install.mjs" "$@"
