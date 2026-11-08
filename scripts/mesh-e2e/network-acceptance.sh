#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
PREFIX=${MESH_E2E_FIXTURE_PREFIX:-network}
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-$PREFIX}
[ "$(nodeB_ssh 'cat /tmp/mesh-bed.lock/owner')" = "$BED_LOCK_OWNER" ] || die "$BED_LOCK_OWNER must hold the bed lock"
suite=${1:-all}
case "$suite" in core|replica|all) ;; *) die "Usage: network-acceptance.sh [core|replica|all]";; esac
export MESH_E2E_BED_WORK=${MESH_E2E_BED_WORK:-/tmp/$PREFIX-network-acceptance}
export MESH_E2E_BED_PROJECT=${MESH_E2E_BED_PROJECT:-$PREFIX-network-demo}
export MESH_E2E_CORE_NAME=$PREFIX-core
export MESH_E2E_CORE_SCRATCH=$PREFIX-core
export MESH_E2E_REPLICA_NAME=$PREFIX-replica
export MESH_E2E_DEMO_TITLE=$PREFIX-network-demo
export MESH_E2E_ORPHAN_LABEL=$PREFIX-orphan
export MESH_E2E_FIXTURE_PREFIX=$PREFIX
export MESH_E2E_CORE_WORK="$MESH_E2E_BED_WORK/core"
export MESH_E2E_REPLICA_WORK="$MESH_E2E_BED_WORK/replica"
mkdir -p "$MESH_E2E_BED_WORK"
nodeB_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=$NODE_B_NODE_BIN_DIR:\$PATH
root="\$HOME/$MESH_E2E_BED_PROJECT"
mkdir -p "\$root/node_modules" "\$root/.venv"
printf 'module.exports = 1;\n' > "\$root/node_modules/x.js"
printf '$PREFIX excluded fixture\n' > "\$root/.venv/a"
if [ ! -d "\$root/.git" ]; then
  git init -q "\$root"
  printf '# mesh e2e demo $PREFIX\n' > "\$root/README.md"
  printf 'node_modules/\n.venv/\n' > "\$root/.gitignore"
  git -C "\$root" add README.md .gitignore
  git -C "\$root" -c user.name='Mesh test' -c user.email=mesh@example.test commit -qm '$PREFIX network fixture'
fi
EOF
case "$suite" in
  core) exec bash "$MESH_DIR/mesh-core-acceptance.sh" ;;
  replica) exec bash "$MESH_DIR/replica-acceptance.sh" ;;
  all)
    bash "$MESH_DIR/mesh-core-acceptance.sh"
    exec bash "$MESH_DIR/replica-acceptance.sh"
    ;;
esac
