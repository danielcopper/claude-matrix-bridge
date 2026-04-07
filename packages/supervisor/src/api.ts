import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import type { MatrixClient } from 'matrix-bot-sdk'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { getSessionById, updateSession } from './database.js'

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
  if (!sessionId) {
    json(res, 400, { error: 'session_id required' })
    return
  }

  const session = getSessionById(db, sessionId)
  if (!session) {
    json(res, 404, { error: 'session not managed by supervisor' })
    return
  }

  if (session.status !== 'active') {
    json(res, 200, { status: session.status, action: 'none' })
    return
  }

  // Informational only — tmux keeps running, Matrix keeps routing
  logger.info({ session: session.name }, 'Session also active in local terminal')
  updateSession(db, session.id, { status: 'handed_off' })

  if (session.room_id) {
    void client.sendText(session.room_id, 'User also active in local terminal.').catch(() => {})
  }

  json(res, 200, { status: 'handed_off', action: 'marked' })
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

  if (session.status !== 'handed_off') {
    json(res, 200, { status: session.status, action: 'none' })
    return
  }

  // Local session ended — just reset status, tmux is still running
  logger.info({ session: session.name }, 'Local session ended, Matrix-only again')
  updateSession(db, session.id, { status: 'active' })

  if (session.room_id) {
    void client.sendText(session.room_id, 'Local session ended.').catch(() => {})
  }

  json(res, 200, { status: 'active', action: 'reset' })
}
