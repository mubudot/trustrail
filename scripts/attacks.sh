#!/usr/bin/env bash
# One offline command: build the test Wasm, exercise the contract, then run the Node attacks.
# Configure your Rust toolchain first, as described in docs/ATTACKS.md.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_NET_OFFLINE=true
mkdir -p .tmp
if ! bash scripts/build-wasm.sh > .tmp/attacks-build.log 2>&1; then
  cat .tmp/attacks-build.log
  exit 1
fi
(
  cd contract
  cargo test --offline --test attacks -- --nocapture --test-threads=1
)
(
  cd live
  npm run attacks
)
