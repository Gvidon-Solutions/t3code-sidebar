#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
PURGE=0
[ "${1:-}" = --purge ] && PURGE=1
"$MESH_DIR/tunnels.sh" down
stop_unit() {
  local unit=$1
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then
    systemctl --user disable --now "$unit"
    rm -f "$HOME/.config/systemd/user/$unit"
  fi
}
stop_unit "$NODE_A_UNIT"
stop_unit "${NODE_A_UNIT%.service}-sshd.service"
nodeB_ssh "set -e; for unit in '$NODE_B_UNIT' '${NODE_B_UNIT%.service}-sshd.service'; do if [ -f \"\$HOME/.config/systemd/user/\$unit\" ]; then systemctl --user disable --now \"\$unit\"; rm -f \"\$HOME/.config/systemd/user/\$unit\"; fi; done; systemctl --user daemon-reload"
cloud_ssh "set -e; if [ -f '$CLOUD_DIR/compose.yaml' ]; then cd '$CLOUD_DIR'; docker compose down --remove-orphans; fi"
systemctl --user daemon-reload
if [ "$PURGE" = 1 ]; then
  nodeB_ssh "rm -rf -- '$NODE_B_BASE_DIR' '$NODE_B_RUNTIME_ROOT' '$NODE_B_STATE_DIR/ssh' '$NODE_B_DEMO_DIR'"
  rm -rf -- "$NODE_A_BASE_DIR" "$NODE_A_RUNTIME_ROOT" "$STATE_DIR/ssh" "$ARTIFACTS_DIR"
fi
log 'teardown complete; administrator SSH configuration and keys were not changed'
