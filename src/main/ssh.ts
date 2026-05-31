import { execFile } from 'child_process'
import type { SshProfile } from './settings'

const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// 원격 경로 join (원격은 POSIX 경로)
function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
}

/**
 * 원격 디렉터리 목록 — 사건 폴더 선택용.
 * BatchMode=yes 로 비대화식 실행하므로 키/ssh-agent 인증일 때만 성공한다.
 * (비밀번호 인증은 여기서 응답할 수 없어 실패 → UI는 경로 직접 입력으로 폴백)
 */
export function listRemoteDir(
  profile: SshProfile,
  remotePath: string
): Promise<{ ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }> {
  const args: string[] = []
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${profile.user}@${profile.host}`)
  // 디렉터리만 슬래시(-p), 숨김 제외 위해 -A 대신 일반 ls, 한 줄 하나(-1)
  // 경로 미지정/빈값이면 홈(~)을 사용
  const target = remotePath && remotePath.trim() ? remotePath : '~'
  args.push(`cd ${shq(target)} && pwd && ls -1p`)

  return new Promise((resolve) => {
    execFile(sshBin, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || '연결 실패').trim() })
        return
      }
      const lines = stdout.split('\n')
      // 첫 줄 = pwd(절대경로), 나머지 = 목록
      const cwd = (lines.shift() ?? target).trim()
      const entries: RemoteEntry[] = []
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line) continue
        const isDir = line.endsWith('/')
        const name = isDir ? line.slice(0, -1) : line
        if (!name || name.startsWith('.')) continue
        entries.push({ name, path: joinRemote(cwd, name), isDir })
      }
      entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
      )
      resolve({ ok: true, entries, cwd })
    })
  })
}
