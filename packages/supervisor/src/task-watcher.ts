import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import type { MatrixClient } from 'matrix-bot-sdk'
import type Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Session } from './types.js'
import { getSessionById, getConfig, setConfig } from './database.js'

// --- Task data shape ---
//
// Claude Code persists each task as a single JSON file under
// ~/.claude/tasks/<sessionId>/<taskId>.json. We mirror the current set of
// tasks into the corresponding Matrix session room whenever it changes.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | string

export interface Task {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  blocks?: string[]
  blockedBy?: string[]
}

/** Resolve lazily so HOME-override-style tests work. */
export function tasksDirFor(sessionId: string): string {
  return join(homedir(), '.claude', 'tasks', sessionId)
}

/** Read all task files for a session, sorted by numeric id. Returns an empty
 *  array if the directory doesn't exist or no readable tasks are present. */
export function readTasks(sessionId: string): Task[] {
  const dir = tasksDirFor(sessionId)
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const tasks: Task[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    const path = join(dir, entry)
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw) as Task
      if (typeof parsed.id === 'string' && typeof parsed.status === 'string') {
        tasks.push(parsed)
      }
    } catch {
      // Mid-write partial file — skip; we'll catch it on the next poll.
    }
  }

  return tasks.sort((a, b) => {
    const an = Number(a.id)
    const bn = Number(b.id)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.id.localeCompare(b.id)
  })
}

// --- Formatting ---

const STATUS_ICON: Record<string, string> = {
  completed: '✅',
  in_progress: '🟡',
  pending: '⬜',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Format the current task set as a Matrix message. Returns null if there
 *  are no tasks at all (nothing to post).
 *
 *  Body and formatted_body both join items with `<br>` / newlines. Element's
 *  pin-preview banner strips tags without inserting separators between
 *  block-level elements, so `<ul><li>` produced run-together text in the
 *  banner. `<br>` works because the visible characters are preserved
 *  between line breaks. */
export function formatTasksAsMatrix(tasks: Task[]): { body: string; formatted_body: string } | null {
  const visible = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed')
  if (visible.length === 0) return null

  const done = visible.filter(t => t.status === 'completed').length
  const header = `📋 Tasks (${visible.length} total, ${done} done)`

  const plainLines: string[] = [header]
  const htmlLines: string[] = [`<b>${escapeHtml(header)}</b>`]

  for (const t of visible) {
    const icon = STATUS_ICON[t.status] ?? '•'
    const subject = t.subject || `(no subject)`
    const activeForm = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''

    plainLines.push(` ${icon} #${t.id} ${subject}${activeForm}`)

    const subjectHtml = escapeHtml(subject)
    const activeFormHtml = activeForm ? ` <i>${escapeHtml(activeForm.trim())}</i>` : ''
    const wrapped =
      t.status === 'completed' ? `<s>${subjectHtml}</s>` :
      t.status === 'in_progress' ? `<b>${subjectHtml}</b>` :
      subjectHtml
    htmlLines.push(`${icon} #${escapeHtml(t.id)} ${wrapped}${activeFormHtml}`)
  }

  return { body: plainLines.join('\n'), formatted_body: htmlLines.join('<br>') }
}

/** Full task list for `m.room.topic`. One task per line; each item line
 *  starts with a space so Element X mobile (no MSC3765 support yet)
 *  separates items even when newlines collapse. Element Web uses the
 *  paired HTML variant below. */
export function formatTasksAsRoomTopic(tasks: Task[]): string | null {
  const visible = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed')
  if (visible.length === 0) return null

  const done = visible.filter(t => t.status === 'completed').length
  const lines: string[] = [`📋 Tasks (${done}/${visible.length})`]

  for (const t of visible) {
    const icon = STATUS_ICON[t.status] ?? '•'
    const subject = t.subject || `(no subject)`
    const activeForm = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''
    lines.push(` ${icon} ${subject}${activeForm}`)
  }

  return lines.join('\n')
}

/** HTML variant for `m.topic` extensible event (MSC3765, stabilized in
 *  Matrix v1.15, Element Web 1.11.100+). `<br>` is in Element's topic
 *  sanitizer allow-list, so this produces real line breaks in the room
 *  header, beginning-of-room notice, and state-change notice. */
export function formatTasksAsRoomTopicHtml(tasks: Task[]): string | null {
  const visible = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed')
  if (visible.length === 0) return null

  const done = visible.filter(t => t.status === 'completed').length
  const parts: string[] = [`📋 Tasks (${done}/${visible.length})`]

  for (const t of visible) {
    const icon = STATUS_ICON[t.status] ?? '•'
    const subject = escapeHtml(t.subject || '(no subject)')
    const activeForm = t.status === 'in_progress' && t.activeForm
      ? ` <i>(${escapeHtml(t.activeForm)})</i>` : ''
    parts.push(`${icon} ${subject}${activeForm}`)
  }

  return parts.join('<br>')
}

/** SHA-1 hash of the canonical task state. Used to skip posts when nothing
 *  meaningful changed (e.g. claude touches a file without altering content). */
export function tasksDigest(tasks: Task[]): string {
  const canonical = tasks.map(t => `${t.id}|${t.status}|${t.subject ?? ''}|${t.activeForm ?? ''}`).join('\n')
  return createHash('sha1').update(canonical).digest('hex')
}

// --- Live polling ---

interface WatcherState {
  lastDigest: string | null
  lastTaskDirMtime: number
  pollHandle: ReturnType<typeof setInterval>
}

const watchers = new Map<string, WatcherState>()

const POLL_INTERVAL_MS = 750

/** Begin mirroring the session's task list into its Matrix room. Idempotent:
 *  calling again for the same session restarts the watcher. The watcher
 *  self-stops once the session is no longer in the 'active' state. */
export function startTaskMirror(
  session: Session,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): void {
  stopTaskMirror(session.id)
  if (!session.room_id) return

  // Don't seed the digest. The first tick reconciles whatever state is on
  // disk against the pinned message — if the user edited tasks in a local
  // terminal while the supervisor was offline, those changes get posted
  // immediately on resume instead of waiting for the next on-disk change.
  const state: WatcherState = {
    lastDigest: null,
    lastTaskDirMtime: 0,
    pollHandle: setInterval(() => {
      void tick(session.id, client, db, logger).catch(err => {
        logger.error({ err, session: session.name }, 'task-mirror tick failed')
      })
    }, POLL_INTERVAL_MS),
  }
  watchers.set(session.id, state)
}

export function stopTaskMirror(sessionId: string): void {
  const w = watchers.get(sessionId)
  if (!w) return
  clearInterval(w.pollHandle)
  watchers.delete(sessionId)
}

async function tick(
  sessionId: string,
  client: MatrixClient,
  db: Database.Database,
  logger: Logger,
): Promise<void> {
  // Self-heal: if the session is no longer active, stop watching.
  const current = getSessionById(db, sessionId)
  if (!current || current.status !== 'active' || !current.room_id) {
    stopTaskMirror(sessionId)
    return
  }

  const state = watchers.get(sessionId)
  if (!state) return

  // Cheap pre-check: skip the full read if the dir's mtime hasn't moved.
  // Only valid after the first reconciliation — otherwise an empty dir
  // (mtimeMs=0 == lastTaskDirMtime=0) would skip the initial cleanup
  // pass when we resume into a state that needs clearing.
  const dir = tasksDirFor(sessionId)
  let mtimeMs = 0
  if (existsSync(dir)) {
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch {
      // Permission error — fall through to a fresh read.
    }
  }
  if (state.lastDigest !== null && mtimeMs === state.lastTaskDirMtime) return
  state.lastTaskDirMtime = mtimeMs

  const tasks = readTasks(sessionId)
  const digest = tasksDigest(tasks)
  if (digest === state.lastDigest) return
  state.lastDigest = digest

  if (tasks.length === 0) {
    await clearTaskState(client, db, current.room_id, sessionId, logger)
    return
  }

  const topic = formatTasksAsRoomTopic(tasks)
  const topicHtml = formatTasksAsRoomTopicHtml(tasks)
  const message = formatTasksAsMatrix(tasks)
  if (topic === null || topicHtml === null || message === null) return

  try {
    await client.sendStateEvent(current.room_id, 'm.room.topic', '', {
      topic,
      'm.topic': {
        'm.text': [
          { mimetype: 'text/html', body: topicHtml },
          { mimetype: 'text/plain', body: topic },
        ],
      },
    })
  } catch (err) {
    logger.warn({ err, session: current.name }, 'failed to update room topic')
  }

  await upsertPinnedTaskMessage(client, db, current.room_id, sessionId, message, logger)
}

/** Reset the task UI when claude clears the list: blank the topic, unpin
 *  the task message, redact it from history, and forget the stored event
 *  id so a fresh tick (with new tasks) posts a new pinned message. */
async function clearTaskState(
  client: MatrixClient,
  db: Database.Database,
  roomId: string,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  const pinKey = `${PIN_KEY_PREFIX}${sessionId}`
  const existingEventId = getConfig(db, pinKey)
  // Nothing to clean up — never posted a pin in this room. Don't touch
  // the topic either; users may have set their own.
  if (!existingEventId) return

  // 1. Blank the topic.
  try {
    await client.sendStateEvent(roomId, 'm.room.topic', '', {
      topic: '',
      'm.topic': { 'm.text': [{ mimetype: 'text/plain', body: '' }] },
    })
  } catch (err) {
    logger.warn({ err, sessionId }, 'task-mirror failed to clear topic')
  }

  // 2. Unpin (preserving any user-pinned events).
  try {
    const state = await client.getRoomStateEvent(roomId, 'm.room.pinned_events', '') as
      | { pinned?: unknown } | null
    if (state && Array.isArray(state.pinned)) {
      const filtered = state.pinned
        .filter((p): p is string => typeof p === 'string')
        .filter(p => p !== existingEventId)
      await client.sendStateEvent(roomId, 'm.room.pinned_events', '', { pinned: filtered })
    }
  } catch (err) {
    logger.warn({ err, sessionId, existingEventId }, 'task-mirror failed to unpin')
  }

  // 3. Redact the task message so it disappears from chat history.
  try {
    await client.redactEvent(roomId, existingEventId, 'tasks cleared')
  } catch (err) {
    logger.warn({ err, sessionId, existingEventId }, 'task-mirror failed to redact')
  }

  // 4. Forget the event id so the next non-empty tick starts fresh.
  setConfig(db, pinKey, '')
}

const PIN_KEY_PREFIX = 'task_pin_event:'

/** Post a new pinned task message on first call; on subsequent calls edit
 *  the existing message in place via `m.replace`. Survives supervisor
 *  restarts because the event id is persisted in the config table. */
async function upsertPinnedTaskMessage(
  client: MatrixClient,
  db: Database.Database,
  roomId: string,
  sessionId: string,
  formatted: { body: string; formatted_body: string },
  logger: Logger,
): Promise<void> {
  const pinKey = `${PIN_KEY_PREFIX}${sessionId}`
  const existingEventId = getConfig(db, pinKey)

  if (existingEventId) {
    // Edit-in-place. Body prefix "* " is the canonical fallback for clients
    // that don't render m.new_content; modern clients show new_content.
    try {
      await client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: `* ${formatted.body}`,
        formatted_body: `* ${formatted.formatted_body}`,
        format: 'org.matrix.custom.html',
        'm.new_content': {
          msgtype: 'm.text',
          body: formatted.body,
          formatted_body: formatted.formatted_body,
          format: 'org.matrix.custom.html',
        },
        'm.relates_to': {
          rel_type: 'm.replace',
          event_id: existingEventId,
        },
      })
      return
    } catch (err) {
      logger.warn(
        { err, sessionId, existingEventId },
        'task-mirror edit failed — falling back to a new pinned message',
      )
      // Fall through to post-new path below.
    }
  }

  // First-time post (or fallback after a failed edit).
  let newEventId: string
  try {
    newEventId = await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: formatted.body,
      formatted_body: formatted.formatted_body,
      format: 'org.matrix.custom.html',
    })
  } catch (err) {
    logger.warn({ err, sessionId }, 'task-mirror failed to post initial message')
    return
  }
  setConfig(db, pinKey, newEventId)

  // Add to pinned events, preserving anything already pinned.
  let pinned: string[] = []
  try {
    const state = await client.getRoomStateEvent(roomId, 'm.room.pinned_events', '') as
      | { pinned?: unknown } | null
    if (state && Array.isArray(state.pinned)) {
      pinned = state.pinned.filter((p): p is string => typeof p === 'string')
    }
  } catch {
    // No existing pinned_events state — that's fine, start fresh.
  }
  if (!pinned.includes(newEventId)) {
    pinned.push(newEventId)
    try {
      await client.sendStateEvent(roomId, 'm.room.pinned_events', '', { pinned })
    } catch (err) {
      logger.warn({ err, sessionId, newEventId }, 'task-mirror failed to pin message')
    }
  }
}
