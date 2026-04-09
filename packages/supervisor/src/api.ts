import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import type { MatrixClient } from 'matrix-bot-sdk'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { getSessionById, updateSession } from './database.js'
import { recentlySpawned, killClaude } from './process-manager.js'

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function startApiServer(
  port: number,
  db: Database.Database,
  _config: Config,
  client: MatrixClient,
  logger: Logger,
): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? ''

    try {
      if (url === '/api/health' && method === 'GET') {
        json(res, 200, { status: 'ok' })
        return
      }

      if (url === '/api/session/start' && method === 'POST') {
        await handleSessionStart(req, res, db, client, logger)
        return
      }

      if (url === '/api/session/end' && method === 'POST') {
        await handleSessionEnd(req, res, db, client, logger)
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      logger.error({ err }, 'API error')
      json(res, 500, { error: 'internal error' })
    }
  })

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'API server listening')
  })

  return server
}

async function handleSessionStart(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  client: MatrixClient,
  logger: Logger,
): Promise<void> {
  const body = await readBody(req)
  const sessionId = body.session_id as string | undefined
  const localPid = typeof body.pid === 'number' ? body.pid : null
  if (!sessionId) {
    json(res, 400, { error: 'session_id required' })
    return
  }

  const session = getSessionById(db, sessionId)
  if (!session) {
    json(res, 404, { error: 'session not managed by supervisor' })
    return
  }

  // Ignore hooks fired by our own spawns (replaces CMB_MANAGED env var)
  if (recentlySpawned.delete(sessionId)) {
    logger.debug({ session: session.name }, 'Ignoring SessionStart from supervisor spawn')
    json(res, 200, { status: session.status, action: 'ignored' })
    return
  }

  // Already marked local_active (e.g., hook fired twice) → just update PID
  if (session.status === 'local_active') {
    updateSession(db, session.id, { local_pid: localPid })
    json(res, 200, { status: 'local_active', action: 'updated_pid' })
    return
  }

  // Archived sessions are no longer tracked
  if (session.status === 'archived') {
    json(res, 200, { status: 'archived', action: 'none' })
    return
  }

  // Active: the supervisor currently holds the session in tmux.
  // Kill our claude and hand control to the local terminal.
  if (session.status === 'active') {
    logger.info(
      { session: session.name, localPid },
      'Auto-detach: local terminal claimed session, killing supervisor claude',
    )
    try {
      await killClaude(session, logger)
    } catch (err) {
      logger.warn({ err, session: session.name }, 'killClaude failed during auto-detach')
    }
  } else {
    // Detached/handed_off: no claude to kill, just transition state.
    logger.info({ session: session.name, localPid }, 'Session claimed by local terminal')
  }

  updateSession(db, session.id, {
    status: 'local_active',
    local_pid: localPid,
    pid: null,
  })

  if (session.room_id) {
    const msg = localPid
      ? `Session handed off to local terminal (PID ${localPid}). Send a new message here to reclaim control.`
      : 'Session handed off to local terminal. Send a new message here to reclaim control.'
    void client.sendText(session.room_id, msg).catch(() => {})
  }

  json(res, 200, { status: 'local_active', action: 'detached' })
}

async function handleSessionEnd(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  client: MatrixClient,
  logger: Logger,
): Promise<void> {
  const body = await readBody(req)
  const sessionId = body.session_id as string | undefined
  if (!sessionId) {
    json(res, 400, { error: 'session_id required' })
    return
  }

  const session = getSessionById(db, sessionId)
  if (!session) {
    json(res, 404, { error: 'session not managed by supervisor' })
    return
  }

  // Only relevant if we thought the session was local_active.
  if (session.status !== 'local_active') {
    json(res, 200, { status: session.status, action: 'none' })
    return
  }

  logger.info({ session: session.name }, 'Local session ended, session now idle')
  updateSession(db, session.id, { status: 'detached', local_pid: null })

  if (session.room_id) {
    void client
      .sendText(
        session.room_id,
        'Local session ended. Send a message to reclaim this session in Matrix.',
      )
      .catch(() => {})
  }

  json(res, 200, { status: 'detached', action: 'released' })
}
