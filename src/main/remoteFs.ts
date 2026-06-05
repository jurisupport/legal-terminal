import { Client, type SFTPWrapper, utils } from 'ssh2'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, posix } from 'path'
import { getSettings, type SshProfile } from './settings'

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
const pool = new Map<string, Promise<{ client: Client; sftp: SFTPWrapper }>>()

const winAgent = '\\\\.\\pipe\\openssh-ssh-agent'
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const SSH_READ_TIMEOUT_MS = 120_000
const SSH_QUICK_READ_TIMEOUT_MS = 8_000
const RCLONE_READ_TIMEOUT_MS = 5 * 60_000
const RCLONE_LIST_TIMEOUT_MS = 15_000
const RCLONE_LIST_MERGE_TIMEOUT_MS = 2_500
const REMOTE_CLOUD_HYDRATE_TIMEOUT_MS = 10 * 60_000
const REMOTE_MATERIALIZE_TMP_ROOT = '/tmp/legal-terminal-rclone-materialize'
const REMOTE_LOCAL_MUTATION_WINDOW_MS = 30_000
const remotePrefetching = new Set<string>()
const remotePrefetchedAt = new Map<string, number>()
const remoteLocalMutatedAt = new Map<string, number>()

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
    'fi'
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
  const profile = await getProfile(profileId)
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    '"$rclone_bin" lsf "$cloud" --max-depth 1 --format p --retries=1 --low-level-retries=1'
  ].join('\n')

  return await new Promise<Entry[]>((resolve, reject) => {
    const chunks: Buffer[] = []
    const errs: Buffer[] = []
    const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('rclone list timed out'))
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`rclone list 실행 실패: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(Buffer.concat(errs).toString('utf8').trim() || `rclone 종료 코드 ${code}`))
        return
      }
      const entries = Buffer.concat(chunks)
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
      resolve(entries)
    })
  })
}

async function listRemoteOneDrivePdfs(
  profileId: string,
  cloudPath: string,
  localRoot: string,
  timeoutMs = RCLONE_LIST_TIMEOUT_MS
): Promise<{ name: string; path: string }[]> {
  const profile = await getProfile(profileId)
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    '"$rclone_bin" lsf "$cloud" --recursive --files-only --format p --retries=1 --low-level-retries=1'
  ].join('\n')

  return await new Promise<{ name: string; path: string }[]>((resolve, reject) => {
    const chunks: Buffer[] = []
    const errs: Buffer[] = []
    const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('rclone pdf list timed out'))
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`rclone pdf list 실행 실패: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(Buffer.concat(errs).toString('utf8').trim() || `rclone 종료 코드 ${code}`))
        return
      }
      const entries = Buffer.concat(chunks)
        .toString('utf8')
        .split(/\r?\n/)
        .flatMap((rel): { name: string; path: string }[] => {
          if (!rel || !rel.toLowerCase().endsWith('.pdf')) return []
          return [{ name: posix.basename(rel), path: makeRemote(profileId, posix.join(localRoot, rel)) }]
        })
      resolve(entries)
    })
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

function connect(profileId: string): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return (async () => {
    const profile = await getProfile(profileId)
    const cfg = await buildConfig(profile)

    return await new Promise<{ client: Client; sftp: SFTPWrapper }>((resolve, reject) => {
      const client = new Client()
      let settled = false
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) {
            settled = true
            client.end()
            reject(err)
            return
          }
          settled = true
          resolve({ client, sftp })
        })
      })
      client.on('error', (err) => {
        if (!settled) reject(err)
        pool.delete(profileId) // 끊기면 다음 호출에서 재연결
      })
      client.on('close', () => {
        pool.delete(profileId)
      })
      client.connect(cfg)
    })
  })()
}

async function getSftp(profileId: string): Promise<SFTPWrapper> {
  const existing = pool.get(profileId)
  if (existing) {
    try {
      return (await existing).sftp
    } catch {
      pool.delete(profileId) // 이전 연결 실패 → 새로 시도
    }
  }
  const fresh = connect(profileId)
  pool.set(profileId, fresh)
  try {
    return (await fresh).sftp
  } catch (e) {
    pool.delete(profileId)
    throw e
  }
}

export function disposeRemote(profileId?: string): void {
  const ids = profileId ? [profileId] : [...pool.keys()]
  for (const id of ids) {
    const c = pool.get(id)
    pool.delete(id)
    if (c) c.then(({ client }) => client.end()).catch(() => {})
  }
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

// 디렉터리 목록. 심볼릭 링크는 stat으로 디렉터리 여부 확인.
export async function rfsList(uri: string): Promise<Entry[]> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  const cloudPath = oneDriveCloudPath(path)
  let actualPath = path
  let out: Entry[] = []
  try {
    actualPath = await resolveRemotePath(sftp, path)
    const list = await new Promise<{ filename: string; attrs: { mode: number; mtime?: number } }[]>(
      (resolve, reject) =>
        sftp.readdir(actualPath, (err, l) => (err ? reject(err) : resolve(l as never)))
    )
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
  if (cloudPath && out.length > 0 && hasRecentRemoteLocalMutation(actualPath)) {
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
      if (out.length === 0) throw e
    }
  } else {
    out = sortEntryArray(out)
  }
  prefetchRemoteOneDriveFiles(profileId, out.filter((e) => !e.isDir).map((e) => e.path))
  return out
}

function statIsDir(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) =>
    sftp.stat(path, (err, st) => resolve(!err && st.isDirectory()))
  )
}

export async function rfsReadBytes(uri: string): Promise<Buffer> {
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
  if (isLikelyOneDrivePath(actualPath)) {
    const cloudPath = oneDriveCloudPath(actualPath)
    try {
      return await readBytesViaSsh(profileId, actualPath, SSH_QUICK_READ_TIMEOUT_MS)
    } catch (sshErr) {
      if (cloudPath) {
        try {
          await materializeRemoteOneDriveFile(profileId, cloudPath, actualPath)
          return await readBytesViaSsh(profileId, actualPath, SSH_READ_TIMEOUT_MS)
        } catch (materializeErr) {
          try {
            return await readBytesViaRclone(profileId, cloudPath)
          } catch (rcloneErr) {
            if (!isCloudTimeout(sshErr)) throw new Error(readFailureMessage(sshErr, rcloneErr))
            await hydrateRemoteFile(profileId, actualPath)
            try {
              return await readBytesViaSsh(profileId, actualPath)
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
      return await readBytesViaSsh(profileId, actualPath)
    }
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
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
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        arm()
      })
      stream.on('error', (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))))
      stream.on('end', () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
    })
  } catch (e) {
    const sftpErr = e
    try {
      return await readBytesViaSsh(profileId, actualPath)
    } catch (sshErr) {
      if (isCloudTimeout(sshErr)) {
        await hydrateRemoteFile(profileId, actualPath)
        try {
          return await readBytesViaSsh(profileId, actualPath)
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
  timeoutMs = SSH_READ_TIMEOUT_MS
): Promise<Buffer> {
  const profile = await getProfile(profileId)
  const args = sshArgs(profile)
  args.push(`cat -- ${shq(path)}`)

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const errs: Buffer[] = []
    const proc = spawn(sshBin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Operation timed out'))
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`SSH fallback 실행 실패: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(Buffer.concat(chunks))
        return
      }
      const fallbackErr = Buffer.concat(errs).toString('utf8').trim()
      reject(new Error(fallbackErr || `ssh 종료 코드 ${code}`))
    })
  })
}

async function readBytesViaRclone(profileId: string, cloudPath: string): Promise<Buffer> {
  const profile = await getProfile(profileId)
  const script = `${remoteRcloneBootstrap()}\n"$rclone_bin" cat ${shq(cloudPath)} --retries=1 --low-level-retries=1`

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const errs: Buffer[] = []
    const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('rclone read timed out'))
    }, RCLONE_READ_TIMEOUT_MS)
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`rclone 실행 실패: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(Buffer.concat(chunks))
        return
      }
      const msg = Buffer.concat(errs).toString('utf8').trim()
      reject(new Error(msg || `rclone 종료 코드 ${code}`))
    })
  })
}

async function materializeRemoteOneDriveFile(
  profileId: string,
  cloudPath: string,
  targetPath: string
): Promise<void> {
  const profile = await getProfile(profileId)
  const tmpPath = `${remoteMaterializeTmpPath(profileId, cloudPath)}.part.$$`
  const script = [
    remoteRcloneBootstrap(),
    `cloud=${shq(cloudPath)}`,
    `target=${shq(targetPath)}`,
    `tmp=${shq(tmpPath)}`,
    'target_state=$(ls -lO "$target" 2>/dev/null || true)',
    'if [ -n "$target_state" ] && ! printf "%s\\n" "$target_state" | grep -q "dataless"; then exit 0; fi',
    'mkdir -p "$(dirname "$target")"',
    'mode=$(stat -f "%Lp" "$target" 2>/dev/null || echo 600)',
    'gid=$(stat -f "%g" "$target" 2>/dev/null || stat -f "%g" "$(dirname "$target")" 2>/dev/null || true)',
    'mkdir -p "$(dirname "$tmp")"',
    'rm -f "$tmp"',
    '"$rclone_bin" copyto "$cloud" "$tmp" --ignore-times --retries=1 --low-level-retries=1',
    'chmod "$mode" "$tmp" >/dev/null 2>&1 || true',
    'if [ -n "$gid" ]; then chgrp "$gid" "$tmp" >/dev/null 2>&1 || true; fi',
    'target_state=$(ls -lO "$target" 2>/dev/null || true)',
    'if [ -n "$target_state" ] && ! printf "%s\\n" "$target_state" | grep -q "dataless"; then rm -f "$tmp"; exit 0; fi',
    'mv -f "$tmp" "$target"'
  ].join('\n')

  await new Promise<void>((resolve, reject) => {
    const errs: Buffer[] = []
    const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('rclone materialize timed out'))
    }, RCLONE_READ_TIMEOUT_MS)
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`rclone materialize 실행 실패: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(Buffer.concat(errs).toString('utf8').trim() || `rclone 종료 코드 ${code}`))
    })
  })
}

function prefetchRemoteOneDriveFiles(profileId: string, uris: string[]): void {
  const now = Date.now()
  const pairs = uris
    .map((uri) => {
      const { path } = parseRemote(uri)
      const cloudPath = oneDriveCloudPath(path)
      if (!cloudPath) return null
      const key = `${profileId}\0${cloudPath}`
      const doneAt = remotePrefetchedAt.get(key) ?? 0
      if (remotePrefetching.has(key) || now - doneAt < 10 * 60_000) return null
      return { key, cloudPath, targetPath: path }
    })
    .filter((p): p is { key: string; cloudPath: string; targetPath: string } => !!p)
  if (pairs.length === 0) return

  for (const p of pairs) remotePrefetching.add(p.key)
  void (async () => {
    const profile = await getProfile(profileId)
    const lines = pairs
      .map((p) => `${Buffer.from(p.cloudPath).toString('base64')}\t${Buffer.from(p.targetPath).toString('base64')}`)
      .join('\n')
    const tmpRoot = posix.join(REMOTE_MATERIALIZE_TMP_ROOT, profileId)
    const script = [
      remoteRcloneBootstrap(),
      `tmp_root=${shq(tmpRoot)}`,
      'while IFS="$(printf \'\\t\')" read -r cloud64 target64; do',
      '  [ -z "$cloud64" ] && continue',
      '  cloud=$(printf "%s" "$cloud64" | base64 --decode)',
      '  target=$(printf "%s" "$target64" | base64 --decode)',
      '  target_state=$(ls -lO "$target" 2>/dev/null || true)',
      '  if [ -n "$target_state" ] && ! printf "%s\\n" "$target_state" | grep -q "dataless"; then continue; fi',
      '  mkdir -p "$(dirname "$target")"',
      '  mode=$(stat -f "%Lp" "$target" 2>/dev/null || echo 600)',
      '  gid=$(stat -f "%g" "$target" 2>/dev/null || stat -f "%g" "$(dirname "$target")" 2>/dev/null || true)',
      '  mkdir -p "$tmp_root"',
      '  name=$(basename "$target")',
      '  tmp="$tmp_root/$name.part.$$"',
      '  rm -f "$tmp"',
      '  if "$rclone_bin" copyto "$cloud" "$tmp" --ignore-times --retries=1 --low-level-retries=1; then',
      '    chmod "$mode" "$tmp" >/dev/null 2>&1 || true',
      '    if [ -n "$gid" ]; then chgrp "$gid" "$tmp" >/dev/null 2>&1 || true; fi',
      '    target_state=$(ls -lO "$target" 2>/dev/null || true)',
      '    if [ -z "$target_state" ] || printf "%s\\n" "$target_state" | grep -q "dataless"; then',
      '      mv -f "$tmp" "$target"',
      '    else',
      '      rm -f "$tmp"',
      '    fi',
      '  else',
      '    rm -f "$tmp"',
      '  fi',
      `done <<'LT_PREFETCH_FILES'\n${lines}\nLT_PREFETCH_FILES`
    ].join('\n')
    await new Promise<void>((resolve) => {
      const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
      proc.on('error', () => resolve())
      proc.on('close', () => resolve())
    })
    const finishedAt = Date.now()
    for (const p of pairs) {
      remotePrefetching.delete(p.key)
      remotePrefetchedAt.set(p.key, finishedAt)
    }
  })().catch(() => {
    for (const p of pairs) remotePrefetching.delete(p.key)
  })
}
function sshArgs(profile: SshProfile): string[] {
  const args: string[] = []
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  args.push('-o', 'BatchMode=yes')
  args.push('-o', 'ConnectTimeout=20')
  args.push('-o', 'ServerAliveInterval=30')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${profile.user}@${profile.host}`)
  return args
}

async function hydrateRemoteFile(profileId: string, path: string): Promise<void> {
  const profile = await getProfile(profileId)
  const script = `
p=${shq(path)}
err="/tmp/legal-terminal-download-$$.err"
cleanup() { rm -f "$err"; }
trap cleanup EXIT

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
  await new Promise<void>((resolve, reject) => {
    const errs: Buffer[] = []
    const proc = spawn(sshBin, [...sshArgs(profile), script], { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('원격 OneDrive 다운로드 대기 시간이 초과되었습니다.'))
    }, REMOTE_CLOUD_HYDRATE_TIMEOUT_MS)
    proc.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(Buffer.concat(errs).toString('utf8').trim() || `ssh 종료 코드 ${code}`))
    })
  })
}

export async function rfsWriteText(uri: string, content: string): Promise<void> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(path, content, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
  )
  noteRemoteLocalMutation(posix.dirname(path))
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
  noteRemoteLocalMutation(path)
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
  await new Promise<void>((resolve, reject) =>
    sftp.mkdir(posix.join(path, name), (err) => (err ? reject(err) : resolve()))
  )
  noteRemoteLocalMutation(path)
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
  noteRemoteLocalMutation(path)
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
    noteRemoteLocalMutation(posix.dirname(src.path))
    noteRemoteLocalMutation(dest.path)
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
  const sftp = await getSftp(profileId)
  await removeRec(sftp, path)
  noteRemoteLocalMutation(posix.dirname(path))
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
