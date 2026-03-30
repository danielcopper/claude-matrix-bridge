#!/usr/bin/env bun
/**
 * matrix-relay — HTTP relay channel for Claude Code.
 *
 * Generic HTTP↔MCP bridge. Spawned by Claude Code as an MCP subprocess.
 * An external supervisor communicates via HTTP endpoints on localhost.
 * No Matrix knowledge — just a dumb relay.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// --- A. Constants ---

const RELAY_PORT = Number(process.env.RELAY_PORT)
if (!RELAY_PORT || isNaN(RELAY_PORT)) {
  process.stderr.write('matrix-relay: RELAY_PORT environment variable required\n')
  process.exit(1)
}

// --- B. Global Error Handlers ---

process.on('unhandledRejection', err => {
  process.stderr.write(`matrix-relay: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`matrix-relay: uncaught exception: ${err}\n`)
})

// --- C. SSE Client Management ---

type SSEEvent = {
  type: 'reply' | 'react' | 'permission_request'
  [key: string]: unknown
}

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

function pushSSE(event: SSEEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`
  const bytes = encoder.encode(data)
  for (const controller of sseClients) {
    try {
      controller.enqueue(bytes)
    } catch {
      sseClients.delete(controller)
    }
  }
}

// --- D. Notification Retry Helper ---

async function sendNotification(
  method: string,
  params: Record<string, unknown>,
  retries = 3,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await mcp.notification({ method, params } as any)
      return
    } catch (err) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * (i + 1)))
      } else {
        throw err
      }
    }
  }
}

// --- E. MCP Server Setup ---

const mcp = new Server(
  { name: 'matrix-relay', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'Messages arrive from an external system via an HTTP relay.',
      'The sender reads messages in a Matrix chat room, not in this terminal.',
      'Anything you want them to see must go through the reply tool.',
      'Your transcript output never reaches the chat room.',
      '',
      'Messages arrive as <channel source="matrix-relay" chat_id="matrix" message_id="..." user="..." ts="...">.',
      'Use the reply tool to respond. Use react for emoji reactions.',
    ].join('\n'),
  },
)

// --- F. Permission Request Handler ---

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    pushSSE({
      type: 'permission_request',
      request_id: params.request_id,
      tool_name: params.tool_name,
      description: params.description,
      input_preview: params.input_preview,
    })
  },
)

// --- G. Tool Definitions ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message to the chat room. The user reads this in their Matrix client.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The message content (Markdown supported)',
          },
          message_id: {
            type: 'string',
            description: 'Optional: ID of the message being replied to',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message in the chat room.',
      inputSchema: {
        type: 'object',
        properties: {
          emoji: {
            type: 'string',
            description: 'The emoji to react with',
          },
          message_id: {
            type: 'string',
            description: 'ID of the message to react to',
          },
        },
        required: ['emoji', 'message_id'],
      },
    },
  ],
}))

// --- H. Tool Call Handler ---

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const content = args.content as string
        const message_id = args.message_id as string | undefined
        pushSSE({
          type: 'reply',
          content,
          ...(message_id ? { message_id } : {}),
        })
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      case 'react': {
        const emoji = args.emoji as string
        const message_id = args.message_id as string
        pushSSE({ type: 'react', emoji, message_id })
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// --- I. MCP Connect ---

await mcp.connect(new StdioServerTransport())

// --- J. HTTP Server ---

Bun.serve({
  port: RELAY_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    // POST /message — Supervisor sends a message to Claude
    if (url.pathname === '/message' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          sender: string
          content: string
          message_id?: string
        }
        if (!body.sender || !body.content) {
          return Response.json(
            { error: 'sender and content required' },
            { status: 400 },
          )
        }
        const message_id = body.message_id ?? `msg_${Date.now()}`
        await sendNotification('notifications/claude/channel', {
          content: body.content,
          meta: {
            chat_id: 'matrix',
            message_id,
            user: body.sender,
            ts: new Date().toISOString(),
          },
        })
        return Response.json({ ok: true, message_id })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`matrix-relay: /message error: ${msg}\n`)
        return Response.json({ error: msg }, { status: 500 })
      }
    }

    // GET /events — SSE stream for replies and permission requests
    if (url.pathname === '/events' && req.method === 'GET') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseClients.add(controller)
          controller.enqueue(encoder.encode(': connected\n\n'))
        },
        cancel(controller) {
          sseClients.delete(controller as ReadableStreamDefaultController<Uint8Array>)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // POST /permission — Supervisor sends permission verdict
    if (url.pathname === '/permission' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          request_id: string
          behavior: 'allow' | 'deny'
        }
        if (!body.request_id || !body.behavior) {
          return Response.json(
            { error: 'request_id and behavior required' },
            { status: 400 },
          )
        }
        if (body.behavior !== 'allow' && body.behavior !== 'deny') {
          return Response.json(
            { error: 'behavior must be allow or deny' },
            { status: 400 },
          )
        }
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: body.request_id,
            behavior: body.behavior,
          },
        } as any)
        return Response.json({ ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`matrix-relay: /permission error: ${msg}\n`)
        return Response.json({ error: msg }, { status: 500 })
      }
    }

    // GET /health — Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', port: RELAY_PORT })
    }

    return new Response('not found', { status: 404 })
  },
})

// --- K. Startup Log ---

process.stderr.write(`matrix-relay: http://127.0.0.1:${RELAY_PORT}\n`)

// --- L. Shutdown ---

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('matrix-relay: shutting down\n')
  for (const controller of sseClients) {
    try {
      controller.close()
    } catch {}
  }
  sseClients.clear()
  setTimeout(() => process.exit(0), 2000)
  void mcp.close().finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
