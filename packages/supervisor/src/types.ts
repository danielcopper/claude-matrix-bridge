// --- Session ---

/**
 * Session lifecycle states. See docs/AUTO_HANDOFF.md for the state machine.
 *
 * - active       : supervisor holds the claude session via tmux
 * - local_active : a local terminal holds the claude session (supervisor passive)
 * - detached     : no claude process, session idle, ready to attach
 * - archived    : killed, kept for history but not restorable
 * - handed_off  : legacy state from earlier design; migrated to detached on startup
 */
export type SessionStatus =
  | 'active'
  | 'local_active'
  | 'handed_off'
  | 'detached'
  | 'archived'

export type PermissionMode = 'default' | 'plan' | 'bypassPermissions'

export interface Session {
  id: string
  room_id: string | null
  name: string
  working_directory: string
  model: string
  permission_mode: PermissionMode
  port: number | null
  pid: number | null
  status: SessionStatus
  created_at: string
  updated_at: string
  last_message_at: string | null
  /** PID of the local claude process when status === 'local_active'. */
  local_pid: number | null
  /** ISO timestamp of the last message Matrix has posted or received. */
  last_matrix_activity: string | null
}

// --- Permission ---

export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired'

export interface PermissionRequest {
  request_id: string
  session_id: string
  event_id: string | null
  tool_name: string
  description: string
  status: PermissionStatus
  created_at: string
  resolved_at: string | null
}

// --- Discovered sessions (from ~/.claude/projects/) ---

export interface DiscoveredSession {
  id: string
  /** User-set title (from custom-title JSONL record) */
  customTitle: string | null
  /** Claude Code auto-generated slug (e.g. "iterative-sauteeing-papert") */
  slug: string | null
  cwd: string
  gitBranch: string | null
  lastActivity: string
}

// --- SSE Events from relay plugin ---

export interface ReplyEvent {
  type: 'reply'
  content: string
  message_id?: string
}

export interface ReactEvent {
  type: 'react'
  emoji: string
  message_id: string
}

export interface PermissionRequestEvent {
  type: 'permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type SSEEvent = ReplyEvent | ReactEvent | PermissionRequestEvent
