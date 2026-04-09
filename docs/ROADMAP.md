# Roadmap

Priorisierte Feature-Liste basierend auf aktuellem Stand und neuen Claude Code Platform-Features (Stand April 2026).

## Aktueller Stand

Phase 1 MVP + Session Handoff + Session Discovery abgeschlossen (PRs #1-#9).
Channels-basierte Architektur: matrix-relay MCP-Plugin + Supervisor mit tmux.

## Nächste Schritte

### 1. Auto Handoff Matrix ↔ Terminal

**Priorität**: Hoch — Kernfeature für nahtlose Nutzung
**Branch**: siehe [AUTO_HANDOFF.md](AUTO_HANDOFF.md)

Detaillierter Plan: [docs/AUTO_HANDOFF.md](AUTO_HANDOFF.md)

Phasen:
1. **Phase 1**: `tmux -L claude-matrix-bridge` dedicated socket (Polish)
2. **Phase 2**: Auto-Detach via SessionStart-Hook mit PID
3. **Phase 3**: Auto-Attach bei Matrix-Message (kill lokalen Claude + resume)
4. **Phase 4**: History-Replay beim Auto-Attach
5. **Phase 5**: Polish (System-Prompt, Edge Cases, Obergrenzen)

### 2. HTTP Hooks (statt Shell-Script)

**Priorität**: Niedrig — Nice-to-have
**Claude Code Version**: v2.1.63+

Claude Code unterstützt native HTTP Hooks. Unser aktuelles Shell-Script könnte durch einen direkten HTTP-Hook ersetzt werden.

**ABER**: Bei früherer Recherche gefunden, dass SessionStart HTTP-Hooks laut Bug-Report nicht zuverlässig funktionieren. Außerdem kann `if`-Conditional keine Env-Vars prüfen. Das Shell-Script ist aktuell robuster. Zurückgestellt.

### 3. StopFailure Hook

**Priorität**: Mittel — Verbessert Observability
**Claude Code Version**: v2.1.78+

Feuert bei API-Errors, Rate Limits, Auth-Fehlern. Matrix-User sieht sofort wenn Claude crashed.

### 4. Weitere Phase 3 Ideas

- **Live Streaming** — Bot-Message editieren während Claude tippt (`m.replace`)
- **File Uploads** — Dateien aus Matrix an Claude weiterleiten
- **GitHub Integration** — Issue-Titel als Raumnamen
- `/rename` — Session + Matrix-Room umbenennen
- **Permission UX** — Vollen Command/Input anzeigen; auto-allowed Tools rausfiltern
- **Control Room Claude** — Natürlichsprachliche Commands statt Slash-Commands

## Verworfene / Zurückgestellte Ideas

### Agent SDK Migration

Prototypiert auf Branch `refactor/agent-sdk` (verworfen). Gründe siehe [ADR in AUTO_HANDOFF.md](AUTO_HANDOFF.md#adr-sdk-vs-channels).

Kurz: Channels sind expliziter für den Remote-Messaging Use Case designed, bieten native Matrix/Lokal-Unterscheidung im JSONL (wichtig für Replay), und benötigen keine Workarounds. SDK wäre einfacher im Code, aber mit mehr Custom-Logik und weniger TOS-Klarheit.

### Raw History Replay (ohne State-Machine)

Ursprünglich als eigenständiges Feature geplant. Jetzt integriert in den Auto-Handoff-Flow (Phase 4), weil nur dort wirklich nötig.

## Referenz: Relevante Claude Code Platform-Updates

| Feature | Version | Beschreibung |
|---|---|---|
| HTTP Hooks | v2.1.63 | POST JSON an URL statt Shell-Command |
| `StopFailure` Hook | v2.1.78 | Feuert bei API-Errors, Rate Limits |
| `CwdChanged` / `FileChanged` Hooks | v2.1.83 | Richer Status-Info |
| Conditional `if` in Hooks | v2.1.85 | Effizientere Hook-Filterung (nur für Tool-Events) |
| `PermissionDenied` Hook | v2.1.89 | Auto-Mode Denial-Benachrichtigung |
| `defer` Permission Decision | v2.1.89 | Headless Sessions können pausieren |
