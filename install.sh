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

  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — please add the following hooks manually to $SETTINGS_FILE:"
    echo "  SessionStart (matcher 'resume'): $HOOK_SCRIPT start"
    echo "  SessionEnd:                      $HOOK_SCRIPT end"
  else
    # Non-destructive, idempotent hook installation.
    # - Preserves any existing hooks the user has configured.
    # - Won't add our hook twice if install.sh is run multiple times.
    # - Detects our hook by the 'session-hook.sh' marker in command strings.
    HOOK_SCRIPT="$HOOK_SCRIPT" SETTINGS_FILE="$SETTINGS_FILE" python3 - <<'PYEOF'
import json, os, sys
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"])
hook_script = os.environ["HOOK_SCRIPT"]
marker = "session-hook.sh"

# Load existing settings or start fresh
if settings_path.exists():
    try:
        settings = json.loads(settings_path.read_text())
    except Exception as e:
        print(f"[ERROR] Failed to parse {settings_path}: {e}", file=sys.stderr)
        print("[ERROR] Fix it manually before re-running install.sh", file=sys.stderr)
        sys.exit(1)
else:
    settings = {}

hooks = settings.setdefault("hooks", {})

def already_installed(hook_list):
    return any(marker in json.dumps(h) for h in hook_list)

changes = []

# SessionStart: matcher 'resume' (fires when user runs claude --resume)
session_start = hooks.setdefault("SessionStart", [])
if already_installed(session_start):
    print("[INFO] SessionStart hook already installed, skipping")
else:
    session_start.append({
        "matcher": "resume",
        "hooks": [{
            "type": "command",
            "command": f"{hook_script} start",
            "timeout": 5000,
        }],
    })
    changes.append("SessionStart")

# SessionEnd: any matcher (fires when claude process exits)
session_end = hooks.setdefault("SessionEnd", [])
if already_installed(session_end):
    print("[INFO] SessionEnd hook already installed, skipping")
else:
    session_end.append({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": f"{hook_script} end",
            "timeout": 5000,
        }],
    })
    changes.append("SessionEnd")

# Only write if we actually changed something
if changes:
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"[INFO] Added hooks to {settings_path}: {', '.join(changes)}")
else:
    print(f"[INFO] All hooks already present in {settings_path}")
PYEOF
    if [ $? -ne 0 ]; then
      error "Failed to update $SETTINGS_FILE"
    fi
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
