#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Tiny adb driver for the sidebar fork's Android e2e checks.

Finds views by text, content-description or resource id in a uiautomator
dump, so steps read like "tap 'Add environment'" instead of coordinates.

  droid.py tap TEXT [--exact]     tap the first view whose text/desc contains TEXT
  droid.py type TEXT              type into the focused field
  droid.py wait TEXT [SECONDS]    wait until TEXT is on screen (exit 1 on timeout)
  droid.py gone TEXT [SECONDS]    wait until TEXT is no longer on screen
  droid.py shot FILE              save a screenshot
  droid.py dump                   print visible texts with their bounds
  droid.py key NAME               press a key (BACK, ENTER, HOME, ...)
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = os.environ.get("ADB", os.path.expanduser("~/Android/Sdk/platform-tools/adb"))
SERIAL = os.environ.get("ANDROID_SERIAL")


def adb(*args: str, capture: bool = True) -> str:
    cmd = [ADB, *(["-s", SERIAL] if SERIAL else []), *args]
    return subprocess.run(cmd, check=True, capture_output=capture, text=True).stdout


def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = adb("exec-out", "cat", "/sdcard/ui.xml")
    for node in ET.fromstring(xml).iter("node"):
        bounds = re.findall(r"\d+", node.get("bounds", ""))
        if len(bounds) != 4:
            continue
        x1, y1, x2, y2 = map(int, bounds)
        labels = [node.get("text", ""), node.get("content-desc", ""), node.get("resource-id", "")]
        yield labels, ((x1 + x2) // 2, (y1 + y2) // 2), node


def find(text: str, exact: bool = False):
    for labels, center, node in nodes():
        if any((label == text) if exact else (text.lower() in label.lower()) for label in labels if label):
            return center, node
    return None


def main() -> int:
    command, *rest = sys.argv[1:] or ["help"]
    if command == "tap":
        exact = "--exact" in rest
        text = rest[0]
        deadline = time.time() + 15
        while (hit := find(text, exact)) is None:
            if time.time() > deadline:
                print(f"not found: {text}", file=sys.stderr)
                return 1
            time.sleep(0.7)
        (x, y), _ = hit
        adb("shell", "input", "tap", str(x), str(y))
        return 0
    if command == "type":
        adb("shell", "input", "text", rest[0].replace(" ", "%s"))
        return 0
    if command in ("wait", "gone"):
        text, seconds = rest[0], float(rest[1]) if len(rest) > 1 else 30
        deadline = time.time() + seconds
        while (find(text) is None) == (command == "wait"):
            if time.time() > deadline:
                print(f"timeout waiting for {command} {text}", file=sys.stderr)
                return 1
            time.sleep(1)
        return 0
    if command == "shot":
        with open(rest[0], "wb") as out:
            out.write(subprocess.run([ADB, "exec-out", "screencap", "-p"], check=True, capture_output=True).stdout)
        return 0
    if command == "dump":
        for labels, center, _ in nodes():
            shown = [label for label in labels if label]
            if shown:
                print(center, " | ".join(shown))
        return 0
    if command == "key":
        adb("shell", "input", "keyevent", f"KEYCODE_{rest[0].upper()}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
