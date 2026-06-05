export type AgentPermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'

export type AgentSource = 'local' | 'ssh'

export interface AgentSshConn {
  host: string
  user: string
  port?: number
  identityFile?: string
}

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
  ssh?: AgentSshConn
}

export interface AgentSendInput {
  text: string
  attachments?: AgentAttachment[]
  permissionMode?: AgentPermissionMode
  delivery?: 'normal' | 'queue' | 'steer'
}

export interface AgentAuthInput {
  text: string
}

export type AgentAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable' | 'error'

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

export interface AgentDialogOption {
  id: string
  label: string
  description?: string
  preview?: string
}

export interface AgentDialogQuestion {
  id: string
  question: string
  header?: string
  options: AgentDialogOption[]
  multiSelect?: boolean
}

export interface AgentDialogRequest {
  dialogId: string
  sessionId: string
  dialogKind: string
  title: string
  questions: AgentDialogQuestion[]
  payloadPreview?: string
  toolUseId?: string
  blocking: boolean
}

export interface AgentDialogAnswer {
  sessionId: string
  dialogId: string
  answers?: Record<string, string>
  response?: string
  cancelled?: boolean
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
  | { type: 'message:assistant_replace'; sessionId: string; messageId: string; text: string }
  | { type: 'message:assistant_done'; sessionId: string; messageId: string }
  | { type: 'process:event'; sessionId: string; processId: string; title: string; text?: string; status?: string }
  | {
      type: 'queue:added'
      sessionId: string
      queueId: string
      text: string
      position: number
      delivery: 'queue' | 'steer'
    }
  | { type: 'queue:started'; sessionId: string; queueId: string }
  | { type: 'queue:cleared'; sessionId: string; queueIds: string[] }
  | { type: 'tool:start'; sessionId: string; toolId: string; name: string; label: string; inputPreview?: string }
  | { type: 'tool:done'; sessionId: string; toolId: string; outputPreview?: string; elapsedMs?: number; isError?: boolean }
  | { type: 'permission:request'; request: AgentPermissionRequest }
  | { type: 'permission:resolved'; sessionId: string; requestId: string; decision: 'allow' | 'reject' }
  | { type: 'dialog:request'; sessionId: string; dialog: AgentDialogRequest }
  | {
      type: 'dialog:resolved'
      sessionId: string
      dialogId: string
      answers?: Record<string, string>
      response?: string
      cancelled?: boolean
    }
  | { type: 'diff:proposed'; proposal: AgentDiffProposal }
  | { type: 'diff:applied'; sessionId: string; proposalId: string; checkpointId?: string }
  | { type: 'plan:proposed'; sessionId: string; planId: string; markdown: string }
  | { type: 'auth:started'; sessionId: string; source: AgentSource }
  | { type: 'auth:output'; sessionId: string; text: string; urls?: string[]; codes?: string[] }
  | { type: 'auth:done'; sessionId: string; ok: boolean; exitCode: number | null; message?: string }
  | { type: 'auth:status'; sessionId: string; state: AgentAuthStatus; message?: string }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'error'; sessionId: string; message: string; recoverable: boolean }
  | { type: 'raw'; sessionId: string; message: unknown }

export interface AgentCommandResult {
  ok: boolean
  error?: string
}
