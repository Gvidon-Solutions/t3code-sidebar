#!/usr/bin/env bash
# Deploy the artifacts from build.sh to gor, an isolated gvidon server, and the
# VPS container, then bring the tunnels up.
#
# Usage: deploy.sh
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_build_env
require_bins

# `from=` must match the source address the VPS sees, and gor's egress differs
# from gvidon's. Probe it, keeping the pinned defaults as a fallback.
GVIDON_PUBLIC_IP="${MESH_E2E_GVIDON_IP:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo "$GVIDON_PUBLIC_IP")}"
GOR_PUBLIC_IP="${MESH_E2E_GOR_IP:-$(gor_ssh 'curl -fsS --max-time 10 https://api.ipify.org' 2>/dev/null || echo "$GOR_PUBLIC_IP")}"
log "egress IPs: gvidon $GVIDON_PUBLIC_IP, gor $GOR_PUBLIC_IP"

log "VPS resources before deploy"
vps_ssh 'set -e
  echo "host: $(hostname)"
  free -h | sed -n "1,2p"
  df -h /opt | tail -1
  echo "t3-ws container: $(docker ps --filter name=^t3-ws$ --format "{{.Status}}")"' || true

# ---------------------------------------------------------------------------
# 1. Container keys (private half only on the VPS).
# ---------------------------------------------------------------------------
log "preparing VPS data dir and container SSH keys"
vps_ssh "set -e
  install -d -m 700 '$VPS_DIR'
  install -d -m 700 '$VPS_DATA'
  install -d -m 700 '$VPS_DATA/.ssh'
  [ -f '$CONTAINER_KEY_GOR' ] || ssh-keygen -q -t ed25519 -N '' -C t3-mesh-e2e-container-gor -f '$CONTAINER_KEY_GOR'
  [ -f '$CONTAINER_KEY_GV' ] || ssh-keygen -q -t ed25519 -N '' -C t3-mesh-e2e-container-gvidon -f '$CONTAINER_KEY_GV'
  chmod 600 '$CONTAINER_KEY_GOR' '$CONTAINER_KEY_GV'
  chmod 644 '$CONTAINER_KEY_GOR.pub' '$CONTAINER_KEY_GV.pub'
  chown 10001:10001 '$VPS_DATA'
  chown -R 10001:10001 '$VPS_DATA/.ssh'"

PUB_GOR="$(key_body "$(vps_ssh "cat '$CONTAINER_KEY_GOR.pub'")")"
PUB_GV="$(key_body "$(vps_ssh "cat '$CONTAINER_KEY_GV.pub'")")"

log "authorizing the container key on gor"
gor_ssh 'bash -s' <<EOF
set -euo pipefail
file="\$HOME/.ssh/authorized_keys"
mkdir -p "\$(dirname "\$file")"
touch "\$file"; chmod 600 "\$file"
cp -p "\$file" "\$file.bak-t3-mesh-e2e-\$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
tmp=\$(mktemp)
grep -vF ' t3-mesh-e2e-container-gor' "\$file" >"\$tmp" || true
printf '%s %s %s\n' 'from="127.0.0.1,::1",restrict' '$PUB_GOR' 't3-mesh-e2e-container-gor' >>"\$tmp"
cat "\$tmp" >"\$file"; rm -f "\$tmp"; chmod 600 "\$file"
EOF

log "authorizing the container key on gvidon"
authorize_line "$HOME/.ssh/authorized_keys" 'from="127.0.0.1,::1",restrict' \
  "$PUB_GV" t3-mesh-e2e-container-gvidon

# ---------------------------------------------------------------------------
# 2. Keys for the reverse tunnels and gvidon's loopback tunnel.
# ---------------------------------------------------------------------------
log "preparing reverse-tunnel keys"
ensure_local_key "$REVERSE_KEY_GV" t3-mesh-e2e-reverse-gvidon
gor_ssh 'bash -s' <<'EOF'
set -euo pipefail
key="$HOME/.ssh/id_t3_mesh_e2e_vps"
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C t3-mesh-e2e-reverse-gor -f "$key"
chmod 600 "$key"; chmod 644 "$key.pub"
EOF
PUB_REV_GOR="$(key_body "$(gor_ssh 'cat ~/.ssh/id_t3_mesh_e2e_vps.pub')")"
PUB_REV_GV="$(key_body "$(cat "$REVERSE_KEY_GV.pub")")"

log "authorizing the reverse-tunnel keys on the VPS"
vps_ssh 'bash -s' <<EOF
set -euo pipefail
file=/root/.ssh/authorized_keys
mkdir -p /root/.ssh
touch "\$file"; chmod 600 "\$file"
cp -p "\$file" "\$file.bak-t3-mesh-e2e-\$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
tmp=\$(mktemp)
grep -vF ' t3-mesh-e2e-reverse-' "\$file" >"\$tmp" || true
printf '%s %s %s\n' \
  'from="$GVIDON_PUBLIC_IP",restrict,port-forwarding,permitlisten="$VPS_BIND:$VPS_SSH_GV",permitlisten="$VPS_BIND:$GV_LOCAL"' \
  '$PUB_REV_GV' 't3-mesh-e2e-reverse-gvidon' >>"\$tmp"
printf '%s %s %s\n' \
  'from="$GOR_PUBLIC_IP",restrict,port-forwarding,permitlisten="$VPS_BIND:$VPS_SSH_GOR",permitlisten="$VPS_BIND:$GOR_LOCAL"' \
  '$PUB_REV_GOR' 't3-mesh-e2e-reverse-gor' >>"\$tmp"
cat "\$tmp" >"\$file"; rm -f "\$tmp"; chmod 600 "\$file"
EOF

log "preparing gvidon loopback tunnel key"
ensure_local_key "$SELF_KEY" t3-mesh-e2e-self
authorize_line "$HOME/.ssh/authorized_keys" 'from="127.0.0.1,::1",restrict,port-forwarding' \
  "$(key_body "$(cat "$SELF_KEY.pub")")" t3-mesh-e2e-self

# ---------------------------------------------------------------------------
# 3. VPS: container SSH config, image, compose.
# ---------------------------------------------------------------------------
log "writing container SSH config"
vps_ssh "cat > '$VPS_DATA/.ssh/config'" <<'EOF'
Host gor
  HostName 172.17.0.1
  Port 22022
  User user
  IdentityFile /home/t3/.ssh/id_mesh_gor
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile /home/t3/.ssh/known_hosts

Host gvidon
  HostName 172.17.0.1
  Port 22023
  User user
  IdentityFile /home/t3/.ssh/id_mesh_gvidon
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile /home/t3/.ssh/known_hosts
EOF
vps_ssh "chmod 600 '$VPS_DATA/.ssh/config'; chown 10001:10001 '$VPS_DATA/.ssh/config'; touch '$VPS_DATA/.ssh/known_hosts'; chmod 600 '$VPS_DATA/.ssh/known_hosts'; chown 10001:10001 '$VPS_DATA/.ssh/known_hosts'"

log "transferring image $IMAGE to the VPS"
docker save "$IMAGE" | gzip -1 | vps_ssh 'gunzip | docker load'
scp -q -F "$VPS_SSH_CONFIG" "$MESH_DIR/compose.yaml" "$VPS_HOST:$VPS_DIR/compose.yaml"

log "starting the VPS container"
vps_ssh "cd '$VPS_DIR' && docker compose up -d --force-recreate" >/dev/null
if ! vps_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$VPS_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  vps_ssh "cd '$VPS_DIR' && docker compose logs --tail 60"
  die "VPS test server did not become healthy"
fi

# ---------------------------------------------------------------------------
# 4. gor: runtime, mutagen, demo repo, systemd unit.
# ---------------------------------------------------------------------------
log "deploying runtime to gor"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
gor_scp "$ARCHIVE" "$GOR_HOST:/tmp/$ARCHIVE_NAME"
gor_ssh 'bash -s' <<EOF
set -euo pipefail
dest='$GOR_RUNTIME_ROOT/$BUILD_VERSION'
mkdir -p '$GOR_RUNTIME_ROOT'
rm -rf "\$dest"
tmp=\$(mktemp -d)
tar -xzf '/tmp/$ARCHIVE_NAME' -C "\$tmp"
mv "\$tmp"/* "\$dest"
rm -rf "\$tmp" '/tmp/$ARCHIVE_NAME'
chmod +x "\$dest/t3"
EOF

log "installing mutagen on gor"
gor_ssh 'mkdir -p ~/.local/bin'
gor_scp "$HOME/.local/bin/mutagen" "$GOR_HOST:.local/bin/mutagen"
gor_scp "$HOME/.local/bin/mutagen-agents.tar.gz" "$GOR_HOST:.local/bin/mutagen-agents.tar.gz"
gor_ssh 'chmod 755 ~/.local/bin/mutagen; ~/.local/bin/mutagen version'

log "preparing demo repo on gor"
gor_ssh 'bash -s' <<'EOF'
set -euo pipefail
repo="$HOME/xdev-e2e/demo"
mkdir -p "$repo/src" "$repo/scripts" "$repo/node_modules" "$repo/.venv"
if [ ! -d "$repo/.git" ]; then
  git init -q "$repo"
  git -C "$repo" symbolic-ref HEAD refs/heads/main
fi
[ -f "$repo/README.md" ] || printf '# mesh e2e demo\n\nSource representation on gor.\n' >"$repo/README.md"
[ -f "$repo/src/main.txt" ] || printf 'hello from gor\n' >"$repo/src/main.txt"
[ -f "$repo/scripts/run.sh" ] || printf '#!/bin/sh\ncat src/main.txt\n' >"$repo/scripts/run.sh"
[ -f "$repo/.gitignore" ] || printf 'node_modules/\n.venv/\n' >"$repo/.gitignore"
printf 'module.exports = 1;\n' >"$repo/node_modules/x.js"
printf 'venv marker\n' >"$repo/.venv/a"
chmod +x "$repo/scripts/run.sh"
git -C "$repo" add -A
if ! git -C "$repo" diff --cached --quiet; then
  git -C "$repo" -c user.name='T3 Mesh E2E' -c user.email='mesh-e2e@localhost' \
    commit -q -m 'mesh e2e demo seed'
fi
EOF

log "installing gor systemd unit"
gor_ssh "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/$GOR_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E server on gor (isolated from t3code-sidebar)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
ExecStart=%h/.t3-mesh-e2e/runtime/$BUILD_VERSION/t3 serve --base-dir %h/.t3-mesh-e2e --host 127.0.0.1 --port $GOR_PORT --no-browser
KillMode=mixed
Restart=on-failure
RestartSec=3
StandardOutput=append:%h/.t3-mesh-e2e/serve.log
StandardError=append:%h/.t3-mesh-e2e/serve.log

[Install]
WantedBy=default.target
EOF
gor_ssh "systemctl --user daemon-reload && systemctl --user enable --now $GOR_UNIT && systemctl --user restart $GOR_UNIT" >/dev/null
if ! gor_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$GOR_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  gor_ssh "journalctl --user -u $GOR_UNIT -n 60 --no-pager" || true
  die "gor test server did not become healthy"
fi

# ---------------------------------------------------------------------------
# 5. gvidon: runtime and systemd unit.
# ---------------------------------------------------------------------------
log "deploying runtime to gvidon"
rm -rf "$GV_RUNTIME_ROOT/$BUILD_VERSION"
mkdir -p "$GV_RUNTIME_ROOT"
cp -a "$RUNTIME_DIR" "$GV_RUNTIME_ROOT/$BUILD_VERSION"
chmod +x "$GV_RUNTIME_ROOT/$BUILD_VERSION/t3"
mkdir -p "$GV_BASE_DIR"

mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/$GV_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E server on gvidon (isolated, base dir /tmp)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
ExecStart=%h/.t3-mesh-e2e-gv-runtime/$BUILD_VERSION/t3 serve --base-dir $GV_BASE_DIR --host 127.0.0.1 --port $GV_PORT --no-browser
KillMode=mixed
Restart=on-failure
RestartSec=3
StandardOutput=append:$GV_BASE_DIR/serve.log
StandardError=append:$GV_BASE_DIR/serve.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$GV_UNIT" >/dev/null
systemctl --user restart "$GV_UNIT"
if ! wait_http "http://127.0.0.1:$GV_PORT/.well-known/t3/environment" 60; then
  journalctl --user -u "$GV_UNIT" -n 60 --no-pager || true
  die "gvidon test server did not become healthy"
fi

# ---------------------------------------------------------------------------
# 6. Tunnels.
# ---------------------------------------------------------------------------
log "bringing tunnels up"
"$MESH_DIR/tunnels.sh" up

log "deployed $BUILD_VERSION"
log "  gor   http://127.0.0.1:$GOR_PORT (gvidon view: 127.0.0.1:$GOR_LOCAL)"
log "  gv    http://127.0.0.1:$GV_PORT"
log "  vps   http://127.0.0.1:$VPS_PORT (gvidon view: 127.0.0.1:$VPS_LOCAL)"
