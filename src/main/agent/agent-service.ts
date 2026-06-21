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
  AgentModelListResult,
  AgentModelOption,
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentPermissionRequest,
  AgentProvider,
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
  finish: (value: any, decision: 'allow' | 'reject', emitWorking?: boolean) => void
  timer: NodeJS.Timeout
}

interface PendingDialog {
  sessionId: string
  kind?: 'claude' | 'codex-user-input'
  finish: (value: any, answer?: AgentDialogAnswer) => void
  timer: NodeJS.Timeout
}

interface QueuedAgentMessage {
  queueId: string
  input: AgentSendInput
  delivery: 'queue' | 'steer'
}

interface CodexPendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface CodexTurnWaiter {
  turnId?: string
  resolve: () => void
  reject: (error: Error) => void
}

interface AgentSession {
  id: string
  cwd: string
  title?: string
  provider: AgentProvider
  model?: string
  reasoningEffort?: string
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
  claudeUsageProbeRunning?: boolean
  claudeUsageProbeLastAt?: number
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
  codexProcess?: ChildProcessWithoutNullStreams
  codexInitialized?: boolean
  codexThreadId?: string
  codexRequestSeq?: number
  codexPending?: Map<number, CodexPendingRequest>
  codexStdoutBuffer?: string
  codexTurnWaiter?: CodexTurnWaiter
  codexTokenUsageTurnIds?: Set<string>
  tokenUsage: AgentTokenUsage
  contextUsage?: AgentContextUsage
  rateLimitUsage?: AgentRateLimitUsage
  rateLimitUsages?: Map<string, AgentRateLimitUsage>
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
const CLAUDE_USAGE_PROBE_COOLDOWN_MS = 60_000
const MIN_TEXT_OVERLAP = 4
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const codexBin = process.platform === 'win32' ? 'codex.cmd' : 'codex'
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

function resolveAgentProvider(provider: AgentProvider | undefined, _source: AgentSource): AgentProvider {
  return provider === 'codex' ? 'codex' : 'claude'
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

function remoteClaudeSlashProbeCommand(session: AgentSession): string {
  const flags = [
    '--verbose --output-format stream-json --input-format stream-json',
    '--permission-mode dontAsk',
    shellArgFlag('--model', session.model).trim()
  ].filter(Boolean).join(' ')
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    unsetClaudeAuthEnvCommand(),
    `cd ${shq(session.cwd)} || exit`,
    'claude_bin=$(command -v claude 2>/dev/null || true)',
    'if [ -z "$claude_bin" ]; then echo "claude command not found on remote PATH" >&2; exit 127; fi',
    `exec "$claude_bin" ${flags}`
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteClaudeUsageCommand(session: AgentSession): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    unsetClaudeAuthEnvCommand(),
    `cd ${shq(session.cwd)} || exit`,
    'claude_bin=$(command -v claude 2>/dev/null || true)',
    'if [ -z "$claude_bin" ]; then echo "claude command not found on remote PATH" >&2; exit 127; fi',
    `exec "$claude_bin" -p --verbose --output-format stream-json ${shq('/usage')}`
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteCodexCommand(session: AgentSession): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    `cd ${shq(session.cwd)} || exit`,
    'codex_bin=$(command -v codex 2>/dev/null || true)',
    'if [ -z "$codex_bin" ]; then echo "codex command not found on remote PATH" >&2; exit 127; fi',
    'exec "$codex_bin" app-server'
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteCodexAuthCommand(): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    'codex_bin=$(command -v codex 2>/dev/null || true)',
    'if [ -z "$codex_bin" ]; then echo "codex command not found on remote PATH" >&2; exit 127; fi',
    '"$codex_bin" logout >/dev/null 2>&1 || true',
    'exec "$codex_bin" login --device-auth'
  ].join('; ')
  return `exec $SHELL -ilc ${shq(inner)}`
}

function remoteCodexAuthStatusCommand(): string {
  const inner = [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    'codex_bin=$(command -v codex 2>/dev/null || true)',
    'if [ -z "$codex_bin" ]; then echo "codex command not found on remote PATH" >&2; exit 127; fi',
    'exec "$codex_bin" login status'
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
  env.PATH = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    env.PATH
  ].filter(Boolean).join(':')
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

function isAuthFailureOutput(value: string): boolean {
  return /not\s+(logged|signed)\s+in|login\s+required|not authenticated|unauthorized|refresh[_\s-]*token|sign in again|log out and sign in again|invalid authentication credentials|api error:\s*401|인증.*필요/i.test(
    value
  )
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
  if (isAuthFailureOutput(trimmed)) return false
  if (/(logged|signed)\s+in|authenticated|claude\.ai/i.test(trimmed)) return true
  return undefined
}

function refreshAgentAuthStatus(session: AgentSession): void {
  if (session.provider === 'codex') {
    if (session.authProcess || session.running) return
    emitAuthStatus(session, 'checking')
    let proc: ChildProcessWithoutNullStreams
    try {
      proc =
        session.source === 'ssh' && session.ssh
          ? spawn(sshBin, [...sshArgs(session.ssh), remoteCodexAuthStatusCommand()], {
              windowsHide: true,
              env: cleanEnv()
            })
          : spawn(codexBin, ['login', 'status'], {
              cwd: session.cwd,
              windowsHide: true,
              env: cleanEnv()
            })
    } catch (error) {
      emitAuthStatus(session, 'error', error instanceof Error ? error.message : String(error))
      return
    }
    let output = ''
    const append = (chunk: Buffer): void => {
      output += cleanProcessText(chunk.toString('utf8'))
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    proc.on('error', (error) => {
      emitAuthStatus(session, error.message.includes('ENOENT') ? 'unavailable' : 'error', error.message)
    })
    proc.on('close', (code) => {
      const loggedIn = loggedInFromAuthStatusOutput(output)
      if (loggedIn === true) {
        emitAuthStatus(session, 'authenticated')
        return
      }
      if (code === 127 || /codex command not found|ENOENT/i.test(output)) {
        emitAuthStatus(session, 'unavailable', 'Codex CLI를 찾을 수 없습니다.')
        return
      }
      if (loggedIn === false || code !== 0) {
        emitAuthStatus(session, 'unauthenticated', output.trim() || undefined)
        return
      }
      emitAuthStatus(session, 'error', 'Codex 로그인 상태를 확인할 수 없습니다.')
    })
    return
  }
  if (session.provider !== 'claude') return
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

function isMcpServerStatus(value: unknown): value is McpServerStatus['status'] {
  return (
    value === 'connected' ||
    value === 'failed' ||
    value === 'needs-auth' ||
    value === 'pending' ||
    value === 'disabled'
  )
}

function mcpStatusesFromUnknown(value: unknown): McpServerStatus[] {
  return unknownArray(value).flatMap((item) => {
    const record = asRecord(item)
    const name = stringValue(record?.name)
    const status = record?.status
    if (!record || !name || !isMcpServerStatus(status)) return []
    const serverInfo = asRecord(record.serverInfo) ?? asRecord(record.server_info)
    const serverName = stringValue(serverInfo?.name)
    const serverVersion = stringValue(serverInfo?.version)
    return [
      {
        name,
        status,
        ...(serverName || serverVersion ? { serverInfo: { name: serverName ?? name, version: serverVersion ?? '' } } : {}),
        ...(stringValue(record.error) ? { error: stringValue(record.error) } : {}),
        ...(asRecord(record.config) ? { config: asRecord(record.config) as McpServerStatus['config'] } : {}),
        ...(stringValue(record.scope) ? { scope: stringValue(record.scope) } : {})
      }
    ]
  })
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

const RATE_LIMIT_TYPE_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage']

function rateLimitTypeOrder(value: string | undefined): number {
  const index = value ? RATE_LIMIT_TYPE_ORDER.indexOf(value) : -1
  return index >= 0 ? index : RATE_LIMIT_TYPE_ORDER.length
}

function rateLimitStatusRank(value: AgentRateLimitUsage['status']): number {
  if (value === 'rejected') return 3
  if (value === 'allowed_warning') return 2
  if (value === 'allowed') return 1
  return 0
}

function rateLimitUsageKey(value: AgentRateLimitUsage): string {
  return value.rateLimitType ?? 'current'
}

function storeRateLimitUsage(session: AgentSession, next: AgentRateLimitUsage): AgentRateLimitUsage {
  if (!session.rateLimitUsages) session.rateLimitUsages = new Map()
  const key = rateLimitUsageKey(next)
  const existing = session.rateLimitUsages.get(key)
  const merged: AgentRateLimitUsage = {
    status: next.status ?? existing?.status,
    rateLimitType: next.rateLimitType ?? existing?.rateLimitType,
    utilization: next.utilization ?? existing?.utilization,
    remainingPercent: next.remainingPercent ?? existing?.remainingPercent,
    resetsAt: next.resetsAt ?? existing?.resetsAt,
    isUsingOverage: next.isUsingOverage ?? existing?.isUsingOverage,
    updatedAt: next.updatedAt
  }
  session.rateLimitUsages.set(key, merged)
  session.rateLimitUsage = primaryRateLimitUsage(sortedRateLimitUsages(session))
  return merged
}

function sortedRateLimitUsages(session: AgentSession): AgentRateLimitUsage[] {
  const values = Array.from(session.rateLimitUsages?.values() ?? [])
  return values.sort((a, b) => rateLimitTypeOrder(a.rateLimitType) - rateLimitTypeOrder(b.rateLimitType))
}

function primaryRateLimitUsage(limits: AgentRateLimitUsage[]): AgentRateLimitUsage | undefined {
  return [...limits].sort((a, b) => {
    const statusDelta = rateLimitStatusRank(b.status) - rateLimitStatusRank(a.status)
    if (statusDelta !== 0) return statusDelta
    const aRemaining = a.remainingPercent ?? Number.POSITIVE_INFINITY
    const bRemaining = b.remainingPercent ?? Number.POSITIVE_INFINITY
    if (aRemaining !== bRemaining) return aRemaining - bRemaining
    return rateLimitTypeOrder(a.rateLimitType) - rateLimitTypeOrder(b.rateLimitType)
  })[0]
}

function emitUsageUpdate(session: AgentSession): void {
  const rateLimits = sortedRateLimitUsages(session)
  emit(session, {
    type: 'usage:update',
    sessionId: session.id,
    usage: session.tokenUsage,
    context: session.contextUsage,
    rateLimit: session.rateLimitUsage,
    rateLimits
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
  const cost =
    session.provider === 'codex'
      ? numberValue(message.total_cost_usd) ?? costUsdFromModelUsage(message.modelUsage)
      : undefined
  const totalCostUsd =
    session.provider === 'codex'
      ? cost !== undefined
        ? (session.tokenUsage.totalCostUsd ?? 0) + cost
        : session.tokenUsage.totalCostUsd
      : undefined
  session.tokenUsage = {
    turns: session.tokenUsage.turns + 1,
    inputTokens: session.tokenUsage.inputTokens + usage.inputTokens,
    outputTokens: session.tokenUsage.outputTokens + usage.outputTokens,
    cacheCreationInputTokens: session.tokenUsage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    cacheReadInputTokens: session.tokenUsage.cacheReadInputTokens + usage.cacheReadInputTokens,
    totalTokens: session.tokenUsage.totalTokens + usage.totalTokens,
    totalCostUsd,
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

const CLAUDE_USAGE_MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
}

function parseClaudeUsageResetTime(value: string | undefined): number | undefined {
  const cleaned = value?.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (!cleaned) return undefined
  const match = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (!match) {
    const direct = Date.parse(cleaned)
    return Number.isFinite(direct) ? direct : undefined
  }
  const month = CLAUDE_USAGE_MONTHS[match[1].toLowerCase()]
  const day = Number.parseInt(match[2], 10)
  let hour = Number.parseInt(match[3], 10)
  const minute = match[4] ? Number.parseInt(match[4], 10) : 0
  const meridiem = match[5].toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return undefined
  }
  const now = new Date()
  const reset = new Date(now.getFullYear(), month, day, hour, minute)
  if (reset.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) reset.setFullYear(reset.getFullYear() + 1)
  return reset.getTime()
}

function claudeUsageRateLimitType(label: string): string | undefined {
  const normalized = label.toLowerCase()
  if (normalized === 'session') return 'five_hour'
  if (normalized === 'week (all models)') return 'seven_day'
  if (normalized.includes('sonnet')) return 'seven_day_sonnet'
  if (normalized.includes('opus')) return 'seven_day_opus'
  return undefined
}

function rememberClaudeUsageSummary(session: AgentSession, text: string | undefined): boolean {
  if (session.provider !== 'claude' || !text) return false
  let updated = false
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^Current\s+(.+?):\s+(\d+(?:\.\d+)?)%\s+used(?:\s+·\s+resets\s+(.+))?$/i)
    if (!match) continue
    const rateLimitType = claudeUsageRateLimitType(match[1])
    if (!rateLimitType) continue
    const usedPercent = Math.min(100, Math.max(0, Number.parseFloat(match[2])))
    if (!Number.isFinite(usedPercent)) continue
    storeRateLimitUsage(session, {
      status: usedPercent >= 100 ? 'rejected' : usedPercent >= 85 ? 'allowed_warning' : 'allowed',
      rateLimitType,
      utilization: usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt: parseClaudeUsageResetTime(match[3]),
      isUsingOverage: false,
      updatedAt: Date.now()
    })
    updated = true
  }
  if (updated) emitUsageUpdate(session)
  return updated
}

function sdkTextContent(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (record.type === 'assistant') {
    const body = asRecord(record.message)
    const text = unknownArray(body?.content)
      .map((blockValue) => {
        const block = asRecord(blockValue)
        return block?.type === 'text' ? stringValue(block.text) : undefined
      })
      .filter((item): item is string => Boolean(item))
      .join('')
    return text || undefined
  }
  if (record.type === 'result') return stringValue(record.result)
  if (record.type === 'system' && record.subtype === 'local_command_output') return stringValue(record.content)
  return undefined
}

function refreshClaudeUsageSummary(session: AgentSession): void {
  if (session.provider !== 'claude' || session.claudeUsageProbeRunning) return
  const now = Date.now()
  if (session.claudeUsageProbeLastAt && now - session.claudeUsageProbeLastAt < CLAUDE_USAGE_PROBE_COOLDOWN_MS) return
  session.claudeUsageProbeRunning = true
  session.claudeUsageProbeLastAt = now

  let proc: ChildProcessWithoutNullStreams
  try {
    proc =
      session.source === 'ssh' && session.ssh
        ? spawn(sshBin, [...sshArgs(session.ssh), remoteClaudeUsageCommand(session)], {
            windowsHide: true,
            env: cleanEnv()
          })
        : spawn(
            packagedClaudeAgentSdkExecutable() ?? CLAUDE_AGENT_SDK_BINARY_BY_PLATFORM[process.platform] ?? 'claude',
            ['-p', '--verbose', '--output-format', 'stream-json', '/usage'],
            {
              cwd: session.cwd,
              windowsHide: true,
              env: cleanEnv()
            }
          )
  } catch {
    session.claudeUsageProbeRunning = false
    return
  }

  let stdoutBuffer = ''
  const handleLine = (line: string): void => {
    if (!line.trim()) return
    try {
      const text = sdkTextContent(JSON.parse(line) as unknown)
      if (text) rememberClaudeUsageSummary(session, text)
    } catch {
      rememberClaudeUsageSummary(session, line)
    }
  }
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  })
  proc.stderr.on('data', () => {
    /* Usage probing is best-effort; visible runs surface their own errors. */
  })
  proc.on('error', () => {
    session.claudeUsageProbeRunning = false
  })
  proc.on('close', () => {
    if (stdoutBuffer.trim()) handleLine(stdoutBuffer)
    session.claudeUsageProbeRunning = false
  })
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
  storeRateLimitUsage(session, rateLimit)

  const overageStatus = stringValue(info.overageStatus)
  if (overageStatus === 'allowed' || overageStatus === 'allowed_warning' || overageStatus === 'rejected') {
    storeRateLimitUsage(session, {
      status: overageStatus,
      rateLimitType: 'overage',
      resetsAt: normalizeResetTime(info.overageResetsAt),
      isUsingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
      updatedAt: Date.now()
    })
  }

  emitUsageUpdate(session)
  if (session.provider === 'claude' && rateLimit.remainingPercent === undefined && rateLimit.rateLimitType !== 'overage') {
    refreshClaudeUsageSummary(session)
  }
  return rateLimit
}

function codexTokenBreakdown(value: unknown):
  | {
      totalTokens: number
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
      reasoningOutputTokens: number
    }
  | undefined {
  const record = asRecord(value)
  const totalTokens = numberValue(record?.totalTokens)
  if (!record || totalTokens === undefined) return undefined
  return {
    totalTokens,
    inputTokens: numberValue(record.inputTokens) ?? 0,
    cachedInputTokens: numberValue(record.cachedInputTokens) ?? 0,
    outputTokens: numberValue(record.outputTokens) ?? 0,
    reasoningOutputTokens: numberValue(record.reasoningOutputTokens) ?? 0
  }
}

function rememberCodexTokenUsage(session: AgentSession, params: Record<string, unknown>): void {
  const usage = asRecord(params.tokenUsage)
  const total = codexTokenBreakdown(usage?.total)
  if (!usage || !total) return
  const last = codexTokenBreakdown(usage.last)
  const turnId = stringValue(params.turnId)
  if (turnId) {
    if (!session.codexTokenUsageTurnIds) session.codexTokenUsageTurnIds = new Set()
    session.codexTokenUsageTurnIds.add(turnId)
  }
  const now = Date.now()
  session.tokenUsage = {
    turns: Math.max(session.tokenUsage.turns, session.codexTokenUsageTurnIds?.size ?? 0, last ? 1 : 0),
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens + total.reasoningOutputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: total.cachedInputTokens,
    totalTokens: total.totalTokens,
    totalCostUsd: session.tokenUsage.totalCostUsd,
    lastTurnTokens: last?.totalTokens,
    updatedAt: now
  }
  const modelContextWindow = numberValue(usage.modelContextWindow)
  if (modelContextWindow && modelContextWindow > 0) {
    session.contextUsage = {
      totalTokens: total.totalTokens,
      maxTokens: modelContextWindow,
      remainingTokens: Math.max(0, modelContextWindow - total.totalTokens),
      percentage: Math.min(100, Math.max(0, (total.totalTokens / modelContextWindow) * 100)),
      model: session.model,
      updatedAt: now
    }
  }
  emitUsageUpdate(session)
}

function rememberCodexRateLimits(session: AgentSession, value: unknown): void {
  const snapshot = asRecord(value)
  if (!snapshot) return
  const primary = asRecord(snapshot.primary)
  const usedPercent = numberValue(primary?.usedPercent)
  const reachedType = stringValue(snapshot.rateLimitReachedType)
  const rateLimit: AgentRateLimitUsage = {
    status: reachedType ? 'rejected' : usedPercent !== undefined && usedPercent >= 85 ? 'allowed_warning' : 'allowed',
    rateLimitType:
      stringValue(snapshot.limitName) ?? stringValue(snapshot.limitId) ?? stringValue(snapshot.planType) ?? undefined,
    utilization: usedPercent,
    remainingPercent: usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent),
    resetsAt: normalizeResetTime(primary?.resetsAt),
    isUsingOverage: false,
    updatedAt: Date.now()
  }
  storeRateLimitUsage(session, rateLimit)
  emitUsageUpdate(session)
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
  if (snapshot) {
    rememberClaudeUsageSummary(session, snapshot)
    reconcileAssistantSnapshot(session, messageId, snapshot)
  }
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
    if (text) {
      rememberClaudeUsageSummary(session, text)
      reconcileAssistantSnapshot(session, activeAssistantOutputId(session, stringValue(message.uuid)), text)
    }
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
  rememberClaudeUsageSummary(session, stringValue(message.result))
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

function codexApprovalPolicy(mode: AgentPermissionMode): string {
  return mode === 'bypassPermissions' ? 'never' : 'on-request'
}

function codexSandboxMode(mode: AgentPermissionMode): string {
  return mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write'
}

function codexSandboxPolicy(mode: AgentPermissionMode, cwd: string): Record<string, unknown> {
  if (mode === 'bypassPermissions') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

function codexSend(session: AgentSession, message: Record<string, unknown>): void {
  const proc = session.codexProcess
  if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded) {
    throw new Error('Codex app-server가 실행 중이 아닙니다.')
  }
  proc.stdin.write(`${JSON.stringify(message)}\n`)
}

function codexNotify(session: AgentSession, method: string, params?: unknown): void {
  codexSend(session, params === undefined ? { method } : { method, params })
}

function codexRequest(session: AgentSession, method: string, params?: unknown): Promise<unknown> {
  const id = (session.codexRequestSeq ?? 0) + 1
  session.codexRequestSeq = id
  if (!session.codexPending) session.codexPending = new Map()
  return new Promise((resolve, reject) => {
    session.codexPending!.set(id, { resolve, reject })
    try {
      codexSend(session, params === undefined ? { id, method } : { id, method, params })
    } catch (error) {
      session.codexPending!.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function codexRespond(session: AgentSession, id: unknown, result: unknown): void {
  if (typeof id !== 'number' && typeof id !== 'string') return
  codexSend(session, { id, result })
}

function codexRespondError(session: AgentSession, id: unknown, message: string): void {
  if (typeof id !== 'number' && typeof id !== 'string') return
  codexSend(session, { id, error: { code: -32000, message } })
}

function rejectCodexPending(session: AgentSession, error: Error): void {
  for (const pending of session.codexPending?.values() ?? []) pending.reject(error)
  session.codexPending?.clear()
  session.codexTurnWaiter?.reject(error)
  session.codexTurnWaiter = undefined
}

function codexMaybeModel(session: AgentSession, includeEffort = false): Record<string, unknown> {
  return {
    ...(session.model ? { model: session.model } : {}),
    ...(includeEffort && session.reasoningEffort ? { effort: session.reasoningEffort } : {})
  }
}

function startCodexProcess(session: AgentSession): void {
  if (session.codexProcess) return
  const proc =
    session.source === 'ssh' && session.ssh
      ? spawn(sshBin, [...sshArgs(session.ssh), remoteCodexCommand(session)], {
          windowsHide: true,
          env: cleanEnv()
        })
      : spawn(codexBin, ['app-server'], {
          cwd: session.cwd,
          windowsHide: true,
          env: cleanEnv()
        })
  session.codexProcess = proc
  session.codexPending = new Map()
  session.codexStdoutBuffer = ''

  proc.stdout.on('data', (chunk: Buffer) => {
    session.codexStdoutBuffer = `${session.codexStdoutBuffer ?? ''}${chunk.toString('utf8')}`
    const lines = session.codexStdoutBuffer.split(/\r?\n/)
    session.codexStdoutBuffer = lines.pop() ?? ''
    for (const line of lines) handleCodexJsonLine(session, line)
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = cleanProcessText(chunk.toString('utf8')).trim()
    if (!text) return
    if (isAuthFailureOutput(text)) emitAuthStatus(session, 'unauthenticated', text)
    emitProcessEvent(session, `codex-stderr-${Date.now()}`, 'Codex', text, 'running')
  })
  proc.on('error', (error) => {
    rejectCodexPending(session, error)
    emit(session, { type: 'error', sessionId: session.id, message: error.message, recoverable: true })
    emit(session, { type: 'status', sessionId: session.id, status: 'error' })
  })
  proc.on('close', (code, signal) => {
    if (session.codexProcess === proc) session.codexProcess = undefined
    session.codexInitialized = false
    rejectCodexPending(
      session,
      new Error(`Codex app-server 종료: code=${code ?? 'unknown'}${signal ? ` signal=${signal}` : ''}`)
    )
  })
}

async function ensureCodexThread(session: AgentSession): Promise<string> {
  if (session.codexThreadId && session.codexProcess) return session.codexThreadId
  startCodexProcess(session)
  await ensureCodexInitialized(session)
  const result = asRecord(
    await codexRequest(session, 'thread/start', {
      cwd: session.cwd,
      ...codexMaybeModel(session),
      approvalPolicy: codexApprovalPolicy(session.permissionMode),
      sandbox: codexSandboxMode(session.permissionMode),
      threadSource: 'user'
    })
  )
  const thread = asRecord(result?.thread)
  const threadId = stringValue(thread?.id) ?? stringValue(result?.threadId)
  if (!threadId) throw new Error('Codex thread를 시작하지 못했습니다.')
  session.codexThreadId = threadId
  emit(session, {
    type: 'session:init',
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    provider: session.provider,
    source: session.source
  })
  return threadId
}

async function ensureCodexInitialized(session: AgentSession): Promise<void> {
  if (session.codexInitialized && session.codexProcess) return
  startCodexProcess(session)
  await codexRequest(session, 'initialize', {
    clientInfo: {
      name: 'legal_terminal',
      title: 'Legal Terminal',
      version: process.env.npm_package_version ?? 'dev'
    },
    capabilities: { experimentalApi: true }
  })
  codexNotify(session, 'initialized')
  session.codexInitialized = true
}

function codexRequestDecision(
  requestMethod: string,
  allowed: boolean,
  remember?: boolean
): Record<string, unknown> {
  if (requestMethod === 'item/commandExecution/requestApproval') {
    return { decision: allowed ? (remember ? 'acceptForSession' : 'accept') : 'decline' }
  }
  if (requestMethod === 'item/fileChange/requestApproval') {
    return { decision: allowed ? (remember ? 'acceptForSession' : 'accept') : 'decline' }
  }
  if (requestMethod === 'applyPatchApproval' || requestMethod === 'execCommandApproval') {
    return { decision: allowed ? (remember ? 'approved_for_session' : 'approved') : 'denied' }
  }
  return { decision: allowed ? 'accept' : 'decline' }
}

function handleCodexApprovalRequest(
  session: AgentSession,
  id: unknown,
  method: string,
  params: Record<string, unknown>
): void {
  const requestId = String(id ?? randomUUID())
  const itemId = stringValue(params.itemId) ?? requestId
  const isFileChange = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
  const toolName = isFileChange ? 'Write' : 'Shell'
  const input = {
    command: stringValue(params.command),
    cwd: stringValue(params.cwd),
    reason: stringValue(params.reason),
    grantRoot: stringValue(params.grantRoot),
    permissions: params.permissions
  }
  const request: AgentPermissionRequest = {
    requestId,
    sessionId: session.id,
    toolUseId: itemId,
    toolName,
    input,
    inputPreview: safeJsonPreview(input),
    title: isFileChange ? '파일 변경 승인' : '명령 실행 승인',
    description: stringValue(params.reason)
  }
  emit(session, { type: 'permission:request', request })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_permission' })

  let settled = false
  let pending: PendingPermission
  const timer = setTimeout(() => pending.finish(codexRequestDecision(method, false), 'reject'), PERMISSION_TIMEOUT_MS)
  pending = {
    sessionId: session.id,
    toolUseId: itemId,
    timer,
    finish: (value, decision, emitWorking = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.pendingPermissions.delete(requestId)
      const allowed = decision === 'allow'
      const remember = stringValue(asRecord(value)?.decisionClassification) === 'user_permanent'
      const result =
        method === 'item/permissions/requestApproval'
          ? {
              permissions: allowed ? (asRecord(params.permissions) ?? {}) : {},
              scope: allowed && remember ? 'session' : 'turn'
            }
          : codexRequestDecision(method, allowed, remember)
      try {
        codexRespond(session, id, result)
      } catch (error) {
        emit(session, {
          type: 'error',
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        })
      }
      emit(session, { type: 'permission:resolved', sessionId: session.id, requestId, decision })
      if (emitWorking) emit(session, { type: 'status', sessionId: session.id, status: 'working' })
    }
  }
  session.pendingPermissions.set(requestId, pending)
}

function buildCodexDialogResult(dialog: AgentDialogRequest, answer: AgentDialogAnswer): Record<string, unknown> {
  if (answer.cancelled) return { answers: {} }
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of dialog.questions) {
    const value = answer.answers?.[question.question]
    if (!value) continue
    answers[question.id] = {
      answers: value.split(',').map((part) => part.trim()).filter(Boolean)
    }
  }
  const response = answer.response?.trim()
  const firstQuestion = dialog.questions[0]
  if (response && firstQuestion && !answers[firstQuestion.id]) answers[firstQuestion.id] = { answers: [response] }
  return { answers }
}

function handleCodexUserInputRequest(session: AgentSession, id: unknown, params: Record<string, unknown>): void {
  const dialogId = String(id ?? randomUUID())
  const questions = unknownArray(params.questions)
    .map((value, index): AgentDialogQuestion | undefined => {
      const question = asRecord(value)
      const text = stringValue(question?.question)
      if (!question || !text) return undefined
      const options = unknownArray(question.options).map((optionValue, optionIndex) => {
        const option = asRecord(optionValue)
        return {
          id: `${index}-${optionIndex}`,
          label: stringValue(option?.label) ?? '',
          description: stringValue(option?.description)
        }
      }).filter((option) => option.label)
      return {
        id: stringValue(question.id) ?? `q-${index}`,
        question: text,
        header: stringValue(question.header),
        options,
        multiSelect: false
      }
    })
    .filter((question): question is AgentDialogQuestion => Boolean(question))
  const dialog = emitDialogRequest(session, {
    dialogId,
    dialogKind: 'codex.requestUserInput',
    title: questions[0]?.header ?? 'Codex 질문',
    questions,
    payloadPreview: safeJsonPreview(params),
    blocking: true
  })
  let pending: PendingDialog
  const timer = setTimeout(() => {
    pending.finish({ answers: {} }, { sessionId: session.id, dialogId, cancelled: true })
  }, Math.max(60_000, numberValue(params.autoResolutionMs) ?? USER_DIALOG_TIMEOUT_MS))
  let settled = false
  pending = {
    sessionId: session.id,
    kind: 'codex-user-input',
    timer,
    finish: (value, answer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.pendingDialogs.delete(dialogId)
      try {
        codexRespond(session, id, value)
      } catch (error) {
        emit(session, {
          type: 'error',
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        })
      }
      emit(session, {
        type: 'dialog:resolved',
        sessionId: session.id,
        dialogId,
        answers: answer?.answers,
        response: answer?.response,
        cancelled: answer?.cancelled
      })
      emit(session, { type: 'status', sessionId: session.id, status: 'working' })
    }
  }
  session.dialogs.set(dialogId, dialog)
  session.pendingDialogs.set(dialogId, pending)
}

function handleCodexServerRequest(session: AgentSession, message: Record<string, unknown>): void {
  const method = stringValue(message.method)
  const params = asRecord(message.params) ?? {}
  if (!method) return
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'applyPatchApproval' ||
    method === 'execCommandApproval'
  ) {
    handleCodexApprovalRequest(session, message.id, method, params)
    return
  }
  if (method === 'item/tool/requestUserInput') {
    handleCodexUserInputRequest(session, message.id, params)
    return
  }
  codexRespondError(session, message.id, `${method} 요청은 아직 지원하지 않습니다.`)
}

function codexFileChangeText(item: Record<string, unknown>): { filePath?: string; text?: string } {
  const changes = unknownArray(item.changes).map(asRecord).filter((change): change is Record<string, unknown> => Boolean(change))
  const filePath = stringValue(changes[0]?.path)
  const text = changes
    .map((change) => [stringValue(change.path), stringValue(change.diff)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
  return { filePath, text: text || undefined }
}

function base64Text(value: unknown): string | undefined {
  const text = stringValue(value)
  if (!text) return undefined
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

function handleCodexItemStarted(session: AgentSession, item: Record<string, unknown>): void {
  const itemId = stringValue(item.id) ?? randomUUID()
  const type = stringValue(item.type)
  if (type === 'agentMessage') {
    startAssistant(session, itemId)
    const text = stringValue(item.text)
    if (text) reconcileAssistantSnapshot(session, itemId, text)
    return
  }
  if (type === 'commandExecution') {
    session.startedTools.add(itemId)
    emit(session, {
      type: 'tool:start',
      sessionId: session.id,
      toolId: itemId,
      name: 'Shell',
      label: 'Shell',
      inputPreview: [stringValue(item.command), stringValue(item.cwd)].filter(Boolean).join('\n')
    })
    return
  }
  if (type === 'fileChange') {
    const { filePath, text } = codexFileChangeText(item)
    emit(session, {
      type: 'diff:proposed',
      proposal: {
        proposalId: itemId,
        sessionId: session.id,
        toolUseId: itemId,
        filePath,
        newString: text
      }
    })
    return
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('.') || type
    emit(session, { type: 'tool:start', sessionId: session.id, toolId: itemId, name, label: name, inputPreview: safeJsonPreview(item.arguments) })
  }
}

function handleCodexItemCompleted(session: AgentSession, item: Record<string, unknown>): void {
  const itemId = stringValue(item.id) ?? randomUUID()
  const type = stringValue(item.type)
  if (type === 'agentMessage') {
    const text = stringValue(item.text)
    if (text) reconcileAssistantSnapshot(session, itemId, text)
    completeAssistant(session, itemId)
    return
  }
  if (type === 'commandExecution') {
    const status = stringValue(item.status)
    emit(session, {
      type: 'tool:done',
      sessionId: session.id,
      toolId: itemId,
      outputPreview: stringValue(item.aggregatedOutput),
      elapsedMs: numberValue(item.durationMs),
      isError: status === 'failed' || status === 'declined'
    })
    return
  }
  if (type === 'fileChange') {
    const { filePath, text } = codexFileChangeText(item)
    emit(session, {
      type: 'diff:applied',
      sessionId: session.id,
      proposalId: itemId,
      filePath,
      newString: text
    })
    return
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    emit(session, {
      type: 'tool:done',
      sessionId: session.id,
      toolId: itemId,
      outputPreview: safeJsonPreview(item.result ?? item.contentItems ?? item.error),
      elapsedMs: numberValue(item.durationMs),
      isError: item.success === false || Boolean(item.error)
    })
  }
}

function handleCodexNotification(session: AgentSession, message: Record<string, unknown>): void {
  const method = stringValue(message.method)
  const params = asRecord(message.params)
  if (!method || !params) return
  if (method === 'thread/started') {
    const threadId = stringValue(asRecord(params.thread)?.id)
    if (threadId) session.codexThreadId = threadId
    return
  }
  if (method === 'thread/settings/updated') {
    const settings = asRecord(params.threadSettings)
    const model = stringValue(settings?.model)
    const effort = stringValue(settings?.effort)
    if (model && session.model) session.model = model
    if (session.reasoningEffort || effort) session.reasoningEffort = effort
    return
  }
  if (method === 'thread/tokenUsage/updated') {
    rememberCodexTokenUsage(session, params)
    return
  }
  if (method === 'account/rateLimits/updated') {
    rememberCodexRateLimits(session, params.rateLimits)
    return
  }
  if (method === 'turn/started') {
    const turnId = stringValue(asRecord(params.turn)?.id)
    if (session.codexTurnWaiter) session.codexTurnWaiter.turnId = turnId
    emit(session, { type: 'status', sessionId: session.id, status: 'working' })
    return
  }
  if (method === 'item/agentMessage/delta') {
    appendAssistantText(session, stringValue(params.itemId) ?? activeAssistantOutputId(session), stringValue(params.delta) ?? '')
    return
  }
  if (method === 'item/started') {
    const item = asRecord(params.item)
    if (item) handleCodexItemStarted(session, item)
    return
  }
  if (method === 'item/completed') {
    const item = asRecord(params.item)
    if (item) handleCodexItemCompleted(session, item)
    return
  }
  if (method === 'item/commandExecution/outputDelta') {
    emitProcessEvent(
      session,
      stringValue(params.itemId) ?? randomUUID(),
      '명령 출력',
      stringValue(params.delta),
      'running'
    )
    return
  }
  if (method === 'command/exec/outputDelta') {
    emitProcessEvent(
      session,
      stringValue(params.processId) ?? randomUUID(),
      `명령 출력${stringValue(params.stream) ? ` · ${stringValue(params.stream)}` : ''}`,
      base64Text(params.deltaBase64),
      'running'
    )
    return
  }
  if (method === 'process/outputDelta') {
    emitProcessEvent(
      session,
      stringValue(params.processHandle) ?? randomUUID(),
      `프로세스 출력${stringValue(params.stream) ? ` · ${stringValue(params.stream)}` : ''}`,
      base64Text(params.deltaBase64),
      'running'
    )
    return
  }
  if (method === 'process/exited') {
    const processId = stringValue(params.processHandle) ?? randomUUID()
    const exitCode = numberValue(params.exitCode)
    const text = [stringValue(params.stdout), stringValue(params.stderr)].filter(Boolean).join('\n')
    emitProcessEvent(session, processId, '프로세스 종료', text || `exit ${exitCode ?? 'unknown'}`, exitCode ? 'error' : 'done')
    return
  }
  if (method === 'turn/completed') {
    const turn = asRecord(params.turn)
    const status = stringValue(turn?.status)
    if (session.turnAssistantMessageId) completeAssistant(session, session.turnAssistantMessageId)
    emit(session, {
      type: 'status',
      sessionId: session.id,
      status: status === 'failed' ? 'error' : 'done'
    })
    const waiter = session.codexTurnWaiter
    session.codexTurnWaiter = undefined
    if (status === 'failed') {
      const error = asRecord(turn?.error)
      const message = stringValue(error?.message) ?? 'Codex 작업이 실패했습니다.'
      emit(session, { type: 'error', sessionId: session.id, message, recoverable: true })
      waiter?.reject(new Error(message))
    } else {
      waiter?.resolve()
    }
  }
}

function handleCodexJsonLine(session: AgentSession, line: string): void {
  if (!line.trim()) return
  let message: Record<string, unknown> | null = null
  try {
    message = asRecord(JSON.parse(line) as unknown)
  } catch {
    emit(session, { type: 'raw', sessionId: session.id, message: { source: 'codex-stdout', line } })
    return
  }
  if (!message) return
  emit(session, { type: 'raw', sessionId: session.id, message })
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const id = numberValue(message.id)
    if (id === undefined) return
    const pending = session.codexPending?.get(id)
    if (!pending) return
    session.codexPending?.delete(id)
    const error = asRecord(message.error)
    if (error) pending.reject(new Error(stringValue(error.message) ?? 'Codex 요청 실패'))
    else pending.resolve(message.result)
    return
  }
  if (message.id !== undefined && message.method) {
    handleCodexServerRequest(session, message)
    return
  }
  handleCodexNotification(session, message)
}

async function runCodexAgentMessage(
  session: AgentSession,
  prompt: string,
  abortController: AbortController
): Promise<void> {
  const threadId = await ensureCodexThread(session)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      abortController.signal.removeEventListener('abort', abort)
      if (session.codexTurnWaiter === waiter) session.codexTurnWaiter = undefined
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => {
      void codexRequest(session, 'turn/interrupt', { threadId }).catch(() => {})
      finish()
    }
    const waiter: CodexTurnWaiter = {
      resolve: () => finish(),
      reject: (error) => finish(error)
    }
    session.codexTurnWaiter = waiter
    abortController.signal.addEventListener('abort', abort, { once: true })
    void codexRequest(session, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: session.cwd,
      ...codexMaybeModel(session, true),
      approvalPolicy: codexApprovalPolicy(session.permissionMode),
      sandboxPolicy: codexSandboxPolicy(session.permissionMode, session.cwd)
    }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
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

function spawnClaudeInitProbe(session: AgentSession): ChildProcessWithoutNullStreams {
  if (session.source === 'ssh' && session.ssh) {
    return spawn(sshBin, [...sshArgs(session.ssh), remoteClaudeSlashProbeCommand(session)], {
      windowsHide: true,
      env: cleanEnv()
    })
  }
  return spawn(
    packagedClaudeAgentSdkExecutable() ?? CLAUDE_AGENT_SDK_BINARY_BY_PLATFORM[process.platform] ?? 'claude',
    [
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      ...(session.model ? ['--model', session.model] : [])
    ],
    {
      cwd: session.cwd,
      windowsHide: true,
      env: cleanEnv()
    }
  )
}

function readClaudeInitMessage(
  session: AgentSession,
  abortController: AbortController,
  timeoutMs = 15_000
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams | undefined
    let stdoutBuffer = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const stop = (): void => {
      if (!proc || proc.killed) return
      try {
        proc.kill()
      } catch {
        /* already exited */
      }
    }
    const settle = (message?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      abortController.signal.removeEventListener('abort', stop)
      stop()
      resolve(message)
    }
    const handleLine = (line: string): void => {
      if (!line.trim()) return
      try {
        const message = asRecord(JSON.parse(line) as unknown)
        if (message?.type === 'system' && message.subtype === 'init') settle(message)
      } catch {
        /* Ignore non-JSON startup noise. */
      }
    }

    try {
      proc = spawnClaudeInitProbe(session)
    } catch {
      settle()
      return
    }

    abortController.signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(() => settle(), timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })
    proc.stderr.on('data', () => {
      /* Discovery is best-effort; real agent runs surface stderr. */
    })
    proc.on('error', () => settle())
    proc.on('close', () => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer)
      settle()
    })
    proc.stdin.on('error', () => {
      /* The process close handler settles discovery. */
    })
    proc.stdin.write(`${remotePromptLine(' ')}\n`)
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
  const label = session.provider === 'codex' ? 'Codex' : 'Claude'
  if (session.authProcess) return { ok: false, error: `이미 ${label} 로그인 절차가 실행 중입니다.` }
  if (session.authStatus === 'authenticated') {
    return { ok: false, error: `이미 ${label}에 로그인되어 있습니다.` }
  }
  if (session.provider !== 'codex' && (session.source !== 'ssh' || !session.ssh)) {
    return { ok: false, error: '현재 구현은 원격 Agent 세션의 Claude 로그인만 지원합니다.' }
  }

  let proc: ChildProcessWithoutNullStreams
  try {
    if (session.provider === 'codex') {
      proc =
        session.source === 'ssh' && session.ssh
          ? spawn(sshBin, [...sshArgs(session.ssh, { batchMode: false, tty: true }), remoteCodexAuthCommand()], {
              windowsHide: true,
              env: cleanEnv()
            })
          : process.platform === 'win32'
            ? spawn(codexBin, ['login', '--device-auth'], {
                cwd: session.cwd,
                windowsHide: true,
                env: cleanEnv()
              })
            : spawn('/bin/sh', ['-lc', `${shq(codexBin)} logout >/dev/null 2>&1 || true; exec ${shq(codexBin)} login --device-auth`], {
                cwd: session.cwd,
                windowsHide: true,
                env: cleanEnv()
              })
    } else {
      proc = spawn(sshBin, [...sshArgs(session.ssh!, { batchMode: false, tty: true }), remoteClaudeAuthCommand()], {
        windowsHide: true,
        env: cleanEnv()
      })
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  session.authProcess = proc
  emit(session, { type: 'auth:started', sessionId: session.id, source: session.source })
  emit(session, { type: 'status', sessionId: session.id, status: 'waiting_user' })

  proc.stdout.on('data', (chunk: Buffer) => emitAuthOutput(session, chunk))
  proc.stderr.on('data', (chunk: Buffer) => emitAuthOutput(session, chunk))
  proc.stdin.on('error', () => {
    /* SSH or the auth CLI may close stdin after browser-based auth completes. */
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
      message: ok ? `${label} 로그인이 완료되었습니다.` : `${label} 로그인 종료: code=${code ?? 'unknown'}`
    })
    emit(session, { type: 'status', sessionId: session.id, status: ok ? 'idle' : 'error' })
    refreshAgentAuthStatus(session)
  })

  return { ok: true }
}

export function sendAgentAuthInput(sessionId: string, input: AgentAuthInput): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (!session.authProcess) return { ok: false, error: '실행 중인 로그인 절차가 없습니다.' }
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

function prefetchClaudeSlashCommands(session: AgentSession): void {
  if (session.provider !== 'claude' || session.running || session.commandProbe) return
  if (session.source === 'ssh' && !session.ssh) return

  const abortController = new AbortController()
  session.commandProbe = abortController

  void (async () => {
    try {
      const init = await readClaudeInitMessage(session, abortController)
      const commands = normalizeAgentSlashCommands(init?.slash_commands ?? init?.commands)
      if (commands.length === 0 || abortController.signal.aborted || sessions.get(session.id) !== session) return
      session.slashCommands = commands
      emit(session, { type: 'session:commands', sessionId: session.id, commands })
    } catch {
      /* Slash commands are progressive enhancement; the agent still works without them. */
    } finally {
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
      provider: existing.provider,
      source: existing.source,
      ...(existing.slashCommands?.length ? { slashCommands: existing.slashCommands } : {})
    })
    if (existing.authStatus) {
      emit(existing, { type: 'auth:status', sessionId: existing.id, state: existing.authStatus })
    } else {
      refreshAgentAuthStatus(existing)
    }
    emitUsageUpdate(existing)
    if (existing.provider === 'claude') prefetchClaudeSlashCommands(existing)
    return { ok: true }
  }
  if (!opts.cwd) return { ok: false, error: 'Agent 세션 cwd가 필요합니다.' }
  if (opts.source === 'ssh' && !opts.ssh) {
    return { ok: false, error: '원격 Agent 세션에 SSH 연결 정보가 필요합니다.' }
  }
  const source = opts.source ?? 'local'
  const provider = resolveAgentProvider(opts.provider, source)

  const session: AgentSession = {
    id: opts.id,
    cwd: opts.cwd,
    title: opts.title,
    provider,
    model: opts.model,
    permissionMode: opts.permissionMode ?? 'ask',
    resumeSessionId: opts.resumeSessionId,
    tools: opts.tools,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    source,
    ssh: opts.ssh,
    authStatus: provider === 'codex' || (source === 'ssh' && provider === 'claude') ? 'checking' : undefined,
    viewers: new Map(),
    pendingPermissions: new Map(),
    pendingDialogs: new Map(),
    dialogs: new Map(),
    assistantMessages: new Set(),
    assistantText: new Map(),
    assistantStreamed: new Set(),
    startedTools: new Set(),
    queue: [],
    tokenUsage: emptyTokenUsage(),
    rateLimitUsages: new Map()
  }
  sessions.set(opts.id, session)
  attach(session, webContents)
  emit(session, {
    type: 'session:init',
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    provider: session.provider,
    source: session.source
  })
  emit(session, { type: 'status', sessionId: session.id, status: 'idle' })
  emitUsageUpdate(session)
  if (session.provider === 'claude' || session.provider === 'codex') {
    refreshAgentAuthStatus(session)
  }
  if (session.provider === 'claude') {
    prefetchClaudeSlashCommands(session)
  }
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
      provider: session.provider,
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

function codexModelOption(value: unknown): AgentModelOption | undefined {
  const record = asRecord(value)
  const model = stringValue(record?.model) ?? stringValue(record?.id)
  if (!record || !model) return undefined
  const supportedReasoningEfforts = unknownArray(record.supportedReasoningEfforts).flatMap((item) => {
    const effort = asRecord(item)
    const reasoningEffort = stringValue(effort?.reasoningEffort)
    if (!effort || !reasoningEffort) return []
    const description = stringValue(effort.description)
    return [{ reasoningEffort, ...(description ? { description } : {}) }]
  })
  return {
    id: stringValue(record.id) ?? model,
    model,
    displayName: stringValue(record.displayName) ?? model,
    description: stringValue(record.description),
    isDefault: Boolean(record.isDefault),
    ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
    ...(stringValue(record.defaultReasoningEffort)
      ? { defaultReasoningEffort: stringValue(record.defaultReasoningEffort) }
      : {})
  }
}

export async function listAgentModels(sessionId: string): Promise<AgentModelListResult> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.provider !== 'codex') return { ok: false, error: '모델 목록은 Codex Agent에서만 지원합니다.' }
  try {
    await ensureCodexInitialized(session)
    const models: AgentModelOption[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 5; page++) {
      const result = asRecord(
        await codexRequest(session, 'model/list', {
          cursor,
          limit: 50,
          includeHidden: false
        })
      )
      for (const item of unknownArray(result?.data)) {
        const option = codexModelOption(item)
        if (option) models.push(option)
      }
      cursor = stringValue(result?.nextCursor)
      if (!cursor) break
    }
    return { ok: true, models, selectedModel: session.model, selectedReasoningEffort: session.reasoningEffort }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function setAgentModel(sessionId: string, model?: string, reasoningEffort?: string): AgentCommandResult {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.provider !== 'codex') return { ok: false, error: '모델 선택은 Codex Agent에서만 지원합니다.' }
  session.model = model?.trim() || undefined
  session.reasoningEffort = reasoningEffort?.trim() || undefined
  const label = [
    `모델: ${session.model ?? '기본값'}`,
    `Effort: ${session.reasoningEffort ?? '기본값'}`
  ].join('\n')
  emitProcessEvent(session, `codex-model-${Date.now()}`, 'Codex 모델', label, 'done')
  return { ok: true }
}

function codexListSummary(title: string, result: unknown): string {
  const record = asRecord(result)
  const data = unknownArray(record?.data)
  if (data.length === 0) return `${title}\n\n${safeJsonPreview(result, 2400)}`
  const lines = [title, '']
  for (const item of data.slice(0, 40)) {
    const entry = asRecord(item)
    const name =
      stringValue(entry?.displayName) ??
      stringValue(entry?.name) ??
      stringValue(entry?.title) ??
      stringValue(entry?.id) ??
      safeJsonPreview(item, 120)
    const description = stringValue(entry?.description)
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`)
  }
  if (data.length > 40) lines.push(`- ... ${data.length - 40}개 더 있음`)
  return lines.join('\n')
}

function codexStatusSummary(session: AgentSession): string {
  return [
    `Provider: ${session.provider}`,
    `Source: ${session.source}`,
    `CWD: ${session.cwd}`,
    `Thread: ${session.codexThreadId ?? '아직 시작 안 됨'}`,
    `Model: ${session.model ?? '기본값'}`,
    `Effort: ${session.reasoningEffort ?? '기본값'}`,
    `Permissions: ${session.permissionMode}`,
    `Turns: ${session.tokenUsage.turns}`,
    `Tokens: ${session.tokenUsage.totalTokens}`
  ].join('\n')
}

function codexPermissionModeFromSlash(argument: string): AgentPermissionMode | undefined {
  const value = argument.trim().toLowerCase()
  if (!value || value === 'status') return undefined
  if (value === 'ask' || value === 'confirm') return 'ask'
  if (value === 'plan' || value === 'read-only' || value === 'readonly') return 'plan'
  if (value === 'accept-edits' || value === 'acceptedits' || value === 'edits') return 'acceptEdits'
  if (value === 'auto' || value === 'bypass' || value === 'full-auto') return 'bypassPermissions'
  if (value === 'deny' || value === 'dontask' || value === 'donotask') return 'dontAsk'
  return undefined
}

async function runCodexSlashCommand(
  session: AgentSession,
  command: string,
  argument = ''
): Promise<AgentCommandResult> {
  const name = normalizeSlashCommandName(command)?.toLowerCase()
  if (!name) return { ok: false, error: 'Slash command가 비어 있습니다.' }
  if (session.running) return { ok: false, error: 'Codex 작업이 끝난 뒤 실행해 주세요.' }

  const emitSlash = (title: string, text: string, status: string = 'done'): void => {
    emitProcessEvent(session, `codex-slash-${name}-${Date.now()}`, title, text, status)
  }

  try {
    if (name === '/status') {
      emitSlash('/status', codexStatusSummary(session))
      return { ok: true }
    }

    if (name === '/permissions') {
      const nextMode = codexPermissionModeFromSlash(argument)
      if (nextMode) session.permissionMode = nextMode
      emitSlash('/permissions', `현재 권한 모드: ${session.permissionMode}`)
      return { ok: true }
    }

    if (name === '/new' || name === '/clear') {
      session.codexThreadId = undefined
      emitSlash(name, '새 Codex thread로 전환했습니다.')
      return { ok: true }
    }

    await ensureCodexInitialized(session)

    if (name === '/mcp') {
      const threadId = session.codexThreadId
      const result = await codexRequest(session, 'mcpServerStatus/list', {
        limit: 100,
        detail: 'full',
        ...(threadId ? { threadId } : {})
      })
      emitSlash('/mcp', codexListSummary('MCP 서버', result))
      return { ok: true }
    }

    if (name === '/plugins') {
      const result = await codexRequest(session, 'plugin/list', { cwds: [session.cwd] })
      emitSlash('/plugins', codexListSummary('플러그인', result))
      return { ok: true }
    }

    if (name === '/skills') {
      const result = await codexRequest(session, 'skills/list', { cwds: [session.cwd], forceReload: false })
      emitSlash('/skills', codexListSummary('스킬', result))
      return { ok: true }
    }

    if (name === '/hooks') {
      const result = await codexRequest(session, 'hooks/list', { cwds: [session.cwd] })
      emitSlash('/hooks', codexListSummary('훅', result))
      return { ok: true }
    }

    if (name === '/apps') {
      const result = await codexRequest(session, 'app/list', {
        limit: 100,
        ...(session.codexThreadId ? { threadId: session.codexThreadId } : {})
      })
      emitSlash('/apps', codexListSummary('앱/커넥터', result))
      return { ok: true }
    }

    if (name === '/usage') {
      const result = await codexRequest(session, 'account/usage/read')
      emitSlash('/usage', safeJsonPreview(result, 2400))
      return { ok: true }
    }

    if (name === '/diff') {
      const result = await codexRequest(session, 'gitDiffToRemote', { cwd: session.cwd })
      const diff = stringValue(asRecord(result)?.diff) ?? safeJsonPreview(result, 3600)
      emitSlash('/diff', diff || '변경된 diff가 없습니다.')
      return { ok: true }
    }

    if (name === '/compact') {
      const threadId = await ensureCodexThread(session)
      await codexRequest(session, 'thread/compact/start', { threadId })
      emitSlash('/compact', 'Codex 컨텍스트 압축을 시작했습니다.')
      return { ok: true }
    }

    if (name === '/review') {
      const threadId = await ensureCodexThread(session)
      await codexRequest(session, 'review/start', {
        threadId,
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      })
      emitSlash('/review', '작업 트리 리뷰를 시작했습니다.')
      return { ok: true }
    }

    if (name === '/goal') {
      const threadId = await ensureCodexThread(session)
      const objective = argument.trim()
      if (!objective) {
        const result = await codexRequest(session, 'thread/goal/get', { threadId })
        emitSlash('/goal', safeJsonPreview(result, 2000))
        return { ok: true }
      }
      if (objective === 'clear') {
        await codexRequest(session, 'thread/goal/clear', { threadId })
        emitSlash('/goal', '목표를 지웠습니다.')
        return { ok: true }
      }
      await codexRequest(session, 'thread/goal/set', { threadId, objective })
      emitSlash('/goal', `목표를 설정했습니다.\n${objective}`)
      return { ok: true }
    }

    if (name === '/archive') {
      const threadId = await ensureCodexThread(session)
      await codexRequest(session, 'thread/archive', { threadId })
      emitSlash('/archive', '현재 Codex thread를 보관했습니다.')
      return { ok: true }
    }

    const tuiOnly = new Set([
      '/agent',
      '/approve',
      '/btw',
      '/copy',
      '/debug-config',
      '/delete',
      '/exit',
      '/experimental',
      '/fast',
      '/feedback',
      '/fork',
      '/ide',
      '/import',
      '/init',
      '/keymap',
      '/logout',
      '/memories',
      '/mention',
      '/personality',
      '/ps',
      '/quit',
      '/raw',
      '/resume',
      '/sandbox-add-read-dir',
      '/side',
      '/statusline',
      '/stop',
      '/theme',
      '/title',
      '/vim'
    ])
    if (tuiOnly.has(name)) {
      emitSlash(
        name,
        `${name}은 Codex TUI 전용 명령입니다. 패널에서는 터미널 탭으로 Codex를 열어 실행해 주세요.`,
        'error'
      )
      return { ok: true }
    }
    return { ok: false, error: `${name} 명령은 아직 지원하지 않습니다.` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runAgentSlashCommand(
  sessionId: string,
  command: string,
  argument?: string
): Promise<AgentCommandResult> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'Agent 세션을 찾을 수 없습니다.' }
  if (session.provider !== 'codex') return { ok: false, error: '패널 slash command 실행은 Codex Agent에서만 지원합니다.' }
  return runCodexSlashCommand(session, command, argument)
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
    pending.finish(pending.kind === 'codex-user-input' ? { answers: {} } : { behavior: 'cancelled' }, answer)
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
  if (session.authProcess) return { ok: false, error: '로그인 절차가 진행 중입니다.' }

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
      if (session.provider === 'codex') {
        await runCodexAgentMessage(session, prompt, abortController)
        return
      }
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
        const message = error instanceof Error ? error.message : String(error)
        if (session.provider === 'codex' && isAuthFailureOutput(message)) {
          emitAuthStatus(session, 'unauthenticated', message)
        }
        emit(session, {
          type: 'error',
          sessionId,
          message,
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
  if (session.authProcess) return { ok: false, error: '로그인 절차가 진행 중입니다.' }
  if (session.provider === 'codex') {
    if (session.authStatus === 'checking') return { ok: false, error: 'Codex 로그인 상태를 확인 중입니다.' }
    if (session.authStatus === 'unavailable') {
      return { ok: false, error: 'Codex CLI를 찾을 수 없습니다. Codex CLI를 설치한 뒤 다시 시도하세요.' }
    }
    if (session.authStatus === 'unauthenticated') {
      return { ok: false, error: 'Codex 로그인이 필요합니다. 로그인 버튼으로 인증을 먼저 진행하세요.' }
    }
  }
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
  if (session.provider !== 'claude') {
    return { ok: false, error: 'Codex Agent의 MCP 상태 확인은 아직 지원하지 않습니다.' }
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
      if (session.source === 'ssh') {
        const init = await readClaudeInitMessage(session, abortController)
        if (abortController.signal.aborted) return
        appendAssistantText(session, assistantMessageId, formatMcpStatus(mcpStatusesFromUnknown(init?.mcp_servers)))
        completeAssistant(session, assistantMessageId)
        emit(session, { type: 'status', sessionId, status: 'done' })
        emit(session, { type: 'status', sessionId, status: 'idle' })
        return
      }
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
    const result =
      pending.kind === 'codex-user-input'
        ? buildCodexDialogResult(dialog, answer)
        : buildQuestionDialogResult(dialog, answer)
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
  session.codexProcess?.kill()
  session.codexProcess = undefined
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
  session.codexProcess?.kill()
  session.codexProcess = undefined
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
  ipcMain.handle('agent:models', (_e, sessionId: string) => listAgentModels(sessionId))
  ipcMain.handle('agent:setModel', (_e, p: { sessionId: string; model?: string; reasoningEffort?: string }) =>
    setAgentModel(p.sessionId, p.model, p.reasoningEffort)
  )
  ipcMain.handle('agent:slashCommand', (_e, p: { sessionId: string; command: string; argument?: string }) =>
    runAgentSlashCommand(p.sessionId, p.command, p.argument)
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
