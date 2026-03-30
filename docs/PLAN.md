# claude-matrix-bridge

## Überblick

Baue `claude-matrix-bridge` — ein System das Claude Code über Matrix fernsteuerbar macht. Jede Claude-Session bekommt einen eigenen Matrix-Raum. Ein Supervisor-Bot hält die einzige Matrix-Verbindung und routet Nachrichten an Claude-Instanzen über ein eigenes Channel-Plugin.

Das Projekt nutzt ausschließlich das offizielle Claude Code Channel-API (MCP `notifications/claude/channel` + MCP-Tools). Kein Agent SDK, kein API Key. Claude Code CLI mit normaler Subscription-Auth (Pro/Max/Team/Enterprise claude.ai Login), identisch zur Nutzung im Terminal.

## Architektur

```
Supervisor Bot (ein Prozess, systemd, @claude-bot:cupr.dev)
├── Eine Matrix-Verbindung zu matrix.cupr.dev (matrix-bot-sdk)
├── SQLite für State (better-sqlite3)
├── Matrix Space "Claude Code"
│   ├── #claude-control (Port 9000) ← eigene Claude-Session mit Management-MCP-Tools
│   ├── romm-sync-pr191 (Port 9001) ← Claude-Session, cwd: ~/projects/decky-romm-sync
│   └── orbit-bugfix (Port 9002)    ← Claude-Session, cwd: ~/projects/orbit
│
└── Pro Session: spawnt `claude` mit Channel-Plugin
    └── matrix-relay = eigenes Channel-Plugin (MCP-Server mit localhost HTTP-Endpoint)

Nachrichtenfluss:
  Element → matrix.cupr.dev → Supervisor (einziger Matrix-Client)
    → HTTP POST localhost:PORT → Channel Plugin (MCP-Server)
    → notifications/claude/channel → Claude Code Session
    → Claude ruft MCP-Tool "reply" auf → Channel Plugin
    → HTTP Response → Supervisor → Matrix Room

Permission-Flow:
  Claude will Tool nutzen → Claude Code schickt permission_request an Plugin
    → Plugin → Supervisor → Matrix Room (⚠️ Nachricht mit Details)
    → User reagiert ✅/❌ → Supervisor → Plugin
    → notifications/claude/channel/permission → Claude Code → Tool erlaubt/verweigert
```

## Referenz-Dokumentation

Lies diese Quellen BEVOR du anfängst zu coden:

1. **Channels Reference (wie man einen Channel baut):** https://code.claude.com/docs/en/channels-reference
2. **Channels Overview:** https://code.claude.com/docs/en/channels
3. **Claude Code CLI Reference:** https://code.claude.com/docs/en/cli-reference
4. **Plugin-Struktur:** https://code.claude.com/docs/en/plugins
5. **Telegram-Plugin Source (Referenz-Implementation mit Permission Relay):** https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
6. **fakechat-Plugin Source (minimale Referenz):** https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat
7. **matrix-bot-sdk Docs:** https://turt2live.github.io/matrix-bot-sdk/index.html

Das Telegram-Plugin ist die primäre Vorlage für das Channel-Plugin (Permission Relay, Retry-Logic, Access Control).
Das fakechat-Plugin zeigt die minimale Boilerplate (lokaler HTTP-Server, Messages rein/raus).

## Versionsanforderungen

- Claude Code **v2.1.80+** (Channels Support)
- Claude Code **v2.1.81+** (Permission Relay)
- **claude.ai Login erforderlich** (Pro/Max/Team/Enterprise) — Console/API-Key Auth funktioniert NICHT mit Channels
- Node.js 22+ (Supervisor)
- Bun (Channel-Plugin, konsistent mit offiziellen Plugins)

## Monorepo-Struktur

```
claude-matrix-bridge/
├── packages/
│   ├── matrix-relay/                    # Channel-Plugin (MCP-Server)
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json             # Plugin-Manifest für Claude Code
│   │   ├── .mcp.json                   # MCP-Server Definition
│   │   ├── .npmrc                      # registry=https://registry.npmjs.org/
│   │   ├── src/
│   │   │   └── server.ts              # MCP-Server + HTTP-Server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── bunfig.toml
│   │
│   └── supervisor/                      # Matrix Bot + Prozessmanager
│       ├── src/
│       │   ├── index.ts                 # Entry point, Bootstrap
│       │   ├── bot.ts                   # Matrix Bot Lifecycle, Event Handling
│       │   ├── process-manager.ts       # Claude-Prozesse starten/stoppen/überwachen
│       │   ├── session-manager.ts       # Session CRUD, Room ↔ Session ↔ Port Mapping
│       │   ├── command-handler.ts       # Slash Commands im Control Room
│       │   ├── relay-client.ts          # HTTP-Client für Kommunikation mit Channel-Plugins
│       │   ├── message-formatter.ts     # Markdown → Matrix HTML (marked)
│       │   ├── permission-handler.ts    # Permission Requests → Matrix Reactions → Verdicts
│       │   ├── replay.ts               # Session-Historie Replay (Phase 2, Platzhalter)
│       │   ├── database.ts             # SQLite Wrapper
│       │   ├── config.ts               # Env/Config Loading + Validation
│       │   └── types.ts                # TypeScript Interfaces
│       ├── migrations/
│       │   └── 001_init.sql
│       ├── package.json
│       └── tsconfig.json
│
├── claude-matrix-bridge.service         # systemd Unit File
├── .env.example
├── README.md
├── LICENSE                              # MIT
└── .gitignore
```

---

## Komponente 1: Channel-Plugin `matrix-relay`

### Was es ist

Ein generisches Channel-Plugin für Claude Code. Es wird von Claude Code als MCP-Server-Subprocess gestartet und öffnet einen lokalen HTTP-Server. Es kennt kein Matrix — es ist eine generische Brücke zwischen HTTP und dem Claude Code Channel-API.

Orientiere dich am **fakechat**-Plugin für MCP-Boilerplate und am **Telegram**-Plugin für Permission Relay.

### Runtime

Bun (Konsistenz mit den offiziellen Channel-Plugins).

### Plugin-Packaging

Das Plugin braucht die volle Plugin-Struktur damit Claude Code es als Channel erkennt:

**`.claude-plugin/plugin.json`:**
```json
{
  "name": "matrix-relay",
  "description": "HTTP relay channel for Claude Code — bridges external systems via localhost HTTP",
  "version": "0.0.1",
  "keywords": ["matrix", "relay", "channel", "mcp", "http"]
}
```

**`.mcp.json`:**
```json
{
  "mcpServers": {
    "matrix-relay": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

**`.npmrc`:**
```
registry=https://registry.npmjs.org/
```

### Funktionsweise

1. Claude Code startet das Plugin als MCP-Subprocess (stdio Transport)
2. Plugin liest `RELAY_PORT` aus der Umgebung (z.B. 9001)
3. Plugin startet HTTP-Server auf `127.0.0.1:RELAY_PORT`
4. Plugin deklariert `claude/channel` UND `claude/channel/permission` Capabilities im MCP-Handshake

### MCP-Setup

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'matrix-relay', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},   // Permission Relay
      },
    },
    instructions: `Messages arrive as <channel source="matrix-relay" ...>. Use the reply tool to respond. The user reads messages in a Matrix chat room, not in this terminal session.`,
  },
)

await mcp.connect(new StdioServerTransport())
```

### HTTP-Endpoints

**`POST /message`** — Nachricht an Claude senden
```json
{
  "sender": "@daniel:cupr.dev",
  "content": "Fix den Bug in save_sync.py",
  "message_id": "optional-tracking-id"
}
```
Plugin empfängt das, pushed es als `notifications/claude/channel` an Claude.

**Wichtig: Notification Retry-Logic.** `mcp.notification()` kann still fehlschlagen (bekanntes Issue). Retry mit exponential Backoff implementieren (3 Versuche, 500ms/1000ms/1500ms):

```typescript
async function sendNotification(params: object, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await mcp.notification({ method: 'notifications/claude/channel', params })
      return
    } catch (err) {
      if (i < retries - 1) await sleep(500 * (i + 1))
      else throw err
    }
  }
}
```

**`GET /events`** — SSE-Stream für Antworten und Permission Requests von Claude
Wenn Claude das MCP-Tool `reply` aufruft, wird die Antwort als SSE-Event gesendet:
```
data: {"type":"reply","content":"Ich schaue mir die Datei an...","message_id":"..."}
```

Permission Requests werden ebenfalls als SSE-Events weitergeleitet:
```
data: {"type":"permission_request","request_id":"abcde","tool_name":"Bash","description":"Run npm test","input_preview":"..."}
```

**`POST /permission`** — Permission Verdict vom Supervisor
```json
{
  "request_id": "abcde",
  "behavior": "allow"
}
```
Plugin empfängt das und schickt `notifications/claude/channel/permission` an Claude.

**`GET /health`** — Health Check
Gibt Status zurück.

### MCP-Interface

**Capabilities:**
- `experimental['claude/channel']` — Registriert den Channel-Notification-Listener
- `experimental['claude/channel/permission']` — Aktiviert Permission Relay

**Notification (inbound → Claude):** `notifications/claude/channel`
```typescript
await sendNotification({
  content: message.content,
  meta: {
    chat_id: 'matrix',
    message_id: message.message_id,
    user: message.sender,
    ts: new Date().toISOString(),
  },
})
```

**Wichtig:** `meta`-Keys dürfen nur Buchstaben, Ziffern und Unterstriche enthalten. Keys mit Bindestrichen werden **still ignoriert**. Also `message_id`, nicht `message-id`.

**Permission Request (inbound ← Claude):** `notifications/claude/channel/permission_request`
```typescript
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Push als SSE-Event an Supervisor
  pushSSE({
    type: 'permission_request',
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  })
})
```

**Permission Verdict (outbound → Claude):** `notifications/claude/channel/permission`
```typescript
await mcp.notification({
  method: 'notifications/claude/channel/permission',
  params: { request_id, behavior },  // behavior: 'allow' | 'deny'
})
```

**Tools (outbound — Claude ruft auf):**
- `reply(content: string, message_id?: string)` — Claude antwortet
- `react(emoji: string, message_id: string)` — Emoji-Reaktion

### Scope

Klein. ~300-500 Zeilen TypeScript. MCP-Boilerplate von fakechat, Permission Relay vom Telegram-Plugin.

---

## Komponente 2: Supervisor Bot

### Was es ist

Ein Node.js-Prozess der als systemd-Service läuft. Er ist der einzige Matrix-Client, managed alle Claude-Prozesse, und routet Nachrichten.

### Runtime

Node.js 22+ mit TypeScript (strict mode).

### Dependencies

- `matrix-bot-sdk` — Matrix-Verbindung
- `better-sqlite3` — State-Persistenz
- `marked` — Markdown → HTML Konvertierung
- `pino` — Strukturiertes Logging (JSON, stderr)
- `dotenv` — .env Loading

### Konfiguration (.env)

```bash
# Matrix
MATRIX_HOMESERVER_URL=https://matrix.cupr.dev
MATRIX_ACCESS_TOKEN=syt_bot_token_here
MATRIX_BOT_USER_ID=@claude-bot:cupr.dev
MATRIX_OWNER_USER_ID=@daniel:cupr.dev

# Claude
CLAUDE_MODEL=sonnet
CLAUDE_DEFAULT_WORKDIR=/home/daniel/projects

# Ports
RELAY_PORT_START=9000
RELAY_PORT_END=9015

# Bot
DATABASE_PATH=./data/bot.db
LOG_LEVEL=info
```

### Datenbank (SQLite)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    -- UUID (wird als --session-id an Claude übergeben)
  room_id TEXT UNIQUE,                    -- Matrix Room ID (!abc:cupr.dev), NULL wenn Room gelöscht
  name TEXT NOT NULL UNIQUE,              -- Human-readable Name (wird als --name an Claude übergeben)
  working_directory TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'sonnet',
  permission_mode TEXT NOT NULL DEFAULT 'default',  -- default | plan | bypassPermissions
  port INTEGER,                           -- Zugewiesener localhost Port
  pid INTEGER,                            -- PID des claude Prozesses, NULL wenn nicht laufend
  status TEXT NOT NULL DEFAULT 'active',  -- active | detached | archived
  created_at TEXT NOT NULL,               -- ISO 8601
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE permission_requests (
  request_id TEXT PRIMARY KEY,            -- 5-Buchstaben Code von Claude
  session_id TEXT NOT NULL,               -- FK → sessions.id
  event_id TEXT,                          -- Matrix Event ID der Permission-Nachricht
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | allowed | denied | expired
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: space_id, control_room_id
```

### Ersteinrichtung (erster Start)

1. SQLite DB initialisieren, Migrations ausführen
2. Prüfen ob Space `#claude-code:cupr.dev` existiert (resolveRoom)
3. Falls nicht → Space erstellen mit Alias
4. Prüfen ob Control Room `#claude-control:cupr.dev` existiert
5. Falls nicht → Room erstellen, zum Space hinzufügen
6. Owner inviten
7. IDs in DB config speichern
8. Control-Room Claude-Session starten (Port 9000)
9. Startup-Message im Control Room posten

**Wichtig:** `SimpleFsStorageProvider` aus matrix-bot-sdk für Sync-State-Persistenz verwenden. Ohne persistenten Storage verarbeitet der Bot nach jedem Restart alle alten Events nochmal.

### Message-Routing

```
Matrix m.room.message Event
  │
  ├─ Sender !== MATRIX_OWNER_USER_ID → ignorieren
  │
  ├─ Room === Control Room
  │   ├─ Message startet mit "/" → command-handler.ts (Slash Command)
  │   └─ Sonst → relay-client.ts POST an Port 9000 (Control-Claude-Session)
  │
  ├─ Room in sessions table (DB lookup by room_id)
  │   ├─ Session status === "active" UND pid !== NULL
  │   │   → relay-client.ts POST an session.port
  │   │   → Typing Indicator setzen
  │   │   → Auf SSE-Antwort warten
  │   │   → message-formatter.ts: Markdown → Matrix HTML
  │   │   → Antwort im Room posten
  │   │   → Typing Indicator entfernen
  │   │   → DB update: last_message_at
  │   │
  │   ├─ Session status === "active" ABER pid === NULL (Prozess weg, z.B. nach Reboot)
  │   │   → Claude-Prozess neu starten mit --resume (falls session id vorhanden)
  │   │   → Dann Message routen wie oben
  │   │
  │   ├─ Session status === "detached"
  │   │   → Re-attach: Claude-Prozess starten mit --resume
  │   │   → Status → active
  │   │   → Message routen
  │   │
  │   └─ Session status === "archived"
  │       → User informieren: "Session ist archiviert. /attach name zum Reaktivieren"
  │
  └─ Room unbekannt → ignorieren
```

### Permission Handling (permission-handler.ts)

```
SSE-Event type === "permission_request" von Channel-Plugin
  │
  ├─ Permission Request in DB speichern (request_id → session_id, event_id)
  │
  ├─ Formatierte Nachricht im Session-Room posten:
  │   ⚠️ Permission Request
  │   Tool: Bash
  │   Command: npm test
  │   Reagiere mit ✅ zum Erlauben oder ❌ zum Ablehnen
  │
  └─ Event-ID der Nachricht in DB speichern

Matrix m.reaction Event
  │
  ├─ Sender !== MATRIX_OWNER_USER_ID → ignorieren
  │
  ├─ Relates-to Event-ID in permission_requests table?
  │   ├─ Ja + Reaction ist ✅/👍 → behavior = "allow"
  │   ├─ Ja + Reaction ist ❌/👎 → behavior = "deny"
  │   └─ Nein → ignorieren
  │
  ├─ POST /permission an Channel-Plugin mit { request_id, behavior }
  │
  ├─ DB update: status → allowed/denied, resolved_at
  │
  └─ Bestätigungs-Edit auf die Permission-Nachricht:
      ✅ Erlaubt — Bash: npm test
      oder
      ❌ Abgelehnt — Bash: npm test

Fallback: Text-Antwort "yes abcde" / "no abcde"
  │
  ├─ Regex: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
  │   (Alphabet a-z ohne 'l', case-insensitive)
  │
  └─ Gleicher Flow wie oben
```

### Slash Commands (Control Room)

- **`/new <working-dir> <name>`** — Neue Session erstellen
  - Tilde-Expansion (`~` → `$HOME`)
  - Room erstellen, zum Space hinzufügen, Owner inviten
  - Claude-Prozess starten
  - Port zuweisen (nächster freier aus 9000-9015 Range)
  - DB-Eintrag erstellen
  - Bestätigung posten

- **`/new <name>`** — Ohne Working Dir, nutzt `CLAUDE_DEFAULT_WORKDIR`

- **`/new <working-dir> <name> --unsafe`** — Mit `--dangerously-skip-permissions` (für vertrauenswürdige Repos)

- **`/list`** — Alle Sessions auflisten (Name, Working Dir, Status, Port, Permission Mode, letzte Aktivität)

- **`/kill <name>`** — Session beenden
  - Claude-Prozess stoppen
  - Port freigeben
  - Status → archived
  - Room bleibt erhalten

- **`/detach <name>`** — Session vom Room lösen (für lokale Weiterarbeit)
  - Claude-Prozess stoppen
  - Status → detached

- **`/attach <name>`** — Detachte/archivierte Session wieder aktivieren
  - Claude-Prozess starten mit --resume
  - Status → active
  - (Phase 2: Historie-Replay)

- **`/status`** — Bot-Uptime, aktive Prozesse, Port-Nutzung

- **`/help`** — Command-Übersicht

### Automatische Benennung

Wenn kein Name angegeben wird, automatisch generieren aus:
- Ordnername + Git Branch (falls Git Repo): `decky-romm-sync-feature-save-v2`
- Nur Ordnername falls kein Git: `decky-romm-sync`
- Bei Namenskollision: Suffix `-2`, `-3` etc.

### Claude-Prozess starten (process-manager.ts)

```typescript
const channelPluginPath = path.resolve(__dirname, "../../matrix-relay");
const sessionId = crypto.randomUUID();

const args = [
  "--plugin-dir", channelPluginPath,
  "--dangerously-load-development-channels", "plugin:matrix-relay",
  "--model", session.model,
  "--session-id", sessionId,
  "--name", session.name,
];

if (session.permission_mode === 'bypassPermissions') {
  args.push("--dangerously-skip-permissions");
}

if (resumeSessionId) {
  args.push("--resume", resumeSessionId);
}

const proc = spawn("claude", args, {
  cwd: session.working_directory,
  env: {
    ...process.env,
    RELAY_PORT: String(session.port),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

**Offener Punkt:** `--dangerously-load-development-channels` zeigt einen Confirmation Prompt. Mögliche Lösungen:
1. `--dangerously-skip-permissions` überspringt möglicherweise auch diesen Prompt (testen)
2. Programmatisch "y\n" an stdin senden
3. `--permission-prompt-tool` mit einem Auto-Accept MCP-Tool
Muss beim Implementieren getestet und dokumentiert werden.

**Session-ID Management:**
- Beim Erstellen: UUID generieren, als `--session-id` übergeben, direkt in DB speichern
- Beim Resume: `--resume SESSION_ID` verwenden
- `--name` für menschenlesbare Identifikation setzen (kann auch für `--resume` genutzt werden)

Wichtig:
- stdout/stderr loggen (über pino)
- Exit-Events handlen (Prozess unerwartet beendet → Status updaten, User informieren)
- `RELAY_PORT` als Env-Variable an den Prozess übergeben (wird vom Channel-Plugin gelesen)

### Concurrent Sessions

Map von room_id → laufendem Prozess. Maximal eine ausstehende Claude-Antwort pro Room. Wenn eine Nachricht kommt während Claude noch arbeitet → "Claude arbeitet noch, bitte warten." posten.

### Message Formatting (message-formatter.ts)

- Claude antwortet in Markdown
- `marked` Library für Markdown → HTML Konvertierung
- Matrix-Message mit `body` (plaintext) + `formatted_body` (HTML) + `format: "org.matrix.custom.html"`
- Code-Blöcke: `<pre><code class="language-xyz">`
- Lange Antworten (>30000 Zeichen) auf mehrere Messages aufteilen
- Typing Indicator im Room setzen während Claude arbeitet

### Error Handling

- Claude-Prozess crashed → Error-Message im Room, Status updaten, User informieren
- Claude-Prozess Timeout → Konfigurierbar (default 15min), Prozess killen, Partial-Result falls vorhanden
- Matrix-Verbindung verloren → matrix-bot-sdk Auto-Reconnect
- Port-Konflikt → nächsten freien Port nehmen
- Startup: Prüfen ob `claude` CLI verfügbar ist (Version >= 2.1.81)
- Alle externen Calls in try/catch

### Neustart-Handling

Nach Reboot/Restart:
1. Supervisor startet via systemd
2. Liest alle Sessions mit status === "active" aus SQLite
3. Startet für jede Session den Claude-Prozess neu (mit --resume)
4. Postet Info im Control Room: "Bot neu gestartet, X Sessions wiederhergestellt"

### Graceful Shutdown (SIGTERM/SIGINT)

1. Alle Claude-Subprocesses SIGTERM senden
2. 5 Sekunden warten, dann SIGKILL für Überbleibsel
3. "Bot wird heruntergefahren" im Control Room posten
4. Matrix Client stoppen
5. DB Connection schließen
6. Exit

### systemd Service

```ini
[Unit]
Description=Claude Matrix Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=daniel
WorkingDirectory=/opt/claude-matrix-bridge
ExecStart=/usr/bin/node packages/supervisor/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/claude-matrix-bridge/.env

[Install]
WantedBy=multi-user.target
```

### Security

- Nur Messages von `MATRIX_OWNER_USER_ID` verarbeiten
- Keine E2EE (Klartext-Räume, lokales Netz)
- Bot erstellt alle Rooms selbst (private, invite-only)
- Fremde Invites ignorieren
- Permission Relay als Default — User muss Tool-Nutzung explizit erlauben
- `--dangerously-skip-permissions` nur als opt-in per Session (`/new ... --unsafe`)
- Ports nur auf 127.0.0.1, nicht extern erreichbar

---

## Phase 2 — Session-Portabilität (nach MVP)

### Session Discovery

- MCP-Tool `list_local_sessions(working_dir)` für den Control-Room-Claude
- Scannt `~/.claude/projects/` nach Session-JSONL-Dateien
- Extrahiert Metadaten: Timestamp, Working Dir, letzte Nachricht
- Claude kann dem User Sessions anzeigen und zur Auswahl stellen

### Detach/Attach

- `/detach name` → Prozess stoppen, Status "detached", User kann lokal mit `claude --resume SESSION_ID` weiterarbeiten
- `/attach name` → Prozess neu starten mit --resume, Session wieder über Matrix steuerbar

### Historie-Replay

Beim Attach einer Session (egal ob neu oder re-attach):

1. Supervisor liest die Session-JSONL-Datei
2. Bestimmt welche Messages bereits im Room sind (Tracking via letztem replay-Punkt in DB)
3. Postet nur NEUE User/Assistant-Paare als formatierte Messages
4. Klare visuelle Trennung zwischen Replay und Live-Messages
5. Keine Duplikate — der Replay-Mechanismus muss idempotent sein

**Offene Design-Fragen für Phase 2:**
- Wie werden Tool-Calls (Dateibearbeitungen, Bash-Commands) in der Replay-Historie dargestellt?
- Ab welcher Länge wird eine Session zusammengefasst statt komplett replayed?
- Wie wird der Sync-Punkt zuverlässig getrackt wenn zwischen Matrix und lokal gewechselt wird?

---

## Phase 3 — Polish (nach Phase 2)

### Control Room als Claude-Session mit MCP-Tools

Statt nur Slash Commands: Der Control Room hat eine eigene Claude-Instanz die natürlichsprachliche Befehle versteht und MCP-Tools aufruft:

- `create_session(name, working_dir)` → Room + Claude-Prozess erstellen
- `list_sessions()` → Aktive/archivierte Sessions auflisten
- `kill_session(name)` → Session beenden
- `attach_session(name_or_id)` → Session an Room binden
- `list_local_sessions(working_dir)` → Lokale Sessions finden

User schreibt: "Ich will an decky-romm-sync Issue #123 arbeiten, erstell mir einen Raum"
Claude versteht das, ruft die richtigen Tools auf, benennt den Room sinnvoll.

### Weitere Phase-3 Features

- Datei-Uploads von Matrix an Claude
- Live-Streaming (Bot editiert seine eigene Message während Claude schreibt, via Matrix `m.replace`)
- GitHub-Integration im Coordinator (Issue-Titel für Raum-Namen holen)
- Intelligentere Auto-Benennung

---

## Was NICHT im Scope ist

- E2EE
- Multi-User Support
- Docker
- Web UI
- Agent SDK oder API Key

---

## Implementierungs-Reihenfolge (Phase 1)

1. Monorepo-Struktur anlegen, package.json für beide Packages
2. Channel-Plugin: Plugin-Packaging (.claude-plugin/plugin.json, .mcp.json)
3. Channel-Plugin: MCP-Server Boilerplate mit Channel + Permission Capabilities
4. Channel-Plugin: HTTP-Server mit /message, /events, /health, /permission
5. Channel-Plugin: MCP Tools (reply, react)
6. Channel-Plugin: Notification Retry-Logic
7. Channel-Plugin: Testen mit `claude --plugin-dir ... --dangerously-load-development-channels`
8. Supervisor: Config + Database Layer
9. Supervisor: Matrix Bot Grundgerüst (connect, SimpleFsStorageProvider, Event Listener, Owner-Check)
10. Supervisor: Ersteinrichtung (Space + Control Room automatisch erstellen)
11. Supervisor: Command Handler (/new, /list, /kill, /status, /help)
12. Supervisor: Process Manager (Claude-Prozesse spawnen/stoppen, --session-id setzen)
13. Supervisor: Relay Client (HTTP POST an Channel-Plugin, SSE lesen)
14. Supervisor: Permission Handler (Reactions + Text-Fallback)
15. Supervisor: Message Formatter (Markdown → Matrix HTML)
16. Supervisor: Alles zusammenstecken — Message Routing
17. Supervisor: Neustart-Handling (aktive Sessions wiederherstellen)
18. Supervisor: Error Handling + Timeouts
19. Supervisor: Graceful Shutdown
20. systemd Service File
21. README mit vollständiger Setup-Anleitung
22. .env.example

**Committe nach jedem Schritt mit aussagekräftiger Commit-Message.**
