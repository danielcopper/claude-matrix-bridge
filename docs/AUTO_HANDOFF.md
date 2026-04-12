# Auto Handoff — Matrix ↔ Terminal

Nahtloser Wechsel zwischen Matrix-Chat und lokalem Terminal für dieselbe Claude-Session, mit automatischem Detach/Attach und History-Replay.

## Goal / User Story

Als User will ich:

1. Via Matrix mit Claude arbeiten (vom Handy aus, z.B. auf dem Weg)
2. Zu Hause ankommen, Terminal öffnen, **entweder** `claude --resume <id>` **oder** `claude --resume` (interaktiver Picker) tippen
3. **Automatisch**: Die Matrix-Session wird detached, ich arbeite lokal weiter
4. Lokal weiterarbeiten — das Terminal muss **nicht explizit geschlossen** werden, wenn ich wieder unterwegs bin
5. Unterwegs wieder am Handy: neue Nachricht in Matrix schicken
6. **Automatisch**: Die lokale Claude-Session wird beendet (falls noch aktiv) — nur der Claude-Prozess selbst, **nicht** mein Terminal oder Tmux-Pane. Matrix übernimmt, ein **Replay** zeigt was lokal passiert ist, dann wird meine neue Nachricht beantwortet

Alle Sessions jederzeit sowohl via Matrix als auch lokal erreichbar. History komplett intakt.

### Wichtige Details zum Kill-Verhalten

Wenn wir den lokalen Claude beenden (wegen neuer Matrix-Message):

- **Wir töten nur den Claude-Prozess selbst** via `process.kill(<local_pid>, 'SIGTERM')`
- **Wir touchen NICHTS** von der User-Umgebung:
  - User's tmux-Server, -Sessions, -Windows, -Panes bleiben unberührt
  - User's Terminal-Emulator bleibt offen
  - User's Shell (bash/zsh) bleibt intakt
- Nach dem Kill sieht der User in seiner Pane einfach einen Shell-Prompt (claude ist "exited")
- Der User kann in diesem Terminal sofort weitermachen was er will (neuer `claude`-Start, andere Commands, etc.)

Der `local_pid` kommt aus dem SessionStart-Hook (`$PPID` im Shell-Script = die claude-Prozess-PID). Wir brauchen weder Zugriff auf User's tmux noch auf dessen Shell-Umgebung.

## Architektur-Entscheidungen

### Channels, nicht Agent SDK

Wir bleiben bei der Channel-basierten Architektur (matrix-relay MCP-Plugin). Gründe:

- **Native Marker für Matrix vs. Lokal**: Channel-injected Messages haben `isMeta: true` + `origin.kind === "channel"` im JSONL. Lokale Messages nicht. → Zuverlässiges Gap-Detection für Replay ohne custom Tracking.
- **TOS-Fit**: Channels sind explizit für "remote messaging interfaces for Claude Code" designed — genau unser Use Case. SDK ist allgemeiner "build apps with Claude".
- **Keine Workarounds**: Kein `CLAUDE_CODE_ENTRYPOINT=cli` Env-Hack, kein `recentlySpawned` Tracking, kein `extraArgs: { name }` Umweg — alles natürlich.

Siehe [ADR: SDK vs Channels](#adr-sdk-vs-channels) am Ende für den Vergleich.

### Publishability — wir sind **kein** klassisches Claude Code Plugin

Wichtige Klarstellung: Dieses Projekt ist **kein** Plugin das man via `/plugin install` installieren kann. Gründe:

- Ein Claude Code Plugin ist ein **MCP-Server** der von claude zur Laufzeit geladen wird (optional mit Skills, Commands, Hooks)
- Unser Projekt ist eine **externe Infrastruktur**: Supervisor-Daemon (systemd-Service), SQLite-DB, Matrix-Bot als separater Prozess, Hooks in `~/.claude/settings.json` die von außen geschrieben werden müssen
- Das kann man nicht als Plugin ausliefern — es läuft **neben** Claude, nicht **in** Claude

**Was publishable wäre:**

- `packages/matrix-relay/` **allein** könnte als eigenständiges Channel-Plugin publiziert werden (wie Telegram/Discord/iMessage). Andere Projekte/Tools könnten es als generischen HTTP-Relay für Claude Code nutzen.
- Das **Gesamtprojekt** bleibt ein normales GitHub-Repo mit `install.sh`, eventuell später als Homebrew/AUR/mise-Package.

### tmux mit dediziertem Socket und minimaler Config

Wir nutzen tmux mit `-L claude-matrix-bridge` Socket **und** `-f /dev/null` (keine Config). Gründe:

- **Crash-Resilienz**: Tmux-Sessions überleben Supervisor-Restart. Bei systemd-Service kritisch.
- **Inspectability**: `tmux -L claude-matrix-bridge attach -t <name>` → direktes Debugging.
- **Isolation**: Separater Socket = keine Vermischung mit User's normalem `tmux ls`.
- **Keine Plugin-Interferenz**: `-f /dev/null` verhindert dass der separate tmux-Server die `.tmux.conf` des Users lädt.
- **Proven**: Code existiert im main Branch, bewährt.

**Warum keine Config?** Ein separater tmux-Server (`-L`) würde per Default trotzdem `~/.tmux.conf` laden. Das könnte mit User-Plugins kollidieren:

- `tmux-continuum` würde unsere Sessions auto-saven/restoren → ungewollt
- `tmux-resurrect` würde unsere Sessions in seinem State tracken → ungewollt
- User Key-Bindings könnten über `send-keys` interferieren (theoretisch)

Mit `-f /dev/null` startet der tmux-Server **komplett ohne Config**. Garantiert keine Interferenz mit User-Umgebung.

Falls wir später spezifische tmux-Settings brauchen (z.B. größerer Scrollback für Debugging), können wir eine minimale `tmux.conf` im Repo bereitstellen und via `-f ./tmux.conf` laden.

`tmux -L claude-matrix-bridge -f /dev/null` startet einen eigenen tmux-Server auf einem separaten Unix-Socket ohne Config. `tmux ls` (default Socket) zeigt weiterhin nur die User-Sessions. Unsere Sessions sind nur via `tmux -L claude-matrix-bridge ls` sichtbar.

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

### Hook-Installation: Append statt Replace

**Wichtig**: `install.sh` **muss existierende User-Hooks respektieren**. Aktuelle Version überschreibt `SessionStart` und `SessionEnd` komplett — das ist ein Bug und **wird in Phase 1 gefixt**.

**Korrektes Verhalten:**

1. Settings-Datei laden (oder neu erstellen)
2. `hooks.SessionStart` Array initialisieren wenn nicht vorhanden
3. **Prüfen** ob unser Hook schon drin ist (marker: `session-hook.sh` im `command`)
4. Nur wenn noch nicht vorhanden: **appenden** (nicht replacen)
5. Gleiches für `hooks.SessionEnd`
6. Settings zurückschreiben

**Pseudocode:**

```python
import json

with open(settings_path) as f:
    settings = json.load(f) if exists else {}

hooks = settings.setdefault('hooks', {})
OUR_MARKER = 'session-hook.sh'

def already_installed(hook_list):
    return any(OUR_MARKER in json.dumps(h) for h in hook_list)

session_start = hooks.setdefault('SessionStart', [])
if not already_installed(session_start):
    session_start.append({
        'matcher': 'resume',
        'hooks': [{'type': 'command', 'command': f'{HOOK_PATH} start'}]
    })

session_end = hooks.setdefault('SessionEnd', [])
if not already_installed(session_end):
    session_end.append({
        'matcher': '',
        'hooks': [{'type': 'command', 'command': f'{HOOK_PATH} end'}]
    })

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
```

**Eigenschaften:**
- **Non-destructive**: User-eigene SessionStart/SessionEnd-Hooks bleiben erhalten
- **Idempotent**: Mehrfaches Ausführen von `install.sh` fügt den Hook nicht mehrfach hinzu
- **Uninstall**: `uninstall.sh` muss den Hook gezielt entfernen (nicht das ganze Settings-File wegwerfen)

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

## Recovery / Supervisor Restart

Der Supervisor läuft als systemd-Service. Er kann aus mehreren Gründen neu starten:

- **Full PC crash / Power loss / Reboot**: systemd, tmux, claude, alles weg
- **Supervisor-only crash**: nur der Supervisor stirbt, tmux-Server und claude laufen weiter
- **Geplanter Neustart**: `systemctl restart claude-matrix-bridge` (z.B. nach Update)

Der Recovery-Flow muss alle drei Szenarien handhaben und **idempotent** sein — mehrfaches Ausführen darf nicht kaputt machen.

### Strategy: Always Fresh

**Entscheidung**: Bei jedem Startup killen wir den gesamten tmux-Server und spawnen alle aktiven Sessions neu. Einfach, predictable, konsistent. Die Alternative (Smart Reconnect zu bestehenden tmux/relay/claude-Prozessen) ist deutlich komplexer und rechtfertigt den Gewinn (~2-3s schnellere Recovery) nicht.

Der einzige Nachteil: Bei einem Supervisor-only-Crash könnten wir in-flight Tool-Calls verlieren. Aber: die JSONL persistiert alles was vor dem Crash committed wurde. Nur laufende, noch nicht geschriebene Tool-Calls gehen verloren — das ist bei jeder Crash-Recovery der Fall.

### Recovery Flow

```
SUPERVISOR STARTUP
│
├─ 1. DB Migrations ausführen
│
├─ 2. Alle pending permission_requests expire'n
│     UPDATE permission_requests SET status='expired', resolved_at=?
│     WHERE status='pending'
│
├─ 3. Legacy handed_off state → detached (falls noch aus alter DB vorhanden)
│     UPDATE sessions SET status='detached' WHERE status='handed_off'
│
├─ 4. Tmux-Server komplett killen (fresh slate)
│     tmux -L claude-matrix-bridge kill-server
│     (falls Server nicht existiert: silent ignore)
│
├─ 5. Stale PIDs clearen
│     UPDATE sessions SET pid=NULL WHERE status='active'
│
├─ 6. Local PID Check (für local_active Sessions):
│     for session in sessions WHERE status='local_active':
│       if session.local_pid:
│         try process.kill(session.local_pid, 0):  // signal 0 = check only
│           success → leave as-is
│             (lokaler Claude lebt noch → Supervisor-only crash)
│           failure → status='detached', local_pid=NULL
│             (PC crash oder lokal beendet)
│       else:
│         status='detached', local_pid=NULL
│
├─ 7. Normal Restore Loop (existierende Logik):
│     for session in sessions WHERE status='active':
│       - spawn fresh claude in tmux mit --resume
│       - waitForHealth(port)
│       - connectSSE(port)
│       - Post "Session restored" in Matrix-Room
│
└─ 8. Startup-Summary in Control Room:
      "Supervisor started. Restored N session(s)."
```

### Edge Cases

1. **Partial crash** (Supervisor weg, tmux+claude laufen): Wir killen die tmux-Sessions (Schritt 4), die relay-Plugins beenden sich → saubere Respawns in Schritt 7. **Verlust**: kurzzeitig offene Tool-Use-Requests, aber keine persistierten Daten.

2. **Local Claude überlebt Supervisor-Crash**: Schritt 6 erkennt das via `process.kill(pid, 0)` und lässt den Status auf `local_active`. Der User merkt nichts — bei nächster Matrix-Message läuft der normale Auto-Attach-Flow (kill local + resume + replay).

3. **tmux-Server war gar nicht gestartet** (erster Start nach Reboot): `tmux kill-server` wirft einen Fehler den wir ignorieren. Schritt 7 startet einen neuen Server beim ersten `new-session`.

4. **DB hat Sessions aber keine JSONL-Files existieren** (z.B. manuell gelöscht): Beim Resume wirft claude einen Fehler. Wir fangen den ab und setzen status=`detached` oder `archived` (Entscheidung: `detached` ist permissiver).

5. **Idempotent**: Wenn systemd in eine Restart-Loop kommt: jeder Run killt den Server (sauber), spawnt neu. Keine Akkumulation von Zombies, keine doppelten Spawns.

### Konsequenz für die Phasen

Die Recovery-Logik ist nicht eine separate Phase — sie ist **in Phase 1 integriert**:

- Schritte 1-5: bereits im main-Stand vorhanden oder trivial zu ergänzen
- Schritt 4 (kill-server): nur ein Command-Call zum bestehenden startup-Code
- Schritt 6 (local PID check): kommt mit Phase 2 (wo wir `local_active` State einführen)
- Schritt 7: bereits im main-Stand vorhanden

Also: **Phase 1 enthält die Recovery-Grundlage** (kill-server + stale PID cleanup), **Phase 2 erweitert um den local_active Check**.

## Implementierungs-Phasen

### Phase 1: Dedicated tmux socket + Hook-Install Fix

**Branch**: `refactor/tmux-socket-and-hooks`

Da wir von main abzweigen (SDK-Arbeit abandoned), ist das kein echter "Rollback". Es ist **Feintuning** des main-Stands:

**1. tmux-Socket-Isolation** — `packages/supervisor/src/process-manager.ts`:
   - Helper `tmuxCmd(...args)` der `['-L', 'claude-matrix-bridge', '-f', '/dev/null', ...args]` returned (oder ähnlich)
   - Alle `execFileSync('tmux', ...)` Aufrufe gehen durch den Helper
   - `killAllProcesses`: statt über `tmux list-sessions` global iterieren, nur unseren Socket
   - `new-session`: auch mit `-f /dev/null` starten damit Server ohne Config startet
   - Erster Call bestimmt die Server-Config, folgende Commands können `-f /dev/null` weglassen aber konsistent ist besser

**2. Recovery-Grundlage** — `packages/supervisor/src/index.ts`:
   - Beim Startup: `tmux -L claude-matrix-bridge kill-server` (silent ignore wenn nicht existiert)
   - Stale PIDs in DB clearen: `UPDATE sessions SET pid=NULL WHERE status='active'`
   - Legacy `handed_off` → `detached` Migration
   - Danach: normaler Restore-Loop (wie gehabt)
   - (Der `local_active` PID-Check kommt erst mit Phase 2, wenn der State eingeführt wird)

**3. Hook-Install Fix** — `install.sh`:
   - Append-Logik statt Replace (siehe "Hook-Installation: Append statt Replace" oben)
   - Idempotent machen
   - Uninstall.sh: gezielt unseren Hook entfernen statt alles wegzuwerfen

**4. Tests**:
   - `/new`, `/list`, `/detach`, `/attach`, `/kill`, `/discover` — alle funktionieren
   - Supervisor-Restart während laufender Sessions: tmux-Server wird gekillt, Sessions werden fresh restored, keine Zombies
   - Supervisor-Restart ohne laufende Sessions: kein Fehler durch fehlenden tmux-Server
   - `tmux ls` (default): zeigt nur User-Sessions
   - `tmux -L claude-matrix-bridge ls`: zeigt unsere Sessions
   - `install.sh` zweimal ausführen: Hook erscheint nur einmal in settings.json
   - User-eigene existierende Hooks bleiben nach `install.sh` erhalten
   - `uninstall.sh`: unsere Hooks weg, User-Hooks bleiben

**Akzeptanzkriterium**: Alles wie vorher, aber sauberer — Socket isoliert, Hooks non-destructive, clean Recovery nach Crash/Restart.

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
8. **Recovery-Erweiterung** in `index.ts` Startup: local PID Check für `local_active` Sessions
   - `process.kill(local_pid, 0)` → alive: leave as-is, dead: → `detached`, clear `local_pid`

**Akzeptanzkriterium**: Matrix aktiv → lokal `claude --resume <id>` → Supervisor-Claude stirbt, Status = `local_active`, Matrix-Room zeigt Handoff-Info. Supervisor-Restart während lokaler Session läuft → Status bleibt `local_active` wenn lokaler Claude noch lebt.

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
- **Netzwerk-Resilienz beim Auto-Attach**: Wenn das Netzwerk während eines Auto-Attach-Flows ausfällt (z.B. `sendMessage` oder `client.sendText` schlägt fehl), gibt es aktuell kein Retry. Die matrix-bot-sdk recovered den Sync selbst (Backoff + Retry), aber unsere eigenen HTTP-Calls im Auto-Attach-Flow nicht. Edge Case: Netzwerk fällt genau im 5s Auto-Attach-Fenster aus.
- **Matrix-Call-Wrapping-Konsolidierung (Follow-up)**: Der Phase-5-#4-PR führt `packages/supervisor/src/retry.ts` + `matrix-send.ts` ein und migriert alle user-facing Send-Calls im Auto-Attach- und Session-Room-Message-Pfad auf `safeSendText`/`safeSendHtml`/`safeSendMessage`/`safeSetTyping` (retry + log-on-exhaust, keine Exceptions). **Bewusst nicht migriert**: Bootstrap-Calls (`createSpace`, `inviteUser`, `sendStateEvent` etc. in `bot.ts:bootstrapSpaceAndRooms`) und Permission-Flow-Calls (im `handleSSEEvent`-Pfad). Begründung: Bootstrap läuft einmal beim Start, systemd-Restart ist dort der Retry — zusätzliche In-Process-Retries wären eine zweite Backoff-Layer ohne Nutzen. Permission-Flow ist event-driven, die SDK handled `M_LIMIT_EXCEEDED` intern, und eine verlorene Permission-Benachrichtigung hat andere Recovery-Semantik (Request expiriert serverseitig beim Startup). Falls beobachtete Probleme in diesen Pfaden auftreten: jeweils eigener kleiner PR mit Call-spezifischer Retry-Policy — **keine einheitliche Proxy-Wrapping-Schicht über `MatrixClient`**, weil die Semantik zu unterschiedlich ist.

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
5. **Lokale Claude-Session ohne unsere Hooks**: Wenn User die Hooks nicht in `~/.claude/settings.json` hat, funktioniert Auto-Handoff nicht. `install.sh` installiert sie non-destructive (siehe Phase 1). User kann sie auch manuell löschen → Auto-Handoff fällt auf manuellen `/detach` + `/attach` Flow zurück (degraded graceful).
6. **Hook + Remote-Nutzung**: Wenn Supervisor auf Remote-Maschine läuft und User an anderem Rechner arbeitet — wie läuft der Hook? Aktuell nur sinnvoll wenn beide auf derselben Maschine. Nicht Scope für jetzt.
7. **Fork-Sessions**: Wenn User lokal `--fork` macht → neue Session-ID → Supervisor kennt die nicht. Nur noch per `/discover` importierbar. Akzeptabel.
8. **Permission-Requests während lokal**: Wenn local_active und Claude lokal ein Tool anfragen will, passiert das lokal im Terminal (nicht via Matrix). Bei Re-Attach sind die schon resolved in der JSONL. Kein Replay nötig für permissions.
9. **Session-Name Wiederverwendung nach `/kill`**: Nach `/kill` ist die Session `archived`, aber der Name bleibt blockiert. Aktuell verhindert `parseNewArgs` jede Wiederverwendung mit `Session 'name' already exists`. UX-mäßig nervig — User erwartet dass ein gekillter Name wieder frei ist. Drei Lösungsansätze (TBD wann wir das fixen):
   - **A) Hard-Delete beim Kill**: `/kill` löscht die Row aus der DB. Einfach, aber Room-Verbindung und History-Referenz verloren.
   - **B) Rename beim Kill**: `/kill` hängt Timestamp an den Namen (`test-phase1-archived-1744223456`). Name wird frei, Historie bleibt nachvollziehbar.
   - **C) Collision-Check ignoriert archived**: `parseNewArgs` filtert `status='archived'` aus dem Namens-Check. Erfordert aber Aufheben der UNIQUE Constraint auf `name` in der DB (oder gleichzeitigen hard-delete auf rename).
   - **Tendenz**: Option B — wenig destruktiv, behält History, einfacher UNIQUE-Constraint bleibt. Nicht Scope für Phase 1, eigener kleiner PR.
10. **Name-Collision beim `/discover`-Attach**: Wenn `/discover #N` eine Session importiert deren `dirname-branch-shortid` Name schon von einer archivierten existiert, fällt's auf den Timestamp-Fallback (`...-1744223456`). Nicht ideal aber funktional. Lösung ergibt sich aus Punkt 9.
11. **Matrix Message Queue / Rate-Limiting**: Während Phase 1 Testing beobachtet: wenn mehrere `/new` Commands schnell hintereinander kommen, sprengen wir das Synapse `rc_message` Burst-Limit (default 10). Die Session wird zwar korrekt erstellt, aber die Bestätigung im Control Room bleibt aus (wird gedroppt). Auch der Invite-Check Fix (Phase 1) löst nur `rc_invites`, nicht `rc_message`.
    - **Was wir schon haben**: Crash-resistant — 429 Errors crashen den Supervisor nicht mehr (bot.ts:handleControlRoomMessage wraps error-send in try/catch).
    - **Was fehlt**: Eine zentrale Outbound-Queue die Matrix-Sends throttelt (z.B. max 5/s). Pro Message: enqueue → worker zieht aus Queue mit Throttle → bei 429 respektiere `retry_after_ms` und retry. User sieht "Processing..." bei langen Delays.
    - **Scope**: Eigener kleiner PR nach Phase 4. Nicht Teil des Auto-Handoff-Features, aber wichtig für robuste Multi-Session-Nutzung.
12. **Resume von nie-genutzten Sessions stirbt**: Beobachtet in Phase 1 Testing: `/new name` erstellt eine Session und spawnt Claude. Wenn der User nie eine Message schickt und direkt ein Restart passiert, stirbt der `claude --resume <id>` Prozess wenige Sekunden nach dem Start (JSONL ist leer oder fast leer). Die Session mit echter Konversations-History resumed sauber.
    - **Vermutung**: Claude Code hat eine Edge-Case wenn `--resume` auf einer effektiv leeren Session läuft. Kein Bug in unserem Code.
    - **Impact**: Nur bei "schnellem Ausprobieren" relevant. In echter Nutzung schickt man immer mindestens eine Message bevor die Session sinnvoll ist.
    - **Mögliche Lösungen** (TBD): (a) beim Restore checken ob JSONL leer ist und in dem Fall neue Session starten statt resume, (b) warten bis erste Message bevor wir in DB `status='active'` setzen, (c) beim Startup: leere Sessions auf `archived` setzen.
    - **Scope**: Nicht Phase 1. Wenn es in echter Nutzung stört, Follow-Up PR.

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
