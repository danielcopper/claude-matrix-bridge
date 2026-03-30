// --- Session ---

export type SessionStatus = 'active' | 'detached' | 'archived'
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
