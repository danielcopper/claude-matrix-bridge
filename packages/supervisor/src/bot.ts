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
} from './database.js'
import { sendPermission, sendMessage } from './relay-client.js'
import { handleCommand } from './command-handler.js'
import { formatMarkdown, splitMessage } from './message-formatter.js'

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
          updateSession(db, session.id, { last_message_at: new Date().toISOString() })
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
          const msg = [
            `**Permission Request** [${event.request_id}]`,
            `Tool: \`${event.tool_name}\``,
            `${event.description}`,
          ].join('\n')
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

// --- Session room message handler ---

function handleSessionRoomMessage(
  body: string,
  sender: string,
  session: Session,
  roomId: string,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): void {
  if (tryTextPermissionVerdict(body, session, db, client, roomId, logger)) return

  if (session.status === 'detached') {
    void client.sendText(roomId, `Session detached. Use \`/attach ${session.name}\` in control room.`)
    return
  }
  if (session.status === 'archived') {
    void client.sendText(roomId, `Session archived. Use \`/attach ${session.name}\` in control room.`)
    return
  }
  if (session.status === 'local_active') {
    // Phase 3 will implement auto-attach (kill local PID + resume + reply).
    // For Phase 2, just inform the user that the session is locked to the terminal.
    void client.sendText(
      roomId,
      `Session is currently active in a local terminal (PID ${session.local_pid ?? '?'}). Exit the local claude first or wait for Phase 3 auto-attach.`,
    )
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
  client.on('room.message', (roomId: string, event: Record<string, unknown>) => {
    const content = event.content as Record<string, unknown> | undefined
    if (!content?.msgtype) return
    const sender = event.sender as string
    if (sender === config.matrix.botUserId) return
    if (sender !== config.matrix.ownerUserId) return

    const body = content.body as string
    if (!body) return

    if (roomId === controlRoomId) {
      handleControlRoomMessage(body, client, db, config, controlRoomId, logger)
      return
    }

    const session = getSessionByRoomId(db, roomId)
    if (!session) return

    handleSessionRoomMessage(body, sender, session, roomId, client, db, logger)
  })

  // Reaction handler for permission verdicts
  client.on('room.event', (roomId: string, event: Record<string, unknown>) => {
    if (event.type !== 'm.reaction') return
    const sender = event.sender as string
    if (sender !== config.matrix.ownerUserId) return

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
