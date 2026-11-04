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

# Replica SSH keys and routes are reconciled by T3. Infrastructure tunnels use
# pre-existing administrator access; deploy never edits a user's authorized_keys.
vps_ssh "install -d -m 700 '$VPS_DIR' '$VPS_DATA'"

log "transferring image $IMAGE to the VPS"
docker save "$IMAGE" | gzip -1 | vps_ssh 'gunzip | docker load'
sed "s|image: t3-mesh-e2e:dev|image: $IMAGE|" "$MESH_DIR/compose.yaml" | vps_ssh "cat > '$VPS_DIR/compose.yaml'"

log "preserving VPS temporary project folders across container recreation"
vps_ssh 'bash -s' <<EOF
set -euo pipefail
install -d -m 1777 '$VPS_DIR/tmp'
if docker container inspect t3-mesh-e2e >/dev/null 2>&1; then
  docker exec t3-mesh-e2e sh -c 'printf "%s\\n" "$COMMIT" > /tmp/N-deploy-$COMMIT_SHORT'
  mounted=\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/tmp"}}{{.Source}}{{end}}{{end}}' t3-mesh-e2e)
  if [ "\$mounted" != '$VPS_DIR/tmp' ]; then
    docker stop t3-mesh-e2e >/dev/null
    docker cp -a t3-mesh-e2e:/tmp/. '$VPS_DIR/tmp/'
  fi
else
  printf '%s\n' '$COMMIT' > '$VPS_DIR/tmp/N-deploy-$COMMIT_SHORT'
fi
EOF

log "starting the VPS container"
vps_ssh "cd '$VPS_DIR' && docker compose up -d --force-recreate" >/dev/null
if ! vps_ssh "for i in \$(seq 1 60); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$VPS_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  vps_ssh "cd '$VPS_DIR' && docker compose logs --tail 60"
  die "VPS test server did not become healthy"
fi
vps_ssh "docker exec t3-mesh-e2e grep -Fx '$COMMIT' '/tmp/N-deploy-$COMMIT_SHORT'" >/dev/null

# ---------------------------------------------------------------------------
# 4. gor: retire the separate test server, back up userdata, then switch the
#    main t3code-sidebar.service to this build.
# ---------------------------------------------------------------------------
if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
log "retiring gor separate mesh test server (if present)"
gor_ssh 'bash -s' <<'EOF'
set -euo pipefail
systemctl --user disable --now t3-mesh-e2e.service >/dev/null 2>&1 || true
systemctl --user reset-failed t3-mesh-e2e.service >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/t3-mesh-e2e.service"
systemctl --user daemon-reload
EOF

fi

# The owner's real gor data: one pre-change tar, taken with the service
# stopped so SQLite and its WAL are consistent.
GOR_STOPPED=0
cleanup_gor() {
  if [ "$GOR_STOPPED" = 1 ]; then
    gor_ssh 'systemctl --user start t3code-sidebar.service' >/dev/null 2>&1 || true
    GOR_STOPPED=0
  fi
}
trap cleanup_gor EXIT

existing_backup="$(gor_ssh 'find "$HOME/.t3-sidebar-server" -maxdepth 1 -name "userdata.pre-mesh-e2e-*.tar.gz" -print -quit' || true)"
if [ -z "$existing_backup" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  log "backing up gor userdata before the first main-server change"
  gor_ssh 'systemctl --user stop t3code-sidebar.service'
  GOR_STOPPED=1
  gor_ssh "tar -C ~/.t3-sidebar-server -czf ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz userdata && tar -tzf ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz >/dev/null"
  gor_ssh "ls -lh ~/.t3-sidebar-server/userdata.pre-mesh-e2e-$ts.tar.gz"
else
  log "gor userdata backup already exists: $existing_backup"
fi

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

if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
log "installing mutagen on gor"
gor_ssh 'mkdir -p ~/.local/bin'
gor_scp "$HOME/.local/bin/mutagen" "$GOR_HOST:.local/bin/mutagen.install-$COMMIT_SHORT"
gor_scp "$HOME/.local/bin/mutagen-agents.tar.gz" "$GOR_HOST:.local/bin/mutagen-agents.install-$COMMIT_SHORT.tar.gz"
gor_ssh "chmod 755 ~/.local/bin/mutagen.install-$COMMIT_SHORT; mv -f ~/.local/bin/mutagen.install-$COMMIT_SHORT ~/.local/bin/mutagen; mv -f ~/.local/bin/mutagen-agents.install-$COMMIT_SHORT.tar.gz ~/.local/bin/mutagen-agents.tar.gz; ~/.local/bin/mutagen version"

log "updating gor t3ctl / staged t3-next skill"
"$REPO_ROOT/agent-kit/install.sh" --dest "$HOME/.agents/skills/t3-next"
gor_ssh 'mkdir -p ~/.agents/skills/t3-next/scripts'
for f in t3ctl.mjs server-runtime.mjs selftest.sh sidebar-workspaces-sync.mjs; do
  if [ -f "$HOME/.agents/skills/t3-next/scripts/$f" ]; then
    gor_scp "$HOME/.agents/skills/t3-next/scripts/$f" "$GOR_HOST:.agents/skills/t3-next/scripts/"
  fi
done
gor_ssh 'bash -s' <<'EOF'
set -euo pipefail
dir="$HOME/.agents/skills/t3-next/scripts"
chmod 755 "$dir/t3ctl.mjs" "$dir/selftest.sh"
[ -f "$dir/sidebar-workspaces-sync.mjs" ] && chmod 644 "$dir/sidebar-workspaces-sync.mjs"
f="$dir/t3ctl.mjs"
"$HOME/.nvm/versions/node/v23.11.1/bin/node" --check "$f" >/dev/null
EOF

log "preparing demo repo on gor"
gor_ssh 'bash -s' <<'EOF'
set -euo pipefail
repo="$HOME/xdev-e2e/demo"
seed_repo=0
mkdir -p "$repo/src" "$repo/scripts" "$repo/node_modules" "$repo/.venv"
if [ ! -d "$repo/.git" ]; then
  seed_repo=1
  git init -q "$repo"
  git -C "$repo" symbolic-ref HEAD refs/heads/main
fi
[ -f "$repo/README.md" ] || printf '# mesh e2e demo\n\nSource representation on gor.\n' >"$repo/README.md"
[ -f "$repo/src/main.txt" ] || printf 'hello from gor\n' >"$repo/src/main.txt"
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

log "allowing repeated fault-test starts on the gor bed unit"
gor_ssh "mkdir -p ~/.config/systemd/user/$GOR_UNIT.d; printf '[Unit]\nStartLimitIntervalSec=0\n' > ~/.config/systemd/user/$GOR_UNIT.d/90-mesh-e2e-faults.conf"
log "switching gor main unit $GOR_UNIT to $BUILD_VERSION"
current_ref="$(gor_ssh "grep -o 'runtime/versions/[^/]*' ~/.config/systemd/user/$GOR_UNIT | head -1" || true)"
if [ "$current_ref" != "runtime/versions/$BUILD_VERSION" ]; then
  if ! gor_ssh "test -n \"\$(find ~/.config/systemd/user -maxdepth 1 -name '$GOR_UNIT.bak-t3-mesh-e2e-*' -print -quit)\""; then
    gor_ssh "cp -p ~/.config/systemd/user/$GOR_UNIT ~/.config/systemd/user/$GOR_UNIT.bak-t3-mesh-e2e-\$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  gor_ssh "sed -i 's|^ExecStart=.*|ExecStart=%h/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3 serve --base-dir %h/.t3-sidebar-server --host 127.0.0.1 --port $GOR_PORT --no-browser|' ~/.config/systemd/user/$GOR_UNIT"
fi
gor_ssh "systemctl --user daemon-reload && systemctl --user reset-failed $GOR_UNIT && systemctl --user restart $GOR_UNIT" >/dev/null
GOR_STOPPED=0
if ! gor_ssh "for i in \$(seq 1 90); do curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$GOR_PORT/.well-known/t3/environment 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
  gor_ssh "journalctl --user -u $GOR_UNIT -n 80 --no-pager" || true
  die "gor main server did not become healthy on the new build"
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
install -d -m 700 "$GV_BASE_DIR/home" "$GV_BASE_DIR/home/.ssh"
node "$MESH_DIR/managed-sshd.mjs" "$GV_BASE_DIR/home" 22295
cat >"$HOME/.config/systemd/user/t3-mesh-e2e-gv-sshd.service" <<EOF
[Unit]
Description=Isolated mesh bed SSH daemon
[Service]
ExecStart=/usr/sbin/sshd -D -e -f $GV_BASE_DIR/home/sshd/sshd_config
Restart=on-failure
EOF
systemctl --user daemon-reload
systemctl --user restart t3-mesh-e2e-gv-sshd.service

mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/$GV_UNIT" <<EOF
[Unit]
Description=T3 Mesh E2E server on gvidon (isolated, base dir /tmp)
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h
UnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT
Environment=HOME=$GV_BASE_DIR/home
Environment=T3_MESH_SSH_HOME=$GV_BASE_DIR/home
Environment=T3_MESH_SSHD_DIR=$GV_BASE_DIR/home/sshd
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
if [ "${MESH_E2E_REUSE_NETWORK:-0}" != 1 ]; then
  log "bringing tunnels up"
  "$MESH_DIR/tunnels.sh" up
fi

log "deployed $BUILD_VERSION"
log "  gor   http://127.0.0.1:$GOR_PORT (gvidon view: 127.0.0.1:$GOR_LOCAL)"
log "  gv    http://127.0.0.1:$GV_PORT"
log "  vps   http://127.0.0.1:$VPS_PORT (gvidon view: 127.0.0.1:$VPS_LOCAL)"
