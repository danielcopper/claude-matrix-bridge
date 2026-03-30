import { marked } from 'marked'

const MAX_MESSAGE_LENGTH = 30000
const HALF_MAX = MAX_MESSAGE_LENGTH / 2

marked.use({ gfm: true, breaks: false })

export function formatMarkdown(content: string): { body: string; formatted_body: string } {
  const formatted_body = String(marked.parse(content, { async: false }))
  return { body: content, formatted_body }
}

function findSplitPoint(text: string): number {
  const para = text.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
  if (para > HALF_MAX) return para
  const line = text.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
  if (line > HALF_MAX) return line
  return MAX_MESSAGE_LENGTH
}

export function splitMessage(content: string): string[] {
  if (content.length <= MAX_MESSAGE_LENGTH) return [content]

  const chunks: string[] = []
  let rest = content

  while (rest.length > MAX_MESSAGE_LENGTH) {
    const cut = findSplitPoint(rest)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }

  if (rest) chunks.push(rest)
  return chunks
}
