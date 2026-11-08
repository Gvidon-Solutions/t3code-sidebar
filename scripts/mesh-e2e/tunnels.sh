#!/usr/bin/env bash
# Loopback forwards and reverse tunnels for nodeA, nodeB and cloud.
# Endpoints, pinned host keys and fixture identities come from local.env.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

NODE_A_RUNNER="$STATE_DIR/tunnels-nodeA.sh"
NODE_B_RUNNER="$NODE_B_STATE_DIR/tunnels-nodeB.sh"
NODE_B_CLOUD_KNOWN="$NODE_B_STATE_DIR/ssh/cloud_known_hosts"

write_nodeA_runner() {
  mkdir -p "$(dirname "$NODE_A_RUNNER")"
  cat >"$NODE_A_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
pids=()
cleanup() { trap - INT TERM EXIT; for pid in "\${pids[@]}"; do kill "\$pid"; done; }
trap cleanup INT TERM EXIT
common=(-o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15
        -o ServerAliveCountMax=3 -o ConnectTimeout=10)
# Client view on studio: the isolated studio server is loopback-only, so even
# its own alias goes through sshd.
ssh "\${common[@]}" -F '$NODE_B_SSH_CONFIG' -i '$NODE_B_SSH_KEY' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$NODE_B_LOCAL:127.0.0.1:$NODE_B_PORT '$NODE_B_HOST' &
pids+=(\$!)
ssh "\${common[@]}" -F '$CLOUD_SSH_CONFIG' -i '$REVERSE_KEY_NODE_A' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$CLOUD_LOCAL:127.0.0.1:$CLOUD_PORT \
  -R $CLOUD_BIND:$CLOUD_SSH_NODE_A:127.0.0.1:$NODE_A_SSHD_PORT \
  -R $CLOUD_BIND:$NODE_A_LOCAL:127.0.0.1:$NODE_A_PORT \
  '$CLOUD_HOST' &
pids+=(\$!)
wait
EOF
  chmod 755 "$NODE_A_RUNNER"
}

write_nodeA_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/$NODE_A_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E studio tunnels
After=network-online.target $NODE_A_UNIT
Wants=$NODE_A_UNIT

[Service]
Type=simple
ExecStart=/bin/bash $NODE_A_RUNNER
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

write_nodeB_runner() {
  nodeB_ssh "mkdir -p '$NODE_B_STATE_DIR' '$NODE_B_STATE_DIR/ssh'"
  nodeB_ssh "cat > $NODE_B_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
pids=()
cleanup() { trap - INT TERM EXIT; for pid in "\${pids[@]}"; do kill "\$pid"; done; }
trap cleanup INT TERM EXIT
exec ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \\
  -o ServerAliveCountMax=3 -o ConnectTimeout=10 \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$NODE_B_CLOUD_KNOWN" \\
  -F /dev/null -i "$REVERSE_KEY_NODE_B" -o IdentitiesOnly=yes -N \\
  -L 127.0.0.1:$CLOUD_LOCAL:127.0.0.1:$CLOUD_PORT \\
  -L 127.0.0.1:$NODE_A_LOCAL:$CLOUD_BIND:$NODE_A_LOCAL \\
  -R $CLOUD_BIND:$CLOUD_SSH_NODE_B:127.0.0.1:$NODE_B_SSHD_PORT \\
  -R $CLOUD_BIND:$NODE_B_LOCAL:127.0.0.1:$NODE_B_PORT \\
  "$CLOUD_SSH_USER@$CLOUD_HOST"
EOF
  nodeB_ssh "chmod 755 $NODE_B_RUNNER"
}

write_nodeB_unit() {
  nodeB_ssh "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/$NODE_B_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E nodeB tunnels
After=network-online.target $NODE_B_UNIT
Wants=$NODE_B_UNIT

[Service]
Type=simple
ExecStart=/bin/bash $NODE_B_RUNNER
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

prepare_nodeB_cloud_known_hosts() {
  local known
  known="$(ssh-keygen -F "$CLOUD_HOST" -f "$CLOUD_KNOWN_HOSTS")"
  [ -n "$known" ] || die "No pinned cloud host key in CLOUD_KNOWN_HOSTS"
  nodeB_ssh "mkdir -p '$NODE_B_STATE_DIR/ssh' && cat > '$NODE_B_CLOUD_KNOWN' && chmod 600 '$NODE_B_CLOUD_KNOWN'" <<<"$known"
}

wait_port_local() {
  local port=$1 tries=${2:-30} i
  for ((i = 1; i <= tries; i++)); do
    ss -H -ltn "sport = :$port" | grep -q . && return 0
    sleep 1
  done
  return 1
}

wait_port_cloud() {
  local port=$1 tries=${2:-30} i
  for ((i = 1; i <= tries; i++)); do
    cloud_ssh "ss -H -ltn 'sport = :$port' | grep -q ." && return 0
    sleep 1
  done
  return 1
}

populate_container_known_hosts() {
  cloud_ssh 'bash -s' <<'EOF'
set -euo pipefail
kh=/opt/t3-mesh-e2e/home/.ssh/known_hosts
: >"$kh"
ssh-keyscan -p 22022 172.17.0.1 >>"$kh" 2>/dev/null || true
ssh-keyscan -p 22023 172.17.0.1 >>"$kh" 2>/dev/null || true
sort -u "$kh" -o "$kh"
chown 10001:10001 "$kh"
chmod 600 "$kh"
EOF
}

container_ssh_check() {
  local host=$1 target=$2
  cloud_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes '$host' hostname" \
    | grep -qx "$target"
}

cmd_up() {
  log "preparing nodeB CLOUD host key"
  prepare_nodeB_cloud_known_hosts

  log "writing studio tunnel unit"
  write_nodeA_runner
  write_nodeA_unit
  systemctl --user daemon-reload
  systemctl --user enable --now "$NODE_A_TUNNEL_UNIT" >/dev/null
  systemctl --user restart "$NODE_A_TUNNEL_UNIT"

  log "writing nodeB tunnel unit"
  write_nodeB_runner
  write_nodeB_unit
  nodeB_ssh "systemctl --user daemon-reload && systemctl --user enable --now $NODE_B_TUNNEL_UNIT && systemctl --user restart $NODE_B_TUNNEL_UNIT" >/dev/null

  log "waiting for local forwards"
  for port in "$NODE_A_LOCAL" "$NODE_B_LOCAL" "$CLOUD_LOCAL"; do
    wait_port_local "$port" 40 || die "studio local port $port did not come up"
  done

  log "waiting for CLOUD reverse forwards"
  for port in "$CLOUD_SSH_NODE_B" "$CLOUD_SSH_NODE_A" "$NODE_B_LOCAL" "$NODE_A_LOCAL"; do
    wait_port_cloud "$port" 40 || die "CLOUD reverse port $port did not come up"
  done

  log "pinning container host keys"
  populate_container_known_hosts

  log "checking container SSH to nodeB and studio"
  container_ssh_check nodeB nodeB || die "CLOUD container cannot ssh to nodeB"
  container_ssh_check studio studio || die "CLOUD container cannot ssh to studio"
  log "tunnels up"
}

cmd_down() {
  systemctl --user disable --now "$NODE_A_TUNNEL_UNIT" >/dev/null 2>&1 || true
  nodeB_ssh "systemctl --user disable --now $NODE_B_TUNNEL_UNIT" >/dev/null 2>&1 || true
  log "tunnels down"
}

cmd_status() {
  echo "studio tunnels: $(systemctl --user is-active "$NODE_A_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "nodeB tunnels:    $(nodeB_ssh "systemctl --user is-active $NODE_B_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "studio local ports:"
  ss -H -ltn | grep -E ":($NODE_A_LOCAL|$NODE_B_LOCAL|$CLOUD_LOCAL) " || echo "  (none)"
  echo "CLOUD reverse bindings:"
  cloud_ssh "ss -H -ltn | grep -E '($CLOUD_BIND):($CLOUD_SSH_NODE_B|$CLOUD_SSH_NODE_A|$NODE_B_LOCAL|$NODE_A_LOCAL) ' || true"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "usage: tunnels.sh up|down|status" ;;
esac
