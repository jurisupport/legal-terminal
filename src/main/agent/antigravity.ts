import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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

// Headless mode cannot relay interactive approvals. Permit workspace reads and
// restrict operations which would otherwise require a decision in the panel.
const blockedActions = ['write_file', 'command', 'mcp', 'execute_url', 'read_url']
const streamArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']

async function chatSettings(): Promise<string> {
  const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  let settings
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Antigravity의 기존 권한 설정을 읽을 수 없습니다. CLI 설정 파일을 확인해 주세요.')
  }
  // Keep the user's stricter rules when the CLI replaces the global deny list.
  const otherRules = (rules: string[] = []): string[] =>
    rules.filter(rule => !blockedActions.includes(rule.split('(', 1)[0].trim()))
  const deny = [...otherRules(settings?.permissions?.deny), ...blockedActions.map(action => `${action}(*)`)]
  return JSON.stringify({
    allowNonWorkspaceAccess: false,
    toolPermission: settings?.toolPermission === 'strict' ? 'strict' : 'request-review',
    permissions: { deny, ask: otherRules(settings?.permissions?.ask) }
  })
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
try:
    try:
        settings = json.loads((Path.home() / '.gemini/antigravity-cli/settings.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        settings = {}
    blocked = ${JSON.stringify(blockedActions)}
    def other_rules(kind):
        rules = settings.get('permissions', {}).get(kind, [])
        if not isinstance(rules, list):
            raise ValueError()
        return [rule for rule in rules if rule.split('(', 1)[0].strip() not in blocked]
    policy = {'allowNonWorkspaceAccess': False,
              'toolPermission': 'strict' if settings.get('toolPermission') == 'strict' else 'request-review',
              'permissions': {'deny': other_rules('deny') + [action + '(*)' for action in blocked], 'ask': other_rules('ask')}}
except (OSError, ValueError, AttributeError, TypeError):
    sys.exit('SSH 서버에서 Antigravity 권한 설정을 읽을 수 없습니다. 서버의 CLI 설정 파일을 확인해 주세요.')
os.execv(binary, [str(binary), '--settings', json.dumps(policy)] + sys.argv[1:])
`

export function remoteAntigravityCommand(session: AgentExecutionIdentity & { cwd: string }): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  const args = session.resumeSessionId ? [...streamArgs, '--conversation', session.resumeSessionId] : streamArgs
  return `cd ${quote(session.cwd)} && exec ${agentExecutionCommand(session)} python3 -c ${quote(remoteLaunch)} ${args.map(quote).join(' ')}`
}

type AntigravityEvent = (message: Record<string, unknown>) => void

export async function runAntigravityTurn(
  session: AgentExecutionIdentity & { cwd: string },
  prompt: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onEvent: AntigravityEvent
): Promise<void> {
  const bin = antigravityExecutable()
  const args = [...streamArgs, '--settings', await chatSettings()]
  if (session.resumeSessionId) args.push('--conversation', session.resumeSessionId)
  if (signal.aborted) return
  const wrapped = process.platform !== 'win32'
  const proc = spawn(wrapped ? 'python3' : bin, wrapped ? [...agentExecutionArgs(session), bin, ...args] : args, {
    cwd: session.cwd, env, windowsHide: true
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
      failure = !remote && err.code === 'ENOENT'
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
        if (!completed) {
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
