import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredSession } from './types.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Read first N bytes of a file
function readHead(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf-8', 0, read)
  } finally {
    closeSync(fd)
  }
}

// Read last N bytes of a file
function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(bytes, size))
    const read = readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf-8', 0, read)
  } finally {
    closeSync(fd)
  }
}

function parseLines(raw: string): unknown[] {
  const results: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      results.push(JSON.parse(trimmed))
    } catch {
      // Partial line from readTail — expected
    }
  }
  return results
}

function extractMetadata(lines: unknown[]): {
  sessionId: string | null
  customTitle: string | null
  slug: string | null
  cwd: string | null
  gitBranch: string | null
  timestamp: string | null
} {
  let sessionId: string | null = null
  let customTitle: string | null = null
  let slug: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let timestamp: string | null = null

  for (const obj of lines) {
    if (typeof obj !== 'object' || obj === null) continue
    const rec = obj as Record<string, unknown>

    if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId
    if (!customTitle && rec.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle
    if (!slug && typeof rec.slug === 'string') slug = rec.slug
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (!gitBranch && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
    if (typeof rec.timestamp === 'string') timestamp = rec.timestamp
  }

  return { sessionId, customTitle, slug, cwd, gitBranch, timestamp }
}

export function scanSessions(): DiscoveredSession[] {
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }

  const sessions: DiscoveredSession[] = []

  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir)
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue

      const filePath = join(dirPath, entry)
      const fileId = basename(entry, '.jsonl')

      // Read first 8KB for sessionId, title, cwd, branch
      const headLines = parseLines(readHead(filePath, 8192))
      const head = extractMetadata(headLines)

      // Read last 8KB for most recent timestamp + slug fallback
      const tailLines = parseLines(readTail(filePath, 8192))
      const tail = extractMetadata(tailLines)

      const sessionId = head.sessionId ?? fileId
      const customTitle = head.customTitle ?? tail.customTitle
      const slug = head.slug ?? tail.slug
      const cwd = head.cwd ?? tail.cwd
      const gitBranch = head.gitBranch ?? tail.gitBranch
      const lastActivity = tail.timestamp ?? head.timestamp

      if (!lastActivity) continue

      sessions.push({
        id: sessionId,
        customTitle,
        slug,
        cwd: cwd ?? 'unknown',
        gitBranch,
        lastActivity,
      })
    }
  }

  return sessions
}
