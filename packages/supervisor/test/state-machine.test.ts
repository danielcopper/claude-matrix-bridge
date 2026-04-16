import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

// Mock process-manager before importing api.ts (which imports killClaude)
const killClaudeMock = mock.fn(async () => {})
mock.module('../src/process-manager.js', {
  namedExports: {
    killClaude: killClaudeMock,
    spawnClaude: mock.fn(),
    killAllProcesses: mock.fn(async () => {}),
    killTmuxServer: mock.fn(),
    checkRelayRegistered: mock.fn(),
    activeSessions: new Set(),
  },
})

const { runMigrations, createSession, getSessionById } = await import('../src/database.js')
const { handleSessionStart, handleSessionEnd } = await import('../src/api.js')
import type { Session } from '../src/types.js'

// --- Mock MatrixClient ---
function mockClient() {
  const sent: { roomId: string; text: string }[] = []
  return {
    sent,
    sendText: mock.fn(async (roomId: string, text: string) => {
      sent.push({ roomId, text })
      return '$event_id'
    }),
  } as unknown as import('matrix-bot-sdk').MatrixClient
}

// --- Mock Logger ---
function mockLogger() {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    debug: mock.fn(),
    error: mock.fn(),
    child: mock.fn(function (this: unknown) { return this }),
  } as unknown as import('pino').Logger
}

// --- Test DB ---
function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

// --- Session factory ---
function insertSession(db: Database.Database, overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString()
  const session: Session = {
    id: randomUUID(),
    room_id: '!room:test.local',
    name: `test-${Math.random().toString(36).slice(2, 6)}`,
    working_directory: '/tmp/test',
    model: 'sonnet',
    permission_mode: 'default',
    port: 9000,
    pid: 1234,
    status: 'active',
    created_at: now,
    updated_at: now,
    last_message_at: null,
    local_pid: null,
    last_matrix_activity: null,
    ...overrides,
  }
  createSession(db, session)
  return session
}

// =============================================
// handleSessionStart
// =============================================

describe('handleSessionStart', () => {
  let db: Database.Database
  let client: ReturnType<typeof mockClient>
  let logger: ReturnType<typeof mockLogger>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    logger = mockLogger()
    killClaudeMock.mock.resetCalls()
  })

  it('returns 400 when session_id is missing', async () => {
    const result = await handleSessionStart({}, db, client, logger)
    assert.equal(result.status, 400)
  })

  it('returns 404 for unknown session', async () => {
    const result = await handleSessionStart(
      { session_id: randomUUID() },
      db, client, logger,
    )
    assert.equal(result.status, 404)
  })

  // spawning -> spawning (ignored)
  it('ignores SessionStart when status is spawning', async () => {
    const session = insertSession(db, { status: 'spawning' })
    const result = await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'ignored')
    assert.equal(getSessionById(db, session.id)!.status, 'spawning')
  })

  // local_active -> local_active (pid updated)
  it('updates PID when already local_active', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 1000 })
    const result = await handleSessionStart(
      { session_id: session.id, pid: 2000 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'updated_pid')
    const updated = getSessionById(db, session.id)!
    assert.equal(updated.status, 'local_active')
    assert.equal(updated.local_pid, 2000)
  })

  // archived -> archived (no action)
  it('does nothing for archived sessions', async () => {
    const session = insertSession(db, { status: 'archived' })
    const result = await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'none')
    assert.equal(getSessionById(db, session.id)!.status, 'archived')
  })

  // active -> local_active (calls killClaude)
  it('transitions active -> local_active and clears pid', async () => {
    const session = insertSession(db, { status: 'active', pid: 1234 })
    const result = await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'detached')
    assert.equal(killClaudeMock.mock.callCount(), 1)
    const updated = getSessionById(db, session.id)!
    assert.equal(updated.status, 'local_active')
    assert.equal(updated.local_pid, 5555)
    assert.equal(updated.pid, null)
  })

  // detached -> local_active does NOT call killClaude
  it('does not call killClaude for detached -> local_active', async () => {
    const session = insertSession(db, { status: 'detached', pid: null })
    await handleSessionStart(
      { session_id: session.id, pid: 7777 },
      db, client, logger,
    )
    assert.equal(killClaudeMock.mock.callCount(), 0)
  })

  // active -> local_active sends Matrix notification
  it('sends room notification on active -> local_active', async () => {
    const session = insertSession(db, { status: 'active', room_id: '!myroom:test' })
    await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(client.sent.length, 1)
    assert.equal(client.sent[0].roomId, '!myroom:test')
    assert.ok(client.sent[0].text.includes('PID 5555'))
  })

  // detached -> local_active (no kill needed)
  it('transitions detached -> local_active', async () => {
    const session = insertSession(db, { status: 'detached', pid: null, port: null })
    const result = await handleSessionStart(
      { session_id: session.id, pid: 7777 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'detached')
    const updated = getSessionById(db, session.id)!
    assert.equal(updated.status, 'local_active')
    assert.equal(updated.local_pid, 7777)
  })

  // No room_id -> no Matrix message sent
  it('skips Matrix notification when room_id is null', async () => {
    const session = insertSession(db, { status: 'active', room_id: null })
    await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(client.sent.length, 0)
  })

  // pid not provided -> local_pid set to null
  it('sets local_pid to null when pid is not a number', async () => {
    const session = insertSession(db, { status: 'detached' })
    await handleSessionStart(
      { session_id: session.id },
      db, client, logger,
    )
    const updated = getSessionById(db, session.id)!
    assert.equal(updated.local_pid, null)
    assert.equal(updated.status, 'local_active')
  })
})

// =============================================
// handleSessionEnd
// =============================================

describe('handleSessionEnd', () => {
  let db: Database.Database
  let client: ReturnType<typeof mockClient>
  let logger: ReturnType<typeof mockLogger>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    logger = mockLogger()
  })

  it('returns 400 when session_id is missing', async () => {
    const result = await handleSessionEnd({}, db, client, logger)
    assert.equal(result.status, 400)
  })

  it('returns 404 for unknown session', async () => {
    const result = await handleSessionEnd(
      { session_id: randomUUID() },
      db, client, logger,
    )
    assert.equal(result.status, 404)
  })

  // active -> no action (only acts on local_active)
  it('does nothing when status is active', async () => {
    const session = insertSession(db, { status: 'active' })
    const result = await handleSessionEnd(
      { session_id: session.id, pid: 1234 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'none')
    assert.equal(getSessionById(db, session.id)!.status, 'active')
  })

  // spawning -> no action
  it('does nothing when status is spawning', async () => {
    const session = insertSession(db, { status: 'spawning' })
    const result = await handleSessionEnd(
      { session_id: session.id },
      db, client, logger,
    )
    assert.equal(result.body.action, 'none')
    assert.equal(getSessionById(db, session.id)!.status, 'spawning')
  })

  // detached -> no action
  it('does nothing when status is detached', async () => {
    const session = insertSession(db, { status: 'detached' })
    const result = await handleSessionEnd(
      { session_id: session.id },
      db, client, logger,
    )
    assert.equal(result.body.action, 'none')
  })

  // archived -> no action
  it('does nothing when status is archived', async () => {
    const session = insertSession(db, { status: 'archived' })
    const result = await handleSessionEnd(
      { session_id: session.id },
      db, client, logger,
    )
    assert.equal(result.body.action, 'none')
  })

  // local_active + matching pid -> detached
  it('transitions local_active -> detached on matching pid', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 5555 })
    const result = await handleSessionEnd(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.action, 'released')
    const updated = getSessionById(db, session.id)!
    assert.equal(updated.status, 'detached')
    assert.equal(updated.local_pid, null)
  })

  // local_active + different pid -> ignored (supervisor's claude dying)
  it('ignores SessionEnd with non-matching pid', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 5555 })
    const result = await handleSessionEnd(
      { session_id: session.id, pid: 9999 },
      db, client, logger,
    )
    assert.equal(result.body.action, 'ignored')
    assert.equal(getSessionById(db, session.id)!.status, 'local_active')
  })

  // local_active + no stored pid -> release (legacy/edge case)
  it('releases when local_pid is null (no pid tracking)', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: null })
    const result = await handleSessionEnd(
      { session_id: session.id, pid: 9999 },
      db, client, logger,
    )
    assert.equal(result.body.action, 'released')
    assert.equal(getSessionById(db, session.id)!.status, 'detached')
  })

  // local_active + no hook pid -> release
  it('releases when hook sends no pid', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 5555 })
    const result = await handleSessionEnd(
      { session_id: session.id },
      db, client, logger,
    )
    assert.equal(result.body.action, 'released')
    assert.equal(getSessionById(db, session.id)!.status, 'detached')
  })

  // Sends room notification on release
  it('sends room notification on release', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 5555, room_id: '!room:test' })
    await handleSessionEnd(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(client.sent.length, 1)
    assert.ok(client.sent[0].text.includes('Local session ended'))
  })

  // No room_id -> no Matrix message
  it('skips notification when room_id is null', async () => {
    const session = insertSession(db, { status: 'local_active', local_pid: 5555, room_id: null })
    await handleSessionEnd(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(client.sent.length, 0)
  })
})

// =============================================
// Full transition sequences
// =============================================

describe('transition sequences', () => {
  let db: Database.Database
  let client: ReturnType<typeof mockClient>
  let logger: ReturnType<typeof mockLogger>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    logger = mockLogger()
  })

  // active -> local_active -> detached (full handoff cycle)
  it('active -> local_active -> detached', async () => {
    const session = insertSession(db, { status: 'active', pid: 1234 })

    const start = await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(start.body.status, 'local_active')

    const end = await handleSessionEnd(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(end.body.status, 'detached')

    const final = getSessionById(db, session.id)!
    assert.equal(final.status, 'detached')
    assert.equal(final.local_pid, null)
    assert.equal(final.pid, null)
  })

  // detached -> local_active -> detached
  it('detached -> local_active -> detached', async () => {
    const session = insertSession(db, { status: 'detached', pid: null, port: null })

    const start = await handleSessionStart(
      { session_id: session.id, pid: 8888 },
      db, client, logger,
    )
    assert.equal(start.body.status, 'local_active')

    const end = await handleSessionEnd(
      { session_id: session.id, pid: 8888 },
      db, client, logger,
    )
    assert.equal(end.body.status, 'detached')
  })

  // Supervisor's SessionEnd ignored during handoff (pid mismatch)
  it('ignores supervisor SessionEnd during active -> local_active handoff', async () => {
    const session = insertSession(db, { status: 'active', pid: 1234 })

    await handleSessionStart(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )

    // Supervisor's killed claude fires SessionEnd with old pid
    const supervisorEnd = await handleSessionEnd(
      { session_id: session.id, pid: 1234 },
      db, client, logger,
    )
    assert.equal(supervisorEnd.body.action, 'ignored')
    assert.equal(getSessionById(db, session.id)!.status, 'local_active')

    // Real local exit
    const localEnd = await handleSessionEnd(
      { session_id: session.id, pid: 5555 },
      db, client, logger,
    )
    assert.equal(localEnd.body.action, 'released')
    assert.equal(getSessionById(db, session.id)!.status, 'detached')
  })
})
