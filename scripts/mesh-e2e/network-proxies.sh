#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
load_build_env
NODE_B_BASE_DIR=${MESH_E2E_NODE_B_BASE_DIR:-$NODE_B_BASE_DIR}
owner=$(nodeB_ssh 'cat /tmp/mesh-bed.lock/owner')
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-mesh-network}
[ "$owner" = "$BED_LOCK_OWNER" ] || die "$BED_LOCK_OWNER must hold the shared bed lock"
action=${1:-up}
name=t3-mesh-mesh-network-proxy.service
dropin=91-mesh-network-network-proxy.conf
state=/tmp/mesh-network-network-state.json
proxy=/tmp/mesh-network-network-proxy.mjs
node_binary=$(command -v node)
if [ "$action" = up ]; then
  cp "$MESH_DIR/network-proxy.mjs" "$proxy"
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  nodeB_scp "$proxy" "$NODE_B_HOST:$proxy"
  nodeB_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  cloud_put "$proxy" "$CLOUD_DIR/tmp/mesh-network-network-proxy.mjs"
  cloud_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$CLOUD_DIR/tmp/mesh-network-network-state.json'; printf '{\"denyMcp\":false,\"cut\":false}\\n' > '$CLOUD_DIR/tmp/mesh-network-outbound-state.json'; chmod 644 '$CLOUD_DIR/tmp/mesh-network-network-proxy.mjs' '$CLOUD_DIR/tmp/mesh-network-network-state.json' '$CLOUD_DIR/tmp/mesh-network-outbound-state.json'"
  install -d "$HOME/.config/systemd/user/$NODE_A_UNIT.d"
  printf '[Service]\nExecStart=\nExecStart=%s/%s/t3 serve --base-dir %s --host 127.0.0.1 --port %s --no-browser\n' "$NODE_A_RUNTIME_ROOT" "$BUILD_VERSION" "$NODE_A_BASE_DIR" "$((NODE_A_PORT + 1))" > "$HOME/.config/systemd/user/$NODE_A_UNIT.d/$dropin"
  cat > "$HOME/.config/systemd/user/$name" <<EOF
[Unit]
Description=Mesh network isolated fault proxy
[Service]
ExecStart=$node_binary $proxy $NODE_A_PORT $((NODE_A_PORT + 1)) $state
Restart=on-failure
EOF
  nodeB_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=$NODE_B_NODE_BIN_DIR:\$PATH
mkdir -p "\$HOME/.config/systemd/user/$NODE_B_UNIT.d"
printf '[Service]\nExecStart=\nExecStart=$NODE_B_RUNTIME_ROOT/$BUILD_VERSION/t3 serve --base-dir $NODE_B_BASE_DIR --host 127.0.0.1 --port $((NODE_B_PORT + 1)) --no-browser\n' > "\$HOME/.config/systemd/user/$NODE_B_UNIT.d/$dropin"
cat > "\$HOME/.config/systemd/user/$name" <<UNIT
[Unit]
Description=Mesh network isolated fault proxy
[Service]
ExecStart=\$(command -v node) $proxy $NODE_B_PORT $((NODE_B_PORT + 1)) $state
Restart=on-failure
UNIT
systemctl --user daemon-reload
systemctl --user restart '$NODE_B_UNIT'
systemctl --user start '$name'
systemctl --user show '$NODE_B_UNIT' -p MainPID --value > /tmp/mesh-network-server-spawn.pid
EOF
  systemctl --user daemon-reload
  systemctl --user restart "$NODE_A_UNIT"
  systemctl --user start "$name"
  systemctl --user show "$NODE_A_UNIT" -p MainPID --value > /tmp/mesh-network-server-spawn.pid
  cloud_ssh "cat > '$CLOUD_DIR/mesh-network-compose.yaml'" <<'EOF'
services:
  t3:
    command:
      - sh
      - -c
      - node /tmp/mesh-network-network-proxy.mjs 3791 3792 /tmp/mesh-network-network-state.json 0.0.0.0 & node /tmp/mesh-network-network-proxy.mjs 13797 13797 /tmp/mesh-network-outbound-state.json 127.0.0.1 172.17.0.1 & if [ -f /tmp/mesh-network-sshd_config ]; then /usr/sbin/sshd -D -e -f /tmp/mesh-network-sshd_config & fi; echo $$$$ > /tmp/mesh-network-server-spawn.pid; exec node /opt/t3/dist/bin.mjs serve --base-dir /home/t3/.t3 --host 127.0.0.1 --port 3792 --no-browser
EOF
  cloud_ssh "cd '$CLOUD_DIR'; docker compose -f compose.yaml -f mesh-network-compose.yaml up -d --force-recreate"
elif [ "$action" = down ]; then
  systemctl --user stop "$name"
  rm "$HOME/.config/systemd/user/$name" "$HOME/.config/systemd/user/$NODE_A_UNIT.d/$dropin"
  systemctl --user daemon-reload
  systemctl --user restart "$NODE_A_UNIT"
  nodeB_ssh "systemctl --user stop '$name'; rm \"\$HOME/.config/systemd/user/$name\" \"\$HOME/.config/systemd/user/$NODE_B_UNIT.d/$dropin\"; systemctl --user daemon-reload; systemctl --user restart '$NODE_B_UNIT'"
  cloud_ssh "cd '$CLOUD_DIR'; docker compose -f compose.yaml up -d --force-recreate"
elif [ "$action" = block ]; then
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  nodeB_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  cloud_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$CLOUD_DIR/tmp/mesh-network-network-state.json'"
else
  die "Usage: network-proxies.sh up|block|down"
fi
