export type AgentPermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'

export type AgentProvider = 'claude' | 'codex'

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
  origin?: 'local' | 'remote'
  access?: 'workspace-path' | 'context-only'
  range?: { startLine?: number; endLine?: number; startPage?: number; endPage?: number }
  source?: {
    docId?: string
    path?: string
    title?: string
    text?: string
    range?: {
      startLine?: number
      startColumn?: number
      endLine?: number
      endColumn?: number
      startPage?: number
      endPage?: number
    }
  }
  text?: string
  content?: string
  contentTruncated?: boolean
}

export interface AgentCreateOptions {
  id: string
  cwd: string
  title?: string
  provider?: AgentProvider
  model?: string
  permissionMode?: AgentPermissionMode
  resumeSessionId?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  source?: AgentSource
  ssh?: AgentSshConn
}

export interface AgentWorktreeForkInput {
  cwd: string
  branchName?: string
}

export interface AgentWorktreeForkResult extends AgentCommandResult {
  path?: string
  root?: string
  branchName?: string
}

export interface AgentSessionSnapshot {
  id: string
  cwd: string
  title?: string
  provider: AgentProvider
  source: AgentSource
  resumeSessionId?: string
}

export interface AgentSessionSnapshotResult extends AgentCommandResult {
  session?: AgentSessionSnapshot
}

export interface AgentModelOption {
  id: string
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  supportedReasoningEfforts?: AgentReasoningEffortOption[]
  defaultReasoningEffort?: string
}

export interface AgentModelListResult extends AgentCommandResult {
  models?: AgentModelOption[]
  selectedModel?: string
  selectedReasoningEffort?: string
}

export interface AgentReasoningEffortOption {
  reasoningEffort: string
  description?: string
}

export interface AgentSendInput {
  text: string
  displayText?: string
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
  sessionId?: string
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
  edits?: { oldString?: string; newString?: string }[]
  structuredPatch?: unknown
  gitDiff?: unknown
}

export interface AgentSlashCommand {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
}

export type AgentStatus =
  | 'idle'
  | 'working'
  | 'waiting_permission'
  | 'waiting_user'
  | 'done'
  | 'error'

export interface AgentTokenUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
  totalCostUsd?: number
  lastTurnTokens?: number
  updatedAt: number
}

export interface AgentContextUsage {
  totalTokens: number
  maxTokens: number
  remainingTokens: number
  percentage: number
  model?: string
  updatedAt: number
}

export interface AgentRateLimitUsage {
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  utilization?: number
  remainingPercent?: number
  resetsAt?: number
  isUsingOverage?: boolean
  updatedAt: number
}

export type AgentEvent =
  | {
      type: 'session:init'
      sessionId: string
      title?: string
      cwd: string
      provider?: AgentProvider
      source: AgentSource
      slashCommands?: AgentSlashCommand[]
    }
  | { type: 'session:commands'; sessionId: string; commands: AgentSlashCommand[] }
  | { type: 'session:interrupted'; sessionId: string; message?: string }
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
  | { type: 'queue:promoted'; sessionId: string; queueId: string; position: number }
  | { type: 'queue:removed'; sessionId: string; queueId: string }
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
  | {
      type: 'diff:applied'
      sessionId: string
      proposalId: string
      checkpointId?: string
      filePath?: string
      oldString?: string
      newString?: string
      edits?: { oldString?: string; newString?: string }[]
      structuredPatch?: unknown
      gitDiff?: unknown
    }
  | { type: 'plan:proposed'; sessionId: string; planId: string; markdown: string }
  | { type: 'auth:started'; sessionId: string; source: AgentSource }
  | { type: 'auth:output'; sessionId: string; text: string; urls?: string[]; codes?: string[] }
  | { type: 'auth:done'; sessionId: string; ok: boolean; exitCode: number | null; message?: string }
  | { type: 'auth:status'; sessionId: string; state: AgentAuthStatus; message?: string }
  | {
      type: 'usage:update'
      sessionId: string
      usage?: AgentTokenUsage
      context?: AgentContextUsage
      rateLimit?: AgentRateLimitUsage
      rateLimits?: AgentRateLimitUsage[]
    }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'error'; sessionId: string; message: string; recoverable: boolean }
  | { type: 'raw'; sessionId: string; message: unknown }

export interface AgentCommandResult {
  ok: boolean
  error?: string
}
