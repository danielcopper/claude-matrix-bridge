import pino from 'pino'
import { loadConfig } from './config.js'
import {
  openDatabase,
  runMigrations,
  getActiveSessions,
  getLocalActiveSessions,
  updateSession,
  nextFreePort,
  releasePort,
} from './database.js'
import { createBot, bootstrapSpaceAndRooms, setupEventHandlers, handleSSEEvent } from './bot.js'
import { checkRelayRegistered, spawnClaude, killAllProcesses, killTmuxServer } from './process-manager.js'
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
// See docs/ARCHITECTURE.md "Recovery / Supervisor Restart" for rationale.

// 1. Expire all pending permission requests from previous run —
//    sessions will be restarted fresh, old permission dialogs are gone.
db.prepare('UPDATE permission_requests SET status = ?, resolved_at = ? WHERE status = ?')
  .run('expired', new Date().toISOString(), 'pending')

// 2. Legacy handed_off state → detached.
db.prepare("UPDATE sessions SET status = 'detached' WHERE status = 'handed_off'").run()

// 3. Stale 'spawning' from a previous crash → detached.
db.prepare("UPDATE sessions SET status = 'detached', port = NULL WHERE status = 'spawning'").run()

// 4. Clear stale PIDs — previous process IDs are no longer trustworthy
//    after a restart. Fresh spawns below will set new ones.
db.prepare("UPDATE sessions SET pid = NULL WHERE status = 'active' AND pid IS NOT NULL").run()

// 5. Always fresh tmux server. If our socket has leftover sessions from
//    a crash or graceful shutdown where we didn't clean up, wipe them
//    before respawning. Silent if the server doesn't exist.
killTmuxServer(logger)

// 6. For local_active sessions, verify the local claude PID is still alive.
//    - Alive: supervisor-only crash, the local terminal is still holding the
//      session; leave it alone, next Matrix message will trigger auto-attach.
//    - Dead: full crash or local exit we missed; fall back to 'detached'.
for (const session of getLocalActiveSessions(db)) {
  if (session.local_pid) {
    try {
      process.kill(session.local_pid, 0)
      logger.info(
        { session: session.name, pid: session.local_pid },
        'Local claude still alive after recovery',
      )
      continue
    } catch {
      // Process dead — fall through to detached reset
    }
  }
  updateSession(db, session.id, { status: 'detached', local_pid: null })
  logger.info(
    { session: session.name },
    'Local claude gone, resetting local_active → detached',
  )
}

logger.info({ path: config.database.path }, 'Database ready')

// Verify relay plugin is registered (mise run dev / mise run setup does the registration)
checkRelayRegistered(logger)

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
      updateSession(db, session.id, { status: 'detached', pid: null, port: null })
      continue
    }
    updateSession(db, session.id, { status: 'spawning', port })
    releasePort(port)
    const restored = { ...session, status: 'spawning' as const, port }
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
        updateSession(db, session.id, { status: 'active' })
        const active = { ...restored, status: 'active' as const }
        connectSSE(
          port,
          (event) => handleSSEEvent(event, active, client, db, logger),
          (err) => logger.error({ err, session: active.name }, 'SSE connection error'),
          logger,
        )
        logger.info({ session: active.name, port }, 'Session restored')
        if (session.room_id) {
          await client.sendText(session.room_id, 'Session restored after supervisor restart.')
        }
      } else {
        logger.warn({ session: session.name, port }, 'Failed to restore session')
        updateSession(db, session.id, { status: 'detached', pid: null, port: null })
      }
    } catch (err) {
      logger.error({ err, session: session.name }, 'Error restoring session')
      updateSession(db, session.id, { status: 'detached', pid: null, port: null })
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
