import type { IpcMain, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { query, type PermissionMode, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentCommandResult,
  AgentCreateOptions,
  AgentEvent,
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentPermissionRequest,
  AgentSendInput,
  AgentSource
} from './agent-types'

interface PendingPermission {
  sessionId: string
  resolve: (value: PermissionResult) => void
  timer: NodeJS.Timeout
}

interface AgentSession {
  id: string
  cwd: string
  title?: string
  model?: string
  permissionMode: AgentPermissionMode
  resumeSessionId?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  source: AgentSource
  viewers: Map<number, WebContents>
  pendingPermissions: Map<string, PendingPermission>
  assistantMessages: Set<string>
  running?: AbortController
}

const sessions = new Map<string, AgentSession>()
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'ListMcpResources',
  'ReadMcpResource'
])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const PERMISSION_TIMEOUT_MS = 5 * 60_000

function sdkPermissionMode(mode: AgentPermissionMode): PermissionMode {
  if (mode === 'ask') return 'default'
  if (mode === 'acceptEdits') return 'acceptEdits'
  return mode
}

function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue
    if (key.startsWith('CLAUDE_CODE_')) continue
    if (key === 'ENABLE_IDE_INTEGRATION') continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `legal-terminal/${process.env.npm_package_version ?? 'dev'}`
  return env
}

function safeJsonPreview(value: unknown, max = 1600): string {
  try {
    const text = JSON.stringify(value, null, 2)
    if (!text) return ''
    return text.length > max ? `${text.slice(0, max)}...` : text
  } catch {
    return String(value)
  }
}

function textPreview(value: unknown, max = 1600): string {
  const text = typeof value === 'string' ? value : safeJsonPreview(value, max)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function emit(session: AgentSession, event: AgentEvent): void {
  for (const [id, webContents] of session.viewers) {
    if (webContents.isDestroyed()) {
      session.viewers.delete(id)
      continue
    }
    webContents.send('agent:event', event)
  }
}

function attach(session: AgentSession, webContents: WebContents): void {
  if (webContents.isDestroyed()) return
  session.viewers.set(webContents.id, webContents)
  webContents.once('destroyed', () => {
    session.viewers.delete(webContents.id)
  })
}

function startAssistant(session: AgentSession, messageId: string): void {
  if (session.assistantMessages.has(messageId)) return
  session.assistantMessages.add(messageId)
  emit(session, { type: 'message:assistant_start', sessionId: session.id, messageId })
}

function completeAssistant(session: AgentSession, messageId: string): void {
  if (!session.assistantMessages.has(messageId)) return
  emit(session, { type: 'message:assistant_done', sessionId: session.id, messageId })
}

function makeDiffProposal(session: AgentSession, toolId: string, input: Record<string, unknown>): void {
  if (!('old_string' in input) && !('new_string' in input) && !('file_path' in input)) return
  emit(session, {
    type: 'diff:proposed',
    proposal: {
      proposalId: toolId,
      sessionId: session.id,
      toolUseId: toolId,
      filePath: stringValue(input.file_path),
      oldString: stringValue(input.old_string),
      newString: stringValue(input.new_string)
    }
  })
}

function handleAssistantMessage(session: AgentSession, message: Record<string, unknown>): void {
  const messageId = stringValue(message.uuid) ?? randomUUID()
  const body = asRecord(message.message)
  const blocks = unknownArray(body?.content)
  if (blocks.length > 0) startAssistant(session, messageId)

  for (const blockValue of blocks) {
    const block = asRecord(blockValue)
    if (!block) continue
    const blockType = block.type
    if (blockType === 'text') {
      const text = stringValue(block.text)
      if (text) emit(session, { type: 'message:assistant_delta', sessionId: session.id, messageId, text })
      continue
    }
    if (blockType !== 'tool_use') continue
    const toolId = stringValue(block.id) ?? randomUUID()
    const name = stringValue(block.name) ?? 'tool'
    const input = asRecord(block.input) ?? {}
    emit(session, {
      type: 'tool:start',
      sessionId: session.id,
      toolId,
      name,
      label: name,
      inputPreview: safeJsonPreview(input)
    })
    if (EDIT_TOOLS.has(name)) makeDiffProposal(session, toolId, input)
  }
}

function handleUserMessage(session: AgentSession, message: Record<string, unknown>): void {
  const body = asRecord(message.message)
  const blocks = unknownArray(body?.content)
  for (const blockValue of blocks) {
    const block = asRecord(blockValue)
    if (!block || block.type !== 'tool_result') continue
    const toolId = stringValue(block.tool_use_id) ?? randomUUID()
    emit(session, {
      type: 'tool:done',
      sessionId: session.id,
      toolId,
      outputPreview: textPreview(block.content),
      isError: block.is_error === true
    })

    const result = asRecord(message.tool_use_result)
    if (result?.structuredPatch) {
      emit(session, {
        type: 'diff:applied',
        sessionId: session.id,
        proposalId: toolId
      })
    }
  }
}

function handleStreamEvent(session: AgentSession, message: Record<string, unknown>): void {
  const event = asRecord(message.event)
  if (!event) return
  const eventType = event.type
  if (eventType !== 'content_block_delta') return
  const delta = asRecord(event.delta)
  if (delta?.type !== 'text_delta') return
  const text = stringValue(delta.text)
  if (!text) return
  const messageId = stringValue(message.uuid) ?? 'streaming'
  startAssistant(session, messageId)
  emit(session, { type: 'message:assistant_delta', sessionId: session.id, messageId, text })
}

function handleSystemMessage(session: AgentSession, message: Record<string, unknown>): void {
  const subtype = message.subtype
  if (subtype === 'init') {
    const claudeSessionId = stringValue(message.session_id)
    if (claudeSessionId) session.resumeSessionId = claudeSessionId
    emit(session, {
      type: 'session:init',
      sessionId: session.id,
      title: session.title,
      cwd: stringValue(message.cwd) ?? session.cwd,
      source: session.source
    })
    return
  }
  if (subtype === 'status') {
    const status = message.status === 'requesting' ? 'working' : 'idle'
    emit(session, { type: 'status', sessionId: session.id, status })
    return
  }
  if (subtype === 'permission_denied') {
    const requestId = stringValue(message.tool_use_id) ?? randomUUID()
    emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision: 'reject' })
  }
}

function handleResultMessage(session: AgentSession, message: Record<string, unknown>): void {
  const subtype = stringValue(message.subtype)
  const isError = subtype !== 'success'
  if (Array.isArray(message.permission_denials)) {
    for (const denialValue of message.permission_denials) {
      const denial = asRecord(denialValue)
      const toolUseId = stringValue(denial?.tool_use_id)
      const toolName = stringValue(denial?.tool_name)
      const input = asRecord(denial?.tool_input)
      if (!toolUseId || !toolName || !input) continue
      emit(session, { type: 'permission:resolved', sessionId: session.id, requestId: toolUseId, decision: 'reject' })
      if (EDIT_TOOLS.has(toolName)) makeDiffProposal(session, toolUseId, input)
    }
  }
  emit(session, {
    type: 'status',
    sessionId: session.id,
    status: isError ? 'error' : 'done'
  })
  if (isError) {
    emit(session, {
      type: 'error',
      sessionId: session.id,
      message: `Claude 종료 상태: ${subtype ?? 'unknown'}`,
      recoverable: true
    })
  }
}

function handleSdkMessage(session: AgentSession, sdkMessage: unknown): void {
  emit(session, { type: 'raw', sessionId: session.id, message: sdkMessage })
  const message = asRecord(sdkMessage)
  if (!message) return

  if (message.type === 'system') handleSystemMessage(session, message)
  else if (message.type === 'assistant') handleAssistantMessage(session, message)
  else if (message.type === 'user') handleUserMessage(session, message)
  else if (message.type === 'stream_event') handleStreamEvent(session, message)
  else if (message.type === 'result') handleResultMessage(session, message)
}

function shouldAutoAllow(session: AgentSession, toolName: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true
  if (session.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true
  return false
}

function requestPermission(
  session: AgentSession,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    suggestions?: unknown[]
    blockedPath?: string
    decisionReason?: string
    title?: string
    displayName?: string
    description?: string
    toolUseID: string
  }
): Promise<PermissionResult> {
  if (shouldAutoAllow(session, toolName)) return Promise.resolve({ behavior: 'allow' })
  const requestId = options.toolUseID || randomUUID()
  const request: AgentPermissionRequest = {
    requestId,
    sessionId: session.id,
    toolUseId: requestId,
    toolName,
    input,
    inputPreview: safeJsonPreview(input),
    title: options.title,
    displayName: options.displayName,
    description: options.description,
    blockedPath: options.blockedPath,
    decisionReason: options.decisionReason
  }

  emit(session, { type: 'permission:request', request })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_permission' })

  return new Promise<PermissionResult>((resolve) => {
    const timer = setTimeout(() => {
      session.pendingPermissions.delete(requestId)
      emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision: 'reject' })
      resolve({
        behavior: 'deny',
        message: '권한 요청 시간이 초과되었습니다.',
        decisionClassification: 'user_reject'
      })
    }, PERMISSION_TIMEOUT_MS)
    session.pendingPermissions.set(requestId, { sessionId: session.id, resolve, timer })
  })
}

export function createAgentSession(opts: AgentCreateOptions, webContents: WebContents): AgentCommandResult {
  const existing = sessions.get(opts.id)
  if (existing) {
    attach(existing, webContents)
    return { ok: true }
  }
  if (!opts.cwd) return { ok: false, error: 'Agent 세션 cwd가 필요합니다.' }

  const session: AgentSession = {
    id: opts.id,
    cwd: opts.cwd,
    title: opts.title,
    model: opts.model,
    permissionMode: opts.permissionMode ?? 'ask',
    resumeSessionId: opts.resumeSessionId,
    tools: opts.tools,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    source: opts.source ?? 'local',
    viewers: new Map(),
    pendingPermissions: new Map(),
    assistantMessages: new Set()
  }
  sessions.set(opts.id, session)
  attach(session, webContents)
  emit(session, { type: 'session:init', sessionId: session.id, title: session.title, cwd: session.cwd, source: session.source })
  emit(session, { type: 'status', sessionId: session.id, status: 'idle' })
  return { ok: true }
}

export function sendAgentMessage(sessionId: string, input: AgentSendInput): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.running) return { ok: false, error: '이미 실행 중인 Agent 작업이 있습니다.' }
  if (!input.text.trim() && (!input.attachments || input.attachments.length === 0)) {
    return { ok: false, error: '전송할 프롬프트나 첨부가 필요합니다.' }
  }

  const messageId = randomUUID()
  const abortController = new AbortController()
  session.running = abortController
  emit(session, {
    type: 'message:user',
    sessionId,
    messageId,
    text: input.text,
    attachments: input.attachments ?? []
  })
  emit(session, { type: 'status', sessionId, status: 'working' })

  const prompt = renderPrompt(input)
  void (async () => {
    try {
      const response = query({
        prompt,
        options: {
          abortController,
          cwd: session.cwd,
          resume: session.resumeSessionId,
          model: session.model,
          tools: session.tools,
          allowedTools: session.allowedTools,
          disallowedTools: session.disallowedTools,
          permissionMode: sdkPermissionMode(session.permissionMode),
          canUseTool: (toolName, toolInput, permissionOptions) =>
            requestPermission(session, toolName, toolInput, permissionOptions),
          includeHookEvents: true,
          includePartialMessages: true,
          enableFileCheckpointing: true,
          env: cleanEnv()
        }
      })
      for await (const sdkMessage of response) {
        handleSdkMessage(session, sdkMessage)
      }
      emit(session, { type: 'status', sessionId, status: 'idle' })
    } catch (error) {
      if (!abortController.signal.aborted) {
        emit(session, {
          type: 'error',
          sessionId,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        })
        emit(session, { type: 'status', sessionId, status: 'error' })
      }
    } finally {
      if (session.running === abortController) session.running = undefined
    }
  })()

  return { ok: true }
}

function renderPrompt(input: AgentSendInput): string {
  const attachments = input.attachments ?? []
  if (attachments.length === 0) return input.text
  const renderedAttachments = attachments
    .map((attachment, index) => {
      const parts = [`${index + 1}. ${attachment.kind}: ${attachment.label}`]
      if (attachment.path) parts.push(`path=${attachment.path}`)
      if (attachment.range) parts.push(`range=${JSON.stringify(attachment.range)}`)
      if (attachment.text) parts.push(`text=${attachment.text}`)
      return parts.join('\n   ')
    })
    .join('\n')
  return `${input.text}\n\n[legal-terminal attachments]\n${renderedAttachments}`
}

export function approveAgentPermission(decision: AgentPermissionDecision): AgentCommandResult {
  for (const session of sessions.values()) {
    const pending = session.pendingPermissions.get(decision.requestId)
    if (!pending) continue
    clearTimeout(pending.timer)
    session.pendingPermissions.delete(decision.requestId)
    const allowed = decision.decision === 'allow'
    pending.resolve(
      allowed
        ? {
            behavior: 'allow',
            decisionClassification: decision.remember ? 'user_permanent' : 'user_temporary'
          }
        : {
            behavior: 'deny',
            message: decision.message ?? '사용자가 거절했습니다.',
            decisionClassification: 'user_reject'
          }
    )
    emit(session, {
      type: 'permission:resolved',
      sessionId: session.id,
      requestId: decision.requestId,
      decision: allowed ? 'allow' : 'reject'
    })
    emit(session, { type: 'status', sessionId: session.id, status: 'working' })
    return { ok: true }
  }
  return { ok: false, error: '대기 중인 권한 요청을 찾을 수 없습니다.' }
}

export function interruptAgentSession(sessionId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  session.running?.abort()
  session.running = undefined
  emit(session, { type: 'status', sessionId, status: 'idle' })
  return { ok: true }
}

export function closeAgentSession(sessionId: string, webContents?: WebContents): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: true }
  if (webContents) {
    session.viewers.delete(webContents.id)
    if (session.viewers.size > 0) return { ok: true }
  }
  session.running?.abort()
  for (const pending of session.pendingPermissions.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ behavior: 'deny', message: 'Agent 세션이 닫혔습니다.', decisionClassification: 'user_reject' })
  }
  sessions.delete(sessionId)
  return { ok: true }
}

export function disposeAgentSessions(): void {
  for (const id of [...sessions.keys()]) closeAgentSession(id)
}

export function registerAgentIpc(ipcMain: IpcMain): void {
  ipcMain.handle('agent:create', (e, opts: AgentCreateOptions) => createAgentSession(opts, e.sender))
  ipcMain.handle('agent:send', (_e, p: { sessionId: string; input: AgentSendInput }) =>
    sendAgentMessage(p.sessionId, p.input)
  )
  ipcMain.handle('agent:approve', (_e, decision: AgentPermissionDecision) =>
    approveAgentPermission(decision)
  )
  ipcMain.handle('agent:interrupt', (_e, sessionId: string) => interruptAgentSession(sessionId))
  ipcMain.handle('agent:close', (e, sessionId: string) => closeAgentSession(sessionId, e.sender))
}
