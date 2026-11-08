#!/usr/bin/env bash
# Build one ref of the fork into the artifacts the three test servers use:
#   * a linux-x64 T3 runtime archive (nodeB, isolated studio server)
#   * the t3-mesh-e2e Docker image (CLOUD)
#
# Usage: build.sh [ref]        (default: HEAD)
set -euo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

REF="${1:-HEAD}"
require_bins
command -v pnpm >/dev/null 2>&1 || die "pnpm not on PATH (export PATH=$NODE_B_NODE_BIN_DIR:\$PATH)"
command -v patchelf >/dev/null 2>&1 || die "patchelf is required to package the Linux runtime (sudo apt-get install patchelf)"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "${REF}^{commit}")"
COMMIT_SHORT="$(git -C "$REPO_ROOT" rev-parse --short=12 "$COMMIT")"

mkdir -p "$ARTIFACTS_DIR" "$STATE_DIR"

log "ref $REF -> $COMMIT"

if [ "${MESH_E2E_BUILD_CURRENT:-0}" = 1 ]; then
  COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  COMMIT_SHORT="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  BUILD_DIR="$REPO_ROOT"
  log "building current checkout $BUILD_DIR at $COMMIT (requested ref: $REF)"
elif [ -d "$BUILD_DIR/.git" ] || [ -f "$BUILD_DIR/.git" ]; then
  log "updating build worktree $BUILD_DIR"
  git -C "$BUILD_DIR" checkout --force --detach "$COMMIT"
  git -C "$BUILD_DIR" clean -ffdx \
    -e node_modules -e .t3 \
    -e apps/web/dist -e apps/server/dist -e apps/server/dist-exe \
    -e native/resource-monitor/target >/dev/null
else
  log "creating build worktree $BUILD_DIR"
  mkdir -p "$(dirname "$BUILD_DIR")"
  git -C "$REPO_ROOT" worktree add --detach --force "$BUILD_DIR" "$COMMIT"
fi

export PATH="${NODE_A_NODE_BIN_DIR:?}:$BUILD_DIR/node_modules/.bin:$BUILD_DIR/apps/server/node_modules/.bin:$PATH"
export CI=1

log "installing workspace"
(cd "$BUILD_DIR" && pnpm install --frozen-lockfile)

log "building web client"
(cd "$BUILD_DIR" && pnpm --filter @t3tools/web run build)

log "building server bundle + client"
(cd "$BUILD_DIR" && node apps/server/scripts/cli.ts build)

log "building server single-executable (node $(node -v))"
(cd "$BUILD_DIR" && node apps/server/scripts/cli.ts build-exe)

log "building resource monitor"
mkdir -p "$ARTIFACTS_DIR/resource-monitor/linux-x64"
CARGO=(cargo)
if command -v rustup >/dev/null 2>&1; then
  newest_tc="$(rustup toolchain list 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1 || true)"
  [ -n "$newest_tc" ] && CARGO=(cargo "+$newest_tc")
fi
(cd "$BUILD_DIR" && "${CARGO[@]}" build --locked --release --manifest-path native/resource-monitor/Cargo.toml)
cp "${CARGO_TARGET_DIR:-$BUILD_DIR/native/resource-monitor/target}/release/t3-resource-monitor" \
  "$ARTIFACTS_DIR/resource-monitor/linux-x64/t3-resource-monitor"

SERVER_VERSION="$(jq -r .version "$BUILD_DIR/apps/server/package.json")"
BUILD_VERSION="${SERVER_VERSION}-mesh.${COMMIT_SHORT}"
ARCHIVE="$ARTIFACTS_DIR/releases/t3-${BUILD_VERSION}-linux-x64.tar.gz"
RUNTIME_DIR="$ARTIFACTS_DIR/runtime/$BUILD_VERSION"

log "packaging runtime $BUILD_VERSION"
rm -f "$ARCHIVE"
(cd "$BUILD_DIR" && node scripts/build-cli-archive.ts \
  --platform linux --arch x64 --version "$BUILD_VERSION" \
  --resource-monitor-dir "$ARTIFACTS_DIR/resource-monitor" \
  --output-dir "$ARTIFACTS_DIR/releases")

rm -rf "$RUNTIME_DIR"
mkdir -p "$(dirname "$RUNTIME_DIR")"
tmp="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$tmp"
top="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
mv "$top" "$RUNTIME_DIR"
rm -rf "$tmp"
chmod +x "$RUNTIME_DIR/t3"

log "building Docker image $IMAGE"
DOCKER_BUILDKIT=1 docker build \
  -f "$MESH_DIR/Dockerfile" \
  --build-arg "MUTAGEN_VERSION=$MUTAGEN_VERSION" \
  --build-arg "MUTAGEN_SHA256=$MUTAGEN_SHA256" \
  -t "$IMAGE" "$BUILD_DIR"

cat >"$BUILD_ENV" <<EOF
REF='$REF'
COMMIT='$COMMIT'
COMMIT_SHORT='$COMMIT_SHORT'
BUILD_VERSION='$BUILD_VERSION'
ARCHIVE='$ARCHIVE'
RUNTIME_DIR='$RUNTIME_DIR'
IMAGE='$IMAGE'
BUILT_AT='$(date -u +%Y-%m-%dT%H:%M:%SZ)'
EOF

log "done: $BUILD_VERSION"
log "  archive: $ARCHIVE"
log "  runtime: $RUNTIME_DIR"
log "  image:   $IMAGE"
