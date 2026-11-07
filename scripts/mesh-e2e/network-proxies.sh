#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
load_build_env
owner=$(gor_ssh 'cat /tmp/mesh-bed.lock/owner')
[ "$owner" = N1 ] || die "N1 must hold the shared bed lock"
action=${1:-up}
name=t3-mesh-N1-proxy.service
dropin=91-N1-network-proxy.conf
state=/tmp/N1-network-state.json
proxy=/tmp/N1-network-proxy.mjs
node_binary=$(command -v node)
if [ "$action" = up ]; then
  cp "$MESH_DIR/network-proxy.mjs" "$proxy"
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  gor_scp "$proxy" "$GOR_HOST:$proxy"
  gor_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  vps_put "$proxy" "$VPS_DIR/tmp/N1-network-proxy.mjs"
  vps_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$VPS_DIR/tmp/N1-network-state.json'; printf '{\"denyMcp\":false,\"cut\":false}\\n' > '$VPS_DIR/tmp/N1-outbound-state.json'; chmod 644 '$VPS_DIR/tmp/N1-network-proxy.mjs' '$VPS_DIR/tmp/N1-network-state.json' '$VPS_DIR/tmp/N1-outbound-state.json'"
  install -d "$HOME/.config/systemd/user/$GV_UNIT.d"
  printf '[Service]\nExecStart=\nExecStart=%s/%s/t3 serve --base-dir %s --host 127.0.0.1 --port %s --no-browser\n' "$GV_RUNTIME_ROOT" "$BUILD_VERSION" "$GV_BASE_DIR" "$((GV_PORT + 1))" > "$HOME/.config/systemd/user/$GV_UNIT.d/$dropin"
  cat > "$HOME/.config/systemd/user/$name" <<EOF
[Unit]
Description=N1 isolated mesh fault proxy
[Service]
ExecStart=$node_binary $proxy $GV_PORT $((GV_PORT + 1)) $state
Restart=on-failure
EOF
  gor_ssh 'bash -s' <<EOF
set -euo pipefail
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
mkdir -p "\$HOME/.config/systemd/user/$GOR_UNIT.d"
printf '[Service]\nExecStart=\nExecStart=%%h/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3 serve --base-dir %%h/.t3-sidebar-server --host 127.0.0.1 --port $((GOR_PORT + 1)) --no-browser\n' > "\$HOME/.config/systemd/user/$GOR_UNIT.d/$dropin"
cat > "\$HOME/.config/systemd/user/$name" <<UNIT
[Unit]
Description=N1 isolated mesh fault proxy
[Service]
ExecStart=\$(command -v node) $proxy $GOR_PORT $((GOR_PORT + 1)) $state
Restart=on-failure
UNIT
systemctl --user daemon-reload
systemctl --user restart '$GOR_UNIT'
systemctl --user start '$name'
systemctl --user show '$GOR_UNIT' -p MainPID --value > /tmp/N1-server-spawn.pid
EOF
  systemctl --user daemon-reload
  systemctl --user restart "$GV_UNIT"
  systemctl --user start "$name"
  systemctl --user show "$GV_UNIT" -p MainPID --value > /tmp/N1-server-spawn.pid
  vps_ssh "cat > '$VPS_DIR/N1-compose.yaml'" <<'EOF'
services:
  t3:
    command:
      - sh
      - -c
      - node /tmp/N1-network-proxy.mjs 3791 3792 /tmp/N1-network-state.json 0.0.0.0 & node /tmp/N1-network-proxy.mjs 13797 13797 /tmp/N1-outbound-state.json 127.0.0.1 172.17.0.1 & if [ -f /tmp/N1-sshd_config ]; then /usr/sbin/sshd -D -e -f /tmp/N1-sshd_config & fi; echo $$$$ > /tmp/N1-server-spawn.pid; exec node /opt/t3/dist/bin.mjs serve --base-dir /home/t3/.t3 --host 127.0.0.1 --port 3792 --no-browser
EOF
  vps_ssh "cd '$VPS_DIR'; docker compose -f compose.yaml -f N1-compose.yaml up -d --force-recreate"
elif [ "$action" = down ]; then
  systemctl --user stop "$name"
  rm "$HOME/.config/systemd/user/$name" "$HOME/.config/systemd/user/$GV_UNIT.d/$dropin"
  systemctl --user daemon-reload
  systemctl --user restart "$GV_UNIT"
  gor_ssh "systemctl --user stop '$name'; rm \"\$HOME/.config/systemd/user/$name\" \"\$HOME/.config/systemd/user/$GOR_UNIT.d/$dropin\"; systemctl --user daemon-reload; systemctl --user restart '$GOR_UNIT'"
  vps_ssh "cd '$VPS_DIR'; docker compose -f compose.yaml up -d --force-recreate"
elif [ "$action" = block ]; then
  printf '{"denyMcp":true,"peerOnlyMcp":true,"cut":false}\n' > "$state"
  gor_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$state'"
  vps_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false}\\n' > '$VPS_DIR/tmp/N1-network-state.json'"
else
  die "Usage: network-proxies.sh up|block|down"
fi
