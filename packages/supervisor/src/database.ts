import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Session, PermissionRequest, PermissionStatus } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  return db
}

export function runMigrations(db: Database.Database): void {
  const migrationPath = resolve(__dirname, '..', 'migrations', '001_init.sql')
  const sql = readFileSync(migrationPath, 'utf-8')
  db.exec(sql)
}

// --- Config helpers ---

export function getConfig(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value)
}

// --- Session helpers ---

export function getSessionByRoomId(
  db: Database.Database,
  roomId: string,
): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE room_id = ?').get(roomId) as
    | Session
    | undefined
}

export function getSessionByName(
  db: Database.Database,
  name: string,
): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE name = ?').get(name) as
    | Session
    | undefined
}

export function getSessionById(db: Database.Database, id: string): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
}

export function getAllSessions(db: Database.Database): Session[] {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as Session[]
}

export function getActiveSessions(db: Database.Database): Session[] {
  return db.prepare('SELECT * FROM sessions WHERE status = ? AND pid IS NOT NULL').all('active') as Session[]
}

export function nextFreePort(
  db: Database.Database,
  portStart: number,
  portEnd: number,
): number | null {
  const usedPorts = new Set(
    getAllSessions(db)
      .filter((s): s is Session & { port: number } => s.status === 'active' && s.port != null)
      .map((s) => s.port),
  )
  for (let port = portStart; port <= portEnd; port++) {
    if (!usedPorts.has(port)) return port
  }
  return null
}

export function createSession(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions (id, room_id, name, working_directory, model, permission_mode, port, pid, status, created_at, updated_at, last_message_at)
     VALUES (@id, @room_id, @name, @working_directory, @model, @permission_mode, @port, @pid, @status, @created_at, @updated_at, @last_message_at)`,
  ).run(session)
}

export function updateSession(
  db: Database.Database,
  id: string,
  fields: Partial<Session>,
): void {
  const entries = Object.entries(fields).filter(([k]) => k !== 'id')
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE sessions SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    id,
    updated_at: new Date().toISOString(),
  })
}

// --- Permission helpers ---

export function createPermissionRequest(
  db: Database.Database,
  request: PermissionRequest,
): void {
  db.prepare(
    `INSERT INTO permission_requests (request_id, session_id, event_id, tool_name, description, status, created_at, resolved_at)
     VALUES (@request_id, @session_id, @event_id, @tool_name, @description, @status, @created_at, @resolved_at)`,
  ).run(request)
}

export function getPermissionRequestByEventId(
  db: Database.Database,
  eventId: string,
): PermissionRequest | undefined {
  return db
    .prepare('SELECT * FROM permission_requests WHERE event_id = ? AND status = ?')
    .get(eventId, 'pending') as PermissionRequest | undefined
}

export function expireSessionPermissions(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(
    'UPDATE permission_requests SET status = ?, resolved_at = ? WHERE session_id = ? AND status = ?',
  ).run('expired', new Date().toISOString(), sessionId, 'pending')
}

export function resolvePermissionRequest(
  db: Database.Database,
  requestId: string,
  status: PermissionStatus,
): void {
  db.prepare(
    'UPDATE permission_requests SET status = ?, resolved_at = ? WHERE request_id = ?',
  ).run(status, new Date().toISOString(), requestId)
}
