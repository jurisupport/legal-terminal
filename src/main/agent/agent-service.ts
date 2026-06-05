import type { IpcMain, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import {
  query,
  type PermissionMode,
  type PermissionResult,
  type UserDialogRequest,
  type UserDialogResult
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentCommandResult,
  AgentCreateOptions,
  AgentEvent,
  AgentAuthInput,
  AgentAuthStatus,
  AgentDialogAnswer,
  AgentDialogQuestion,
  AgentDialogRequest,
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentPermissionRequest,
  AgentSendInput,
  AgentSshConn,
  AgentSource
} from './agent-types'

interface PendingPermission {
  sessionId: string
  resolve: (value: PermissionResult) => void
  timer: NodeJS.Timeout
}

interface PendingDialog {
  sessionId: string
  finish: (value: UserDialogResult, answer?: AgentDialogAnswer) => void
  timer: NodeJS.Timeout
}

interface QueuedAgentMessage {
  queueId: string
  input: AgentSendInput
  delivery: 'queue' | 'steer'
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
  ssh?: AgentSshConn
  authStatus?: AgentAuthStatus
  viewers: Map<number, WebContents>
  pendingPermissions: Map<string, PendingPermission>
  pendingDialogs: Map<string, PendingDialog>
  dialogs: Map<string, AgentDialogRequest>
  assistantMessages: Set<string>
  assistantText: Map<string, string>
  assistantStreamed: Set<string>
  startedTools: Set<string>
  queue: QueuedAgentMessage[]
  turnAssistantMessageId?: string
  activeAssistantMessageId?: string
  running?: AbortController
  remoteProcess?: ChildProcessWithoutNullStreams
  authProcess?: ChildProcessWithoutNullStreams
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
const USER_DIALOG_TIMEOUT_MS = 30 * 60_000
const MIN_TEXT_OVERLAP = 4
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const CLAUDE_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS'
])

interface SshArgsOptions {
  batchMode?: boolean
  tty?: boolean
}

function sdkPermissionMode(mode: AgentPermissionMode): PermissionMode {
  if (mode === 'ask') return 'default'
  if (mode === 'acceptEdits') return 'acceptEdits'
  return mode
}

function cliPermissionMode(mode: AgentPermissionMode): string {
  if (mode === 'ask') return 'default'
  if (mode === 'acceptEdits') return 'acceptEdits'
  return mode
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function sshArgs(ssh: AgentSshConn, opts: SshArgsOptions = {}): string[] {
  const args: string[] = []
  if (opts.tty) args.push('-tt')
  if (ssh.port) args.push('-p', String(ssh.port))
  if (ssh.identityFile) args.push('-i', ssh.identityFile)
  if (opts.batchMode !== false) args.push('-o', 'BatchMode=yes')
  args.push('-o', 'ConnectTimeout=20')
  args.push('-o', 'ServerAliveInterval=30')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${ssh.user}@${ssh.host}`)
  return args
}

function shellArgFlag(flag: string, value: string | undefined): string {
  return value ? ` ${flag} ${shq(value)}` : ''
}

function shellListFlag(flag: string, values: string[] | undefined): string {
  return values && values.length ? ` ${flag} ${shq(values.join(','))}` : ''
}

function unsetClaudeAuthEnvCommand(): string {
  return `unset ${Array.from(CLAUDE_AUTH_ENV_KEYS).join(' ')}`
}

function remoteClaudeCommand(session: AgentSession): string {
  const mode = cliPermissionMode(session.permissionMode)
  const flags = [
    '-p --verbose --output-format stream-json',
    '--include-partial-messages --include-hook-events',
    `--permission-mode ${shq(mode)}`,
    session.permissionMode === 'bypassPermissions' ? '--allow-dangerously-skip-permissions' : '',
    shellArgFlag('--resume', session.resumeSessionId).trim(),
    shellArgFlag('--model', session.model).trim(),
    shellListFlag('--tools', session.tools).trim(),
    shellListFlag('--allowedTools', session.allowedTools).trim(),
    shellListFlag('--disallowedTools', session.disallowedTools).trim()
  ]
    .filter(Boolean)
    .join(' ')
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    unsetClaudeAuthEnvCommand(),
    'export CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true',
    `cd ${shq(session.cwd)} || exit`,
    'claude_bin=$(command -v claude 2>/dev/null || true)',
    'if [ -z "$claude_bin" ]; then echo "claude command not found on remote PATH" >&2; exit 127; fi',
    `exec "$claude_bin" ${flags}`
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteClaudeAuthCommand(): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    unsetClaudeAuthEnvCommand(),
    'claude_bin=$(command -v claude 2>/dev/null || true)',
    'if [ -z "$claude_bin" ]; then echo "claude command not found on remote PATH" >&2; exit 127; fi',
    'exec "$claude_bin" auth login --claudeai'
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteClaudeAuthStatusCommand(): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    unsetClaudeAuthEnvCommand(),
    'claude_bin=$(command -v claude 2>/dev/null || true)',
    'if [ -z "$claude_bin" ]; then echo "claude command not found on remote PATH" >&2; exit 127; fi',
    'exec "$claude_bin" auth status'
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue
    if (key.startsWith('CLAUDE_CODE_')) continue
    if (CLAUDE_AUTH_ENV_KEYS.has(key)) continue
    if (key === 'ENABLE_IDE_INTEGRATION') continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `legal-terminal/${process.env.npm_package_version ?? 'dev'}`
  return env
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function cleanProcessText(value: string): string {
  return stripAnsi(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>"'`]+/g) ?? []
  return [...new Set(matches.map((url) => url.replace(/[),.;\]]+$/g, '')))]
}

function extractAuthCodes(value: string): string[] {
  const codes: string[] = []
  for (const match of value.matchAll(/(?:code|코드)[^\n:：]*[:：]\s*([A-Z0-9][A-Z0-9-]{5,})/gi)) {
    codes.push(match[1])
  }
  for (const match of value.matchAll(/\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,3})\b/g)) {
    codes.push(match[1])
  }
  return [...new Set(codes)]
}

function emitAuthOutput(session: AgentSession, chunk: Buffer | string): void {
  const text = cleanProcessText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
  if (!text.trim()) return
  const urls = extractUrls(text)
  const codes = extractAuthCodes(text)
  emit(session, {
    type: 'auth:output',
    sessionId: session.id,
    text,
    urls: urls.length ? urls : undefined,
    codes: codes.length ? codes : undefined
  })
}

function emitAuthStatus(session: AgentSession, state: AgentAuthStatus, message?: string): void {
  session.authStatus = state
  emit(session, { type: 'auth:status', sessionId: session.id, state, message })
}

function loggedInFromAuthStatusOutput(output: string): boolean | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const record = asRecord(parsed)
    if (typeof record?.loggedIn === 'boolean') return record.loggedIn
  } catch {
    /* Older Claude builds may print plain text. */
  }
  if (/not\s+(logged|signed)\s+in|login\s+required|not authenticated|인증.*필요/i.test(trimmed)) return false
  if (/(logged|signed)\s+in|authenticated|claude\.ai/i.test(trimmed)) return true
  return undefined
}

function refreshAgentAuthStatus(session: AgentSession): void {
  if (session.source !== 'ssh' || !session.ssh || session.authProcess || session.running) return
  emitAuthStatus(session, 'checking')
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(sshBin, [...sshArgs(session.ssh), remoteClaudeAuthStatusCommand()], {
      windowsHide: true,
      env: cleanEnv()
    })
  } catch (error) {
    emitAuthStatus(session, 'error', error instanceof Error ? error.message : String(error))
    return
  }

  let output = ''
  const append = (chunk: Buffer): void => {
    output = (output + cleanProcessText(chunk.toString('utf8'))).slice(-6000)
  }
  proc.stdout.on('data', append)
  proc.stderr.on('data', append)
  proc.on('error', (error) => emitAuthStatus(session, 'error', error.message))
  proc.on('close', (code) => {
    const loggedIn = loggedInFromAuthStatusOutput(output)
    if (loggedIn === true) {
      emitAuthStatus(session, 'authenticated')
      return
    }
    if (code === 127 || /claude command not found/i.test(output)) {
      emitAuthStatus(session, 'unavailable', '원격에서 Claude Code CLI를 찾을 수 없습니다.')
      return
    }
    if (loggedIn === false || code !== 0) {
      emitAuthStatus(session, 'unauthenticated')
      return
    }
    emitAuthStatus(session, 'error', 'Claude 로그인 상태를 확인할 수 없습니다.')
  })
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

function diffEditsFromInput(input: Record<string, unknown>): { oldString?: string; newString?: string }[] {
  const edits: { oldString?: string; newString?: string }[] = []
  for (const value of unknownArray(input.edits)) {
    const edit = asRecord(value)
    if (!edit) continue
    const oldString = stringValue(edit.old_string)
    const newString = stringValue(edit.new_string)
    if (oldString !== undefined || newString !== undefined) edits.push({ oldString, newString })
  }
  if (edits.length > 0) return edits

  const oldString = stringValue(input.old_string)
  const newString = stringValue(input.new_string) ?? stringValue(input.content)
  return oldString !== undefined || newString !== undefined ? [{ oldString, newString }] : []
}

function isAskUserQuestionTool(name: string): boolean {
  return /^(askuserquestion|ask_user_question|request_user_question)$/i.test(name)
}

function normalizeDialogQuestions(payload: Record<string, unknown>): AgentDialogQuestion[] {
  const questions: AgentDialogQuestion[] = []
  for (const [questionIndex, questionValue] of unknownArray(payload.questions).entries()) {
    const question = asRecord(questionValue)
    if (!question) continue
    const text = stringValue(question.question) ?? stringValue(question.text)
    if (!text) continue
    const options: AgentDialogQuestion['options'] = []
    for (const [optionIndex, optionValue] of unknownArray(question.options).entries()) {
      const option = asRecord(optionValue)
      const label = stringValue(option?.label) ?? stringValue(option?.value)
      if (!label) continue
      options.push({
        id: stringValue(option?.id) ?? `${questionIndex}-${optionIndex}`,
        label,
        description: stringValue(option?.description),
        preview: stringValue(option?.preview)
      })
    }
    questions.push({
      id: stringValue(question.id) ?? `q-${questionIndex}`,
      question: text,
      header: stringValue(question.header),
      options,
      multiSelect: question.multiSelect === true
    })
  }
  return questions
}

function emitDialogRequest(
  session: AgentSession,
  dialog: Omit<AgentDialogRequest, 'sessionId'>
): AgentDialogRequest {
  const fullDialog: AgentDialogRequest = { ...dialog, sessionId: session.id }
  session.dialogs.set(fullDialog.dialogId, fullDialog)
  emit(session, { type: 'dialog:request', sessionId: session.id, dialog: fullDialog })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_user' })
  return fullDialog
}

function makeQuestionDialog(
  session: AgentSession,
  opts: {
    dialogId: string
    dialogKind: string
    payload: Record<string, unknown>
    toolUseId?: string
    blocking: boolean
  }
): AgentDialogRequest | null {
  const questions = normalizeDialogQuestions(opts.payload)
  if (questions.length === 0) return null
  const title =
    stringValue(opts.payload.title) ??
    stringValue(opts.payload.header) ??
    questions[0]?.header ??
    'Claude 질문'
  return emitDialogRequest(session, {
    dialogId: opts.dialogId,
    dialogKind: opts.dialogKind,
    title,
    questions,
    payloadPreview: safeJsonPreview(opts.payload),
    toolUseId: opts.toolUseId,
    blocking: opts.blocking
  })
}

function buildQuestionDialogResult(
  dialog: AgentDialogRequest,
  answer: AgentDialogAnswer
): UserDialogResult {
  if (answer.cancelled) return { behavior: 'cancelled' }
  const result = {
    questions: dialog.questions.map((question) => ({
      question: question.question,
      header: question.header ?? question.question.slice(0, 12),
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description ?? '',
        ...(option.preview ? { preview: option.preview } : {})
      })),
      multiSelect: question.multiSelect === true
    })),
    answers: answer.answers ?? {},
    ...(answer.response?.trim() ? { response: answer.response.trim() } : {})
  }
  return { behavior: 'completed', result }
}

function renderDialogAnswerText(dialog: AgentDialogRequest | undefined, answer: AgentDialogAnswer): string {
  const lines = ['사용자가 Claude의 선택 질문에 답했습니다.']
  if (dialog) {
    lines.push('', `선택 요청: ${dialog.title}`)
  }
  if (answer.cancelled) {
    lines.push('', '응답: 취소')
    return lines.join('\n')
  }
  const entries = Object.entries(answer.answers ?? {})
  if (entries.length > 0) {
    lines.push('', '선택 답변:')
    for (const [question, value] of entries) lines.push(`- ${question}: ${value}`)
  }
  const response = answer.response?.trim()
  if (response) lines.push('', '직접 입력:', response)
  return lines.join('\n')
}

function requestUserDialog(
  session: AgentSession,
  request: UserDialogRequest,
  signal: AbortSignal
): Promise<UserDialogResult> {
  const dialogId = randomUUID()
  const dialog = makeQuestionDialog(session, {
    dialogId,
    dialogKind: request.dialogKind,
    payload: request.payload,
    toolUseId: request.toolUseID,
    blocking: true
  })
  if (!dialog) {
    emitProcessEvent(
      session,
      `dialog-${dialogId}`,
      'Claude 선택 요청',
      safeJsonPreview(request.payload),
      'cancelled'
    )
    return Promise.resolve({ behavior: 'cancelled' })
  }

  return new Promise<UserDialogResult>((resolve) => {
    let timer: NodeJS.Timeout
    let settled = false
    function abort(): void {
      finish({ behavior: 'cancelled' }, { sessionId: session.id, dialogId, cancelled: true })
    }
    function finish(result: UserDialogResult, answer?: AgentDialogAnswer): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      session.pendingDialogs.delete(dialogId)
      emit(session, {
        type: 'dialog:resolved',
        sessionId: session.id,
        dialogId,
        answers: answer?.answers,
        response: answer?.response,
        cancelled: answer?.cancelled
      })
      emit(session, { type: 'status', sessionId: session.id, status: 'working' })
      resolve(result)
    }
    timer = setTimeout(() => {
      finish({ behavior: 'cancelled' }, { sessionId: session.id, dialogId, cancelled: true })
    }, USER_DIALOG_TIMEOUT_MS)
    session.pendingDialogs.set(dialogId, {
      sessionId: session.id,
      finish,
      timer
    })
    signal.addEventListener('abort', abort, { once: true })
  })
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

function commonOverlapLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  for (let length = max; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length
  }
  return 0
}

function mergeAssistantDelta(current: string, chunk: string): string {
  if (!current) return chunk
  if (!chunk) return current
  if (chunk.startsWith(current)) return chunk
  if (chunk.length >= MIN_TEXT_OVERLAP && current.endsWith(chunk)) return current
  const overlap = commonOverlapLength(current, chunk)
  return overlap >= MIN_TEXT_OVERLAP ? `${current}${chunk.slice(overlap)}` : `${current}${chunk}`
}

function mergeAssistantSnapshot(current: string, snapshot: string): string {
  if (!current) return snapshot
  if (!snapshot) return current
  if (current === snapshot || current.includes(snapshot)) return current
  if (snapshot.startsWith(current) || snapshot.includes(current)) return snapshot
  const overlap = commonOverlapLength(current, snapshot)
  if (overlap >= MIN_TEXT_OVERLAP) return `${current}${snapshot.slice(overlap)}`
  const separator = current.endsWith('\n') || snapshot.startsWith('\n') ? '\n' : '\n\n'
  return `${current}${separator}${snapshot}`
}

function activeAssistantOutputId(session: AgentSession, fallback?: string): string {
  return session.turnAssistantMessageId ?? session.activeAssistantMessageId ?? fallback ?? randomUUID()
}

function appendAssistantText(session: AgentSession, messageId: string, text: string): void {
  if (!text) return
  startAssistant(session, messageId)
  session.assistantStreamed.add(messageId)
  const current = session.assistantText.get(messageId) ?? ''
  const next = mergeAssistantDelta(current, text)
  if (next === current) return
  session.assistantText.set(messageId, next)
  if (next.startsWith(current)) {
    emit(session, { type: 'message:assistant_delta', sessionId: session.id, messageId, text: next.slice(current.length) })
  } else {
    emit(session, { type: 'message:assistant_replace', sessionId: session.id, messageId, text: next })
  }
}

function reconcileAssistantSnapshot(session: AgentSession, messageId: string, text: string): void {
  if (!text) return
  startAssistant(session, messageId)
  const current = session.assistantText.get(messageId) ?? ''
  const next = mergeAssistantSnapshot(current, text)
  if (next === current) return
  session.assistantText.set(messageId, next)
  if (next.startsWith(current)) {
    const suffix = next.slice(current.length)
    if (suffix) emit(session, { type: 'message:assistant_delta', sessionId: session.id, messageId, text: suffix })
    return
  }
  emit(session, { type: 'message:assistant_replace', sessionId: session.id, messageId, text: next })
}

function emitProcessEvent(
  session: AgentSession,
  processId: string,
  title: string,
  text?: string,
  status?: string
): void {
  emit(session, { type: 'process:event', sessionId: session.id, processId, title, text, status })
}

function makeDiffProposal(session: AgentSession, toolId: string, input: Record<string, unknown>): void {
  const edits = diffEditsFromInput(input)
  const filePath = stringValue(input.file_path)
  if (!filePath && edits.length === 0) return
  const singleEdit = edits.length === 1 ? edits[0] : undefined
  emit(session, {
    type: 'diff:proposed',
    proposal: {
      proposalId: toolId,
      sessionId: session.id,
      toolUseId: toolId,
      filePath,
      oldString: singleEdit?.oldString,
      newString: singleEdit?.newString,
      edits: edits.length > 1 ? edits : undefined
    }
  })
}

function handleAssistantMessage(session: AgentSession, message: Record<string, unknown>): void {
  const body = asRecord(message.message)
  const messageId = activeAssistantOutputId(session, stringValue(body?.id) ?? stringValue(message.uuid))
  if (message.error) {
    emitProcessEvent(session, `assistant-error-${messageId}`, 'Claude 응답 오류', stringValue(message.error), 'error')
  }
  const blocks = unknownArray(body?.content)
  const textBlocks: string[] = []

  for (const blockValue of blocks) {
    const block = asRecord(blockValue)
    if (!block) continue
    const blockType = block.type
    if (blockType === 'text') {
      const text = stringValue(block.text)
      if (text) textBlocks.push(text)
      continue
    }
    if (blockType !== 'tool_use') continue
    const toolId = stringValue(block.id) ?? randomUUID()
    const name = stringValue(block.name) ?? 'tool'
    const input = asRecord(block.input) ?? {}
    if (isAskUserQuestionTool(name)) {
      makeQuestionDialog(session, {
        dialogId: toolId,
        dialogKind: name,
        payload: input,
        toolUseId: toolId,
        blocking: false
      })
      continue
    }
    if (session.startedTools.has(toolId)) continue
    session.startedTools.add(toolId)
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

  const snapshot = textBlocks.join('')
  if (snapshot) reconcileAssistantSnapshot(session, messageId, snapshot)
  completeAssistant(session, messageId)
  if (session.activeAssistantMessageId === messageId) session.activeAssistantMessageId = undefined
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
    if (result?.structuredPatch || result?.gitDiff) {
      const gitDiff = asRecord(result.gitDiff)
      emit(session, {
        type: 'diff:applied',
        sessionId: session.id,
        proposalId: toolId,
        filePath:
          stringValue(result.filePath) ??
          stringValue(result.file_path) ??
          stringValue(gitDiff?.filename),
        oldString: stringValue(result.oldString) ?? stringValue(result.old_string),
        newString:
          stringValue(result.newString) ??
          stringValue(result.new_string) ??
          stringValue(result.content),
        structuredPatch: result.structuredPatch,
        gitDiff: result.gitDiff
      })
    }
  }
}

function handleStreamEvent(session: AgentSession, message: Record<string, unknown>): void {
  const event = asRecord(message.event)
  if (!event) return
  const eventType = event.type
  const eventMessage = asRecord(event.message)
  const messageId = activeAssistantOutputId(
    session,
    stringValue(eventMessage?.id) ?? stringValue(message.session_id) ?? 'streaming'
  )
  if (eventType === 'message_start') {
    session.activeAssistantMessageId = messageId
    startAssistant(session, messageId)
    if (!session.assistantText.has(messageId)) session.assistantText.set(messageId, '')
    return
  }
  if (eventType === 'message_stop') {
    completeAssistant(session, messageId)
    if (session.activeAssistantMessageId === messageId) session.activeAssistantMessageId = undefined
    return
  }
  if (eventType === 'content_block_start') {
    const block = asRecord(event.content_block)
    if (block?.type === 'text') {
      const text = stringValue(block.text)
      if (text) appendAssistantText(session, messageId, text)
    }
    if (block?.type === 'tool_use') {
      const toolId = stringValue(block.id) ?? randomUUID()
      const name = stringValue(block.name) ?? 'tool'
      const input = asRecord(block.input) ?? {}
      if (isAskUserQuestionTool(name)) {
        makeQuestionDialog(session, {
          dialogId: toolId,
          dialogKind: name,
          payload: input,
          toolUseId: toolId,
          blocking: false
        })
        return
      }
      if (session.startedTools.has(toolId)) return
      session.startedTools.add(toolId)
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
    return
  }
  if (eventType !== 'content_block_delta') return
  const delta = asRecord(event.delta)
  if (delta?.type !== 'text_delta') return
  const text = stringValue(delta.text)
  if (!text) return
  appendAssistantText(session, messageId, text)
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
    const status = message.status === 'requesting' || message.status === 'compacting' ? 'working' : 'idle'
    emit(session, { type: 'status', sessionId: session.id, status })
    if (message.status === 'compacting') {
      emitProcessEvent(session, stringValue(message.uuid) ?? 'status-compacting', '컨텍스트 압축', undefined, 'running')
    }
    return
  }
  if (subtype === 'permission_denied') {
    const requestId = stringValue(message.tool_use_id) ?? randomUUID()
    emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision: 'reject' })
    emitProcessEvent(
      session,
      requestId,
      '권한 거절',
      stringValue(message.decision_reason) ?? stringValue(message.message),
      'denied'
    )
    return
  }
  if (subtype === 'local_command_output') {
    const text = stringValue(message.content)
    if (text) reconcileAssistantSnapshot(session, activeAssistantOutputId(session, stringValue(message.uuid)), text)
    return
  }
  if (subtype === 'hook_started') {
    emitProcessEvent(
      session,
      stringValue(message.hook_id) ?? stringValue(message.uuid) ?? randomUUID(),
      `Hook · ${stringValue(message.hook_name) ?? 'hook'}`,
      stringValue(message.hook_event),
      'running'
    )
    return
  }
  if (subtype === 'hook_progress' || subtype === 'hook_response') {
    emitProcessEvent(
      session,
      stringValue(message.hook_id) ?? stringValue(message.uuid) ?? randomUUID(),
      `Hook · ${stringValue(message.hook_name) ?? 'hook'}`,
      stringValue(message.output) ?? stringValue(message.stdout) ?? stringValue(message.stderr),
      stringValue(message.outcome) ?? 'running'
    )
    return
  }
  if (subtype === 'api_retry') {
    emitProcessEvent(
      session,
      stringValue(message.uuid) ?? randomUUID(),
      'API 재시도',
      stringValue(message.error),
      `retry ${String(message.attempt ?? '?')}/${String(message.max_retries ?? '?')}`
    )
    return
  }
  if (subtype === 'plugin_install') {
    emitProcessEvent(
      session,
      `plugin-${stringValue(message.name) ?? stringValue(message.uuid) ?? 'install'}`,
      '플러그인',
      stringValue(message.name) ?? stringValue(message.error),
      stringValue(message.status)
    )
    return
  }
  if (subtype === 'notification') {
    emitProcessEvent(
      session,
      stringValue(message.uuid) ?? randomUUID(),
      stringValue(message.key) ?? '알림',
      stringValue(message.text),
      stringValue(message.priority)
    )
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
  else if (message.type === 'tool_progress') {
    emitProcessEvent(
      session,
      stringValue(message.tool_use_id) ?? stringValue(message.uuid) ?? randomUUID(),
      `도구 실행 · ${stringValue(message.tool_name) ?? 'tool'}`,
      undefined,
      `${String(message.elapsed_time_seconds ?? 0)}s`
    )
  } else if (message.type === 'tool_use_summary') {
    emitProcessEvent(session, stringValue(message.uuid) ?? randomUUID(), '도구 요약', stringValue(message.summary), 'done')
  } else if (message.type === 'auth_status') {
    const output = Array.isArray(message.output) ? message.output.filter((line) => typeof line === 'string').join('\n') : ''
    emitProcessEvent(
      session,
      stringValue(message.uuid) ?? randomUUID(),
      'Claude 인증',
      stringValue(message.error) ?? output,
      message.isAuthenticating ? 'running' : 'done'
    )
  } else if (message.type === 'rate_limit_event') {
    const info = asRecord(message.rate_limit_info)
    emitProcessEvent(
      session,
      stringValue(message.uuid) ?? randomUUID(),
      'Rate limit',
      stringValue(info?.status),
      stringValue(info?.status)
    )
  } else if (message.type === 'prompt_suggestion') {
    emitProcessEvent(session, stringValue(message.uuid) ?? randomUUID(), '다음 프롬프트 제안', stringValue(message.suggestion))
  }
}

function handleRemoteJsonLine(session: AgentSession, line: string): void {
  if (!line.trim()) return
  try {
    handleSdkMessage(session, JSON.parse(line))
  } catch {
    emit(session, {
      type: 'raw',
      sessionId: session.id,
      message: { source: 'ssh-stdout', line }
    })
  }
}

function runRemoteAgentMessage(
  session: AgentSession,
  prompt: string,
  abortController: AbortController
): Promise<void> {
  const ssh = session.ssh
  if (!ssh) throw new Error('원격 Agent 세션에 SSH 연결 정보가 없습니다.')

  return new Promise((resolve) => {
    const proc = spawn(sshBin, [...sshArgs(ssh), remoteClaudeCommand(session)], {
      windowsHide: true,
      env: cleanEnv()
    })
    session.remoteProcess = proc

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let sawJson = false

    const stopRemote = (): void => {
      if (proc.killed) return
      try {
        proc.kill()
      } catch {
        /* already exited */
      }
    }
    abortController.signal.addEventListener('abort', stopRemote, { once: true })

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) sawJson = true
        handleRemoteJsonLine(session, line)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-8000)
    })

    proc.on('error', (error) => {
      if (abortController.signal.aborted) return
      emit(session, {
        type: 'error',
        sessionId: session.id,
        message: error.message,
        recoverable: true
      })
      emit(session, { type: 'status', sessionId: session.id, status: 'error' })
      resolve()
    })

    proc.on('close', (code, signal) => {
      if (session.remoteProcess === proc) session.remoteProcess = undefined
      abortController.signal.removeEventListener('abort', stopRemote)
      if (stdoutBuffer.trim()) {
        sawJson = true
        handleRemoteJsonLine(session, stdoutBuffer)
        stdoutBuffer = ''
      }
      if (abortController.signal.aborted) {
        resolve()
        return
      }
      if (code && code !== 0) {
        emit(session, {
          type: 'error',
          sessionId: session.id,
          message:
            stderrBuffer.trim() ||
            `원격 Claude 종료: code=${code}${signal ? ` signal=${signal}` : ''}`,
          recoverable: true
        })
        emit(session, { type: 'status', sessionId: session.id, status: 'error' })
        resolve()
        return
      }
      if (!sawJson && stderrBuffer.trim()) {
        emit(session, {
          type: 'error',
          sessionId: session.id,
          message: stderrBuffer.trim(),
          recoverable: true
        })
        emit(session, { type: 'status', sessionId: session.id, status: 'error' })
        resolve()
        return
      }
      emit(session, { type: 'status', sessionId: session.id, status: 'idle' })
      resolve()
    })

    proc.stdin.on('error', () => {
      /* SSH may close stdin first on connection errors. The process close handler reports it. */
    })
    proc.stdin.end(prompt)
  })
}

export function startAgentAuthLogin(sessionId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.running) return { ok: false, error: 'Agent 작업 실행 중에는 로그인할 수 없습니다.' }
  if (session.authProcess) return { ok: false, error: '이미 Claude 로그인 절차가 실행 중입니다.' }
  if (session.authStatus === 'authenticated') {
    return { ok: false, error: '이미 원격 Claude에 로그인되어 있습니다.' }
  }
  if (session.source !== 'ssh' || !session.ssh) {
    return { ok: false, error: '현재 구현은 원격 Agent 세션의 Claude 로그인만 지원합니다.' }
  }

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(sshBin, [...sshArgs(session.ssh, { batchMode: false, tty: true }), remoteClaudeAuthCommand()], {
      windowsHide: true,
      env: cleanEnv()
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  session.authProcess = proc
  emit(session, { type: 'auth:started', sessionId: session.id, source: session.source })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_user' })

  proc.stdout.on('data', (chunk: Buffer) => emitAuthOutput(session, chunk))
  proc.stderr.on('data', (chunk: Buffer) => emitAuthOutput(session, chunk))
  proc.stdin.on('error', () => {
    /* SSH or Claude may close stdin after browser-based auth completes. */
  })
  proc.on('error', (error) => {
    if (session.authProcess !== proc) return
    if (session.authProcess === proc) session.authProcess = undefined
    emit(session, {
      type: 'auth:done',
      sessionId: session.id,
      ok: false,
      exitCode: null,
      message: error.message
    })
    emit(session, { type: 'status', sessionId: session.id, status: 'error' })
    refreshAgentAuthStatus(session)
  })
  proc.on('close', (code) => {
    if (session.authProcess !== proc) return
    if (session.authProcess === proc) session.authProcess = undefined
    const ok = code === 0
    emit(session, {
      type: 'auth:done',
      sessionId: session.id,
      ok,
      exitCode: code,
      message: ok ? 'Claude 로그인이 완료되었습니다.' : `Claude 로그인 종료: code=${code ?? 'unknown'}`
    })
    emit(session, { type: 'status', sessionId: session.id, status: ok ? 'idle' : 'error' })
    refreshAgentAuthStatus(session)
  })

  return { ok: true }
}

export function sendAgentAuthInput(sessionId: string, input: AgentAuthInput): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (!session.authProcess) return { ok: false, error: '실행 중인 Claude 로그인 절차가 없습니다.' }
  session.authProcess.stdin.write(`${input.text}\n`)
  return { ok: true }
}

function shouldAutoAllow(session: AgentSession, toolName: string): boolean {
  if (session.permissionMode === 'bypassPermissions') return true
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
    if (existing.authStatus) {
      emit(existing, { type: 'auth:status', sessionId: existing.id, state: existing.authStatus })
    } else {
      refreshAgentAuthStatus(existing)
    }
    return { ok: true }
  }
  if (!opts.cwd) return { ok: false, error: 'Agent 세션 cwd가 필요합니다.' }
  if (opts.source === 'ssh' && !opts.ssh) {
    return { ok: false, error: '원격 Agent 세션에 SSH 연결 정보가 필요합니다.' }
  }

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
    ssh: opts.ssh,
    authStatus: opts.source === 'ssh' ? 'checking' : undefined,
    viewers: new Map(),
    pendingPermissions: new Map(),
    pendingDialogs: new Map(),
    dialogs: new Map(),
    assistantMessages: new Set(),
    assistantText: new Map(),
    assistantStreamed: new Set(),
    startedTools: new Set(),
    queue: []
  }
  sessions.set(opts.id, session)
  attach(session, webContents)
  emit(session, { type: 'session:init', sessionId: session.id, title: session.title, cwd: session.cwd, source: session.source })
  emit(session, { type: 'status', sessionId: session.id, status: 'idle' })
  refreshAgentAuthStatus(session)
  return { ok: true }
}

function isEmptyAgentInput(input: AgentSendInput): boolean {
  return !input.text.trim() && (!input.attachments || input.attachments.length === 0)
}

function agentInputDisplayText(input: AgentSendInput): string {
  return input.displayText?.trim() || input.text
}

function queuedTextPreview(input: AgentSendInput): string {
  const text = agentInputDisplayText(input).trim()
  if (text) return textPreview(text, 360)
  return (input.attachments ?? []).map((attachment) => attachment.label).join(', ')
}

function rejectPendingPermissions(session: AgentSession, message: string): void {
  for (const [requestId, pending] of session.pendingPermissions) {
    clearTimeout(pending.timer)
    pending.resolve({
      behavior: 'deny',
      message,
      decisionClassification: 'user_reject'
    })
    emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision: 'reject' })
  }
  session.pendingPermissions.clear()
}

function cancelPendingDialogs(session: AgentSession): void {
  for (const [dialogId, pending] of session.pendingDialogs) {
    const answer: AgentDialogAnswer = { sessionId: session.id, dialogId, cancelled: true }
    pending.finish({ behavior: 'cancelled' }, answer)
  }
  session.pendingDialogs.clear()
}

function clearAgentQueue(session: AgentSession): void {
  const queueIds = session.queue.map((item) => item.queueId)
  if (queueIds.length === 0) return
  session.queue = []
  emit(session, { type: 'queue:cleared', sessionId: session.id, queueIds })
}

function interruptForImmediateInstruction(session: AgentSession): void {
  emitProcessEvent(
    session,
    `steer-${Date.now()}`,
    '바로 지시하기',
    '현재 작업을 중단하고 새 지시를 바로 실행합니다.',
    'running'
  )
  rejectPendingPermissions(session, '사용자가 바로 지시하기로 현재 작업을 중단했습니다.')
  cancelPendingDialogs(session)
  session.running?.abort()
  session.remoteProcess?.kill()
}

function enqueueAgentMessage(
  session: AgentSession,
  input: AgentSendInput,
  delivery: 'queue' | 'steer'
): QueuedAgentMessage {
  const queueId = randomUUID()
  const item: QueuedAgentMessage = {
    queueId,
    input: { ...input, delivery },
    delivery
  }
  if (delivery === 'steer') session.queue.unshift(item)
  else session.queue.push(item)
  emit(session, {
    type: 'queue:added',
    sessionId: session.id,
    queueId,
    text: queuedTextPreview(input),
    position: session.queue.findIndex((queued) => queued.queueId === queueId) + 1,
    delivery
  })
  return item
}

export function promoteQueuedAgentMessage(sessionId: string, queueId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.authProcess) return { ok: false, error: 'Claude 로그인 절차가 진행 중입니다.' }

  const index = session.queue.findIndex((item) => item.queueId === queueId)
  if (index < 0) return { ok: false, error: '대기 중인 지시를 찾을 수 없습니다.' }

  const [item] = session.queue.splice(index, 1)
  item.delivery = 'steer'
  item.input = { ...item.input, delivery: 'steer' }
  session.queue.unshift(item)
  emit(session, {
    type: 'queue:promoted',
    sessionId: session.id,
    queueId,
    position: 1
  })

  if (session.running) interruptForImmediateInstruction(session)
  else startNextQueuedMessage(session)
  return { ok: true }
}

export function removeQueuedAgentMessage(sessionId: string, queueId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }

  const index = session.queue.findIndex((item) => item.queueId === queueId)
  if (index < 0) return { ok: false, error: '대기 중인 지시를 찾을 수 없습니다.' }

  session.queue.splice(index, 1)
  emit(session, { type: 'queue:removed', sessionId: session.id, queueId })
  return { ok: true }
}

function startNextQueuedMessage(session: AgentSession): void {
  if (session.running || session.authProcess) return
  const next = session.queue.shift()
  if (!next) return
  emit(session, { type: 'queue:started', sessionId: session.id, queueId: next.queueId })
  startAgentTurn(session, next.input)
}

function startAgentTurn(session: AgentSession, input: AgentSendInput): void {
  if (input.permissionMode) session.permissionMode = input.permissionMode
  const sessionId = session.id
  const messageId = randomUUID()
  const assistantMessageId = randomUUID()
  const abortController = new AbortController()
  session.running = abortController
  session.turnAssistantMessageId = assistantMessageId
  session.activeAssistantMessageId = assistantMessageId
  emit(session, {
    type: 'message:user',
    sessionId,
    messageId,
    text: agentInputDisplayText(input),
    attachments: input.attachments ?? []
  })
  emit(session, { type: 'status', sessionId, status: 'working' })

  const prompt = renderPrompt(input)
  void (async () => {
    try {
      if (session.source === 'ssh') {
        await runRemoteAgentMessage(session, prompt, abortController)
        return
      }
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
          allowDangerouslySkipPermissions: session.permissionMode === 'bypassPermissions',
          canUseTool: (toolName, toolInput, permissionOptions) =>
            requestPermission(session, toolName, toolInput, permissionOptions),
          onUserDialog: (request, options) => requestUserDialog(session, request, options.signal),
          toolConfig: {
            askUserQuestion: { previewFormat: 'html' }
          },
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
      if (session.queue.length === 0) {
        session.turnAssistantMessageId = undefined
        session.activeAssistantMessageId = undefined
      }
      startNextQueuedMessage(session)
    }
  })()
}

export function sendAgentMessage(sessionId: string, input: AgentSendInput): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.authProcess) return { ok: false, error: 'Claude 로그인 절차가 진행 중입니다.' }
  if (session.source === 'ssh') {
    if (session.authStatus === 'checking') {
      return { ok: false, error: '원격 Claude Code 설치와 로그인 상태를 확인 중입니다.' }
    }
    if (session.authStatus === 'unavailable') {
      return { ok: false, error: '원격에서 Claude Code CLI를 찾을 수 없습니다. 원격 터미널에서 Claude Code를 설치한 뒤 다시 시도하세요.' }
    }
    if (session.authStatus === 'unauthenticated') {
      return { ok: false, error: '원격 Claude 로그인이 필요합니다. 로그인 버튼으로 인증을 먼저 진행하세요.' }
    }
  }
  if (isEmptyAgentInput(input)) {
    return { ok: false, error: '전송할 프롬프트나 첨부가 필요합니다.' }
  }
  if (session.running) {
    const delivery = input.delivery === 'steer' ? 'steer' : 'queue'
    enqueueAgentMessage(session, input, delivery)
    if (delivery === 'steer') {
      interruptForImmediateInstruction(session)
    }
    return { ok: true }
  }
  startAgentTurn(session, input)
  return { ok: true }
}

function renderPrompt(input: AgentSendInput): string {
  const attachments = input.attachments ?? []
  const text =
    input.delivery === 'steer'
      ? `사용자가 진행 중인 작업을 중단하고 방향 전환을 요청했습니다. 아래 지시를 최우선으로 반영하세요.\n\n${input.text}`
      : input.text
  if (attachments.length === 0) return text
  const renderedAttachments = attachments
    .map((attachment, index) => {
      const parts = [`${index + 1}. ${attachment.kind}: ${attachment.label}`]
      if (attachment.path) parts.push(`path=${attachment.path}`)
      if (attachment.range) parts.push(`range=${JSON.stringify(attachment.range)}`)
      if (attachment.text) parts.push(`text=${attachment.text}`)
      return parts.join('\n   ')
    })
    .join('\n')
  return `${text}\n\n[legal-terminal attachments]\n${renderedAttachments}`
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

export function answerAgentDialog(answer: AgentDialogAnswer): AgentCommandResult {
  const session = sessions.get(answer.sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  const dialog = session.dialogs.get(answer.dialogId)
  const pending = session.pendingDialogs.get(answer.dialogId)
  if (pending && dialog) {
    const result = buildQuestionDialogResult(dialog, answer)
    pending.finish(result, answer)
    return { ok: true }
  }
  if (!dialog) return { ok: false, error: '대기 중인 선택 요청을 찾을 수 없습니다.' }

  emit(session, {
    type: 'dialog:resolved',
    sessionId: session.id,
    dialogId: answer.dialogId,
    answers: answer.answers,
    response: answer.response,
    cancelled: answer.cancelled
  })
  if (answer.cancelled) return { ok: true }
  return sendAgentMessage(session.id, {
    text: renderDialogAnswerText(dialog, answer),
    delivery: session.running ? 'queue' : 'normal'
  })
}

export function interruptAgentSession(sessionId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  clearAgentQueue(session)
  rejectPendingPermissions(session, '사용자가 Agent 작업을 중지했습니다.')
  cancelPendingDialogs(session)
  session.running?.abort()
  session.remoteProcess?.kill()
  session.remoteProcess = undefined
  session.authProcess?.kill()
  session.authProcess = undefined
  session.running = undefined
  session.turnAssistantMessageId = undefined
  session.activeAssistantMessageId = undefined
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
  session.remoteProcess?.kill()
  session.remoteProcess = undefined
  session.authProcess?.kill()
  session.authProcess = undefined
  session.turnAssistantMessageId = undefined
  session.activeAssistantMessageId = undefined
  clearAgentQueue(session)
  rejectPendingPermissions(session, 'Agent 세션이 닫혔습니다.')
  cancelPendingDialogs(session)
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
  ipcMain.handle('agent:promoteQueued', (_e, p: { sessionId: string; queueId: string }) =>
    promoteQueuedAgentMessage(p.sessionId, p.queueId)
  )
  ipcMain.handle('agent:removeQueued', (_e, p: { sessionId: string; queueId: string }) =>
    removeQueuedAgentMessage(p.sessionId, p.queueId)
  )
  ipcMain.handle('agent:approve', (_e, decision: AgentPermissionDecision) =>
    approveAgentPermission(decision)
  )
  ipcMain.handle('agent:answerDialog', (_e, answer: AgentDialogAnswer) => answerAgentDialog(answer))
  ipcMain.handle('agent:interrupt', (_e, sessionId: string) => interruptAgentSession(sessionId))
  ipcMain.handle('agent:close', (e, sessionId: string) => closeAgentSession(sessionId, e.sender))
  ipcMain.handle('agent:authLogin', (_e, sessionId: string) => startAgentAuthLogin(sessionId))
  ipcMain.handle('agent:authInput', (_e, p: { sessionId: string; input: AgentAuthInput }) =>
    sendAgentAuthInput(p.sessionId, p.input)
  )
}
