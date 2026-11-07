#!/usr/bin/env bash
# Tunnels for the T3 Mesh E2E bed.
#
#   up      studio: 13795 -> local studio, 13797 -> worker, 13791 -> VPS
#           studio: reverse to VPS 172.17.0.1:22023 (sshd), :13795 (studio HTTP)
#           worker:    local 13791 -> VPS; reverse 172.17.0.1:22022 (sshd),
#                   :13797 (worker HTTP)
#   down    stop both tunnel units
#   status  show units and listening ports
#
# The reverse side binds to the VPS docker bridge address (172.17.0.1) because
# the container runs on a bridge network and cannot see host loopback.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

STUDIO_RUNNER="$HOME/.local/share/t3-mesh-e2e/tunnels-studio.sh"
WORKER_RUNNER='$HOME/.local/share/t3-mesh-e2e/tunnels-worker.sh'
WORKER_CLOUDBOX_KNOWN='$HOME/.ssh/t3_mesh_e2e_vps_known_hosts'

write_gv_runner() {
  mkdir -p "$(dirname "$STUDIO_RUNNER")"
  cat >"$STUDIO_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cleanup() { trap - INT TERM EXIT; kill 0; }
trap cleanup INT TERM EXIT
common=(-o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15
        -o ServerAliveCountMax=3 -o ConnectTimeout=10)
# Client view on studio: the isolated studio server is loopback-only, so even
# its own alias goes through sshd.
ssh "\${common[@]}" -i '$SELF_KEY' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  -N -L 127.0.0.1:$STUDIO_LOCAL:127.0.0.1:$STUDIO_PORT $STUDIO_SSH_USER@127.0.0.1 &
ssh "\${common[@]}" -F '$WORKER_SSH_CONFIG' -i '$WORKER_SSH_KEY' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$WORKER_LOCAL:127.0.0.1:$WORKER_PORT '$WORKER_HOST' &
ssh "\${common[@]}" -F '$CLOUDBOX_SSH_CONFIG' -i '$REVERSE_KEY_GV' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$CLOUDBOX_LOCAL:127.0.0.1:$CLOUDBOX_PORT \
  -R $CLOUDBOX_BIND:$CLOUDBOX_SSH_GV:127.0.0.1:22 \
  -R $CLOUDBOX_BIND:$STUDIO_LOCAL:127.0.0.1:$STUDIO_PORT \
  '$CLOUDBOX_HOST' &
wait
EOF
  chmod 755 "$STUDIO_RUNNER"
}

write_gv_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/$STUDIO_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E studio tunnels
After=network-online.target $STUDIO_UNIT
Wants=$STUDIO_UNIT

[Service]
Type=simple
ExecStart=/bin/bash %h/.local/share/t3-mesh-e2e/tunnels-studio.sh
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

write_gor_runner() {
  worker_ssh 'mkdir -p ~/.local/share/t3-mesh-e2e'
  worker_ssh "cat > $WORKER_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cleanup() { trap - INT TERM EXIT; kill 0; }
trap cleanup INT TERM EXIT
exec ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \\
  -o ServerAliveCountMax=3 -o ConnectTimeout=10 \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORKER_CLOUDBOX_KNOWN" \\
  -i "\$HOME/.ssh/id_t3_mesh_e2e_vps" -o IdentitiesOnly=yes -N \\
  -L 127.0.0.1:$CLOUDBOX_LOCAL:127.0.0.1:$CLOUDBOX_PORT \\
  -L 127.0.0.1:$STUDIO_LOCAL:$CLOUDBOX_BIND:$STUDIO_LOCAL \\
  -R $CLOUDBOX_BIND:$CLOUDBOX_SSH_GOR:127.0.0.1:22 \\
  -R $CLOUDBOX_BIND:$WORKER_LOCAL:127.0.0.1:$WORKER_PORT \\
  root@$CLOUDBOX_HOST
EOF
  worker_ssh "chmod 755 $WORKER_RUNNER"
}

write_gor_unit() {
  worker_ssh "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/$WORKER_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E worker tunnels
After=network-online.target $WORKER_UNIT
Wants=$WORKER_UNIT

[Service]
Type=simple
ExecStart=/bin/bash %h/.local/share/t3-mesh-e2e/tunnels-worker.sh
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

prepare_gor_vps_known_hosts() {
  local known
  known="$(ssh-keygen -F "$CLOUDBOX_HOST" -f "$HOME/.local/share/vpn-ops/known_hosts" 2>/dev/null || true)"
  if [ -z "$known" ]; then
    known="$(ssh-keyscan -t ed25519 "$CLOUDBOX_HOST" 2>/dev/null || true)"
  fi
  [ -n "$known" ] || die "cannot read or scan the VPS host key"
  worker_ssh "mkdir -p ~/.ssh && cat > $WORKER_CLOUDBOX_KNOWN && chmod 600 $WORKER_CLOUDBOX_KNOWN" <<<"$known"
}

wait_port_local() {
  local port=$1 tries=${2:-30} i
  for ((i = 1; i <= tries; i++)); do
    ss -H -ltn "sport = :$port" | grep -q . && return 0
    sleep 1
  done
  return 1
}

wait_port_vps() {
  local port=$1 tries=${2:-30} i
  for ((i = 1; i <= tries; i++)); do
    cloudbox_ssh "ss -H -ltn 'sport = :$port' | grep -q ." && return 0
    sleep 1
  done
  return 1
}

populate_container_known_hosts() {
  cloudbox_ssh 'bash -s' <<'EOF'
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
  cloudbox_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes '$host' hostname" \
    | grep -qx "$target"
}

cmd_up() {
  log "preparing worker VPS host key"
  prepare_gor_vps_known_hosts

  log "writing studio tunnel unit"
  write_gv_runner
  write_gv_unit
  systemctl --user daemon-reload
  systemctl --user enable --now "$STUDIO_TUNNEL_UNIT" >/dev/null
  systemctl --user restart "$STUDIO_TUNNEL_UNIT"

  log "writing worker tunnel unit"
  write_gor_runner
  write_gor_unit
  worker_ssh "systemctl --user daemon-reload && systemctl --user enable --now $WORKER_TUNNEL_UNIT && systemctl --user restart $WORKER_TUNNEL_UNIT" >/dev/null

  log "waiting for local forwards"
  for port in "$STUDIO_LOCAL" "$WORKER_LOCAL" "$CLOUDBOX_LOCAL"; do
    wait_port_local "$port" 40 || die "studio local port $port did not come up"
  done

  log "waiting for VPS reverse forwards"
  for port in "$CLOUDBOX_SSH_GOR" "$CLOUDBOX_SSH_GV" "$WORKER_LOCAL" "$STUDIO_LOCAL"; do
    wait_port_vps "$port" 40 || die "VPS reverse port $port did not come up"
  done

  log "pinning container host keys"
  populate_container_known_hosts

  log "checking container SSH to worker and studio"
  container_ssh_check worker worker || die "VPS container cannot ssh to worker"
  container_ssh_check studio studio || die "VPS container cannot ssh to studio"
  log "tunnels up"
}

cmd_down() {
  systemctl --user disable --now "$STUDIO_TUNNEL_UNIT" >/dev/null 2>&1 || true
  worker_ssh "systemctl --user disable --now $WORKER_TUNNEL_UNIT" >/dev/null 2>&1 || true
  log "tunnels down"
}

cmd_status() {
  echo "studio tunnels: $(systemctl --user is-active "$STUDIO_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "worker tunnels:    $(worker_ssh "systemctl --user is-active $WORKER_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "studio local ports:"
  ss -H -ltn | grep -E ":($STUDIO_LOCAL|$WORKER_LOCAL|$CLOUDBOX_LOCAL) " || echo "  (none)"
  echo "VPS reverse bindings:"
  cloudbox_ssh "ss -H -ltn | grep -E '($CLOUDBOX_BIND):($CLOUDBOX_SSH_GOR|$CLOUDBOX_SSH_GV|$WORKER_LOCAL|$STUDIO_LOCAL) ' || true"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "usage: tunnels.sh up|down|status" ;;
esac
