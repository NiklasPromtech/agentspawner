#!/usr/bin/env bash
# build-ext.sh — Reliable build script for the AgentSpawner Chrome extension.
#
# Usage:  ./build-ext.sh
#
# Why not 'npm run build'?  Vite/Rollup requires a native linux-arm64 binary
# that is absent in this sandbox.  This script uses build-ext.mjs which drives
# TypeScript's pure-JS compiler API instead — no native code needed.
#
# Idempotent: safe to re-run; dist/ is fully recreated each time.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building extension (ARM64-safe)..."
node "$DIR/build-ext.mjs"
echo "==> Build complete."
