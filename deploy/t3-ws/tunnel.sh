#!/usr/bin/env bash
# Opens http://localhost:3790 -> t3-ws on the VPS (loopback only there).
set -euo pipefail
exec ssh -F "$HOME/.local/share/vpn-ops/ssh_config" -N \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3790:127.0.0.1:3790 152.89.244.57
