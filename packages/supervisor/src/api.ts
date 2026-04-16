import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import type { MatrixClient } from 'matrix-bot-sdk'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { getSessionById, updateSession } from './database.js'
import { killClaude } from './process-manager.js'

export interface ApiResult {
  status: number
  body: Record<string, unknown>
}

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
        const body = await readBody(req)
        const result = await handleSessionStart(body, db, client, logger)
        json(res, result.status, result.body)
        return
      }

      if (url === '/api/session/end' && method === 'POST') {
        const body = await readBody(req)
        const result = await handleSessionEnd(body, db, client, logger)
        json(res, result.status, result.body)
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

export async function handleSessionStart(
  body: Record<string, unknown>,
  db: Database.Database,
  client: MatrixClient,
  logger: Logger,
): Promise<ApiResult> {
  const sessionId = body.session_id as string | undefined
  const localPid = typeof body.pid === 'number' ? body.pid : null
  if (!sessionId) {
    return { status: 400, body: { error: 'session_id required' } }
  }

  const session = getSessionById(db, sessionId)
  if (!session) {
    return { status: 404, body: { error: 'session not managed by supervisor' } }
  }

  // Supervisor is currently spawning this session — the hook is from our own
  // spawn, not a local terminal. Ignore it.
  if (session.status === 'spawning') {
    logger.debug({ session: session.name }, 'Ignoring SessionStart from supervisor spawn (status=spawning)')
    return { status: 200, body: { status: 'spawning', action: 'ignored' } }
  }

  // Already marked local_active (e.g., hook fired twice) → just update PID
  if (session.status === 'local_active') {
    updateSession(db, session.id, { local_pid: localPid })
    return { status: 200, body: { status: 'local_active', action: 'updated_pid' } }
  }

  // Archived sessions are no longer tracked
  if (session.status === 'archived') {
    return { status: 200, body: { status: 'archived', action: 'none' } }
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
    // Detached: no claude to kill, just transition state.
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

  return { status: 200, body: { status: 'local_active', action: 'detached' } }
}

export async function handleSessionEnd(
  body: Record<string, unknown>,
  db: Database.Database,
  client: MatrixClient,
  logger: Logger,
): Promise<ApiResult> {
  const sessionId = body.session_id as string | undefined
  if (!sessionId) {
    return { status: 400, body: { error: 'session_id required' } }
  }

  const session = getSessionById(db, sessionId)
  if (!session) {
    return { status: 404, body: { error: 'session not managed by supervisor' } }
  }

  // Only relevant if we thought the session was local_active.
  if (session.status !== 'local_active') {
    return { status: 200, body: { status: session.status, action: 'none' } }
  }

  // When we auto-detach (kill supervisor's tmux claude), that dying process
  // also fires a SessionEnd hook. Ignore it — only act on the LOCAL claude's exit.
  // Match by PID: if we stored local_pid and the hook sends a different pid, skip.
  const hookPid = typeof body.pid === 'number' ? body.pid : null
  if (session.local_pid && hookPid && hookPid !== session.local_pid) {
    logger.debug(
      { session: session.name, hookPid, localPid: session.local_pid },
      'Ignoring SessionEnd from killed supervisor claude (not the local process)',
    )
    return { status: 200, body: { status: session.status, action: 'ignored' } }
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

  return { status: 200, body: { status: 'detached', action: 'released' } }
}
