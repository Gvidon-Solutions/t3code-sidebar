#!/usr/bin/env bash
# Pairs the installed T3 Code Sidebar app with the configured bed server through
# the emulator's host loopback (10.0.2.2 -> the local tunnel port). Needs a
# running emulator and the bed SSH destination from scripts/mesh-e2e/local.env.
set -euo pipefail
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../mesh-e2e" && pwd)/local.env"
[ -f "$LOCAL_ENV" ] || { echo "Create $LOCAL_ENV from local.env.example" >&2; exit 1; }
. "$LOCAL_ENV"
: "${CLOUD_SSH_CONFIG:?Set CLOUD_SSH_CONFIG in local.env}"
: "${CLOUD_HOST:?Set CLOUD_HOST in local.env}"
D="uv run --script $(dirname "$0")/droid.py"
code=$(ssh -F "$CLOUD_SSH_CONFIG" "$CLOUD_HOST" \
  'docker exec t3-ws node /opt/t3/dist/bin.mjs pair --ttl 10m --label sidebar-e2e' \
  | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
[ -n "$code" ] || { echo "no pairing token" >&2; exit 1; }
"${ADB:-$HOME/Android/Sdk/platform-tools/adb}" shell monkey -p com.gvidon.t3codesidebar 1 >/dev/null 2>&1
$D tap "Add environment"
$D type "10.0.2.2:${T3_E2E_PORT:-3790}"
$D tap "Pairing code"
$D type "$code"
$D key ENTER
$D gone "Pairing code" 30
echo paired
