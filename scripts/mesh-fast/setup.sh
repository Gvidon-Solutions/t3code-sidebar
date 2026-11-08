#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
cd "$(dirname "$0")/../.."
command -v cc >/dev/null
cache=${MESH_FAST_MUTAGEN_CACHE:-/tmp/mesh-fast-tools-0.18.1}
mkdir -p "$cache"
scripts/mesh-fast/build-monitor.sh "$cache"
pnpm --dir apps/web -s build
export PLAYWRIGHT_BROWSERS_PATH="$cache/browsers"
pnpm --dir scripts exec playwright-core install chromium
for fixture in node bootstrap; do
  case "$fixture" in node) tag=26; file=Dockerfile;; bootstrap) tag=24; file=bootstrap.Dockerfile;; esac
  docker build -t "mesh-fast-$fixture:$tag" -f "scripts/mesh-fast/$file" scripts/mesh-fast
 done
