import Database from 'better-sqlite3'
import { readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
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

/**
 * Apply all *.sql files in migrations/ that haven't run yet.
 * Tracks applied migrations in a schema_migrations table for idempotency.
 */
export function runMigrations(db: Database.Database): void {
  const createTrackingTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`
  db.exec(createTrackingTable)

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[])
      .map((r) => r.name),
  )

  const migrationsDir = resolve(__dirname, '..', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))

  const insertApplied = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  )

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    db.transaction(() => {
      db.exec(sql)
      insertApplied.run(file, new Date().toISOString())
    })()
  }
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
  // Returns all sessions with status='active' regardless of pid.
  // The pid may be null after startup recovery (we clear stale pids and
  // respawn) — the restore loop uses this query to find what to spawn.
  return db.prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[]
}

/**
 * Ports reserved between nextFreePort and the actual DB commit. Prevents a
 * race where two concurrent /new handlers allocate the same port because
 * neither has written its session to the DB yet. Caller must releasePort
 * after createSession commits (or on any error path).
 */
const reservedPorts = new Set<number>()

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
    if (!usedPorts.has(port) && !reservedPorts.has(port)) {
      reservedPorts.add(port)
      return port
    }
  }
  return null
}

export function releasePort(port: number): void {
  reservedPorts.delete(port)
}

export function createSession(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions (
       id, room_id, name, working_directory, model, permission_mode,
       port, pid, status, created_at, updated_at, last_message_at,
       local_pid, last_matrix_activity
     ) VALUES (
       @id, @room_id, @name, @working_directory, @model, @permission_mode,
       @port, @pid, @status, @created_at, @updated_at, @last_message_at,
       @local_pid, @last_matrix_activity
     )`,
  ).run(session)
}

export function getLocalActiveSessions(db: Database.Database): Session[] {
  return db
    .prepare("SELECT * FROM sessions WHERE status = 'local_active'")
    .all() as Session[]
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
