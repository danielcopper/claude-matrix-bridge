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
echo "  - Kill the dedicated tmux server (socket: claude-matrix-bridge)"
echo "  - Remove our session handoff hooks from ~/.claude/settings.json"
echo "  - Remove the matrix-relay MCP registration"
echo "  - Remove build artifacts and node_modules"
echo ""
echo "  It will NOT delete:"
echo "  - The git repository"
echo "  - The .env file"
echo "  - The SQLite database (data/bot.db)"
echo "  - Matrix rooms (those stay on your homeserver)"
echo "  - Your own hooks or any other ~/.claude/settings.json contents"
echo "  - Your normal tmux sessions (different socket)"
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

# --- tmux sessions (our dedicated socket) ---

if tmux -L claude-matrix-bridge kill-server 2>/dev/null; then
  info "Killed dedicated tmux server (socket: claude-matrix-bridge)"
fi

# --- Session handoff hooks ---

SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ] && command -v python3 >/dev/null 2>&1; then
  # Remove only our hooks, leave everything else intact
  SETTINGS_FILE="$SETTINGS_FILE" python3 - <<'PYEOF'
import json, os, sys
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"])
marker = "session-hook.sh"

try:
    settings = json.loads(settings_path.read_text())
except Exception:
    sys.exit(0)

hooks = settings.get("hooks")
if not hooks:
    sys.exit(0)

def strip_ours(hook_list):
    return [h for h in hook_list if marker not in json.dumps(h)]

changed = False
for event in ("SessionStart", "SessionEnd"):
    if event in hooks:
        filtered = strip_ours(hooks[event])
        if len(filtered) != len(hooks[event]):
            changed = True
            if filtered:
                hooks[event] = filtered
            else:
                del hooks[event]

if changed:
    if not hooks:
        settings.pop("hooks", None)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"[INFO] Removed bridge hooks from {settings_path}")
PYEOF
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
