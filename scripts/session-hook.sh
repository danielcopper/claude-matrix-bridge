#!/usr/bin/env bash
# Claude Code hook for session handoff.
# Notifies the claude-matrix-bridge supervisor when a session is
# resumed locally or ended, enabling automatic Matrix ↔ terminal handoff.
#
# Fails silently if the supervisor is not running — Claude works normally.
#
# Usage (configured in ~/.claude/settings.json):
#   SessionStart (resume): session-hook.sh start
#   SessionEnd:            session-hook.sh end

# Skip if this session is managed by the supervisor (running inside tmux)
# Prevents infinite loop: supervisor resumes → hook fires → supervisor hands off → ...
if [ "$CMB_MANAGED" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
EVENT=${1:-start}
PORT=${CMB_API_PORT:-9090}

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

curl -s -X POST "http://127.0.0.1:${PORT}/api/session/${EVENT}" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"${SESSION_ID}\"}" \
  --connect-timeout 1 \
  --max-time 5 \
  > /dev/null 2>&1 \
  || true
