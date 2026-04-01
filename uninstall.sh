#!/usr/bin/env bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "This will:"
echo "  - Stop and remove the systemd service"
echo "  - Kill all Claude tmux sessions"
echo "  - Remove the matrix-relay MCP registration"
echo "  - Remove build artifacts and node_modules"
echo ""
echo "  It will NOT delete:"
echo "  - The git repository"
echo "  - The .env file"
echo "  - The SQLite database (data/bot.db)"
echo "  - Matrix rooms (those stay on your homeserver)"
echo ""
read -rp "Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || exit 0

# --- systemd ---

if systemctl is-active claude-matrix-bridge >/dev/null 2>&1; then
  info "Stopping service..."
  sudo systemctl stop claude-matrix-bridge
fi

if [ -f /etc/systemd/system/claude-matrix-bridge.service ]; then
  info "Removing systemd service..."
  sudo systemctl disable claude-matrix-bridge 2>/dev/null
  sudo rm /etc/systemd/system/claude-matrix-bridge.service
  sudo systemctl daemon-reload
fi

# --- tmux sessions ---

CLAUDE_SESSIONS=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^claude-' || true)
if [ -n "$CLAUDE_SESSIONS" ]; then
  info "Killing Claude tmux sessions..."
  echo "$CLAUDE_SESSIONS" | while read -r name; do
    tmux kill-session -t "$name" 2>/dev/null
    info "  Killed $name"
  done
fi

# --- MCP registration ---

if claude mcp list 2>/dev/null | grep -q "matrix-relay"; then
  info "Removing matrix-relay MCP registration..."
  claude mcp remove --scope user matrix-relay 2>/dev/null
fi

# --- Build artifacts ---

info "Removing build artifacts..."
rm -rf "$REPO_DIR/packages/supervisor/dist"
rm -rf "$REPO_DIR/packages/supervisor/node_modules"
rm -rf "$REPO_DIR/packages/matrix-relay/node_modules"

echo ""
info "Uninstall complete."
echo ""
echo "  Kept: .env, data/bot.db, Matrix rooms"
echo "  To fully clean: rm -rf $REPO_DIR"
echo ""
