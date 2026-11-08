#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(dirname "$0")/lib.sh"
worker_name=$(worker_ssh 'hostname -s')
[ "$worker_name" = "$BED_NIGHTLY_HOST" ] || die "Nightly timer target is $worker_name, expected $BED_NIGHTLY_HOST"
private="$BED_NIGHTLY_ROOT/controller"
mkdir -p "$private" "$HOME/.config/systemd/user"
chmod 700 "$private"
for key in client host; do
  if [ ! -f "$private/$key" ]; then ssh-keygen -q -t ed25519 -N '' -f "$private/$key"; fi
done
cp "$private/client.pub" "$private/authorized_keys"
chmod 600 "$private/authorized_keys"
codex_binary="${R1_CODEX_BINARY:-$(command -v codex)}"
opencode_binary="${R1_OPENCODE_BINARY:-$(command -v opencode)}"
[ -x "$codex_binary" ] && [ -x "$opencode_binary" ] || die "Native nightly provider binaries are required"
cat > "$private/entry" <<EOF_ENTRY
#!/bin/sh
set -eu
case "\${SSH_ORIGINAL_COMMAND:-run}" in
 probe) printf 'mesh-nightly-controller-ready\n' ;;
 run) export R1_CODEX_BINARY='$codex_binary' R1_OPENCODE_BINARY='$opencode_binary'; export HOME='$HOME'; export PATH='$HOME/.nvm/versions/node/v26.12.1/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.cargo/bin'; exec bash '$REPO_ROOT/scripts/mesh-e2e/acceptance.sh' ;;
 *) exit 64 ;;
esac
EOF_ENTRY
chmod 700 "$private/entry"
cat > "$private/sshd_config" <<EOF_SSH
Port $BED_CONTROLLER_PORT
ListenAddress $BED_CONTROLLER_ADDRESS
HostKey $private/host
AuthorizedKeysFile $private/authorized_keys
AllowUsers $(id -un)
StrictModes yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
UseDNS no
PermitUserRC no
PermitUserEnvironment no
AllowTcpForwarding no
PermitTTY no
X11Forwarding no
SetEnv HOME=$private
ForceCommand $private/entry
PidFile $private/pid
EOF_SSH
cat > "$HOME/.config/systemd/user/mesh-nightly-controller.service" <<EOF_UNIT
[Unit]
Description=Private mesh nightly controller SSH endpoint
[Service]
ExecStart=/usr/sbin/sshd -D -e -f $private/sshd_config
Restart=on-failure
[Install]
WantedBy=default.target
EOF_UNIT
systemctl --user daemon-reload
systemctl --user enable --now mesh-nightly-controller.service
systemctl --user restart mesh-nightly-controller.service
worker_ssh "test \"\$(hostname -s)\" = '$BED_NIGHTLY_HOST' && mkdir -p '$BED_NIGHTLY_ROOT' && chmod 700 '$BED_NIGHTLY_ROOT'"
worker_scp "$private/client" "$private/host.pub" "$MESH_DIR/nightly.mjs" "$WORKER_HOST:$BED_NIGHTLY_ROOT/"
local_user=$(id -un)
cat > "$private/ssh-config" <<EOF_CLIENT
Host controller
  HostName $BED_CONTROLLER_ADDRESS
  Port $BED_CONTROLLER_PORT
  User $local_user
  IdentityFile $BED_NIGHTLY_ROOT/client
  UserKnownHostsFile $BED_NIGHTLY_ROOT/known_hosts
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes
EOF_CLIENT
worker_scp "$private/ssh-config" "$WORKER_HOST:$BED_NIGHTLY_ROOT/ssh-config"
# The generated host key is pinned through the existing authenticated worker SSH connection.
{ printf '[%s]:%s ' "$BED_CONTROLLER_ADDRESS" "$BED_CONTROLLER_PORT"; cat "$private/host.pub"; } > "$private/known_hosts"
worker_scp "$private/known_hosts" "$WORKER_HOST:$BED_NIGHTLY_ROOT/known_hosts"
worker_scp "$(command -v node)" "$WORKER_HOST:$BED_NIGHTLY_ROOT/node"
node_path="$BED_NIGHTLY_ROOT/node"
ctl_path="$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs"
tar -czf "$private/cli.tar.gz" -C "$REPO_ROOT/agent-kit/skills/t3" scripts
worker_scp "$private/cli.tar.gz" "$WORKER_HOST:$BED_NIGHTLY_ROOT/cli.tar.gz"
worker_ssh "tar -xzf '$BED_NIGHTLY_ROOT/cli.tar.gz' -C '$BED_NIGHTLY_ROOT'"
node - "$private/job.json" "$BED_NIGHTLY_ROOT" "$node_path" <<'JS'
const fs=require('node:fs');const [file,root,node]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({directory:root+'/results',command:['ssh','-F',root+'/ssh-config','controller','run'],inboxCommand:[node,root+'/scripts/t3ctl.mjs']}));
JS
worker_scp "$private/job.json" "$WORKER_HOST:$BED_NIGHTLY_ROOT/job.json"
cat > "$private/service" <<EOF_SERVICE
[Unit]
Description=Realistic T3 mesh nightly acceptance
[Service]
Type=oneshot
Environment=T3CODE_HOME=$WORKER_BASE_DIR
Environment=T3CTL_ORIGIN=http://127.0.0.1:$WORKER_PORT
ExecStart=$node_path $BED_NIGHTLY_ROOT/nightly.mjs $BED_NIGHTLY_ROOT/job.json
TimeoutStartSec=3h10m
EOF_SERVICE
cat > "$private/timer" <<EOF_TIMER
[Unit]
Description=Run realistic T3 mesh acceptance nightly
[Timer]
OnCalendar=$BED_NIGHTLY_CALENDAR
Persistent=true
RandomizedDelaySec=5m
Unit=mesh-nightly.service
[Install]
WantedBy=timers.target
EOF_TIMER
worker_scp "$private/service" "$WORKER_HOST:$BED_NIGHTLY_ROOT/mesh-nightly.service"
worker_scp "$private/timer" "$WORKER_HOST:$BED_NIGHTLY_ROOT/mesh-nightly.timer"
worker_ssh "chmod 600 '$BED_NIGHTLY_ROOT/client'; ssh -F '$BED_NIGHTLY_ROOT/ssh-config' controller probe; mkdir -p ~/.config/systemd/user; cp '$BED_NIGHTLY_ROOT/mesh-nightly.service' '$BED_NIGHTLY_ROOT/mesh-nightly.timer' ~/.config/systemd/user/; systemctl --user daemon-reload; systemctl --user enable --now mesh-nightly.timer; systemctl --user list-timers mesh-nightly.timer --no-pager"
