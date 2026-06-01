import { spawn, execFile } from 'child_process'
import type { WebContents } from 'electron'
import type { SshProfile } from './settings'

// 클라우드 경유 모델: 맥미니에서(SSH로) rclone을 실행해 맥 사건폴더 ↔ OneDrive 클라우드 동기화.
// Windows에는 rclone 불필요. 맥에 rclone + onedrive 리모트(rclone config)가 있어야 한다.
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function shellPathArg(path: string): string {
  const target = path.trim()
  if (!target || target === '~' || target === '$HOME') return '"$HOME"'
  if (target.startsWith('~/')) return `"$HOME"/${shq(target.slice(2))}`
  if (target.startsWith('$HOME/')) return `"$HOME"/${shq(target.slice(6))}`
  return shq(target)
}

// BatchMode(키/agent 인증) ssh 인자 — 비대화식 원격 명령 실행용
function sshBaseArgs(profile: SshProfile): string[] {
  const a: string[] = []
  if (profile.port) a.push('-p', String(profile.port))
  if (profile.identityFile) a.push('-i', profile.identityFile)
  a.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new')
  a.push(`${profile.user}@${profile.host}`)
  return a
}

// 맥의 rclone 설치 여부 + 설정된 리모트 목록(rclone listremotes). 키/agent 인증 시에만 성공.
export function remoteRcloneInfo(
  profile: SshProfile
): Promise<{ installed: boolean; remotes: string[]; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(profile), 'rclone listremotes'],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ installed: false, remotes: [], error: (stderr || err.message || '').trim() })
          return
        }
        const remotes = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean) // 예: "onedrive:"
        resolve({ installed: true, remotes })
      }
    )
  })
}

export interface RemoteSyncOpts {
  profile: SshProfile
  direction: 'pull' | 'push' // pull: 클라우드→맥, push: 맥→클라우드
  macFolder: string // 맥의 사건 폴더 (예: /Users/me/OneDrive/진행중사건/강상우)
  dest: string // rclone 클라우드 대상 (예: onedrive:진행중사건/강상우)
}

let active: ReturnType<typeof spawn> | null = null

// 맥에서 rclone copy --update 실행 (삭제 전파 안 함). 진행 로그를 'sync:progress'로 스트리밍.
export function runRemoteSync(
  opts: RemoteSyncOpts,
  wc: WebContents
): Promise<{ ok: boolean; code: number | null; error?: string }> {
  const cloudArg = shq(opts.dest)
  const macArg = shellPathArg(opts.macFolder)
  const src = opts.direction === 'pull' ? cloudArg : macArg
  const dst = opts.direction === 'pull' ? macArg : cloudArg
  const rcloneCmd =
    `rclone copy ${src} ${dst} --update --create-empty-src-dirs --transfers=4 --checkers=8 ` +
    `-v --stats-one-line --stats=1s`
  const args = [...sshBaseArgs(opts.profile), rcloneCmd]

  const send = (line: string): void => {
    if (!wc.isDestroyed()) wc.send('sync:progress', line)
  }
  send(`$ (맥미니에서) rclone ${opts.direction === 'pull' ? '내리기 ⬇' : '올리기 ⬆'}`)
  send(`  ${opts.direction === 'pull' ? opts.dest : opts.macFolder}`)
  send(`  → ${opts.direction === 'pull' ? opts.macFolder : opts.dest}`)

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(sshBin, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, code: null, error: String(e) })
      return
    }
    active = proc
    let tail = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      tail = (tail + text).slice(-2000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) send(line)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => {
      active = null
      resolve({ ok: false, code: null, error: String(e) })
    })
    proc.on('close', (code) => {
      active = null
      send(code === 0 ? '✓ 완료' : `✗ 종료 코드 ${code}`)
      resolve({ ok: code === 0, code, error: code === 0 ? undefined : tail })
    })
  })
}

export function cancelSync(): void {
  if (active) {
    active.kill()
    active = null
  }
}
