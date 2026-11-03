#!/usr/bin/env bash
# Install the repository's agent kit using routes from global/machines.json.
# --dest DIR copies only the skill; --to ID[,ID] selects configured machines.
# Without --apply, show changes without writing to installed skills or instructions.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/install.mjs" "$@"
