#!/usr/bin/env bash
# Chat swipes: opens the first thread on Home, swipes left through its file
# tabs until the Files panel slides in, walks back with the back key, then
# swipes right from the chat back to Home (a held drag shows Home underneath).
# Screenshots go to $OUT.
set -euo pipefail
D="uv run --script $(dirname "$0")/droid.py"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
OUT="${OUT:-/tmp/sidebar-e2e}"; mkdir -p "$OUT"
read -r width height < <("$ADB" shell wm size | grep -oE '[0-9]+x[0-9]+' | tail -1 | tr x ' ')
mid=$((height / 2)); from=$((width / 6)); to=$((width * 5 / 6))
swipe() { "$ADB" shell input swipe "$1" "$mid" "$2" "$mid" 250; sleep 1; }

$D wait workspace-dock 60
# First thread row under the first open folder.
folder_y=$($D dump | grep -v 'workspace-folder-new' | grep -m1 'workspace-folder-' | grep -oE '^\([0-9]+, [0-9]+' | cut -d' ' -f2)
"$ADB" shell input tap $((width / 2)) $((folder_y + 103))
$D wait thread-page-chat 10

# Left through the tabs (at most 8) to the Files panel past the last one.
for page in $(seq 1 9); do
  swipe "$to" "$from"
  if $D wait thread-panel-right 1 >/dev/null 2>&1; then break; fi
  $D shot "$OUT/swipe-page-$page.png"
done
$D wait thread-panel-right 2
$D shot "$OUT/swipe-files-panel.png"

# Back closes the panel, then (with tabs open) returns from the last tab to the chat.
"$ADB" shell input keyevent KEYCODE_BACK; sleep 1
$D gone thread-panel-right 5
if [ "$page" -gt 1 ]; then "$ADB" shell input keyevent KEYCODE_BACK; sleep 1; fi

# Hold a right drag halfway: Home shows underneath the chat.
"$ADB" shell input motionevent DOWN "$from" "$mid"
for x in $(seq "$from" 60 $((width / 2))); do "$ADB" shell input motionevent MOVE "$x" "$mid"; done
$D wait thread-home-underlay 3
$D shot "$OUT/swipe-home-underlay.png"
"$ADB" shell input motionevent MOVE "$to" "$mid"
"$ADB" shell input motionevent UP "$to" "$mid"
$D gone thread-page-chat 5
$D wait workspace-dock 5
echo "swipes ok"
