import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { basename, resolve } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type { MatrixClient } from 'matrix-bot-sdk'
import type Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import type { Session } from './types.js'
import {
  getSessionByName,
  getAllSessions,
  createSession,
  getConfig,
} from './database.js'
import { spawnClaude } from './process-manager.js'
import { waitForHealth, connectSSE } from './relay-client.js'
import { formatMarkdown, splitMessage } from './message-formatter.js'
import { handleSSEEvent } from './bot.js'

export async function handleCommand(
  body: string,
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  controlRoomId: string,
  logger: Logger,
): Promise<string> {
  const parts = body.trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase()

  switch (cmd) {
    case '/new':
      return handleNew(parts.slice(1), client, db, config, controlRoomId, logger)
    case '/claude-help':
      return handleHelp()
    default:
      return `Unknown command: \`${cmd}\`. Type /claude-help for available commands.`
  }
}

function handleHelp(): string {
  return [
    '**Available commands:**',
    '',
    '`/new <working-dir> <name>` — Create new Claude session',
    '`/new <working-dir>` — Auto-name from directory + git branch',
    '`/new <name>` — Use default working directory',
    '`/claude-help` — Show this help',
    '',
    '*More commands (/list, /kill, /detach, /attach, /status) coming soon.*',
  ].join('\n')
}

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  if (p === '~') return homedir()
  return p
}

function autoName(workDir: string, db: Database.Database): string {
  const dirName = basename(workDir)
  let branch = ''
  try {
    branch = execFileSync('git', ['-C', workDir, 'branch', '--show-current'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
  } catch {
    // Not a git repo or git not available
  }

  const base = branch ? `${dirName}-${branch}` : dirName
  // Sanitize: lowercase, replace non-alphanumeric with dash
  let name = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')

  // Handle collision
  if (!getSessionByName(db, name)) return name
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`
    if (!getSessionByName(db, candidate)) return candidate
  }
  return `${name}-${Date.now()}`
}

function nextFreePort(db: Database.Database, config: Config): number | null {
  const usedPorts = new Set(
    getAllSessions(db)
      .filter(s => s.status === 'active' && s.port != null)
      .map(s => s.port!),
  )
  for (let port = config.ports.start; port <= config.ports.end; port++) {
    if (!usedPorts.has(port)) return port
  }
  return null
}

async function handleNew(
  args: string[],
  client: MatrixClient,
  db: Database.Database,
  config: Config,
  controlRoomId: string,
  logger: Logger,
): Promise<string> {
  let workDir: string
  let name: string | undefined

  if (args.length === 0) {
    return 'Usage: `/new <working-dir> [name]` or `/new <name>`'
  }

  if (args.length >= 2) {
    // /new <working-dir> <name>
    workDir = expandTilde(args[0]!)
    name = args[1]!
  } else {
    const arg = expandTilde(args[0]!)
    if (existsSync(arg)) {
      // /new <working-dir> — auto-name
      workDir = arg
      name = undefined
    } else {
      // /new <name> — use default workdir
      workDir = config.claude.defaultWorkDir
      name = args[0]!
    }
  }

  workDir = resolve(workDir)
  if (!existsSync(workDir)) {
    return `Directory not found: \`${workDir}\``
  }

  if (!name) {
    name = autoName(workDir, db)
  }

  if (getSessionByName(db, name)) {
    return `Session \`${name}\` already exists. Choose a different name.`
  }

  const port = nextFreePort(db, config)
  if (port == null) {
    return `No free ports available (${config.ports.start}-${config.ports.end}). Kill some sessions first.`
  }

  const domain = config.matrix.botUserId.split(':')[1]
  const spaceId = getConfig(db, 'space_id')

  // Create room
  logger.info({ name, workDir, port }, 'Creating session')
  const roomId = await client.createRoom({
    name,
    topic: `Claude session — ${workDir}`,
    preset: 'private_chat',
    invite: [config.matrix.ownerUserId],
  })

  // Add to space
  if (spaceId) {
    try {
      await client.sendStateEvent(spaceId, 'm.space.child', roomId, {
        via: [domain],
        suggested: true,
      })
      await client.sendStateEvent(roomId, 'm.space.parent', spaceId, {
        canonical: true,
        via: [domain],
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to add room to space')
    }
  }

  // Create session in DB
  const session: Session = {
    id: randomUUID(),
    room_id: roomId,
    name,
    working_directory: workDir,
    model: config.claude.model,
    permission_mode: 'default',
    port,
    pid: null,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_message_at: null,
  }
  createSession(db, session)

  // Spawn Claude in tmux
  spawnClaude(session, config, db, logger, () => {
    void client.sendHtmlText(
      roomId,
      '<strong>Claude session ended.</strong>',
    ).catch(() => {})
  })

  // Wait for relay health (longer timeout: Claude needs ~10s for confirmation prompt + startup)
  const healthy = await waitForHealth(port, logger, 30_000)
  if (!healthy) {
    return `Session \`${name}\` created but relay not responding on port ${port}. Claude may still be starting.`
  }

  // Connect SSE
  connectSSE(
    port,
    (event) => handleSSEEvent(event, session, client, db, logger),
    (err) => logger.error({ err, session: name }, 'SSE connection error'),
    logger,
  )

  // Post welcome in session room
  await client.sendHtmlText(
    roomId,
    `<strong>Session started.</strong> Working directory: <code>${workDir}</code>`,
  )

  return `Session **${name}** created → [${name}](https://matrix.to/#/${roomId})`
}
