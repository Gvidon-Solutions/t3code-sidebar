#!/usr/bin/env bash
# Builds the t3-ws image on this machine, ships it to the VPS and recreates the
# container. Usage: deploy/t3-ws/deploy.sh [--no-build] [--workspaces file.json]
set -euo pipefail
cd "$(dirname "$0")/../.."
CFG="$HOME/.local/share/vpn-ops/ssh_config"
HOST=152.89.244.57
export DOCKER_CONTEXT=default DOCKER_CONFIG="$HOME/.local/share/t3-ws/docker-config"

build=1
workspaces=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0 ;;
    --workspaces) workspaces="$2"; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$build" = 1 ]; then
  docker build -f deploy/t3-ws/Dockerfile -t t3-ws:dev .
fi
docker save t3-ws:dev | gzip -1 | ssh -F "$CFG" "$HOST" 'gunzip | docker load'

if [ -n "$workspaces" ]; then
  scp -q -F "$CFG" "$workspaces" "$HOST:/opt/t3-ws/sidebar-workspaces.json"
fi

ssh -F "$CFG" "$HOST" 'set -e
cd /opt/t3-ws
if [ -f sidebar-workspaces.json ]; then
  docker compose stop t3 >/dev/null 2>&1 || true
  cp home/.t3/userdata/settings.json "settings.backup-$(date -u +%Y%m%dT%H%M%SZ).json"
  docker run --rm -v /opt/t3-ws:/w -w /w --entrypoint sh t3-ws:dev -c \
    "jq --slurpfile ws sidebar-workspaces.json \".sidebarWorkspaces = \\\$ws[0]\" home/.t3/userdata/settings.json > /tmp/s.json && cat /tmp/s.json > home/.t3/userdata/settings.json"
  rm sidebar-workspaces.json
fi
docker compose up -d --force-recreate 2>&1 | tail -2
for i in $(seq 1 30); do curl -sf --max-time 2 -o /dev/null http://127.0.0.1:3790/ && break; sleep 1; done
docker ps --filter name=t3-ws --format "{{.Names}} {{.Status}} {{.Ports}}"
docker image prune -f >/dev/null'
