# Tech Debt & Code Audit

Stand: 2026-04-12 (nach Phase 5 #4 PR)

Dieses Dokument sammelt offene Punkte außerhalb der Phasen-Roadmap: beobachtete Code-Smells, Latent-Bugs, fehlende Features und eine priorisierte Reihenfolge für kleine Follow-Up-PRs. Der Phasen-Plan und die ausführlichen TBDs leben weiter in `AUTO_HANDOFF.md`.

---

## TBD-Status-Übersicht

Die zwölf TBDs aus `AUTO_HANDOFF.md:520-546` verdichtet. Details pro Punkt dort.

| # | Thema | Status |
|---|---|---|
| 1 | Replay-Länge-Obergrenze (20 Paare hart vs. Summary) | offen, lebt mit Default |
| 2 | Kill→Resume Race-Window (500ms fest vs. File-Watch) | lebt mit 500ms, bisher unproblematisch |
| 3 | Kill-Signal-Eskalation | implementiert aggressiver als TBD (500ms → SIGKILL) |
| 4 | Parallele Matrix-Messages während Auto-Attach | gelöst via `autoAttachInProgress` Set — siehe Latent-Bug in §1.2 |
| 5 | Lokaler Claude ohne unsere Hooks | akzeptierter degraded-Fallback |
| 6 | Remote-Supervisor + lokaler User | out of scope |
| 7 | Fork-Sessions (`--fork`) | akzeptierter `/discover`-Workaround |
| 8 | Permission-Requests während lokal | kein Problem (JSONL persistiert) |
| **9** | **Session-Name-Reuse nach `/kill`** | **offen, Tendenz Option B (rename-on-kill mit Timestamp)** |
| 10 | Name-Collision bei `/discover` | löst sich mit #9 |
| **11** | **Matrix Outbound Queue / Rate-Limiting** | **offen, beobachtetes UX-Problem** |
| **12** | **Resume leerer Sessions stirbt** | **offen, beobachtet** |

Die fett markierten (#9, #11, #12) sind die Kandidaten für konkrete Follow-Up-PRs.

---

## 1. Echte Bugs (verifiziert gegen aktuellen Code)

### 1.1 `spawning` ist ein Schwarzes Loch nach Crash

`packages/supervisor/src/index.ts:90` ruft `getActiveSessions()` auf, das nur `status='active'` zurückgibt. Eine Session, die beim Supervisor-Crash in `spawning` steckengeblieben ist (Crash zwischen `updateSession(... spawning)` und `updateSession(... active)`), wird beim Restart nie wieder angefasst:

- Recovery-Loop überspringt sie (`getActiveSessions` filtert sie aus)
- `/attach` im Command-Handler filtert `spawning` explizit heraus
- Kein automatischer Normalisierungs-Schritt irgendwo

**Severity**: Medium. Tritt nur im ~1-2s-Fenster zwischen den beiden `updateSession`-Aufrufen auf, macht die Session aber danach unerreichbar.

**Fix-Skizze**: Im Recovery-Loop (`index.ts:88` ff) vor `getActiveSessions()` einen Normalisierungs-Step einfügen: `UPDATE sessions SET status='detached' WHERE status='spawning'`. Der User kann sie danach via `/attach` wieder hochziehen.

### 1.2 `autoAttachInProgress` Set kann hängenbleiben bei Matrix-Hang

`packages/supervisor/src/bot.ts:500-510`. Der `.finally()`-Block entfernt den Eintrag nur wenn `autoAttachSession` returned oder throws. Wenn aber ein Matrix-API-Call **hängt** (nicht throws, nicht returns — matrix-bot-sdk hat keine Client-Timeouts per Default), hängt die ganze Auto-Attach-Kette, und der Set-Eintrag bleibt forever. Jede weitere Matrix-Message in diesem Room bekommt dann „Re-attaching session, please wait..." ohne jemals rauszukommen.

**Wichtig**: Der Phase-5-#4-PR (retry-Wrapper aus `retry.ts`/`matrix-send.ts`) fixt das **nicht**. Der `withRetry`-Helper retryt nur bei Errors, nicht bei Hangs. Timeout-Logik fehlt.

**Severity**: Medium, latent. Unter gesunden Netzwerk-Bedingungen nicht reproduzierbar, bei Matrix-Homeserver-Hang oder Paket-Loss fatal.

**Fix-Skizze**: Entweder
- Wallclock-Timeout auf den Set-Eintrag (z.B. `setTimeout` der nach 60s den Eintrag auto-cleared und loud loggt), oder
- `AbortSignal.timeout(30000)` in den safe-Helpern um die `client.*`-Calls herumgelegt.

### 1.3 Tmux-Server-Kill beim Startup fehlt (zu verifizieren)

Laut `AUTO_HANDOFF.md:266-277` sollte der Recovery-Flow Schritt 4 `tmux -L claude-matrix-bridge kill-server` sein. In `index.ts` ist der Aufruf beim Code-Review nicht offensichtlich auffindbar — `killAllProcesses` existiert in `process-manager.ts`, wird aber nur beim Shutdown aus `index.ts:161` aufgerufen.

**Severity**: Unklar bis verifiziert. Falls der Kill wirklich fehlt, wäre das eine Phase-1-Regression.

**TODO**: Code-Stelle finden oder bestätigen dass fehlt. Falls fehlt: vor `getActiveSessions()` im Startup einen `tmux -L claude-matrix-bridge kill-server || true` Aufruf einfügen.

---

## 2. Code-Smells (nicht exploitbar, aber fragil)

> **Hinweis**: Diese Punkte wurden von einem Explore-Agent als „high severity" geflaggt. Die Verifikation gegen den aktuellen Code zeigt aber: **nicht exploitbar** in der heutigen Codebase. Trotzdem fragile Patterns die man bei Gelegenheit aufräumen sollte.

### 2.1 `updateSession` baut Feldnamen dynamisch

`packages/supervisor/src/database.ts:153-166`:

```ts
const sets = entries.map(([k]) => `${k} = @${k}`).join(', ')
db.prepare(`UPDATE sessions SET ${sets}, updated_at = @updated_at WHERE id = @id`).run(...)
```

`Partial<Session>` ist TypeScript-beschränkt. Alle aktuellen Call-Sites übergeben hardcodierte Keys (`{ status: 'active' }`, `{ pid: null }` etc.). Es gibt keinen Pfad wo User-Input zu einem Feldnamen wird.

**Echte Severity**: Low (Defense-in-Depth / Wartbarkeit). Fragil für künftige Caller die den Type umgehen.

**Fix-Skizze**: Whitelist-basierter Setter oder ein `switch` über die erlaubten Keys. Nicht dringend.

### 2.2 Tmux-Command-Assembly via Shell-String

`packages/supervisor/src/process-manager.ts:109-110`:

```ts
const quotedArgs = claudeArgs.map(quoteArg).join(' ')
const claudeCmd = `RELAY_PORT=${session.port} claude ${quotedArgs}`
```

tmux `new-session <command>` exekutiert via `sh -c`. **Nicht exploitbar heute**, weil:
- `session.id` ist UUID (via `randomUUID()`)
- `session.port` ist Number
- `session.name` wird sanitized im Command-Handler bevor gespeichert
- `model`/`permission_mode` sind constrained Enums
- `quoteArg()` wrappt jedes Arg in single quotes

**Risiko-Vektor**: Eine künftige neue Input-Quelle die unsanitized in `claudeArgs` landet.

**Severity**: Low. Fragiles Pattern.

**Fix-Skizze**: Command nicht als Shell-String bauen sondern via Env-Var + explizite Args, oder minimal `quoteArg()` gegen Single-Quote-Escapes absichern.

---

## 3. Resilienz-Gaps

### 3.1 Kein SSE-Reconnect

`packages/supervisor/src/relay-client.ts:113-137`. Wenn die SSE-Verbindung zum Relay abbricht (Backpressure, Bun-HTTP-Hiccup), geht der Error an den `onError`-Callback und keine Reconnect-Logik greift. Die Session ist dann bis zum nächsten manuellen Trigger tot.

**Severity**: Low-Medium. In der Praxis selten, aber mit unscharfer Failure-Mode.

**Fix-Skizze**: Im `connectSSE`-Caller-Pfad oder im `onError`-Callback einen Reconnect mit Exponential Backoff. Wiederverwendung des `retry.ts`-Helpers möglich.

### 3.2 Keine Auth auf der HTTP-API

`packages/supervisor/src/api.ts`. Keinerlei Authentication auf `/api/session/start` und `/api/session/end`. Jeder lokale Prozess kann Session-State-Transitionen triggern.

**Threat-Model-Kontext**: Single-User-Laptop-Tool → akzeptabel. Wenn der Supervisor jemals auf einer Shared Machine läuft → Problem.

**Severity**: Low (heute), Medium (zukünftig).

**Fix-Skizze**: Shared Secret im `.env`, Header-Check in den Route-Handlern, `session-hook.sh` schickt das Secret mit. ~30 Zeilen Änderung.

### 3.3 Keine Config-Validation beim Startup

`packages/supervisor/src/config.ts`. Env-Variablen werden geladen, aber nicht validiert. Ungültiger Port-Range (`9000-8000`), fehlendes Access-Token, nicht erreichbarer Homeserver → Supervisor startet trotzdem und failed irgendwo später mysteriös.

**Severity**: Low. Aber spart bei Onboarding und Config-Refactors stundenlange Debug-Sessions.

**Fix-Skizze**: Zod-Schema am Startup, fail-fast bei ungültiger Config mit klarer Error-Message.

### 3.4 Kein Health-Endpoint für externes Monitoring

Der Supervisor hat `checkHealth(port)` **für den Relay**, aber keinen eigenen Health-Check. Kein Weg für externes Monitoring (systemd, Prometheus, manuell) festzustellen ob's dem Supervisor gut geht.

**Severity**: Low.

**Fix-Skizze**: `GET /api/health` in `api.ts` — checkt DB-Verbindung, Matrix-Client-Status, zählt aktive Sessions, liefert JSON.

### 3.5 Kein DB-Backup / Snapshot

`data/bot.db` ist die einzige Source of Truth für Session-Metadaten. Korruption = alle Session-State-Daten weg.

**Severity**: Low (bei seltenem Write-Volume unrealistisch), aber hart wenn's trifft.

**Fix-Skizze**: Beim Startup Snapshot nach `data/bot.db.bak-YYYY-MM-DD`, Rotation nach N Tagen.

### 3.6 Kein Idle-Session-Timeout

Sessions in `active`/`local_active` leben ewig. Ports bleiben belegt.

**Severity**: Low. Bei intensivem Nutzungsmuster könnte der konfigurierte Port-Range mit Zombies volllaufen.

**Fix-Skizze**: Startup-Task: Sessions ohne Activity > N Tage → `archived`.

---

## 4. Fehlende Features

- **E2EE-Support** — matrix-bot-sdk kann Crypto, aber der Supervisor hat kein Crypto-Setup. Verschlüsselte Rooms funktionieren nicht.
- **Graceful SIGKILL-Recovery** — `shutdown()` (`index.ts:157-171`) läuft nur bei SIGTERM/SIGINT. Bei SIGKILL (OOM-Killer, `kill -9`) sind tmux-Sessions orphaned — das MUSS der Startup-Recovery aufräumen, siehe §1.3.
- **TBD #11 — Matrix Outbound Queue** — explizit in AUTO_HANDOFF.md getrackt, nicht umgesetzt. Beobachtetes UX-Problem (Burst-`/new` verliert Bestätigungen).

---

## 5. Der größte Gap: Null Tests

Der Codebase hat 5 Session-States, ~10 Transitionen, Concurrency (`autoAttachInProgress`, Port-Allocation), Hook-API, Replay-Parser — **kein einziges Test-File**.

Das ist die offensichtlichste Achilles-Ferse. Das Tool läuft weil die Logik überschaubar ist und jemand sie im Kopf hat. Sobald man drei Monate wegguckt, wird jeder Refactor ein Glücksspiel.

**Höchsten-Hebel-Tests** (in Reihenfolge):

1. **Replay-Parser** (`packages/supervisor/src/replay.ts`) — reine Funktion, JSONL-Parsing, viele Edge-Cases (leerer Content, malformed JSON, `isMeta`-Filter, `maxPairs`-Truncation, tool-Result-Skipping). Trivialer Einstieg in Testing ohne Mocks.
2. **State-Machine-Transitionen** (`packages/supervisor/src/api.ts` Hook-Handler) — Tabelle: gegeben Status X + Event Y → erwarteter neuer Status + erwartete Side-Effects. Benötigt DB-Fixture, sonst Mocks minimal.
3. **Port-Allocation unter Concurrency** (`packages/supervisor/src/database.ts:nextFreePort` + `releasePort`) — kritisch weil es ein Race-Window bei parallelen `/new`-Commands gibt.

---

## 6. Ehrliches Gesamturteil

**Qualitätsstufe**: solides personal tool, nicht production-grade.

**Pro:**
- Architektur sauber (Supervisor als Koordinator, Relay als dummer Proxy, State-Machine klar dokumentiert)
- Logging konsistent (pino überall, strukturiert)
- Recovery-Flow durchdacht und in `AUTO_HANDOFF.md` begründet
- Angenehm zu lesen, keine Over-Abstraktion
- Separation of Concerns zwischen `bot.ts` (Matrix-Events), `process-manager.ts` (tmux), `relay-client.ts` (HTTP/SSE), `database.ts` (Persistenz) ist sauber

**Contra:**
- **Null Tests** bei nicht-trivialer State-Machine-Komplexität
- Mehrere latent-hang-Szenarien die erst bei pathologischen Netzwerk-Bedingungen auftauchen
- Config/Setup hat keine Validation — Onboarding-Risiko
- `spawning`-Recovery-Gap ist ein echter Bug der jeden Nutzer treffen kann der einen Crash erlebt

**Einschätzung**: Für einen einzelnen erfahrenen User der das Tool täglich selbst nutzt und debuggen kann — völlig ok. Für Publish-Ready oder Team-Use deutlich zu wenig Test-Sicherheit und zu viele Latent-Issues.

---

## 7. Priorisierter Fix-Plan

Kleine, unabhängige PRs in dieser Reihenfolge:

1. **`spawning`-Recovery-Gap fixen** (§1.1) — kleinster PR, echter Bug, <30 Zeilen
2. **Replay-Parser Unit-Tests** (§5) — pure Funktion, einfachster Testing-Einstieg, gibt sofort Confidence für Refactors
3. **Config-Validation mit Zod** (§3.3) — ~1h Arbeit, massiver Debug-Zeit-Gewinn
4. **TBD #11 Matrix Outbound Queue** — reales UX-Problem, direkter Gewinn
5. **`autoAttachInProgress` Wallclock-Timeout** (§1.2) — verhindert den Matrix-Hang-Latent-Bug
6. **Tmux-Kill-Server beim Startup verifizieren** (§1.3) — falls fehlt, Phase-1-Regression fixen

Punkte 1-3 sind kleine PRs mit großem Hebel. Die fortgeschrittenen Themen (#4-6) danach.

Nicht in diesem Plan: TBD #9 (Name-Reuse), TBD #12 (Empty-Session-Resume), E2EE, SSE-Reconnect, HTTP-API-Auth, Idle-Timeout — alles valide aber niedrigerer Hebel als die Top 6.

---

*Erstellt im Rahmen von PR #16 (Phase 5 #4, `feature/auto-attach-retry`). Quelle: Codebase-Lesung + verifizierter Output eines Explore-Agents, bewusst gegen den Code gegen-verifiziert um überzogene „high severity"-Claims zurückzustufen.*
