import pino from 'pino'
import { loadConfig } from './config.js'
import { openDatabase, runMigrations } from './database.js'
import { createBot, bootstrapSpaceAndRooms, setupEventHandlers } from './bot.js'
import { ensureRelayRegistered, killAllProcesses } from './process-manager.js'

const config = loadConfig()

const logger = pino(
  { name: 'supervisor', level: config.logLevel },
  pino.destination(2), // stderr
)

logger.info('Starting supervisor')

const db = openDatabase(config.database.path)
runMigrations(db)
logger.info({ path: config.database.path }, 'Database ready')

// Ensure relay plugin is registered as user-scoped MCP server
await ensureRelayRegistered(logger)

const client = createBot(config, logger)
await client.start()
logger.info('Matrix client connected')

const { controlRoomId } = await bootstrapSpaceAndRooms(client, db, config, logger)
setupEventHandlers(client, db, config, controlRoomId, logger)

await client.sendHtmlText(
  controlRoomId,
  '<strong>Supervisor started.</strong> Use /claude-help for commands.',
)
logger.info('Supervisor ready')

// --- Graceful shutdown ---

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Shutting down')
  await killAllProcesses(logger)
  try {
    await client.sendText(controlRoomId, 'Supervisor shutting down.')
  } catch {
    // Best effort
  }
  client.stop()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
