import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { Client, ClientChannel } from 'ssh2'
import { rfsBoardClaudeConnection } from '../remoteFs'
import { boardRemoteShell, quoteBoardShellWord } from './boardRemoteShell'

// The SDK sends the prompt, agent definition and in-process MCP traffic over stdin.
// Only the board's pinned SDK launch flags may cross to the remote shell.
export function boardClaudeCommand(cwd: string, args: readonly string[]): string {
  const required = new Map<string,string | null>([
    ['--output-format','stream-json'], ['--input-format','stream-json'], ['--verbose',null],
    ['--max-turns','40'], ['--permission-prompt-tool','stdio'], ['--tools',''],
    ['--setting-sources',''], ['--strict-mcp-config',null], ['--permission-mode','default'],
    ['--managed-settings',JSON.stringify({disableAllHooks:true})],
    ['--settings',JSON.stringify({disableAllHooks:true,disableSkillShellExecution:true,disableBundledSkills:true,autoMemoryEnabled:false})]
  ])
  const seen = new Set<string>()
  const flags: string[] = []
  if (!posix.isAbsolute(cwd) || posix.normalize(cwd) !== cwd || /[\x00-\x1f]/.test(cwd)) throw new Error('원격 보드의 전용 세션 경로가 잘못되었습니다.')
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const eq = arg.indexOf('=')
    const key = eq < 0 ? arg : arg.slice(0,eq)
    if (seen.has(key) || (!required.has(key) && key !== '--agent' && key !== '--resume')) throw new Error('지원하지 않는 원격 보드 SDK 실행 옵션입니다.')
    seen.add(key)
    const expected = required.get(key)
    if (expected === null) {
      if (eq !== -1) throw new Error('원격 보드의 실행 옵션 값이 잘못되었습니다.')
      flags.push(key)
      continue
    }
    const value = eq < 0 ? args[++index] : arg.slice(eq+1)
    if (value === undefined || (expected !== undefined && value !== expected) ||
        (key === '--agent' && !/^[\p{L}\d_][\p{L}\d_-]{0,99}$/u.test(value)) ||
        (key === '--resume' && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value))) {
      throw new Error('원격 보드의 실행 옵션을 안전하게 전달할 수 없습니다.')
    }
    flags.push(key + '=' + value)
  }
  if ([...required.keys()].some(key => !seen.has(key))) throw new Error('보드 세션의 필수 권한 설정이 누락되었습니다.')
  const script = [
    'umask 077',
    'PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin"; export PATH',
    'export CLAUDE_CODE_ENTRYPOINT=sdk-ts',
    'cd ' + quoteBoardShellWord(cwd) + ' || exit 126',
    'cli=$(command -v claude) || { echo "원격 서버에서 Claude CLI를 찾지 못했습니다." >&2; exit 127; }',
    'exec "$cli" ' + flags.map(quoteBoardShellWord).join(' ')
  ].join('; ')
  return boardRemoteShell(script)
}

class BoardSshProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  exitCode: number | null = null
  killed = false
  private channel?: ClientChannel
  private stop?: () => void

  constructor(client: Client, cwd: string, options: SpawnOptions, onFailure: (error: Error) => void) {
    super()
    const abort = () => this.kill('SIGTERM')
    const finish = (code: number) => {
      if (this.exitCode !== null) return
      this.exitCode = code
      clearTimeout(openTimer)
      this.channel?.unpipe(this.stdout)
      this.stop = undefined
      options.signal.removeEventListener('abort', abort)
      client.off('close', disconnected)
      this.stdin.destroy()
      this.stdout.end()
      this.emit('exit', code, null)
    }
    const fail = (error: Error) => {
      if (this.exitCode !== null) return
      onFailure(error)
      this.emit('error', error)
      finish(1)
    }
    const disconnected = () => fail(new Error('보드 수행 중 SSH 연결이 종료되었습니다.'))
    const openTimer = setTimeout(() => fail(new Error('SSH 서버가 보드 세션을 열지 못했습니다. 연결 상태를 확인하세요.')), 30000)
    openTimer.unref()
    this.stop = () => finish(1)
    // The SDK attaches its exit/error handlers after spawnClaudeCodeProcess returns.
    queueMicrotask(() => {
      try {
        if (options.signal.aborted || this.killed) { finish(1); return }
        const command = boardClaudeCommand(cwd, options.args)
        options.signal.addEventListener('abort', abort, {once:true})
        client.once('close', disconnected)
        client.exec(command, (err, channel) => {
          if (err) { fail(new Error('SSH 보드 세션을 열지 못했습니다: ' + err.message)); return }
          clearTimeout(openTimer)
          this.channel = channel
          channel.on('error', disconnected)
          if (this.killed || this.exitCode !== null) {
            try { channel.signal('TERM') } catch { /* already closed */ }
            channel.close()
            finish(1)
            return
          }
          let exit = 1
          let stderr = ''
          channel.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096) })
          channel.once('exit', (code: number | null) => { exit = code ?? 1 })
          channel.once('close', (code?: number) => {
            if ((code ?? exit) !== 0 && /not logged in|unauthorized|authentication (?:failed|required)|invalid .*api.?key|please run .*login/i.test(stderr)) {
              fail(new Error('SSH 서버에서 claude auth login 후 다시 시도하세요.'))
            } else if (code === 126 || exit === 126) fail(new Error('SSH 서버의 로그인 환경, Python 3 설치 및 전용 세션 폴더 권한을 확인하세요.'))
            else if (code === 127 || exit === 127) fail(new Error('원격 서버에 Claude CLI가 설치되어 있는지 확인하세요.'))
            else finish(typeof code === 'number' ? code : exit)
          })
          channel.pipe(this.stdout, {end:false})
          this.stdin.pipe(channel)
        })
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    if (this.channel) {
      try { this.channel.signal(signal.replace(/^SIG/, '')) } catch { /* channel already closed */ }
      this.channel.close()
    }
    this.stop?.()
    return true
  }
}

export async function prepareBoardRemoteClaude(uri: string, onFailure: (error: Error) => void): Promise<Pick<Options, 'spawnClaudeCodeProcess'>> {
  const { cwd, client } = await rfsBoardClaudeConnection(uri)
  return { spawnClaudeCodeProcess: options => new BoardSshProcess(client, cwd, options, onFailure) }
}
