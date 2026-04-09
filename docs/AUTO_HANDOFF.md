# Auto Handoff — Matrix ↔ Terminal

Nahtloser Wechsel zwischen Matrix-Chat und lokalem Terminal für dieselbe Claude-Session, mit automatischem Detach/Attach und History-Replay.

## Goal / User Story

Als User will ich:

1. Via Matrix mit Claude arbeiten (vom Handy aus, z.B. auf dem Weg)
2. Zu Hause ankommen, Terminal öffnen, `claude --resume <id>` tippen
3. **Automatisch**: Die Matrix-Session wird detached, ich arbeite lokal weiter
4. Lokal zu Ende arbeiten, Terminal schließen
5. Unterwegs wieder am Handy: neue Nachricht in Matrix schicken
6. **Automatisch**: Die lokale Session (falls noch aktiv) wird beendet, Matrix übernimmt, ein **Replay** zeigt was lokal passiert ist, dann wird meine neue Nachricht beantwortet

Alle Sessions jederzeit sowohl via Matrix als auch lokal erreichbar. History komplett intakt.

## Architektur-Entscheidungen

### Channels, nicht Agent SDK

Wir bleiben bei der Channel-basierten Architektur (matrix-relay MCP-Plugin). Gründe:

- **Native Marker für Matrix vs. Lokal**: Channel-injected Messages haben `isMeta: true` + `origin.kind === "channel"` im JSONL. Lokale Messages nicht. → Zuverlässiges Gap-Detection für Replay ohne custom Tracking.
- **TOS-Fit**: Channels sind explizit für "remote messaging interfaces for Claude Code" designed — genau unser Use Case. SDK ist allgemeiner "build apps with Claude".
- **Keine Workarounds**: Kein `CLAUDE_CODE_ENTRYPOINT=cli` Env-Hack, kein `recentlySpawned` Tracking, kein `extraArgs: { name }` Umweg — alles natürlich.
- **Plugin-Ökosystem**: `matrix-relay` kann als richtiges Channel-Plugin behandelt werden.

Siehe [ADR: SDK vs Channels](#adr-sdk-vs-channels) am Ende für den Vergleich.

### tmux mit dediziertem Socket

Wir nutzen tmux mit `-L claude-matrix-bridge` Socket. Gründe:

- **Crash-Resilienz**: Tmux-Sessions überleben Supervisor-Restart. Bei systemd-Service kritisch.
- **Inspectability**: `tmux -L claude-matrix-bridge attach -t <name>` → direktes Debugging.
- **Isolation**: Separater Socket = keine Vermischung mit User's normalem `tmux ls`.
- **Proven**: Code existiert im main Branch, bewährt.

`tmux -L claude-matrix-bridge` startet einen eigenen tmux-Server auf einem separaten Unix-Socket. `tmux ls` (default Socket) zeigt weiterhin nur die User-Sessions. Unsere Sessions sind nur via `tmux -L claude-matrix-bridge ls` sichtbar.

### State Machine

```
                    /kill
                      │
                      ▼
                 ┌──────────┐
                 │ archived │
                 └──────────┘
                      ▲
                      │ /kill
                      │
      matrix_msg +    │         SessionStart hook
      local_start     │         (lokal claude --resume)
    ┌────────────┐   ┌┴────────┐ ──────────────► ┌──────────────┐
    │            │   │ active  │                 │ local_active │
    │  detached  │◄──┤(Matrix) │                 │  (Terminal)  │
    │   (idle)   │   └────┬────┘ ◄──────┐        └──────┬───────┘
    │            │        │    kill local+      matrix_msg      │
    └─────┬──────┘        │    resume + replay               SessionEnd
          │               │                                     │
          │               │ /detach                             │
          │               ▼                                     │
          │         ┌──────────┐                                │
          └─────────┤ detached │◄───────────────────────────────┘
                    │  (idle)  │
                    └──────────┘
```

**States:**

| State | Bedeutung | Supervisor Claude läuft? | Lokaler Claude läuft? |
|---|---|---|---|
| `active` | Matrix hat eine aktive Claude-Session | ✅ | ❌ |
| `local_active` | Lokales Terminal hat Claude am Laufen, Matrix ist passiv | ❌ | ✅ |
| `detached` | Niemand hat Claude aktiv, Session ist idle | ❌ | ❌ |
| `archived` | Session beendet (via `/kill`) | ❌ | ❌ |

**Transitions:**

| Von | Event | Nach | Supervisor Aktion |
|---|---|---|---|
| `active` | SessionStart-Hook (lokal) | `local_active` | Kill eigenen Claude, store local PID |
| `local_active` | SessionEnd-Hook (lokal) | `detached` | Clear local PID |
| `local_active` | Matrix-Message | `active` | Kill local PID, wait flush, spawn Claude, replay gap, relay message |
| `detached` | Matrix-Message | `active` | Spawn Claude, replay gap, relay message |
| `active` | Matrix `/detach` | `detached` | Kill eigenen Claude |
| `active` | Matrix `/kill` | `archived` | Kill eigenen Claude, free port |
| `detached` | SessionStart-Hook (lokal) | `local_active` | Store local PID |

## Komponenten

### Supervisor (Node.js)

- **matrix-bot-sdk** Verbindung zu Matrix
- **SQLite** für Session-State
- **HTTP API** `localhost:9090` für Hooks
- **Process Manager** — spawnt/killt tmux-Sessions mit `-L claude-matrix-bridge`
- **Relay Client** — HTTP POST an matrix-relay, SSE-Stream für Responses
- **Replay Module** (**neu**) — parst JSONL, formatiert Gap

### matrix-relay Channel Plugin

Unverändert zum aktuellen main-Stand:

- MCP-Server (Bun) läuft als Subprocess von claude
- HTTP-Server auf `RELAY_PORT` (lokal)
- Channel-Capabilities: `claude/channel` + `claude/channel/permission`
- Tools: `reply`, `react`
- Endpoints: `POST /message`, `GET /events` (SSE), `POST /permission`

### Hook Script

`scripts/session-hook.sh` — erweitert um die Claude-PID mitzuschicken:

```bash
#!/usr/bin/env bash
# SessionStart / SessionEnd hook
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
EVENT=${1:-start}
CLAUDE_PID=$PPID   # Parent = der claude-Prozess
PORT=${CMB_API_PORT:-9090}

[ -z "$SESSION_ID" ] && exit 0

curl -s -X POST "http://127.0.0.1:${PORT}/api/session/${EVENT}" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"${SESSION_ID}\",\"pid\":${CLAUDE_PID}}" \
  --connect-timeout 1 --max-time 5 > /dev/null 2>&1 || true
```

Installiert über `install.sh` in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "resume", "hooks": [{"type": "command", "command": "/path/session-hook.sh start"}]}],
    "SessionEnd": [{"matcher": "", "hooks": [{"type": "command", "command": "/path/session-hook.sh end"}]}]
  }
}
```

## Database Schema

Erweiterung des bestehenden `sessions` Table:

```sql
-- Neue Status-Option
-- status TEXT: 'active' | 'local_active' | 'detached' | 'archived'

ALTER TABLE sessions ADD COLUMN local_pid INTEGER;
ALTER TABLE sessions ADD COLUMN last_matrix_activity TEXT;  -- ISO 8601
```

- `local_pid`: PID des lokalen Claude-Prozesses (wenn `local_active`), sonst NULL
- `last_matrix_activity`: Timestamp der letzten Message die Matrix gesehen hat (für Replay-Cutoff)

## Implementierungs-Phasen

### Phase 1: Restore Channels + dedicated tmux socket

**Branch**: `refactor/restore-channels-dedicated-socket`

Da wir von main abzweigen (SDK-Arbeit abandoned), ist das kein echter "Rollback". Es ist **Feintuning** des main-Stands:

1. `packages/supervisor/src/process-manager.ts`:
   - Alle `tmux` Commands mit `-L claude-matrix-bridge` prefix
   - Helper-Funktion `tmuxCmd(...args)` die `['-L', 'claude-matrix-bridge', ...args]` returned
   - `killAllProcesses`: statt über `tmux list-sessions` global iterieren, nur unser Socket
2. Tests: `/new`, `/list`, `/detach`, `/attach`, `/kill`, Supervisor-Restart
3. `install.sh` / `uninstall.sh`: wenn nötig anpassen für Socket-Cleanup

**Akzeptanzkriterium**: `tmux ls` zeigt nur User-Sessions. `tmux -L claude-matrix-bridge ls` zeigt unsere Sessions.

### Phase 2: Auto-Detach (SessionStart Hook mit PID)

**Branch**: `feature/auto-detach`

1. `scripts/session-hook.sh`: `$PPID` mitschicken
2. `packages/supervisor/migrations/002_auto_handoff.sql`: neue Spalten (`local_pid`, `last_matrix_activity`)
3. `packages/supervisor/src/types.ts`: `SessionStatus` um `'local_active'` erweitern, `Session` um `local_pid` und `last_matrix_activity`
4. `packages/supervisor/src/database.ts`: CRUD für neue Felder
5. `packages/supervisor/src/api.ts` `handleSessionStart`:
   - Wenn `status === 'active'`: **killClaude()** (statt nur markieren)
   - Wenn `status === 'detached'`: nur markieren
   - In beiden Fällen: `status = 'local_active'`, `local_pid = body.pid`
6. `packages/supervisor/src/api.ts` `handleSessionEnd`:
   - `status = 'detached'`, `local_pid = NULL`
7. Matrix-Nachricht in Session-Room mit Info: "Session handed off to local terminal (PID X)"

**Akzeptanzkriterium**: Matrix aktiv → lokal `claude --resume <id>` → Supervisor-Claude stirbt, Status = `local_active`, Matrix-Room zeigt Handoff-Info.

### Phase 3: Auto-Attach + Kill lokal

**Branch**: `feature/auto-attach`

1. `packages/supervisor/src/bot.ts` `handleSessionRoomMessage`:
   - Wenn `status === 'local_active'`:
     - `process.kill(local_pid, 'SIGTERM')`
     - Wait 500ms (JSONL flush)
     - Fallback: `SIGKILL` falls PID noch läuft
     - `spawnClaude(session, ...)` mit Resume
     - `status = 'active'`, `local_pid = NULL`
     - (Replay kommt in Phase 4)
     - Relay die Matrix-Nachricht
   - Wenn `status === 'detached'`:
     - `spawnClaude(session, ...)` mit Resume
     - `status = 'active'`
     - Relay die Matrix-Nachricht
2. Matrix-Nachricht: "Local session closed, Matrix control resumed"
3. `last_matrix_activity` bei jedem SSE-Reply updaten (für Phase 4 vorbereiten)

**Akzeptanzkriterium**: Lokal aktiv → Matrix-Nachricht → lokaler Claude stirbt, Supervisor spawnt, Matrix-Nachricht wird beantwortet.

### Phase 4: Replay

**Branch**: `feature/history-replay`

1. **Neues Module** `packages/supervisor/src/replay.ts`:
   - `function buildReplay(sessionId, since: Date): ReplayBlock | null`
   - Findet JSONL-Pfad via `working_directory` (encoded: `/` → `-`)
   - Parst JSONL-Records
   - Filtert: nach `timestamp > since`, nur `type === 'user'` (ohne `isMeta: true`) und `type === 'assistant'`
   - Gruppiert: User → Claude pairs
   - Formatiert als Matrix-Block (siehe unten)
2. `bot.ts` beim Auto-Attach: vor dem Relay die Replay posten
3. `last_matrix_activity` bei jedem SSE-Reply updaten

**Replay-Format** (einzelner Matrix-Block):

```markdown
─── Local session activity ───
(from terminal, 2026-04-09 10:15)

**User:** ok fix the typo in save_sync.py
**Claude:** Done. Updated line 42.

**User:** run the tests
**Claude:** ✓ All 23 tests passed.

─── Back in Matrix ───
```

**Grenzen**: 
- Max 20 Message-Pairs per Replay (Entscheidung TBD in Phase 4)
- Bei mehr: Summary statt vollem Log (z.B. "During local session: 45 messages exchanged, 8 files edited, 3 bash commands run")
- Option: Claude selbst zusammenfassen lassen beim Attach

### Phase 5: Polish

- Channel-Plugin System-Prompt erweitern um Hinweis auf mögliche local-session Messages: "Previous messages without channel wrapper were typed directly in a terminal. Treat them as part of the continuing conversation."
- Lange Running-Sessions Testing
- Edge Cases: Fork, mehrere parallele Attacks

## Replay Details

### JSONL Format Reminder

Channel-injected Messages haben klare Marker:

```json
// MATRIX-Message (via channel plugin)
{
  "type": "user",
  "message": {"role": "user", "content": "<channel source=\"matrix-relay\" ...>\nhi\n</channel>"},
  "isMeta": true,
  "origin": {"kind": "channel", "server": "matrix-relay"},
  "timestamp": "..."
}

// LOKALE Message
{
  "type": "user",
  "message": {"role": "user", "content": "hi"},
  "entrypoint": "cli",
  "timestamp": "..."
}
```

### Replay-Cutoff

`last_matrix_activity` = Timestamp des letzten Messages das Matrix gesehen/gesendet hat.

**Update-Regel**: Bei jedem erfolgreichen SSE-Reply vom Relay (`type: 'reply'`) den aktuellen Timestamp in `last_matrix_activity` speichern.

Beim Re-Attach: Alle JSONL-Records mit `timestamp > last_matrix_activity` sind der Gap.

### Replay-Content-Extraktion

Pseudocode:

```typescript
function buildReplay(sessionId: string, since: Date): ReplayBlock | null {
  const path = jsonlPath(sessionId)
  if (!existsSync(path)) return null
  
  const records = parseJsonlLines(path)
    .filter(r => new Date(r.timestamp) > since)
  
  const messages: {role: 'user' | 'assistant', text: string}[] = []
  
  for (const r of records) {
    if (r.type === 'user' && !r.isMeta) {
      // Lokale User-Message
      const text = typeof r.message.content === 'string'
        ? r.message.content
        : extractText(r.message.content)
      if (text) messages.push({role: 'user', text})
    } else if (r.type === 'assistant') {
      // Jede Assistant-Response
      const text = extractAssistantText(r.message.content)
      if (text) messages.push({role: 'assistant', text})
    }
    // User mit tool_result: überspringen
    // attachment, system, etc.: überspringen
  }
  
  if (messages.length === 0) return null
  
  return formatReplayBlock(messages, since)
}
```

## Offene Fragen / TBD

Entscheidungen die wir während der Implementierung treffen:

1. **Replay-Länge-Obergrenze**: 20 Message-Pairs hart, oder Summary ab X Messages? Wer macht die Summary — wir via simple Logik oder Claude selbst?
2. **Race-Window beim Kill→Resume**: 500ms fest, oder tatsächlich auf JSONL-Flush warten (File-Watch)?
3. **Kill-Signal Escalation**: Wie aggressiv sollen wir sein? `SIGTERM` → wait 3s → `SIGKILL`?
4. **Mehrere Matrix-Messages während Auto-Attach**: Queue? Lock? Was passiert wenn Nachricht 2 kommt während Auto-Attach läuft?
5. **Lokale Claude-Session ohne unsere Hooks**: Wenn User die Hooks nicht in `~/.claude/settings.json` hat, funktioniert Auto-Handoff nicht. Soll install.sh das erzwingen?
6. **Hook + Remote-Nutzung**: Wenn Supervisor auf Remote-Maschine läuft und User an anderem Rechner arbeitet — wie läuft der Hook? Aktuell nur sinnvoll wenn beide auf derselben Maschine. Nicht Scope für jetzt.
7. **Fork-Sessions**: Wenn User lokal `--fork` macht → neue Session-ID → Supervisor kennt die nicht. Nur noch per `/discover` importierbar. Akzeptabel.
8. **Permission-Requests während lokal**: Wenn local_active und Claude lokal ein Tool anfragen will, passiert das lokal im Terminal (nicht via Matrix). Bei Re-Attach sind die schon resolved in der JSONL. Kein Replay nötig für permissions.

## Research Findings

### `allowedChannelPlugins` Setting (geprüft)

Resultat: **nicht nutzbar**, um den `--dangerously-load-development-channels` Confirmation-Dialog zu skippen.

- Existiert als Setting, aber nur für `kind: 'plugin'`, nicht `kind: 'server'` (wir nutzen `server:matrix-relay`)
- Bei dev-loaded channels wird der Allowlist-Check komplett übersprungen (`dev: true` → immer `register`)
- Der Dialog wird von `tengu_harbor` GrowthBook-Feature-Flag gesteuert — nicht von Settings/Env-Vars
- `DISABLE_TELEMETRY=1` schaltet den Dialog aus, aber dann wird der Channel auch abgelehnt ("Channels are not currently available")

**Konsequenz**: Wir bleiben beim bewährten Ansatz: tmux-Pane auf `"I am using this for local development"` pollen, dann `Enter` senden. Code existiert bereits im main Branch.

### `tmux -L <socket>`

Kurzerklärung: tmux-Clients/Server kommunizieren über Unix-Sockets. `-L <name>` nutzt einen separaten Socket statt dem Default. Sessions darin sind vollständig isoliert vom User's normalem `tmux ls`.

## ADR: SDK vs Channels

### Context

Während der Entwicklung wurde ein SDK-basierter Ansatz (`@anthropic-ai/claude-agent-sdk`) prototypisiert (Branch `refactor/agent-sdk`, verworfen). Die Channels-basierte Lösung wurde bevorzugt.

### Decision

Wir nutzen die **Claude Code Channels API** (matrix-relay als MCP Channel Plugin, geladen via `--dangerously-load-development-channels`), nicht das Agent SDK.

### Consequences

**Pro Channels:**

- Explizit für diesen Use Case designed ("remote messaging interfaces")
- `isMeta` / `origin` Marker im JSONL → robuste Matrix/Lokal-Unterscheidung für Replay
- Keine Workarounds (kein `CLAUDE_CODE_ENTRYPOINT=cli`, kein `recentlySpawned`, kein `extraArgs`)
- Plugin-Ökosystem-kompatibel
- Klarer TOS-Fit für "persönliches Automations-Tool über offizielle Anthropic-Mechanismen"

**Pro SDK (verworfen):**

- Einfacherer Code (in-process, kein HTTP Relay + SSE, kein PTY)
- Type-safe `canUseTool` Callback statt MCP Permission-Relay
- Streaming AsyncGenerator
- Weniger Moving Parts

**Entschieden für Channels weil:**

- TOS-Klarheit wichtiger als Code-Einfachheit für diesen Use Case
- Replay-Feature in Zukunft wichtig → saubere Matrix/Lokal-Unterscheidung
- Crash-Resilienz durch tmux als Persistenz-Layer
- Channel-Plugin-Modell passt besser zur Domäne

### Alternatives Considered

- **SDK mit Custom Matrix-Marker**: SDK + wrappe Matrix-Messages manuell mit `<matrix>` Tags. Funktioniert, aber fragil (Claude sieht den Wrapper im Prompt-Context), mehr Custom-Code, nicht sauber.
- **Node-pty statt tmux**: Native Node.js PTY. Vorteil: keine externe Dependency. Nachteil: keine Crash-Resilienz (Supervisor-Crash = Session weg), schlechtere Inspectability. Verworfen zugunsten tmux.

## File Map (erwartet nach Phase 4)

```
packages/supervisor/src/
├── index.ts                  # Bootstrap + Restore-Logik mit State-Machine
├── bot.ts                    # Event-Handler + Auto-Attach-Flow
├── command-handler.ts        # Slash Commands
├── process-manager.ts        # tmux-Spawning mit -L cmb
├── relay-client.ts           # HTTP POST + SSE (unverändert)
├── api.ts                    # Hook Handler mit PID-Tracking
├── replay.ts                 # NEU: JSONL Parser für Gap
├── database.ts               # Mit local_pid, last_matrix_activity
├── message-formatter.ts      # Markdown → Matrix HTML (unverändert)
├── session-scanner.ts        # /discover (unverändert)
├── config.ts                 # Config (unverändert)
└── types.ts                  # SessionStatus + 'local_active'

packages/supervisor/migrations/
├── 001_init.sql
└── 002_auto_handoff.sql      # NEU

packages/matrix-relay/        # Channel Plugin (unverändert)

scripts/
└── session-hook.sh           # Erweitert um $PPID
```
