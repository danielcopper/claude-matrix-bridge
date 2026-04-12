import type { Logger } from 'pino'

export interface RetryOptions {
  // Delays between attempts. attempts = delaysMs.length + 1.
  // Default: 500ms, 2000ms, 5000ms → 4 attempts, ~7.5s worst case.
  delaysMs?: number[]
}

const DEFAULT_DELAYS_MS = [500, 2000, 5000]

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; statusCode?: number; code?: string; cause?: { code?: string } }

  if (e.name === 'AbortError') return false

  // If the error carries an HTTP status code, retry 5xx only.
  // 4xx (auth, not found, bad request) will not succeed on retry.
  // matrix-bot-sdk already retries 429 / M_LIMIT_EXCEEDED internally.
  if (typeof e.statusCode === 'number') {
    return e.statusCode >= 500 && e.statusCode < 600
  }

  // No status code → most likely a network layer failure
  // (ECONNRESET, ETIMEDOUT, DNS, socket hang up, "fetch failed" from undici).
  // These are transient and worth retrying.
  return true
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  logger: Logger,
  opts: RetryOptions = {},
): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS
  const attempts = delays.length + 1

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetriable(err) || attempt === attempts) {
        throw err
      }
      const delay = delays[attempt - 1] ?? 500
      logger.warn({ label, attempt, nextDelayMs: delay, err }, 'Retrying after transient error')
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

export async function withRetrySoft<T>(
  label: string,
  fn: () => Promise<T>,
  logger: Logger,
  opts: RetryOptions = {},
): Promise<T | null> {
  try {
    return await withRetry(label, fn, logger, opts)
  } catch (err) {
    logger.error({ label, err }, 'Call failed after all retries')
    return null
  }
}
