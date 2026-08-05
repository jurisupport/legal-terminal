import { app } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import type { SshProfile } from './settings'
import { buildSshArgs } from './sshOptions'
import {
  computeSearchText,
  fromRemoteLocalForm,
  isSessionMetaRecord,
  mergeMetaEntries,
  toRemoteLocalForm,
  type SessionMetaRecord
} from './sessionSyncData'
import {
  buildCaseActivity,
  buildFolderActivity,
  comparablePath,
  pathLeaf,
  searchNorm,
  type CaseActivity,
  type CaseActivityMetaLike,
  type CaseActivityQuery,
  type FolderActivity
} from './caseActivityData'
import {
  cleanUserInstruction,
  daysFromTranscriptContent,
  mergeWorkLog,
  type DayActivity,
  type SessionDayScan,
  type WorkLogDay,
  type WorkLogScanSource
} from './workLogData'
import { allCasePairingRecords, allJsPairings, mergeCasePairingRecords } from './caseStore'
import { tokenUsageFromTranscript, type TranscriptTokenUsage } from './agent/tokenUsage'
import {
  CASE_PAIRING_FILE_VERSION,
  MAX_CASE_PAIRING_ENTRIES,
  fromRemoteLocalCaseForm,
  isCasePairingRecord,
  toRemoteLocalCaseForm,
  type CasePairingRecord
} from './caseSyncData'
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
  model?: string
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

// 세션 인덱스는 기기 공유 경로(~/.claude)에 둔다 — 같은 호스트에서 직접 실행한 앱과
// 다른 컴퓨터에서 SSH로 접속한 앱(원격 동기화 스크립트)이 같은 파일을 보게 하기 위함.
function sessionIndexPath(): string {
  return join(homedir(), '.claude', 'legal-terminal-sessions.json')
}

// 구버전 경로(userData/session-index.json) — 최초 1회 새 파일에 병합 후 치운다.
function legacySessionIndexPath(): string {
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

function hasNoiseTranscriptTitle(meta: Pick<SessionMeta, 'transcriptTitle'>): boolean {
  return !!meta.transcriptTitle && !cleanUserInstruction(meta.transcriptTitle)
}

function parseSessionIndex(text: string): SessionMeta[] | null {
  try {
    const parsed = JSON.parse(text) as SessionIndex
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter(isSessionMeta).filter((entry) => !hasNoiseTranscriptTitle(entry))
      : []
  } catch {
    return null
  }
}

async function readIndexFile(file: string): Promise<SessionMeta[]> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
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

// 인덱스 읽기-수정-쓰기를 프로세스 안에서 직렬화한다. 앱 시작 시 이관·원격 풀·메타 저장이
// 동시에 돌면 늦게 끝난 쪽이 빈(또는 옛) 스냅샷 기준으로 저장해 인덱스가 통째로 유실될 수 있다.
let indexChain: Promise<unknown> = Promise.resolve()

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn)
  indexChain = run.catch(() => undefined)
  return run
}

// 구경로(userData) 인덱스를 공유 경로로 병합 — 프로세스당 1회.
// .migrated 백업도 함께 재병합해, 과거에 이관이 꼬여 공유 인덱스가 비었더라도 자가 복구된다.
let legacyMergePromise: Promise<void> | null = null

function mergeLegacyIndexOnce(): Promise<void> {
  if (!legacyMergePromise) {
    legacyMergePromise = withIndexLock(async () => {
      const legacyFile = legacySessionIndexPath()
      const [current, legacy, backup] = await Promise.all([
        readIndexFile(sessionIndexPath()),
        readIndexFile(legacyFile),
        readIndexFile(`${legacyFile}.migrated`)
      ])
      if (!legacy.length && !backup.length) return
      const { entries, changed } = mergeMetaEntries(current as unknown as SessionMetaRecord[], [
        ...legacy,
        ...backup
      ] as unknown as SessionMetaRecord[])
      if (changed) await writeSessionIndex(entries as unknown as SessionMeta[])
      if (legacy.length) {
        // 구파일은 삭제하지 않고 백업 이름으로 옮겨 자가 복구 재료로 남긴다.
        try {
          await rename(legacyFile, `${legacyFile}.migrated`)
        } catch {
          await unlink(legacyFile).catch(() => {})
        }
      }
    })
  }
  return legacyMergePromise
}

// 주의: withIndexLock 안에서는 이 함수를 부르지 말 것(락 재진입 불가 — readIndexFile을 직접 사용).
async function readSessionIndex(): Promise<SessionMeta[]> {
  await mergeLegacyIndexOnce().catch(() => {})
  return readIndexFile(sessionIndexPath())
}

async function writeSessionIndex(entries: SessionMeta[]): Promise<void> {
  const file = sessionIndexPath()
  await mkdir(dirname(file), { recursive: true })
  const sorted = entries
    .filter((entry) => !hasNoiseTranscriptTitle(entry))
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
    searchText: computeSearchText({ ...input, folderName } as Record<string, unknown>)
  }
}

export async function rememberSessionMeta(raw: SessionMetaInput): Promise<{ ok: boolean; error?: string }> {
  try {
    // undefined 필드는 "값 없음"이지 "지워라"가 아니다 — 스프레드 병합에서 기존 사건 연결
    // (caseNumber 등)을 덮어쓰지 않도록 키 자체를 제거한다.
    const input = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== undefined)
    ) as SessionMetaInput
    if (!input.sessionId || !input.cwd) return { ok: false, error: '세션 ID와 cwd가 필요합니다.' }
    await mergeLegacyIndexOnce().catch(() => {})
    // 읽기-병합-쓰기를 락으로 묶어 동시 저장(터미널 여러 개·원격 풀)이 서로를 덮어쓰지 않게 한다.
    await withIndexLock(async () => {
      const nextMeta = buildSessionMeta(input)
      const entries = await readIndexFile(sessionIndexPath())
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
    })
    // 원격 세션 메타는 그 호스트의 공유 인덱스에도 반영해 다른 기기에서 보이게 한다.
    if (input.ssh) scheduleRemoteIndexPush(input.ssh)
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

async function remoteRealpath(ssh: SshConn, path: string): Promise<string | undefined> {
  const script = `cd ${shq(path)} 2>/dev/null && pwd -P`
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...buildSshArgs(ssh, { usage: 'oneshot' }), script],
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

// ── 원격 세션 인덱스·사건 폴더 지정 동기화 ─────────────────────────────────
// 각 SSH 호스트의 ~/.claude/legal-terminal-sessions.json(세션 메타)과
// ~/.claude/legal-terminal-cases.json(사건→폴더 지정)이 그 호스트 데이터의 원본이다.
// 이 기기가 기록한 그 호스트의 항목을 stdin으로 밀어 넣으면(푸시) 원격이 병합·저장한 뒤
// 전체 항목을 돌려주고(풀), 그것을 로컬에 합친다 — 파일당 SSH 왕복 1회로 양방향 동기화.

const REMOTE_INDEX_SYNC_TTL_MS = 45_000
const REMOTE_INDEX_PUSH_DEBOUNCE_MS = 3_000
const REMOTE_INDEX_SYNC_TIMEOUT_MS = 20_000
const MAX_REMOTE_INDEX_OUTPUT_BYTES = 8 * 1024 * 1024

// 병합 규칙은 sessionSyncData.mergeMetaPair와 동일해야 한다:
// updatedAt이 새로운 쪽 기본 + 빈 필드는 옛 항목에서 채움, 정렬·개수 제한 포함.
function remoteIndexMergeCommand(): string {
  const py = `
import json, os, sys
path = os.path.expanduser("~/.claude/legal-terminal-sessions.json")
REQUIRED = ("key", "sourceKey", "sessionId", "cwd", "updatedAt", "searchText")
def valid(entry):
    return isinstance(entry, dict) and all(isinstance(entry.get(k), str) for k in REQUIRED)
def load():
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return []
    entries = data.get("entries") if isinstance(data, dict) else None
    return [e for e in entries if valid(e)] if isinstance(entries, list) else []
try:
    incoming = json.load(sys.stdin)
except Exception:
    incoming = []
if not isinstance(incoming, list):
    incoming = []
by = {e["key"]: e for e in load()}
for e in incoming:
    if not valid(e):
        continue
    old = by.get(e["key"])
    if old is None:
        by[e["key"]] = e
        continue
    newer, older = (e, old) if e["updatedAt"] >= old["updatedAt"] else (old, e)
    merged = dict(newer)
    for k, v in older.items():
        cur = merged.get(k)
        if (cur is None or cur == "") and v is not None:
            merged[k] = v
    by[e["key"]] = merged
entries = sorted(by.values(), key=lambda x: x["updatedAt"], reverse=True)[:${MAX_SESSION_INDEX_ENTRIES}]
tmp = path + "." + str(os.getpid()) + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump({"version": ${SESSION_INDEX_VERSION}, "entries": entries}, fh, ensure_ascii=False)
os.replace(tmp, path)
sys.stdout.write(json.dumps(entries, ensure_ascii=False))
`.trim()
  return [
    'mkdir -p "$HOME/.claude" 2>/dev/null',
    'command -v python3 >/dev/null 2>&1 || exit 0',
    `python3 -c ${shq(py)}`
  ].join('\n')
}

// 사건→폴더 지정 병합 스크립트 — 규칙은 caseSyncData.mergeCasePair와 동일해야 한다:
// updatedAt이 새로운 쪽이 이기고, records는 drafts가 같을 때만 옛 항목에서 보충.
function remoteCaseMergeCommand(): string {
  const py = `
import json, os, sys
path = os.path.expanduser("~/.claude/legal-terminal-cases.json")
REQUIRED = ("key", "drafts", "updatedAt")
def valid(entry):
    if not (isinstance(entry, dict) and all(isinstance(entry.get(k), str) for k in REQUIRED)):
        return False
    rec = entry.get("records")
    return rec is None or isinstance(rec, str)
def load():
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return []
    entries = data.get("entries") if isinstance(data, dict) else None
    return [e for e in entries if valid(e)] if isinstance(entries, list) else []
try:
    incoming = json.load(sys.stdin)
except Exception:
    incoming = []
if not isinstance(incoming, list):
    incoming = []
by = {e["key"]: e for e in load()}
for e in incoming:
    if not valid(e):
        continue
    old = by.get(e["key"])
    if old is None:
        by[e["key"]] = e
        continue
    newer, older = (e, old) if e["updatedAt"] >= old["updatedAt"] else (old, e)
    merged = dict(newer)
    if not merged.get("records") and older.get("records") and older.get("drafts") == merged.get("drafts"):
        merged["records"] = older["records"]
    by[e["key"]] = merged
entries = sorted(by.values(), key=lambda x: x["updatedAt"], reverse=True)[:${MAX_CASE_PAIRING_ENTRIES}]
tmp = path + "." + str(os.getpid()) + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump({"version": ${CASE_PAIRING_FILE_VERSION}, "entries": entries}, fh, ensure_ascii=False)
os.replace(tmp, path)
sys.stdout.write(json.dumps(entries, ensure_ascii=False))
`.trim()
  return [
    'mkdir -p "$HOME/.claude" 2>/dev/null',
    'command -v python3 >/dev/null 2>&1 || exit 0',
    `python3 -c ${shq(py)}`
  ].join('\n')
}

// 푸시 항목을 stdin으로 보내고 병합된 원격 파일 전체를 배열로 받는다.
// 실패(오프라인·python3 없음·타임아웃)는 null — 항목 검증은 호출부에서 한다.
function execRemoteJsonExchange(
  ssh: SshConn,
  command: string,
  payload: unknown
): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), command], { windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let outBytes = 0
    let settled = false
    const finish = (value: unknown[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(null)
    }, REMOTE_INDEX_SYNC_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_REMOTE_INDEX_OUTPUT_BYTES) {
        proc.kill()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    proc.stderr?.resume()
    proc.on('error', () => finish(null))
    proc.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8')
      if (code !== 0 || !out.trim()) {
        finish(null)
        return
      }
      try {
        const parsed = JSON.parse(out) as unknown
        finish(Array.isArray(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
    proc.stdin?.on('error', () => {
      /* python3 없음 등으로 원격이 먼저 종료하면 EPIPE — close에서 처리된다. */
    })
    proc.stdin?.end(JSON.stringify(payload))
  })
}

interface RemoteIndexSyncState {
  lastSyncAt: number
  inflight: Promise<void> | null
  pushTimer: NodeJS.Timeout | null
}

const remoteIndexSyncStates = new Map<string, RemoteIndexSyncState>()

function remoteIndexSyncState(ssh: SshConn): RemoteIndexSyncState {
  const key = remoteSourceKey(ssh)
  let state = remoteIndexSyncStates.get(key)
  if (!state) {
    state = { lastSyncAt: 0, inflight: null, pushTimer: null }
    remoteIndexSyncStates.set(key, state)
  }
  return state
}

async function findSshProfile(ssh: SshConn): Promise<SshProfile | undefined> {
  const settings = await getSettings().catch(() => ({}) as { sshProfiles?: SshProfile[] })
  return settings.sshProfiles?.find(
    (p) => p.host === ssh.host && p.user === ssh.user && (p.port ?? 22) === (ssh.port ?? 22)
  )
}

async function runRemoteIndexSync(ssh: SshConn): Promise<void> {
  const profile = await findSshProfile(ssh)
  await Promise.all([
    runRemoteSessionExchange(ssh, profile),
    runRemoteCaseExchange(ssh, profile)
  ])
}

async function runRemoteSessionExchange(ssh: SshConn, profile?: SshProfile): Promise<void> {
  const srcKey = remoteSourceKey(ssh)
  const local = await readSessionIndex()
  // 매번 이 소스의 전체 항목을 푸시한다 — 이전 푸시가 유실됐어도 다음 동기화가 복구한다.
  const push = local
    .filter((meta) => meta.sourceKey === srcKey)
    .map((meta) => toRemoteLocalForm(meta as unknown as SessionMetaRecord))
  const remoteEntries = (await execRemoteJsonExchange(ssh, remoteIndexMergeCommand(), push))?.filter(
    isSessionMetaRecord
  )
  if (!remoteEntries) return
  const conn: SshConn = {
    host: ssh.host,
    user: ssh.user,
    port: ssh.port,
    identityFile: ssh.identityFile
  }
  const pulled = remoteEntries
    .map((entry) =>
      fromRemoteLocalForm(entry, {
        sourceKey: srcKey,
        ssh: conn as unknown as Record<string, unknown>,
        profileId: profile?.id,
        sshLabel: profile?.label
      })
    )
    .filter((entry): entry is SessionMetaRecord => !!entry)
  if (!pulled.length) return
  // 풀 병합도 락 안에서 — remember와 동시에 돌 때 서로의 항목을 덮어쓰지 않게 한다.
  await withIndexLock(async () => {
    const current = await readIndexFile(sessionIndexPath())
    const { entries, changed } = mergeMetaEntries(current as unknown as SessionMetaRecord[], pulled)
    if (changed) await writeSessionIndex(entries as unknown as SessionMeta[])
  })
}

// 사건→폴더 지정도 같은 왕복으로 동기화한다. remote:<프로필id>:… 키 변환에
// 프로필 id가 필요하므로, 저장된 프로필이 없는 즉석 접속은 건너뛴다.
async function runRemoteCaseExchange(ssh: SshConn, profile?: SshProfile): Promise<void> {
  if (!profile?.id) return
  const local = await allCasePairingRecords()
  const push = local
    .map((rec) => toRemoteLocalCaseForm(rec, profile.id))
    .filter((rec): rec is CasePairingRecord => !!rec)
  const remoteEntries = await execRemoteJsonExchange(ssh, remoteCaseMergeCommand(), push)
  if (!remoteEntries) return
  const pulled = remoteEntries
    .filter(isCasePairingRecord)
    .map((rec) => fromRemoteLocalCaseForm(rec, profile.id))
    .filter((rec): rec is CasePairingRecord => !!rec)
  if (pulled.length) await mergeCasePairingRecords(pulled)
}

// TTL 안이면 재사용, 동시 호출은 한 번만 실행. 실패해도 다음 TTL에 재시도한다.
export function syncRemoteSessionIndex(
  ssh: SshConn,
  maxAgeMs = REMOTE_INDEX_SYNC_TTL_MS
): Promise<void> {
  const state = remoteIndexSyncState(ssh)
  if (state.inflight) return state.inflight
  if (Date.now() - state.lastSyncAt < maxAgeMs) return Promise.resolve()
  state.lastSyncAt = Date.now()
  state.inflight = runRemoteIndexSync(ssh)
    .catch(() => {
      /* 오프라인이면 다음 TTL에 재시도 — 로컬 인덱스만으로도 동작한다. */
    })
    .finally(() => {
      state.inflight = null
    })
  return state.inflight
}

// 메타 저장 직후의 잦은 왕복을 피하려고 몇 초 모아 1회 푸시한다.
function scheduleRemoteIndexPush(ssh: SshConn): void {
  const state = remoteIndexSyncState(ssh)
  if (state.pushTimer) clearTimeout(state.pushTimer)
  const conn: SshConn = {
    host: ssh.host,
    user: ssh.user,
    port: ssh.port,
    identityFile: ssh.identityFile
  }
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null
    void syncRemoteSessionIndex(conn, 0)
  }, REMOTE_INDEX_PUSH_DEBOUNCE_MS)
  state.pushTimer.unref?.()
}

// 저장된 모든 SSH 프로필과 동기화 (사건 대시보드·작업일지 조회 시 배경 갱신용).
export async function syncAllRemoteSessionIndexes(
  maxAgeMs = REMOTE_INDEX_SYNC_TTL_MS
): Promise<void> {
  const settings = await getSettings().catch(() => ({}) as { sshProfiles?: SshProfile[] })
  await Promise.all(
    (settings.sshProfiles ?? []).map((p) => syncRemoteSessionIndex(p, maxAgeMs).catch(() => {}))
  )
}

function pairingKeyProfile(id: string): Promise<SshProfile | undefined> {
  if (!id.startsWith('remote:')) return Promise.resolve(undefined)
  const profileId = id.slice('remote:'.length).split(':')[0]
  if (!profileId) return Promise.resolve(undefined)
  return getSettings()
    .then((s) => s.sshProfiles?.find((p) => p.id === profileId))
    .catch(() => undefined)
}

// 원격 사건의 폴더 지정을 읽기 전에 그 호스트와 한 번 동기화한다(TTL 안이면 즉시 반환).
// 첫 조회가 호스트 응답을 오래 기다리지 않도록 timeoutMs에서 끊는다 — 동기화는 배경에서 계속된다.
export async function ensureRemoteCasePairingFresh(id: string, timeoutMs = 4000): Promise<void> {
  const profile = await pairingKeyProfile(id)
  if (!profile) return
  await Promise.race([
    syncRemoteSessionIndex(profile).catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
  ])
}

// 폴더 지정 저장 직후 해당 호스트로 푸시를 예약한다 (case:setJsPairing IPC에서 호출).
export async function scheduleCasePairingPush(id: string): Promise<void> {
  const profile = await pairingKeyProfile(id)
  if (profile) scheduleRemoteIndexPush(profile)
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
      [...buildSshArgs(ssh, { usage: 'oneshot' }), script],
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
      [...buildSshArgs(ssh, { usage: 'oneshot' }), script],
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

function parseTranscriptMessages(
  content: string,
  sessionId: string
): { messages: SessionTranscriptMessage[]; model?: string } {
  const messages: SessionTranscriptMessage[] = []
  let model: string | undefined
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
    if (role === 'assistant') model = typeof message.model === 'string' ? message.model : model
    const text = extractTranscriptText(message.content).trim()
    const visibleText = role === 'user' ? cleanUserInstruction(text) : text
    if (!visibleText) continue
    messages.push({
      id: `${sessionId}-history-${lineIndex}`,
      role,
      text: clipTranscriptText(visibleText)
    })
  }
  return { messages: messages.slice(-MAX_SESSION_HISTORY_MESSAGES), model }
}

export async function readSessionTranscript(
  sessionId: string,
  ssh?: SshConn
): Promise<SessionTranscript | null> {
  if (!sessionId || !safeSessionId(sessionId)) return null
  const transcript = await readTranscript(sessionId, ssh)
  if (!transcript) return null
  return {
    sessionId,
    ...parseTranscriptMessages(transcript.content, sessionId),
    mtime: transcript.mtime,
    truncated: transcript.truncated
  }
}

async function readTranscript(sessionId: string, ssh?: SshConn): Promise<TranscriptRead | null> {
  if (!safeSessionId(sessionId)) return null
  if (ssh) return readRemoteTranscript(ssh, sessionId)
  const ref = (await listTranscripts()).find((item) => item.sessionId === sessionId)
  return ref ? readTail(ref.file) : null
}

export async function readSessionTokenUsage(
  sessionId: string,
  ssh?: SshConn
): Promise<TranscriptTokenUsage | undefined> {
  const transcript = await readTranscript(sessionId, ssh)
  return transcript ? tokenUsageFromTranscript(transcript.content, transcript.mtime) : undefined
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
  const text = cleanUserInstruction(raw)
  return text ? truncateTitle(text) : undefined
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
  // 목록을 열 때 원격 인덱스와 동기화해, 다른 기기가 기록한 제목·사건 연결·요약을 먼저 당겨온다.
  // transcript 헤더 스캔과 병렬이라 추가 대기는 거의 없다. 인덱스는 동기화 후에 읽는다.
  const remoteHeads = ssh
    ? await Promise.all([listRemoteTranscriptHeads(ssh), syncRemoteSessionIndex(ssh)]).then(
        ([heads]) => heads
      )
    : []
  const indexed = await readSessionIndex()
  const cwdAliases = ssh ? await remoteCwdAliases(ssh, cwd) : await localCwdAliases(cwd)
  const indexedByKey = new Map(
    indexed.filter((meta) => sameSource(meta, ssh)).map((meta) => [meta.sessionId, meta])
  )
  const out: SessionListEntry[] = []
  const seen = new Set<string>()
  const hidden = new Set<string>()
  const push = (entry: SessionListEntry): void => {
    if (seen.has(entry.sessionId) || out.length >= limit) return
    seen.add(entry.sessionId)
    out.push(entry)
  }

  if (ssh) {
    for (const t of remoteHeads) {
      if (out.length >= limit) break
      const p = parseHead(t.head)
      if (p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
        if (!p.title) {
          hidden.add(t.sessionId)
          continue
        }
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
      if (
        hidden.has(meta.sessionId) ||
        !sameSource(meta, ssh) ||
        !matchIndexedSession(meta, cwd, context, cwdAliases)
      ) continue
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
      if (!p.title) {
        hidden.add(t.sessionId)
        continue
      }
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
    if (
      hidden.has(meta.sessionId) ||
      !sameSource(meta, ssh) ||
      !matchIndexedSession(meta, cwd, context, cwdAliases)
    ) continue
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
// 인덱스 + transcript 스캔(로컬 mtime 캐시, 원격 TTL 캐시)을 합쳐 작업일지와 같은 범위를 다룬다.
export async function listSessionsByCase(q: CaseActivityQuery): Promise<Record<string, CaseActivity>> {
  if (!q?.cases?.length) return {}
  // 원격 인덱스 동기화는 배경에서 — 이번 응답은 로컬 인덱스로 즉시, 다음 조회(TTL)가 신선해진다.
  void syncAllRemoteSessionIndexes()
  const [entries, pairings, scans] = await Promise.all([
    readSessionIndex(),
    allJsPairings(),
    collectWorkLogScans(30, false)
  ])
  // 인덱스에 없는 세션도 transcript 스캔에서 보완해 작업일지와 같은 범위를 다룬다.
  return buildCaseActivity([...entries, ...syntheticScanMetas(scans, entries)], pairings, q)
}

// 사건 대시보드: 어떤 사건에도 안 붙은 세션을 폴더별로 묶어 돌려준다.
export async function listFolderActivity(q: CaseActivityQuery): Promise<FolderActivity[]> {
  void syncAllRemoteSessionIndexes()
  const [entries, pairings, scans] = await Promise.all([
    readSessionIndex(),
    allJsPairings(),
    collectWorkLogScans(30, false)
  ])
  return buildFolderActivity(
    [...entries, ...syntheticScanMetas(scans, entries)],
    pairings,
    q ?? { cases: [] }
  )
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

const remoteWorkLogInflight = new Map<string, Promise<SessionDayScan[]>>()

async function scanRemoteWorkLog(ssh: SshConn, days: number): Promise<SessionDayScan[]> {
  const key = remoteSourceKey(ssh)
  const cached = remoteWorkLogCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < REMOTE_WORK_LOG_TTL_MS) return cached.sessions
  const inflight = remoteWorkLogInflight.get(key)
  if (inflight) return inflight
  const run = new Promise<SessionDayScan[]>((resolve) => {
    execFile(
      sshBin,
      [...buildSshArgs(ssh, { usage: 'oneshot' }), remoteWorkLogScript(days)],
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
    .then((sessions) => {
      if (sessions.length) remoteWorkLogCache.set(key, { fetchedAt: Date.now(), sessions })
      return sessions
    })
    .finally(() => {
      remoteWorkLogInflight.delete(key)
    })
  remoteWorkLogInflight.set(key, run)
  return run
}

// 캐시가 신선하면 그대로, 아니면 배경에서 갱신을 시작하고 옛 캐시(없으면 빈 목록)를 즉시 돌려준다.
// 사건 대시보드처럼 응답 지연이 곤란한 호출자용.
function cachedRemoteWorkLog(ssh: SshConn, days: number): Promise<SessionDayScan[]> {
  const cached = remoteWorkLogCache.get(remoteSourceKey(ssh))
  if (cached && Date.now() - cached.fetchedAt < REMOTE_WORK_LOG_TTL_MS) {
    return Promise.resolve(cached.sessions)
  }
  void scanRemoteWorkLog(ssh, days).catch(() => {})
  return Promise.resolve(cached?.sessions ?? [])
}

// 작업일지·사건별 이력 공용 transcript 스캔 수집.
// waitRemote=false면 원격 스캔은 캐시만 쓰고 만료 시 배경 갱신한다.
async function collectWorkLogScans(days: number, waitRemote: boolean): Promise<WorkLogScanSource[]> {
  const [settings, local] = await Promise.all([
    getSettings().catch(() => ({}) as { sshProfiles?: SshProfile[] }),
    scanLocalWorkLog(days)
  ])
  const scans: WorkLogScanSource[] = [{ sourceKey: 'local', sessions: local }]
  const remotes = await Promise.all(
    (settings.sshProfiles ?? []).map(async (p) => {
      // 트랜스크립트 스캔과 병렬로 원격 인덱스도 동기화 — 제목·요약·사건 연결이 함께 온다.
      const sessions = waitRemote
        ? await Promise.all([
            scanRemoteWorkLog(p, days).catch(() => [] as SessionDayScan[]),
            syncRemoteSessionIndex(p).catch(() => {})
          ]).then(([s]) => s)
        : await cachedRemoteWorkLog(p, days)
      return { sourceKey: remoteSourceKey(p), profileId: p.id, sshLabel: p.label, sessions }
    })
  )
  scans.push(...remotes.filter((r) => r.sessions.length))
  return scans
}

// 작업일지 스캔에는 있는데 인덱스에는 없는 세션(인덱스 유실분·앱 밖에서 돌린 세션)을
// 사건 매칭용 합성 메타로 만든다 — "작업일지엔 보이는데 사건 아래엔 없다"를 없앤다.
function syntheticScanMetas(
  scans: WorkLogScanSource[],
  indexed: SessionMeta[]
): CaseActivityMetaLike[] {
  const known = new Set(indexed.map((meta) => meta.sessionId))
  const out: CaseActivityMetaLike[] = []
  for (const source of scans) {
    for (const scan of source.sessions) {
      if (!scan.cwd || !scan.days.length || known.has(scan.sessionId)) continue
      const last = scan.days[scan.days.length - 1]
      out.push({
        sessionId: scan.sessionId,
        cwd: scan.cwd,
        updatedAt: new Date(last.lastTs).toISOString(),
        mtime: last.lastTs,
        title: last.firstText,
        folderName: pathLeaf(scan.cwd),
        profileId: source.profileId,
        sshLabel: source.sshLabel,
        matchByFolder: true
      })
    }
  }
  return out
}

// 날짜별 작업일지: 로컬+원격 트랜스크립트 스캔을 합치고, 스캔이 닿지 못한 세션은 인덱스로 폴백.
export async function listWorkLog(days = 30): Promise<WorkLogDay[]> {
  const scans = await collectWorkLogScans(days, true)
  // 인덱스는 원격 동기화(collectWorkLogScans 내)가 끝난 뒤 읽어야 방금 당겨온 제목·요약이 보인다.
  const entries = await readSessionIndex()
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
      if (p.title && p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
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
    if (p.title && p.cwd && pathMatchesAny(p.cwd, cwdAliases)) {
      return { sessionId: t.sessionId, title: await resolveSessionTitle(t.sessionId, p) }
    }
  }
  return null
}
