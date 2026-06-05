import { app } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import type { SshProfile } from './settings'

// claude Code 세션 transcript: ~/.claude/projects/<인코딩폴더>/<sessionId>.jsonl
// 폴더 인코딩이 비영숫자→'-'(한글 충돌)이라, 폴더명 계산 대신 transcript 내부 cwd로 매칭한다.
const projectsDir = join(homedir(), '.claude', 'projects')
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
type SshConn = Pick<SshProfile, 'host' | 'user' | 'port' | 'identityFile'>

interface TranscriptRef {
  file: string
  sessionId: string
  mtime: number
}

interface TranscriptHead {
  sessionId: string
  mtime: number
  head: string
}

export interface SessionListEntry {
  sessionId: string
  title?: string
  transcriptTitle?: string
  mtime: number
  cwd?: string
  displayTitle?: string
  caseNumber?: string
  caseName?: string
  folderName?: string
  indexed?: boolean
}

export interface SessionSearchContext {
  query?: string
  displayTitle?: string
  caseNumber?: string
  caseName?: string
  court?: string
  client?: string
  folderName?: string
  recordsFolder?: string
  profileId?: string
  sshLabel?: string
}

export interface SessionMetaInput extends SessionSearchContext {
  sessionId: string
  cwd: string
  title?: string
  transcriptTitle?: string
  mtime?: number
  ssh?: SshConn
}

export interface SessionTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface SessionTranscript {
  sessionId: string
  messages: SessionTranscriptMessage[]
  mtime: number
  truncated?: boolean
}

interface SessionMeta extends SessionMetaInput {
  key: string
  sourceKey: string
  updatedAt: string
  searchText: string
}

interface SessionIndex {
  version: number
  entries: SessionMeta[]
}

const SESSION_INDEX_VERSION = 1
const MAX_SESSION_INDEX_ENTRIES = 600
const REMOTE_TRANSCRIPT_SCAN_LIMIT = 1000
const MAX_SESSION_TRANSCRIPT_BYTES = 6 * 1024 * 1024
const MAX_REMOTE_TRANSCRIPT_BUFFER = Math.ceil(MAX_SESSION_TRANSCRIPT_BYTES * 1.5) + 1024 * 1024
const MAX_SESSION_HISTORY_MESSAGES = 100
const MAX_SESSION_MESSAGE_CHARS = 20000

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function sessionIndexPath(): string {
  return join(app.getPath('userData'), 'session-index.json')
}

function remoteSourceKey(ssh: SshConn): string {
  return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}`
}

function sourceKey(ssh?: SshConn): string {
  return ssh ? remoteSourceKey(ssh) : 'local'
}

function pathLeaf(path?: string): string | undefined {
  if (!path) return undefined
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean
}

function comparablePath(path?: string): string {
  if (!path) return ''
  const clean = path.trim().replace(/[\\/]+$/, '') || '/'
  return clean.normalize('NFKC')
}

function pathMatchesAny(candidate: string | undefined, aliases: Set<string>): boolean {
  const comparable = comparablePath(candidate)
  return !!comparable && aliases.has(comparable)
}

async function localCwdAliases(cwd: string): Promise<Set<string>> {
  const aliases = new Set([comparablePath(cwd)])
  try {
    aliases.add(comparablePath(await realpath(cwd)))
  } catch {
    /* The original cwd is still useful if the folder is unavailable. */
  }
  return aliases
}

function searchNorm(value?: string): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
}

function searchText(parts: (string | number | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== undefined && String(part).trim().length > 0)
    .map((part) => String(part).normalize('NFKC').toLowerCase())
    .join(' ')
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function safeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]{8,200}$/.test(sessionId)
}

function clipTranscriptText(text: string): string {
  if (text.length <= MAX_SESSION_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_SESSION_MESSAGE_CHARS)}\n\n[이전 세션 메시지가 길어 일부만 표시됩니다.]`
}

function sessionKey(sessionId: string, ssh?: SshConn): string {
  return `${sourceKey(ssh)}:${sessionId}`
}

function sameSource(meta: SessionMeta, ssh?: SshConn): boolean {
  return meta.sourceKey === sourceKey(ssh)
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SessionMeta>
  return (
    typeof v.key === 'string' &&
    typeof v.sourceKey === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.updatedAt === 'string' &&
    typeof v.searchText === 'string'
  )
}

async function readSessionIndex(): Promise<SessionMeta[]> {
  try {
    const raw = await readFile(sessionIndexPath(), 'utf8')
    const parsed = JSON.parse(raw) as SessionIndex
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isSessionMeta) : []
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    return []
  }
}

async function writeSessionIndex(entries: SessionMeta[]): Promise<void> {
  const file = sessionIndexPath()
  await mkdir(dirname(file), { recursive: true })
  const sorted = [...entries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSION_INDEX_ENTRIES)
  await writeFile(
    file,
    JSON.stringify({ version: SESSION_INDEX_VERSION, entries: sorted }, null, 2),
    'utf8'
  )
}

function buildSessionMeta(input: SessionMetaInput): SessionMeta {
  const folderName = input.folderName || pathLeaf(input.cwd)
  const key = sessionKey(input.sessionId, input.ssh)
  return {
    ...input,
    key,
    sourceKey: sourceKey(input.ssh),
    folderName,
    updatedAt: new Date().toISOString(),
    searchText: searchText([
      input.sessionId,
      input.title,
      input.transcriptTitle,
      input.displayTitle,
      input.caseNumber,
      input.caseName,
      input.court,
      input.client,
      folderName,
      input.cwd,
      input.recordsFolder,
      input.profileId,
      input.sshLabel,
      input.ssh?.host,
      input.ssh?.user
    ])
  }
}

export async function rememberSessionMeta(input: SessionMetaInput): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!input.sessionId || !input.cwd) return { ok: false, error: '세션 ID와 cwd가 필요합니다.' }
    const nextMeta = buildSessionMeta(input)
    const entries = await readSessionIndex()
    const previous = entries.find((entry) => entry.key === nextMeta.key)
    const merged: SessionMeta = previous
      ? buildSessionMeta({
          ...previous,
          ...input,
          displayTitle: input.displayTitle || previous.displayTitle,
          title: input.title || previous.title,
          transcriptTitle: input.transcriptTitle || previous.transcriptTitle,
          mtime: input.mtime ?? previous.mtime,
          folderName: input.folderName || previous.folderName,
          ssh: input.ssh || previous.ssh
        })
      : nextMeta
    await writeSessionIndex([merged, ...entries.filter((entry) => entry.key !== merged.key)])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

function matchIndexedSession(
  meta: SessionMeta,
  cwd: string,
  context?: SessionSearchContext,
  cwdAliases = new Set([comparablePath(cwd)])
): boolean {
  if (pathMatchesAny(meta.cwd, cwdAliases)) return true
  const needles = [
    context?.query,
    context?.caseNumber,
    context?.caseName,
    context?.folderName,
    context?.displayTitle
  ].filter((value): value is string => !!value && value.trim().length > 0)
  if (!needles.length) return false

  if (context?.caseNumber && searchNorm(meta.caseNumber) === searchNorm(context.caseNumber)) return true
  const folderNeedle = searchNorm(context?.folderName)
  if (folderNeedle.length >= 2) {
    const folder = searchNorm(meta.folderName || pathLeaf(meta.cwd))
    if (folder.length >= 2 && (folder.includes(folderNeedle) || folderNeedle.includes(folder))) return true
  }
  const haystack = searchNorm(meta.searchText)
  return needles.every((needle) => haystack.includes(searchNorm(needle)))
}

function decorateSession(
  session: { sessionId: string; title?: string; mtime: number; cwd?: string },
  meta?: SessionMeta,
  context?: SessionSearchContext
): SessionListEntry {
  const displayTitle = meta?.displayTitle || context?.displayTitle
  const transcriptTitle = session.title || meta?.transcriptTitle || meta?.title
  const title = displayTitle || meta?.title || transcriptTitle
  return {
    sessionId: session.sessionId,
    title,
    transcriptTitle,
    mtime: session.mtime || meta?.mtime || 0,
    cwd: session.cwd || meta?.cwd,
    displayTitle,
    caseNumber: meta?.caseNumber || context?.caseNumber,
    caseName: meta?.caseName || context?.caseName,
    folderName: meta?.folderName || context?.folderName,
    indexed: !!meta
  }
}

function sshBaseArgs(ssh: SshConn): string[] {
  const a: string[] = []
  if (ssh.port) a.push('-p', String(ssh.port))
  if (ssh.identityFile) a.push('-i', ssh.identityFile)
  a.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new')
  a.push(`${ssh.user}@${ssh.host}`)
  return a
}

async function remoteRealpath(ssh: SshConn, path: string): Promise<string | undefined> {
  const script = `cd ${shq(path)} 2>/dev/null && pwd -P`
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(ssh), script],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(undefined)
          return
        }
        resolve(stdout.trim() || undefined)
      }
    )
  })
}

async function remoteCwdAliases(ssh: SshConn, cwd: string): Promise<Set<string>> {
  const aliases = new Set([comparablePath(cwd)])
  const resolved = await remoteRealpath(ssh, cwd)
  if (resolved) aliases.add(comparablePath(resolved))
  return aliases
}

async function listTranscripts(): Promise<TranscriptRef[]> {
  const out: TranscriptRef[] = []
  let dirs
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = join(projectsDir, d.name)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const s = await stat(join(dir, f))
        out.push({ file: join(dir, f), sessionId: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs })
      } catch {
        /* skip */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// 파일 앞부분만 읽어 cwd·제목 파싱 (transcript는 클 수 있음)
async function readHead(file: string, bytes = 65536): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

interface TranscriptRead {
  content: string
  mtime: number
  truncated: boolean
}

async function readTail(file: string, bytes = MAX_SESSION_TRANSCRIPT_BYTES): Promise<TranscriptRead> {
  const s = await stat(file)
  const length = Math.min(s.size, bytes)
  const start = Math.max(0, s.size - length)
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return {
      content: buf.subarray(0, bytesRead).toString('utf8'),
      mtime: s.mtimeMs,
      truncated: start > 0
    }
  } finally {
    await fh.close()
  }
}

async function listRemoteTranscriptHeads(ssh: SshConn, bytes = 32768): Promise<TranscriptHead[]> {
  const script = `
root="$HOME/.claude/projects"
[ -d "$root" ] || exit 0
find "$root" -type f -name '*.jsonl' -print 2>/dev/null | while IFS= read -r f; do
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  id=\${f##*/}
  id=\${id%.jsonl}
  printf '%s\\t%s\\t%s\\n' "$m" "$id" "$f"
done | sort -rn | head -${REMOTE_TRANSCRIPT_SCAN_LIMIT} | while IFS="$(printf '\\t')" read -r m id f; do
  b64=$(head -c ${bytes} "$f" | base64 | tr -d '\\n\\r')
  printf '%s\\t%s\\t%s\\n' "$m" "$id" "$b64"
done
`.trim()
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(ssh), script],
      { timeout: 25000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        const out: TranscriptHead[] = []
        for (const raw of stdout.split(/\r?\n/)) {
          if (!raw.trim()) continue
          const [mtimeRaw, sessionId, b64] = raw.split('\t')
          if (!sessionId || !b64) continue
          const mtime = Number(mtimeRaw) * 1000
          try {
            out.push({
              sessionId,
              mtime: Number.isFinite(mtime) ? mtime : 0,
              head: Buffer.from(b64, 'base64').toString('utf8')
            })
          } catch {
            /* skip malformed line */
          }
        }
        resolve(out.sort((a, b) => b.mtime - a.mtime))
      }
    )
  })
}

async function readRemoteTranscript(ssh: SshConn, sessionId: string): Promise<TranscriptRead | null> {
  if (!safeSessionId(sessionId)) return null
  const script = `
sid=${shq(sessionId)}
root="$HOME/.claude/projects"
[ -d "$root" ] || exit 0
f=$(find "$root" -type f -name "$sid.jsonl" -print -quit 2>/dev/null)
[ -n "$f" ] || exit 0
size=$(wc -c < "$f" 2>/dev/null || echo 0)
m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
if [ "$size" -gt ${MAX_SESSION_TRANSCRIPT_BYTES} ]; then
  printf '1\\t%s\\t' "$m"
  tail -c ${MAX_SESSION_TRANSCRIPT_BYTES} "$f" | base64 | tr -d '\\n\\r'
else
  printf '0\\t%s\\t' "$m"
  cat "$f" | base64 | tr -d '\\n\\r'
fi
printf '\\n'
`.trim()
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(ssh), script],
      { timeout: 20000, windowsHide: true, maxBuffer: MAX_REMOTE_TRANSCRIPT_BUFFER },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
          return
        }
        const [truncatedRaw, mtimeRaw, b64] = stdout.trim().split('\t')
        if (!b64) {
          resolve(null)
          return
        }
        const mtime = Number(mtimeRaw) * 1000
        try {
          resolve({
            content: Buffer.from(b64, 'base64').toString('utf8'),
            mtime: Number.isFinite(mtime) ? mtime : 0,
            truncated: truncatedRaw === '1'
          })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

function extractTranscriptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = recordValue(block)
      if (!record) return ''
      const type = typeof record.type === 'string' ? record.type : ''
      if (type !== 'text') return ''
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

function parseTranscriptMessages(content: string, sessionId: string): SessionTranscriptMessage[] {
  const messages: SessionTranscriptMessage[] = []
  let lineIndex = 0
  for (const line of content.split('\n')) {
    lineIndex += 1
    if (!line.trim() || !line.includes('{')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.isMeta === true) continue
    const message = recordValue(entry.message)
    const roleValue = typeof message?.role === 'string' ? message.role : entry.type
    const role = roleValue === 'user' || roleValue === 'assistant' ? roleValue : undefined
    if (!role || !message) continue
    const text = extractTranscriptText(message.content).trim()
    if (!text) continue
    messages.push({
      id: `${sessionId}-history-${lineIndex}`,
      role,
      text: clipTranscriptText(text)
    })
  }
  return messages.slice(-MAX_SESSION_HISTORY_MESSAGES)
}

export async function readSessionTranscript(
  sessionId: string,
  ssh?: SshConn
): Promise<SessionTranscript | null> {
  if (!sessionId || !safeSessionId(sessionId)) return null
  const transcript = ssh
    ? await readRemoteTranscript(ssh, sessionId)
    : await (async (): Promise<TranscriptRead | null> => {
        const ref = (await listTranscripts()).find((item) => item.sessionId === sessionId)
        if (!ref) return null
        return readTail(ref.file)
      })()
  if (!transcript) return null
  return {
    sessionId,
    messages: parseTranscriptMessages(transcript.content, sessionId),
    mtime: transcript.mtime,
    truncated: transcript.truncated
  }
}

function parseHead(content: string): { cwd?: string; title?: string } {
  let cwd: string | undefined
  let aiTitle: string | undefined
  let firstUser: string | undefined
  for (const line of content.split('\n')) {
    if (!line.trim() || !line.includes('{')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') aiTitle = d.aiTitle
    if (!firstUser && d.type === 'user') {
      const m = d.message as { content?: unknown } | undefined
      const c = m?.content
      if (typeof c === 'string') firstUser = c
      else if (Array.isArray(c))
        firstUser = c
          .filter((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'text')
          .map((x) => (x as { text?: string }).text ?? '')
          .join(' ')
    }
  }
  const title = aiTitle || (firstUser ? firstUser.trim().slice(0, 40) : undefined)
  return { cwd, title }
}

// 주어진 cwd의 모든 과거 claude 세션 목록 (최신순). 제목·시각 포함.
export async function listSessions(
  cwd: string,
  limit = 40,
  ssh?: SshConn,
  context?: SessionSearchContext
): Promise<SessionListEntry[]> {
  const indexed = await readSessionIndex()
  const cwdAliases = ssh ? await remoteCwdAliases(ssh, cwd) : await localCwdAliases(cwd)
  const indexedByKey = new Map(
    indexed.filter((meta) => sameSource(meta, ssh)).map((meta) => [meta.sessionId, meta])
  )
  const out: SessionListEntry[] = []
  const seen = new Set<string>()
  const push = (entry: SessionListEntry): void => {
    if (seen.has(entry.sessionId) || out.length >= limit) return
    seen.add(entry.sessionId)
    out.push(entry)
  }

  if (ssh) {
    const ts = await listRemoteTranscriptHeads(ssh)
    for (const t of ts) {
      if (out.length >= limit) break
      const p = parseHead(t.head)
      if (p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
        push(
          decorateSession(
            { sessionId: t.sessionId, title: p.title, mtime: t.mtime, cwd: p.cwd },
            indexedByKey.get(t.sessionId),
            context
          )
        )
      }
    }
    for (const meta of indexed) {
      if (out.length >= limit) break
      if (!sameSource(meta, ssh) || !matchIndexedSession(meta, cwd, context, cwdAliases)) continue
      push(
        decorateSession(
          {
            sessionId: meta.sessionId,
            title: meta.transcriptTitle || meta.title,
            mtime: meta.mtime ?? Date.parse(meta.updatedAt),
            cwd: meta.cwd
          },
          meta,
          context
        )
      )
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }
  const ts = await listTranscripts()
  for (const t of ts) {
    if (out.length >= limit) break
    let head: string
    try {
      head = await readHead(t.file)
    } catch {
      continue
    }
    const p = parseHead(head)
    if (p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
      push(
        decorateSession(
          { sessionId: t.sessionId, title: p.title, mtime: t.mtime, cwd: p.cwd },
          indexedByKey.get(t.sessionId),
          context
        )
      )
    }
  }
  for (const meta of indexed) {
    if (out.length >= limit) break
    if (!sameSource(meta, ssh) || !matchIndexedSession(meta, cwd, context, cwdAliases)) continue
    push(
      decorateSession(
        {
          sessionId: meta.sessionId,
          title: meta.transcriptTitle || meta.title,
          mtime: meta.mtime ?? Date.parse(meta.updatedAt),
          cwd: meta.cwd
        },
        meta,
        context
      )
    )
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// 주어진 cwd의 claude 세션 제목. since가 주어지면 그 시각 이후 갱신된 transcript만 본다
// (터미널을 연 뒤 시작된 세션 = 현재 세션. 과거 세션 제목이 잡히는 것을 방지).
export async function currentSession(
  cwd: string,
  since = 0,
  ssh?: SshConn
): Promise<{ sessionId: string; title?: string } | null> {
  const cwdAliases = ssh ? await remoteCwdAliases(ssh, cwd) : await localCwdAliases(cwd)
  if (ssh) {
    const ts = await listRemoteTranscriptHeads(ssh)
    for (const t of ts) {
      if (since && t.mtime < since) continue
      const p = parseHead(t.head)
      if (p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
        return { sessionId: t.sessionId, title: p.title }
      }
    }
    return null
  }
  const ts = await listTranscripts()
  for (const t of ts) {
    if (since && t.mtime < since) continue // 과거 세션 제외
    let head: string
    try {
      head = await readHead(t.file)
    } catch {
      continue
    }
    const p = parseHead(head)
    if (p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
      return { sessionId: t.sessionId, title: p.title }
    }
  }
  return null
}
