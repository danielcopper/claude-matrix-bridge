#!/usr/bin/env bash
# Register the matrix-relay MCP server with Claude Code (user scope).
#
# Resolves the relay path relative to this script's location, so it
# works from any checkout (main, worktree, different machine).
# Safe to run repeatedly — re-registers if the path changed.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_PATH="$REPO_DIR/packages/matrix-relay"

if [ ! -d "$RELAY_PATH" ]; then
  echo "[ERROR] matrix-relay not found at $RELAY_PATH" >&2
  exit 1
fi

# Find bun via mise (preferred) or PATH
BUN_PATH=$(mise which bun 2>/dev/null || which bun 2>/dev/null) || {
  echo "[ERROR] bun not found. Run 'mise install' first." >&2
  exit 1
}

CONFIG="{\"command\":\"$BUN_PATH\",\"args\":[\"run\",\"--cwd\",\"$RELAY_PATH\",\"--shell=bun\",\"--silent\",\"start\"]}"

# Check if already registered with the correct path
CURRENT=$(claude mcp list 2>/dev/null || true)
if echo "$CURRENT" | grep -q "matrix-relay" && echo "$CURRENT" | grep -q "$RELAY_PATH"; then
  echo "[INFO] matrix-relay already registered at $RELAY_PATH"
  exit 0
fi

# Remove stale registration if present (path changed)
if echo "$CURRENT" | grep -q "matrix-relay"; then
  echo "[INFO] Updating matrix-relay registration"
  claude mcp remove --scope user matrix-relay 2>/dev/null || true
fi

claude mcp add-json --scope user matrix-relay "$CONFIG"
echo "[INFO] matrix-relay registered at $RELAY_PATH"
