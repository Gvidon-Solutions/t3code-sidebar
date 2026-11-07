#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
action=${1:-}
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_ROUND1_WORK=${N1_BED_OPS:-/tmp/N1-network-ops}
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/round1.sh"
unset MESH_E2E_HELPERS_ONLY
set -euo pipefail
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-N1}
require_bed_lock() {
  local owner
  owner=$(worker_ssh 'cat /tmp/mesh-bed.lock/owner') || return 1
  [ "$owner" = "$BED_LOCK_OWNER" ] || { printf 'Bed belongs to %s, expected %s.\n' "$owner" "$BED_LOCK_OWNER" >&2; return 1; }
}
require_bed_lock || die "$BED_LOCK_OWNER must hold the bed lock"
ws_rpc() {
  require_bed_lock || return 1
  local machine=$1 method=$2 payload=${3:-'{}'} first=${4:-} token
  token=$(token_of "$machine")
  [ -n "$token" ] || { printf '{"__error":true,"message":"no token"}\n'; return 1; }
  node "$WS" rpc "$method" "$payload" ${first:+"$first"} --origin "$(origin_of "$machine")" --token "$token" --timeout 60000
}
chmod 700 "$WORK"
T_GV=$(mint_token studio)
T_GOR=$(mint_token worker)
T_VPS=$(mint_token cloudbox)
STUDIO_ENV=$(descriptor_env "$STUDIO_ORIGIN")
WORKER_ENV=$(descriptor_env "$WORKER_ORIGIN")
CLOUDBOX_ENV=$(descriptor_env "$CLOUDBOX_ORIGIN")
binary="$STUDIO_RUNTIME_ROOT/$BUILD_VERSION/t3"
proof=/tmp/N1-network-proof
wait_connection() {
  local state=$1 direction=${2:-} deadline=$((SECONDS+90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    ws_rpc studio meshLayout.status '{}' > "$WORK/current-status.json"
    if jq -e --arg e "$CLOUDBOX_ENV" --arg s "$state" --arg d "$direction" '.connections[] | select(.environmentId==$e and .state==$s and ($d=="" or .direction==$d))' "$WORK/current-status.json" >/dev/null; then return 0; fi
    sleep 1
  done
  cat "$WORK/current-status.json"
  return 1
}
read_proof() {
  ws_rpc studio files.read "$(jq -nc --arg e "$CLOUDBOX_ENV" --arg p "$proof" '{environmentId:$e,absolutePath:$p}')" > "$WORK/read-proof.json"
  jq -e '.contents=="N1 persistent relay"' "$WORK/read-proof.json" >/dev/null
}
metrics() {
  local machine
  for machine in "${BED_MACHINES[@]}"; do
    curl -fsS "$(origin_of "$machine")/__N1_network" > "$WORK/final-proxy-$machine.json"
    jq -e '.state.denyMcp==true' "$WORK/final-proxy-$machine.json" >/dev/null
    jq -e '.peerMcp==.refusedPeerMcp' "$WORK/final-proxy-$machine.json" >/dev/null
  done
}
ssh_options() {
  local identity
  identity=$(cat "$WORK/ssh-identity.path")
  ssh_user=$(cat "$WORK/ssh-user")
  printf -v proxy_command '%q mesh pipe %q --base-dir %q' "$binary" "$CLOUDBOX_ENV" "$STUDIO_BASE_DIR"
  ssh_args=(-F /dev/null -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$WORK/ssh-known-hosts" -o "ProxyCommand=$proxy_command" "$ssh_user@N1-network-target")
}
case "$action" in
  nat)
    cloudbox_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false,\"denyPeer\":true}\\n' > '$CLOUDBOX_DIR/tmp/N1-network-state.json'"
    [ "$(curl -s -o "$WORK/inbound-peer-refusal.txt" -w '%{http_code}' "$CLOUDBOX_ORIGIN/peer")" = 503 ]
    ws_rpc worker peerLinks.list '{}' > "$WORK/nat-worker-links.json"
    if jq -e --arg e "$CLOUDBOX_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-worker-links.json" >/dev/null; then
      ws_rpc worker peerLinks.unlink "$(jq -nc --arg e "$CLOUDBOX_ENV" '{environmentId:$e}')" > "$WORK/nat-unlink.json"
    fi
    for attempt in $(seq 1 60); do
      ws_rpc cloudbox peerLinks.list '{}' > "$WORK/nat-cloudbox-links.json"
      if ! jq -e --arg e "$WORKER_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-cloudbox-links.json" >/dev/null; then break; fi
      sleep 1
    done
    ! jq -e --arg e "$WORKER_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-cloudbox-links.json" >/dev/null
    code=$(pair_code worker)
    ws_rpc cloudbox peerLinks.link "$(jq -nc --arg c "$code" --arg e "$WORKER_ENV" '{url:"http://127.0.0.1:13797",pairingCode:$c,access:"full-access",expectedEnvironmentId:$e}')" > "$WORK/nat-link.json"
    for attempt in $(seq 1 60); do
      ws_rpc worker meshLayout.status '{}' > "$WORK/nat-worker-status.json"
      ws_rpc worker peerLinks.list '{}' > "$WORK/nat-worker-links.json"
      # The live connection can precede persistence of its reciprocal grant.
      if jq -e --arg e "$CLOUDBOX_ENV" '.connections[] | select(.environmentId==$e and .state=="direct" and .direction=="inbound")' "$WORK/nat-worker-status.json" >/dev/null &&
        jq -e --arg e "$CLOUDBOX_ENV" '.links[] | select(.environmentId==$e and (.urls|length)==0 and .status=="reachable")' "$WORK/nat-worker-links.json" >/dev/null; then break; fi
      sleep 1
    done
    jq -e --arg e "$CLOUDBOX_ENV" '.connections[] | select(.environmentId==$e and .state=="direct" and .direction=="inbound")' "$WORK/nat-worker-status.json" >/dev/null
    jq -e --arg e "$CLOUDBOX_ENV" '.links[] | select(.environmentId==$e and (.urls|length)==0 and .status=="reachable")' "$WORK/nat-worker-links.json" > "$WORK/nat-reverse-grant.json"
    wait_connection relayed
    cloudbox_ssh "docker exec t3-mesh-e2e sh -c 'printf %s \"N1 persistent relay\" > $proof'"
    read_proof
    metrics
    printf 'PASS bed NAT: inbound peer connections refused; VPS dials worker; reverse grant has no address; studio calls VPS via worker\n'
    ;;
  ssh)
    ws_get studio > "$WORK/ssh-layout.json"
    jq --arg e "$CLOUDBOX_ENV" '.config.machines[$e].reported.sshd.hostKeys' "$WORK/ssh-layout.json" > "$WORK/ssh-host-keys.json"
    ssh_user=$(jq -r --arg e "$CLOUDBOX_ENV" '.config.machines[$e].reported.user' "$WORK/ssh-layout.json")
    [[ "$ssh_user" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "Invalid reported SSH user"
    printf '%s\n' "$ssh_user" > "$WORK/ssh-user"
    N1_SSH_PREPARE_ONLY=1 node "$MESH_DIR/network-ssh.mjs" "$binary" "$STUDIO_BASE_DIR" "$CLOUDBOX_ENV" "$ssh_user" "$WORK/ssh-host-keys.json" > "$WORK/ssh-prepare.log"
    public_key=$(sed -n 's/^AUTHORIZED_KEY_FILE=//p' "$WORK/ssh-prepare.log")
    [ -f "$public_key" ]
    printf '%s\n' "${public_key%.pub}" > "$WORK/ssh-identity.path"
    cat "$public_key" | cloudbox_ssh "cat > '$CLOUDBOX_DATA/.ssh/N1_authorized_keys'; chmod 600 '$CLOUDBOX_DATA/.ssh/N1_authorized_keys'; chown 10001:10001 '$CLOUDBOX_DATA/.ssh/N1_authorized_keys'"
    cloudbox_ssh "cat > '$CLOUDBOX_DIR/tmp/N1-sshd_config'" <<EOF
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /tmp/N1-sshd.pid
AuthorizedKeysFile /home/t3/.ssh/authorized_keys /home/t3/.ssh/N1_authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowUsers $ssh_user
EOF
    cloudbox_ssh "chmod 644 '$CLOUDBOX_DIR/tmp/N1-sshd_config'; docker exec t3-mesh-e2e /usr/sbin/sshd -t -f /tmp/N1-sshd_config"
    cloudbox_ssh "docker exec -d t3-mesh-e2e sh -c 'if [ -s /tmp/N1-sshd.pid ] && kill -0 \"\$(cat /tmp/N1-sshd.pid)\" 2>/dev/null; then exit 0; fi; exec /usr/sbin/sshd -D -e -f /tmp/N1-sshd_config'"
    for machine in studio worker; do
      ws_rpc "$machine" meshLayout.status '{}' | jq -Sc '[.connections[] | select(.state=="direct") | {environmentId,connectedAt}] | sort_by(.environmentId)' > "$WORK/ssh-before-$machine.json"
    done
    N1_SSH_IDENTITY=$(cat "$WORK/ssh-identity.path") node "$MESH_DIR/network-ssh.mjs" "$binary" "$STUDIO_BASE_DIR" "$CLOUDBOX_ENV" "$ssh_user" "$WORK/ssh-host-keys.json"
    for machine in studio worker; do
      ws_rpc "$machine" meshLayout.status '{}' | jq -Sc '[.connections[] | select(.state=="direct") | {environmentId,connectedAt}] | sort_by(.environmentId)' > "$WORK/ssh-after-$machine.json"
      cmp "$WORK/ssh-before-$machine.json" "$WORK/ssh-after-$machine.json"
    done
    printf 'PASS all persistent peer connections survived SSH transfer interruption\n'
    jq -r '.[] | "N1-network-target "+.' "$WORK/ssh-host-keys.json" > "$WORK/ssh-known-hosts"
    metrics
    ;;
  faults)
    [ -f "$WORK/ssh-identity.path" ] || die "Run network-bed.sh ssh first"
    readonly_ssh="$WORK/readonly-ssh"
    mkdir -p "$readonly_ssh"
    cat > "$readonly_ssh/ssh" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/ssh -o StrictHostKeyChecking=yes -o UpdateHostKeys=no "$@"
EOF
    chmod 700 "$readonly_ssh/ssh"
    dropin="$HOME/.config/systemd/user/$STUDIO_TUNNEL_UNIT.d/92-N1-readonly-ssh.conf"
    mkdir -p "$(dirname "$dropin")"
    printf '[Service]\nEnvironment=PATH=%s:/usr/bin:/bin\n' "$readonly_ssh" > "$dropin"
    systemctl --user daemon-reload
    tunnel_stopped=0
    restore_tunnel() {
      require_bed_lock || { printf 'Bed lock lost; leaving shared tunnels untouched.\n' >&2; return 1; }
      if [ "$tunnel_stopped" = 1 ]; then systemctl --user start "$STUDIO_TUNNEL_UNIT"; fi
      rm "$dropin"
      systemctl --user daemon-reload
    }
    trap restore_tunnel EXIT
    before=$(systemctl --user show "$STUDIO_UNIT" -p NRestarts --value)
    systemctl --user is-active --quiet "$STUDIO_TUNNEL_UNIT"
    require_bed_lock || die 'Bed lock lost before tunnel cut'
    tunnel_stopped=1
    systemctl --user stop "$STUDIO_TUNNEL_UNIT"
    wait_connection offline
    jq -e --arg e "$CLOUDBOX_ENV" '.connections[] | select(.environmentId==$e and .offlineSince!=null and .lastError!=null)' "$WORK/current-status.json" > "$WORK/tunnel-offline.json"
    for elapsed in 30 60 90 120 150 180; do sleep 30; printf 'N1 bed tunnel cut: %s/180 seconds\n' "$elapsed"; done
    require_bed_lock || die 'Bed lock lost during tunnel cut'
    systemctl --user start "$STUDIO_TUNNEL_UNIT"
    tunnel_stopped=0
    wait_connection relayed
    read_proof
    [ "$before" = "$(systemctl --user show "$STUDIO_UNIT" -p NRestarts --value)" ]
    printf 'PASS bed three-minute tunnel cut: relay recovers without a T3 restart\n'
    restarts=$(cloudbox_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e')
    ws_rpc worker meshLayout.status '{}' > "$WORK/before-kill-status.json"
    connected_at=$(jq -r --arg e "$CLOUDBOX_ENV" '.connections[] | select(.environmentId==$e and .state=="direct") | .connectedAt' "$WORK/before-kill-status.json")
    pid=$(cloudbox_ssh 'docker exec t3-mesh-e2e cat /tmp/N1-server-spawn.pid')
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || die "Invalid captured server PID"
    require_bed_lock || die 'Bed lock lost before server crash'
    cloudbox_ssh "docker exec t3-mesh-e2e kill -9 '$pid'"
    for attempt in $(seq 1 90); do
      after=$(cloudbox_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e')
      if [ "$after" -gt "$restarts" ]; then break; fi
      sleep 1
    done
    [ "$after" -gt "$restarts" ]
    for attempt in $(seq 1 90); do
      ws_rpc worker meshLayout.status '{}' > "$WORK/after-kill-status.json"
      if jq -e --arg e "$CLOUDBOX_ENV" --arg before "$connected_at" '.connections[] | select(.environmentId==$e and .state=="direct" and .connectedAt!=$before)' "$WORK/after-kill-status.json" >/dev/null; then break; fi
      sleep 1
    done
    jq -e --arg e "$CLOUDBOX_ENV" --arg before "$connected_at" '.connections[] | select(.environmentId==$e and .state=="direct" and .connectedAt!=$before)' "$WORK/after-kill-status.json" >/dev/null
    wait_connection relayed
    read_proof
    ssh_options
    ssh "${ssh_args[@]}" true
    metrics
    printf 'PASS bed SIGKILL: automatic restart count %s -> %s, relay and SSH recovered\n' "$restarts" "$after"
    ;;
  restore)
    cloudbox_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false,\"denyPeer\":false}\\n' > '$CLOUDBOX_DIR/tmp/N1-network-state.json'"
    ws_rpc worker peerLinks.unlink "$(jq -nc --arg e "$CLOUDBOX_ENV" '{environmentId:$e}')" > "$WORK/restore-unlink.json"
    for attempt in $(seq 1 60); do
      ws_rpc cloudbox peerLinks.list '{}' > "$WORK/restore-cloudbox-links.json"
      if ! jq -e --arg e "$WORKER_ENV" '.links[] | select(.environmentId==$e)' "$WORK/restore-cloudbox-links.json" >/dev/null; then break; fi
      sleep 1
    done
    ! jq -e --arg e "$WORKER_ENV" '.links[] | select(.environmentId==$e)' "$WORK/restore-cloudbox-links.json" >/dev/null
    code=$(pair_code cloudbox)
    ws_rpc worker peerLinks.link "$(jq -nc --arg c "$code" --arg e "$CLOUDBOX_ENV" '{url:"http://127.0.0.1:13791",pairingCode:$c,access:"full-access",expectedEnvironmentId:$e}')" > "$WORK/restore-link.json"
    wait_connection relayed
    read_proof
    metrics
    printf 'PASS bed restored to worker dialing VPS; temporary outbound forwarder can be removed\n'
    ;;
  *) die "Usage: network-bed.sh nat|ssh|faults|restore (after proxies up/block; run ssh before faults)" ;;
esac
