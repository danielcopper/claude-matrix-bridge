import type { Logger } from 'pino'
import type { SSEEvent } from './types.js'

const BASE_TIMEOUT = 30000

function relayUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

export async function sendMessage(
  port: number,
  sender: string,
  content: string,
  messageId?: string,
): Promise<{ ok: boolean; message_id: string }> {
  const res = await fetch(relayUrl(port, '/message'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, content, message_id: messageId }),
    signal: AbortSignal.timeout(BASE_TIMEOUT),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`POST /message failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<{ ok: boolean; message_id: string }>
}

export async function sendPermission(
  port: number,
  requestId: string,
  behavior: 'allow' | 'deny',
): Promise<void> {
  const res = await fetch(relayUrl(port, '/permission'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, behavior }),
    signal: AbortSignal.timeout(BASE_TIMEOUT),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`POST /permission failed (${res.status}): ${body}`)
  }
}

export async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(relayUrl(port, '/health'), {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForHealth(
  port: number,
  logger: Logger,
  maxWaitMs = 15000,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (await checkHealth(port)) {
      logger.debug({ port }, 'Relay health check passed')
      return true
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  logger.warn({ port }, 'Relay health check timed out')
  return false
}

function parseSSELine(
  line: string,
  onEvent: (event: SSEEvent) => void,
  logger: Logger,
): void {
  if (line.startsWith(':')) return
  if (!line.startsWith('data: ')) return

  try {
    const event = JSON.parse(line.slice(6)) as SSEEvent
    onEvent(event)
  } catch (error_) {
    logger.warn({ line, err: error_ }, 'Failed to parse SSE event')
  }
}

async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  logger: Logger,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      parseSSELine(line, onEvent, logger)
    }
  }
}

export function connectSSE(
  port: number,
  onEvent: (event: SSEEvent) => void,
  onError: (err: Error) => void,
  logger: Logger,
): AbortController {
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(relayUrl(port, '/events'), {
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed (${res.status})`)
      }
      await readSSEStream(res.body.getReader(), onEvent, logger)
    } catch (err) {
      if (controller.signal.aborted) return
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  return controller
}
