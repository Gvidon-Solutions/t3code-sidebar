#!/usr/bin/env bash
# Tunnels for the T3 Mesh E2E bed.
#
#   up      gvidon: 13795 -> local gv, 13797 -> gor, 13791 -> VPS
#           gvidon: reverse to VPS 172.17.0.1:22023 (sshd), :13795 (gv HTTP)
#           gor:    local 13791 -> VPS; reverse 172.17.0.1:22022 (sshd),
#                   :13797 (gor HTTP)
#   down    stop both tunnel units
#   status  show units and listening ports
#
# The reverse side binds to the VPS docker bridge address (172.17.0.1) because
# the container runs on a bridge network and cannot see host loopback.
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

GV_RUNNER="$HOME/.local/share/t3-mesh-e2e/tunnels-gv.sh"
GOR_RUNNER='$HOME/.local/share/t3-mesh-e2e/tunnels-gor.sh'
GOR_VPS_KNOWN='$HOME/.ssh/t3_mesh_e2e_vps_known_hosts'

write_gv_runner() {
  mkdir -p "$(dirname "$GV_RUNNER")"
  cat >"$GV_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cleanup() { trap - INT TERM EXIT; kill 0; }
trap cleanup INT TERM EXIT
common=(-o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15
        -o ServerAliveCountMax=3 -o ConnectTimeout=10)
# Client view on gvidon: the isolated gvidon server is loopback-only, so even
# its own alias goes through sshd.
ssh "\${common[@]}" -i '$SELF_KEY' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  -N -L 127.0.0.1:$GV_LOCAL:127.0.0.1:$GV_PORT user@127.0.0.1 &
ssh "\${common[@]}" -F '$GOR_SSH_CONFIG' -i '$GOR_SSH_KEY' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$GOR_LOCAL:127.0.0.1:$GOR_PORT '$GOR_HOST' &
ssh "\${common[@]}" -F '$VPS_SSH_CONFIG' -i '$REVERSE_KEY_GV' -o IdentitiesOnly=yes \
  -N -L 127.0.0.1:$VPS_LOCAL:127.0.0.1:$VPS_PORT \
  -R $VPS_BIND:$VPS_SSH_GV:127.0.0.1:22 \
  -R $VPS_BIND:$GV_LOCAL:127.0.0.1:$GV_PORT \
  '$VPS_HOST' &
wait
EOF
  chmod 755 "$GV_RUNNER"
}

write_gv_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/$GV_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E gvidon tunnels
After=network-online.target $GV_UNIT
Wants=$GV_UNIT

[Service]
Type=simple
ExecStart=/bin/bash %h/.local/share/t3-mesh-e2e/tunnels-gv.sh
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

write_gor_runner() {
  gor_ssh 'mkdir -p ~/.local/share/t3-mesh-e2e'
  gor_ssh "cat > $GOR_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cleanup() { trap - INT TERM EXIT; kill 0; }
trap cleanup INT TERM EXIT
exec ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \\
  -o ServerAliveCountMax=3 -o ConnectTimeout=10 \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$GOR_VPS_KNOWN" \\
  -i "\$HOME/.ssh/id_t3_mesh_e2e_vps" -o IdentitiesOnly=yes -N \\
  -L 127.0.0.1:$VPS_LOCAL:127.0.0.1:$VPS_PORT \\
  -L 127.0.0.1:$GV_LOCAL:$VPS_BIND:$GV_LOCAL \\
  -R $VPS_BIND:$VPS_SSH_GOR:127.0.0.1:22 \\
  -R $VPS_BIND:$GOR_LOCAL:127.0.0.1:$GOR_PORT \\
  root@$VPS_HOST
EOF
  gor_ssh "chmod 755 $GOR_RUNNER"
}

write_gor_unit() {
  gor_ssh "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/$GOR_TUNNEL_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E gor tunnels
After=network-online.target $GOR_UNIT
Wants=$GOR_UNIT

[Service]
Type=simple
ExecStart=/bin/bash %h/.local/share/t3-mesh-e2e/tunnels-gor.sh
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

prepare_gor_vps_known_hosts() {
  local known
  known="$(ssh-keygen -F "$VPS_HOST" -f "$HOME/.local/share/vpn-ops/known_hosts" 2>/dev/null || true)"
  if [ -z "$known" ]; then
    known="$(ssh-keyscan -t ed25519 "$VPS_HOST" 2>/dev/null || true)"
  fi
  [ -n "$known" ] || die "cannot read or scan the VPS host key"
  gor_ssh "mkdir -p ~/.ssh && cat > $GOR_VPS_KNOWN && chmod 600 $GOR_VPS_KNOWN" <<<"$known"
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
    vps_ssh "ss -H -ltn 'sport = :$port' | grep -q ." && return 0
    sleep 1
  done
  return 1
}

populate_container_known_hosts() {
  vps_ssh 'bash -s' <<'EOF'
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
  vps_ssh "docker exec t3-mesh-e2e ssh -F /home/t3/.ssh/config -o BatchMode=yes '$host' hostname" \
    | grep -qx "$target"
}

cmd_up() {
  log "preparing gor VPS host key"
  prepare_gor_vps_known_hosts

  log "writing gvidon tunnel unit"
  write_gv_runner
  write_gv_unit
  systemctl --user daemon-reload
  systemctl --user enable --now "$GV_TUNNEL_UNIT" >/dev/null
  systemctl --user restart "$GV_TUNNEL_UNIT"

  log "writing gor tunnel unit"
  write_gor_runner
  write_gor_unit
  gor_ssh "systemctl --user daemon-reload && systemctl --user enable --now $GOR_TUNNEL_UNIT && systemctl --user restart $GOR_TUNNEL_UNIT" >/dev/null

  log "waiting for local forwards"
  for port in "$GV_LOCAL" "$GOR_LOCAL" "$VPS_LOCAL"; do
    wait_port_local "$port" 40 || die "gvidon local port $port did not come up"
  done

  log "waiting for VPS reverse forwards"
  for port in "$VPS_SSH_GOR" "$VPS_SSH_GV" "$GOR_LOCAL" "$GV_LOCAL"; do
    wait_port_vps "$port" 40 || die "VPS reverse port $port did not come up"
  done

  log "pinning container host keys"
  populate_container_known_hosts

  log "checking container SSH to gor and gvidon"
  container_ssh_check gor gor || die "VPS container cannot ssh to gor"
  container_ssh_check gvidon gvidon || die "VPS container cannot ssh to gvidon"
  log "tunnels up"
}

cmd_down() {
  systemctl --user disable --now "$GV_TUNNEL_UNIT" >/dev/null 2>&1 || true
  gor_ssh "systemctl --user disable --now $GOR_TUNNEL_UNIT" >/dev/null 2>&1 || true
  log "tunnels down"
}

cmd_status() {
  echo "gvidon tunnels: $(systemctl --user is-active "$GV_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "gor tunnels:    $(gor_ssh "systemctl --user is-active $GOR_TUNNEL_UNIT" 2>/dev/null || true)"
  echo "gvidon local ports:"
  ss -H -ltn | grep -E ":($GV_LOCAL|$GOR_LOCAL|$VPS_LOCAL) " || echo "  (none)"
  echo "VPS reverse bindings:"
  vps_ssh "ss -H -ltn | grep -E '($VPS_BIND):($VPS_SSH_GOR|$VPS_SSH_GV|$GOR_LOCAL|$GV_LOCAL) ' || true"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "usage: tunnels.sh up|down|status" ;;
esac
