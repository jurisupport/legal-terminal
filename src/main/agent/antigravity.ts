import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentPermissionMode } from './agent-types'
import type { RemoteAgentTransport } from './remoteAgentTransport'
import { agentExecutionArgs, agentExecutionCommand, type AgentExecutionIdentity } from './agentExecutionLock'

export const ANTIGRAVITY_LOGIN_MESSAGE = 'Antigravity 로그인이 필요합니다. 이 컴퓨터의 터미널에서 agy를 실행해 로그인한 뒤 다시 보내 주세요.'

export const ANTIGRAVITY_REMOTE_LOGIN_MESSAGE = 'Antigravity 로그인이 필요합니다. SSH 서버의 터미널에서 agy를 실행해 로그인한 뒤 다시 보내 주세요.'

export function antigravityExecutable(): string {
  const windows = process.platform === 'win32'
  const name = windows ? 'agy.exe' : 'agy'
  const installed = windows
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', name)
    : join(homedir(), '.local', 'bin', name)
  return existsSync(installed) ? installed : name
}

type AntigravitySession = AgentExecutionIdentity & {
  cwd: string
  permissionMode?: AgentPermissionMode
  model?: string
}

function turnArgs(session: AntigravitySession): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']
  if (session.permissionMode === 'acceptEdits') args.push('--mode', 'accept-edits', '--sandbox')
  if (session.model) args.push('--model', session.model)
  if (session.resumeSessionId) args.push('--conversation', session.resumeSessionId)
  return args
}

function panelSettings(session: AntigravitySession) {
  const editable = session.permissionMode === 'acceptEdits'
  const deny = ['mcp(*)', 'execute_url(*)', 'read_url(*)']
  if (editable) deny.push('unsandboxed(*)')
  else deny.push('write_file(*)', 'command(*)')
  return {
    allowNonWorkspaceAccess: false,
    toolPermission: editable ? 'proceed-in-sandbox' : 'request-review',
    permissions: { allow: [] as string[], ask: [] as string[], deny }
  }
}

async function chatSettings(session: AntigravitySession, cwd: string): Promise<string> {
  const policy = panelSettings(session)
  if (session.permissionMode === 'acceptEdits') {
    if (cwd === parse(cwd).root || /[\r\n\x00]/.test(cwd)) throw new Error('Antigravity 편집에는 별도의 작업 폴더가 필요합니다.')
    // The CLI sandbox rejects literal glob characters in mount paths; native file tools can still edit.
    const nativeFilesOnly = /[*?\[\]]/.test(cwd)
    policy.permissions.allow.push(`write_file(${nativeFilesOnly ? './' : cwd})`)
    if (nativeFilesOnly) policy.permissions.deny.push('command(*)')
  }
  const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (settings.toolPermission === 'strict' || settings.toolPermission === 'request-review') {
      policy.toolPermission = settings.toolPermission
      if (settings.toolPermission === 'strict' && session.permissionMode === 'acceptEdits') {
        policy.permissions.allow = []
        policy.permissions.deny.push('write_file(*)', 'command(*)')
      }
    }
    for (const key of ['ask', 'deny'] as const) {
      const rules = settings.permissions?.[key] ?? []
      if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string')) throw new Error('Invalid permission rules')
      policy.permissions[key].push(...rules)
    }
    // Headless edits cannot show the CLI's approval prompt.
    if (session.permissionMode === 'acceptEdits') policy.permissions.deny.push(...policy.permissions.ask)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Antigravity의 기존 권한 설정을 읽을 수 없습니다. CLI 설정 파일을 확인해 주세요.')
  }
  return JSON.stringify(policy)
}

// Read and apply the server's permission policy on the execution host.
const remoteLaunch = String.raw`
import json, os, shutil, sys
from pathlib import Path
binary = Path.home() / '.local/bin/agy'
if not os.access(binary, os.X_OK):
    binary = shutil.which('agy')
if not binary:
    sys.exit('SSH 서버에서 Antigravity CLI를 찾을 수 없습니다. 서버에 agy를 설치한 뒤 다시 보내 주세요.')
policy = json.loads(sys.argv[1])
cwd = os.getcwd()
editable = policy['toolPermission'] == 'proceed-in-sandbox'
if editable:
    if cwd == '/' or any(character in cwd for character in ('\r', '\n', '\0')):
        sys.exit('Antigravity 편집에는 별도의 작업 폴더가 필요합니다.')
    native_files_only = any(character in cwd for character in '*?[]')
    policy['permissions']['allow'].append('write_file(' + ('./' if native_files_only else cwd) + ')')
    if native_files_only: policy['permissions']['deny'].append('command(*)')
try:
    settings = json.loads((Path.home() / '.gemini/antigravity-cli/settings.json').read_text(encoding='utf-8'))
    if settings.get('toolPermission') in ('strict', 'request-review'):
        policy['toolPermission'] = settings['toolPermission']
        if settings['toolPermission'] == 'strict' and editable:
            policy['permissions']['allow'] = []
            policy['permissions']['deny'].extend(['write_file(*)', 'command(*)'])
    for key in ('ask', 'deny'):
        rules = settings.get('permissions', {}).get(key, [])
        if not isinstance(rules, list) or not all(isinstance(rule, str) for rule in rules):
            raise ValueError()
        policy['permissions'][key].extend(rules)
    if editable:
        policy['permissions']['deny'].extend(policy['permissions']['ask'])
except FileNotFoundError:
    pass
except (OSError, ValueError, AttributeError, TypeError):
    sys.exit('SSH 서버에서 Antigravity 권한 설정을 읽을 수 없습니다. 서버의 CLI 설정 파일을 확인해 주세요.')
os.environ['PWD'] = cwd
os.execv(binary, [str(binary), '--settings', json.dumps(policy)] + sys.argv[2:])
`

export function remoteAntigravityCommand(session: AntigravitySession): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  const args = [JSON.stringify(panelSettings(session)), ...turnArgs(session)]
  return `cd ${quote(session.cwd)} && exec ${agentExecutionCommand(session)} python3 -c ${quote(remoteLaunch)} ${args.map(quote).join(' ')}`
}

type AntigravityEvent = (message: Record<string, unknown>) => void

export async function runAntigravityTurn(
  session: AntigravitySession,
  prompt: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onEvent: AntigravityEvent
): Promise<void> {
  const bin = antigravityExecutable()
  const cwd = await realpath(session.cwd)
  const args = [...turnArgs(session), '--settings', await chatSettings(session, cwd)]
  if (signal.aborted) return
  const wrapped = process.platform !== 'win32'
  const proc = spawn(wrapped ? 'python3' : bin, wrapped ? [...agentExecutionArgs(session), bin, ...args] : args, {
    cwd, env: { ...env, PWD: cwd }, windowsHide: true
  })
  return readTurn(proc, prompt, signal, onEvent)
}

export function runRemoteAntigravityTurn(
  proc: RemoteAgentTransport,
  prompt: string | undefined,
  signal: AbortSignal,
  onEvent: AntigravityEvent
): Promise<void> {
  return readTurn(proc, prompt, signal, onEvent)
}

function readTurn(
  proc: ChildProcessWithoutNullStreams | RemoteAgentTransport,
  prompt: string | undefined,
  signal: AbortSignal,
  onEvent: AntigravityEvent
): Promise<void> {
  const remote = 'ready' in proc
  return new Promise((resolve, reject) => {
    let failure: string | undefined
    let stderr = ''
    let completed = false
    const abort = (): void => { proc.kill() }
    signal.addEventListener('abort', abort, { once: true })
    const checkLogin = (text: string): boolean => {
      if (!/Authentication required|accounts\.google\.com\/o\/oauth2|paste the authorization code/i.test(text)) return false
      failure = remote ? ANTIGRAVITY_REMOTE_LOGIN_MESSAGE : ANTIGRAVITY_LOGIN_MESSAGE
      abort()
      return true
    }
    proc.once('error', (err: NodeJS.ErrnoException) => {
      failure ??= !remote && err.code === 'ENOENT'
        ? process.platform !== 'win32' ? 'Antigravity 실행에 필요한 Python 3 또는 작업 폴더를 찾을 수 없습니다.' : 'Antigravity CLI 또는 작업 폴더를 찾을 수 없습니다.'
        : err.message
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
      checkLogin(stderr)
    })
    if (!remote) proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') { failure ??= err.message; abort() }
    })
    const readLine = (line: string): void => {
      if (signal.aborted || failure || !line.trim()) return
      let event
      try { event = JSON.parse(line) } catch {
        checkLogin(line)
        return
      }
      if (!event || typeof event !== 'object') return
      if (event.event === 'result') {
        completed = event.result?.status === 'SUCCESS'
        const hasAnswer = typeof event.result?.response === 'string' && event.result.response.trim()
        if (completed && !hasAnswer && Array.isArray(event.result.denied_actions) && event.result.denied_actions.length) {
          failure = 'Antigravity가 작업에 필요한 권한을 받지 못했습니다. 파일 저장은 작업 폴더 편집 모드를 선택하고, 같은 문제가 계속되면 실행 중인 컴퓨터의 CLI 권한 설정을 확인해 주세요.'
        } else if (!completed) {
          const error = typeof event.result?.error === 'string' ? event.result.error : ''
          if (!checkLogin(error)) failure = error || `Antigravity 응답이 중단되었습니다 (${event.result?.status ?? 'unknown'}).`
        }
      }
      onEvent(event)
    }
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = (buffer + decoder.write(chunk)).split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(readLine)
    })
    if (remote) proc.once('detached', () => {
      if (proc.exitCode !== null) return
      signal.removeEventListener('abort', abort)
      resolve()
    })
    proc.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      readLine(buffer + decoder.end())
      if (signal.aborted) return resolve()
      if (!remote && !failure && /No such file or directory.*agy|spawn agy(?:\.exe)? ENOENT/i.test(stderr)) {
        failure = 'Antigravity CLI를 찾을 수 없습니다. 이 컴퓨터에 agy를 설치한 뒤 다시 보내 주세요.'
      }
      if (code !== 0 || !completed || failure) {
        reject(new Error(failure || stderr.trim() || `Antigravity가 응답을 완료하지 못했습니다 (종료 코드 ${code}).`))
      } else resolve()
    })
    if (signal.aborted) return abort()
    if (prompt !== undefined) {
      proc.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n')
      proc.stdin.end()
    } else if (remote) {
      // A disconnected client may have delivered the prompt but not its EOF.
      proc.once('ready', info => { if (info.running && info.hasTurnInput) proc.stdin.end() })
    }
  })
}
