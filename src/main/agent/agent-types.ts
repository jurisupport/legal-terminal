export type AgentPermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'dontAsk'

export type AgentSource = 'local' | 'ssh'

export interface AgentAttachment {
  kind: 'file' | 'folder' | 'selection' | 'pdf-page-range' | 'terminal-snippet'
  label: string
  path?: string
  range?: { startLine?: number; endLine?: number; startPage?: number; endPage?: number }
  text?: string
}

export interface AgentCreateOptions {
  id: string
  cwd: string
  title?: string
  model?: string
  permissionMode?: AgentPermissionMode
  resumeSessionId?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  source?: AgentSource
}

export interface AgentSendInput {
  text: string
  attachments?: AgentAttachment[]
}

export interface AgentPermissionRequest {
  requestId: string
  sessionId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  inputPreview: string
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  decisionReason?: string
}

export interface AgentPermissionDecision {
  requestId: string
  decision: 'allow' | 'reject'
  message?: string
  remember?: boolean
}

export interface AgentDiffProposal {
  proposalId: string
  sessionId: string
  toolUseId: string
  filePath?: string
  oldString?: string
  newString?: string
  structuredPatch?: unknown
}

export type AgentStatus =
  | 'idle'
  | 'working'
  | 'waiting_permission'
  | 'waiting_user'
  | 'done'
  | 'error'

export type AgentEvent =
  | { type: 'session:init'; sessionId: string; title?: string; cwd: string; source: AgentSource }
  | { type: 'message:user'; sessionId: string; messageId: string; text: string; attachments: AgentAttachment[] }
  | { type: 'message:assistant_start'; sessionId: string; messageId: string }
  | { type: 'message:assistant_delta'; sessionId: string; messageId: string; text: string }
  | { type: 'message:assistant_done'; sessionId: string; messageId: string }
  | { type: 'tool:start'; sessionId: string; toolId: string; name: string; label: string; inputPreview?: string }
  | { type: 'tool:done'; sessionId: string; toolId: string; outputPreview?: string; elapsedMs?: number; isError?: boolean }
  | { type: 'permission:request'; request: AgentPermissionRequest }
  | { type: 'permission:resolved'; sessionId: string; requestId: string; decision: 'allow' | 'reject' }
  | { type: 'diff:proposed'; proposal: AgentDiffProposal }
  | { type: 'diff:applied'; sessionId: string; proposalId: string; checkpointId?: string }
  | { type: 'plan:proposed'; sessionId: string; planId: string; markdown: string }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'error'; sessionId: string; message: string; recoverable: boolean }
  | { type: 'raw'; sessionId: string; message: unknown }

export interface AgentCommandResult {
  ok: boolean
  error?: string
}
