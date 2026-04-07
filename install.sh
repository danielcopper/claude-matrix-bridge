#!/usr/bin/env bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Prerequisites ---

info "Checking prerequisites..."

command -v mise >/dev/null 2>&1 || error "mise not found. Install from https://mise.jdx.dev"
command -v tmux >/dev/null 2>&1 || error "tmux not found. Install tmux"
command -v claude >/dev/null 2>&1 || error "claude not found. Install Claude Code CLI from https://claude.ai/download"

info "Prerequisites OK"

# --- sudo early ---

info "Requesting sudo access for systemd..."
sudo -v || error "sudo required for systemd installation"

# --- Install tools + deps + build ---

info "Running mise setup..."
cd "$REPO_DIR"
mise trust
mise install
mise run setup || error "Setup failed. Fix the errors above and re-run."

# --- systemd ---

NODE_PATH=$(mise which node)
CURRENT_USER=$(whoami)
USER_PATH=$(echo "$PATH")

sudo tee /etc/systemd/system/claude-matrix-bridge.service > /dev/null <<EOF
[Unit]
Description=Claude Matrix Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$REPO_DIR/packages/supervisor
ExecStart=$NODE_PATH dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=$USER_PATH
Environment=HOME=/home/$CURRENT_USER
EnvironmentFile=$REPO_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now claude-matrix-bridge
info "systemd service installed and started"

# --- Session handoff hooks (optional) ---

echo ""
read -rp "Install Claude hooks for automatic session handoff (Matrix ↔ terminal)? [y/N] " INSTALL_HOOKS

if [[ "$INSTALL_HOOKS" =~ ^[Yy]$ ]]; then
  HOOK_SCRIPT="$REPO_DIR/scripts/session-hook.sh"
  SETTINGS_FILE="$HOME/.claude/settings.json"

  mkdir -p "$(dirname "$SETTINGS_FILE")"

  if [ -f "$SETTINGS_FILE" ]; then
    # Merge hooks into existing settings
    if command -v python3 >/dev/null 2>&1; then
      python3 -c "
import json, sys
try:
    with open('$SETTINGS_FILE') as f:
        settings = json.load(f)
except:
    settings = {}
hooks = settings.setdefault('hooks', {})
hooks['SessionStart'] = [{'matcher': 'resume', 'hooks': [{'type': 'command', 'command': '$HOOK_SCRIPT start', 'timeout': 5000}]}]
hooks['SessionEnd'] = [{'matcher': '', 'hooks': [{'type': 'command', 'command': '$HOOK_SCRIPT end', 'timeout': 5000}]}]
with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
"
      info "Hooks added to $SETTINGS_FILE"
    else
      warn "python3 not found — add hooks manually to $SETTINGS_FILE"
    fi
  else
    cat > "$SETTINGS_FILE" <<HOOKS
{
  "hooks": {
    "SessionStart": [{"matcher": "resume", "hooks": [{"type": "command", "command": "$HOOK_SCRIPT start", "timeout": 5000}]}],
    "SessionEnd": [{"matcher": "", "hooks": [{"type": "command", "command": "$HOOK_SCRIPT end", "timeout": 5000}]}]
  }
}
HOOKS
    info "Created $SETTINGS_FILE with hooks"
  fi
else
  info "Skipping hooks. You can add them later — see README."
fi

# --- Done ---

echo ""
info "Installation complete!"
echo ""
echo "  Logs:    journalctl -u claude-matrix-bridge -f"
echo "  Stop:    sudo systemctl stop claude-matrix-bridge"
echo "  Restart: sudo systemctl restart claude-matrix-bridge"
echo "  Dev:     mise run dev"
echo ""
