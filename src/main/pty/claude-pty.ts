import * as pty from '@lydell/node-pty'
import type { WebContents } from 'electron'
import { execFile } from 'child_process'
import os from 'os'

interface Session {
  proc: pty.IPty
}

const sessions = new Map<string, Session>()

const defaultShell =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'

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

export interface CreatePtyOptions {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchClaude?: boolean
  resumeSessionId?: string // 주어지면 `claude --resume <id>`로 과거 세션 이어서 실행
}

export function createPty(opts: CreatePtyOptions, webContents: WebContents): void {
  const { id, cols, rows, autoLaunchClaude, resumeSessionId } = opts
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : os.homedir()

  // 기존 동일 id 세션 정리 (HMR/재마운트 안전)
  killPty(id)

  const proc = pty.spawn(defaultShell, [], {
    name: 'xterm-256color',
    cwd,
    cols: Math.max(cols, 2),
    rows: Math.max(rows, 1),
    env: cleanEnv()
  })
  sessions.set(id, { proc })

  proc.onData((data) => {
    if (!webContents.isDestroyed()) webContents.send('pty:data', { id, data })
  })
  proc.onExit(({ exitCode }) => {
    if (!webContents.isDestroyed()) webContents.send('pty:exit', { id, exitCode })
    sessions.delete(id)
  })

  if (resumeSessionId) {
    // 과거 세션 이어서 실행
    proc.write(`claude --resume ${resumeSessionId}\r`)
  } else if (autoLaunchClaude) {
    // 셸이 뜨면 곧바로 Claude Code CLI 실행 (VS Code 확장과 동일한 경험)
    proc.write('claude\r')
  }
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
