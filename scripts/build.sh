#!/usr/bin/env bash
set -euo pipefail

# Build the GitHub Action as an ESM bundle using Vite/Rollup.
# All dependencies (@actions/core, @actions/github) are inlined.
# Only Node builtins are externalized.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PKG_DIR"

npx vite build --config vite.build.config.ts

echo "Build complete: dist/index.js ($(du -h dist/index.js | cut -f1) ESM bundle)"
