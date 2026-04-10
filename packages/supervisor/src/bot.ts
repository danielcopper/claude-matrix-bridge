import {
  MatrixClient,
  SimpleFsStorageProvider,
  LogService,
  LogLevel,
} from 'matrix-bot-sdk'
import type Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import type { Session, SSEEvent } from './types.js'
import {
  getConfig,
  setConfig,
  getSessionByRoomId,
  updateSession,
  createPermissionRequest,
  getPermissionRequestByEventId,
  resolvePermissionRequest,
  nextFreePort,
  releasePort,
} from './database.js'
import { sendPermission, sendMessage, waitForHealth, connectSSE } from './relay-client.js'
import { spawnClaude } from './process-manager.js'
import { handleCommand } from './command-handler.js'
import { formatMarkdown, splitMessage } from './message-formatter.js'
import { buildReplay } from './replay.js'

const SDK_LOG_LEVELS: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
}

export function createBot(config: Config, logger: Logger): MatrixClient {
  LogService.setLevel(SDK_LOG_LEVELS[config.logLevel] ?? LogLevel.WARN)

  const storage = new SimpleFsStorageProvider('data/bot-sync.json')
  const client = new MatrixClient(
    config.matrix.homeserverUrl,
    config.matrix.accessToken,
    storage,
  )

  logger.info('Matrix client created')
  return client
}

export async function bootstrapSpaceAndRooms(
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<{ spaceId: string; controlRoomId: string }> {
  const domain = config.matrix.botUserId.split(':')[1]

  // --- Space ---
  let spaceId = getConfig(db, 'space_id')
  if (spaceId) {
    logger.info({ spaceId }, 'Using existing space')
  } else {
    // Try to resolve existing space by alias, or create new
    try {
      spaceId = await client.resolveRoom(`#claude-code:${domain}`)
      logger.info({ spaceId }, 'Found existing space by alias')
    } catch {
      logger.info('Creating Claude Code space')
      const space = await client.createSpace({
        name: 'Claude Code',
        topic: 'Claude Code remote sessions',
        isPublic: false,
        localpart: 'claude-code',
        invites: [config.matrix.ownerUserId],
      })
      spaceId = space.roomId
      logger.info({ spaceId }, 'Space created')
    }
    setConfig(db, 'space_id', spaceId)
  }

  // --- Control Room ---
  let controlRoomId = getConfig(db, 'control_room_id')
  if (controlRoomId) {
    logger.info({ controlRoomId }, 'Using existing control room')
  } else {
    // Try to resolve existing room by alias, or create new
    try {
      controlRoomId = await client.resolveRoom(`#claude-control:${domain}`)
      logger.info({ controlRoomId }, 'Found existing control room by alias')
    } catch {
      logger.info('Creating control room')
      controlRoomId = await client.createRoom({
        name: 'claude-control',
        topic: 'Claude Code control room — use /claude-help for commands',
        preset: 'private_chat',
        room_alias_name: 'claude-control',
        invite: [config.matrix.ownerUserId],
      })
    }
    setConfig(db, 'control_room_id', controlRoomId)
    logger.info({ controlRoomId }, 'Control room ready')

    // Ensure room is in space
    try {
      await client.sendStateEvent(spaceId, 'm.space.child', controlRoomId, {
        via: [domain],
        suggested: true,
      })
      await client.sendStateEvent(controlRoomId, 'm.space.parent', spaceId, {
        canonical: true,
        via: [domain],
      })
    } catch {
      // Already linked or no permission — ignore
    }
  }

  // Ensure owner is invited to both space and control room.
  // Check membership first (GET, not rate-limited) so we don't burn
  // through the invite rate limit with redundant M_FORBIDDEN failures.
  for (const roomId of [spaceId, controlRoomId]) {
    try {
      const members = await client.getJoinedRoomMembers(roomId)
      if (members.includes(config.matrix.ownerUserId)) continue
      await client.inviteUser(config.matrix.ownerUserId, roomId)
    } catch (err) {
      logger.warn({ err, roomId }, 'Could not ensure owner membership')
    }
  }

  return { spaceId, controlRoomId }
}

// --- SSE Event Handler ---

export function handleSSEEvent(
  event: SSEEvent,
  session: Session,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): void {
  if (!session.room_id) return

  const roomId = session.room_id

  switch (event.type) {
    case 'reply': {
      const chunks = splitMessage(event.content)
      void (async () => {
        try {
          await client.setTyping(roomId, false)
          for (const chunk of chunks) {
            const { body, formatted_body } = formatMarkdown(chunk)
            await client.sendMessage(roomId, {
              msgtype: 'm.text',
              body,
              format: 'org.matrix.custom.html',
              formatted_body,
            })
          }
          const now = new Date().toISOString()
          updateSession(db, session.id, { last_message_at: now, last_matrix_activity: now })
        } catch (err) {
          logger.error({ err, session: session.name }, 'Failed to send reply to Matrix')
        }
      })()
      break
    }

    case 'react': {
      logger.info({ session: session.name, emoji: event.emoji, messageId: event.message_id }, 'React event (not implemented yet)')
      break
    }

    case 'permission_request': {
      void (async () => {
        try {
          const parts = [
            `**Permission Request** [${event.request_id}]`,
            `Tool: \`${event.tool_name}\``,
            `${event.description}`,
          ]
          if (event.input_preview) {
            parts.push(`\`\`\`\n${event.input_preview}\n\`\`\``)
          }
          const msg = parts.join('\n')
          const { body: plain, formatted_body } = formatMarkdown(msg)
          const eventId = await client.sendMessage(roomId, {
            msgtype: 'm.text',
            body: plain,
            format: 'org.matrix.custom.html',
            formatted_body,
          })
          createPermissionRequest(db, {
            request_id: event.request_id,
            session_id: session.id,
            event_id: eventId,
            tool_name: event.tool_name,
            description: event.description,
            status: 'pending',
            created_at: new Date().toISOString(),
            resolved_at: null,
          })
          logger.info(
            { session: session.name, requestId: event.request_id, tool: event.tool_name },
            'Permission request posted',
          )
        } catch (err) {
          logger.error({ err, session: session.name }, 'Failed to post permission request')
        }
      })()
      break
    }
  }
}

// --- Shared permission verdict logic ---

async function sendPermissionVerdict(
  permReq: import('./types.js').PermissionRequest,
  behavior: 'allow' | 'deny',
  port: number,
  roomId: string,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): Promise<void> {
  await sendPermission(port, permReq.request_id, behavior)
  resolvePermissionRequest(db, permReq.request_id, behavior === 'allow' ? 'allowed' : 'denied')
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await client.sendText(roomId, `${label} — ${permReq.tool_name}`)
  logger.info(
    { requestId: permReq.request_id, behavior, tool: permReq.tool_name },
    'Permission verdict sent',
  )
}

// --- Permission verdict via single-word text ---

const ALLOW_WORDS = new Set(['yes', 'ja', 'jap', 'jo', 'sure', 'yep', 'yup', 'ok', 'okay', 'mach', 'klar', 'passt', 'allow', 'y', 'si', 'oui'])
const DENY_WORDS = new Set(['no', 'nein', 'ne', 'nope', 'nah', 'deny', 'stop', 'n', 'nicht', 'lass'])

function stripPunctuation(s: string): string {
  return s.replaceAll(/[^a-zA-ZäöüÄÖÜß]/g, '')
}

function tryTextPermissionVerdict(
  body: string,
  session: Session,
  db: Database.Database,
  client: MatrixClient,
  roomId: string,
  logger: Logger,
): boolean {
  if (body.includes(' ')) return false

  const pendingAll = db.prepare(
    'SELECT * FROM permission_requests WHERE session_id = ? AND status = ? ORDER BY created_at DESC',
  ).all(session.id, 'pending') as import('./types.js').PermissionRequest[]
  if (pendingAll.length === 0) return false

  const word = stripPunctuation(body.toLowerCase().trim())
  if (!ALLOW_WORDS.has(word) && !DENY_WORDS.has(word)) return false

  const pending = pendingAll[0]
  const behavior = ALLOW_WORDS.has(word) ? 'allow' as const : 'deny' as const
  const sessionPort = session.port
  if (!sessionPort || !pending) return false

  // Warn if multiple permissions are pending
  if (pendingAll.length > 1) {
    void client.sendText(roomId,
      `Note: ${pendingAll.length} permissions pending. Responding to the most recent: \`${pending.tool_name}\``,
    )
  }

  void (async () => {
    try {
      await sendPermissionVerdict(pending, behavior, sessionPort, roomId, client, db, logger)
    } catch (err) {
      logger.error({ err, requestId: pending.request_id }, 'Failed to send permission verdict')
    }
  })()
  return true
}

// --- Control room message handler ---

function handleControlRoomMessage(
  body: string,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  controlRoomId: string,
  logger: Logger,
): void {
  if (body.startsWith('/')) {
    void (async () => {
      try {
        const response = await handleCommand(body, client, db, config, controlRoomId, logger)
        const { body: plain, formatted_body } = formatMarkdown(response)
        await client.sendMessage(controlRoomId, {
          msgtype: 'm.text',
          body: plain,
          format: 'org.matrix.custom.html',
          formatted_body,
        })
      } catch (err) {
        logger.error({ err }, 'Command handler error')
        const msg = `Error: ${err instanceof Error ? err.message : err}`
        await client.sendText(controlRoomId, msg).catch((error_: unknown) => {
          logger.error({ err: error_ }, 'Failed to send error message to control room')
        })
      }
    })()
    return
  }
  logger.info({ body: body.slice(0, 100) }, 'Control room message (no routing yet)')
}

// --- Auto-Attach helpers ---

// Prevents concurrent auto-attach attempts for the same session.
const autoAttachInProgress = new Set<string>()

async function killLocalClaude(pid: number, logger: Logger): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
    logger.info({ pid }, 'Sent SIGTERM to local claude')
  } catch {
    return // Already dead
  }

  // Wait for JSONL flush
  await new Promise(r => setTimeout(r, 500))

  // If still alive, escalate to SIGKILL
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
    logger.info({ pid }, 'Sent SIGKILL to local claude (still alive after SIGTERM)')
  } catch {
    // Dead after SIGTERM — good
  }
}

async function autoAttachSession(
  session: Session,
  body: string,
  sender: string,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): Promise<void> {
  const roomId = session.room_id
  if (!roomId) return

  const wasLocal = session.status === 'local_active'

  // Allocate a fresh port — the old port (if any) may be stale or reused.
  const port = nextFreePort(db, config.ports.start, config.ports.end)
  if (!port) {
    await client.sendText(roomId, 'No free ports available. Cannot re-attach session.')
    return
  }

  // Set 'spawning' BEFORE killing local claude. This serves two purposes:
  // 1. The SessionEnd hook (from the dying local process) sees status != 'local_active' → skips
  // 2. The SessionStart hook (from our own spawn) sees status == 'spawning' → ignored
  updateSession(db, session.id, { status: 'spawning', port, local_pid: null })
  releasePort(port)

  if (wasLocal && session.local_pid) {
    await killLocalClaude(session.local_pid, logger)
  }

  const updated: Session = { ...session, status: 'spawning', port, local_pid: null }

  spawnClaude(updated, config, db, logger, {
    resume: true,
    onExit: () => {
      void client
        .sendHtmlText(roomId, '<strong>Claude session ended.</strong>')
        .catch(() => {})
    },
  })

  const healthy = await waitForHealth(port, logger, 30000)
  if (!healthy) {
    updateSession(db, session.id, { status: 'detached', port: null })
    await client.sendText(roomId, 'Failed to start session. Send a message to retry.')
    return
  }

  updateSession(db, session.id, { status: 'active' })

  connectSSE(
    port,
    (event) => handleSSEEvent(event, { ...updated, status: 'active' }, client, db, logger),
    (err) => logger.error({ err, session: session.name }, 'SSE connection error'),
    logger,
  )

  // Post replay of local activity before resuming Matrix conversation
  if (wasLocal) {
    const since = session.last_matrix_activity ? new Date(session.last_matrix_activity) : null
    const replay = buildReplay(session.id, session.working_directory, since, config.replay.maxPairs)
    if (replay) {
      await client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: replay.body,
        format: 'org.matrix.custom.html',
        formatted_body: replay.formatted_body,
      })
    }
    await client.sendText(roomId, 'Local session closed, Matrix control resumed.')
  } else {
    await client.sendText(roomId, 'Session re-attached.')
  }

  // Brief wait for Claude to fully initialize the channel after startup.
  // Health check only confirms the relay HTTP server is up — Claude needs
  // a moment longer to wire up the channel protocol after resume.
  await new Promise(r => setTimeout(r, 2000))

  await client.setTyping(roomId, true, 30000)
  await sendMessage(port, sender, body)
}

// --- Session room message handler ---

function handleSessionRoomMessage(
  body: string,
  sender: string,
  session: Session,
  roomId: string,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  logger: Logger,
): void {
  if (tryTextPermissionVerdict(body, session, db, client, roomId, logger)) return

  if (session.status === 'archived') {
    void client.sendText(roomId, `Session archived. Use \`/attach ${session.name}\` in control room.`)
    return
  }
  if (session.status === 'spawning') {
    void client.sendText(roomId, 'Session is starting up, please wait...')
    return
  }

  if (session.status === 'local_active' || session.status === 'detached') {
    if (autoAttachInProgress.has(session.id)) {
      void client.sendText(roomId, 'Re-attaching session, please wait...')
      return
    }
    autoAttachInProgress.add(session.id)
    void (async () => {
      try {
        await autoAttachSession(session, body, sender, client, db, config, logger)
      } catch (err) {
        logger.error({ err, session: session.name }, 'Auto-attach failed')
        await client.sendText(roomId, `Auto-attach failed: ${err instanceof Error ? err.message : err}`)
      } finally {
        autoAttachInProgress.delete(session.id)
      }
    })()
    return
  }

  const port = session.port
  if (!port) {
    void client.sendText(roomId, `Session has no port assigned. Use \`/attach ${session.name}\` in control room.`)
    return
  }

  void (async () => {
    try {
      await client.setTyping(roomId, true, 30000)
      await sendMessage(port, sender, body)
    } catch (err) {
      logger.error({ err, session: session.name }, 'Failed to relay message')
      await client.setTyping(roomId, false)
      await client.sendText(roomId, `Failed to send message to Claude: ${err instanceof Error ? err.message : err}`)
    }
  })()
}

// --- Event Handlers ---

export function setupEventHandlers(
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  controlRoomId: string,
  logger: Logger,
): void {
  // Ignore events older than supervisor startup. Protects against re-processing
  // historical commands when sync state is missing (fresh worktree, first run
  // without a bot-sync.json). 10s slack for clock skew.
  const ignoreBeforeMs = Date.now() - 10_000

  client.on('room.message', (roomId: string, event: Record<string, unknown>) => {
    const content = event.content as Record<string, unknown> | undefined
    if (!content?.msgtype) return
    const sender = event.sender as string
    if (sender === config.matrix.botUserId) return
    if (sender !== config.matrix.ownerUserId) return

    const ts = event.origin_server_ts
    if (typeof ts === 'number' && ts < ignoreBeforeMs) {
      logger.debug({ roomId, ts }, 'Ignoring stale event from before supervisor startup')
      return
    }

    const body = content.body as string
    if (!body) return

    if (roomId === controlRoomId) {
      handleControlRoomMessage(body, client, db, config, controlRoomId, logger)
      return
    }

    const session = getSessionByRoomId(db, roomId)
    if (!session) return

    handleSessionRoomMessage(body, sender, session, roomId, client, db, config, logger)
  })

  // Reaction handler for permission verdicts
  client.on('room.event', (roomId: string, event: Record<string, unknown>) => {
    if (event.type !== 'm.reaction') return
    const sender = event.sender as string
    if (sender !== config.matrix.ownerUserId) return

    const ts = event.origin_server_ts
    if (typeof ts === 'number' && ts < ignoreBeforeMs) return

    const content = event.content as Record<string, unknown>
    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined
    if (!relatesTo) return

    const emoji = relatesTo.key as string
    const targetEventId = relatesTo.event_id as string
    if (!targetEventId) return

    const permReq = getPermissionRequestByEventId(db, targetEventId)
    if (!permReq) return

    // Strip variation selectors (U+FE0F) — Matrix clients append them inconsistently
    const stripped = emoji.replaceAll('\uFE0F', '')
    const isAllow = stripped === '✅' || stripped === '👍'
    const isDeny = stripped === '❌' || stripped === '👎'
    if (!isAllow && !isDeny) return

    const behavior: 'allow' | 'deny' = isAllow ? 'allow' : 'deny'
    const session = getSessionByRoomId(db, roomId)

    const sessionPort = session?.port
    if (!sessionPort) return

    void (async () => {
      try {
        await sendPermissionVerdict(permReq, behavior, sessionPort, roomId, client, db, logger)
      } catch (err) {
        logger.error({ err, requestId: permReq.request_id }, 'Failed to send permission verdict')
      }
    })()
  })

  logger.info('Event handlers registered')
}
