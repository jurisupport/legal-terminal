import { execFile } from 'child_process'
import type { SshProfile } from './settings'

const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function cdTarget(path: string): string {
  const target = path.trim()
  if (!target || target === '~' || target === '$HOME') return '"$HOME"'
  if (target.startsWith('~/')) return `"$HOME"/${shq(target.slice(2))}`
  if (target.startsWith('$HOME/')) return `"$HOME"/${shq(target.slice(6))}`
  return shq(target)
}

// 원격 경로 join (원격은 POSIX 경로)
function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export interface SearchRemoteDirsOptions {
  query: string
  maxDepth?: number
  limit?: number
}

function sshArgs(profile: SshProfile, connectTimeout = 12): string[] {
  const args: string[] = []
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  args.push('-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`)
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${profile.user}@${profile.host}`)
  return args
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
  const args = sshArgs(profile)
  // 숨김 제외, 한 줄 하나. test -d를 써서 루트의 symlink 디렉터리도 탐색 가능하게 보인다.
  // 경로 미지정/빈값이면 홈(~)을 사용
  const target = remotePath && remotePath.trim() ? remotePath : '~'
  const listDirs = `
for p do
  [ -d "$p" ] || continue
  name=\${p#./}
  [ -n "$name" ] || continue
  case "$name" in .*) continue ;; esac
  m=$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo 0)
  printf '%s\t%s\n' "$m" "$name"
done
`.trim()
  args.push(`cd ${cdTarget(target)} && pwd && find . ! -name . -prune -exec sh -c ${shq(listDirs)} sh {} +`)

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
        const tab = line.indexOf('\t')
        const mtimeSec = tab >= 0 ? Number(line.slice(0, tab)) : 0
        const name = tab >= 0 ? line.slice(tab + 1) : line
        if (!name || name.startsWith('.')) continue
        entries.push({
          name,
          path: joinRemote(cwd, name),
          isDir: true,
          mtimeMs: Number.isFinite(mtimeSec) ? mtimeSec * 1000 : undefined
        })
      }
      entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
      )
      resolve({ ok: true, entries, cwd })
    })
  })
}

/**
 * 원격 하위 폴더 검색 — 폴더 선택 UI용.
 * 렌더러에서 폴더마다 ssh.listDir를 반복하면 SSH 왕복 때문에 큰 트리에서 멈춘 것처럼 보이므로,
 * 원격 find 한 번으로 검색하고 제한 시간 내 결과/오류를 반환한다.
 */
export function searchRemoteDirs(
  profile: SshProfile,
  remotePath: string,
  opts: SearchRemoteDirsOptions
): Promise<
  { ok: true; entries: RemoteEntry[]; cwd: string; truncated?: boolean } | { ok: false; error: string }
> {
  const query = opts.query.trim()
  if (!query) return Promise.resolve({ ok: true, entries: [], cwd: remotePath.trim() || '~' })

  const maxDepth = Math.min(8, Math.max(1, Math.trunc(opts.maxDepth ?? 5)))
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 150)))
  const shellLimit = limit + 1
  const args = sshArgs(profile, 20)
  const target = remotePath && remotePath.trim() ? remotePath : '~'
  const searchDirs = `
q=$1
limit=$2
count=0
while IFS= read -r p; do
  [ -d "$p" ] || continue
  rel=\${p#./}
  [ -n "$rel" ] || continue
  name=\${rel##*/}
  [ -n "$name" ] || continue
  case "$name" in .*) continue ;; esac
  if printf '%s\\n%s\\n' "$name" "$rel" | grep -iF -- "$q" >/dev/null 2>&1; then
    m=$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo 0)
    printf '%s\\t%s\\n' "$m" "$rel"
    count=$((count + 1))
    [ "$count" -ge "$limit" ] && break
  fi
done
`.trim()
  args.push(
    [
      `cd ${cdTarget(target)} && pwd &&`,
      `find . -maxdepth ${maxDepth} \\( -name '.*' -a ! -name . \\) -prune -o`,
      `-type d ! -name . -print 2>/dev/null | sh -c ${shq(searchDirs)} sh ${shq(query)} ${shellLimit}`
    ].join(' ')
  )

  return new Promise((resolve) => {
    execFile(
      sshBin,
      args,
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: (stderr || err.message || '검색 실패').trim() })
          return
        }
        const lines = stdout.split('\n')
        const cwd = (lines.shift() ?? target).trim()
        const entries: RemoteEntry[] = []
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '')
          if (!line) continue
          const tab = line.indexOf('\t')
          const mtimeSec = tab >= 0 ? Number(line.slice(0, tab)) : 0
          const rel = tab >= 0 ? line.slice(tab + 1) : line
          if (!rel || rel.startsWith('.')) continue
          const path = joinRemote(cwd, rel)
          const name = rel.split('/').filter(Boolean).pop()
          if (!name || name.startsWith('.')) continue
          entries.push({
            name,
            path,
            isDir: true,
            mtimeMs: Number.isFinite(mtimeSec) ? mtimeSec * 1000 : undefined
          })
          if (entries.length > limit) break
        }
        entries.sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
        )
        resolve({
          ok: true,
          entries: entries.slice(0, limit),
          cwd,
          truncated: entries.length > limit
        })
      }
    )
  })
}
