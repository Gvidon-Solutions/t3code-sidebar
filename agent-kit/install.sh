#!/usr/bin/env bash
# Installs the agent kit (the `t3` skill with t3ctl, and the shared agent instructions) from this
# repository onto the owner's machines. Run it on gvidon from the repository root.
#
#   agent-kit/install.sh                 # dry run for every machine: what would change
#   agent-kit/install.sh --apply         # install everywhere (backups first)
#   agent-kit/install.sh --to operalia   # one machine (gvidon, operalia, gor; comma-separated)
#   agent-kit/install.sh --dest DIR      # copy the skill into DIR only (test beds, e.g. ~/.agents/skills/t3-next)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill="$here/skills/t3"
targets="gvidon,operalia,gor"
apply=0
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --to) targets="$2"; shift ;;
    --dest) dest="$2"; shift ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$dest" ]; then
  mkdir -p "$dest"
  rsync -a --delete --exclude node_modules --exclude "*.test.mjs" "$skill/" "$dest/"
  echo "skill copied to $dest"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
gor_ssh=(-F "$HOME/.local/share/gor-transfer/ssh_config" -i "$HOME/.ssh/id_malaniya_25519" -o IdentitiesOnly=yes)

install_skill() {
  local machine="$1" rsh home
  case "$machine" in
    gvidon) rsh=""; home="$HOME" ;;
    operalia) rsh="ssh"; home="/root" ;;
    gor) rsh="ssh ${gor_ssh[*]}"; home="/home/user" ;;
    *) echo "unknown machine $machine" >&2; return 1 ;;
  esac
  local target="$home/.agents/skills/t3" backup="$home/.local/state/t3-agent-kit/$stamp"
  local remote_prefix=""
  [ "$machine" = gvidon ] || remote_prefix="$machine:"
  if [ "$apply" = 0 ]; then
    echo "== $machine: skill changes (dry run)"
    if [ -z "$rsh" ]; then
      rsync -an --delete --itemize-changes --exclude node_modules --exclude "*.test.mjs" "$skill/" "$target/" | sed 's/^/   /'
    else
      rsync -an --delete --itemize-changes --exclude node_modules --exclude "*.test.mjs" -e "$rsh" "$skill/" "$remote_prefix$target/" | sed 's/^/   /'
    fi
    return 0
  fi
  echo "== $machine: installing skill (backup $backup/skill-t3)"
  if [ -z "$rsh" ]; then
    mkdir -p "$backup" && { [ -d "$target" ] && cp -a "$target" "$backup/skill-t3" || true; }
    rsync -a --delete --exclude node_modules --exclude "*.test.mjs" "$skill/" "$target/"
  else
    $rsh "${remote_prefix%:}" "mkdir -p '$backup' && { [ -d '$target' ] && cp -a '$target' '$backup/skill-t3' || true; }"
    rsync -a --delete --exclude node_modules --exclude "*.test.mjs" -e "$rsh" "$skill/" "$remote_prefix$target/"
  fi
}

IFS=',' read -r -a list <<< "$targets"
for machine in "${list[@]}"; do install_skill "$machine"; done

echo "== shared agent instructions"
if [ "$apply" = 1 ]; then
  node "$skill/scripts/t3ctl.mjs" agents sync --to "$targets" --apply
else
  node "$skill/scripts/t3ctl.mjs" agents sync --to "$targets"
fi
