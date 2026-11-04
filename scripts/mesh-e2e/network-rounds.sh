#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ "$(gor_ssh 'cat /tmp/mesh-bed.lock/owner')" = N1 ] || die "N1 must hold the bed lock"
round=${1:-1}
case "$round" in 1|2) ;; *) die "Usage: network-rounds.sh 1|2";; esac
export N1_BED_WORK=${N1_BED_WORK:-/tmp/N1-network-rounds}
export N1_BED_SOURCE=$MESH_DIR
export N1_BED_PROJECT=N1-network-demo
export N1_BED_GOR_HOME
N1_BED_GOR_HOME=$(gor_ssh 'printf %s "$HOME"')
mkdir -p "$N1_BED_WORK/scripts"
node --input-type=module <<'JS'
import fs from "node:fs";
import path from "node:path";
const source = process.env.N1_BED_SOURCE;
const target = path.join(process.env.N1_BED_WORK, "scripts");
for (const name of ["round1.sh", "round2.sh"]) {
  let text = fs.readFileSync(path.join(source, name), "utf8");
  text = text.replaceAll("/home/user", process.env.N1_BED_GOR_HOME)
    .replaceAll("xdev-e2e/demo", process.env.N1_BED_PROJECT)
    .replaceAll("round1-", "N1-round1-").replaceAll("r1-", "N1-r1-")
    .replaceAll("round2-primary", "N1-round2-primary")
    .replaceAll("round2-orphan", "N1-round2-orphan")
    .replaceAll("round2-conflict", "N1-round2-conflict")
    .replaceAll("round2-transfer", "N1-round2-transfer")
    .replaceAll('MARK="round2-', 'MARK="N1-round2-')
    .replaceAll("t3-env=orphan", "t3-env=N1-orphan")
    .replaceAll('"title":"demo"', '"title":"N1-network-demo"')
    .replaceAll('title: "demo"', 'title: "N1-network-demo"')
    .replaceAll("--project demo", "--project N1-network-demo");
  text = text.replace('CTL="$HOME/.agents/skills/t3-next/scripts/t3ctl.mjs"', 'CTL="$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs"');
  if (name === "round2.sh") text = text.replace('"$MESH_DIR/round2-routes.sh" || exit 1', '[ -f "$STATE_DIR/round2-container" ] || die "The existing bed SSH route key is required; N1 does not edit the owner SSH configuration"');
  fs.writeFileSync(path.join(target, name), text, { mode: 0o700 });
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
fs.writeFileSync(path.join(target, "lib.sh"), `. ${quote(path.join(source, "lib.sh"))}\nMESH_DIR=${quote(target)}\n`, { mode: 0o700 });
JS
gor_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
root="\$HOME/$N1_BED_PROJECT"
mkdir -p "\$root"
if [ ! -d "\$root/.git" ]; then
  git init -q "\$root"
  printf '# mesh e2e demo N1\n' > "\$root/README.md"
  printf 'node_modules/\n.venv/\n' > "\$root/.gitignore"
  git -C "\$root" add README.md .gitignore
  git -C "\$root" -c user.name='Mesh test' -c user.email=mesh@example.test commit -qm 'N1 network fixture'
fi
EOF
export MESH_E2E_ROUND1_WORK="$N1_BED_WORK/round1"
export MESH_E2E_ROUND2_WORK="$N1_BED_WORK/round2"
exec bash "$N1_BED_WORK/scripts/round$round.sh"
