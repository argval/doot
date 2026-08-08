#!/usr/bin/env bash
# Start the caption gateway and the Doot desktop app together.
# Ctrl+C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies…"
  npm install
fi

echo "Starting gateway (ws://127.0.0.1:8787) and Doot desktop…"
exec npm run dev
