import type { MatrixClient } from 'matrix-bot-sdk'
import type { Logger } from 'pino'
import { withRetrySoft } from './retry.js'

// Best-effort Matrix send wrappers. Each retries on network / 5xx,
// logs loudly on final failure, and returns null instead of throwing.
// Callers that don't care about the event id can ignore the return value.
//
// Scope: user-facing room messages (status text, replay blocks, typing).
// Bootstrap calls (createSpace, inviteUser, etc.) stay bare — systemd
// restart is the retry for those.

export async function safeSendText(
  client: MatrixClient,
  roomId: string,
  text: string,
  logger: Logger,
  label = 'sendText',
): Promise<string | null> {
  return withRetrySoft(label, () => client.sendText(roomId, text), logger)
}

export async function safeSendHtml(
  client: MatrixClient,
  roomId: string,
  html: string,
  logger: Logger,
  label = 'sendHtmlText',
): Promise<string | null> {
  return withRetrySoft(label, () => client.sendHtmlText(roomId, html), logger)
}

export async function safeSendMessage(
  client: MatrixClient,
  roomId: string,
  content: Record<string, unknown>,
  logger: Logger,
  label = 'sendMessage',
): Promise<string | null> {
  return withRetrySoft(label, () => client.sendMessage(roomId, content), logger)
}

export async function safeSetTyping(
  client: MatrixClient,
  roomId: string,
  active: boolean,
  logger: Logger,
  durationMs = 30000,
): Promise<void> {
  try {
    await client.setTyping(roomId, active, durationMs)
  } catch (err) {
    logger.debug({ err, roomId, active }, 'setTyping failed (ignored)')
  }
}
