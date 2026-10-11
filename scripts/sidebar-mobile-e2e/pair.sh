#!/usr/bin/env bash
# Pairs the installed T3 Code Sidebar app with t3-ws through the emulator's
# host loopback (10.0.2.2 → the local tunnel on :3790). Needs a running
# emulator and `ssh -F ~/.local/share/vpn-ops/ssh_config` access to the VPS.
set -euo pipefail
D="uv run --script $(dirname "$0")/droid.py"
code=$(ssh -F ~/.local/share/vpn-ops/ssh_config 152.89.244.57 \
  'docker exec t3-ws node /opt/t3/dist/bin.mjs pair --ttl 10m --label sidebar-e2e' \
  | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
[ -n "$code" ] || { echo "no pairing token" >&2; exit 1; }
"${ADB:-$HOME/Android/Sdk/platform-tools/adb}" shell monkey -p com.gvidon.t3codesidebar 1 >/dev/null 2>&1
$D tap "Add environment"
$D tap "192.168.1.100:3773"
$D type "10.0.2.2:${T3_E2E_PORT:-3790}"
$D tap "Pairing code"
$D type "$code"
$D key ENTER
$D gone "Pairing code" 30
echo paired
