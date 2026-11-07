#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
load_build_env
owner=$(worker_ssh 'cat /tmp/mesh-bed.lock/owner')
[ "$owner" = "${MESH_E2E_LOCK_OWNER:-N1}" ] || die "N1 must hold the shared bed lock"
action=${1:-up}
name=t3-mesh-N1-proxy.service
dropin=91-N1-network-proxy.conf
state=/tmp/N1-network-state.json
proxy=/tmp/N1-network-proxy.mjs
node_binary=$(command -v node)
if [ "$action" = up ]; then
  cp "$MESH_DIR/network-proxy.mjs" "$proxy"
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  worker_scp "$proxy" "$WORKER_HOST:$proxy"
  worker_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  scp -F "$CLOUDBOX_SSH_CONFIG" -o StrictHostKeyChecking=yes -o UpdateHostKeys=no "$proxy" "$CLOUDBOX_HOST:$CLOUDBOX_DIR/tmp/N1-network-proxy.mjs"
  cloudbox_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$CLOUDBOX_DIR/tmp/N1-network-state.json'; printf '{\"denyMcp\":false,\"cut\":false}\\n' > '$CLOUDBOX_DIR/tmp/N1-outbound-state.json'; chmod 644 '$CLOUDBOX_DIR/tmp/N1-network-proxy.mjs' '$CLOUDBOX_DIR/tmp/N1-network-state.json' '$CLOUDBOX_DIR/tmp/N1-outbound-state.json'"
  install -d "$HOME/.config/systemd/user/$STUDIO_UNIT.d"
  printf '[Service]\nExecStart=\nExecStart=%s/%s/t3 serve --base-dir %s --host 127.0.0.1 --port %s --no-browser\n' "$STUDIO_RUNTIME_ROOT" "$BUILD_VERSION" "$STUDIO_BASE_DIR" "$((STUDIO_PORT + 1))" > "$HOME/.config/systemd/user/$STUDIO_UNIT.d/$dropin"
  cat > "$HOME/.config/systemd/user/$name" <<EOF
[Unit]
Description=N1 isolated mesh fault proxy
[Service]
ExecStart=$node_binary $proxy $STUDIO_PORT $((STUDIO_PORT + 1)) $state
Restart=on-failure
EOF
  worker_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
mkdir -p "\$HOME/.config/systemd/user/$WORKER_UNIT.d"
printf '[Service]\nExecStart=\nExecStart=%%h/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3 serve --base-dir %%h/.t3-sidebar-server --host 127.0.0.1 --port $((WORKER_PORT + 1)) --no-browser\n' > "\$HOME/.config/systemd/user/$WORKER_UNIT.d/$dropin"
cat > "\$HOME/.config/systemd/user/$name" <<UNIT
[Unit]
Description=N1 isolated mesh fault proxy
[Service]
ExecStart=\$(command -v node) $proxy $WORKER_PORT $((WORKER_PORT + 1)) $state
Restart=on-failure
UNIT
systemctl --user daemon-reload
systemctl --user restart '$WORKER_UNIT'
systemctl --user start '$name'
systemctl --user show '$WORKER_UNIT' -p MainPID --value > /tmp/N1-server-spawn.pid
EOF
  systemctl --user daemon-reload
  systemctl --user restart "$STUDIO_UNIT"
  systemctl --user start "$name"
  systemctl --user show "$STUDIO_UNIT" -p MainPID --value > /tmp/N1-server-spawn.pid
  cloudbox_ssh "cat > '$CLOUDBOX_DIR/N1-compose.yaml'" <<'EOF'
services:
  t3:
    command:
      - sh
      - -c
      - node /tmp/N1-network-proxy.mjs 3791 3792 /tmp/N1-network-state.json 0.0.0.0 & node /tmp/N1-network-proxy.mjs 13797 13797 /tmp/N1-outbound-state.json 127.0.0.1 172.17.0.1 & if [ -f /tmp/N1-sshd_config ]; then /usr/sbin/sshd -D -e -f /tmp/N1-sshd_config & fi; echo $$$$ > /tmp/N1-server-spawn.pid; exec node /opt/t3/dist/bin.mjs serve --base-dir /home/t3/.t3 --host 127.0.0.1 --port 3792 --no-browser
EOF
  cloudbox_ssh "cd '$CLOUDBOX_DIR'; docker compose -f compose.yaml -f N1-compose.yaml up -d --force-recreate"
elif [ "$action" = down ]; then
  systemctl --user stop "$name"
  rm "$HOME/.config/systemd/user/$name" "$HOME/.config/systemd/user/$STUDIO_UNIT.d/$dropin"
  systemctl --user daemon-reload
  systemctl --user restart "$STUDIO_UNIT"
  worker_ssh "systemctl --user stop '$name'; rm \"\$HOME/.config/systemd/user/$name\" \"\$HOME/.config/systemd/user/$WORKER_UNIT.d/$dropin\"; systemctl --user daemon-reload; systemctl --user restart '$WORKER_UNIT'"
  cloudbox_ssh "cd '$CLOUDBOX_DIR'; docker compose -f compose.yaml up -d --force-recreate"
elif [ "$action" = block ]; then
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  worker_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  cloudbox_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$CLOUDBOX_DIR/tmp/N1-network-state.json'"
else
  die "Usage: network-proxies.sh up|block|down"
fi
