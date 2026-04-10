import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

interface JsonlRecord {
  type: string
  message?: { role?: string; content?: string | ContentBlock[] }
  isMeta?: boolean
  origin?: { kind?: string }
  timestamp?: string
}

interface ContentBlock {
  type: string
  text?: string
}

interface ReplayMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Encode a working directory path the way Claude Code does for its
 * projects directory: replace all `/` with `-`.
 */
function encodeWorkDir(workDir: string): string {
  return workDir.replaceAll('/', '-')
}

function jsonlPath(sessionId: string, workDir: string): string | null {
  const encoded = encodeWorkDir(workDir)
  const path = join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`)
  return existsSync(path) ? path : null
}

function parseJsonl(path: string): JsonlRecord[] {
  const records: JsonlRecord[] = []
  const content = readFileSync(path, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as JsonlRecord)
    } catch {
      // Partial or corrupt line — skip
    }
  }
  return records
}

function extractText(content: string | ContentBlock[] | undefined): string | null {
  if (!content) return null
  if (typeof content === 'string') return content.trim() || null

  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
    }
  }
  return texts.length > 0 ? texts.join('\n').trim() || null : null
}

function isLocalUserMessage(r: JsonlRecord): boolean {
  if (r.type !== 'user') return false
  if (r.isMeta) return false
  if (r.origin?.kind === 'channel') return false
  // tool_result entries have array content with type: 'tool_result'
  const content = r.message?.content
  if (Array.isArray(content)) {
    return content.some((b: ContentBlock) => b.type === 'text')
  }
  return typeof content === 'string'
}

function isAssistantText(r: JsonlRecord): boolean {
  if (r.type !== 'assistant') return false
  const content = r.message?.content
  if (!content) return false
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some((b: ContentBlock) => b.type === 'text' && !!b.text?.trim())
  }
  return false
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

function formatReplayBlock(
  messages: ReplayMessage[],
  totalPairs: number,
  maxPairs: number,
  since: Date,
): string {
  const shownPairs = Math.min(totalPairs, maxPairs)
  const dateStr = since.toISOString().replace('T', ' ').slice(0, 16)

  const header = totalPairs > maxPairs
    ? `─── Local session activity (${shownPairs} of ${totalPairs} exchanges) ───`
    : '─── Local session activity ───'

  const lines = [header, '', `*(from terminal, ${dateStr})*`, '']

  for (let i = 0; i < messages.length; i += 2) {
    const user = messages[i]
    const assistant = messages[i + 1]
    if (user) lines.push(`> **User:** ${truncateText(user.text, 500)}`)
    if (assistant) lines.push(`> **Claude:** ${truncateText(assistant.text, 500)}`)
    lines.push('')
  }

  lines.push('─── Back in Matrix ───')
  return lines.join('\n')
}

export function buildReplay(
  sessionId: string,
  workDir: string,
  since: Date | null,
  maxPairs: number,
): string | null {
  const path = jsonlPath(sessionId, workDir)
  if (!path) return null

  const records = parseJsonl(path)

  // Collect local user/assistant text pairs after the cutoff
  const pairs: { user: string; assistant: string }[] = []
  let pendingUser: string | null = null

  for (const r of records) {
    if (since && r.timestamp && new Date(r.timestamp) <= since) continue

    if (isLocalUserMessage(r)) {
      const text = extractText(r.message?.content)
      if (text) pendingUser = text
    } else if (isAssistantText(r) && pendingUser) {
      const text = extractText(r.message?.content)
      if (text) {
        pairs.push({ user: pendingUser, assistant: text })
        pendingUser = null
      }
    }
  }

  if (pairs.length === 0) return null

  const totalPairs = pairs.length
  const shown = pairs.slice(-maxPairs) // Show most recent if truncated

  const messages: ReplayMessage[] = []
  for (const pair of shown) {
    messages.push({ role: 'user', text: pair.user })
    messages.push({ role: 'assistant', text: pair.assistant })
  }

  return formatReplayBlock(messages, totalPairs, maxPairs, since ?? new Date())
}
