import { app } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import type { SshProfile } from './settings'
import {
  buildCaseActivity,
  buildFolderActivity,
  comparablePath,
  pathLeaf,
  searchNorm,
  type CaseActivity,
  type CaseActivityQuery,
  type FolderActivity
} from './caseActivityData'
import {
  daysFromTranscriptContent,
  mergeWorkLog,
  type DayActivity,
  type SessionDayScan,
  type WorkLogDay,
  type WorkLogScanSource
} from './workLogData'
import { allJsPairings } from './caseStore'
import { getSettings } from './settings'

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

interface ParsedHead {
  cwd?: string
  aiTitle?: string
  fallbackTitle?: string
  title?: string
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
  // 앱이 대화 맥락으로 직접 생성한 세션 제목 (transcript ai-title이 없는 SDK 세션용)
  generatedTitle?: string
  // 앱이 자동 생성한 "한 일/다음 할 일" 요약 — 사건 대시보드 표시용
  workSummary?: string
  workSummaryAt?: number
  workSummaryAtTurn?: number
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

function parseSessionIndex(text: string): SessionMeta[] | null {
  try {
    const parsed = JSON.parse(text) as SessionIndex
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isSessionMeta) : []
  } catch {
    return null
  }
}

async function readSessionIndex(): Promise<SessionMeta[]> {
  let raw: string
  try {
    raw = await readFile(sessionIndexPath(), 'utf8')
  } catch {
    return []
  }
  const direct = parseSessionIndex(raw)
  if (direct) return direct
  // 구버전의 비원자 쓰기가 겹치면 유효한 JSON 뒤에 이전 내용 조각이 남는다.
  // 최상위 닫는 중괄호(pretty-print 기준 "\n}")까지만 잘라 복구를 시도한다.
  const end = raw.indexOf('\n}')
  if (end > 0) {
    const salvaged = parseSessionIndex(raw.slice(0, end + 2))
    if (salvaged) return salvaged
  }
  return []
}

async function writeSessionIndex(entries: SessionMeta[]): Promise<void> {
  const file = sessionIndexPath()
  await mkdir(dirname(file), { recursive: true })
  const sorted = [...entries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSION_INDEX_ENTRIES)
  // temp+rename 원자 쓰기 — 앱 인스턴스 두 개(설치본+dev)가 동시에 쓰면
  // 파일이 부분 덮어쓰기로 깨져 인덱스 전체가 유실되는 것을 막는다.
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(
    tmp,
    JSON.stringify({ version: SESSION_INDEX_VERSION, entries: sorted }, null, 2),
    'utf8'
  )
  await rename(tmp, file)
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
      input.generatedTitle,
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
          generatedTitle: input.generatedTitle || previous.generatedTitle,
          workSummary: input.workSummary || previous.workSummary,
          workSummaryAt: input.workSummaryAt ?? previous.workSummaryAt,
          workSummaryAtTurn: input.workSummaryAtTurn ?? previous.workSummaryAtTurn,
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
  session: { sessionId: string; title?: string; aiTitle?: string; mtime: number; cwd?: string },
  meta?: SessionMeta,
  context?: SessionSearchContext
): SessionListEntry {
  const displayTitle = meta?.displayTitle || context?.displayTitle
  // 세션 고유 제목: AI 생성 제목(transcript ai-title → 앱 생성) 우선, 첫 사용자 메시지는 최후 수단
  const transcriptTitle =
    session.aiTitle || meta?.generatedTitle || session.title || meta?.transcriptTitle || meta?.title
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

const TITLE_MAX_CHARS = 48

function truncateTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= TITLE_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, TITLE_MAX_CHARS)}…`
}

// 첫 사용자 메시지에서 제목 후보 추출. 내부 태그·명령 래퍼·fork 프리앰블은
// 건너뛰거나(undefined) 정리해서, "<local-command-caveat>…" 같은 원문이 제목이 되지 않게 한다.
function userTitleCandidate(raw: string): string | undefined {
  let text = raw
  // 슬래시 명령 세션: 명령 이름을 그대로 제목으로
  const command = /<command-name>\s*([^<\n]+?)\s*<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>\s*([^<\n]*?)\s*<\/command-args>/.exec(text)?.[1]
    return truncateTitle([command[1], args].filter(Boolean).join(' '))
  }
  // 로컬 명령 출력·caveat 안내는 대화 내용이 아니므로 다음 사용자 메시지를 기다린다
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>/.test(text)) return undefined
  // fork/전환으로 주입된 transcript 프리앰블도 실제 지시가 아니다
  if (/원본 대화 transcript입니다|진행하던 대화 transcript입니다/.test(text)) return undefined
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return truncateTitle(text)
}

function transcriptEntryUserText(d: Record<string, unknown>): string | undefined {
  const m = d.message as { content?: unknown } | undefined
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .filter((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'text')
      .map((x) => (x as { text?: string }).text ?? '')
      .join(' ')
  return undefined
}

function parseHead(content: string): ParsedHead {
  let cwd: string | undefined
  let aiTitle: string | undefined
  let fallbackTitle: string | undefined
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
    if (!fallbackTitle && d.type === 'user' && d.isMeta !== true) {
      const text = transcriptEntryUserText(d)
      if (text) fallbackTitle = userTitleCandidate(text)
    }
  }
  return { cwd, aiTitle, fallbackTitle, title: aiTitle || fallbackTitle }
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
            { sessionId: t.sessionId, title: p.fallbackTitle, aiTitle: p.aiTitle, mtime: t.mtime, cwd: p.cwd },
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
            title: meta.generatedTitle || meta.transcriptTitle || meta.title,
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
          { sessionId: t.sessionId, title: p.fallbackTitle, aiTitle: p.aiTitle, mtime: t.mtime, cwd: p.cwd },
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
          title: meta.generatedTitle || meta.transcriptTitle || meta.title,
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

// 사건 대시보드용: 세션 인덱스를 사건별로 그룹핑해 최근 작업을 돌려준다.
// transcript 스캔 없이 인덱스 1회 + pairing 1회 읽기라 저렴하다.
export async function listSessionsByCase(q: CaseActivityQuery): Promise<Record<string, CaseActivity>> {
  if (!q?.cases?.length) return {}
  const [entries, pairings] = await Promise.all([readSessionIndex(), allJsPairings()])
  return buildCaseActivity(entries, pairings, q)
}

// 사건 대시보드: 어떤 사건에도 안 붙은 세션을 폴더별로 묶어 돌려준다.
export async function listFolderActivity(q: CaseActivityQuery): Promise<FolderActivity[]> {
  const [entries, pairings] = await Promise.all([readSessionIndex(), allJsPairings()])
  return buildFolderActivity(entries, pairings, q ?? { cases: [] })
}

// ── 날짜별 작업일지: 트랜스크립트 타임스탬프를 스캔해 세션을 날짜별로 쪼갠다 ──
// 세션 인덱스(마지막 활동 시각)만으로는 여러 날에 걸친 작업이 마지막 날에만 보이고,
// 인덱스가 유실돼도 트랜스크립트는 남아 있으므로 파일을 직접 스캔한다.

const WORK_LOG_SCAN_VERSION = 2 // 지시 정리 규칙이 바뀌면 올린다 (캐시 전체 재스캔)
const REMOTE_WORK_LOG_TTL_MS = 10 * 60_000
const REMOTE_WORK_LOG_TIMEOUT_MS = 25_000

interface WorkLogScanCacheEntry {
  mtime: number
  cwd?: string
  days: DayActivity[]
}

function workLogCachePath(): string {
  return join(app.getPath('userData'), 'worklog-scan.json')
}

async function readWorkLogScanCache(): Promise<Record<string, WorkLogScanCacheEntry>> {
  try {
    const parsed = JSON.parse(await readFile(workLogCachePath(), 'utf8')) as {
      version?: number
      local?: Record<string, WorkLogScanCacheEntry>
    }
    return parsed.version === WORK_LOG_SCAN_VERSION && parsed.local ? parsed.local : {}
  } catch {
    return {}
  }
}

async function writeWorkLogScanCache(local: Record<string, WorkLogScanCacheEntry>): Promise<void> {
  try {
    const file = workLogCachePath()
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: WORK_LOG_SCAN_VERSION, local }), 'utf8')
    await rename(tmp, file)
  } catch {
    /* 캐시 저장 실패는 다음 스캔이 조금 느려질 뿐이다. */
  }
}

// 로컬 트랜스크립트 스캔 — 파일 mtime이 안 바뀐 세션은 캐시를 재사용한다.
async function scanLocalWorkLog(days: number): Promise<SessionDayScan[]> {
  const cutoff = Date.now() - days * 86_400_000
  const [refs, cache] = await Promise.all([listTranscripts(), readWorkLogScanCache()])
  const nextCache: Record<string, WorkLogScanCacheEntry> = {}
  const out: SessionDayScan[] = []
  let changed = false
  for (const ref of refs) {
    if (ref.mtime < cutoff) continue
    const cached = cache[ref.sessionId]
    if (cached && cached.mtime === ref.mtime) {
      nextCache[ref.sessionId] = cached
      out.push({ sessionId: ref.sessionId, cwd: cached.cwd, days: cached.days })
      continue
    }
    try {
      const read = await readTail(ref.file)
      const scan = daysFromTranscriptContent(read.content)
      const entry: WorkLogScanCacheEntry = { mtime: ref.mtime, cwd: scan.cwd, days: scan.days }
      nextCache[ref.sessionId] = entry
      changed = true
      if (scan.days.length) out.push({ sessionId: ref.sessionId, cwd: scan.cwd, days: scan.days })
    } catch {
      /* 깨진 파일은 건너뛴다 */
    }
  }
  if (changed || Object.keys(cache).length !== Object.keys(nextCache).length) {
    await writeWorkLogScanCache(nextCache)
  }
  return out
}

// 원격 트랜스크립트 스캔 — 파일을 내려받지 않고 원격에서 python3로 집계해 JSON만 받는다.
const remoteWorkLogCache = new Map<string, { fetchedAt: number; sessions: SessionDayScan[] }>()

function remoteWorkLogScript(days: number): string {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days)))
  return `
command -v python3 >/dev/null 2>&1 || exit 0
python3 - <<'PY'
import json, os, glob, re, datetime
ROOT = os.path.expanduser('~/.claude/projects')
CUTOFF = datetime.datetime.now().timestamp() - ${windowDays} * 86400
NOISE = {'/usage','/context','/cost','/compact','/clear','/exit','/login','/logout','/model','/status','/help','/doctor','/resume'}
def clean(t):
    t = (t or '').strip()
    if not t: return None
    if t.lower() in NOISE: return None
    m = re.search(r'<command-name>\\s*([^<\\n]+?)\\s*</command-name>', t)
    if m:
        if m.group(1).strip().lower() in NOISE: return None
        a = re.search(r'<command-args>\\s*([^<\\n]*?)\\s*</command-args>', t)
        arg = a.group(1).strip() if a else ''
        return (m.group(1) + (' ' + arg if arg else '')).strip()
    if re.search(r'<local-command-caveat>|<local-command-stdout>|<command-message>', t): return None
    if t.startswith('[Request interrupted'): return None
    if 'transcript입니다' in t: return None
    t = re.sub(r'<system-reminder>[\\s\\S]*?</system-reminder>', ' ', t)
    t = re.sub(r'<ide_selection>[\\s\\S]*?</ide_selection>', ' ', t)
    t = re.sub(r'</?[A-Za-z][A-Za-z0-9_-]*>', ' ', t)
    t = re.sub(r'\\s+', ' ', t).strip()
    return t or None
def text_of(msg):
    c = (msg or {}).get('content')
    if isinstance(c, str): return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return None
out = []
for f in glob.glob(ROOT + '/*/*.jsonl'):
    try:
        if os.path.getmtime(f) < CUTOFF: continue
        sid = os.path.basename(f)[:-6]
        cwd = None
        days = {}
        with open(f, encoding='utf-8', errors='ignore') as fh:
            for line in fh:
                if '"type":"user"' not in line and (cwd or '"cwd"' not in line): continue
                try: d = json.loads(line)
                except Exception: continue
                if cwd is None and isinstance(d.get('cwd'), str): cwd = d['cwd']
                if d.get('type') != 'user' or d.get('isMeta') is True or d.get('isSidechain') is True: continue
                ts = d.get('timestamp')
                if not isinstance(ts, str): continue
                try: dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone()
                except Exception: continue
                t = clean(text_of(d.get('message')))
                if not t: continue
                key = dt.strftime('%Y-%m-%d')
                ms = int(dt.timestamp() * 1000)
                e = days.get(key)
                if e:
                    e['count'] += 1
                    e['lastTs'] = max(e['lastTs'], ms)
                else:
                    days[key] = {'date': key, 'count': 1, 'firstText': t[:200], 'lastTs': ms}
        if days:
            out.append({'sessionId': sid, 'cwd': cwd, 'days': sorted(days.values(), key=lambda x: x['date'])})
    except Exception:
        pass
print(json.dumps(out, ensure_ascii=False))
PY
`.trim()
}

async function scanRemoteWorkLog(ssh: SshConn, days: number): Promise<SessionDayScan[]> {
  const key = remoteSourceKey(ssh)
  const cached = remoteWorkLogCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < REMOTE_WORK_LOG_TTL_MS) return cached.sessions
  const sessions = await new Promise<SessionDayScan[]>((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(ssh), remoteWorkLogScript(days)],
      { timeout: REMOTE_WORK_LOG_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]') as SessionDayScan[]
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch {
          resolve([])
        }
      }
    )
  })
  if (sessions.length) remoteWorkLogCache.set(key, { fetchedAt: Date.now(), sessions })
  return sessions
}

// 날짜별 작업일지: 로컬+원격 트랜스크립트 스캔을 합치고, 스캔이 닿지 못한 세션은 인덱스로 폴백.
export async function listWorkLog(days = 30): Promise<WorkLogDay[]> {
  const [entries, settings, local] = await Promise.all([
    readSessionIndex(),
    getSettings().catch(() => ({}) as { sshProfiles?: SshProfile[] }),
    scanLocalWorkLog(days)
  ])
  const scans: WorkLogScanSource[] = [{ sourceKey: 'local', sessions: local }]
  const profiles = settings.sshProfiles ?? []
  const remotes = await Promise.all(
    profiles.map(async (p) => ({
      sourceKey: remoteSourceKey(p),
      profileId: p.id,
      sshLabel: p.label,
      sessions: await scanRemoteWorkLog(p, days).catch(() => [])
    }))
  )
  scans.push(...remotes.filter((r) => r.sessions.length))
  return mergeWorkLog(scans, entries, Date.now(), days)
}

// 주어진 cwd의 claude 세션 제목. since가 주어지면 그 시각 이후 갱신된 transcript만 본다
// (터미널을 연 뒤 시작된 세션 = 현재 세션. 과거 세션 제목이 잡히는 것을 방지).
// ai-title 없는 SDK 세션은 앱이 생성해 인덱스에 저장한 제목으로 보완한다.
async function resolveSessionTitle(
  sessionId: string,
  parsed: ParsedHead,
  ssh?: SshConn
): Promise<string | undefined> {
  if (parsed.aiTitle) return parsed.aiTitle
  const indexed = await readSessionIndex()
  const meta = indexed.find((m) => m.sessionId === sessionId && sameSource(m, ssh))
  return meta?.generatedTitle || parsed.fallbackTitle || meta?.transcriptTitle
}

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
        return { sessionId: t.sessionId, title: await resolveSessionTitle(t.sessionId, p, ssh) }
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
      return { sessionId: t.sessionId, title: await resolveSessionTitle(t.sessionId, p) }
    }
  }
  return null
}
