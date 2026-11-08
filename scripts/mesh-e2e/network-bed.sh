#!/usr/bin/env bash
set -euo pipefail
action=${1:-}
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_CORE_WORK=${MESH_E2E_BED_OPS:-/tmp/mesh-network-ops}
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mesh-core-acceptance.sh"
unset MESH_E2E_HELPERS_ONLY
set -euo pipefail
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-mesh-network}
require_bed_lock() {
  local owner
  owner=$(nodeB_ssh 'cat /tmp/mesh-bed.lock/owner') || return 1
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
T_NODE_A=$(mint_token nodeA)
T_NODE_B=$(mint_token nodeB)
T_CLOUD=$(mint_token cloud)
NODE_A_ENV=$(descriptor_env "$NODE_A_ORIGIN")
NODE_B_ENV=$(descriptor_env "$NODE_B_ORIGIN")
CLOUD_ENV=$(descriptor_env "$CLOUD_ORIGIN")
binary="$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3"
proof=/tmp/mesh-network-proof
wait_connection() {
  local state=$1 direction=${2:-} deadline=$((SECONDS+90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    ws_rpc nodeA meshLayout.status '{}' > "$WORK/current-status.json"
    if jq -e --arg e "$CLOUD_ENV" --arg s "$state" --arg d "$direction" '.connections[] | select(.environmentId==$e and .state==$s and ($d=="" or .direction==$d))' "$WORK/current-status.json" >/dev/null; then return 0; fi
    sleep 1
  done
  cat "$WORK/current-status.json"
  return 1
}
read_proof() {
  ws_rpc nodeA files.read "$(jq -nc --arg e "$CLOUD_ENV" --arg p "$proof" '{environmentId:$e,absolutePath:$p}')" > "$WORK/read-proof.json"
  jq -e '.contents=="mesh network persistent relay"' "$WORK/read-proof.json" >/dev/null
}
metrics() {
  local machine
  for machine in nodeA nodeB cloud; do
    curl -fsS "$(origin_of "$machine")/__mesh_network" > "$WORK/final-proxy-$machine.json"
    jq -e '.state.denyMcp==true' "$WORK/final-proxy-$machine.json" >/dev/null
    jq -e '.peerMcp==.refusedPeerMcp' "$WORK/final-proxy-$machine.json" >/dev/null
  done
}
ssh_options() {
  local identity
  identity=$(cat "$WORK/ssh-identity.path")
  ssh_user=$(cat "$WORK/ssh-user")
  printf -v proxy_command '%q mesh pipe %q --base-dir %q' "$binary" "$CLOUD_ENV" "$NODE_A_BASE_DIR"
  ssh_args=(-F /dev/null -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$WORK/ssh-known-hosts" -o "ProxyCommand=$proxy_command" "$ssh_user@mesh-network-target")
}
case "$action" in
  nat)
    cloud_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false,\"denyPeer\":true}\\n' > '$CLOUD_DIR/tmp/mesh-network-state.json'"
    [ "$(curl -s -o "$WORK/inbound-peer-refusal.txt" -w '%{http_code}' "$CLOUD_ORIGIN/peer")" = 503 ]
    ws_rpc nodeB peerLinks.list '{}' > "$WORK/nat-nodeB-links.json"
    if jq -e --arg e "$CLOUD_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-nodeB-links.json" >/dev/null; then
      ws_rpc nodeB peerLinks.unlink "$(jq -nc --arg e "$CLOUD_ENV" '{environmentId:$e}')" > "$WORK/nat-unlink.json"
    fi
    for attempt in $(seq 1 60); do
      ws_rpc cloud peerLinks.list '{}' > "$WORK/nat-cloud-links.json"
      if ! jq -e --arg e "$NODE_B_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-cloud-links.json" >/dev/null; then break; fi
      sleep 1
    done
    ! jq -e --arg e "$NODE_B_ENV" '.links[] | select(.environmentId==$e)' "$WORK/nat-cloud-links.json" >/dev/null
    code=$(pair_code nodeB)
    ws_rpc cloud peerLinks.link "$(jq -nc --arg c "$code" --arg e "$NODE_B_ENV" --arg url "http://127.0.0.1:$NODE_B_LOCAL" '{url:$url,pairingCode:$c,access:"full-access",expectedEnvironmentId:$e}')" > "$WORK/nat-link.json"
    for attempt in $(seq 1 60); do
      ws_rpc nodeB meshLayout.status '{}' > "$WORK/nat-nodeB-status.json"
      ws_rpc nodeB peerLinks.list '{}' > "$WORK/nat-nodeB-links.json"
      # The live connection can precede persistence of its reciprocal grant.
      if jq -e --arg e "$CLOUD_ENV" '.connections[] | select(.environmentId==$e and .state=="direct" and .direction=="inbound")' "$WORK/nat-nodeB-status.json" >/dev/null &&
        jq -e --arg e "$CLOUD_ENV" '.links[] | select(.environmentId==$e and (.urls|length)==0 and .status=="reachable")' "$WORK/nat-nodeB-links.json" >/dev/null; then break; fi
      sleep 1
    done
    jq -e --arg e "$CLOUD_ENV" '.connections[] | select(.environmentId==$e and .state=="direct" and .direction=="inbound")' "$WORK/nat-nodeB-status.json" >/dev/null
    jq -e --arg e "$CLOUD_ENV" '.links[] | select(.environmentId==$e and (.urls|length)==0 and .status=="reachable")' "$WORK/nat-nodeB-links.json" > "$WORK/nat-reverse-grant.json"
    wait_connection relayed
    cloud_ssh "docker exec t3-mesh-e2e sh -c 'printf %s \"mesh network persistent relay\" > $proof'"
    read_proof
    metrics
    printf 'PASS bed NAT: inbound peer connections refused; CLOUD dials nodeB; reverse grant has no address; nodeA calls CLOUD via nodeB\n'
    ;;
  ssh)
    ws_get nodeA > "$WORK/ssh-layout.json"
    jq --arg e "$CLOUD_ENV" '.config.machines[$e].reported.sshd.hostKeys' "$WORK/ssh-layout.json" > "$WORK/ssh-host-keys.json"
    ssh_user=$(jq -r --arg e "$CLOUD_ENV" '.config.machines[$e].reported.user' "$WORK/ssh-layout.json")
    [[ "$ssh_user" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "Invalid reported SSH user"
    printf '%s\n' "$ssh_user" > "$WORK/ssh-user"
    MESH_E2E_SSH_PREPARE_ONLY=1 node "$MESH_DIR/network-ssh.mjs" "$binary" "$NODE_A_BASE_DIR" "$CLOUD_ENV" "$ssh_user" "$WORK/ssh-host-keys.json" > "$WORK/ssh-prepare.log"
    public_key=$(sed -n 's/^AUTHORIZED_KEY_FILE=//p' "$WORK/ssh-prepare.log")
    [ -f "$public_key" ]
    printf '%s\n' "${public_key%.pub}" > "$WORK/ssh-identity.path"
    cat "$public_key" | cloud_ssh "cat > '$CLOUD_DATA/.ssh/mesh_network_authorized_keys'; chmod 600 '$CLOUD_DATA/.ssh/mesh_network_authorized_keys'; chown 10001:10001 '$CLOUD_DATA/.ssh/mesh_network_authorized_keys'"
    cloud_ssh "cat > '$CLOUD_DIR/tmp/mesh-network-sshd_config'" <<EOF
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /tmp/mesh-network-sshd.pid
AuthorizedKeysFile /home/t3/.ssh/authorized_keys /home/t3/.ssh/mesh_network_authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowUsers $ssh_user
Subsystem sftp internal-sftp
EOF
    cloud_ssh "chmod 644 '$CLOUD_DIR/tmp/mesh-network-sshd_config'; docker exec t3-mesh-e2e /usr/sbin/sshd -t -f /tmp/mesh-network-sshd_config"
    cloud_ssh "docker exec -d t3-mesh-e2e sh -c 'if [ -s /tmp/mesh-network-sshd.pid ] && kill -0 \"\$(cat /tmp/mesh-network-sshd.pid)\" 2>/dev/null; then exit 0; fi; exec /usr/sbin/sshd -D -e -f /tmp/mesh-network-sshd_config'"
    for machine in nodeA nodeB; do
      ws_rpc "$machine" meshLayout.status '{}' | jq -Sc '[.connections[] | select(.state=="direct") | {environmentId,connectedAt}] | sort_by(.environmentId)' > "$WORK/ssh-before-$machine.json"
    done
    MESH_E2E_SSH_IDENTITY=$(cat "$WORK/ssh-identity.path") node "$MESH_DIR/network-ssh.mjs" "$binary" "$NODE_A_BASE_DIR" "$CLOUD_ENV" "$ssh_user" "$WORK/ssh-host-keys.json"
    for machine in nodeA nodeB; do
      ws_rpc "$machine" meshLayout.status '{}' | jq -Sc '[.connections[] | select(.state=="direct") | {environmentId,connectedAt}] | sort_by(.environmentId)' > "$WORK/ssh-after-$machine.json"
      cmp "$WORK/ssh-before-$machine.json" "$WORK/ssh-after-$machine.json"
    done
    printf 'PASS all persistent peer connections survived SSH transfer interruption\n'
    jq -r '.[] | "mesh-network-target "+.' "$WORK/ssh-host-keys.json" > "$WORK/ssh-known-hosts"
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
    dropin="$HOME/.config/systemd/user/$NODE_A_TUNNEL_UNIT.d/92-mesh-network-readonly-ssh.conf"
    mkdir -p "$(dirname "$dropin")"
    printf '[Service]\nEnvironment=PATH=%s:/usr/bin:/bin\n' "$readonly_ssh" > "$dropin"
    systemctl --user daemon-reload
    tunnel_stopped=0
    restore_tunnel() {
      require_bed_lock || { printf 'Bed lock lost; leaving shared tunnels untouched.\n' >&2; return 1; }
      if [ "$tunnel_stopped" = 1 ]; then systemctl --user start "$NODE_A_TUNNEL_UNIT"; fi
      rm "$dropin"
      systemctl --user daemon-reload
    }
    trap restore_tunnel EXIT
    before=$(systemctl --user show "$NODE_A_UNIT" -p NRestarts --value)
    systemctl --user is-active --quiet "$NODE_A_TUNNEL_UNIT"
    require_bed_lock || die 'Bed lock lost before tunnel cut'
    tunnel_stopped=1
    systemctl --user stop "$NODE_A_TUNNEL_UNIT"
    wait_connection offline
    jq -e --arg e "$CLOUD_ENV" '.connections[] | select(.environmentId==$e and .offlineSince!=null and .lastError!=null)' "$WORK/current-status.json" > "$WORK/tunnel-offline.json"
    for elapsed in 30 60 90 120 150 180; do sleep 30; printf 'mesh network bed tunnel cut: %s/180 seconds\n' "$elapsed"; done
    require_bed_lock || die 'Bed lock lost during tunnel cut'
    systemctl --user start "$NODE_A_TUNNEL_UNIT"
    tunnel_stopped=0
    wait_connection relayed
    read_proof
    [ "$before" = "$(systemctl --user show "$NODE_A_UNIT" -p NRestarts --value)" ]
    printf 'PASS bed three-minute tunnel cut: relay recovers without a T3 restart\n'
    restarts=$(cloud_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e')
    ws_rpc nodeB meshLayout.status '{}' > "$WORK/before-kill-status.json"
    connected_at=$(jq -r --arg e "$CLOUD_ENV" '.connections[] | select(.environmentId==$e and .state=="direct") | .connectedAt' "$WORK/before-kill-status.json")
    pid=$(cloud_ssh 'docker exec t3-mesh-e2e cat /tmp/mesh-network-server-spawn.pid')
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || die "Invalid captured server PID"
    require_bed_lock || die 'Bed lock lost before server crash'
    cloud_ssh "docker exec t3-mesh-e2e kill -9 '$pid'"
    for attempt in $(seq 1 90); do
      after=$(cloud_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e')
      if [ "$after" -gt "$restarts" ]; then break; fi
      sleep 1
    done
    [ "$after" -gt "$restarts" ]
    for attempt in $(seq 1 90); do
      ws_rpc nodeB meshLayout.status '{}' > "$WORK/after-kill-status.json"
      if jq -e --arg e "$CLOUD_ENV" --arg before "$connected_at" '.connections[] | select(.environmentId==$e and .state=="direct" and .connectedAt!=$before)' "$WORK/after-kill-status.json" >/dev/null; then break; fi
      sleep 1
    done
    jq -e --arg e "$CLOUD_ENV" --arg before "$connected_at" '.connections[] | select(.environmentId==$e and .state=="direct" and .connectedAt!=$before)' "$WORK/after-kill-status.json" >/dev/null
    wait_connection relayed
    read_proof
    ssh_options
    ssh "${ssh_args[@]}" true
    metrics
    printf 'PASS bed SIGKILL: automatic restart count %s -> %s, relay and SSH recovered\n' "$restarts" "$after"
    ;;
  restore)
    cloud_ssh "printf '{\"denyMcp\":true,\"peerOnlyMcp\":true,\"cut\":false,\"denyPeer\":false}\\n' > '$CLOUD_DIR/tmp/mesh-network-state.json'"
    ws_rpc nodeB peerLinks.unlink "$(jq -nc --arg e "$CLOUD_ENV" '{environmentId:$e}')" > "$WORK/restore-unlink.json"
    for attempt in $(seq 1 60); do
      ws_rpc cloud peerLinks.list '{}' > "$WORK/restore-cloud-links.json"
      if ! jq -e --arg e "$NODE_B_ENV" '.links[] | select(.environmentId==$e)' "$WORK/restore-cloud-links.json" >/dev/null; then break; fi
      sleep 1
    done
    ! jq -e --arg e "$NODE_B_ENV" '.links[] | select(.environmentId==$e)' "$WORK/restore-cloud-links.json" >/dev/null
    code=$(pair_code cloud)
    ws_rpc nodeB peerLinks.link "$(jq -nc --arg c "$code" --arg e "$CLOUD_ENV" --arg url "http://127.0.0.1:$CLOUD_LOCAL" '{url:$url,pairingCode:$c,access:"full-access",expectedEnvironmentId:$e}')" > "$WORK/restore-link.json"
    wait_connection relayed
    read_proof
    metrics
    printf 'PASS bed restored to nodeB dialing CLOUD; temporary outbound forwarder can be removed\n'
    ;;
  *) die "Usage: network-bed.sh nat|ssh|faults|restore (after proxies up/block; run ssh before faults)" ;;
esac
