import { existsSync, readFileSync } from 'node:fs'
import { join, basename as pathBasename } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// --- JSONL types ---

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
  name?: string
  input?: Record<string, unknown>
}

// --- Tool detail types ---

interface ToolDetail {
  name: string
  filePath?: string
  oldStr?: string
  newStr?: string
  command?: string
  content?: string
}

interface ReplayPair {
  user: string
  tools: ToolDetail[]
  assistant: string
}

export interface ReplayBlock {
  body: string
  formatted_body: string
}

// --- JSONL helpers ---

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
      // Partial or corrupt line
    }
  }
  return records
}

function extractText(content: string | ContentBlock[] | undefined): string | null {
  if (!content) return null
  if (typeof content === 'string') return content.trim() || null
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text) texts.push(block.text)
  }
  return texts.length > 0 ? texts.join('\n').trim() || null : null
}

function isLocalUserMessage(r: JsonlRecord): boolean {
  if (r.type !== 'user') return false
  if (r.isMeta) return false
  if (r.origin?.kind === 'channel') return false
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

// --- Tool extraction ---

function extractToolDetails(r: JsonlRecord): ToolDetail[] {
  if (r.type !== 'assistant') return []
  const content = r.message?.content
  if (!Array.isArray(content)) return []

  const details: ToolDetail[] = []
  for (const b of content) {
    if (b.type !== 'tool_use' || !b.name) continue
    if (b.name.startsWith('mcp__matrix-relay__')) continue
    if (b.name === 'Read') continue

    const detail: ToolDetail = { name: b.name }
    const input = b.input

    if (input && typeof input.file_path === 'string') {
      detail.filePath = input.file_path
    }
    if (b.name === 'Edit' && input) {
      if (typeof input.old_string === 'string') detail.oldStr = input.old_string
      if (typeof input.new_string === 'string') detail.newStr = input.new_string
    }
    if (b.name === 'Write' && input && typeof input.content === 'string') {
      detail.content = input.content
    }
    if ((b.name === 'Bash' || b.name === 'bash') && input && typeof input.command === 'string') {
      detail.command = input.command
    }

    details.push(detail)
  }
  return details
}

// --- HTML formatting ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

function formatToolHtml(tool: ToolDetail): string {
  const parts: string[] = []
  const file = tool.filePath ? pathBasename(tool.filePath) : null

  if (tool.name === 'Edit' && file && (tool.oldStr || tool.newStr)) {
    parts.push(`<code>Edit: ${escapeHtml(file)}</code>`)
    const diffLines: string[] = []
    for (const l of (tool.oldStr ?? '').split('\n')) { if (l) diffLines.push(`- ${l}`) }
    for (const l of (tool.newStr ?? '').split('\n')) { if (l) diffLines.push(`+ ${l}`) }
    if (diffLines.length > 0) {
      parts.push(`<pre>${escapeHtml(truncate(diffLines.join('\n'), 400))}</pre>`)
    }
  } else if ((tool.name === 'Bash' || tool.name === 'bash') && tool.command) {
    parts.push(`<code>$ ${escapeHtml(truncate(tool.command, 200))}</code>`)
  } else if (tool.name === 'Write' && file) {
    parts.push(`<code>Write: ${escapeHtml(file)}</code>`)
  } else if (tool.name === 'Read' && file) {
    parts.push(`<code>Read: ${escapeHtml(file)}</code>`)
  } else if (file) {
    parts.push(`<code>${escapeHtml(tool.name)}: ${escapeHtml(file)}</code>`)
  } else {
    parts.push(`<code>${escapeHtml(tool.name)}</code>`)
  }

  return parts.join('')
}

function formatToolPlain(tool: ToolDetail): string {
  const file = tool.filePath ? pathBasename(tool.filePath) : null

  if (tool.name === 'Edit' && file && (tool.oldStr || tool.newStr)) {
    const lines = [`Edit: ${file}`]
    for (const l of (tool.oldStr ?? '').split('\n')) { if (l) lines.push(`  - ${l}`) }
    for (const l of (tool.newStr ?? '').split('\n')) { if (l) lines.push(`  + ${l}`) }
    return truncate(lines.join('\n'), 400)
  }
  if ((tool.name === 'Bash' || tool.name === 'bash') && tool.command) {
    return `$ ${truncate(tool.command, 200)}`
  }
  if (file) return `${tool.name}: ${file}`
  return tool.name
}

// --- Replay block builder ---

function formatReplayBlock(
  pairs: ReplayPair[],
  totalPairs: number,
  maxPairs: number,
  since: Date,
): ReplayBlock {
  const dateStr = since.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })

  const header = totalPairs > maxPairs
    ? `─── Local session activity (${pairs.length} of ${totalPairs} exchanges) ───`
    : '─── Local session activity ───'

  // Plain text
  const plain: string[] = [header, `(from terminal, ${dateStr})`, '']
  for (const p of pairs) {
    plain.push(`User: ${truncate(p.user, 500)}`)
    for (const t of p.tools) plain.push(formatToolPlain(t))
    plain.push(`Claude: ${truncate(p.assistant, 500)}`)
    plain.push('')
  }
  plain.push('─── Back in Matrix ───')

  // HTML
  const html: string[] = [
    `<p>${escapeHtml(header)}<br><i>(from terminal, ${escapeHtml(dateStr)})</i></p>`,
  ]
  for (const p of pairs) {
    const toolsHtml = p.tools.map(t => formatToolHtml(t)).join('<br>')
    const toolSection = toolsHtml ? `<br>${toolsHtml}<br>` : '<br>'
    html.push(
      `<blockquote><b>User:</b> ${escapeHtml(truncate(p.user, 500))}`
      + toolSection
      + `<b>Claude:</b> ${escapeHtml(truncate(p.assistant, 500))}</blockquote>`,
    )
  }
  html.push(`<p>${escapeHtml('─── Back in Matrix ───')}</p>`)

  return { body: plain.join('\n'), formatted_body: html.join('\n') }
}

// --- Public API ---

export function buildReplay(
  sessionId: string,
  workDir: string,
  since: Date | null,
  maxPairs: number,
): ReplayBlock | null {
  const path = jsonlPath(sessionId, workDir)
  if (!path) return null

  const records = parseJsonl(path)

  const pairs: ReplayPair[] = []
  let pendingUser: string | null = null
  let pendingTools: ToolDetail[] = []

  for (const r of records) {
    if (since && r.timestamp && new Date(r.timestamp) <= since) continue

    if (isLocalUserMessage(r)) {
      const text = extractText(r.message?.content)
      if (text) {
        pendingUser = text
        pendingTools = []
      }
    } else if (r.type === 'assistant' && pendingUser) {
      pendingTools.push(...extractToolDetails(r))
      if (isAssistantText(r)) {
        const text = extractText(r.message?.content)
        if (text) {
          pairs.push({ user: pendingUser, tools: pendingTools, assistant: text })
          pendingUser = null
          pendingTools = []
        }
      }
    }
  }

  if (pairs.length === 0) return null

  const totalPairs = pairs.length
  const shown = pairs.slice(-maxPairs)

  return formatReplayBlock(shown, totalPairs, maxPairs, since ?? new Date())
}
