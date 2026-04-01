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

# --- Done ---

echo ""
info "Installation complete!"
echo ""
echo "  Logs:    journalctl -u claude-matrix-bridge -f"
echo "  Stop:    sudo systemctl stop claude-matrix-bridge"
echo "  Restart: sudo systemctl restart claude-matrix-bridge"
echo "  Dev:     mise run dev"
echo ""
