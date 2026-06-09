import { execFile } from 'child_process'
import type { SshProfile } from './settings'
import {
  invalidateRemoteDirListCache,
  readRemoteDirListCache,
  rememberRemoteDirListCache
} from './remoteDirListCache'

const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const CLOUD_DIR_LIST_TIMEOUT_MS = 15_000
const CLOUD_DIR_MERGE_TIMEOUT_MS = 2_500
const REMOTE_DIR_CACHE_TTL_MS = 10 * 60_000
const REMOTE_DIR_CACHE_MAX = 500
const REMOTE_DIR_DISK_CACHE_NAMESPACE = 'ssh-picker'

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

function oneDriveCloudPath(path: string): string | undefined {
  const marker = '/OneDrive/'
  const idx = path.indexOf(marker)
  if (idx >= 0) return 'onedrive:' + path.slice(idx + marker.length).normalize('NFC')
  const cloudStorage = path.match(/\/Library\/CloudStorage\/OneDrive[^/]*\/(.+)$/)
  return cloudStorage ? 'onedrive:' + cloudStorage[1].normalize('NFC') : undefined
}

function remoteRcloneBootstrap(): string {
  return [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    'rclone_bin=$(command -v rclone 2>/dev/null || true)',
    'if [ -z "$rclone_bin" ]; then',
    '  for p in /opt/homebrew/bin/rclone /usr/local/bin/rclone /opt/local/bin/rclone; do',
    '    [ -x "$p" ] && rclone_bin="$p" && break',
    '  done',
    'fi',
    'if [ -z "$rclone_bin" ]; then',
    '  echo "rclone not found on remote Mac" >&2',
    '  exit 127',
    'fi'
  ].join('\n')
}

// 원격 경로 join (원격은 POSIX 경로)
function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function searchTextKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR')
}

function remoteSearchQueryVariants(query: string): string[] {
  const variants = new Set<string>()
  for (const value of [query, query.normalize('NFKC')]) {
    variants.add(value.normalize('NFC'))
    variants.add(value.normalize('NFD'))
  }
  return [...variants].filter(Boolean)
}

function remoteDirMatchesQuery(rel: string, name: string, query: string): boolean {
  const needle = searchTextKey(query)
  if (!needle) return false
  return searchTextKey(name).includes(needle) || searchTextKey(rel).includes(needle)
}

function mergeRemoteEntries(localEntries: RemoteEntry[], cloudEntries: RemoteEntry[]): RemoteEntry[] {
  const byName = new Map<string, RemoteEntry>()
  for (const entry of cloudEntries) byName.set(entry.name.normalize('NFC'), entry)
  for (const entry of localEntries) byName.set(entry.name.normalize('NFC'), entry)
  return [...byName.values()].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
  )
}

function listCloudRemoteDirs(
  profile: SshProfile,
  cwd: string,
  timeoutMs = CLOUD_DIR_LIST_TIMEOUT_MS
): Promise<RemoteEntry[]> {
  const cloud = oneDriveCloudPath(cwd)
  if (!cloud) return Promise.resolve([])
  const args = sshArgs(profile, 20)
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloud)}`,
    '"$rclone_bin" lsf "$cloud" --dirs-only --max-depth 1 --format p --retries=1 --low-level-retries=1'
  ].join('\n')
  args.push(script)

  return new Promise((resolve, reject) => {
    execFile(
      sshBin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'rclone 목록 실패').trim()))
          return
        }
        const entries = stdout
          .split(/\r?\n/)
          .flatMap((raw): RemoteEntry[] => {
            if (!raw) return []
            const rel = raw.replace(/\/+$/, '')
            const name = rel.split('/').filter(Boolean).pop()
            if (!name || name.startsWith('.')) return []
            return [{ name, path: joinRemote(cwd, rel), isDir: true }]
          })
        resolve(entries)
      }
    )
  })
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export interface ListRemoteDirOptions {
  refresh?: boolean
}

export interface SearchRemoteDirsOptions {
  query: string
  maxDepth?: number
  limit?: number
}

interface RemoteDirCacheEntry {
  cwd: string
  entries: RemoteEntry[]
  ts: number
}

const remoteDirCache = new Map<string, RemoteDirCacheEntry>()
const remoteDirInflight = new Map<
  string,
  Promise<{ ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }>
>()

function normalizeRemoteDirPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed || '~'
}

function profileCachePrefix(profileId: string): string {
  return `${profileId}\0`
}

function profileCacheKey(profile: SshProfile): string {
  return [
    profile.id,
    profile.user,
    profile.host,
    String(profile.port ?? 22),
    profile.identityFile ?? ''
  ].join('\0')
}

function remoteDirCacheKey(profile: SshProfile, path: string): string {
  return `${profileCacheKey(profile)}\0${normalizeRemoteDirPath(path)}`
}

function cloneEntries(entries: RemoteEntry[]): RemoteEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function cloneListResult(
  result: { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }
): { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string } {
  return result.ok ? { ok: true, cwd: result.cwd, entries: cloneEntries(result.entries) } : result
}

function rememberRemoteDir(profile: SshProfile, path: string, cwd: string, entries: RemoteEntry[]): void {
  const cache: RemoteDirCacheEntry = { cwd, entries: cloneEntries(entries), ts: Date.now() }
  for (const key of [remoteDirCacheKey(profile, path), remoteDirCacheKey(profile, cwd)]) {
    if (remoteDirCache.has(key)) remoteDirCache.delete(key)
    remoteDirCache.set(key, cache)
    rememberRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, key, cache)
  }
  while (remoteDirCache.size > REMOTE_DIR_CACHE_MAX) {
    const oldest = remoteDirCache.keys().next().value
    if (!oldest) break
    remoteDirCache.delete(oldest)
  }
}

function cachedRemoteDir(
  profile: SshProfile,
  path: string
): { ok: true; entries: RemoteEntry[]; cwd: string } | undefined {
  const key = remoteDirCacheKey(profile, path)
  const cached = remoteDirCache.get(key)
  if (!cached) return undefined
  if (Date.now() - cached.ts > REMOTE_DIR_CACHE_TTL_MS) {
    remoteDirCache.delete(key)
    return undefined
  }
  return { ok: true, cwd: cached.cwd, entries: cloneEntries(cached.entries) }
}

function cachePathMatches(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : base + '/')
}

export function invalidateRemoteDirCacheForProfile(profileId: string, remotePath?: string): void {
  const prefix = profileCachePrefix(profileId)
  const normalized = remotePath ? normalizeRemoteDirPath(remotePath) : undefined
  for (const key of [...remoteDirCache.keys()]) {
    if (!key.startsWith(prefix)) continue
    const keyPath = key.slice(key.lastIndexOf('\0') + 1)
    const cachedCwd = remoteDirCache.get(key)?.cwd
    const cwdMatches = cachedCwd ? cachePathMatches(normalizeRemoteDirPath(cachedCwd), normalized ?? '') : false
    if (normalized && !cachePathMatches(keyPath, normalized) && !cwdMatches) continue
    remoteDirCache.delete(key)
  }
  for (const key of [...remoteDirInflight.keys()]) {
    if (!key.startsWith(prefix)) continue
    const keyPath = key.slice(key.lastIndexOf('\0') + 1)
    if (normalized && !cachePathMatches(keyPath, normalized)) continue
    remoteDirInflight.delete(key)
  }
  invalidateRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, (key, record) => {
    if (!key.startsWith(prefix)) return false
    if (!normalized) return true
    const keyPath = key.slice(key.lastIndexOf('\0') + 1)
    const cwdMatches = record.cwd ? cachePathMatches(normalizeRemoteDirPath(record.cwd), normalized) : false
    return cachePathMatches(keyPath, normalized) || cwdMatches
  })
}

export function clearRemoteDirCache(): void {
  remoteDirCache.clear()
  remoteDirInflight.clear()
  invalidateRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, () => true)
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

function readRemoteDir(
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
    execFile(sshBin, args, { timeout: 15000, windowsHide: true }, async (err, stdout, stderr) => {
      if (err) {
        const cloud = oneDriveCloudPath(target)
        if (cloud) {
          try {
            resolve({ ok: true, entries: await listCloudRemoteDirs(profile, target), cwd: target })
            return
          } catch {
            /* fall through to the original SSH error */
          }
        }
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
      try {
        resolve({
          ok: true,
          entries: mergeRemoteEntries(
            entries,
            await listCloudRemoteDirs(
              profile,
              cwd,
              entries.length > 0 ? CLOUD_DIR_MERGE_TIMEOUT_MS : CLOUD_DIR_LIST_TIMEOUT_MS
            )
          ),
          cwd
        })
      } catch {
        entries.sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
        )
        resolve({ ok: true, entries, cwd })
      }
    })
  })
}

/**
 * 원격 디렉터리 목록 — 사건 폴더 선택용.
 * BatchMode=yes 로 비대화식 실행하므로 키/ssh-agent 인증일 때만 성공한다.
 * (비밀번호 인증은 여기서 응답할 수 없어 실패 → UI는 경로 직접 입력으로 폴백)
 */
export function listRemoteDir(
  profile: SshProfile,
  remotePath: string,
  opts: ListRemoteDirOptions = {}
): Promise<{ ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }> {
  const key = remoteDirCacheKey(profile, remotePath)
  if (!opts.refresh) {
    const cached = cachedRemoteDir(profile, remotePath)
    if (cached) return Promise.resolve(cached)
    const inflight = remoteDirInflight.get(key)
    if (inflight) return inflight.then(cloneListResult)
  }

  const request = (async () => {
    if (!opts.refresh) {
      const diskCached = await readRemoteDirListCache<RemoteEntry>(REMOTE_DIR_DISK_CACHE_NAMESPACE, key)
      if (diskCached) {
        const cwd = diskCached.cwd ?? remotePath
        rememberRemoteDir(profile, remotePath, cwd, diskCached.entries)
        return { ok: true, cwd, entries: cloneEntries(diskCached.entries) } as const
      }
    }
    return await readRemoteDir(profile, remotePath)
  })().then((result) => {
    if (result.ok) rememberRemoteDir(profile, remotePath, result.cwd, result.entries)
    return result
  })
  remoteDirInflight.set(key, request)
  return request
    .then(cloneListResult)
    .finally(() => {
      if (remoteDirInflight.get(key) === request) remoteDirInflight.delete(key)
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
  const queryVariants = remoteSearchQueryVariants(query)
  const queryArgs = [...queryVariants, ...Array(Math.max(0, 4 - queryVariants.length)).fill('')].slice(0, 4)
  const searchDirs = `
q1=$1
q2=$2
q3=$3
q4=$4
limit=$5
count=0
matches_search() {
  text=$1
  for q in "$q1" "$q2" "$q3" "$q4"; do
    [ -n "$q" ] || continue
    if printf '%s\\n' "$text" | grep -iF -- "$q" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}
while IFS= read -r p; do
  [ -d "$p" ] || continue
  rel=\${p#./}
  [ -n "$rel" ] || continue
  name=\${rel##*/}
  [ -n "$name" ] || continue
  case "$name" in .*) continue ;; esac
  if matches_search "$name
$rel"; then
    m=$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo 0)
    printf '%s\\t%s\\n' "$m" "$rel"
    count=$((count + 1))
    [ "$count" -ge "$limit" ] && break
  fi
done
exit 0
	`.trim()
  args.push(
    [
      `cd ${cdTarget(target)} && pwd &&`,
      `find . -maxdepth ${maxDepth} \\( -name '.*' -a ! -name . \\) -prune -o`,
      `-type d ! -name . -print 2>/dev/null | sh -c ${shq(searchDirs)} sh ${queryArgs
        .map(shq)
        .join(' ')} ${shq(String(shellLimit))}`
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
          if (!remoteDirMatchesQuery(rel, name, query)) continue
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
