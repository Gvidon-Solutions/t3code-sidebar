#!/usr/bin/env bash
# SSH endpoint into only the test container; keys cannot execute on the VPS host.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
. "$(dirname "$0")/lib.sh"
if ! worker_ssh 'curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:13795/.well-known/t3/environment'; then
  "$MESH_DIR/tunnels.sh" up
fi
key="$STATE_DIR/round2-container"
ensure_local_key "$key" t3-mesh-e2e-round2-container
known=$(ssh-keygen -F "$CLOUDBOX_HOST" -f "$HOME/.local/share/vpn-ops/known_hosts")
if ! ssh-keygen -F "$CLOUDBOX_HOST" >/dev/null; then printf '%s\n' "$known" >> "$HOME/.ssh/known_hosts"; fi
printf '%s\n' "$known" | worker_ssh 'if ! ssh-keygen -F 152.89.244.57 >/dev/null; then cat >> ~/.ssh/known_hosts; fi'
pub=$(key_body "$(cat "$key.pub")")
cloudbox_ssh 'cat > /opt/t3-mesh-e2e/round2-ssh; chmod 700 /opt/t3-mesh-e2e/round2-ssh' <<'EOF'
#!/bin/sh
case "$SSH_ORIGINAL_COMMAND" in
  internal-sftp|*/sftp-server) exec docker exec -i t3-mesh-e2e /usr/lib/openssh/sftp-server ;;
  *) exec docker exec -i t3-mesh-e2e sh -c "$SSH_ORIGINAL_COMMAND" ;;
esac
EOF
line="restrict,command=\"/opt/t3-mesh-e2e/round2-ssh\" $pub t3-mesh-e2e-round2-container"
printf '%s\n' "$line" | cloudbox_ssh 'umask 077; cat > /opt/t3-mesh-e2e/round2-authorized-line; cp -p ~/.ssh/authorized_keys /opt/t3-mesh-e2e/authorized_keys.before-round2; { sed "/ t3-mesh-e2e-round2-container$/d" ~/.ssh/authorized_keys; cat /opt/t3-mesh-e2e/round2-authorized-line; } > /opt/t3-mesh-e2e/authorized_keys.round2; cat /opt/t3-mesh-e2e/authorized_keys.round2 > ~/.ssh/authorized_keys'
if ! cloudbox_ssh 'docker exec t3-mesh-e2e test -x /usr/lib/openssh/sftp-server'; then
  cloudbox_ssh 'docker exec -u 0 -i t3-mesh-e2e sh -s' <<'EOF'
set -eu
mkdir -p /tmp/round2-apt-cache/archives/partial
apt-get -o APT::Sandbox::User=root -o Dir::Cache=/tmp/round2-apt-cache update -qq
package=$(apt-cache show openssh-sftp-server | sed -n 's/^Filename: //p' | head -1)
curl -fsS "https://deb.debian.org/debian/$package" -o /tmp/round2-sftp.deb
expected=$(apt-cache show openssh-sftp-server | sed -n 's/^SHA256: //p' | head -1)
printf '%s  /tmp/round2-sftp.deb\n' "$expected" | sha256sum -c -
mkdir -p /usr/lib/openssh
dpkg-deb --fsys-tarfile /tmp/round2-sftp.deb | tar -xOf - ./usr/lib/openssh/sftp-server > /usr/lib/openssh/sftp-server
chmod 755 /usr/lib/openssh/sftp-server
rm /tmp/round2-sftp.deb
EOF
fi
# Settings reach stores the destination plus identity; no user SSH config edits.
worker_ssh 'mkdir -p ~/.local/share/t3-mesh-e2e'
worker_scp "$key" "$WORKER_HOST:.local/share/t3-mesh-e2e/round2-container"
printf 'Container key installed; use reach ssh=root@%s identityFile=%s\n' "$CLOUDBOX_HOST" "$key"

# Credentials are copied only into the isolated container home, never into logs.
if ! cloudbox_ssh 'test -s /opt/t3-mesh-e2e/home/.codex/auth.json'; then
  auth="${MESH_E2E_CODEX_AUTH:-$HOME/.codex/auth.json}"
  [ -s "$auth" ] || die "Codex auth fixture missing: $auth"
  cloudbox_ssh 'umask 077; mkdir -p /opt/t3-mesh-e2e/home/.codex; cat > /opt/t3-mesh-e2e/home/.codex/auth.json; chown -R 10001:10001 /opt/t3-mesh-e2e/home/.codex' < "$auth"
  cloudbox_ssh 'docker restart t3-mesh-e2e' >/dev/null
  wait_http "http://127.0.0.1:$CLOUDBOX_LOCAL/.well-known/t3/environment" 60
fi
