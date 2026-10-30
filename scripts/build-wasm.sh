#!/usr/bin/env bash
# Build the contract Wasm modules used by the integration tests and for deployment.
#   build/agent_spend_guard.wasm  — the guard (deployable)
#   build/mock_registry.wasm      — TEST-ONLY CIS-2 registry stand-in (never deploy)
# Prefers `cargo concordium build` (embeds the schema) when installed; falls back to plain cargo.
set -euo pipefail
cd "$(dirname "$0")/../contract"
mkdir -p ../build
if cargo concordium --version >/dev/null 2>&1; then
  cargo concordium build --schema-embed --out ../build/agent_spend_guard.wasm.v1
fi
cargo build --quiet --locked --target wasm32v1-none --release --lib
cp target/wasm32v1-none/release/agent_spend_guard.wasm ../build/agent_spend_guard.wasm
cargo build --quiet --locked --target wasm32v1-none --release --lib \
  --features mock-registry --target-dir target/mock
cp target/mock/wasm32v1-none/release/agent_spend_guard.wasm ../build/mock_registry.wasm
ls -l ../build/*.wasm*
