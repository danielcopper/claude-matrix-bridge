import pino from 'pino'
import { loadConfig } from './config.js'
import { openDatabase, runMigrations, getActiveSessions, updateSession, nextFreePort } from './database.js'
import { createBot, bootstrapSpaceAndRooms, setupEventHandlers, handleSSEEvent } from './bot.js'
import { ensureRelayRegistered, spawnClaude, killAllProcesses, killTmuxServer } from './process-manager.js'
import { waitForHealth, connectSSE } from './relay-client.js'
import { startApiServer } from './api.js'

const config = loadConfig()

const logger = pino(
  { name: 'supervisor', level: config.logLevel },
  pino.destination(2), // stderr
)

logger.info('Starting supervisor')

const db = openDatabase(config.database.path)
runMigrations(db)

// --- Recovery / Startup Cleanup ---
// See docs/AUTO_HANDOFF.md "Recovery / Supervisor Restart" for rationale.

// 1. Expire all pending permission requests from previous run —
//    sessions will be restarted fresh, old permission dialogs are gone.
db.prepare('UPDATE permission_requests SET status = ?, resolved_at = ? WHERE status = ?')
  .run('expired', new Date().toISOString(), 'pending')

// 2. Legacy handed_off state → detached (from earlier handoff design).
//    Kept for DB compatibility; handed_off will be removed entirely in Phase 2.
db.prepare("UPDATE sessions SET status = 'detached' WHERE status = 'handed_off'").run()

// 3. Clear stale PIDs — previous process IDs are no longer trustworthy
//    after a restart. Fresh spawns below will set new ones.
db.prepare("UPDATE sessions SET pid = NULL WHERE status = 'active' AND pid IS NOT NULL").run()

// 4. Always fresh tmux server. If our socket has leftover sessions from
//    a crash or graceful shutdown where we didn't clean up, wipe them
//    before respawning. Silent if the server doesn't exist.
killTmuxServer(logger)

logger.info({ path: config.database.path }, 'Database ready')

// Ensure relay plugin is registered as user-scoped MCP server
await ensureRelayRegistered(logger)

const client = createBot(config, logger)
await client.start()
logger.info('Matrix client connected')

const { controlRoomId } = await bootstrapSpaceAndRooms(client, db, config, logger)
setupEventHandlers(client, db, config, controlRoomId, logger)

// --- Restart handling: restore active sessions from previous run ---

const activeSessions = getActiveSessions(db)
if (activeSessions.length > 0) {
  logger.info({ count: activeSessions.length }, 'Restoring active sessions')
  for (const session of activeSessions) {
    // Allocate a fresh port to avoid conflicts from stale DB state
    const port = nextFreePort(db, config.ports.start, config.ports.end)
    if (!port) {
      logger.warn({ session: session.name }, 'No free port for session restore')
      updateSession(db, session.id, { pid: null })
      continue
    }
    const restored = { ...session, port }
    updateSession(db, session.id, { port })
    try {
      spawnClaude(restored, config, db, logger, {
        resume: true,
        onExit: () => {
          if (session.room_id) {
            void client.sendHtmlText(
              session.room_id,
              '<strong>Claude session ended.</strong>',
            ).catch(() => {})
          }
        },
      })

      const healthy = await waitForHealth(port, logger, 30000)
      if (healthy) {
        connectSSE(
          port,
          (event) => handleSSEEvent(event, restored, client, db, logger),
          (err) => logger.error({ err, session: restored.name }, 'SSE connection error'),
          logger,
        )
        logger.info({ session: restored.name, port }, 'Session restored')
        if (session.room_id) {
          await client.sendText(session.room_id, 'Session restored after supervisor restart.')
        }
      } else {
        logger.warn({ session: session.name, port: session.port }, 'Failed to restore session')
        updateSession(db, session.id, { pid: null })
      }
    } catch (err) {
      logger.error({ err, session: session.name }, 'Error restoring session')
      updateSession(db, session.id, { pid: null })
    }
  }
}

await client.sendHtmlText(
  controlRoomId,
  activeSessions.length > 0
    ? `<strong>Supervisor started.</strong> Restored ${activeSessions.length} session(s). Use /claude-help for commands.`
    : '<strong>Supervisor started.</strong> Use /claude-help for commands.',
)
// --- HTTP API for session handoff hooks ---

const apiServer = startApiServer(config.apiPort, db, config, client, logger)

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
  apiServer.close()
  client.stop()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
