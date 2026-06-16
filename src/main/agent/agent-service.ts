import type { IpcMain, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import {
  query,
  type McpServerStatus,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type UserDialogRequest,
  type UserDialogResult
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentAttachment,
  AgentCommandResult,
  AgentCreateOptions,
  AgentContextUsage,
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
  AgentSessionSnapshotResult,
  AgentSlashCommand,
  AgentSshConn,
  AgentSource,
  AgentRateLimitUsage,
  AgentTokenUsage,
  AgentWorktreeForkInput,
  AgentWorktreeForkResult
} from './agent-types'

interface PendingPermission {
  sessionId: string
  toolUseId: string
  suggestions?: PermissionUpdate[]
  finish: (value: PermissionResult, decision: 'allow' | 'reject', emitWorking?: boolean) => void
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
  commandProbe?: AbortController
  slashCommands?: AgentSlashCommand[]
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
  tokenUsage: AgentTokenUsage
  contextUsage?: AgentContextUsage
  rateLimitUsage?: AgentRateLimitUsage
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
const MCP_STATUS_TIMEOUT_MS = 20_000
const GIT_WORKTREE_TIMEOUT_MS = 60_000
const MIN_TEXT_OVERLAP = 4
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const CLAUDE_AGENT_SDK_BINARY_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'claude',
  linux: 'claude',
  win32: 'claude.exe'
}
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

function packagedClaudeAgentSdkExecutable(): string | undefined {
  const binaryName = CLAUDE_AGENT_SDK_BINARY_BY_PLATFORM[process.platform]
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (!binaryName || !resourcesPath) return undefined

  const packageName = `claude-agent-sdk-${process.platform}-${process.arch}`
  const candidate = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    packageName,
    binaryName
  )
  return existsSync(candidate) ? candidate : undefined
}

function remoteClaudeCommand(session: AgentSession): string {
  const mode = cliPermissionMode(session.permissionMode)
  const flags = [
    '--verbose --output-format stream-json --input-format stream-json',
    '--include-partial-messages --include-hook-events',
    '--permission-prompt-tool stdio',
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeSlashCommandName(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const name = trimmed.split(/\s+/, 1)[0]
  return name.startsWith('/') ? name : `/${name}`
}

function normalizeAgentSlashCommands(value: unknown): AgentSlashCommand[] {
  const seen = new Set<string>()
  return unknownArray(value)
    .map((item): AgentSlashCommand | undefined => {
      if (typeof item === 'string') {
        const name = normalizeSlashCommandName(item)
        return name ? { name } : undefined
      }

      const record = asRecord(item)
      const name = normalizeSlashCommandName(stringValue(record?.name) ?? '')
      if (!record || !name) return undefined
      const description = stringValue(record.description)
      const argumentHint = stringValue(record.argumentHint)
      const aliases = stringArrayValue(record.aliases)
        .map((alias) => normalizeSlashCommandName(alias))
        .filter((alias): alias is string => Boolean(alias))
      return {
        name,
        ...(description ? { description } : {}),
        ...(argumentHint ? { argumentHint } : {}),
        ...(aliases.length > 0 ? { aliases } : {})
      }
    })
    .filter((command): command is AgentSlashCommand => {
      if (!command) return false
      const key = command.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

async function* waitForAbort(signal: AbortSignal): AsyncGenerator<never, void, unknown> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = MCP_STATUS_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간이 초과되었습니다.`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const mcpStatusLabels: Record<McpServerStatus['status'], string> = {
  connected: '연결됨',
  failed: '실패',
  'needs-auth': '인증 필요',
  pending: '보류',
  disabled: '비활성'
}

function mcpConfigSummary(config: McpServerStatus['config'] | undefined): string | undefined {
  const record = asRecord(config)
  if (!record) return undefined
  const type = stringValue(record.type)
  const url = stringValue(record.url)
  const command = stringValue(record.command)
  const args = unknownArray(record.args).filter((item): item is string => typeof item === 'string')

  if (url) return [type, url].filter(Boolean).join(' ')
  if (command) return [type, command, ...args].filter(Boolean).join(' ')
  return type
}

function formatMcpStatus(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) {
    return 'MCP 서버가 설정되어 있지 않습니다.'
  }

  const counts = statuses.reduce(
    (acc, server) => {
      acc[server.status] += 1
      return acc
    },
    {
      connected: 0,
      failed: 0,
      'needs-auth': 0,
      pending: 0,
      disabled: 0
    } satisfies Record<McpServerStatus['status'], number>
  )
  const summary = [
    `총 ${statuses.length}개`,
    `연결됨 ${counts.connected}개`,
    `실패 ${counts.failed}개`,
    `인증 필요 ${counts['needs-auth']}개`,
    `보류 ${counts.pending}개`,
    `비활성 ${counts.disabled}개`
  ].join(', ')

  const lines = [`MCP 상태를 확인했습니다. ${summary}.`, '']
  for (const server of statuses) {
    lines.push(`### ${server.name}`)
    lines.push(`- 상태: ${mcpStatusLabels[server.status]}`)
    if (server.scope) lines.push(`- 범위: ${server.scope}`)
    const config = mcpConfigSummary(server.config)
    if (config) lines.push(`- 설정: ${config}`)
    if (server.serverInfo) {
      lines.push(`- 서버: ${server.serverInfo.name} ${server.serverInfo.version}`)
    }
    if (server.error) lines.push(`- 오류: ${server.error}`)
    if (server.tools?.length) {
      const tools = server.tools.map((tool) => tool.name).join(', ')
      lines.push(`- 도구: ${tools}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
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
  return /^(askuserquestion|ask_user_question|request_user_question|requestuserinput|request_user_input)$/i.test(name)
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
  const previous = session.dialogs.get(dialog.dialogId)
  const fullDialog: AgentDialogRequest = {
    ...previous,
    ...dialog,
    sessionId: session.id,
    blocking: previous?.blocking === true || dialog.blocking
  }
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
  const dialogId = request.toolUseID ?? randomUUID()
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

function emitInterrupted(session: AgentSession, message = '사용자가 Agent 작업을 중지했습니다.'): void {
  emit(session, { type: 'session:interrupted', sessionId: session.id, message })
}

function emptyTokenUsage(): AgentTokenUsage {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    updatedAt: Date.now()
  }
}

function emitUsageUpdate(session: AgentSession): void {
  emit(session, {
    type: 'usage:update',
    sessionId: session.id,
    usage: session.tokenUsage,
    context: session.contextUsage,
    rateLimit: session.rateLimitUsage
  })
}

function usageTokensFromRecord(value: unknown): Omit<AgentTokenUsage, 'turns' | 'updatedAt'> | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ?? numberValue(usage.cacheCreationInputTokens) ?? 0
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens) ?? 0
  const totalTokens = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens
  }
}

function costUsdFromModelUsage(value: unknown): number | undefined {
  const modelUsage = asRecord(value)
  if (!modelUsage) return undefined
  let total = 0
  for (const item of Object.values(modelUsage)) {
    const cost = numberValue(asRecord(item)?.costUSD)
    if (cost) total += cost
  }
  return total > 0 ? total : undefined
}

function accumulateResultUsage(session: AgentSession, message: Record<string, unknown>): void {
  const usage = usageTokensFromRecord(message.usage)
  if (!usage) return
  const cost = numberValue(message.total_cost_usd) ?? costUsdFromModelUsage(message.modelUsage)
  session.tokenUsage = {
    turns: session.tokenUsage.turns + 1,
    inputTokens: session.tokenUsage.inputTokens + usage.inputTokens,
    outputTokens: session.tokenUsage.outputTokens + usage.outputTokens,
    cacheCreationInputTokens: session.tokenUsage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    cacheReadInputTokens: session.tokenUsage.cacheReadInputTokens + usage.cacheReadInputTokens,
    totalTokens: session.tokenUsage.totalTokens + usage.totalTokens,
    totalCostUsd:
      cost !== undefined ? (session.tokenUsage.totalCostUsd ?? 0) + cost : session.tokenUsage.totalCostUsd,
    lastTurnTokens: usage.totalTokens,
    updatedAt: Date.now()
  }
  emitUsageUpdate(session)
}

function normalizeContextUsage(value: unknown): AgentContextUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const totalTokens = numberValue(usage.totalTokens)
  const maxTokens = numberValue(usage.maxTokens)
  const rawMaxTokens = numberValue(usage.rawMaxTokens)
  const limit = maxTokens ?? rawMaxTokens
  if (totalTokens === undefined || limit === undefined || limit <= 0) return undefined
  return {
    totalTokens,
    maxTokens: limit,
    remainingTokens: Math.max(0, limit - totalTokens),
    percentage: numberValue(usage.percentage) ?? Math.min(100, Math.max(0, (totalTokens / limit) * 100)),
    model: stringValue(usage.model),
    updatedAt: Date.now()
  }
}

function rememberContextUsage(session: AgentSession, value: unknown): void {
  const context = normalizeContextUsage(value)
  if (!context) return
  session.contextUsage = context
  emitUsageUpdate(session)
}

function normalizedUtilization(value: unknown): number | undefined {
  const raw = numberValue(value)
  if (raw === undefined) return undefined
  const percent = raw <= 1 ? raw * 100 : raw
  return Math.min(100, Math.max(0, percent))
}

function normalizeResetTime(value: unknown): number | undefined {
  const raw = numberValue(value)
  if (raw === undefined || raw <= 0) return undefined
  return raw < 10_000_000_000 ? raw * 1000 : raw
}

function rememberRateLimitUsage(session: AgentSession, value: unknown): AgentRateLimitUsage | undefined {
  const info = asRecord(value)
  if (!info) return undefined
  const utilization = normalizedUtilization(info.utilization)
  const status = stringValue(info.status)
  const rateLimit: AgentRateLimitUsage = {
    status: status === 'allowed' || status === 'allowed_warning' || status === 'rejected' ? status : undefined,
    rateLimitType: stringValue(info.rateLimitType),
    utilization,
    remainingPercent: utilization === undefined ? undefined : Math.max(0, 100 - utilization),
    resetsAt: normalizeResetTime(info.resetsAt),
    isUsingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
    updatedAt: Date.now()
  }
  session.rateLimitUsage = rateLimit
  emitUsageUpdate(session)
  return rateLimit
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
      if (session.source === 'ssh') {
        makeQuestionDialog(session, {
          dialogId: toolId,
          dialogKind: name,
          payload: input,
          toolUseId: toolId,
          blocking: false
        })
      }
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
        if (session.source === 'ssh') {
          makeQuestionDialog(session, {
            dialogId: toolId,
            dialogKind: name,
            payload: input,
            toolUseId: toolId,
            blocking: false
          })
        }
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
    const slashCommands = normalizeAgentSlashCommands(message.slash_commands)
    if (slashCommands.length > 0) session.slashCommands = slashCommands
    emit(session, {
      type: 'session:init',
      sessionId: session.id,
      title: session.title,
      cwd: stringValue(message.cwd) ?? session.cwd,
      source: session.source,
      ...(slashCommands.length > 0 ? { slashCommands } : {})
    })
    return
  }
  if (subtype === 'commands_changed') {
    const commands = normalizeAgentSlashCommands(message.commands)
    session.slashCommands = commands
    emit(session, { type: 'session:commands', sessionId: session.id, commands })
    return
  }
  if (subtype === 'status') {
    const status = message.status === 'requesting' || message.status === 'compacting' ? 'working' : 'idle'
    if (status === 'idle' && session.pendingPermissions.size > 0) {
      emit(session, { type: 'status', sessionId: session.id, status: 'waiting_permission' })
      return
    }
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
  accumulateResultUsage(session, message)
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
    const rateLimit = rememberRateLimitUsage(session, info)
    emitProcessEvent(
      session,
      stringValue(message.uuid) ?? randomUUID(),
      'Rate limit',
      stringValue(info?.status),
      rateLimit?.status
    )
  } else if (message.type === 'prompt_suggestion') {
    emitProcessEvent(session, stringValue(message.uuid) ?? randomUUID(), '다음 프롬프트 제안', stringValue(message.suggestion))
  }
}

function handleRemoteJsonLine(session: AgentSession, line: string): Record<string, unknown> | null {
  if (!line.trim()) return null
  try {
    const message = JSON.parse(line) as unknown
    if (handleRemoteControlRequest(session, message)) return null
    handleSdkMessage(session, message)
    return asRecord(message)
  } catch {
    emit(session, {
      type: 'raw',
      sessionId: session.id,
      message: { source: 'ssh-stdout', line }
    })
    return null
  }
}

function remotePromptLine(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    },
    parent_tool_use_id: null
  })
}

function writeRemoteControlResponse(
  session: AgentSession,
  requestId: string,
  response: unknown
): boolean {
  const proc = session.remoteProcess
  if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded) return false
  try {
    proc.stdin.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response
        }
      })}\n`
    )
    return true
  } catch {
    return false
  }
}

function writeRemoteControlError(session: AgentSession, requestId: string, message: string): void {
  const proc = session.remoteProcess
  if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded) return
  try {
    proc.stdin.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: message
        }
      })}\n`
    )
  } catch {
    /* The process close path reports the failure to the UI. */
  }
}

function handleRemotePermissionRequest(
  session: AgentSession,
  requestId: string,
  request: Record<string, unknown>
): boolean {
  const toolName = stringValue(request.tool_name)
  if (!toolName) {
    const message = '원격 Claude 권한 요청에 도구 이름이 없습니다.'
    writeRemoteControlError(session, requestId, message)
    emit(session, { type: 'error', sessionId: session.id, message, recoverable: true })
    return true
  }
  const input = asRecord(request.input) ?? {}
  const toolUseId = stringValue(request.tool_use_id) ?? requestId
  const suggestions = Array.isArray(request.permission_suggestions)
    ? (request.permission_suggestions as PermissionUpdate[])
    : undefined

  if (shouldAutoAllow(session, toolName)) {
    writeRemoteControlResponse(session, requestId, { behavior: 'allow', toolUseID: toolUseId })
    return true
  }

  const permission: AgentPermissionRequest = {
    requestId,
    sessionId: session.id,
    toolUseId,
    toolName,
    input,
    inputPreview: safeJsonPreview(input),
    title: stringValue(request.title),
    displayName: stringValue(request.display_name),
    description: stringValue(request.description),
    blockedPath: stringValue(request.blocked_path),
    decisionReason: stringValue(request.decision_reason)
  }

  emit(session, { type: 'permission:request', request: permission })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_permission' })

  let settled = false
  let pending: PendingPermission
  const timer = setTimeout(() => {
    pending.finish(
      {
        behavior: 'deny',
        message: '권한 요청 시간이 초과되었습니다.',
        toolUseID: toolUseId,
        decisionClassification: 'user_reject'
      },
      'reject'
    )
  }, PERMISSION_TIMEOUT_MS)
  pending = {
    sessionId: session.id,
    toolUseId,
    suggestions,
    timer,
    finish: (value, decision, emitWorking = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.pendingPermissions.delete(requestId)
      const wrote = writeRemoteControlResponse(session, requestId, {
        ...value,
        toolUseID: toolUseId
      } as PermissionResult)
      if (!wrote && session.remoteProcess) {
        emit(session, {
          type: 'error',
          sessionId: session.id,
          message: '원격 Claude 권한 응답을 전달할 수 없습니다.',
          recoverable: true
        })
      }
      emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision })
      if (emitWorking) emit(session, { type: 'status', sessionId: session.id, status: 'working' })
    }
  }
  session.pendingPermissions.set(requestId, pending)
  return true
}

function handleRemoteControlRequest(session: AgentSession, messageValue: unknown): boolean {
  const record = asRecord(messageValue)
  if (record?.type !== 'control_request') return false
  const requestId = stringValue(record.request_id)
  const request = asRecord(record.request)
  if (!requestId || !request) return true
  if (request.subtype === 'can_use_tool') return handleRemotePermissionRequest(session, requestId, request)
  const errorMessage = `지원하지 않는 원격 control request: ${String(request.subtype ?? 'unknown')}`
  writeRemoteControlError(session, requestId, errorMessage)
  emit(session, {
    type: 'error',
    sessionId: session.id,
    message: errorMessage,
    recoverable: true
  })
  return true
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

    const endRemoteInput = (): void => {
      if (proc.stdin.destroyed || proc.stdin.writableEnded) return
      try {
        proc.stdin.end()
      } catch {
        /* The process close handler reports any resulting failure. */
      }
    }

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
      if (abortController.signal.aborted || session.running !== abortController) return
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (abortController.signal.aborted || session.running !== abortController) return
        if (line.trim()) sawJson = true
        const message = handleRemoteJsonLine(session, line)
        if (message?.type === 'result') endRemoteInput()
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-8000)
    })

    proc.on('error', (error) => {
      if (abortController.signal.aborted) return
      rejectPendingPermissions(session, '원격 Claude 프로세스 오류로 권한 요청이 취소되었습니다.')
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
      if (abortController.signal.aborted || session.running !== abortController) {
        resolve()
        return
      }
      if (stdoutBuffer.trim()) {
        sawJson = true
        const message = handleRemoteJsonLine(session, stdoutBuffer)
        if (message?.type === 'result') endRemoteInput()
        stdoutBuffer = ''
      }
      rejectPendingPermissions(session, '원격 Claude 프로세스가 종료되었습니다.')
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
    proc.stdin.write(`${remotePromptLine(prompt)}\n`)
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
  if (isAskUserQuestionTool(toolName)) return true
  if (READ_ONLY_TOOLS.has(toolName)) return true
  if (session.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true
  return false
}

function requestPermission(
  session: AgentSession,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[]
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
  const toolUseId = options.toolUseID || requestId
  const request: AgentPermissionRequest = {
    requestId,
    sessionId: session.id,
    toolUseId,
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
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (
      value: PermissionResult,
      decision: 'allow' | 'reject',
      emitWorking = false
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      session.pendingPermissions.delete(requestId)
      emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision })
      if (emitWorking) emit(session, { type: 'status', sessionId: session.id, status: 'working' })
      resolve({ ...value, toolUseID: toolUseId } as PermissionResult)
    }
    const onAbort = (): void => {
      finish(
        {
          behavior: 'deny',
          message: '권한 요청이 취소되었습니다.',
          interrupt: true,
          decisionClassification: 'user_reject'
        },
        'reject'
      )
    }
    timer = setTimeout(() => {
      finish(
        {
          behavior: 'deny',
          message: '권한 요청 시간이 초과되었습니다.',
          decisionClassification: 'user_reject'
        },
        'reject'
      )
    }, PERMISSION_TIMEOUT_MS)
    session.pendingPermissions.set(requestId, {
      sessionId: session.id,
      toolUseId,
      suggestions: options.suggestions,
      finish,
      timer
    })
    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) onAbort()
  })
}

function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_WORKTREE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (error) {
          reject(new Error([error.message, err, out].filter(Boolean).join('\n').trim()))
          return
        }
        resolve({ stdout: out, stderr: err })
      }
    )
  })
}

function pathName(value: string): string {
  const clean = value.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || 'worktree'
}

function safeBranchPart(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.slice(0, 48) || 'worktree'
}

function safePathPart(value: string, maxLength = 96): string {
  const normalized =
    value
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'worktree'
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 17)}-${normalized.slice(-16)}`
}

function timestampSlug(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
}

function defaultForkBranch(root: string, cwd: string): string {
  return `codex/fork-${safeBranchPart(pathName(cwd) || pathName(root))}-${timestampSlug()}`
}

function worktreeLeaf(branchName: string): string {
  return safePathPart(branchName.replace(/[\\/]+/g, '-'))
}

function childCwdForWorktree(root: string, cwd: string, worktreeRoot: string): string {
  const child = relative(root, cwd)
  if (
    !child ||
    child === '..' ||
    child.startsWith('../') ||
    child.startsWith('..\\') ||
    /^[A-Za-z]:/.test(child)
  ) {
    return worktreeRoot
  }
  const target = join(worktreeRoot, child)
  return existsSync(target) ? target : worktreeRoot
}

export async function createAgentWorktreeFork(
  input: AgentWorktreeForkInput
): Promise<AgentWorktreeForkResult> {
  const cwd = input.cwd.trim()
  if (!cwd) return { ok: false, error: 'worktree를 만들 cwd가 필요합니다.' }

  try {
    const rootResult = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'])
    const root = rootResult.stdout.trim()
    if (!root) return { ok: false, error: 'Git 저장소 루트를 찾을 수 없습니다.' }

    const baseBranch = input.branchName?.trim() || defaultForkBranch(root, cwd)
    await runGit(['check-ref-format', '--branch', baseBranch])

    const worktreeBase = join(dirname(root), `${basename(root)}-worktrees`)
    await mkdir(worktreeBase, { recursive: true })

    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const branchName = attempt === 0 ? baseBranch : `${baseBranch}-${attempt + 1}`
      const worktreeRoot = join(worktreeBase, worktreeLeaf(branchName))
      try {
        await runGit(['-C', root, 'worktree', 'add', '-b', branchName, worktreeRoot, 'HEAD'])
        return {
          ok: true,
          path: childCwdForWorktree(root, cwd, worktreeRoot),
          root: worktreeRoot,
          branchName
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (input.branchName || !/already exists|exists|사용 중|이미/i.test(lastError)) break
      }
    }
    return { ok: false, error: lastError || 'Git worktree 생성에 실패했습니다.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function prefetchLocalSlashCommands(session: AgentSession): void {
  if (session.source !== 'local' || session.running || session.commandProbe) return

  const abortController = new AbortController()
  session.commandProbe = abortController
  let diagnostic: ReturnType<typeof query> | undefined

  void (async () => {
    try {
      diagnostic = query({
        prompt: waitForAbort(abortController.signal),
        options: {
          abortController,
          cwd: session.cwd,
          model: session.model,
          tools: [],
          pathToClaudeCodeExecutable: packagedClaudeAgentSdkExecutable(),
          permissionMode: 'dontAsk',
          includeHookEvents: false,
          includePartialMessages: false,
          env: cleanEnv()
        }
      })
      const init = await withTimeout(diagnostic.initializationResult(), '명령 목록 초기화', 15000)
      if (abortController.signal.aborted || sessions.get(session.id) !== session) return
      const commands = normalizeAgentSlashCommands(init.commands)
      if (commands.length === 0) return
      session.slashCommands = commands
      emit(session, { type: 'session:commands', sessionId: session.id, commands })
    } catch {
      /* Slash commands are progressive enhancement; the agent still works without them. */
    } finally {
      diagnostic?.close()
      abortController.abort()
      if (session.commandProbe === abortController) session.commandProbe = undefined
    }
  })()
}

export function createAgentSession(opts: AgentCreateOptions, webContents: WebContents): AgentCommandResult {
  const existing = sessions.get(opts.id)
  if (existing) {
    attach(existing, webContents)
    emit(existing, {
      type: 'session:init',
      sessionId: existing.id,
      title: existing.title,
      cwd: existing.cwd,
      source: existing.source,
      ...(existing.slashCommands?.length ? { slashCommands: existing.slashCommands } : {})
    })
    if (existing.authStatus) {
      emit(existing, { type: 'auth:status', sessionId: existing.id, state: existing.authStatus })
    } else {
      refreshAgentAuthStatus(existing)
    }
    emitUsageUpdate(existing)
    prefetchLocalSlashCommands(existing)
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
    queue: [],
    tokenUsage: emptyTokenUsage()
  }
  sessions.set(opts.id, session)
  attach(session, webContents)
  emit(session, { type: 'session:init', sessionId: session.id, title: session.title, cwd: session.cwd, source: session.source })
  emit(session, { type: 'status', sessionId: session.id, status: 'idle' })
  emitUsageUpdate(session)
  refreshAgentAuthStatus(session)
  prefetchLocalSlashCommands(session)
  return { ok: true }
}

export function getAgentSessionSnapshot(sessionId: string): AgentSessionSnapshotResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  return {
    ok: true,
    session: {
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      source: session.source,
      resumeSessionId: session.resumeSessionId
    }
  }
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
  for (const pending of [...session.pendingPermissions.values()]) {
    pending.finish(
      {
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject'
      },
      'reject'
    )
  }
}

function approvedPermissionResult(pending: PendingPermission, remember?: boolean): PermissionResult {
  return {
    behavior: 'allow',
    toolUseID: pending.toolUseId,
    decisionClassification: remember ? 'user_permanent' : 'user_temporary',
    ...(remember && pending.suggestions?.length ? { updatedPermissions: pending.suggestions } : {})
  }
}

function rejectedPermissionResult(pending: PendingPermission, message: string): PermissionResult {
  return {
    behavior: 'deny',
    message,
    toolUseID: pending.toolUseId,
    decisionClassification: 'user_reject'
  }
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
  emitInterrupted(session, '현재 작업을 중단하고 새 지시를 바로 실행합니다.')
  emitProcessEvent(
    session,
    `steer-${Date.now()}`,
    '바로 지시하기',
    '현재 작업을 중단하고 새 지시를 바로 실행합니다.',
    'done'
  )
  rejectPendingPermissions(session, '사용자가 바로 지시하기로 현재 작업을 중단했습니다.')
  cancelPendingDialogs(session)
  session.running?.abort()
  session.commandProbe?.abort()
  session.commandProbe = undefined
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
  session.commandProbe?.abort()
  session.commandProbe = undefined
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
    attachments: displayAgentAttachments(input.attachments)
  })
  emit(session, { type: 'status', sessionId, status: 'working' })

  const prompt = renderPrompt(input)
  void (async () => {
    let contextUsageTimer: NodeJS.Timeout | undefined
    let contextUsageActive = true
    let contextUsagePending = false
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
          pathToClaudeCodeExecutable: packagedClaudeAgentSdkExecutable(),
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
      const pollContextUsage = (): void => {
        if (contextUsagePending || abortController.signal.aborted || !contextUsageActive) return
        contextUsagePending = true
        void withTimeout(response.getContextUsage(), '컨텍스트 사용량 확인', 5000)
          .then((usage) => {
            if (!abortController.signal.aborted && contextUsageActive) rememberContextUsage(session, usage)
          })
          .catch(() => {
            /* Context usage is progressive enhancement; token totals still update from result. */
          })
          .finally(() => {
            contextUsagePending = false
          })
      }
      pollContextUsage()
      contextUsageTimer = setInterval(pollContextUsage, 3000)
      for await (const sdkMessage of response) {
        if (abortController.signal.aborted || session.running !== abortController) break
        handleSdkMessage(session, sdkMessage)
      }
      if (!abortController.signal.aborted && session.running === abortController) {
        emit(session, { type: 'status', sessionId, status: 'idle' })
      }
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
      contextUsageActive = false
      if (contextUsageTimer) clearInterval(contextUsageTimer)
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

export function inspectAgentMcpStatus(sessionId: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.source === 'ssh') {
    return { ok: false, error: '원격 Agent의 MCP 상태 확인은 아직 지원하지 않습니다.' }
  }
  if (session.running) {
    return { ok: false, error: 'Agent 작업이 끝난 뒤 /mcp를 실행해 주세요.' }
  }

  const userMessageId = randomUUID()
  const assistantMessageId = randomUUID()
  const abortController = new AbortController()
  session.running = abortController
  emit(session, {
    type: 'message:user',
    sessionId,
    messageId: userMessageId,
    text: '/mcp',
    attachments: []
  })
  emit(session, { type: 'status', sessionId, status: 'working' })

  void (async () => {
    let diagnostic: ReturnType<typeof query> | undefined
    try {
      diagnostic = query({
        prompt: waitForAbort(abortController.signal),
        options: {
          abortController,
          cwd: session.cwd,
          model: session.model,
          tools: [],
          pathToClaudeCodeExecutable: packagedClaudeAgentSdkExecutable(),
          permissionMode: 'dontAsk',
          includeHookEvents: false,
          includePartialMessages: false,
          env: cleanEnv()
        }
      })
      await withTimeout(diagnostic.initializationResult(), 'MCP 초기화')
      const statuses = await withTimeout(diagnostic.mcpServerStatus(), 'MCP 상태 확인')
      if (abortController.signal.aborted) return
      appendAssistantText(session, assistantMessageId, formatMcpStatus(statuses))
      completeAssistant(session, assistantMessageId)
      emit(session, { type: 'status', sessionId, status: 'done' })
      emit(session, { type: 'status', sessionId, status: 'idle' })
    } catch (error) {
      if (abortController.signal.aborted) return
      emit(session, {
        type: 'error',
        sessionId,
        message: error instanceof Error ? error.message : String(error),
        recoverable: true
      })
      emit(session, { type: 'status', sessionId, status: 'error' })
    } finally {
      diagnostic?.close()
      abortController.abort()
      if (session.running === abortController) session.running = undefined
      startNextQueuedMessage(session)
    }
  })()

  return { ok: true }
}

function displayAgentAttachments(attachments: AgentAttachment[] | undefined): AgentAttachment[] {
  return (attachments ?? []).map(({ content: _content, ...attachment }) => attachment)
}

function renderPrompt(input: AgentSendInput): string {
  const attachments = input.attachments ?? []
  const text =
    input.delivery === 'steer'
      ? `사용자가 진행 중인 작업을 중단하고 방향 전환을 요청했습니다. 아래 지시를 최우선으로 반영하세요.\n\n${input.text}`
      : input.text
  if (attachments.length === 0) return text
  const hasContextOnly = attachments.some((attachment) => attachment.access === 'context-only')
  const hasFolder = attachments.some((attachment) => attachment.kind === 'folder')
  const renderedAttachments = attachments
    .map((attachment, index) => {
      const parts = [`${index + 1}. ${attachment.kind}: ${attachment.label}`]
      if (attachment.origin) parts.push(`origin=${attachment.origin}`)
      if (attachment.access) parts.push(`access=${attachment.access}`)
      if (attachment.path) {
        parts.push(
          attachment.access === 'context-only'
            ? `source_path=${attachment.path}`
            : `path=${attachment.path}`
        )
      }
      if (attachment.range) parts.push(`range=${JSON.stringify(attachment.range)}`)
      if (attachment.text) parts.push(`text=${attachment.text}`)
      if (attachment.content !== undefined) {
        const marker = `LEGAL_TERMINAL_ATTACHMENT_${index + 1}_CONTENT`
        if (attachment.contentTruncated) parts.push('content_truncated=true')
        parts.push(`content<<${marker}\n${attachment.content}\n${marker}`)
      }
      return parts.join('\n   ')
    })
    .join('\n')
  const rules = [
    hasContextOnly
      ? 'Context-only attachments are embedded in this prompt. Treat source_path as informational only; do not try to read it from the remote workspace. Review the embedded content field instead.'
      : undefined,
    hasFolder
      ? 'Folder attachments include only a bounded top-level listing. Do not recursively scan an attached folder unless the user explicitly asks or the task clearly requires it.'
      : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const block = `[legal-terminal attachments]${rules ? `\n${rules}` : ''}\n${renderedAttachments}`
  return text ? `${text}\n\n${block}` : block
}

export function approveAgentPermission(decision: AgentPermissionDecision): AgentCommandResult {
  const candidates = decision.sessionId
    ? [sessions.get(decision.sessionId)].filter((session): session is AgentSession => Boolean(session))
    : [...sessions.values()]
  for (const session of candidates) {
    const pending = session.pendingPermissions.get(decision.requestId)
    if (!pending) continue
    const allowed = decision.decision === 'allow'
    pending.finish(
      allowed
        ? approvedPermissionResult(pending, decision.remember)
        : rejectedPermissionResult(pending, decision.message ?? '사용자가 거절했습니다.'),
      allowed ? 'allow' : 'reject',
      true
    )
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
  emitInterrupted(session)
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
  ipcMain.handle('agent:snapshot', (_e, sessionId: string) => getAgentSessionSnapshot(sessionId))
  ipcMain.handle('agent:worktreeFork', (_e, input: AgentWorktreeForkInput) =>
    createAgentWorktreeFork(input)
  )
  ipcMain.handle('agent:send', (_e, p: { sessionId: string; input: AgentSendInput }) =>
    sendAgentMessage(p.sessionId, p.input)
  )
  ipcMain.handle('agent:mcpStatus', (_e, sessionId: string) => inspectAgentMcpStatus(sessionId))
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
