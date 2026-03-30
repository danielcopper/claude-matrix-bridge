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
import { getConfig, setConfig, getSessionByRoomId, updateSession } from './database.js'
import { handleCommand } from './command-handler.js'
import { sendMessage } from './relay-client.js'
import { formatMarkdown, splitMessage } from './message-formatter.js'

export function createBot(config: Config, logger: Logger): MatrixClient {
  LogService.setLevel(LogLevel.WARN)

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
    logger.info('Creating Claude Code space')
    const space = await client.createSpace({
      name: 'Claude Code',
      topic: 'Claude Code remote sessions',
      isPublic: false,
      localpart: 'claude-code',
      invites: [config.matrix.ownerUserId],
    })
    spaceId = space.roomId
    setConfig(db, 'space_id', spaceId)
    logger.info({ spaceId }, 'Space created')
  }

  // --- Control Room ---
  let controlRoomId = getConfig(db, 'control_room_id')
  if (controlRoomId) {
    logger.info({ controlRoomId }, 'Using existing control room')
  } else {
    logger.info('Creating control room')
    controlRoomId = await client.createRoom({
      name: 'claude-control',
      topic: 'Claude Code control room — use /claude-help for commands',
      preset: 'private_chat',
      room_alias_name: 'claude-control',
      invite: [config.matrix.ownerUserId],
    })

    // Add to space
    await client.sendStateEvent(spaceId, 'm.space.child', controlRoomId, {
      via: [domain],
      suggested: true,
    })
    await client.sendStateEvent(controlRoomId, 'm.space.parent', spaceId, {
      canonical: true,
      via: [domain],
    })

    setConfig(db, 'control_room_id', controlRoomId)
    logger.info({ controlRoomId }, 'Control room created')
  }

  // Ensure owner is invited to both space and control room
  for (const roomId of [spaceId, controlRoomId]) {
    try {
      await client.inviteUser(config.matrix.ownerUserId, roomId)
    } catch {
      // Already joined or invited — ignore
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
      // Permission handling comes in PR 2c
      logger.info(
        { session: session.name, requestId: event.request_id, tool: event.tool_name },
        'Permission request (not implemented yet — auto-allowing)',
      )
      break
    }
  }
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

    // Control room
    if (roomId === controlRoomId) {
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
            await client.sendText(controlRoomId, `Error: ${err instanceof Error ? err.message : err}`)
          }
        })()
        return
      }

      // Non-command message in control room — log only (control Claude session comes later)
      logger.info({ body: body.slice(0, 100) }, 'Control room message (no routing yet)')
      return
    }

    // Session room
    const session = getSessionByRoomId(db, roomId)
    if (!session) return

    if (session.status === 'detached') {
      void client.sendText(roomId, `Session detached. Use \`/attach ${session.name}\` in control room.`)
      return
    }
    if (session.status === 'archived') {
      void client.sendText(roomId, `Session archived. Use \`/attach ${session.name}\` in control room.`)
      return
    }
    const port = session.port
    if (!port) {
      void client.sendText(roomId, `Session has no port assigned. Use \`/attach ${session.name}\` in control room.`)
      return
    }

    // Route to relay
    void (async () => {
      try {
        await client.setTyping(roomId, true, 30000)
        await sendMessage(port, sender, body)
        // Reply comes via SSE → handleSSEEvent
      } catch (err) {
        logger.error({ err, session: session.name }, 'Failed to relay message')
        await client.setTyping(roomId, false)
        await client.sendText(roomId, `Failed to send message to Claude: ${err instanceof Error ? err.message : err}`)
      }
    })()
  })

  // Reaction handler — permission handling comes in PR 2c
  client.on('room.event', (roomId: string, event: Record<string, unknown>) => {
    if (event.type !== 'm.reaction') return
    const sender = event.sender as string
    if (sender !== config.matrix.ownerUserId) return

    const content = event.content as Record<string, unknown>
    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined
    if (!relatesTo) return

    logger.info(
      { roomId, emoji: relatesTo.key, targetEventId: relatesTo.event_id },
      'Reaction received (permission handling not yet implemented)',
    )
  })

  logger.info('Event handlers registered')
}
