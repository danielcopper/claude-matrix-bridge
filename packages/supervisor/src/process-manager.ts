import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from 'pino'
import type Database from 'better-sqlite3'
import type { Session } from './types.js'
import { updateSession, expireSessionPermissions } from './database.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Track active tmux session names for cleanup
export const activeSessions = new Set<string>()

export function relayPluginPath(): string {
  return resolve(__dirname, '..', '..', 'matrix-relay')
}

function tmuxSessionName(session: Session): string {
  return `claude-${session.name}`
}

function quoteArg(a: string): string {
  return `'${a}'`
}

export async function ensureRelayRegistered(logger: Logger): Promise<void> {
  const pluginPath = relayPluginPath()

  // Check if matrix-relay is already registered
  try {
    const output = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf-8',
      timeout: 10000,
    })
    if (output.includes('matrix-relay')) {
      logger.debug('matrix-relay MCP server already registered')
      return
    }
  } catch {
    // mcp list failed — try to register anyway
  }

  // Find bun binary via mise (bun is managed by mise, not in global PATH)
  let bunPath: string
  try {
    bunPath = execFileSync('mise', ['which', 'bun'], {
      encoding: 'utf-8',
      cwd: pluginPath,
      timeout: 10000,
    }).trim()
  } catch {
    // Fallback: check global PATH
    try {
      bunPath = execFileSync('which', ['bun'], { encoding: 'utf-8' }).trim()
    } catch {
      throw new Error('Could not find bun binary. Run "mise install" in packages/matrix-relay/')
    }
  }

  const serverConfig = JSON.stringify({
    command: bunPath,
    args: ['run', '--cwd', pluginPath, '--shell=bun', '--silent', 'start'],
  })

  logger.info('Registering matrix-relay MCP server (user scope)')
  execFileSync('claude', ['mcp', 'add-json', '--scope', 'user', 'matrix-relay', serverConfig], {
    encoding: 'utf-8',
    timeout: 10000,
  })
  logger.info('matrix-relay MCP server registered')
}

export function spawnClaude(
  session: Session,
  _config: unknown,
  db: Database.Database,
  logger: Logger,
  options?: { resume?: boolean; onExit?: (code: number | null) => void },
): void {
  const tmuxName = tmuxSessionName(session)
  const sessionLogger = logger.child({ session: session.name, port: session.port, tmux: tmuxName })

  // Build the claude command to run inside tmux
  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:matrix-relay',
    '--model', session.model,
    // Auto-allow relay tools so Claude doesn't prompt in tmux
    '--allowedTools', 'mcp__matrix-relay__reply mcp__matrix-relay__react',
  ]

  if (options?.resume) {
    // Resume existing session — don't pass --session-id (conflicts with --resume)
    claudeArgs.push('--resume', session.id)
  } else {
    // New session
    claudeArgs.push('--session-id', session.id, '--name', session.name)
  }

  if (session.permission_mode === 'bypassPermissions') {
    claudeArgs.push('--dangerously-skip-permissions')
  }

  // Construct the full command string for tmux
  // RELAY_PORT is set as env var prefix so the channel plugin picks it up
  // CMB_MANAGED=1 tells the session-hook.sh to skip notifying the supervisor
  // (prevents infinite loop: supervisor resumes → hook fires → supervisor hands off → ...)
  const quotedArgs = claudeArgs.map(quoteArg).join(' ')
  const claudeCmd = `CMB_MANAGED=1 RELAY_PORT=${session.port} claude ${quotedArgs}`

  sessionLogger.info({ cwd: session.working_directory, claudeCmd }, 'Spawning Claude in tmux')

  // Kill stale tmux session with same name if it exists
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxName], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Killed stale tmux session')
  } catch {
    // No existing session — expected
  }

  // Create a detached tmux session running claude
  try {
    execFileSync('tmux', [
      'new-session',
      '-d',                    // detached
      '-s', tmuxName,          // session name
      '-c', session.working_directory,  // working directory
      claudeCmd,               // command to run
    ], {
      encoding: 'utf-8',
      timeout: 10000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sessionLogger.error({ err: msg }, 'Failed to create tmux session')
    throw new Error(`Failed to start Claude tmux session: ${msg}`)
  }

  activeSessions.add(session.id)

  // Auto-confirm the development channels prompt.
  // Poll tmux pane content until the confirmation dialog appears, then send Enter.
  void (async () => {
    const maxAttempts = 20 // 20 * 500ms = 10s max wait
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const pane = execFileSync('tmux', ['capture-pane', '-t', tmuxName, '-p'], {
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (pane.includes('I am using this for local development')) {
          execFileSync('tmux', ['send-keys', '-t', tmuxName, 'Enter'], {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          sessionLogger.info('Auto-confirmed development channels prompt')
          return
        }
        if (pane.includes('Listening for channel messages')) {
          sessionLogger.debug('Channel already active, no confirmation needed')
          return
        }
      } catch {
        // tmux session might not be ready yet
      }
    }
    sessionLogger.warn('Development channels prompt not detected within 10s')
  })()

  // Get the PID of the claude process inside tmux
  try {
    const paneInfo = execFileSync('tmux', [
      'list-panes', '-t', tmuxName, '-F', '#{pane_pid}',
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

    const pid = Number(paneInfo)
    if (pid) {
      updateSession(db, session.id, { pid })
      sessionLogger.info({ pid }, 'Claude tmux session started')
    }
  } catch {
    sessionLogger.warn('Could not get tmux pane PID')
  }

  // Monitor tmux session — poll for exit
  const pollInterval = setInterval(() => {
    try {
      execFileSync('tmux', ['has-session', '-t', tmuxName], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      clearInterval(pollInterval)
      activeSessions.delete(session.id)
      updateSession(db, session.id, { pid: null })
      expireSessionPermissions(db, session.id)
      sessionLogger.warn('Claude tmux session ended')
      options?.onExit?.(null)
    }
  }, 5000)

  exitPollers.set(session.id, pollInterval)
}

const exitPollers = new Map<string, ReturnType<typeof setInterval>>()

export async function killClaude(
  session: Session,
  logger: Logger,
): Promise<void> {
  const tmuxName = tmuxSessionName(session)
  const sessionLogger = logger.child({ session: session.name, tmux: tmuxName })

  const poller = exitPollers.get(session.id)
  if (poller) {
    clearInterval(poller)
    exitPollers.delete(session.id)
  }

  // Send Ctrl+C to Claude first (graceful)
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxName, 'C-c', ''], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Sent Ctrl+C to Claude')
  } catch {
    // Session might already be gone
  }

  await new Promise(r => setTimeout(r, 3000))

  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxName], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Killed tmux session')
  } catch {
    // Already gone
  }

  activeSessions.delete(session.id)
}

export async function killAllProcesses(logger: Logger): Promise<void> {
  // Stop all exit pollers
  for (const [id, poller] of exitPollers) {
    clearInterval(poller)
    exitPollers.delete(id)
  }

  // Kill all tmux sessions with claude- prefix
  try {
    const sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')

    for (const name of sessions) {
      if (name.startsWith('claude-')) {
        try {
          execFileSync('tmux', ['kill-session', '-t', name], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          logger.info({ tmux: name }, 'Killed tmux session')
        } catch {
          // Already gone
        }
      }
    }
  } catch {
    // tmux not running or no sessions
  }

  activeSessions.clear()
}
