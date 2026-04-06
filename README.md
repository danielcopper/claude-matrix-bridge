# claude-matrix-bridge

Remote-control Claude Code sessions via Matrix. Each Claude session gets its own Matrix room. A supervisor bot maintains a single Matrix connection and routes messages to Claude instances through a custom channel plugin.

Uses the official Claude Code Channel API (`notifications/claude/channel` + MCP tools). No Agent SDK, no API key — just Claude Code CLI with normal subscription auth.

## Architecture

```
Supervisor Bot (single process, systemd)
├── One Matrix connection (matrix-bot-sdk)
├── SQLite for state (better-sqlite3)
├── Matrix Space "Claude Code"
│   ├── #claude-control        ← slash commands
│   ├── session-room-1 (9000)  ← Claude session in tmux
│   └── session-room-2 (9001)  ← Claude session in tmux
│
└── Per session: Claude runs in a tmux session
    └── matrix-relay channel plugin (MCP server + localhost HTTP)
        └── SSE stream back to supervisor for replies + permissions
```

## Packages

- **`packages/matrix-relay`** — Channel plugin (Bun). Generic HTTP-to-MCP bridge spawned by Claude Code as a subprocess.
- **`packages/supervisor`** — Matrix bot + process manager (Node.js). Manages rooms, sessions, and message routing.

## Prerequisites

- [Claude Code CLI](https://claude.ai/download) v2.1.81+ with claude.ai subscription (Pro/Max/Team/Enterprise)
- [Node.js](https://nodejs.org/) 22+
- [Bun](https://bun.sh/) (for the channel plugin)
- [tmux](https://github.com/tmux/tmux) (Claude channels require a real PTY)
- A Matrix homeserver (Synapse recommended) with a bot account
- [mise](https://mise.jdx.dev/) (optional, for managing tool versions)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/danielcopper/claude-matrix-bridge.git
cd claude-matrix-bridge

# Install relay plugin dependencies
cd packages/matrix-relay && bun install && cd ../..

# Install supervisor dependencies
cd packages/supervisor && npm install && cd ../..
```

### 2. Create a Matrix bot account

Create a new user on your homeserver (e.g. `@claude-bot:example.com`) and obtain an access token. With Synapse Admin API:

```bash
# Create user
curl -X PUT "https://matrix.example.com/_synapse/admin/v2/users/@claude-bot:example.com" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password": "a-secure-password", "displayname": "Claude Bot", "admin": false}'

# Get access token
curl -X POST "https://matrix.example.com/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type": "m.login.password", "identifier": {"type": "m.id.user", "user": "claude-bot"}, "password": "a-secure-password"}'
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_ACCESS_TOKEN=syt_your_token_here
MATRIX_BOT_USER_ID=@claude-bot:example.com
MATRIX_OWNER_USER_ID=@you:example.com

CLAUDE_MODEL=sonnet
CLAUDE_DEFAULT_WORKDIR=/home/user/projects

RELAY_PORT_START=9000
RELAY_PORT_END=9015

DATABASE_PATH=./data/bot.db
LOG_LEVEL=info
```

### 4. Register the relay plugin

The supervisor does this automatically on first start, but you can also do it manually:

```bash
claude mcp add-json --scope user matrix-relay \
  '{"command":"/path/to/bun","args":["run","--cwd","/path/to/packages/matrix-relay","--shell=bun","--silent","start"]}'
```

### 5. Build and run

```bash
# Development
cd packages/supervisor
npx tsx src/index.ts

# Production
cd packages/supervisor
npx tsc
node dist/index.js
```

### 6. systemd (optional)

```bash
sudo cp claude-matrix-bridge.service /etc/systemd/system/
# Edit the service file to match your paths and user
sudo systemctl daemon-reload
sudo systemctl enable --now claude-matrix-bridge
```

## Usage

All commands are sent in the `#claude-control` room:

| Command | Description |
|---------|-------------|
| `/new <dir> [name]` | Create new Claude session in directory |
| `/new <name>` | Create session in default working directory |
| `/list` | List all sessions with status |
| `/kill <name>` | End and archive a session |
| `/detach <name>` | Detach session (continue locally with `claude --resume`) |
| `/attach <name>` | Re-attach a detached/archived session |
| `/status` | Show bot uptime and port usage |
| `/claude-help` | Show available commands |

### Permissions

When Claude needs permission to use a tool (e.g. write a file, run a command), a permission request appears in the session room. You can respond by:

- **Reacting** with ✅ 👍 (allow) or ❌ 👎 (deny)
- **Typing** a single word: `yes`, `ja`, `ok`, `mach`, `sure` (allow) or `no`, `nein`, `nope`, `deny` (deny)
- Any multi-word message is sent to Claude as a normal chat message

### Detach / Attach

You can switch between Matrix and local terminal.

**Automatic (with hooks installed):**

Just open a terminal and `claude --resume` — pick your session. The supervisor automatically detaches from Matrix, and when you close the local session, it re-attaches to Matrix. No manual steps.

**Manual (without hooks):**

```bash
# In Matrix: detach the session
/detach my-session

# Locally: continue in your terminal
claude --resume SESSION_UUID

# When done, re-attach in Matrix
/attach my-session
```

### Session Handoff Hooks

The `install.sh` script can optionally install Claude Code hooks that enable automatic session handoff. The hooks notify the supervisor when you resume or end a session locally.

If the supervisor is not running, the hooks fail silently — Claude works normally.

To install hooks manually, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "resume",
      "hooks": [{"type": "command", "command": "/path/to/scripts/session-hook.sh start", "timeout": 5000}]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "/path/to/scripts/session-hook.sh end", "timeout": 5000}]
    }]
  }
}
```

### Inspecting sessions

Claude runs in tmux sessions. You can attach to see what Claude is doing:

```bash
tmux ls                              # List sessions
tmux attach -t claude-my-session     # Watch Claude work
```

## Security

- Only messages from `MATRIX_OWNER_USER_ID` are processed
- All rooms are private, invite-only
- Relay ports bind to `127.0.0.1` only
- No E2EE (rooms are unencrypted by design)
- Permission relay allows remote tool approval without `--dangerously-skip-permissions`

## License

MIT
