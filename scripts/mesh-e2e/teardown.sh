#!/usr/bin/env bash
# Stop and remove everything the test bed started. By default T3 data and the
# built artifacts stay on disk; --purge also deletes them.
#
# Usage: teardown.sh [--purge]
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

log "stopping tunnels"
"$MESH_DIR/tunnels.sh" down || true

log "stopping studio server unit"
systemctl --user disable --now "$STUDIO_UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$STUDIO_UNIT" >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/$STUDIO_UNIT" "$HOME/.config/systemd/user/$STUDIO_TUNNEL_UNIT"
rm -f "$HOME/.local/share/t3-mesh-e2e/tunnels-studio.sh"
systemctl --user daemon-reload

log "stopping worker test-bed tunnel and retired test unit (main server stays up)"
worker_ssh 'bash -s' <<'EOF' || true
systemctl --user disable --now t3-mesh-e2e-tunnels.service >/dev/null 2>&1 || true
systemctl --user disable --now t3-mesh-e2e.service >/dev/null 2>&1 || true
systemctl --user reset-failed t3-mesh-e2e-tunnels.service t3-mesh-e2e.service >/dev/null 2>&1 || true
rm -f ~/.config/systemd/user/t3-mesh-e2e-tunnels.service ~/.config/systemd/user/t3-mesh-e2e.service
rm -f ~/.local/share/t3-mesh-e2e/tunnels-worker.sh
rm -f ~/.ssh/t3_mesh_e2e_vps_known_hosts
systemctl --user daemon-reload
EOF

log "stopping VPS container"
cloudbox_ssh 'bash -s' <<'EOF' || true
if [ -d /opt/t3-mesh-e2e ]; then
  cd /opt/t3-mesh-e2e
  docker compose down --remove-orphans 2>/dev/null || true
fi
EOF

log "removing authorized_keys entries"
worker_ssh 'bash -s' <<'EOF' || true
set -euo pipefail
file="$HOME/.ssh/authorized_keys"
[ -f "$file" ] || exit 0
tmp=$(mktemp)
grep -vF ' t3-mesh-e2e-container-worker' "$file" >"$tmp" || true
cat "$tmp" >"$file"; rm -f "$tmp"; chmod 600 "$file"
EOF

if [ -f "$HOME/.ssh/authorized_keys" ]; then
  remove_authorized_lines "$HOME/.ssh/authorized_keys" t3-mesh-e2e-container-studio
  remove_authorized_lines "$HOME/.ssh/authorized_keys" t3-mesh-e2e-self
fi

cloudbox_ssh 'bash -s' <<'EOF' || true
set -euo pipefail
file=/root/.ssh/authorized_keys
[ -f "$file" ] || exit 0
tmp=$(mktemp)
grep -vF ' t3-mesh-e2e-reverse-' "$file" >"$tmp" || true
cat "$tmp" >"$file"; rm -f "$tmp"; chmod 600 "$file"
rm -f /opt/t3-mesh-e2e/home/.ssh/id_mesh_gor /opt/t3-mesh-e2e/home/.ssh/id_mesh_gor.pub
rm -f /opt/t3-mesh-e2e/home/.ssh/id_mesh_gvidon /opt/t3-mesh-e2e/home/.ssh/id_mesh_gvidon.pub
EOF

log "removing local key material"
rm -f "$REVERSE_KEY_GV" "$REVERSE_KEY_GV.pub"
rm -f "$SELF_KEY" "$SELF_KEY.pub"
worker_ssh 'rm -f ~/.ssh/id_t3_mesh_e2e_vps ~/.ssh/id_t3_mesh_e2e_vps.pub' || true

if [ "$PURGE" = 1 ]; then
  log "purging data and build artifacts"
  cloudbox_ssh 'rm -rf /opt/t3-mesh-e2e; docker image rm t3-mesh-e2e:dev 2>/dev/null || true' || true
  worker_ssh 'rm -rf ~/.t3-mesh-e2e ~/xdev-e2e ~/.local/share/t3-mesh-e2e' || true
  rm -rf "$STUDIO_RUNTIME_ROOT" "$STUDIO_BASE_DIR" "$STATE_DIR" "$ARTIFACTS_DIR"
  rm -rf "$BUILD_DIR"
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
fi

log "teardown complete$([ "$PURGE" = 1 ] && echo ' (purged)')"
