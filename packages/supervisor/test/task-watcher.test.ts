import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readTasks,
  formatTasksAsMatrix,
  formatTasksAsRoomTopic,
  tasksDigest,
  type Task,
} from '../src/task-watcher.js'

// Override the tasks dir for tests by symlinking — but readTasks resolves
// against $HOME/.claude/tasks. Easier: run each test against a temp HOME.

// --- formatTasksAsMatrix ---

function task(id: string, status: Task['status'], subject = `t${id}`, opts: Partial<Task> = {}): Task {
  return { id, status, subject, ...opts }
}

describe('formatTasksAsMatrix', () => {
  it('returns null on empty input', () => {
    assert.equal(formatTasksAsMatrix([]), null)
  })

  it('returns null when all tasks have unknown statuses', () => {
    assert.equal(formatTasksAsMatrix([task('1', 'deleted')]), null)
  })

  it('includes the right counts in the header', () => {
    const result = formatTasksAsMatrix([
      task('1', 'completed'),
      task('2', 'completed'),
      task('3', 'in_progress'),
      task('4', 'pending'),
    ])
    assert.ok(result)
    assert.match(result.body, /4 total, 2 done/)
  })

  it('uses ✅ 🟡 ⬜ icons in the body', () => {
    const result = formatTasksAsMatrix([
      task('1', 'completed'),
      task('2', 'in_progress'),
      task('3', 'pending'),
    ])
    assert.ok(result)
    assert.match(result.body, /✅ #1/)
    assert.match(result.body, /🟡 #2/)
    assert.match(result.body, /⬜ #3/)
  })

  it('renders strikethrough for completed and bold for in_progress in HTML', () => {
    const result = formatTasksAsMatrix([
      task('1', 'completed', 'done'),
      task('2', 'in_progress', 'doing'),
      task('3', 'pending', 'todo'),
    ])
    assert.ok(result)
    assert.match(result.formatted_body, /<s>done<\/s>/)
    assert.match(result.formatted_body, /<b>doing<\/b>/)
    // pending is plain — appears un-wrapped
    assert.match(result.formatted_body, /#3 todo<\/li>/)
  })

  it('appends activeForm only for in_progress tasks', () => {
    const result = formatTasksAsMatrix([
      task('1', 'completed', 'done', { activeForm: 'Doing it' }),
      task('2', 'in_progress', 'doing', { activeForm: 'Doing the thing' }),
    ])
    assert.ok(result)
    assert.match(result.body, /🟡 #2 doing \(Doing the thing\)/)
    // Completed should NOT show activeForm
    assert.doesNotMatch(result.body, /Doing it/)
  })

  it('escapes HTML metacharacters in subjects', () => {
    const result = formatTasksAsMatrix([task('1', 'pending', 'a <script> & "thing"')])
    assert.ok(result)
    assert.doesNotMatch(result.formatted_body, /<script>/)
    assert.match(result.formatted_body, /&lt;script&gt;/)
    assert.match(result.formatted_body, /&amp;/)
  })
})

// --- formatTasksAsRoomTopic ---

describe('formatTasksAsRoomTopic', () => {
  it('returns null when no visible tasks', () => {
    assert.equal(formatTasksAsRoomTopic([]), null)
    assert.equal(formatTasksAsRoomTopic([task('1', 'deleted')]), null)
  })

  it('renders the full list as multi-line plain text', () => {
    const topic = formatTasksAsRoomTopic([
      task('1', 'completed', 'one'),
      task('2', 'in_progress', 'two', { activeForm: 'Doing two' }),
      task('3', 'pending', 'three'),
    ])
    assert.equal(
      topic,
      '📋 Tasks (1/3)\n✅ one\n🟡 two (Doing two)\n⬜ three',
    )
  })

  it('shows just the header counts when there are no in-progress tasks', () => {
    const topic = formatTasksAsRoomTopic([
      task('1', 'completed', 'a'),
      task('2', 'pending', 'b'),
    ])
    assert.ok(topic?.startsWith('📋 Tasks (1/2)\n'))
    assert.match(topic ?? '', /✅ a/)
    assert.match(topic ?? '', /⬜ b/)
  })

  it('skips activeForm for completed tasks even if set', () => {
    const topic = formatTasksAsRoomTopic([
      task('1', 'completed', 'done', { activeForm: 'Doing it' }),
    ])
    assert.doesNotMatch(topic ?? '', /Doing it/)
  })
})

// --- tasksDigest ---

describe('tasksDigest', () => {
  it('returns the same digest for the same content', () => {
    const a = [task('1', 'pending'), task('2', 'in_progress')]
    const b = [task('1', 'pending'), task('2', 'in_progress')]
    assert.equal(tasksDigest(a), tasksDigest(b))
  })

  it('changes when status changes', () => {
    const a = [task('1', 'pending')]
    const b = [task('1', 'in_progress')]
    assert.notEqual(tasksDigest(a), tasksDigest(b))
  })

  it('changes when subject changes', () => {
    const a = [task('1', 'pending', 'a')]
    const b = [task('1', 'pending', 'b')]
    assert.notEqual(tasksDigest(a), tasksDigest(b))
  })

  it('is sensitive to task order', () => {
    // The caller is responsible for sorting; readTasks does that. Digest
    // intentionally doesn't re-sort because order changes shouldn't be
    // common and changing it might mask real reorderings later.
    const a = [task('1', 'pending'), task('2', 'pending')]
    const b = [task('2', 'pending'), task('1', 'pending')]
    assert.notEqual(tasksDigest(a), tasksDigest(b))
  })
})

// --- readTasks (filesystem integration) ---

describe('readTasks', () => {
  let tmpHome: string
  const origHome = process.env.HOME

  before(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cmb-tasks-test-'))
    process.env.HOME = tmpHome
  })

  after(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeTask(sessionId: string, id: string, payload: Partial<Task>): void {
    const dir = join(tmpHome, '.claude', 'tasks', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, status: 'pending', subject: `t${id}`, ...payload }),
    )
  }

  it('returns empty for a session with no task directory', () => {
    assert.deepEqual(readTasks('no-such-session'), [])
  })

  it('reads a single task', () => {
    const sid = 'sid-single'
    writeTask(sid, '1', { status: 'in_progress', subject: 'hello' })
    const tasks = readTasks(sid)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.subject, 'hello')
  })

  it('sorts numerically (not lexicographically)', () => {
    const sid = 'sid-sort'
    writeTask(sid, '1', {})
    writeTask(sid, '2', {})
    writeTask(sid, '10', {})
    writeTask(sid, '11', {})
    const ids = readTasks(sid).map(t => t.id)
    assert.deepEqual(ids, ['1', '2', '10', '11'])
  })

  it('skips dotfiles (.highwatermark, .lock)', () => {
    const sid = 'sid-dotfiles'
    writeTask(sid, '1', {})
    // Forge some dotfile siblings
    const dir = join(tmpHome, '.claude', 'tasks', sid)
    writeFileSync(join(dir, '.highwatermark'), '5')
    writeFileSync(join(dir, '.lock'), '')
    assert.equal(readTasks(sid).length, 1)
  })

  it('survives a malformed task file (skips it)', () => {
    const sid = 'sid-malformed'
    writeTask(sid, '1', {})
    const dir = join(tmpHome, '.claude', 'tasks', sid)
    writeFileSync(join(dir, '2.json'), '{not valid json')
    const tasks = readTasks(sid)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.id, '1')
  })
})
