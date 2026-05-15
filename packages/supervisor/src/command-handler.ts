import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { MatrixClient } from "matrix-bot-sdk";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { USER_PERMISSION_MODES, type Session, type DiscoveredSession, type UserPermissionMode } from "./types.js";
import {
  getSessionByName,
  getSessionById,
  getAllSessions,
  getActiveSessions,
  createSession,
  updateSession,
  getConfig,
  expireSessionPermissions,
  nextFreePort,
  releasePort,
} from "./database.js";
import { spawnClaude, killClaude, readPermissionMode, cycleToPermissionMode } from "./process-manager.js";
import { safeSendHtml } from "./matrix-send.js";
import { waitForHealth, connectSSE } from "./relay-client.js";
import { handleSSEEvent } from "./bot.js";
import { scanSessions } from "./session-scanner.js";

const startTime = Date.now();

// Temporary mapping from /discover results: number → DiscoveredSession
let discoverCache: DiscoveredSession[] = [];

export async function handleCommand(
  body: string,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  _controlRoomId: string,
  logger: Logger,
): Promise<string> {
  const parts = body.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "/new":
      return handleNew(
        parts.slice(1),
        client,
        db,
        config,
        logger,
      );
    case "/list":
      return handleList(db);
    case "/kill":
      return handleKill(parts[1], client, db, logger);
    case "/detach":
      return handleDetach(parts[1], db, logger);
    case "/attach":
      return handleAttach(parts[1], client, db, config, logger);
    case "/discover":
      return handleDiscover(parts[1], db);
    case "/status":
      return handleStatus(db, config);
    case "/claude-help":
      return handleHelp();
    default:
      return `Unknown command: \`${cmd}\`. Type /claude-help for available commands.`;
  }
}

function handleHelp(): string {
  return [
    "**Available commands:**",
    "",
    "`/new <working-dir> [name]` — Create new Claude session",
    "`/new <name>` — Use default working directory",
    "`/list` — List all sessions",
    "`/kill <name>` — End session (archive)",
    "`/detach <name>` — Detach session (for local work with claude --resume)",
    "`/attach <name>` — Re-attach detached/archived session",
    "`/attach #N` — Attach a discovered session by number",
    "`/discover [N]` — Find local Claude sessions (default: 10 most recent)",
    "`/status` — Show bot status",
    "`/claude-help` — Show this help",
  ].join("\n");
}

// --- /discover ---

function handleDiscover(limitArg: string | undefined, db: Database.Database): string {
  const limit = Math.max(1, Math.min(50, Number(limitArg) || 10))

  const allDiscovered = scanSessions()
  const knownIds = new Set(getAllSessions(db).map((s) => s.id))
  const unknown = allDiscovered
    .filter((s) => !knownIds.has(s.id))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, limit)

  if (unknown.length === 0) {
    discoverCache = []
    return "No new local sessions found."
  }

  discoverCache = unknown

  const rows = unknown.map((s, i) => {
    const dir = s.cwd.replace(homedir(), "~")
    const name = s.customTitle ?? s.slug ?? s.id.slice(0, 8)
    return `| ${i + 1} | ${name} | ${dir} | ${s.gitBranch ?? "-"} | ${timeAgo(s.lastActivity)} |`
  })

  return [
    `Found **${unknown.length}** local session(s). Use \`/attach #N\` to connect.`,
    "",
    "| # | Name | Directory | Branch | Last active |",
    "|---|------|-----------|--------|-------------|",
    ...rows,
  ].join("\n")
}

// --- /list ---

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function handleList(db: Database.Database): string {
  const sessions = getAllSessions(db);
  if (sessions.length === 0) return "No sessions.";

  const rows = sessions.map((s) => {
    const dir = s.working_directory.replace(homedir(), "~");
    const shortId = s.id.slice(0, 8);
    return `| ${s.name} | ${shortId} | ${dir} | ${s.status} | ${s.permission_mode} | ${timeAgo(s.last_message_at)} |`;
  });

  return [
    "| Name | ID | Directory | Status | Mode | Last activity |",
    "|------|----|-----------|--------|------|---------------|",
    ...rows,
  ].join("\n");
}

// --- /kill ---

async function handleKill(
  name: string | undefined,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): Promise<string> {
  if (!name) return "Usage: `/kill <name>`";

  const session = getSessionByName(db, name);
  if (!session) return `Session \`${name}\` not found.`;

  if (session.status === "archived")
    return `Session \`${name}\` is already archived.`;

  await killClaude(session, logger);

  // Rename to free the original name for reuse. Without this, /new <name>
  // after /kill <name> hits the UNIQUE constraint and is rejected. Suffix
  // is YYYYMMDD-HHMMSS so /list stays human-readable and entries sort.
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const archivedName = `${session.name}-archived-${ts}`;
  updateSession(db, session.id, {
    status: "archived",
    name: archivedName,
    pid: null,
    port: null,
  });
  expireSessionPermissions(db, session.id);

  // Rename the Matrix room to match so the user can tell which room is archived
  if (session.room_id) {
    void client.sendStateEvent(session.room_id, "m.room.name", "", { name: archivedName }).catch(() => {});
  }

  return `Session **${name}** archived as \`${archivedName}\`. Name \`${name}\` is now free for reuse.`;
}

// --- /detach ---

async function handleDetach(
  name: string | undefined,
  db: Database.Database,
  logger: Logger,
): Promise<string> {
  if (!name) return "Usage: `/detach <name>`";

  const session = getSessionByName(db, name);
  if (!session) return `Session \`${name}\` not found.`;

  if (session.status === "detached")
    return `Session \`${name}\` is already detached.`;
  if (session.status === "archived")
    return `Session \`${name}\` is archived. Use /attach first.`;

  await killClaude(session, logger);
  updateSession(db, session.id, { status: "detached", pid: null });
  expireSessionPermissions(db, session.id);

  return [
    `Session **${name}** detached.`,
    "",
    `Continue locally: \`claude --resume ${session.id}\``,
  ].join("\n");
}

// --- /attach ---

async function handleAttach(
  name: string | undefined,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<string> {
  if (!name) return "Usage: `/attach <name>` or `/attach #N` (from /discover)";

  // Handle #N reference from /discover
  if (name.startsWith("#")) {
    const idx = Number(name.slice(1)) - 1;
    const discovered = discoverCache[idx];
    if (!discovered) return `Invalid reference \`${name}\`. Run /discover first.`;
    return attachDiscovered(discovered, client, db, config, logger);
  }

  const session = getSessionByName(db, name);
  if (!session) return `Session \`${name}\` not found. Use /discover to find local sessions.`;

  if (session.status === "active" && session.pid) {
    return `Session \`${name}\` is already active.`;
  }

  return resumeSession(session, client, db, config, logger);
}

async function attachDiscovered(
  discovered: DiscoveredSession,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<string> {
  // Check if it was already attached since discovery
  const existing = getSessionById(db, discovered.id);
  if (existing) return resumeSession(existing, client, db, config, logger);

  const port = nextFreePort(db, config.ports.start, config.ports.end);
  if (port == null) return "No free ports available.";

  try {
    const name = discoveredName(discovered, db);
    const domain = config.matrix.botUserId.split(":")[1];
    const spaceId = getConfig(db, "space_id");

    const roomId = await client.createRoom({
      name,
      topic: `Claude session — ${discovered.cwd}`,
      preset: "private_chat",
      invite: [config.matrix.ownerUserId],
    });

    await addRoomToSpace(client, spaceId, roomId, domain, logger);

    const session: Session = {
      id: discovered.id,
      room_id: roomId,
      name,
      working_directory: discovered.cwd,
      model: config.claude.model,
      permission_mode: "default",
      port,
      pid: null,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
      local_pid: null,
      last_matrix_activity: null,
    };
    createSession(db, session);

    return await resumeSession(session, client, db, config, logger);
  } finally {
    releasePort(port);
  }
}

async function resumeSession(
  session: Session,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<string> {
  // Allocate port if needed (archived sessions have port = null)
  let port = session.port;
  let reservedHere = false;
  if (!port) {
    const allocated = nextFreePort(db, config.ports.start, config.ports.end);
    if (!allocated) return "No free ports available.";
    port = allocated;
    reservedHere = true;
  }

  // Mark spawning — our own SessionStart hook will see this and skip.
  updateSession(db, session.id, { status: "spawning", port });
  if (reservedHere) releasePort(port);
  const updated: Session = { ...session, status: "spawning", port };

  // Spawn with --resume
  spawnClaude(updated, config, db, logger, {
    resume: true,
    onExit: () => {
      if (session.room_id) {
        void client
          .sendHtmlText(
            session.room_id,
            "<strong>Claude session ended.</strong>",
          )
          .catch(() => {});
      }
    },
  });

  const healthy = await waitForHealth(port, logger, 30000);
  if (!healthy) {
    try {
      await killClaude(updated, logger);
    } catch (err) {
      logger.warn({ err, session: session.name }, "killClaude failed during failed-spawn cleanup");
    }
    updateSession(db, session.id, { status: "detached", port: null, pid: null });
    return `Session \`${session.name}\` failed to start. Use /attach to retry.`;
  }

  updateSession(db, session.id, { status: "active" });

  connectSSE(
    port,
    (event) => handleSSEEvent(event, { ...updated, status: "active" }, client, db, logger),
    (err) => logger.error({ err, session: session.name }, "SSE connection error"),
    logger,
  );

  if (session.room_id) {
    await client.sendHtmlText(
      session.room_id,
      "<strong>Session re-attached.</strong> Resumed with previous context.",
    );
  }

  return `Session **${session.name}** re-attached → [${session.name}](https://matrix.to/#/${session.room_id})`;
}

// --- /status ---

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function handleStatus(db: Database.Database, config: Config): string {
  const active = getActiveSessions(db);
  const all = getAllSessions(db);
  const usedPorts = active.filter((s) => s.port).map((s) => s.port);

  return [
    "**Supervisor Status**",
    "",
    `- Uptime: ${formatUptime(Date.now() - startTime)}`,
    `- Active sessions: ${active.length}`,
    `- Total sessions: ${all.length}`,
    `- Ports used: ${usedPorts.length > 0 ? usedPorts.join(", ") : "none"} (range ${config.ports.start}-${config.ports.end})`,
  ].join("\n");
}

// --- Shared helpers ---

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function discoveredName(discovered: DiscoveredSession, db: Database.Database): string {
  // Prefer user-set customTitle (not the auto-generated slug)
  if (discovered.customTitle) {
    const cleaned = discovered.customTitle
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/-+/g, "-");
    if (!getSessionByName(db, cleaned)) return cleaned;
  }

  // Fallback: dirname-branch-shortid
  const dirName = basename(discovered.cwd);
  const shortId = discovered.id.slice(0, 5);
  const parts = [dirName, discovered.gitBranch, shortId].filter(Boolean);
  const name = parts
    .join("-")
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-");

  if (!getSessionByName(db, name)) return name;
  return `${name}-${Date.now()}`;
}

function autoName(workDir: string, db: Database.Database): string {
  const dirName = basename(workDir);
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", workDir, "branch", "--show-current"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    // Not a git repo or git not available
  }

  const base = branch ? `${dirName}-${branch}` : dirName;
  let name = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-");

  if (!getSessionByName(db, name)) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`;
    if (!getSessionByName(db, candidate)) return candidate;
  }
  return `${name}-${Date.now()}`;
}


// --- /new ---

/** Pluck `--mode <value>` (or `--mode=value`) out of args, validating against
 *  the user-facing mode list. Returns the cleaned positional args + the
 *  parsed mode (or null if no flag), or an error message. */
export function extractModeFlag(
  args: string[],
): { positional: string[]; mode: UserPermissionMode | null } | string {
  const positional: string[] = [];
  let mode: UserPermissionMode | null = null;
  const allowed = USER_PERMISSION_MODES.join("|");

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--mode") {
      const next = args[i + 1];
      if (!next) return `Missing value for --mode. Expected one of: ${allowed}`;
      if (!(USER_PERMISSION_MODES as readonly string[]).includes(next)) {
        return `Invalid mode \`${next}\`. Expected one of: ${allowed}`;
      }
      mode = next as UserPermissionMode;
      i++;
    } else if (a.startsWith("--mode=")) {
      const next = a.slice("--mode=".length);
      if (!(USER_PERMISSION_MODES as readonly string[]).includes(next)) {
        return `Invalid mode \`${next}\`. Expected one of: ${allowed}`;
      }
      mode = next as UserPermissionMode;
    } else {
      positional.push(a);
    }
  }

  return { positional, mode };
}

function parseNewArgs(
  args: string[],
  config: Config,
  db: Database.Database,
): { workDir: string; name: string; mode: UserPermissionMode } | string {
  const flagResult = extractModeFlag(args);
  if (typeof flagResult === "string") return flagResult;
  const { positional, mode } = flagResult;

  if (positional.length === 0) {
    return "Usage: `/new <working-dir> [name] [--mode default|plan|acceptEdits|auto]`";
  }

  let workDir: string;
  let name: string | undefined;

  if (positional.length >= 2) {
    const dir = positional[0];
    const n = positional[1];
    if (!dir || !n) return "Usage: `/new <working-dir> [name]`";
    workDir = expandTilde(dir);
    name = n;
  } else {
    const arg = positional[0];
    if (!arg) return "Usage: `/new <working-dir> [name]` or `/new <name>`";
    const expanded = expandTilde(arg);
    if (existsSync(expanded)) {
      workDir = expanded;
    } else {
      workDir = config.claude.defaultWorkDir;
      name = arg;
    }
  }

  workDir = resolve(workDir);
  if (!existsSync(workDir)) return `Directory not found: \`${workDir}\``;
  if (!name) name = autoName(workDir, db);
  if (getSessionByName(db, name)) return `Session \`${name}\` already exists. Choose a different name.`;

  return { workDir, name, mode: mode ?? "default" };
}

async function addRoomToSpace(
  client: MatrixClient,
  spaceId: string | undefined,
  roomId: string,
  domain: string,
  logger: Logger,
): Promise<void> {
  if (!spaceId) return
  try {
    await client.sendStateEvent(spaceId, "m.space.child", roomId, {
      via: [domain],
      suggested: true,
    });
    await client.sendStateEvent(roomId, "m.space.parent", spaceId, {
      canonical: true,
      via: [domain],
    });
  } catch (err) {
    logger.warn({ err }, "Failed to add room to space");
  }
}

async function handleNew(
  args: string[],
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<string> {
  const parsed = parseNewArgs(args, config, db);
  if (typeof parsed === "string") return parsed;
  const { workDir, name, mode } = parsed;

  const port = nextFreePort(db, config.ports.start, config.ports.end);
  if (port == null) {
    return `No free ports available (${config.ports.start}-${config.ports.end}). Kill some sessions first.`;
  }

  try {
    const domain = config.matrix.botUserId.split(":")[1];
    const spaceId = getConfig(db, "space_id");

    logger.info({ name, workDir, port }, "Creating session");
    const roomId = await client.createRoom({
      name,
      topic: `Claude session — ${workDir}`,
      preset: "private_chat",
      invite: [config.matrix.ownerUserId],
    });

    await addRoomToSpace(client, spaceId, roomId, domain, logger);

    const session: Session = {
      id: randomUUID(),
      room_id: roomId,
      name,
      working_directory: workDir,
      model: config.claude.model,
      permission_mode: mode,
      port,
      pid: null,
      status: "spawning",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
      local_pid: null,
      last_matrix_activity: null,
    };
    createSession(db, session);

    spawnClaude(session, config, db, logger, {
      onExit: () => {
        void client
          .sendHtmlText(roomId, "<strong>Claude session ended.</strong>")
          .catch(() => {});
      },
    });

    const healthy = await waitForHealth(port, logger, 30000);
    if (!healthy) {
      try {
        await killClaude(session, logger);
      } catch (err) {
        logger.warn({ err, session: session.name }, "killClaude failed during failed-spawn cleanup");
      }
      updateSession(db, session.id, { status: "detached", port: null, pid: null });
      return `Session \`${name}\` created but failed to start. Use /attach to retry.`;
    }

    updateSession(db, session.id, { status: "active" });
    const active: Session = { ...session, status: "active" };

    connectSSE(
      port,
      (event) => handleSSEEvent(event, active, client, db, logger),
      (err) => logger.error({ err, session: name }, "SSE connection error"),
      logger,
    );

    await client.sendHtmlText(
      roomId,
      `<strong>Session started.</strong> Working directory: <code>${workDir}</code>`,
    );

    return `Session **${name}** created → [${name}](https://matrix.to/#/${roomId})`;
  } finally {
    // Port is now in DB (or session creation failed); release the reservation.
    releasePort(port);
  }
}

// --- !mode (in-session bridge command) ---
//
// Lives in session rooms so users can switch permission modes without
// disturbing the running claude. Uses tmux send-keys to cycle the TUI and
// reads the resulting mode from the session JSONL.
//
// `/` is reserved for claude's own slash commands and skills. `:` was
// considered but conflicts with Element's emoji autocomplete. `!` (mautrix
// convention) is the only prefix.

const MODE_COMMAND_RE = /^!mode(?:\s+(.*))?$/;
const MODE_LIST_HTML = "default | plan | acceptEdits | auto";

/** Map user input to a canonical UserPermissionMode. Case-insensitive; also
 *  accepts the shorter alias `edit` / `edits` for `acceptEdits`. Returns null
 *  for unknown values. */
function resolveModeAlias(raw: string): UserPermissionMode | null {
  const lower = raw.toLowerCase();
  if (lower === "edit" || lower === "edits" || lower === "acceptedits") return "acceptEdits";
  for (const m of USER_PERMISSION_MODES) {
    if (m.toLowerCase() === lower) return m;
  }
  return null;
}

/** Cheap sync check used in the message handler to decide whether to
 *  intercept before forwarding to claude. */
export function isModeCommand(body: string): boolean {
  return MODE_COMMAND_RE.test(body.trim());
}

/** Handle a session-room `!mode` / `:mode` message. Posts the response into
 *  the same room. Caller already confirmed this is a mode command. */
export async function handleModeCommand(
  body: string,
  session: Session,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): Promise<void> {
  const roomId = session.room_id;
  if (!roomId) return;

  const match = body.trim().match(MODE_COMMAND_RE);
  const argRaw = match?.[1]?.trim() ?? "";

  // No args → report current mode
  if (!argRaw) {
    if (session.status !== "active") {
      await safeSendHtml(
        client,
        roomId,
        `<i>Session is <b>${session.status}</b> — current mode is whatever DB says (<b>${session.permission_mode}</b>), but no live terminal to confirm. Use <code>/attach</code> to bring it active.</i>`,
        logger,
        "mode:report-inactive",
      );
      return;
    }
    const current = readPermissionMode(session.id, session.working_directory);
    if (current === null) {
      await safeSendHtml(
        client,
        roomId,
        `<i>Couldn't read terminal — session may be initializing. DB says: <b>${session.permission_mode}</b>.</i>`,
        logger,
        "mode:report-unreadable",
      );
      return;
    }
    await safeSendHtml(
      client,
      roomId,
      `<i>Mode: <b>${current}</b>. Change with <code>!mode &lt;${MODE_LIST_HTML}&gt;</code>.</i>`,
      logger,
      "mode:report",
    );
    return;
  }

  // Validate target — case-insensitive, with `edit` alias for `acceptEdits`
  const target = resolveModeAlias(argRaw);
  if (target === null) {
    await safeSendHtml(
      client,
      roomId,
      `<i>Unknown mode <code>${escapeHtmlMin(argRaw)}</code>. Valid: ${MODE_LIST_HTML} (case-insensitive; <code>edit</code> works for <code>acceptEdits</code>).</i>`,
      logger,
      "mode:invalid-arg",
    );
    return;
  }

  if (session.status !== "active") {
    await safeSendHtml(
      client,
      roomId,
      `<i>Can't switch mode — session is <b>${session.status}</b>. Re-attach in the control room first.</i>`,
      logger,
      "mode:not-active",
    );
    return;
  }

  const result = await cycleToPermissionMode(session, target, logger);

  // Always sync the DB to whatever we observed, even on failure — the JSONL
  // is the source of truth and the DB shouldn't drift away from it.
  if (result.mode && result.mode !== session.permission_mode) {
    updateSession(db, session.id, { permission_mode: result.mode });
  }

  if (result.ok) {
    await safeSendHtml(
      client,
      roomId,
      `<i>Mode → <b>${target}</b></i>`,
      logger,
      "mode:switched",
    );
    return;
  }

  await safeSendHtml(
    client,
    roomId,
    `<i>Couldn't switch to <b>${target}</b>: ${result.reason ?? "unknown reason"}. Current: <b>${result.mode ?? "unknown"}</b>. If this persists, attach to the tmux pane and try Shift+Tab manually.</i>`,
    logger,
    "mode:failed",
  );
}

function escapeHtmlMin(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
