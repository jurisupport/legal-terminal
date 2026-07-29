import { Client, type ClientChannel, type SFTPWrapper, utils } from 'ssh2'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, posix } from 'path'
import { getSettings, type SshProfile } from './settings'
import {
  invalidateRemoteDirListCache,
  readRemoteDirListCache,
  rememberRemoteDirListCache
} from './remoteDirListCache'
import {
  invalidateRemoteFileCache,
  readRemoteFileCache,
  rememberRemoteFileCache
} from './remoteFileCache'
import { SshConnectionPool, type SshConnection } from './sshConnectionPool'

// ── ssh:// URI 스킴 ──
// 형식: ssh://<profileId>/<원격절대경로>  (profileId는 UUID라 슬래시 없음)
// 예) ssh://abc-123/Users/me/cases/강상우  →  profileId=abc-123, path=/Users/me/cases/강상우
const SCHEME = 'ssh://'

export function isRemote(p: string | undefined): boolean {
  return !!p && p.startsWith(SCHEME)
}

export function parseRemote(uri: string): { profileId: string; path: string } {
  const rest = uri.slice(SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { profileId: rest, path: '/' }
  return { profileId: rest.slice(0, slash), path: rest.slice(slash) }
}

export function makeRemote(profileId: string, path: string): string {
  return SCHEME + profileId + (path.startsWith('/') ? path : '/' + path)
}

// ── 연결 풀 (profileId → SFTP) ──
const MAX_TOTAL_CONNECTIONS = 4
const connectionPool = new SshConnectionPool(connect, MAX_TOTAL_CONNECTIONS)

const winAgent = '\\\\.\\pipe\\openssh-ssh-agent'
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']
const SSH_READ_TIMEOUT_MS = 120_000
const SSH_QUICK_READ_TIMEOUT_MS = 8_000
const RCLONE_PROCESS_TIMEOUT = '60s'
const RCLONE_PROCESS_TIMEOUT_MS = 60_000
const RCLONE_IO_TIMEOUT = '30s'
const RCLONE_CONNECT_TIMEOUT = '10s'
const RCLONE_READ_TIMEOUT_MS = RCLONE_PROCESS_TIMEOUT_MS + 15_000
const RCLONE_LIST_TIMEOUT_MS = 15_000
const RCLONE_LIST_MERGE_TIMEOUT_MS = 2_500
const REMOTE_CLOUD_HYDRATE_TIMEOUT_MS = 10 * 60_000
const REMOTE_MATERIALIZE_TMP_ROOT = '/tmp/legal-terminal-rclone-materialize'
const REMOTE_LOCAL_MUTATION_WINDOW_MS = 30_000
const REMOTE_DIR_CACHE_TTL_MS = 10 * 60_000
const REMOTE_DIR_CACHE_MAX = 500
const REMOTE_DIR_DISK_CACHE_NAMESPACE = 'remote-fs'
const REMOTE_FILE_CACHE_NAMESPACE = 'remote-file'
const REMOTE_PREFETCH_CONCURRENCY = 4
const REMOTE_PREFETCH_COOLDOWN_MS = 10 * 60_000
const REMOTE_RCLONE_LIST_BACKOFF_MS = 30_000
const remotePrefetching = new Set<string>()
const remotePrefetchedAt = new Map<string, number>()
const remotePrefetchQueue: RemotePrefetchJob[] = []
const remoteOneDriveListInflight = new Map<string, Promise<Entry[]>>()
const remoteOneDriveListBackoffUntil = new Map<string, number>()
const remoteLocalMutatedAt = new Map<string, number>()
let remotePrefetchActive = 0

interface RemoteExecResult {
  stdout: Buffer
  stderr: Buffer
  code: number | null
  signal?: string
}

interface RemoteExecOptions {
  timeoutMs: number
  timeoutMessage: string
  onStdout?: (chunk: Buffer) => void
}

interface RemotePrefetchJob {
  key: string
  profileId: string
  cloudPath: string
  targetPath: string
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function isLikelyOneDrivePath(path: string): boolean {
  return path.includes('/OneDrive/') || path.includes('/Library/CloudStorage/OneDrive')
}

function oneDriveCloudPath(path: string): string | undefined {
  const marker = '/OneDrive/'
  const idx = path.indexOf(marker)
  if (idx >= 0) return 'onedrive:' + path.slice(idx + marker.length).normalize('NFC')
  const cloudStorage = path.match(/\/Library\/CloudStorage\/OneDrive[^/]*\/(.+)$/)
  return cloudStorage ? 'onedrive:' + cloudStorage[1].normalize('NFC') : undefined
}

function entryKey(name: string): string {
  return name.normalize('NFC')
}

function sortEntryArray(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
  )
}

function mergeEntries(localEntries: Entry[], cloudEntries: Entry[]): Entry[] {
  const byName = new Map<string, Entry>()
  for (const entry of cloudEntries) byName.set(entryKey(entry.name), entry)
  for (const entry of localEntries) byName.set(entryKey(entry.name), entry)
  return sortEntryArray([...byName.values()])
}

function mergePdfEntries(
  localEntries: { name: string; path: string }[],
  cloudEntries: { name: string; path: string }[]
): { name: string; path: string }[] {
  const byPath = new Map<string, { name: string; path: string }>()
  for (const entry of cloudEntries) byPath.set(entry.path.normalize('NFC'), entry)
  for (const entry of localEntries) byPath.set(entry.path.normalize('NFC'), entry)
  return [...byPath.values()]
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
    'fi',
    'lt_timeout_bin=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)',
    'lt_rclone_pid=',
    'lt_rclone_watchdog=',
    'lt_rclone_cleanup() {',
    '  if [ -n "${lt_rclone_watchdog:-}" ]; then',
    '    kill "$lt_rclone_watchdog" >/dev/null 2>&1 || true',
    '    wait "$lt_rclone_watchdog" >/dev/null 2>&1 || true',
    '    lt_rclone_watchdog=',
    '  fi',
    '  if [ -n "${lt_rclone_pid:-}" ] && kill -0 "$lt_rclone_pid" >/dev/null 2>&1; then',
    '    if command -v pgrep >/dev/null 2>&1; then',
    '      for lt_child in $(pgrep -P "$lt_rclone_pid" 2>/dev/null); do kill "$lt_child" >/dev/null 2>&1 || true; done',
    '    fi',
    '    kill "$lt_rclone_pid" >/dev/null 2>&1 || true',
    '    sleep 1',
    '    if command -v pgrep >/dev/null 2>&1; then',
    '      for lt_child in $(pgrep -P "$lt_rclone_pid" 2>/dev/null); do kill -9 "$lt_child" >/dev/null 2>&1 || true; done',
    '    fi',
    '    kill -9 "$lt_rclone_pid" >/dev/null 2>&1 || true',
    '    wait "$lt_rclone_pid" >/dev/null 2>&1 || true',
    '  fi',
    '  lt_rclone_pid=',
    '}',
    'trap lt_rclone_cleanup HUP INT TERM EXIT',
    'lt_rclone() {',
    '  lt_rclone_cleanup',
    '  if [ -n "$lt_timeout_bin" ]; then',
    `    "$lt_timeout_bin" -k 5s ${RCLONE_PROCESS_TIMEOUT} "$rclone_bin" "$@" --timeout ${RCLONE_IO_TIMEOUT} --contimeout ${RCLONE_CONNECT_TIMEOUT} &`,
    '  else',
    `    "$rclone_bin" "$@" --timeout ${RCLONE_IO_TIMEOUT} --contimeout ${RCLONE_CONNECT_TIMEOUT} &`,
    '  fi',
    '  lt_rclone_pid=$!',
    `  ( sleep ${Math.ceil(RCLONE_PROCESS_TIMEOUT_MS / 1000)}; kill "$lt_rclone_pid" >/dev/null 2>&1 || true; sleep 2; kill -9 "$lt_rclone_pid" >/dev/null 2>&1 || true ) &`,
    '  lt_rclone_watchdog=$!',
    '  wait "$lt_rclone_pid"',
    '  lt_rclone_status=$?',
    '  lt_rclone_cleanup',
    '  return "$lt_rclone_status"',
    '}'
  ].join('\n')
}

function remoteMaterializeTmpPath(profileId: string, cloudPath: string): string {
  const rel = cloudPath.replace(/^[^:]+:/, '')
  const hash = createHash('sha256')
    .update(profileId + '\0' + cloudPath)
    .digest('hex')
    .slice(0, 24)
  const base = posix.basename(rel) || 'file'
  return posix.join(REMOTE_MATERIALIZE_TMP_ROOT, profileId, `${hash}-${base}`)
}

function remoteExitError(result: RemoteExecResult, fallback: string): Error {
  const msg = result.stderr.toString('utf8').trim()
  const status =
    result.signal && result.code !== 0
      ? `원격 명령 종료 코드 ${result.code ?? 'unknown'} (${result.signal})`
      : `원격 명령 종료 코드 ${result.code ?? 'unknown'}`
  return new Error(msg || fallback || status)
}

function noteRemoteLocalMutation(path: string): void {
  if (!isLikelyOneDrivePath(path)) return
  remoteLocalMutatedAt.set(path.replace(/\/+$/, '') || '/', Date.now())
}

function hasRecentRemoteLocalMutation(path: string): boolean {
  const key = path.replace(/\/+$/, '') || '/'
  const at = remoteLocalMutatedAt.get(key)
  return at !== undefined && Date.now() - at < REMOTE_LOCAL_MUTATION_WINDOW_MS
}

async function listRemoteOneDriveEntries(
  profileId: string,
  cloudPath: string,
  localDir: string,
  timeoutMs = RCLONE_LIST_TIMEOUT_MS
): Promise<Entry[]> {
  const backoffKey = `${profileId}\0${cloudPath}\0${localDir}`
  const backoffUntil = remoteOneDriveListBackoffUntil.get(backoffKey) ?? 0
  if (Date.now() < backoffUntil) throw new Error('rclone list backed off after recent failure')

  const listKey = `${backoffKey}\0${timeoutMs}`
  const existing = remoteOneDriveListInflight.get(listKey)
  if (existing) return await existing

  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    'lt_rclone lsf "$cloud" --max-depth 1 --format p --retries=1 --low-level-retries=1'
  ].join('\n')

  const request = (async (): Promise<Entry[]> => {
    const result = await execRemoteCommand(profileId, script, {
      timeoutMs,
      timeoutMessage: 'rclone list timed out'
    })
    if (result.code !== 0) throw remoteExitError(result, `rclone 종료 코드 ${result.code}`)
    return result.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .flatMap((raw): Entry[] => {
        if (!raw) return []
        const isDir = raw.endsWith('/')
        const rel = raw.replace(/\/+$/, '')
        const name = posix.basename(rel)
        if (!name || name.startsWith('.')) return []
        return [
          {
            name,
            path: makeRemote(profileId, posix.join(localDir, rel)),
            isDir
          }
        ]
      })
  })()
  remoteOneDriveListInflight.set(listKey, request)
  try {
    const entries = await request
    remoteOneDriveListBackoffUntil.delete(backoffKey)
    return entries
  } catch (e) {
    remoteOneDriveListBackoffUntil.set(backoffKey, Date.now() + REMOTE_RCLONE_LIST_BACKOFF_MS)
    throw e
  } finally {
    if (remoteOneDriveListInflight.get(listKey) === request) remoteOneDriveListInflight.delete(listKey)
  }
}

async function deleteRemoteOneDrivePath(profileId: string, cloudPath: string): Promise<void> {
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    [
      'lt_rclone deletefile "$cloud" --retries=1 --low-level-retries=1 && exit 0',
      'file_status=$?',
      'lt_rclone purge "$cloud" --retries=1 --low-level-retries=1 && exit 0',
      'purge_status=$?',
      'echo "rclone deletefile failed: $file_status; purge failed: $purge_status" >&2',
      'exit "$purge_status"'
    ].join('\n')
  ].join('\n')

  const result = await execRemoteCommand(profileId, script, {
    timeoutMs: RCLONE_READ_TIMEOUT_MS * 2,
    timeoutMessage: 'rclone delete timed out'
  })
  if (result.code !== 0) throw remoteExitError(result, `rclone 종료 코드 ${result.code}`)
}

async function listRemoteOneDrivePdfs(
  profileId: string,
  cloudPath: string,
  localRoot: string,
  timeoutMs = RCLONE_LIST_TIMEOUT_MS
): Promise<{ name: string; path: string }[]> {
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    'lt_rclone lsf "$cloud" --recursive --files-only --format p --retries=1 --low-level-retries=1'
  ].join('\n')

  const result = await execRemoteCommand(profileId, script, {
    timeoutMs,
    timeoutMessage: 'rclone pdf list timed out'
  })
  if (result.code !== 0) throw remoteExitError(result, `rclone 종료 코드 ${result.code}`)
  return result.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .flatMap((rel): { name: string; path: string }[] => {
      if (!rel || !rel.toLowerCase().endsWith('.pdf')) return []
      return [{ name: posix.basename(rel), path: makeRemote(profileId, posix.join(localRoot, rel)) }]
    })
}

async function getProfile(profileId: string): Promise<SshProfile> {
  const settings = await getSettings()
  const profile = (settings.sshProfiles ?? []).find((p) => p.id === profileId)
  if (!profile) throw new Error('SSH 프로필을 찾을 수 없습니다: ' + profileId)
  return profile
}

// 프로필 + 기본 키/agent로 ssh2 접속 설정을 만든다.
// 비밀번호 인증은 지원하지 않음(파일 패널은 키/agent 필요) — 실패 시 명확한 에러를 던진다.
async function buildConfig(p: SshProfile): Promise<Record<string, unknown>> {
  const cfg: Record<string, unknown> = {
    host: p.host,
    port: p.port || 22,
    username: p.user,
    readyTimeout: 20000,
    keepaliveInterval: 20000
  }
  // agent (Windows OpenSSH 명명 파이프 또는 SSH_AUTH_SOCK)
  const agent =
    process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? winAgent : undefined)
  if (agent) cfg.agent = agent

  // 개인키: 프로필 지정 키 → 없으면 ~/.ssh/기본 키. 암호화된 키는(패스프레이즈 필요) 건너뛰고 agent에 의존.
  const keyPath =
    p.identityFile && p.identityFile.trim()
      ? p.identityFile.trim()
      : DEFAULT_KEYS.map((k) => join(homedir(), '.ssh', k)).find((f) => existsSync(f))
  if (keyPath && existsSync(keyPath)) {
    try {
      const raw = await readFile(keyPath)
      const parsed = utils.parseKey(raw)
      // parseKey는 암호화된 키면 Error(또는 passphrase 요구)를 반환 → 그땐 privateKey 생략
      if (!(parsed instanceof Error)) cfg.privateKey = raw
    } catch {
      /* 키 읽기 실패 시 agent에 의존 */
    }
  }
  if (!cfg.agent && !cfg.privateKey) {
    throw new Error(
      '사용 가능한 인증 수단이 없습니다. SSH 키(개인키 파일)를 프로필에 지정하거나 ssh-agent에 키를 등록하세요. (파일 패널은 비밀번호 인증을 지원하지 않습니다)'
    )
  }
  return cfg
}

function connect(profileId: string): Promise<SshConnection> {
  return (async () => {
    const profile = await getProfile(profileId)
    const cfg = await buildConfig(profile)

    return await new Promise<SshConnection>((resolve, reject) => {
      const client = new Client()
      let settled = false
      let connection: SshConnection | undefined
      const failConnection = (err: Error): void => {
        if (!settled) {
          settled = true
          reject(err)
          client.destroy()
          return
        }
        if (connection) connectionPool.discard(profileId, connection)
      }
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) {
            failConnection(err)
            return
          }
          connection = { client, sftp }
          settled = true
          resolve(connection)
        })
      })
      client.on('error', failConnection)
      client.on('close', () => {
        if (!settled) {
          settled = true
          reject(new Error('SSH 연결이 준비되기 전에 종료되었습니다.'))
          client.destroy()
          return
        }
        if (connection) connectionPool.discard(profileId, connection)
      })
      client.connect(cfg)
    })
  })()
}

async function getSftp(profileId: string): Promise<SFTPWrapper> {
  return (await connectionPool.get(profileId)).sftp
}

function getConnection(profileId: string): Promise<SshConnection> {
  return connectionPool.get(profileId)
}

async function execRemoteCommand(
  profileId: string,
  command: string,
  opts: RemoteExecOptions
): Promise<RemoteExecResult> {
  const { client } = await getConnection(profileId)
  return await new Promise<RemoteExecResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let stream: ClientChannel | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutError: Error | undefined

    const finish = (err?: Error, result?: RemoteExecResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (err) reject(err)
      else resolve(result ?? { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: 0 })
    }
    const terminate = (): void => {
      timeoutError = new Error(opts.timeoutMessage)
      if (!stream) {
        finish(timeoutError)
        return
      }
      try {
        stream.signal('TERM')
      } catch {
        /* best effort */
      }
      killTimer = setTimeout(() => {
        try {
          stream?.signal('KILL')
        } catch {
          /* best effort */
        }
        try {
          stream?.close()
        } catch {
          /* best effort */
        }
        finish(timeoutError)
      }, 2_000)
    }
    timer = setTimeout(terminate, opts.timeoutMs)

    client.exec(command, (err, channel) => {
      if (err) {
        finish(err)
        return
      }
      stream = channel
      channel.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stdout.push(buf)
        opts.onStdout?.(buf)
      })
      channel.stderr.on('data', (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      channel.on('error', (streamErr: unknown) => {
        finish(streamErr instanceof Error ? streamErr : new Error(String(streamErr)))
      })
      channel.on('close', (code: number | null, signal?: string) => {
        if (timeoutError) {
          finish(timeoutError)
          return
        }
        finish(undefined, {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          code,
          signal
        })
      })
    })
  })
}

export function disposeRemote(profileId?: string): void {
  invalidateRemoteDirCache(profileId)
  connectionPool.dispose(profileId)
}

// ── SFTP 작업 ──
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

interface Entry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export interface RfsReadProgress {
  totalBytes?: number
  downloadedBytes: number
}

export interface RfsListOptions {
  refresh?: boolean
}

interface RemoteDirCacheEntry {
  entries: Entry[]
  ts: number
}

const remoteDirCache = new Map<string, RemoteDirCacheEntry>()
const remoteDirInflight = new Map<string, Promise<Entry[]>>()

function normalizeRemoteDirPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed || '/'
}

function remoteDirCacheKey(profileId: string, path: string): string {
  return `${profileId}\0${normalizeRemoteDirPath(path)}`
}

function remoteFileCacheKey(profileId: string, path: string, signature?: string): string {
  return `${profileId}\0${path.normalize('NFC')}${signature ? `\0${signature}` : ''}`
}

function cloneEntries(entries: Entry[]): Entry[] {
  return entries.map((entry) => ({ ...entry }))
}

function rememberRemoteDir(profileId: string, path: string, entries: Entry[]): void {
  const key = remoteDirCacheKey(profileId, path)
  if (remoteDirCache.has(key)) remoteDirCache.delete(key)
  remoteDirCache.set(key, { entries: cloneEntries(entries), ts: Date.now() })
  rememberRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, key, { entries })
  while (remoteDirCache.size > REMOTE_DIR_CACHE_MAX) {
    const oldest = remoteDirCache.keys().next().value
    if (!oldest) break
    remoteDirCache.delete(oldest)
  }
}

function cachedRemoteDir(profileId: string, path: string): Entry[] | undefined {
  const key = remoteDirCacheKey(profileId, path)
  const cached = remoteDirCache.get(key)
  if (!cached) return undefined
  if (Date.now() - cached.ts > REMOTE_DIR_CACHE_TTL_MS) {
    remoteDirCache.delete(key)
    return undefined
  }
  return cloneEntries(cached.entries)
}

function cachePathMatches(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : base + '/')
}

function invalidateRemoteDirCache(profileId?: string, path?: string): void {
  const normalized = path ? normalizeRemoteDirPath(path) : undefined
  for (const key of [...remoteDirCache.keys()]) {
    const [keyProfileId, keyPath] = key.split('\0')
    if (profileId && keyProfileId !== profileId) continue
    if (normalized && !cachePathMatches(keyPath, normalized)) continue
    remoteDirCache.delete(key)
  }
  for (const key of [...remoteDirInflight.keys()]) {
    const [keyProfileId, keyPath] = key.split('\0')
    if (profileId && keyProfileId !== profileId) continue
    if (normalized && !cachePathMatches(keyPath, normalized)) continue
    remoteDirInflight.delete(key)
  }
  invalidateRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, (key) => {
    const [keyProfileId, keyPath] = key.split('\0')
    if (profileId && keyProfileId !== profileId) return false
    return !normalized || cachePathMatches(keyPath, normalized)
  })
}

function cacheFilePathMatches(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : base + '/')
}

function remoteFileCachePathFromKey(key: string): string {
  const first = key.indexOf('\0')
  const pathWithSignature = first >= 0 ? key.slice(first + 1) : key
  const second = pathWithSignature.indexOf('\0')
  return second >= 0 ? pathWithSignature.slice(0, second) : pathWithSignature
}

function invalidateRemoteFileContentCache(profileId: string, path: string): void {
  const normalized = path.normalize('NFC')
  invalidateRemoteFileCache(REMOTE_FILE_CACHE_NAMESPACE, (key) => {
    const tab = key.indexOf('\0')
    const keyProfileId = tab >= 0 ? key.slice(0, tab) : key
    const keyPath = remoteFileCachePathFromKey(key)
    return keyProfileId === profileId && cacheFilePathMatches(keyPath, normalized)
  })
}

function remoteFileStatSignature(st: { size?: number; mtime?: number }): string {
  return `${st.size ?? 0}:${st.mtime ?? 0}`
}

function sftpStat(
  sftp: SFTPWrapper,
  path: string
): Promise<{ size: number; mtime?: number; isDirectory: () => boolean }> {
  return new Promise((resolve, reject) =>
    sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st as never)))
  )
}

export function clearRemoteDirCache(): void {
  remoteDirCache.clear()
  remoteDirInflight.clear()
  invalidateRemoteDirListCache(REMOTE_DIR_DISK_CACHE_NAMESPACE, () => true)
  invalidateRemoteFileCache(REMOTE_FILE_CACHE_NAMESPACE, () => true)
}

function sameFsName(a: string, b: string): boolean {
  return a === b || a.normalize('NFC') === b.normalize('NFC') || a.normalize('NFD') === b.normalize('NFD')
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<unknown> {
  return new Promise((resolve, reject) =>
    sftp.lstat(path, (err, st) => (err ? reject(err) : resolve(st)))
  )
}

async function resolveRemotePath(sftp: SFTPWrapper, requestedPath: string): Promise<string> {
  try {
    await sftpLstat(sftp, requestedPath)
    return requestedPath
  } catch {
    /* Try component-wise Unicode normalization fallback below. */
  }
  const absolute = requestedPath.startsWith('/')
  const parts = requestedPath.split('/').filter(Boolean)
  let current = absolute ? '/' : '.'
  for (const part of parts) {
    const list = await new Promise<{ filename: string }[]>((resolve, reject) =>
      sftp.readdir(current, (err, l) => (err ? reject(err) : resolve(l as never)))
    )
    const hit = list.find((e) => sameFsName(e.filename, part))
    if (!hit) throw new Error('원격 경로를 찾을 수 없습니다: ' + requestedPath)
    current = current === '/' ? '/' + hit.filename : posix.join(current, hit.filename)
  }
  return current
}

async function readRemoteDir(profileId: string, path: string): Promise<Entry[]> {
  const sftp = await getSftp(profileId)
  const cloudPath = oneDriveCloudPath(path)
  let actualPath = path
  let out: Entry[] = []
  let localListed = false
  try {
    actualPath = await resolveRemotePath(sftp, path)
    const list = await new Promise<{ filename: string; attrs: { mode: number; mtime?: number } }[]>(
      (resolve, reject) =>
        sftp.readdir(actualPath, (err, l) => (err ? reject(err) : resolve(l as never)))
    )
    localListed = true
    for (const e of list) {
      if (e.filename.startsWith('.')) continue
      const remotePath = posix.join(actualPath, e.filename)
      let isDir = (e.attrs.mode & S_IFMT) === S_IFDIR
      if ((e.attrs.mode & S_IFMT) === S_IFLNK) {
        isDir = await statIsDir(sftp, remotePath)
      }
      out.push({
        name: e.filename,
        path: makeRemote(profileId, remotePath),
        isDir,
        mtimeMs: e.attrs.mtime ? e.attrs.mtime * 1000 : undefined
      })
    }
  } catch (e) {
    if (!cloudPath) throw e
  }
  if (cloudPath && hasRecentRemoteLocalMutation(actualPath)) {
    out = sortEntryArray(out)
  } else if (cloudPath) {
    try {
      out = mergeEntries(
        out,
        await listRemoteOneDriveEntries(
          profileId,
          cloudPath,
          actualPath,
          out.length > 0 ? RCLONE_LIST_MERGE_TIMEOUT_MS : RCLONE_LIST_TIMEOUT_MS
        )
      )
    } catch (e) {
      if (!localListed && out.length === 0) throw e
      out = sortEntryArray(out)
    }
  } else {
    out = sortEntryArray(out)
  }
  prefetchRemoteOneDriveFiles(profileId, out.filter((e) => !e.isDir).map((e) => e.path))
  return out
}

// 디렉터리 목록. 심볼릭 링크는 stat으로 디렉터리 여부 확인.
export async function rfsList(uri: string, opts: RfsListOptions = {}): Promise<Entry[]> {
  const { profileId, path } = parseRemote(uri)
  const key = remoteDirCacheKey(profileId, path)
  if (!opts.refresh) {
    const cached = cachedRemoteDir(profileId, path)
    if (cached) return cached
    const inflight = remoteDirInflight.get(key)
    if (inflight) return cloneEntries(await inflight)
    const diskCached = await readRemoteDirListCache<Entry>(REMOTE_DIR_DISK_CACHE_NAMESPACE, key)
    if (diskCached) {
      rememberRemoteDir(profileId, path, diskCached.entries)
      return cloneEntries(diskCached.entries)
    }
  }
  const request = readRemoteDir(profileId, path).then((entries) => {
    rememberRemoteDir(profileId, path, entries)
    return entries
  })
  remoteDirInflight.set(key, request)
  try {
    return cloneEntries(await request)
  } finally {
    if (remoteDirInflight.get(key) === request) remoteDirInflight.delete(key)
  }
}

function statIsDir(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) =>
    sftp.stat(path, (err, st) => resolve(!err && st.isDirectory()))
  )
}

export async function rfsReadBytes(
  uri: string,
  onProgress?: (progress: RfsReadProgress) => void
): Promise<Buffer> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  let actualPath: string
  try {
    actualPath = await resolveRemotePath(sftp, path)
  } catch (e) {
    const cloudPath = oneDriveCloudPath(path)
    if (!cloudPath) throw e
    await materializeRemoteOneDriveFile(profileId, cloudPath, path)
    actualPath = await resolveRemotePath(sftp, path)
  }
  const st = await sftpStat(sftp, actualPath)
  const cacheKey = remoteFileCacheKey(profileId, actualPath, remoteFileStatSignature(st))
  const cached = await readRemoteFileCache(REMOTE_FILE_CACHE_NAMESPACE, cacheKey)
  if (cached) return cached
  const progress = (downloadedBytes: number): void =>
    onProgress?.({ totalBytes: st.size, downloadedBytes })
  progress(0)
  const remember = (data: Buffer): Buffer => {
    rememberRemoteFileCache(REMOTE_FILE_CACHE_NAMESPACE, cacheKey, data)
    progress(data.byteLength)
    return data
  }
  if (isLikelyOneDrivePath(actualPath)) {
    const cloudPath = oneDriveCloudPath(actualPath)
    try {
      return remember(await readBytesViaSsh(profileId, actualPath, SSH_QUICK_READ_TIMEOUT_MS, progress))
    } catch (sshErr) {
      if (cloudPath) {
        try {
          await materializeRemoteOneDriveFile(profileId, cloudPath, actualPath)
          return remember(await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS, progress))
        } catch (materializeErr) {
          try {
            return remember(await readBytesViaRclone(profileId, cloudPath, progress))
          } catch (rcloneErr) {
            if (!isCloudTimeout(sshErr)) throw new Error(readFailureMessage(sshErr, rcloneErr))
            await hydrateRemoteFile(profileId, actualPath)
            try {
              return remember(await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS, progress))
            } catch (retryErr) {
              throw new Error(
                [
                  readFailureMessage(sshErr, retryErr),
                  `rclone 직접 읽기 실패(${rcloneErr instanceof Error ? rcloneErr.message : String(rcloneErr)})`,
                  `원격 파일 물리화 실패(${materializeErr instanceof Error ? materializeErr.message : String(materializeErr)})`
                ].join('\n')
              )
            }
          }
        }
      }
      if (!isCloudTimeout(sshErr)) throw sshErr
      await hydrateRemoteFile(profileId, actualPath)
      return remember(await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS, progress))
    }
  }
  try {
    return remember(await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let downloadedBytes = 0
      const stream = sftp.createReadStream(actualPath)
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        stream.destroy()
        reject(err)
      }
      const arm = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => fail(new Error('SFTP read timed out')), 15_000)
      }
      arm()
      stream.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(buf)
        downloadedBytes += buf.byteLength
        progress(downloadedBytes)
        arm()
      })
      stream.on('error', (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))))
      stream.on('end', () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
    }))
  } catch (e) {
    const sftpErr = e
    try {
      return remember(await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS, progress))
    } catch (sshErr) {
      if (isCloudTimeout(sshErr)) {
        await hydrateRemoteFile(profileId, actualPath)
        try {
          return remember(await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS, progress))
        } catch (retryErr) {
          throw new Error(cloudFileMessage(actualPath, sftpErr, retryErr))
        }
      }
      throw new Error(readFailureMessage(sftpErr, sshErr))
    }
  }
}

function isCloudTimeout(e: unknown): boolean {
  return /Operation timed out|timed out/i.test(e instanceof Error ? e.message : String(e))
}

function readFailureMessage(sftpErr: unknown, sshErr: unknown): string {
  const sftpMsg = sftpErr instanceof Error ? sftpErr.message : String(sftpErr)
  const sshMsg = sshErr instanceof Error ? sshErr.message : String(sshErr)
  return `SFTP 읽기 실패(${sftpMsg}); SSH fallback 실패: ${sshMsg}`
}

function cloudFileMessage(path: string, sftpErr: unknown, retryErr: unknown): string {
  return [
    readFailureMessage(sftpErr, retryErr),
    `원격 파일 자동 다운로드가 시간 내 완료되지 않았습니다: ${path}`,
    '원격 Mac의 OneDrive 로그인/네트워크 상태를 확인한 뒤 다시 여세요.'
  ].join('\n')
}

async function readBytesViaSsh(
  profileId: string,
  path: string,
  timeoutMs = SSH_READ_TIMEOUT_MS,
  onBytes?: (downloadedBytes: number) => void
): Promise<Buffer> {
  let downloadedBytes = 0
  const result = await execRemoteCommand(profileId, `cat -- ${shq(path)}`, {
    timeoutMs,
    timeoutMessage: 'Operation timed out',
    onStdout: (chunk) => {
      downloadedBytes += chunk.byteLength
      onBytes?.(downloadedBytes)
    }
  })
  if (result.code === 0) return result.stdout
  throw remoteExitError(result, `ssh 종료 코드 ${result.code}`)
}

async function readBytesViaRclone(
  profileId: string,
  cloudPath: string,
  onBytes?: (downloadedBytes: number) => void
): Promise<Buffer> {
  const script = `${remoteRcloneBootstrap()}\nlt_rclone cat ${shq(cloudPath)} --retries=1 --low-level-retries=1`
  let downloadedBytes = 0
  const result = await execRemoteCommand(profileId, script, {
    timeoutMs: RCLONE_READ_TIMEOUT_MS,
    timeoutMessage: 'rclone read timed out',
    onStdout: (chunk) => {
      downloadedBytes += chunk.byteLength
      onBytes?.(downloadedBytes)
    }
  })
  if (result.code === 0) return result.stdout
  throw remoteExitError(result, `rclone 종료 코드 ${result.code}`)
}

async function materializeRemoteOneDriveFile(
  profileId: string,
  cloudPath: string,
  targetPath: string
): Promise<void> {
  const tmpPath = `${remoteMaterializeTmpPath(profileId, cloudPath)}.part.$$`
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    `target=${shq(targetPath)}`,
    `tmp=${shq(tmpPath)}`,
    'cleanup_tmp() { rm -f "$tmp"; }',
    'trap "lt_rclone_cleanup; cleanup_tmp" HUP INT TERM EXIT',
    'target_state=$(ls -lO "$target" 2>/dev/null || true)',
    'if [ -n "$target_state" ] && ! printf "%s\\n" "$target_state" | grep -q "dataless"; then exit 0; fi',
    'mkdir -p "$(dirname "$target")"',
    'mode=$(stat -f "%Lp" "$target" 2>/dev/null || echo 600)',
    'gid=$(stat -f "%g" "$target" 2>/dev/null || stat -f "%g" "$(dirname "$target")" 2>/dev/null || true)',
    'mkdir -p "$(dirname "$tmp")"',
    'rm -f "$tmp"',
    'lt_rclone copyto "$cloud" "$tmp" --ignore-times --retries=1 --low-level-retries=1',
    'chmod "$mode" "$tmp" >/dev/null 2>&1 || true',
    'if [ -n "$gid" ]; then chgrp "$gid" "$tmp" >/dev/null 2>&1 || true; fi',
    'target_state=$(ls -lO "$target" 2>/dev/null || true)',
    'if [ -n "$target_state" ] && ! printf "%s\\n" "$target_state" | grep -q "dataless"; then rm -f "$tmp"; exit 0; fi',
    'mv -f "$tmp" "$target"',
    'mv_status=$?',
    'if [ "$mv_status" -eq 0 ]; then trap - HUP INT TERM EXIT; fi',
    'exit "$mv_status"'
  ].join('\n')

  const result = await execRemoteCommand(profileId, script, {
    timeoutMs: RCLONE_READ_TIMEOUT_MS,
    timeoutMessage: 'rclone materialize timed out'
  })
  if (result.code !== 0) throw remoteExitError(result, `rclone 종료 코드 ${result.code}`)
}

function prefetchRemoteOneDriveFiles(profileId: string, uris: string[]): void {
  const now = Date.now()
  const jobs = uris
    .map((uri) => {
      const { path } = parseRemote(uri)
      const cloudPath = oneDriveCloudPath(path)
      if (!cloudPath) return null
      const key = `${profileId}\0${cloudPath}`
      const doneAt = remotePrefetchedAt.get(key) ?? 0
      if (remotePrefetching.has(key) || now - doneAt < REMOTE_PREFETCH_COOLDOWN_MS) return null
      return { key, profileId, cloudPath, targetPath: path }
    })
    .filter((p): p is RemotePrefetchJob => !!p)
  if (jobs.length === 0) return

  for (const job of jobs) {
    remotePrefetching.add(job.key)
    remotePrefetchQueue.push(job)
  }
  drainRemotePrefetchQueue()
}

function drainRemotePrefetchQueue(): void {
  while (remotePrefetchActive < REMOTE_PREFETCH_CONCURRENCY && remotePrefetchQueue.length > 0) {
    const job = remotePrefetchQueue.shift()
    if (!job) return
    remotePrefetchActive += 1
    void runRemotePrefetchJob(job).finally(() => {
      remotePrefetchActive -= 1
      drainRemotePrefetchQueue()
    })
  }
}

async function runRemotePrefetchJob(job: RemotePrefetchJob): Promise<void> {
  try {
    await materializeRemoteOneDriveFile(job.profileId, job.cloudPath, job.targetPath)
  } catch {
    /* Background prefetch is opportunistic; foreground open still reports errors. */
  } finally {
    remotePrefetching.delete(job.key)
    remotePrefetchedAt.set(job.key, Date.now())
  }
}

// ── 저장 시 자동 올리기 ──
// 원격 OneDrive 경로에 파일을 저장하면 잠시 뒤 그 파일만 rclone copyto로 클라우드에 올린다.
// macOS OneDrive 클라이언트의 업로드 시점에 기대지 않고 전파를 확정한다.
// 실패는 조용히 넘긴다(수동 동기화·OneDrive 클라이언트가 보완).
const AUTO_PUSH_DEBOUNCE_MS = 5_000
const autoPushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleRemoteAutoPush(profileId: string, path: string): void {
  const cloudPath = oneDriveCloudPath(path)
  if (!cloudPath) return
  const key = `${profileId}\0${path}`
  const prev = autoPushTimers.get(key)
  if (prev) clearTimeout(prev)
  autoPushTimers.set(
    key,
    setTimeout(() => {
      autoPushTimers.delete(key)
      void runRemoteAutoPush(profileId, path, cloudPath)
    }, AUTO_PUSH_DEBOUNCE_MS)
  )
}

async function runRemoteAutoPush(
  profileId: string,
  path: string,
  cloudPath: string
): Promise<void> {
  try {
    if ((await getSettings()).syncAutoPushOnSave !== true) return
    const script =
      `${remoteRcloneBootstrap()}\n` +
      `lt_rclone copyto ${shq(path)} ${shq(cloudPath)} --update --retries=3 --low-level-retries=10`
    const result = await execRemoteCommand(profileId, script, {
      timeoutMs: RCLONE_READ_TIMEOUT_MS,
      timeoutMessage: 'rclone 자동 올리기 대기 시간 초과'
    })
    if (result.code !== 0) {
      console.warn('[remoteFs] 자동 올리기 실패:', path, result.stderr.toString('utf8').slice(-500))
    }
  } catch (e) {
    console.warn('[remoteFs] 자동 올리기 실패:', path, e)
  }
}

async function hydrateRemoteFile(profileId: string, path: string): Promise<void> {
  const script = `
p=${shq(path)}
err="/tmp/legal-terminal-download-$$.err"
cleanup() {
  if [ -n "\${dlpid:-}" ] && kill -0 "$dlpid" >/dev/null 2>&1; then
    kill "$dlpid" >/dev/null 2>&1 || true
    wait "$dlpid" >/dev/null 2>&1 || true
  fi
  rm -f "$err"
}
trap cleanup HUP INT TERM EXIT

try_read() {
  rm -f "$err"
  python3 - "$p" > /dev/null 2>"$err" <<'PY' &
import sys
p = sys.argv[1]
with open(p, 'rb') as f:
    f.read(4096)
PY
  rpid=$!
  i=0
  while [ "$i" -lt 8 ]; do
    if ! kill -0 "$rpid" >/dev/null 2>&1; then
      wait "$rpid"
      return $?
    fi
    sleep 1
    i=$((i + 1))
  done
  kill "$rpid" >/dev/null 2>&1 || true
  wait "$rpid" >/dev/null 2>&1 || true
  echo "OneDrive placeholder read timed out" > "$err"
  return 124
}

is_dataless() {
  ls -lO "$p" 2>/dev/null | grep -q "dataless"
}

start_downloader() {
  if [ -n "\${dlpid:-}" ] && kill -0 "$dlpid" >/dev/null 2>&1; then
    return 0
  fi
  rm -f "$err"
  /bin/cat "$p" >/dev/null 2>"$err" &
  dlpid=$!
}

if ! is_dataless && try_read; then exit 0; fi

onedrive="/Applications/OneDrive.app/Contents/MacOS/OneDrive"
if [ -x "$onedrive" ]; then
  open -ga OneDrive >/dev/null 2>&1 || true
  "$onedrive" /pin "$p" >/dev/null 2>&1 || true
fi

start_downloader
deadline=$(( $(date +%s) + 590 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! is_dataless; then
    if [ -n "\${dlpid:-}" ]; then wait "$dlpid" >/dev/null 2>&1 || true; fi
    exit 0
  fi
  if [ -n "\${dlpid:-}" ] && ! kill -0 "$dlpid" >/dev/null 2>&1; then
    wait "$dlpid" >/dev/null 2>&1
    if ! is_dataless && try_read; then exit 0; fi
    if [ -x "$onedrive" ]; then "$onedrive" /pin "$p" >/dev/null 2>&1 || true; fi
    start_downloader
  fi
  sleep 2
done

if [ -n "\${dlpid:-}" ]; then kill "$dlpid" >/dev/null 2>&1 || true; fi
cat "$err" >&2 2>/dev/null || true
if [ -x "$onedrive" ]; then "$onedrive" /getpin "$p" >&2 || true; fi
ls -lO@ "$p" >&2 2>/dev/null || true
exit 1
`.trim()
  const result = await execRemoteCommand(profileId, script, {
    timeoutMs: REMOTE_CLOUD_HYDRATE_TIMEOUT_MS,
    timeoutMessage: '원격 OneDrive 다운로드 대기 시간이 초과되었습니다.'
  })
  if (result.code !== 0) throw remoteExitError(result, `ssh 종료 코드 ${result.code}`)
}

export async function rfsWriteText(uri: string, content: string): Promise<void> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(path, content, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
  )
  invalidateRemoteDirCache(profileId, posix.dirname(path))
  invalidateRemoteFileContentCache(profileId, path)
  const st = await sftpStat(sftp, path).catch(() => undefined)
  if (st) {
    rememberRemoteFileCache(
      REMOTE_FILE_CACHE_NAMESPACE,
      remoteFileCacheKey(profileId, path, remoteFileStatSignature(st)),
      Buffer.from(content)
    )
  }
  noteRemoteLocalMutation(posix.dirname(path))
  scheduleRemoteAutoPush(profileId, path)
}

// 바이너리 업로드: destDirUri 하위에 name으로 저장 → 저장된 URI 반환
export async function rfsWriteBytes(
  destDirUri: string,
  name: string,
  data: Buffer
): Promise<string> {
  const { profileId, path } = parseRemote(destDirUri)
  const sftp = await getSftp(profileId)
  const full = posix.join(path, name)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(full, data, (err) => (err ? reject(err) : resolve()))
  )
  invalidateRemoteDirCache(profileId, path)
  invalidateRemoteFileContentCache(profileId, full)
  const st = await sftpStat(sftp, full).catch(() => undefined)
  if (st) {
    rememberRemoteFileCache(
      REMOTE_FILE_CACHE_NAMESPACE,
      remoteFileCacheKey(profileId, full, remoteFileStatSignature(st)),
      data
    )
  }
  noteRemoteLocalMutation(path)
  scheduleRemoteAutoPush(profileId, full)
  return makeRemote(profileId, full)
}

export async function rfsStat(
  uri: string
): Promise<{ size: number; isDir: boolean; mtimeMs?: number }> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  const actualPath = await resolveRemotePath(sftp, path)
  return await new Promise((resolve, reject) =>
    sftp.stat(actualPath, (err, st) =>
      err
        ? reject(err)
        : resolve({
            size: st.size,
            isDir: st.isDirectory(),
            mtimeMs: st.mtime ? st.mtime * 1000 : undefined
          })
    )
  )
}

export async function rfsMkdir(parentUri: string, name: string): Promise<void> {
  const { profileId, path } = parseRemote(parentUri)
  const sftp = await getSftp(profileId)
  const full = posix.join(path, name)
  await new Promise<void>((resolve, reject) =>
    sftp.mkdir(full, (err) => (err ? reject(err) : resolve()))
  )
  invalidateRemoteDirCache(profileId, path)
  noteRemoteLocalMutation(path)
  noteRemoteLocalMutation(full)
}

// 빈 파일 생성 (이름 충돌 시 " (n)") → 새 경로(URI) 반환
export async function rfsCreateFile(
  parentUri: string,
  name: string,
  content = ''
): Promise<string> {
  const { profileId, path } = parseRemote(parentUri)
  const sftp = await getSftp(profileId)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = ext ? name.slice(0, name.length - ext.length) : name
  let fname = name
  let i = 1
  // 충돌 회피
  while (await exists(sftp, posix.join(path, fname))) {
    fname = `${base} (${i})${ext}`
    i++
  }
  const full = posix.join(path, fname)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(full, content, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
  )
  invalidateRemoteDirCache(profileId, path)
  invalidateRemoteFileContentCache(profileId, full)
  const st = await sftpStat(sftp, full).catch(() => undefined)
  if (st) {
    rememberRemoteFileCache(
      REMOTE_FILE_CACHE_NAMESPACE,
      remoteFileCacheKey(profileId, full, remoteFileStatSignature(st)),
      Buffer.from(content)
    )
  }
  noteRemoteLocalMutation(path)
  scheduleRemoteAutoPush(profileId, full)
  return makeRemote(profileId, full)
}

function exists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.stat(path, (err) => resolve(!err)))
}

// 같은 원격 내 이동 (rename). destDirUri 하위로 옮긴다.
export async function rfsMove(
  srcUri: string,
  destDirUri: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const src = parseRemote(srcUri)
  const dest = parseRemote(destDirUri)
  if (src.profileId !== dest.profileId)
    return { ok: false, error: '다른 서버 간 이동은 지원하지 않습니다.' }
  const name = posix.basename(src.path)
  const target = posix.join(dest.path, name)
  if (target === src.path) return { ok: true, path: srcUri }
  const sftp = await getSftp(src.profileId)
  try {
    await new Promise<void>((resolve, reject) =>
      sftp.rename(src.path, target, (err) => (err ? reject(err) : resolve()))
    )
    invalidateRemoteDirCache(src.profileId, posix.dirname(src.path))
    invalidateRemoteDirCache(src.profileId, src.path)
    invalidateRemoteDirCache(src.profileId, dest.path)
    invalidateRemoteDirCache(src.profileId, target)
    invalidateRemoteFileContentCache(src.profileId, src.path)
    invalidateRemoteFileContentCache(src.profileId, target)
    noteRemoteLocalMutation(posix.dirname(src.path))
    noteRemoteLocalMutation(dest.path)
    noteRemoteLocalMutation(target)
    return { ok: true, path: makeRemote(src.profileId, target) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function rfsRename(
  srcUri: string,
  newName: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const src = parseRemote(srcUri)
  const name = newName.trim()
  if (!name) return { ok: false, error: '이름을 입력하세요.' }
  if (name.includes('/')) return { ok: false, error: '이름에 /를 사용할 수 없습니다.' }
  const target = posix.join(posix.dirname(src.path), name)
  if (target === src.path) return { ok: true, path: srcUri }
  const sftp = await getSftp(src.profileId)
  if (await exists(sftp, target)) return { ok: false, error: '같은 이름이 이미 있습니다.' }
  try {
    await new Promise<void>((resolve, reject) =>
      sftp.rename(src.path, target, (err) => (err ? reject(err) : resolve()))
    )
    invalidateRemoteDirCache(src.profileId, posix.dirname(src.path))
    invalidateRemoteDirCache(src.profileId, src.path)
    invalidateRemoteDirCache(src.profileId, target)
    invalidateRemoteFileContentCache(src.profileId, src.path)
    invalidateRemoteFileContentCache(src.profileId, target)
    noteRemoteLocalMutation(posix.dirname(src.path))
    noteRemoteLocalMutation(target)
    return { ok: true, path: makeRemote(src.profileId, target) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// 파일/폴더 삭제 (폴더는 재귀). lstat로 심볼릭 링크는 따라가지 않고 unlink.
export async function rfsDelete(uri: string): Promise<void> {
  const { profileId, path } = parseRemote(uri)
  const cloudPath = oneDriveCloudPath(path)
  let localError: unknown
  try {
    const sftp = await getSftp(profileId)
    const actualPath = await resolveRemotePath(sftp, path)
    await removeRec(sftp, actualPath)
    invalidateRemoteDirCache(profileId, posix.dirname(actualPath))
    invalidateRemoteDirCache(profileId, actualPath)
    invalidateRemoteFileContentCache(profileId, actualPath)
    if (actualPath !== path) {
      invalidateRemoteDirCache(profileId, posix.dirname(path))
      invalidateRemoteDirCache(profileId, path)
      invalidateRemoteFileContentCache(profileId, path)
    }
    noteRemoteLocalMutation(posix.dirname(actualPath))
    noteRemoteLocalMutation(actualPath)
    return
  } catch (e) {
    localError = e
    if (!cloudPath) throw e
  }

  try {
    await deleteRemoteOneDrivePath(profileId, cloudPath)
    invalidateRemoteDirCache(profileId, posix.dirname(path))
    invalidateRemoteDirCache(profileId, path)
    invalidateRemoteFileContentCache(profileId, path)
    noteRemoteLocalMutation(posix.dirname(path))
    noteRemoteLocalMutation(path)
  } catch (cloudError) {
    const localMessage = localError instanceof Error ? localError.message : String(localError)
    const cloudMessage = cloudError instanceof Error ? cloudError.message : String(cloudError)
    throw new Error(`OneDrive 삭제 실패: ${cloudMessage}\n로컬 삭제 오류: ${localMessage}`)
  }
}

async function removeRec(sftp: SFTPWrapper, path: string): Promise<void> {
  const st = await new Promise<{ isDirectory: () => boolean }>((resolve, reject) =>
    sftp.lstat(path, (err, s) => (err ? reject(err) : resolve(s)))
  )
  if (st.isDirectory()) {
    const list = await new Promise<{ filename: string }[]>((resolve, reject) =>
      sftp.readdir(path, (err, l) => (err ? reject(err) : resolve(l as never)))
    )
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') continue
      await removeRec(sftp, posix.join(path, e.filename))
    }
    await new Promise<void>((resolve, reject) =>
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
    )
  } else {
    await new Promise<void>((resolve, reject) =>
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
    )
  }
}

// 하위 포함 모든 PDF 수집 (소송기록 폴더 분류용)
export async function rfsListPdfs(uri: string): Promise<{ name: string; path: string }[]> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  const cloudPath = oneDriveCloudPath(path)
  let actualPath = path
  const out: { name: string; path: string }[] = []
  let localFailed: unknown
  try {
    actualPath = await resolveRemotePath(sftp, path)
    await walk(sftp, profileId, actualPath, out, 0)
  } catch (e) {
    localFailed = e
    if (!cloudPath) throw e
  }
  if (cloudPath && (localFailed || out.length === 0)) {
    try {
      const cloudOut = await listRemoteOneDrivePdfs(profileId, cloudPath, actualPath)
      const merged = mergePdfEntries(out, cloudOut)
      prefetchRemoteOneDriveFiles(profileId, merged.map((p) => p.path))
      return merged
    } catch (e) {
      if (localFailed) throw e
    }
  }
  prefetchRemoteOneDriveFiles(profileId, out.map((p) => p.path))
  return out
}

async function walk(
  sftp: SFTPWrapper,
  profileId: string,
  dir: string,
  out: { name: string; path: string }[],
  depth: number
): Promise<void> {
  if (depth > 8) return // 폭주 방지
  let list: { filename: string; attrs: { mode: number } }[]
  try {
    list = await new Promise((resolve, reject) =>
      sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l as never)))
    )
  } catch {
    return
  }
  for (const e of list) {
    if (e.filename.startsWith('.')) continue
    const full = posix.join(dir, e.filename)
    const isDir = (e.attrs.mode & S_IFMT) === S_IFDIR
    if (isDir) await walk(sftp, profileId, full, out, depth + 1)
    else if (e.filename.toLowerCase().endsWith('.pdf'))
      out.push({ name: e.filename, path: makeRemote(profileId, full) })
  }
}
