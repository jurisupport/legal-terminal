import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentExecutionArgs, type AgentExecutionIdentity } from './agentExecutionLock'

export const ANTIGRAVITY_LOGIN_MESSAGE = 'Antigravity 로그인이 필요합니다. 이 컴퓨터의 터미널에서 agy를 실행해 로그인한 뒤 다시 보내 주세요.'

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
async function chatSettings(): Promise<string> {
  const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  let settings
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Antigravity의 기존 권한 설정을 읽을 수 없습니다. CLI 설정 파일을 확인해 주세요.')
  }
  // Keep the user's stricter rules when the CLI replaces the global deny list.
  const blocked = ['write_file', 'command', 'mcp', 'execute_url', 'read_url']
  const otherRules = (rules: string[] = []): string[] =>
    rules.filter(rule => !blocked.includes(rule.split('(', 1)[0].trim()))
  const deny = [...otherRules(settings?.permissions?.deny), ...blocked.map(action => `${action}(*)`)]
  return JSON.stringify({
    allowNonWorkspaceAccess: false,
    toolPermission: settings?.toolPermission === 'strict' ? 'strict' : 'request-review',
    permissions: { deny, ask: otherRules(settings?.permissions?.ask) }
  })
}

export async function runAntigravityTurn(
  session: AgentExecutionIdentity & { cwd: string },
  prompt: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onEvent: (message: Record<string, unknown>) => void
): Promise<void> {
  const bin = antigravityExecutable()
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--disable-slash-commands', '--settings', await chatSettings()]
  if (session.resumeSessionId) args.push('--conversation', session.resumeSessionId)
  const wrapped = process.platform !== 'win32'
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const proc = spawn(wrapped ? 'python3' : bin, wrapped ? [...agentExecutionArgs(session), bin, ...args] : args, {
      cwd: session.cwd, env, windowsHide: true
    })
    let failure: string | undefined
    let stderr = ''
    let completed = false
    const abort = (): void => { proc.kill() }
    signal.addEventListener('abort', abort, { once: true })
    const checkLogin = (text: string): boolean => {
      if (!/Authentication required|accounts\.google\.com\/o\/oauth2|paste the authorization code/i.test(text)) return false
      failure = ANTIGRAVITY_LOGIN_MESSAGE
      abort()
      return true
    }
    proc.once('error', (err: NodeJS.ErrnoException) => {
      failure = err.code === 'ENOENT'
        ? wrapped ? 'Antigravity 실행에 필요한 Python 3 또는 작업 폴더를 찾을 수 없습니다.' : 'Antigravity CLI 또는 작업 폴더를 찾을 수 없습니다.'
        : err.message
    })
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
      checkLogin(stderr)
    })
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') { failure ??= err.message; abort() }
    })
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
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
    })
    proc.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      lines.close()
      if (signal.aborted) return resolve()
      if (!failure && /No such file or directory.*agy|spawn agy(?:\.exe)? ENOENT/i.test(stderr)) {
        failure = 'Antigravity CLI를 찾을 수 없습니다. 이 컴퓨터에 agy를 설치한 뒤 다시 보내 주세요.'
      }
      if (code !== 0 || !completed || failure) {
        reject(new Error(failure || stderr.trim() || `Antigravity가 응답을 완료하지 못했습니다 (종료 코드 ${code}).`))
      } else resolve()
    })
    proc.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n')
  })
}
