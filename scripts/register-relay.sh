#!/usr/bin/env bash

REGISTERED=$(claude mcp list 2>/dev/null | grep -c "matrix-relay" || true)
if [ "$REGISTERED" -gt 0 ]; then
  echo "matrix-relay already registered"
  exit 0
fi

BUN_PATH=$(which bun)
RELAY_PATH="$(pwd)/packages/matrix-relay"

CONFIG="{\"command\":\"$BUN_PATH\",\"args\":[\"run\",\"--cwd\",\"$RELAY_PATH\",\"--shell=bun\",\"--silent\",\"start\"]}"

claude mcp add-json --scope user matrix-relay "$CONFIG"
echo "matrix-relay registered"
