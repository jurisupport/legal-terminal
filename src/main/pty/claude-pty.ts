import * as pty from '@lydell/node-pty'
import type { WebContents } from 'electron'
import { execFile } from 'child_process'
import os from 'os'

interface Session {
  proc: pty.IPty
  viewers: Map<number, WebContents>
  buffer: string
}

const sessions = new Map<string, Session>()
const MAX_REPLAY_CHARS = 200_000

const defaultShell =
  process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
const defaultShellArgs = process.platform === 'darwin' ? ['-l'] : []

/**
 * pty에 넘길 깨끗한 환경을 만든다.
 * 이 앱이 Claude Code 세션 안에서 실행되면 CLAUDECODE / CLAUDE_CODE_SSE_PORT /
 * ENABLE_IDE_INTEGRATION 등 바깥 세션 마커가 상속되어, 터미널 안의 claude가
 * 바깥 세션의 IDE 통합에 붙으려다 비정상 종료한다. 이런 변수는 제거한다.
 * (M3에서 우리 앱의 IDE 통합 변수를 여기서 다시 주입할 예정)
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE') continue
    if (k.startsWith('CLAUDE_CODE_')) continue
    if (k === 'ENABLE_IDE_INTEGRATION') continue
    env[k] = v
  }
  return env
}

/** SSH 접속에 필요한 최소 정보 (settings의 SshProfile에서 추려 전달) */
export interface SshConn {
  host: string
  user: string
  port?: number
  identityFile?: string
  remoteControl?: boolean
}

export interface CreatePtyOptions {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchAgent?: 'claude' | 'codex'
  autoLaunchClaude?: boolean
  resumeSessionId?: string // 주어지면 `claude --resume <id>`로 과거 세션 이어서 실행
  ssh?: SshConn // 주어지면 로컬 셸 대신 ssh로 원격 접속 (cwd는 원격 경로)
}

const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'

// 원격 셸 명령에 안전하게 끼워넣기 위한 single-quote 이스케이프 (POSIX)
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function agentLaunchCommand(opts: CreatePtyOptions): string {
  const agent = opts.autoLaunchAgent ?? (opts.autoLaunchClaude ? 'claude' : undefined)
  const remoteControl = agent === 'claude' && opts.ssh?.remoteControl
  const name = opts.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || opts.id
  if (opts.resumeSessionId) {
    return `claude${remoteControl ? ` --remote-control ${shq(name)}` : ''} --resume ${shq(opts.resumeSessionId)}`
  }
  if (agent === 'claude' && remoteControl) return `claude --remote-control ${shq(name)}`
  return agent ?? ''
}

/**
 * ssh 인자 + 원격 시작 명령을 만든다.
 * 비밀번호/키 프롬프트는 터미널(xterm)에 그대로 표시되어 사용자가 응답한다.
 * 원격 명령은 인증 성공 후에만 실행되므로 stdin 주입과 달리 프롬프트와 충돌하지 않는다.
 */
function buildSshArgs(opts: CreatePtyOptions): string[] {
  const ssh = opts.ssh!
  const args = ['-tt'] // 원격 PTY 강제 할당 (대화형 claude/셸)
  if (ssh.port) args.push('-p', String(ssh.port))
  if (ssh.identityFile) args.push('-i', ssh.identityFile)
  // 끊김 방지 keepalive, 첫 접속 호스트키 자동 수락
  args.push('-o', 'ServerAliveInterval=30')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${ssh.user}@${ssh.host}`)

  // 원격 시작 명령 (inner): (cd 사건폴더 →) claude 실행 → 끝나면 로그인 셸 유지.
  // cd 실패 시에도(&&) claude는 건너뛰되 셸은 유지(;)되어 사용자가 상황을 본다.
  const launch = agentLaunchCommand(opts)
  let inner: string
  if (opts.cwd && opts.cwd.length > 0) {
    inner = launch ? `cd ${shq(opts.cwd)} && ${launch}; ` : `cd ${shq(opts.cwd)}; `
  } else {
    inner = launch ? `${launch}; ` : ''
  }
  inner += 'exec $SHELL -l' // claude 종료 후에도 원격 셸 유지 (로컬 동작과 동일)

  // 대화형 로그인 셸(-ilc)로 감싸 원격 PATH(claude 등)를 로드한 뒤 실행한다.
  // -i가 있어야 zsh/bash가 .zshrc/.bashrc(claude PATH가 흔히 여기 있음)를 읽는다.
  // ssh는 이 단일 인자를 원격 셸에 그대로 전달하므로 nested single-quote는 shq로 이중 이스케이프됨.
  // ($SHELL은 큰따옴표 없이 — Windows ConPTY 커맨드라인 인용을 단순화)
  args.push(`exec $SHELL -ilc ${shq(inner)}`)
  return args
}

export function createPty(opts: CreatePtyOptions, webContents: WebContents): void {
  const { id, cols, rows, ssh } = opts
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : os.homedir()

  const existing = sessions.get(id)
  if (existing) {
    attachPty(id, webContents)
    resizePty(id, cols, rows)
    return
  }

  let proc: pty.IPty
  try {
    proc = ssh
      ? pty.spawn(sshBin, buildSshArgs(opts), {
          name: 'xterm-256color',
          // 로컬 cwd는 ssh 실행에만 쓰임(원격 경로는 위 명령의 cd가 처리)
          cwd: os.homedir(),
          cols: Math.max(cols, 2),
          rows: Math.max(rows, 1),
          env: cleanEnv()
        })
      : pty.spawn(defaultShell, defaultShellArgs, {
          name: 'xterm-256color',
          cwd,
          cols: Math.max(cols, 2),
          rows: Math.max(rows, 1),
          env: cleanEnv()
        })
  } catch (e) {
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data: `\r\n\x1b[31m[터미널 시작 실패: ${String(e)}]\x1b[0m\r\n` })
      webContents.send('pty:exit', { id, exitCode: 1 })
    }
    return
  }
  const session: Session = { proc, viewers: new Map(), buffer: '' }
  sessions.set(id, session)
  attachPty(id, webContents)

  proc.onData((data) => {
    session.buffer = (session.buffer + data).slice(-MAX_REPLAY_CHARS)
    for (const [viewerId, viewer] of session.viewers) {
      if (viewer.isDestroyed()) {
        session.viewers.delete(viewerId)
        continue
      }
      viewer.send('pty:data', { id, data })
    }
  })
  proc.onExit(({ exitCode }) => {
    for (const [viewerId, viewer] of session.viewers) {
      if (viewer.isDestroyed()) {
        session.viewers.delete(viewerId)
        continue
      }
      viewer.send('pty:exit', { id, exitCode })
    }
    sessions.delete(id)
  })

  // ssh는 원격 시작 명령(buildSshArgs)으로 claude를 실행하므로 여기서 따로 주입하지 않는다.
  if (ssh) return

  const launch = agentLaunchCommand(opts)
  if (launch) proc.write(`${launch}\r`)
}

export function attachPty(id: string, webContents: WebContents): boolean {
  const session = sessions.get(id)
  if (!session || webContents.isDestroyed()) return false
  session.viewers.set(webContents.id, webContents)
  webContents.once('destroyed', () => detachPty(id, webContents))
  if (session.buffer) webContents.send('pty:data', { id, data: session.buffer })
  return true
}

export function detachPty(id: string, webContents: WebContents): void {
  sessions.get(id)?.viewers.delete(webContents.id)
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  try {
    sessions.get(id)?.proc.resize(cols, rows)
  } catch {
    /* 리사이즈 중 종료된 세션 무시 */
  }
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (s) {
    const pid = s.proc.pid
    try {
      s.proc.kill()
    } catch {
      /* 이미 종료됨 */
    }
    // Windows: 셸 종료가 자식(claude.exe 등)으로 전파되지 않으므로 트리 종료
    if (process.platform === 'win32' && pid) {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
        /* 이미 종료된 트리는 무시 */
      })
    }
    sessions.delete(id)
  }
}

export function killAllPty(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
