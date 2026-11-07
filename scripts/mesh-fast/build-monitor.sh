#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
cache=${1:?tool cache required}
export RUSTUP_HOME="$cache/toolchain/rustup" CARGO_HOME="$cache/toolchain/cargo" RUSTUP_TOOLCHAIN=1.95.0
mkdir -p "$CARGO_HOME/bin"
if [ ! -f "$CARGO_HOME/bin/rustup" ]; then cp "$(command -v rustup)" "$CARGO_HOME/bin/rustup"; fi
for tool in cargo rustc rustdoc; do ln -sf rustup "$CARGO_HOME/bin/$tool"; done
export PATH="$CARGO_HOME/bin:$PATH"
if [ ! -x "$RUSTUP_HOME/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin/rustc" ]; then rustup toolchain install 1.95.0 --profile minimal; fi
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
