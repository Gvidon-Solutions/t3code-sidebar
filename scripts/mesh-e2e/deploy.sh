#!/usr/bin/env bash
# Deploy the artifacts from build.sh to worker, an isolated studio server, and the
# VPS container, then bring the tunnels up.
#
# Usage: deploy.sh
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_build_env
require_bins

# `from=` must match the source address the VPS sees, and worker's egress differs
# from studio's. Probe it, keeping the pinned defaults as a fallback.
STUDIO_PUBLIC_IP="${MESH_E2E_STUDIO_IP:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo "$STUDIO_PUBLIC_IP")}"
WORKER_PUBLIC_IP="${MESH_E2E_WORKER_IP:-$(worker_ssh 'curl -fsS --max-time 10 https://api.ipify.org' 2>/dev/null || echo "$WORKER_PUBLIC_IP")}"
log "egress IPs: studio $STUDIO_PUBLIC_IP, worker $WORKER_PUBLIC_IP"

log "VPS resources before deploy"
cloudbox_ssh 'set -e
  echo "host: $(hostname)"
  free -h | sed -n "1,2p"
  df -h /opt | tail -1
  echo "t3-ws container: $(docker ps --filter name=^t3-ws$ --format "{{.Status}}")"' || true

# Replica SSH keys and routes are reconciled by T3. Infrastructure tunnels use
# pre-existing administrator access; deploy never edits a user's authorized_keys.
cloudbox_ssh "install -d -m 700 '$CLOUDBOX_DIR' '$CLOUDBOX_DATA'"

log "transferring image $IMAGE to the VPS"
docker save "$IMAGE" | gzip -1 | cloudbox_ssh 'gunzip | docker load'
sed "s|image: t3-mesh-e2e:dev|image: $IMAGE|" "$MESH_DIR/compose.yaml" | cloudbox_ssh "cat > '$CLOUDBOX_DIR/compose.yaml'"

log "preserving VPS temporary project folders across container recreation"
cloudbox_ssh 'bash -s' <<EOF
set -euo pipefail
install -d -m 1777 '$CLOUDBOX_DIR/tmp' '$CLOUDBOX_DIR/var-tmp'
if docker container inspect t3-mesh-e2e >/dev/null 2>&1; then
  docker exec t3-mesh-e2e sh -c 'printf "%s\\n" "$COMMIT" > /tmp/N-deploy-$COMMIT_SHORT'
  mounted=\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/tmp"}}{{.Source}}{{end}}{{end}}' t3-mesh-e2e)
  var_mounted=\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/tmp"}}{{.Source}}{{end}}{{end}}' t3-mesh-e2e)
  if [ "\$mounted" != '$CLOUDBOX_DIR/tmp' ] || [ "\$var_mounted" != '$CLOUDBOX_DIR/var-tmp' ]; then
    docker stop t3-mesh-e2e >/dev/null
    if [ "\$mounted" != '$CLOUDBOX_DIR/tmp' ]; then docker cp -a t3-mesh-e2e:/tmp/. '$CLOUDBOX_DIR/tmp/'; fi
    if [ "\$var_mounted" != '$CLOUDBOX_DIR/var-tmp' ]; then docker cp -a t3-mesh-e2e:/var/tmp/. '$CLOUDBOX_DIR/var-tmp/'; fi
  fi
else
  printf '%s\n' '$COMMIT' > '$CLOUDBOX_DIR/tmp/N-deploy-$COMMIT_SHORT'
fi
EOF

log "starting the VPS container"
cloudbox_ssh "cd '$CLOUDBOX_DIR' && docker compose up -d --force-recreate" >/dev/null
if ! cloudbox_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$CLOUDBOX_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  cloudbox_ssh "cd '$CLOUDBOX_DIR' && docker compose logs --tail 60"
  die "VPS test server did not become healthy"
fi
cloudbox_ssh "docker exec t3-mesh-e2e grep -Fx '$COMMIT' '/tmp/N-deploy-$COMMIT_SHORT'" >/dev/null

# ---------------------------------------------------------------------------
# 4. worker: retire the separate test server, back up userdata, then switch the
#    main t3code-sidebar.service to this build.
# ---------------------------------------------------------------------------
if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
log "retiring worker separate mesh test server (if present)"
worker_ssh 'bash -s' <<'EOF'
set -euo pipefail
systemctl --user disable --now t3-mesh-e2e.service >/dev/null 2>&1 || true
systemctl --user reset-failed t3-mesh-e2e.service >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/t3-mesh-e2e.service"
systemctl --user daemon-reload
EOF

fi

# The owner's real worker data: one pre-change tar, taken with the service
# stopped so SQLite and its WAL are consistent.
WORKER_STOPPED=0
cleanup_gor() {
  if [ "$WORKER_STOPPED" = 1 ]; then
    worker_ssh 'systemctl --user start t3code-sidebar.service' >/dev/null 2>&1 || true
    WORKER_STOPPED=0
  fi
}
trap cleanup_gor EXIT

existing_backup="$(worker_ssh 'find "$HOME/.t3-sidebar-server" -maxdepth 1 -name "userdata.pre-mesh-e2e-*.tar.gz" -print -quit' || true)"
if [ -z "$existing_backup" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  log "backing up worker userdata before the first main-server change"
  worker_ssh 'systemctl --user stop t3code-sidebar.service'
  WORKER_STOPPED=1
  worker_ssh "tar -C ~/.t3-sidebar-server -czf ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz userdata && tar -tzf ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz >/dev/null"
  worker_ssh "ls -lh ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz"
else
  log "worker userdata backup already exists: $existing_backup"
fi

log "deploying runtime to worker"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
worker_scp "$ARCHIVE" "$WORKER_HOST:/tmp/$ARCHIVE_NAME"
worker_ssh 'bash -s' <<EOF
set -euo pipefail
dest='$WORKER_RUNTIME_ROOT/$BUILD_VERSION'
mkdir -p '$WORKER_RUNTIME_ROOT'
rm -rf "\$dest"
tmp=\$(mktemp -d)
tar -xzf '/tmp/$ARCHIVE_NAME' -C "\$tmp"
mv "\$tmp"/* "\$dest"
rm -rf "\$tmp" '/tmp/$ARCHIVE_NAME'
chmod +x "\$dest/t3"
EOF

if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
log "installing mutagen on worker"
worker_ssh 'mkdir -p ~/.local/bin'
worker_scp "$HOME/.local/bin/mutagen" "$WORKER_HOST:.local/bin/mutagen.install-$COMMIT_SHORT"
worker_scp "$HOME/.local/bin/mutagen-agents.tar.gz" "$WORKER_HOST:.local/bin/mutagen-agents.install-$COMMIT_SHORT.tar.gz"
worker_ssh "chmod 755 ~/.local/bin/mutagen.install-$COMMIT_SHORT; mv -f ~/.local/bin/mutagen.install-$COMMIT_SHORT ~/.local/bin/mutagen; mv -f ~/.local/bin/mutagen-agents.install-$COMMIT_SHORT.tar.gz ~/.local/bin/mutagen-agents.tar.gz; ~/.local/bin/mutagen version"

log "updating worker t3ctl / staged t3-next skill"
"$REPO_ROOT/agent-kit/install.sh" --dest "$HOME/.agents/skills/t3-next"
worker_ssh 'mkdir -p ~/.agents/skills/t3-next/scripts'
for f in t3ctl.mjs server-runtime.mjs selftest.sh sidebar-workspaces-sync.mjs; do
  if [ -f "$HOME/.agents/skills/t3-next/scripts/$f" ]; then
    worker_scp "$HOME/.agents/skills/t3-next/scripts/$f" "$WORKER_HOST:.agents/skills/t3-next/scripts/"
  fi
done
worker_ssh 'bash -s' <<'EOF'
set -euo pipefail
dir="$HOME/.agents/skills/t3-next/scripts"
chmod 755 "$dir/t3ctl.mjs" "$dir/selftest.sh"
[ -f "$dir/sidebar-workspaces-sync.mjs" ] && chmod 644 "$dir/sidebar-workspaces-sync.mjs"
f="$dir/t3ctl.mjs"
"$HOME/.nvm/versions/node/v23.11.1/bin/node" --check "$f" >/dev/null
EOF

log "preparing demo repo on worker"
worker_ssh 'bash -s' <<'EOF'
set -euo pipefail
repo="$HOME/xdev-e2e/demo"
seed_repo=0
mkdir -p "$repo/src" "$repo/scripts" "$repo/node_modules" "$repo/.venv"
if [ ! -d "$repo/.git" ]; then
  seed_repo=1
  git init -q "$repo"
  git -C "$repo" symbolic-ref HEAD refs/heads/main
fi
[ -f "$repo/README.md" ] || printf '# mesh e2e demo\n\nSource representation on worker.\n' >"$repo/README.md"
[ -f "$repo/src/main.txt" ] || printf 'hello from worker\n' >"$repo/src/main.txt"
[ -f "$repo/scripts/run.sh" ] || printf '#!/bin/sh\ncat src/main.txt\n' >"$repo/scripts/run.sh"
[ -f "$repo/.gitignore" ] || printf 'node_modules/\n.venv/\n' >"$repo/.gitignore"
[ -f "$repo/node_modules/x.js" ] || printf 'module.exports = 1;\n' >"$repo/node_modules/x.js"
[ -f "$repo/.venv/a" ] || printf 'venv marker\n' >"$repo/.venv/a"
chmod +x "$repo/scripts/run.sh"
if [ "$seed_repo" = 1 ]; then
  git -C "$repo" add -A
  if ! git -C "$repo" diff --cached --quiet; then
  git -C "$repo" -c user.name='T3 Mesh E2E' -c user.email='mesh-e2e@localhost' \
    commit -q -m 'mesh e2e demo seed'
  fi
fi
EOF

fi

log "allowing repeated fault-test starts on the worker bed unit"
worker_ssh "mkdir -p ~/.config/systemd/user/$WORKER_UNIT.d; printf '[Unit]\nStartLimitIntervalSec=0\n' > ~/.config/systemd/user/$WORKER_UNIT.d/90-mesh-e2e-faults.conf"
log "switching worker main unit $WORKER_UNIT to $BUILD_VERSION"
current_ref="$(worker_ssh "grep -o 'runtime/versions/[^/]*' ~/.config/systemd/user/$WORKER_UNIT | head -1" || true)"
if [ "$current_ref" != "runtime/versions/$BUILD_VERSION" ]; then
  if ! worker_ssh "test -n \"\$(find ~/.config/systemd/user -maxdepth 1 -name '$WORKER_UNIT.bak-t3-mesh-e2e-*' -print -quit)\""; then
    worker_ssh "cp -p ~/.config/systemd/user/$WORKER_UNIT ~/.config/systemd/user/$WORKER_UNIT.bak-t3-mesh-e2e-\$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  worker_ssh "sed -i 's|^ExecStart=.*|ExecStart=%h/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3 serve --base-dir %h/.t3-sidebar-server --host 127.0.0.1 --port $WORKER_PORT --no-browser|' ~/.config/systemd/user/$WORKER_UNIT"
fi
worker_ssh "systemctl --user daemon-reload && systemctl --user reset-failed $WORKER_UNIT && systemctl --user restart $WORKER_UNIT" >/dev/null
WORKER_STOPPED=0
if ! worker_ssh "for i in \$(seq 1 90); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$WORKER_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  worker_ssh "journalctl --user -u $WORKER_UNIT -n 80 --no-pager" || true
  die "worker main server did not become healthy on the new build"
fi

# ---------------------------------------------------------------------------
# 5. studio: runtime and systemd unit.
# ---------------------------------------------------------------------------
log "deploying runtime to studio"
rm -rf "$STUDIO_RUNTIME_ROOT/$BUILD_VERSION"
mkdir -p "$STUDIO_RUNTIME_ROOT"
cp -a "$RUNTIME_DIR" "$STUDIO_RUNTIME_ROOT/$BUILD_VERSION"
chmod +x "$STUDIO_RUNTIME_ROOT/$BUILD_VERSION/t3"
mkdir -p "$STUDIO_BASE_DIR"
install -d -m 700 "$STUDIO_BASE_DIR/home" "$STUDIO_BASE_DIR/home/.ssh"
node "$MESH_DIR/managed-sshd.mjs" "$STUDIO_BASE_DIR/home" 22295
cat >"$HOME/.config/systemd/user/$STUDIO_SSHD_UNIT" <<EOF
[Unit]
Description=Isolated mesh bed SSH daemon
[Service]
ExecStart=/usr/sbin/sshd -D -e -f $STUDIO_BASE_DIR/home/sshd/sshd_config
Restart=on-failure
EOF
systemctl --user daemon-reload
systemctl --user restart $STUDIO_SSHD_UNIT

mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/$STUDIO_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E server on studio (isolated, base dir /tmp)
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
Environment=HOME=$STUDIO_BASE_DIR/home
Environment=T3_MESH_SSH_HOME=$STUDIO_BASE_DIR/home
Environment=T3_MESH_SSHD_DIR=$STUDIO_BASE_DIR/home/sshd
ExecStart=$STUDIO_RUNTIME_ROOT/$BUILD_VERSION/t3 serve --base-dir $STUDIO_BASE_DIR --host 127.0.0.1 --port $STUDIO_PORT --no-browser
KillMode=mixed
Restart=on-failure
RestartSec=3
StandardOutput=append:$STUDIO_BASE_DIR/serve.log
StandardError=append:$STUDIO_BASE_DIR/serve.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$STUDIO_UNIT" >/dev/null
systemctl --user restart "$STUDIO_UNIT"
if ! wait_http "http://127.0.0.1:$STUDIO_PORT/.well-known/t3/environment" 60; then
  journalctl --user -u "$STUDIO_UNIT" -n 60 --no-pager || true
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
log "  worker   http://127.0.0.1:$WORKER_PORT (studio view: 127.0.0.1:$WORKER_LOCAL)"
log "  studio    http://127.0.0.1:$STUDIO_PORT"
log "  cloudbox   http://127.0.0.1:$CLOUDBOX_PORT (studio view: 127.0.0.1:$CLOUDBOX_LOCAL)"
