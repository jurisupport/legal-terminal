import { Client, type SFTPWrapper, utils } from 'ssh2'
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
    const settings = await getSettings()
    const profile = (settings.sshProfiles ?? []).find((p) => p.id === profileId)
    if (!profile) throw new Error('SSH 프로필을 찾을 수 없습니다: ' + profileId)
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

// 디렉터리 목록. 심볼릭 링크는 stat으로 디렉터리 여부 확인.
export async function rfsList(uri: string): Promise<Entry[]> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  const list = await new Promise<{ filename: string; attrs: { mode: number; mtime?: number } }[]>(
    (resolve, reject) => sftp.readdir(path, (err, l) => (err ? reject(err) : resolve(l as never)))
  )
  const out: Entry[] = []
  for (const e of list) {
    if (e.filename.startsWith('.')) continue
    const remotePath = posix.join(path, e.filename)
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
  out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
  )
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
  return await new Promise<Buffer>((resolve, reject) =>
    sftp.readFile(path, (err, buf) => (err ? reject(err) : resolve(buf as Buffer)))
  )
}

export async function rfsWriteText(uri: string, content: string): Promise<void> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(path, content, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
  )
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
  return makeRemote(profileId, full)
}

export async function rfsStat(
  uri: string
): Promise<{ size: number; isDir: boolean; mtimeMs?: number }> {
  const { profileId, path } = parseRemote(uri)
  const sftp = await getSftp(profileId)
  return await new Promise((resolve, reject) =>
    sftp.stat(path, (err, st) =>
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
  const out: { name: string; path: string }[] = []
  await walk(sftp, profileId, path, out, 0)
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
