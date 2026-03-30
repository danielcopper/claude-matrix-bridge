import { marked } from 'marked'

const MAX_MESSAGE_LENGTH = 30_000

marked.use({ gfm: true, breaks: false })

export function formatMarkdown(content: string): { body: string; formatted_body: string } {
  const formatted_body = marked.parse(content, { async: false }) as string
  return { body: content, formatted_body }
}

export function splitMessage(content: string): string[] {
  if (content.length <= MAX_MESSAGE_LENGTH) return [content]

  const chunks: string[] = []
  let rest = content

  while (rest.length > MAX_MESSAGE_LENGTH) {
    // Prefer splitting at paragraph boundaries
    const para = rest.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    const line = rest.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    const cut = para > MAX_MESSAGE_LENGTH / 2
      ? para
      : line > MAX_MESSAGE_LENGTH / 2
        ? line
        : MAX_MESSAGE_LENGTH

    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }

  if (rest) chunks.push(rest)
  return chunks
}
