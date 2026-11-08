#!/usr/bin/env bash
# Deploy the artifacts from build.sh to nodeB, an isolated studio server, and the
# CLOUD container, then bring the tunnels up.
#
# Usage: deploy.sh
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_build_env
require_bins

log "CLOUD resources before deploy"
cloud_ssh 'set -e
  echo "host: $(hostname)"
  free -h | sed -n "1,2p"
  df -h /opt | tail -1
  echo "t3-ws container: $(docker ps --filter name=^t3-ws$ --format "{{.Status}}")"' || true

# Replica SSH keys and routes are reconciled by T3. Infrastructure tunnels use
# pre-existing administrator access; deploy never edits a user's authorized_keys.
cloud_ssh "install -d -m 700 '$CLOUD_DIR' '$CLOUD_DATA'"

log "transferring image $IMAGE to the CLOUD"
docker save "$IMAGE" | gzip -1 | cloud_ssh 'gunzip | docker load'
sed "s|t3-mesh-e2e:dev|$IMAGE|" "${MESH_E2E_COMPOSE_TEMPLATE:-$MESH_DIR/compose.yaml}" | cloud_ssh "cat > '$CLOUD_DIR/compose.yaml'"

log "preserving CLOUD temporary project folders across container recreation"
cloud_ssh 'bash -s' <<EOF
set -euo pipefail
install -d -m 1777 '$CLOUD_DIR/tmp' '$CLOUD_DIR/var-tmp'
if docker container inspect t3-mesh-e2e >/dev/null 2>&1; then
  if [ "\$(docker inspect -f '{{.State.Running}}' t3-mesh-e2e)" = true ]; then
    docker exec t3-mesh-e2e sh -c 'printf "%s\\n" "$COMMIT" > /tmp/N-deploy-$COMMIT_SHORT'
  else
    printf '%s\n' '$COMMIT' > '$CLOUD_DIR/tmp/N-deploy-$COMMIT_SHORT'
  fi
  mounted=\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/tmp"}}{{.Source}}{{end}}{{end}}' t3-mesh-e2e)
  var_mounted=\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/tmp"}}{{.Source}}{{end}}{{end}}' t3-mesh-e2e)
  if [ "\$mounted" != '$CLOUD_DIR/tmp' ] || [ "\$var_mounted" != '$CLOUD_DIR/var-tmp' ]; then
    docker stop t3-mesh-e2e >/dev/null
    if [ "\$mounted" != '$CLOUD_DIR/tmp' ]; then docker cp -a t3-mesh-e2e:/tmp/. '$CLOUD_DIR/tmp/'; fi
    if [ "\$var_mounted" != '$CLOUD_DIR/var-tmp' ]; then docker cp -a t3-mesh-e2e:/var/tmp/. '$CLOUD_DIR/var-tmp/'; fi
  fi
else
  printf '%s\n' '$COMMIT' > '$CLOUD_DIR/tmp/N-deploy-$COMMIT_SHORT'
fi
EOF

log "starting the CLOUD container"
cloud_ssh "cd '$CLOUD_DIR' && docker compose up -d --force-recreate" >/dev/null
if ! cloud_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$CLOUD_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  cloud_ssh "cd '$CLOUD_DIR' && docker compose logs --tail 60"
  die "CLOUD test server did not become healthy"
fi
cloud_ssh "docker exec t3-mesh-e2e grep -Fx '$COMMIT' '/tmp/N-deploy-$COMMIT_SHORT'" >/dev/null

# nodeB runs only the disposable bed unit and sandbox home.
log "deploying isolated runtime to nodeB"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
nodeB_scp "$ARCHIVE" "$NODE_B_HOST:/tmp/$ARCHIVE_NAME"
nodeB_ssh "mkdir -p '$NODE_B_STATE_DIR'"
nodeB_scp "$MESH_DIR/managed-sshd.mjs" "$NODE_B_HOST:$NODE_B_STATE_DIR/managed-sshd.mjs"
nodeB_ssh 'bash -s' <<EOF
set -euo pipefail
dest='$NODE_B_RUNTIME_ROOT/$BUILD_VERSION'
mkdir -p '$NODE_B_RUNTIME_ROOT' '$NODE_B_BASE_DIR/home' '$NODE_B_STATE_DIR/ssh'
tmp=\$(mktemp -d)
tar -xzf '/tmp/$ARCHIVE_NAME' -C "\$tmp"
if [ ! -d "\$dest" ]; then mv "\$tmp"/* "\$dest"; fi
rm -rf "\$tmp" '/tmp/$ARCHIVE_NAME'
chmod +x "\$dest/t3"
mkdir -p '$NODE_B_DEMO_DIR/src'
if [ ! -d '$NODE_B_DEMO_DIR/.git' ]; then
  git init -q '$NODE_B_DEMO_DIR'
  printf 'mesh fixture\n' > '$NODE_B_DEMO_DIR/README.md'
  git -C '$NODE_B_DEMO_DIR' add README.md
  git -C '$NODE_B_DEMO_DIR' -c user.name='Mesh fixture' -c user.email='fixture@example.test' commit -qm 'seed fixture'
fi
'$NODE_B_NODE_BIN_DIR/node' '$NODE_B_STATE_DIR/managed-sshd.mjs' '$NODE_B_BASE_DIR/home' '$NODE_B_SSHD_PORT'
mkdir -p "\$HOME/.config/systemd/user"
cat > "\$HOME/.config/systemd/user/$NODE_B_UNIT" <<'UNIT'
[Unit]
Description=Isolated T3 mesh bed nodeB
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=$NODE_B_STATE_DIR
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
Environment=HOME=$NODE_B_BASE_DIR/home
Environment=T3_MESH_AGENT_HOME=$NODE_B_BASE_DIR/home
Environment=T3_MESH_SSH_HOME=$NODE_B_BASE_DIR/home
Environment=T3_MESH_SSHD_DIR=$NODE_B_BASE_DIR/home/sshd
ExecStart=$NODE_B_RUNTIME_ROOT/$BUILD_VERSION/t3 serve --base-dir $NODE_B_BASE_DIR --host 127.0.0.1 --port $NODE_B_PORT --no-browser
KillMode=mixed
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
cat > "\$HOME/.config/systemd/user/${NODE_B_UNIT%.service}-sshd.service" <<'UNIT'
[Unit]
Description=Isolated mesh bed SSH daemon
[Service]
ExecStart=/usr/sbin/sshd -D -e -f $NODE_B_BASE_DIR/home/sshd/sshd_config
Restart=on-failure
UNIT
systemctl --user daemon-reload
systemctl --user restart '${NODE_B_UNIT%.service}-sshd.service' '$NODE_B_UNIT'
EOF
if ! nodeB_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$NODE_B_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  die "nodeB test server did not become healthy"
fi

# ---------------------------------------------------------------------------
# 5. studio: runtime and systemd unit.
# ---------------------------------------------------------------------------
log "deploying runtime to studio"
rm -rf "$NODE_A_RUNTIME_ROOT/$BUILD_VERSION"
mkdir -p "$NODE_A_RUNTIME_ROOT"
cp -a "$RUNTIME_DIR" "$NODE_A_RUNTIME_ROOT/$BUILD_VERSION"
chmod +x "$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3"
mkdir -p "$NODE_A_BASE_DIR"
install -d -m 700 "$NODE_A_BASE_DIR/home" "$NODE_A_BASE_DIR/home/.ssh"
node "$MESH_DIR/managed-sshd.mjs" "$NODE_A_BASE_DIR/home" $NODE_A_SSHD_PORT
mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/${NODE_A_UNIT%.service}-sshd.service" <<EOF
[Unit]
Description=Isolated mesh bed SSH daemon
[Service]
ExecStart=/usr/sbin/sshd -D -e -f $NODE_A_BASE_DIR/home/sshd/sshd_config
Restart=on-failure
EOF
systemctl --user daemon-reload
systemctl --user restart ${NODE_A_UNIT%.service}-sshd.service

mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/$NODE_A_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E server on studio (isolated, base dir /tmp)
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
Environment=HOME=$NODE_A_BASE_DIR/home
Environment=T3_MESH_AGENT_HOME=$NODE_A_BASE_DIR/home
Environment=T3_MESH_SSH_HOME=$NODE_A_BASE_DIR/home
Environment=T3_MESH_SSHD_DIR=$NODE_A_BASE_DIR/home/sshd
ExecStart=$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3 serve --base-dir $NODE_A_BASE_DIR --host 127.0.0.1 --port $NODE_A_PORT --no-browser
KillMode=mixed
Restart=on-failure
RestartSec=3
StandardOutput=append:$NODE_A_BASE_DIR/serve.log
StandardError=append:$NODE_A_BASE_DIR/serve.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$NODE_A_UNIT" >/dev/null
systemctl --user restart "$NODE_A_UNIT"
if ! wait_http "http://127.0.0.1:$NODE_A_PORT/.well-known/t3/environment" 60; then
  journalctl --user -u "$NODE_A_UNIT" -n 60 --no-pager || true
  die "studio test server did not become healthy"
fi

# ---------------------------------------------------------------------------
# 6. Tunnels.
# ---------------------------------------------------------------------------
if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
  log "bringing tunnels up"
  "$MESH_DIR/tunnels.sh" up
fi

log "deployed $BUILD_VERSION"
log "  nodeB   http://127.0.0.1:$NODE_B_PORT (studio view: 127.0.0.1:$NODE_B_LOCAL)"
log "  nodeA    http://127.0.0.1:$NODE_A_PORT"
log "  cloud   http://127.0.0.1:$CLOUD_PORT (studio view: 127.0.0.1:$CLOUD_LOCAL)"
