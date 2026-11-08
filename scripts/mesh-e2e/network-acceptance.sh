#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
STAGE=${MESH_E2E_STAGE_PREFIX:-network}
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-$STAGE}
[ "$(nodeB_ssh 'cat /tmp/mesh-bed.lock/owner')" = "$BED_LOCK_OWNER" ] || die "$BED_LOCK_OWNER must hold the bed lock"
round=${1:-1}
case "$round" in 1|2) ;; *) die "Usage: network-rounds.sh 1|2";; esac
export MESH_E2E_BED_WORK=${MESH_E2E_BED_WORK:-/tmp/$STAGE-network-rounds}
export MESH_E2E_BED_PROJECT=${MESH_E2E_BED_PROJECT:-$STAGE-network-demo}
export MESH_E2E_ROUND1_NAME=$STAGE-round1
export MESH_E2E_ROUND1_SCRATCH=$STAGE-r1
export MESH_E2E_ROUND2_NAME=$STAGE-round2
export MESH_E2E_DEMO_TITLE=$STAGE-network-demo
export MESH_E2E_ORPHAN_LABEL=$STAGE-orphan
export MESH_E2E_STAGE_PREFIX=$STAGE
export MESH_E2E_ROUND1_WORK="$MESH_E2E_BED_WORK/round1"
export MESH_E2E_ROUND2_WORK="$MESH_E2E_BED_WORK/round2"
mkdir -p "$MESH_E2E_BED_WORK"
nodeB_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=$NODE_B_NODE_BIN_DIR:\$PATH
root="\$HOME/$MESH_E2E_BED_PROJECT"
mkdir -p "\$root/node_modules" "\$root/.venv"
printf 'module.exports = 1;\n' > "\$root/node_modules/x.js"
printf '$STAGE excluded fixture\n' > "\$root/.venv/a"
if [ ! -d "\$root/.git" ]; then
  git init -q "\$root"
  printf '# mesh e2e demo $STAGE\n' > "\$root/README.md"
  printf 'node_modules/\n.venv/\n' > "\$root/.gitignore"
  git -C "\$root" add README.md .gitignore
  git -C "\$root" -c user.name='Mesh test' -c user.email=mesh@example.test commit -qm '$STAGE network fixture'
fi
EOF
exec bash "$MESH_DIR/round$round.sh"
