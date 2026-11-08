#!/usr/bin/env bash
umask 077
export MESH_FAST_ARTIFACTS_DIR=${MESH_FAST_ARTIFACTS_DIR:-/data/mf}
export MESH_FAST_MUTAGEN_CACHE=${MESH_FAST_MUTAGEN_CACHE:-$MESH_FAST_ARTIFACTS_DIR/tools}
state=${MESH_FAST_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/t3-mesh-fast}
mkdir -p "$state"
exec 9>"$state/host.lock"
if ! flock --nonblock 9; then
  printf 'Another mesh-fast command holds the host admission lock: %s\n' "$state/host.lock" >&2
  exit 75
fi
export MESH_FAST_HOST_LEASE_FD=9
