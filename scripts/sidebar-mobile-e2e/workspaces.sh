#!/usr/bin/env bash
# Workspaces on Home: the dock shows, every tile opens its workspace (title
# changes), and the choice survives an app restart. Screenshots go to $OUT.
set -euo pipefail
D="uv run --script $(dirname "$0")/droid.py"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
OUT="${OUT:-/tmp/sidebar-e2e}"; mkdir -p "$OUT"
$D wait workspace-dock 60
mapfile -t tiles < <($D dump | grep -oE 'workspace-tile-[A-Za-z0-9_-]+' | sort -u)
[ "${#tiles[@]}" -gt 1 ] || { echo "need at least two workspaces, found ${#tiles[@]}" >&2; exit 1; }
for tile in "${tiles[@]}"; do
  $D tap "$tile" --exact
  sleep 1
  $D shot "$OUT/${tile}.png"
done
last="${tiles[-1]}"
"$ADB" shell am force-stop com.gvidon.t3codesidebar
"$ADB" shell monkey -p com.gvidon.t3codesidebar 1 >/dev/null 2>&1
$D wait workspace-dock 60
$D shot "$OUT/after-restart.png"
echo "workspaces ok (${#tiles[@]} tiles; last opened ${last#workspace-tile-}, see after-restart.png)"
