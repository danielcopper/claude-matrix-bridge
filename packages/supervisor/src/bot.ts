import {
  MatrixClient,
  SimpleFsStorageProvider,
  LogService,
  LogLevel,
} from 'matrix-bot-sdk'
import type Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { getConfig, setConfig } from './database.js'

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
      topic: 'Claude Code control room — use /help for commands',
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

export function setupEventHandlers(
  client: MatrixClient,
  config: Config,
  controlRoomId: string,
  logger: Logger,
): void {
  // Message handler — log only in PR 1, routing comes in PR 2
  client.on('room.message', (roomId: string, event: Record<string, unknown>) => {
    const content = event.content as Record<string, unknown> | undefined
    if (!content?.msgtype) return
    const sender = event.sender as string
    if (sender === config.matrix.botUserId) return

    if (sender !== config.matrix.ownerUserId) {
      logger.debug({ roomId, sender }, 'Ignoring message from non-owner')
      return
    }

    const body = content.body as string
    const isControlRoom = roomId === controlRoomId

    logger.info(
      { roomId, sender, isControlRoom, body: body?.slice(0, 100) },
      'Message received',
    )
  })

  // Reaction handler — log only in PR 1, permission handling comes in PR 2
  client.on('room.event', (roomId: string, event: Record<string, unknown>) => {
    if (event.type !== 'm.reaction') return
    const sender = event.sender as string
    if (sender !== config.matrix.ownerUserId) return

    const content = event.content as Record<string, unknown>
    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined
    if (!relatesTo) return

    logger.info(
      {
        roomId,
        emoji: relatesTo.key,
        targetEventId: relatesTo.event_id,
      },
      'Reaction received',
    )
  })

  logger.info('Event handlers registered')
}
