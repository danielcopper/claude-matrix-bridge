# claude-matrix-bridge

Remote-control Claude Code sessions via Matrix. Each Claude session gets its own Matrix room. A supervisor bot maintains a single Matrix connection and routes messages to Claude instances through a custom channel plugin.

Uses the official Claude Code Channel API (`notifications/claude/channel` + MCP tools). No Agent SDK, no API key — just Claude Code CLI with normal subscription auth.

## Architecture

```
Supervisor Bot (single process, systemd)
├── One Matrix connection (matrix-bot-sdk)
├── SQLite for state (better-sqlite3)
├── Matrix Space "Claude Code"
│   ├── #claude-control (Port 9000) ← management session
│   ├── session-room-1   (Port 9001) ← Claude session
│   └── session-room-2   (Port 9002) ← Claude session
│
└── Per session: spawns claude --channels plugin:matrix-relay
    └── matrix-relay = channel plugin (MCP server + localhost HTTP)
```

## Packages

- **`packages/matrix-relay`** — Channel plugin (Bun). Generic HTTP ↔ Claude Code Channel bridge.
- **`packages/supervisor`** — Matrix bot + process manager (Node.js). Manages rooms, sessions, and message routing.

## Setup

TODO — see `.env.example` for configuration.

## License

MIT
