import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Terminal from './terminal/Terminal'
import AgentPanel, {
  DiffPreview,
  type AgentAttachmentRequest,
  type AgentDiffOpenRequest
} from './agent/AgentPanel'
import FileTree, { LT_PATH, sortEntries, type PendingCreateRequest, type SortMode } from './filetree/FileTree'
import PdfViewer, { type PdfViewStatus } from './viewer/PdfViewer'
import RecordViewer from './viewer/RecordViewer'
import { parseRecordFiles, type ParsedRecord, type OutlineItem } from './viewer/recordOutline'
import {
  IconExplorer,
  IconCases,
  IconTodos,
  IconViewer,
  IconSettings,
  IconNewFile,
  IconNewFolder,
  IconSync,
  IconWorkspace,
  IconSearch,
  IconSave
} from './icons/Icons'
import MarkdownEditor, {
  TEXT_SELECTION_OVERLAY_EVENT,
  type MarkdownDocumentPayload,
  type TextSelectionOverlayDetail
} from './editor/MarkdownEditor'
import { markdownToPlainText, writeMarkdownClipboard } from './markdownClipboard'
import FindBar from './search/FindBar'
import CasesDashboard from './dashboard/CasesDashboard'
import UpcomingHearings from './dashboard/UpcomingHearings'
import TodosDashboard from './dashboard/TodosDashboard'
import TodayTodos from './dashboard/TodayTodos'
import { cancelIfTerminalPointerDrag } from './dragGuard'
import type {
  AppSettings,
  AgentAttachment,
  JsCase,
  TodoTerminalContext,
  SessionListEntry,
  SessionRememberInput,
  SessionSearchContext,
  SshConn,
  SshProfile,
  RemoteEntry,
  DocumentTabPayload,
  TabPayload,
  WorkspaceDocTabPayload,
  WorkspaceEntry,
  WorkspaceLoadResult,
  WorkspaceSnapshot
} from './env'

type Mode = 'explorer' | 'cases' | 'viewer' | 'todos'
type DockSide = 'left' | 'right'

interface ActivityItem {
  id: Mode
  label: string
  Icon: (props: { size?: number }) => JSX.Element
}
const ACTIVITY: ActivityItem[] = [
  { id: 'explorer', label: '탐색기', Icon: IconExplorer },
  { id: 'cases', label: '사건', Icon: IconCases },
  { id: 'todos', label: '할일', Icon: IconTodos },
  { id: 'viewer', label: '기록뷰어', Icon: IconViewer }
]

const SORT_OPTIONS: { value: SortMode; label: string; title: string }[] = [
  { value: 'name-asc', label: '가나다↑', title: '가나다순' },
  { value: 'name-desc', label: '가나다↓', title: '가나다 역순' },
  { value: 'mtime-desc', label: '수정↓', title: '최근 수정순' },
  { value: 'mtime-asc', label: '수정↑', title: '오래된 수정순' }
]
const DEFAULT_SORT_MODE: SortMode = 'name-asc'

const CASE_OPEN_LOCAL = 'local'
const CASE_OPEN_REMOTE_PREFIX = 'remote:'
const SETTINGS_UPDATED_EVENT = 'lt:settings-updated'
const TAB_DND_TYPE = 'application/x-legal-terminal-tab'
const DEFAULT_TERM_FONT_SIZE = 13
const DEFAULT_MD_FONT_SIZE = 14
const DEFAULT_AGENT_FONT_SIZE = 13
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const APP_WINDOW_TITLE = 'legal-terminal'
const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"
const DEFAULT_NOTIFICATION_SOUND: NotificationSound = 'chime'
const DEFAULT_NOTIFICATION_VOLUME = 85

const MD_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '기본값 (D2Coding 고정폭)', value: '' },
  { label: '맑은 고딕 / Segoe UI', value: "'Malgun Gothic', 'Segoe UI', system-ui, sans-serif" },
  {
    label: 'Apple SD Gothic Neo',
    value: "'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif"
  },
  {
    label: 'Noto Sans KR',
    value: "'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif"
  },
  { label: '나눔고딕', value: "'Nanum Gothic', 'Malgun Gothic', system-ui, sans-serif" },
  { label: 'Cascadia Mono / Consolas', value: "'Cascadia Mono', Consolas, 'D2Coding', monospace" }
]

type NotificationSound = 'chime' | 'ding' | 'success' | 'bell' | 'none'

const NOTIFICATION_SOUND_OPTIONS: { label: string; value: NotificationSound }[] = [
  { label: '기본 차임', value: 'chime' },
  { label: '맑은 딩', value: 'ding' },
  { label: '완료 상승음', value: 'success' },
  { label: '강한 벨', value: 'bell' },
  { label: '소리 끔', value: 'none' }
]

interface NotificationTone {
  frequency: number
  start: number
  duration: number
  type?: OscillatorType
  gain?: number
}

const NOTIFICATION_TONES: Record<Exclude<NotificationSound, 'none'>, NotificationTone[]> = {
  chime: [
    { frequency: 880, start: 0, duration: 0.13, gain: 0.18 },
    { frequency: 1320, start: 0.12, duration: 0.17, gain: 0.16 }
  ],
  ding: [{ frequency: 1046.5, start: 0, duration: 0.24, gain: 0.19 }],
  success: [
    { frequency: 659.25, start: 0, duration: 0.11, gain: 0.16 },
    { frequency: 880, start: 0.1, duration: 0.12, gain: 0.17 },
    { frequency: 1174.66, start: 0.21, duration: 0.18, gain: 0.16 }
  ],
  bell: [
    { frequency: 740, start: 0, duration: 0.18, type: 'triangle', gain: 0.23 },
    { frequency: 1480, start: 0.02, duration: 0.14, type: 'sine', gain: 0.11 }
  ]
}

const normalizePasteForPty = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r')

const remoteCaseOpenTarget = (profileId: string): string => `${CASE_OPEN_REMOTE_PREFIX}${profileId}`
const caseOpenProfileId = (target?: string): string | undefined =>
  target?.startsWith(CASE_OPEN_REMOTE_PREFIX) ? target.slice(CASE_OPEN_REMOTE_PREFIX.length) : undefined
const resolveCaseOpenTarget = (target: string | undefined, profiles: SshProfile[]): string => {
  const profileId = caseOpenProfileId(target)
  return profileId && profiles.some((p) => p.id === profileId)
    ? remoteCaseOpenTarget(profileId)
    : CASE_OPEN_LOCAL
}
const clampFontSize = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed))
}
const resolveNotificationSound = (value?: string): NotificationSound =>
  NOTIFICATION_SOUND_OPTIONS.some((option) => option.value === value)
    ? (value as NotificationSound)
    : DEFAULT_NOTIFICATION_SOUND
const resolveSortMode = (value?: string): SortMode =>
  SORT_OPTIONS.some((option) => option.value === value) ? (value as SortMode) : DEFAULT_SORT_MODE
const clampNotificationVolume = (
  value: string | number | undefined,
  fallback = DEFAULT_NOTIFICATION_VOLUME
): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '')
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(100, Math.max(0, Math.round(parsed)))
}
const emitSettingsUpdated = (settings: AppSettings): void => {
  window.dispatchEvent(new CustomEvent<AppSettings>(SETTINGS_UPDATED_EVENT, { detail: settings }))
}

const sshConnFromProfile = (profile: SshProfile): SshConn => ({
  host: profile.host,
  user: profile.user,
  port: profile.port,
  identityFile: profile.identityFile
})

interface DocTab {
  id: string
  title: string
  kind: 'welcome' | 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'csv' | 'settings' | 'diff'
  path?: string
  diffId?: string
  side?: DockSide
}
/**
 * 터미널 1개 = 사건 1개.
 * cwd = 작성서류 폴더(claude 작업·탐색기 기준). recordsFolder = 소송기록 폴더(뷰어 기준, 별도 지정).
 */
interface TermTab {
  id: string
  title: string
  kind?: 'terminal' | 'agent'
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string // 페어링으로 추천된 소송기록 폴더 (사용자가 '열기' 눌러야 적용)
  suggestedRecordOptions?: FolderMatchSuggestion[]
  autoClaude?: boolean // 명시적으로 터미널을 열 때만 claude 자동 실행
  // JuriSupport 사건에서 연 세션의 메타 (자동 명명·사건별 필터용)
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  sessionTitle?: string // claude 세션 제목(ai-title) — transcript에서 자동 반영
  renamed?: boolean // 사용자가 직접 이름 변경 → 자동 반영 중단
  createdAt?: number // 세션 시작 시각 — 이 이후의 transcript만 현재 세션으로 매칭
  resumeSessionId?: string // 과거 세션 이어서 열기
  ssh?: SshConn // 주어지면 원격(SSH) 사건 — cwd는 원격 경로, claude도 원격에서 실행
  sshLabel?: string // 접속 프로필 이름 (탭 툴팁/표시용)
  profileId?: string // 원격 파일 패널 라우팅용 (ssh://<profileId>/<경로>)
  side?: DockSide
}

type WorkTabKind = 'doc' | 'terminal'
type WorkTabKey = `${WorkTabKind}:${string}`
type TermRunStatus = 'working' | 'done' | 'question'

interface FolderMatchSuggestion {
  path: string
  name: string
  reason: string
  score: number
}

const docSide = (tab?: DocTab): DockSide => tab?.side ?? 'left'
const termSide = (tab?: TermTab): DockSide => tab?.side ?? 'right'
const isAgentTab = (tab?: TermTab): boolean => tab?.kind === 'agent'
const otherSide = (side: DockSide): DockSide => (side === 'left' ? 'right' : 'left')
const docKey = (id: string): WorkTabKey => `doc:${id}`
const termKeyOf = (id: string): WorkTabKey => `terminal:${id}`
const parseWorkKey = (key: string): { kind: WorkTabKind; id: string } | null => {
  const split = key.indexOf(':')
  if (split < 0) return null
  const kind = key.slice(0, split)
  if (kind !== 'doc' && kind !== 'terminal') return null
  return { kind, id: key.slice(split + 1) }
}

const resolveClaudeTargetTab = (
  tabs: TermTab[],
  activeTermId: string,
  activeWorkBySide: Record<DockSide, string>
): TermTab | undefined => {
  const active = tabs.find((tab) => tab.id === activeTermId)
  if (active) return active
  for (const side of ['right', 'left'] as DockSide[]) {
    const parsed = parseWorkKey(activeWorkBySide[side] ?? '')
    if (parsed?.kind !== 'terminal') continue
    const visible = tabs.find((tab) => tab.id === parsed.id)
    if (visible) return visible
  }
  return tabs[0]
}

// 원격 파일 패널이 쓰는 ssh:// URI 빌더 (main의 remoteFs와 동일 스킴)
const remoteUri = (profileId: string, p: string): string =>
  'ssh://' + profileId + (p.startsWith('/') ? p : '/' + p)

const isRemotePath = (p?: string): p is string => !!p && p.startsWith('ssh://')
const parseRemoteUri = (uri: string): { profileId: string; path: string } | null => {
  if (!isRemotePath(uri)) return null
  const rest = uri.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { profileId: rest, path: '/' }
  return { profileId: rest.slice(0, slash), path: rest.slice(slash) }
}

const claudeReadablePath = (path: string, term?: TermTab): string => {
  const remote = parseRemoteUri(path)
  if (remote && term?.profileId === remote.profileId) return remote.path
  return path
}

const fileAccessNote = (path: string, term?: TermTab): string | undefined => {
  const remote = parseRemoteUri(path)
  if (remote && term?.profileId !== remote.profileId) {
    return '주의: 이 파일은 앱의 원격 URI입니다. 같은 SSH 프로필의 터미널에서 열려 있지 않으면 Claude가 직접 읽지 못할 수 있습니다.'
  }
  if (!remote && term?.ssh) {
    return '주의: 이 파일은 로컬 경로입니다. 현재 Claude가 원격 터미널에서 실행 중이면 원격에 같은 파일이 있어야 직접 읽을 수 있습니다.'
  }
  return undefined
}

const dirnameForClaudeContext = (path: string): string | undefined => {
  const remote = parseRemoteUri(path)
  if (remote) {
    const trimmed = remote.path.replace(/\/+$/, '')
    const slash = trimmed.lastIndexOf('/')
    return remoteUri(remote.profileId, slash > 0 ? trimmed.slice(0, slash) : '/')
  }
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash > 0 ? path.slice(0, slash) : undefined
}

const selectionContextFileName = (): string =>
  `.legal-terminal-claude-selection-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`

const formatCharCount = (count: number): string => new Intl.NumberFormat('ko-KR').format(count)

const formatFileMtime = (mtimeMs?: number): string =>
  mtimeMs ? new Date(mtimeMs).toLocaleString('ko-KR') : '알 수 없음'

function useRemoteFileVersion(path?: string, intervalMs = 2500): number {
  const [version, setVersion] = useState(0)
  const sigRef = useRef('')

  useEffect(() => {
    if (!isRemotePath(path)) return
    let alive = true
    const tick = (): void => {
      window.lt.fs
        .stat(path)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = `${s.size}:${s.mtimeMs ?? 0}`
          if (sigRef.current && sig !== sigRef.current) setVersion((v) => v + 1)
          sigRef.current = sig
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path, intervalMs])

  return version
}
interface CaseMeta {
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
}
interface CurrentCase {
  drafts: string
  records?: string
  name: string
  meta?: CaseMeta
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
  remotePath?: string
}

const WORKSPACE_VERSION = 1
const RESTORABLE_DOC_KINDS = new Set<DocTab['kind']>([
  'markdown',
  'mdview',
  'file',
  'pdf',
  'image',
  'hwp',
  'csv',
  'settings'
])

const isRestorableDocKind = (value: unknown): value is DocTab['kind'] =>
  typeof value === 'string' && RESTORABLE_DOC_KINDS.has(value as DocTab['kind'])

const normalizeDocKind = (kind: DocTab['kind'], path?: string): DocTab['kind'] =>
  kind === 'markdown' && path && MARKDOWN_EXT_RE.test(path) ? 'mdview' : kind

const isWorkspaceMode = (value: unknown): value is Mode =>
  value === 'explorer' || value === 'cases' || value === 'viewer' || value === 'todos'

const isWorkKey = (value: unknown): value is WorkTabKey =>
  typeof value === 'string' && parseWorkKey(value) !== null

const closestHTMLElement = (element: HTMLElement | null, selector: string): HTMLElement | null =>
  (element?.closest(selector) as HTMLElement | null) ?? null
const datasetSide = (value?: string): DockSide | undefined =>
  value === 'left' || value === 'right' ? value : undefined
const shouldFocusDocContainer = (target: HTMLElement): boolean =>
  !target.closest(
    'input, textarea, button, select, a, [contenteditable="true"], [role="button"], [role="textbox"], [tabindex]:not([tabindex="-1"])'
  )

const formatWorkspaceSavedAt = (savedAt: string): string => {
  const date = new Date(savedAt)
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString('ko-KR')
}

const describeWorkspaceEntry = (entry: WorkspaceEntry, index: number): string =>
  `${index + 1}. ${entry.label} · ${formatWorkspaceSavedAt(entry.savedAt)} · 문서 ${entry.docs}개 / 터미널 ${entry.terminals}개`

const pathLeaf = (path?: string): string | undefined => {
  if (!path) return undefined
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean
}

const normalizeRemoteQuickStartPaths = (paths: Array<string | undefined> = []): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const trimmed = path?.trim()
    if (!trimmed) continue
    const key = trimmed.replace(/\/+$/, '') || '/'
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

const remoteQuickStartInputValue = (paths?: string[]): string =>
  normalizeRemoteQuickStartPaths(paths).join('\n')

const remoteQuickStartInputToPaths = (value: string): string[] =>
  normalizeRemoteQuickStartPaths(value.split(/\r?\n/))

const joinStatus = (parts: (string | undefined | false)[]): string =>
  parts.filter((part): part is string => !!part).join(' · ')

const docKindStatus = (kind: DocTab['kind']): string | undefined => {
  switch (kind) {
    case 'welcome':
      return '시작하기'
    case 'settings':
      return '설정'
    case 'mdview':
    case 'markdown':
      return '문서'
    case 'pdf':
      return 'PDF'
    case 'image':
      return '이미지'
    case 'hwp':
      return 'HWP'
    case 'csv':
      return 'CSV'
    case 'diff':
      return '변경 비교'
    case 'file':
      return '파일'
  }
}

const pdfZoomLabel = (mode: PdfViewStatus['zoomMode']): string => {
  if (mode === 'fit_page') return '쪽맞춤'
  if (mode === 'fit_width') return '폭맞춤'
  return '사용자 배율'
}

const samePdfStatus = (a: PdfViewStatus | undefined, b: PdfViewStatus): boolean =>
  !!a &&
  a.page === b.page &&
  a.pages === b.pages &&
  a.zoomPct === b.zoomPct &&
  a.zoomMode === b.zoomMode &&
  a.cropOn === b.cropOn &&
  a.cropRatio === b.cropRatio

const describeDocStatus = (
  tab: DocTab | undefined,
  dirty: boolean,
  pdfStatus?: PdfViewStatus
): string | undefined => {
  if (!tab) return undefined
  if (tab.kind === 'welcome' || tab.kind === 'settings') return docKindStatus(tab.kind)
  if (tab.kind === 'pdf' && pdfStatus) {
    const pages = pdfStatus.pages || '…'
    return joinStatus([
      tab.title,
      `${pdfStatus.page}/${pages}쪽`,
      `${pdfStatus.zoomPct}%`,
      pdfZoomLabel(pdfStatus.zoomMode),
      pdfStatus.cropOn && `여백 ${Math.round(pdfStatus.cropRatio * 100)}%`
    ])
  }
  return joinStatus([tab.title, dirty ? '변경 있음' : docKindStatus(tab.kind)])
}

const describeCaseStatus = (term?: TermTab, currentCase?: CurrentCase | null): string | undefined => {
  const court = term?.court ?? currentCase?.meta?.court
  const caseNumber = term?.caseNumber ?? currentCase?.meta?.caseNumber
  const caseName = term?.caseName ?? currentCase?.meta?.caseName
  const label = [caseNumber, caseName].filter(Boolean).join(' ') || undefined
  return joinStatus([court, label || term?.title || currentCase?.name])
}

const describeRecordsStatus = (
  recordsFolder: string | undefined,
  suggestedRecords: string | undefined,
  hasCase: boolean
): string | undefined => {
  if (suggestedRecords) return '추천 소송기록 있음'
  if (recordsFolder) return '소송기록 연결됨'
  if (hasCase) return '소송기록 없음'
  return undefined
}

const describeTermStatus = (term: TermTab | undefined, status?: TermRunStatus): string | undefined => {
  if (!term) return undefined
  const agent = isAgentTab(term)
  const run =
    status === 'working'
      ? agent
        ? 'Agent 작업 중'
        : 'Claude 작업 중'
      : status === 'question'
        ? agent
          ? 'Agent 확인 대기'
          : 'Claude 질문 대기'
        : status === 'done'
          ? agent
            ? 'Agent 완료'
            : 'Claude 완료'
          : agent
            ? 'Agent 대기'
            : term.autoClaude
              ? 'Claude 대기'
              : '터미널 대기'
  const connection = term.ssh ? `원격 ${term.sshLabel ?? term.ssh.host}` : '로컬'
  return joinStatus([run, connection])
}

const windowTitlePart = (value?: string | null): string | undefined => {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed
}

const caseWindowTitlePart = (
  term?: TermTab,
  currentCase?: CurrentCase | null
): string | undefined => {
  const court = windowTitlePart(term?.court ?? currentCase?.meta?.court)
  const caseNumber = windowTitlePart(term?.caseNumber ?? currentCase?.meta?.caseNumber)
  const caseName = windowTitlePart(term?.caseName ?? currentCase?.meta?.caseName)
  const client = windowTitlePart(term?.client ?? currentCase?.meta?.client)
  const legalCore = [caseNumber, caseName, client].filter(Boolean).join(' ')
  const legalTitle = legalCore ? [court ? abbrevCourt(court) : undefined, legalCore].filter(Boolean).join(' ') : ''
  if (legalTitle) return legalTitle

  const folder = pathLeaf(term?.cwd ?? currentCase?.remotePath ?? currentCase?.drafts)
  return (
    windowTitlePart(term?.title) ??
    windowTitlePart(currentCase?.name) ??
    windowTitlePart(folder)
  )
}

const buildWindowTitle = (opts: {
  term?: TermTab
  currentCase?: CurrentCase | null
  doc?: DocTab
  docOnly: boolean
  termOnly: boolean
}): string => {
  const caseTitle = caseWindowTitlePart(opts.term, opts.currentCase)
  const docTitle =
    opts.doc && opts.doc.kind !== 'welcome' ? windowTitlePart(opts.doc.title) : undefined
  const context = opts.docOnly ? docTitle ?? caseTitle : opts.termOnly ? caseTitle : caseTitle ?? docTitle
  return context ? `${context} - ${APP_WINDOW_TITLE}` : APP_WINDOW_TITLE
}

const searchNorm = (value?: string): string =>
  (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')

const matchNorm = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFC')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.,()[\]{}·]+/g, '')

const fileNameFromPath = (path: string): string =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i
const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

const markdownRenameName = (title: string, currentName: string): string => {
  const next = title.trim()
  const ext = currentName.match(MARKDOWN_EXT_RE)?.[0]
  if (!next || !ext || MARKDOWN_EXT_RE.test(next) || FILE_EXT_RE.test(next)) return next
  return `${next}${ext}`
}

const docKindForPath = (path: string): DocTab['kind'] => {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/.test(lower)) return 'image'
  if (/\.(hwp|hwpx)$/.test(lower)) return 'hwp'
  if (/\.(md|markdown)$/.test(lower)) return 'mdview'
  if (lower.endsWith('.csv')) return 'csv'
  return 'file'
}

const replacePathPrefix = (
  value: string | undefined,
  from: string,
  to: string
): string | undefined => {
  if (!value) return value
  if (value === from) return to
  if (value.startsWith(from + '/')) return to + value.slice(from.length)
  if (value.startsWith(from + '\\')) return to + value.slice(from.length)
  return value
}

const matchesSearch = (parts: (string | number | undefined)[], query: string): boolean => {
  const tokens = query
    .split(/\s+/)
    .map(searchNorm)
    .filter(Boolean)
  if (!tokens.length) return true
  const haystack = searchNorm(
    parts
      .filter((part): part is string | number => part !== undefined && String(part).trim().length > 0)
      .join(' ')
  )
  return tokens.every((token) => haystack.includes(token))
}

const koreanSessionTitle = (source?: Partial<TermTab>): string | undefined => {
  if (!source) return undefined
  const court = source.court ? abbrevCourt(source.court) : undefined
  const legalTitle = [court, source.caseNumber, source.caseName, source.client].filter(Boolean).join(' ')
  return legalTitle || source.title
}

const sessionContextForTerm = (source?: TermTab, query = ''): SessionSearchContext | undefined => {
  if (!source && !query.trim()) return undefined
  return {
    query: query.trim() || undefined,
    displayTitle: koreanSessionTitle(source),
    caseNumber: source?.caseNumber,
    caseName: source?.caseName,
    court: source?.court,
    client: source?.client,
    folderName: pathLeaf(source?.cwd),
    recordsFolder: source?.recordsFolder,
    profileId: source?.profileId,
    sshLabel: source?.sshLabel
  }
}

const sessionRememberInput = (
  source: TermTab,
  sessionId: string,
  title?: string,
  mtime?: number
): SessionRememberInput => ({
  ...(sessionContextForTerm(source) ?? {}),
  sessionId,
  cwd: source.cwd,
  title: koreanSessionTitle(source) || title,
  transcriptTitle: title,
  mtime,
  ssh: source.ssh
})

const sessionListCache = new Map<string, SessionListEntry[]>()
const sessionListInflight = new Map<string, Promise<SessionListEntry[]>>()

const sessionListKey = (
  cwd: string,
  ssh?: SshConn,
  context?: SessionSearchContext
): string =>
  JSON.stringify({
    cwd,
    ssh: ssh
      ? {
          host: ssh.host,
          user: ssh.user,
          port: ssh.port ?? 22,
          identityFile: ssh.identityFile ?? ''
        }
      : null,
    context: context ?? null
  })

const cachedPastSessions = (
  cwd: string,
  source?: TermTab,
  query = ''
): SessionListEntry[] | undefined => {
  const context = sessionContextForTerm(source, query)
  return sessionListCache.get(sessionListKey(cwd, source?.ssh, context))
}

const loadPastSessions = (
  cwd: string,
  source?: TermTab,
  query = '',
  refresh = false
): Promise<SessionListEntry[]> => {
  const context = sessionContextForTerm(source, query)
  const key = sessionListKey(cwd, source?.ssh, context)
  if (!refresh) {
    const cached = sessionListCache.get(key)
    if (cached) return Promise.resolve(cached)
    const inflight = sessionListInflight.get(key)
    if (inflight) return inflight
  }
  const request = window.lt.sessions
    .list(cwd, source?.ssh, context)
    .then((entries) => {
      if (source) {
        entries.forEach((entry) => {
          void window.lt.sessions
            .remember(
              sessionRememberInput(
                source,
                entry.sessionId,
                entry.transcriptTitle || entry.title,
                entry.mtime
              )
            )
            .catch(() => {})
        })
      }
      sessionListCache.set(key, entries)
      return entries
    })
    .finally(() => {
      sessionListInflight.delete(key)
    })
  sessionListInflight.set(key, request)
  return request
}

const preloadPastSessions = (cwd?: string, source?: TermTab): void => {
  if (!cwd) return
  void loadPastSessions(cwd, source).catch(() => {})
}

const currentCaseSessionSource = (
  currentCase: CurrentCase | null | undefined,
  profiles: SshProfile[]
): TermTab | undefined => {
  if (!currentCase) return undefined
  const remote = parseRemoteUri(currentCase.drafts)
  const profileId = currentCase.profileId ?? remote?.profileId
  const savedProfile = profileId ? profiles.find((p) => p.id === profileId) : undefined
  const ssh = currentCase.ssh ?? (savedProfile ? sshConnFromProfile(savedProfile) : undefined)
  const cwd = currentCase.remotePath ?? remote?.path ?? currentCase.drafts
  return {
    id: '__current_case__',
    title: currentCase.name,
    kind: 'agent',
    cwd,
    recordsFolder: currentCase.records,
    autoClaude: true,
    jsId: currentCase.meta?.jsId,
    court: currentCase.meta?.court,
    caseNumber: currentCase.meta?.caseNumber,
    caseName: currentCase.meta?.caseName,
    client: currentCase.meta?.client,
    ssh,
    sshLabel: currentCase.sshLabel ?? savedProfile?.label,
    profileId,
    side: 'right'
  }
}

const todoContextForTerm = (term: TermTab): TodoTerminalContext => ({
  terminalId: term.id,
  cwd: term.cwd,
  jsId: term.jsId,
  court: term.court,
  caseNumber: term.caseNumber,
  caseName: term.caseName,
  client: term.client,
  opponent: term.opponent,
  partyNames: term.partyNames
})

const toWorkspaceDoc = (tab: DocTab): WorkspaceDocTabPayload | null => {
  if (!RESTORABLE_DOC_KINDS.has(tab.kind)) return null
  if (tab.kind !== 'settings' && !tab.path) return null
  return {
    id: tab.id,
    title: tab.title,
    kind: tab.kind as WorkspaceDocTabPayload['kind'],
    path: tab.path,
    side: docSide(tab)
  }
}

const toDocTab = (tab: WorkspaceDocTabPayload): DocTab | null => {
  if (!RESTORABLE_DOC_KINDS.has(tab.kind)) return null
  if (tab.kind !== 'settings' && !tab.path) return null
  return {
    id: tab.id || `file-${++docSeq}`,
    title: tab.title || tab.path?.split(/[\\/]/).pop() || '문서',
    kind: normalizeDocKind(tab.kind, tab.path),
    path: tab.path,
    side: tab.side ?? 'left'
  }
}

const docTabDragPayload = (tab: DocTab, side: DockSide = docSide(tab)): TabPayload | undefined => {
  if (!tab.path || !RESTORABLE_DOC_KINDS.has(tab.kind) || tab.kind === 'settings') return undefined
  const doc: DocumentTabPayload = {
    id: tab.id,
    title: tab.title,
    kind: normalizeDocKind(tab.kind, tab.path) as DocumentTabPayload['kind'],
    path: tab.path,
    side
  }
  return { kind: 'doc', tab: doc, path: doc.path, title: doc.title, side }
}

const sanitizeCurrentCase = (value: unknown): CurrentCase | null => {
  if (!value || typeof value !== 'object') return null
  const c = value as Partial<CurrentCase>
  if (typeof c.drafts !== 'string' || typeof c.name !== 'string') return null
  return {
    drafts: c.drafts,
    records: typeof c.records === 'string' ? c.records : undefined,
    name: c.name,
    meta: c.meta,
    ssh: c.ssh,
    sshLabel: typeof c.sshLabel === 'string' ? c.sshLabel : undefined,
    profileId: typeof c.profileId === 'string' ? c.profileId : undefined,
    remotePath: typeof c.remotePath === 'string' ? c.remotePath : undefined
  }
}

interface JuriSupportLegalPromptContext {
  caseId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
}

function buildJuriSupportLegalDocumentPrompt(
  doc: MarkdownDocumentPayload,
  context: JuriSupportLegalPromptContext
): string {
  const title = doc.title.replace(/\.[^.]+$/, '') || '문서'
  const caseLines = [
    context.caseId && `- caseId: ${context.caseId}`,
    context.court && `- 법원: ${context.court}`,
    context.caseNumber && `- 사건번호: ${context.caseNumber}`,
    context.caseName && `- 사건명: ${context.caseName}`,
    context.client && `- 의뢰인/당사자: ${context.client}`
  ].filter(Boolean)
  const caseBlock = caseLines.length
    ? caseLines.join('\n')
    : '- 현재 앱에서 연결된 JuriSupport 사건 ID를 확인하지 못했습니다. 먼저 list_cases 등으로 대상 사건을 확인하세요.'

  return `아래 Markdown 원본을 JuriSupport 소송문서(legal_document)로 정리해 주세요.

목표:
- Markdown은 사람이 읽고 편집하기 위한 원본입니다. 사용자에게 별도 변환용 문법을 요구하지 마세요.
- 원본 의미를 보존하되, JuriSupport MCP/API 규칙에 맞는 legal_document content, evidenceList, attachments로 분리하세요.
- 대상이 명확하면 create_legal_document 또는 update_legal_document/autosave_legal_document MCP 도구를 호출하세요.
- 기존 문서 ID가 필요하지만 원본/대화에서 특정되지 않으면 임의로 고르지 말고 먼저 짧게 확인하세요.

사건 컨텍스트:
${caseBlock}

문서 원본:
- 파일명: ${doc.title}
${doc.path ? `- 경로: ${doc.path}` : '- 경로: 미저장 문서'}
- 기본 제목 후보: ${title}

JuriSupport legal_document 작성 규칙:
- documentType은 원본에서 판단하세요. 가능한 값: complaint, accusation, brief, answer, appeal, supremeAppeal, correction, cause, modifiedCause, applicationReason, other.
- content에는 순수 본문만 넣으세요.
- content에 문서 제목, 사건번호, 법원, 당사자 표시, 대리인 표시, 입증방법/증거방법 목록, 첨부서류 목록, 날짜, 서명란, 법원 귀중을 중복으로 넣지 마세요.
- 원본의 번호 붙은 제목은 JuriSupport 에디터 개요 규칙에 맞게 h1/h2/h3 구조로 정리하고, 자동 번호와 중복될 수 있는 번호 텍스트는 제거하세요.
- 소송서류 본문은 공손한 서면체로 유지하세요.

서증 처리:
- 본문 안의 "갑 제1호증", "을 제2호증의1" 같은 raw 호증 문구는 content에 그대로 두지 말고 data-evidence-exhibit span으로 변환하세요.
- 새 서증 span 예: <span data-evidence-exhibit="true" data-side="갑" data-description="매매계약서" contenteditable="false"></span>
- 재인용 서증 span 예: <span data-evidence-exhibit="true" data-side="갑" data-is-reference="true" data-reference-main-number="1" data-description="매매계약서" contenteditable="false"></span>
- 새 서증의 evidenceList 항목은 mainNumber를 null로 두고, 본문 등장 순서와 evidenceList 순서를 맞추세요.
- 재인용은 isReference=true, referenceMainNumber를 사용하세요.
- 원본의 입증방법/증거방법 목록과 본문 인용이 불일치하면 MCP 도구를 호출하지 말고 불일치 항목을 질문하세요.

첨부서류 처리:
- 본문 안의 첨부서류 인용은 data-attachment-exhibit span으로 변환하세요.
- 새 첨부 span 예: <span data-attachment-exhibit="true" data-name="위임장" data-description="위임장" data-sub-description="2026. 4. 17.자" data-quantity="1통" contenteditable="false"></span>
- 재인용 첨부 span 예: <span data-attachment-exhibit="true" data-name="위임장" data-description="위임장" data-quantity="1통" data-is-reference="true" data-reference-attachment-number="1" contenteditable="false"></span>
- 새 첨부의 attachments 항목은 attachmentNumber를 null 또는 생략하고, 재인용 첨부는 includeInAttachmentList=false로 중복 목록 생성을 피하세요.
- 원본의 첨부서류 목록은 attachments로 분리하고 content에 목록을 중복 출력하지 마세요.

진행 방식:
- 애매한 서증/첨부/문서유형/대상 문서 ID가 있으면 먼저 확인 질문만 하세요.
- 애매하지 않으면 변환 요약을 한 번 보여준 뒤 MCP 도구를 호출하세요.

<markdown-source>
${doc.markdown}
</markdown-source>
`
}
// 법원명 약칭 (탭 제목 길이 절약)
function abbrevCourt(court: string): string {
  return court
    .replace('지방법원', '지법')
    .replace('고등법원', '고법')
    .replace('지원', '지원')
    .trim()
}

// 완료 알림음 (외부 파일 없이 WebAudio로 합성). 컨텍스트를 1개만 만들어 재사용하고
// 자동재생 정책 때문에 사용자 제스처(클릭)에서 resume 해 둔다.
let _actx: AudioContext | null = null
function getAudioCtx(): AudioContext | null {
  try {
    if (!_actx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      _actx = new Ctx()
    }
    if (_actx.state === 'suspended') void _actx.resume()
    return _actx
  } catch {
    return null
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => void getAudioCtx(), { capture: true })
}
function playNotificationSound(
  sound = DEFAULT_NOTIFICATION_SOUND,
  volume = DEFAULT_NOTIFICATION_VOLUME
): void {
  if (sound === 'none') return
  const volumeRatio = clampNotificationVolume(volume) / 100
  if (volumeRatio <= 0) return
  const ctx = getAudioCtx()
  if (!ctx) return
  const tones = NOTIFICATION_TONES[sound]
  const play = ({ frequency, start, duration, type = 'sine', gain = 0.16 }: NotificationTone): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.value = frequency
    o.connect(g)
    g.connect(ctx.destination)
    const t0 = ctx.currentTime + start
    const peak = Math.max(0.0001, gain * volumeRatio)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    o.start(t0)
    o.stop(t0 + duration + 0.02)
  }
  tones.forEach(play)
}

let docSeq = 0
const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${++docSeq}`

export default function App(): JSX.Element {
  const docOnly = window.location.hash.includes('docOnly')
  const termOnly = window.location.hash.includes('termOnly')
  const [mode, setMode] = useState<Mode>('explorer')
  const [bridgeStatus, setBridgeStatus] = useState<string>('')
  const [platform, setPlatform] = useState<string>('')
  const [selectionCharCount, setSelectionCharCount] = useState(0)

  const [docTabs, setDocTabs] = useState<DocTab[]>(() =>
    docOnly ? [] : [{ id: 'doc-welcome', title: '시작하기.md', kind: 'welcome', side: 'left' }]
  )
  const [agentDiffs, setAgentDiffs] = useState<Record<string, AgentDiffOpenRequest>>({})
  const [activeDoc, setActiveDoc] = useState<string>(() => (docOnly ? '' : 'doc-welcome'))
  // 닫으면 내용이 사라지는 문서(저장 안 된 새 문서) id 집합 — 닫기 전 확인용
  const [dirtyDocs, setDirtyDocs] = useState<Set<string>>(new Set())

  const [termTabs, setTermTabs] = useState<TermTab[]>([])
  const [activeTerm, setActiveTerm] = useState<string>('')
  const [agentAttachmentRequests, setAgentAttachmentRequests] = useState<Record<string, AgentAttachmentRequest[]>>({})
  const [termFocusNonce, setTermFocusNonce] = useState<Record<string, number>>({})
  const [termBracketedPasteMode, setTermBracketedPasteMode] = useState<Record<string, boolean>>({})
  const termBracketedPasteModeRef = useRef<Record<string, boolean>>({})
  termBracketedPasteModeRef.current = termBracketedPasteMode
  const termTabsRef = useRef<TermTab[]>([])
  const selectionAttachmentSeqRef = useRef(0)
  const rememberedSessionsRef = useRef<Set<string>>(new Set())
  const [activeWork, setActiveWork] = useState<Record<DockSide, string>>({
    left: docOnly ? '' : docKey('doc-welcome'),
    right: ''
  })
  const activeWorkRef = useRef(activeWork)
  activeWorkRef.current = activeWork
  const [draftsRoot, setDraftsRoot] = useState<string | undefined>()
  const [recordsRoot, setRecordsRoot] = useState<string | undefined>()
  const [caseOpenTarget, setCaseOpenTarget] = useState<string>(CASE_OPEN_LOCAL)
  const [notificationSound, setNotificationSound] =
    useState<NotificationSound>(DEFAULT_NOTIFICATION_SOUND)
  const [notificationVolume, setNotificationVolume] = useState(DEFAULT_NOTIFICATION_VOLUME)
  // SSH 접속 프로필 + 접속 선택/원격 폴더 선택 모달 상태
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([])
  const [connMenu, setConnMenu] = useState(false)
  const [remotePick, setRemotePick] = useState<SshProfile | null>(null)
  const [recordsPick, setRecordsPick] = useState<{
    profile: SshProfile
    draftsPath?: string
    title?: string
    startPath?: string
  } | null>(null)
  const [syncInit, setSyncInit] = useState<{
    profile: SshProfile
    macFolder: string
    folderLabel?: string
    directions?: 'both' | 'pull-only'
  } | null>(null)
  const [workspacePick, setWorkspacePick] = useState<{
    loading: boolean
    entries: WorkspaceEntry[]
    error?: string
  } | null>(null)

  // 활성 PDF의 목차 분류 결과 + 페이지 점프 신호
  const [pdfRecord, setPdfRecord] = useState<{ path: string; parsed: ParsedRecord } | null>(null)
  const [pdfStatus, setPdfStatus] = useState<Record<string, PdfViewStatus>>({})
  const [pdfJump, setPdfJump] = useState<{ page: number; nonce: number } | undefined>()
  const jumpNonce = useRef(0)


  // 소송기록 폴더의 PDF 파일명을 파싱한 분류 결과 (폴더 기반 기록)
  const [folderRecord, setFolderRecord] = useState<ParsedRecord | null>(null)

  // 여백 자르기는 앱 전역으로 유지 (문서 바꿔도 적용 지속)
  const [cropOn, setCropOn] = useState(false)
  const [cropRatio, setCropRatio] = useState(0.05)

  // 최근 사건 히스토리
  const [recent, setRecent] = useState<{ drafts: string; records?: string; name: string; ts: number }[]>(
    []
  )

  // 탐색기 트리 새로고침 트리거 (드래그드롭 복사 후)
  const [treeRefresh, setTreeRefresh] = useState(0)

  // 탐색기 인라인 생성 (VS Code식: 트리에 입력칸이 떠서 이름 입력)
  const [pendingCreate, setPendingCreate] = useState<PendingCreateRequest | null>(null)
  const closeActiveTermRef = useRef<() => void>(() => {})
  const closeActiveTabRef = useRef<() => void>(() => {})

  useEffect(() => {
    const applySettings = (s: AppSettings): void => {
      const profiles = s.sshProfiles ?? []
      setDraftsRoot(s.draftsRoot)
      setRecordsRoot(s.recordsRoot)
      setSshProfiles(profiles)
      setCaseOpenTarget(resolveCaseOpenTarget(s.caseOpenTarget, profiles))
      setNotificationSound(resolveNotificationSound(s.notificationSound))
      setNotificationVolume(clampNotificationVolume(s.notificationVolume))
    }
    window.lt?.app
      .info()
      .then((i) => {
        setPlatform(i.platform)
        setBridgeStatus('')
      })
      .catch(() => setBridgeStatus('preload 브리지 미연결'))
    window.lt?.settings.get().then(applySettings)
    window.lt?.case.history().then(setRecent)
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  termTabsRef.current = termTabs
  useEffect(() => {
    const killWindowTerms = (): void => {
      for (const t of termTabsRef.current) {
        if (isAgentTab(t)) void window.lt.agent.close(t.id)
        else window.lt.pty.kill(t.id)
      }
    }
    window.addEventListener('beforeunload', killWindowTerms)
    return () => window.removeEventListener('beforeunload', killWindowTerms)
  }, [])

  useEffect(() => window.lt.app.onCloseActiveTab(() => closeActiveTabRef.current()), [])

  const setWorkActive = useCallback((side: DockSide, key: WorkTabKey): void => {
    setActiveWork((active) => ({ ...active, [side]: key }))
  }, [])
  const focusedWorkSide = (element = document.activeElement as HTMLElement | null): DockSide | undefined =>
    datasetSide(closestHTMLElement(element, '[data-work-side]')?.dataset.workSide)
  const focusedTermId = (element = document.activeElement as HTMLElement | null): string | undefined =>
    closestHTMLElement(element, '[data-term-id]')?.dataset.termId
  const focusedDocId = (element = document.activeElement as HTMLElement | null): string | undefined =>
    closestHTMLElement(element, '[data-doc-id]')?.dataset.docId
  const activateDocTab = (id: string): void => {
    const tab = docTabs.find((t) => t.id === id)
    setActiveDoc(id)
    setWorkActive(docSide(tab), docKey(id))
  }
  const openAgentDiff = useCallback(
    (request: AgentDiffOpenRequest): void => {
      const id = `agent-diff-${request.id}`
      setAgentDiffs((diffs) => ({ ...diffs, [request.id]: request }))
      setDocTabs((tabs) => {
        const existing = tabs.find((tab) => tab.kind === 'diff' && tab.diffId === request.id)
        if (existing) {
          return tabs.map((tab) =>
            tab.id === existing.id ? { ...tab, title: request.title, side: 'left' } : tab
          )
        }
        return [...tabs, { id, title: request.title, kind: 'diff', diffId: request.id, side: 'left' }]
      })
      setMode('explorer')
      setActiveDoc(id)
      setWorkActive('left', docKey(id))
    },
    [setWorkActive]
  )
  const activateTermTab = (id: string): void => {
    const tab = termTabs.find((t) => t.id === id)
    setActiveTerm(id)
    setWorkActive(termSide(tab), termKeyOf(id))
  }
  const moveDocToSide = (id: string, side: DockSide): void => {
    setDocTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, side } : t)))
    setActiveDoc(id)
    setWorkActive(side, docKey(id))
  }
  const moveTermToSide = (id: string, side: DockSide): void => {
    setTermTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, side } : t)))
    setActiveTerm(id)
    setWorkActive(side, termKeyOf(id))
  }
  const moveWorkTabToSide = (key: string, side: DockSide): void => {
    const parsed = parseWorkKey(key)
    if (!parsed) return
    if (parsed.kind === 'doc') moveDocToSide(parsed.id, side)
    else moveTermToSide(parsed.id, side)
  }

  // ── 본문(문서) 탭 ──
  // 활성 사건 폴더가 있으면 거기에 실제 파일을 만들어 연다(VS Code식). 없으면 메모리 스크래치.
  const addDoc = (side: DockSide = 'left'): void => {
    const t = termTabs.find((t) => t.id === activeTerm)
    // 원격 사건이면 ssh:// URI로 만들어 원격에 생성 (plain cwd면 로컬에 잘못 생성됨)
    const dir = t ? (t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd) : undefined
    if (dir) {
      setMode('explorer')
      setPendingCreate({ type: 'file', dir, side })
      return
    }
    const n = ++docSeq
    const tab: DocTab = { id: `doc-${n}`, title: `새 문서 ${n}.md`, kind: 'mdview', side }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }
  const setDocPath = (id: string, path: string): void =>
    setDocTabs((tabs) =>
      tabs.map((t) =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() ?? t.title } : t
      )
    )
  const closeDoc = (id: string): boolean => {
    // 저장 안 된 새 문서면 확인 (경로 있는 문서는 자동저장되므로 그냥 닫음)
    if (
      dirtyDocs.has(id) &&
      !window.confirm('저장하지 않은 새 문서입니다. 닫으면 내용이 사라집니다. 닫을까요?')
    )
      return false
    setDirtyDocs((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
    setPdfStatus((s) => {
      if (!s[id]) return s
      const n = { ...s }
      delete n[id]
      return n
    })
    setDocTabs((tabs) => closeTab(tabs, id, activeDoc, setActiveDoc))
    return true
  }

  const openNewWorkspaceWindow = (): void => {
    void window.lt.app.newWindow()
  }

  // 단축키: Ctrl/Cmd+T 새 Agent / Ctrl/Cmd+Shift+T 새 터미널 / Ctrl/Cmd+W 탭 닫기 / Ctrl/Cmd+N 새 문서 / Ctrl/Cmd+Shift+N 새 작업환경
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const activeEl = document.activeElement as HTMLElement | null
      const k = e.key.toLowerCase()
      const isKey = (key: string, code?: string): boolean => k === key || (!!code && e.code === code)
      const isT = isKey('t', 'KeyT')
      const termId = focusedTermId(activeEl)
      const workSideForShortcut = focusedWorkSide(activeEl)
      const workTabForShortcut = workSideForShortcut ? parseWorkKey(activeWork[workSideForShortcut]) : null
      const sourceTermId =
        termId ?? (workTabForShortcut?.kind === 'terminal' ? workTabForShortcut.id : activeTerm)
      const termSideForShortcut =
        workSideForShortcut ?? termSide(termTabs.find((t) => t.id === sourceTermId))
      const primary = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey
      const macCtrlTInWorkArea =
        platform === 'darwin' && !!(termId || workSideForShortcut) && e.ctrlKey && !e.metaKey && isT
      if ((!primary && !macCtrlTInWorkArea) || e.altKey) return
      if (isT) {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) addTermSame(termSideForShortcut, sourceTermId)
        else addAgentSame(termSideForShortcut, sourceTermId)
        return
      }
      if (isKey('w', 'KeyW') && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        closeActiveTabRef.current()
      } else if (isKey('n', 'KeyN') && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openNewWorkspaceWindow()
      } else if (isKey('n', 'KeyN') && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        addDoc()
      } else if (k === 'tab') {
        // Ctrl/Cmd+Tab: Agent/터미널 포커스면 작업 탭, 아니면 문서 탭 순환
        e.preventDefault()
        e.stopPropagation()
        if (termId) cycleTerm(e.shiftKey ? -1 : 1, termId)
        else cycleDoc(e.shiftKey ? -1 : 1)
      } else if (k === 'pageup' || k === 'pagedown') {
        // Ctrl/Cmd+PageUp/PageDown: Agent/터미널 포커스면 작업 탭, 아니면 문서 탭 이동
        e.preventDefault()
        e.stopPropagation()
        if (termId) cycleTerm(k === 'pageup' ? -1 : 1, termId)
        else cycleDoc(k === 'pageup' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDoc, activeTerm, activeWork, termTabs, docTabs, platform]) // eslint-disable-line react-hooks/exhaustive-deps

  const openSettings = (): void => {
    const existing = docTabs.find((t) => t.kind === 'settings')
    if (existing) {
      activateDocTab(existing.id)
      return
    }
    const tab: DocTab = { id: 'settings', title: '설정', kind: 'settings', side: 'left' }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive('left', docKey(tab.id))
  }

  const openFile = (path: string, name: string, side: DockSide = 'left'): void => {
    const existing = docTabs.find((t) => t.path === path)
    if (existing) {
      activateDocTab(existing.id)
      return
    }
    const kind = docKindForPath(path)
    const tab: DocTab = { id: `file-${++docSeq}`, title: name, kind, path, side }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }

  // 이미지 뷰어: 같은 폴더의 정렬순 이전/다음 이미지로 현재 탭에서 이동
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/i
  const navigateImage = async (curPath: string, dir: 1 | -1): Promise<void> => {
    const parent = curPath.replace(/[\\/][^\\/]*$/, '')
    if (!parent || parent === curPath) return
    try {
      const list = await window.lt.fs.list(parent)
      const imgs = list.filter((e) => !e.isDir && IMG_RE.test(e.name))
      const i = imgs.findIndex((e) => e.path === curPath)
      if (i < 0) return
      const next = imgs[i + dir]
      if (!next) return
      setDocTabs((tabs) =>
        tabs.map((t) =>
          t.kind === 'image' && t.path === curPath ? { ...t, path: next.path, title: next.name } : t
        )
      )
    } catch {
      /* 무시 */
    }
  }

  const currentCaseFromTerm = (t: TermTab): CurrentCase => {
    const drafts = t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd
    return {
      drafts,
      records: t.recordsFolder,
      name: t.title,
      meta: {
        jsId: t.jsId,
        court: t.court,
        caseNumber: t.caseNumber,
        caseName: t.caseName,
        client: t.client,
        opponent: t.opponent,
        partyNames: t.partyNames
      },
      ssh: t.ssh,
      sshLabel: t.sshLabel,
      profileId: t.profileId,
      remotePath: t.ssh ? t.cwd : undefined
    }
  }

  // 다른 창에서 찢겨/이동돼 온 탭 수신 → 문서 또는 터미널 열기.
  const receiveTabRef = useRef<(p: TabPayload) => void>(() => {})
  receiveTabRef.current = (p) => {
    if (p.kind === 'terminal') {
      const tab = { ...(p.tab as TermTab), side: (p.tab as TermTab).side ?? 'right' }
      setTermTabs((tabs) =>
        tabs.some((t) => t.id === tab.id)
          ? tabs.map((t) => (t.id === tab.id ? { ...t, side: termSide(tab) } : t))
          : [...tabs, tab]
      )
      setActiveTerm(tab.id)
      setCurrentCase(currentCaseFromTerm(tab))
      setWorkActive(termSide(tab), termKeyOf(tab.id))
      return
    }
    const payload = p.tab
    const path = payload?.path ?? p.path
    const side = payload?.side ?? p.side ?? 'left'
    const rawKind = isRestorableDocKind(payload?.kind)
      ? payload.kind
      : path
        ? docKindForPath(path)
        : 'mdview'
    const kind = normalizeDocKind(rawKind, path)
    if (!path && kind !== 'settings') return
    const title = payload?.title ?? p.title ?? pathLeaf(path) ?? '문서'
    const existing = path
      ? docTabs.find((t) => t.path === path)
      : payload?.id
        ? docTabs.find((t) => t.id === payload.id)
        : undefined
    if (existing) {
      setDocTabs((tabs) => tabs.map((t) => (t.id === existing.id ? { ...t, side } : t)))
      setActiveDoc(existing.id)
      setWorkActive(side, docKey(existing.id))
      return
    }
    const id = payload?.id && !docTabs.some((t) => t.id === payload.id) ? payload.id : `file-${++docSeq}`
    const tab: DocTab = { id, title, kind, path, side }
    setDocTabs((tabs) => [...tabs, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }
  useEffect(() => {
    const off = window.lt.tabs.onReceive((p) => receiveTabRef.current(p))
    window.lt.tabs.ready() // 큐잉된 페이로드 flush 요청
    return off
  }, [])

  useEffect(() => {
    let frame = 0
    const readSelection = (): void => {
      frame = 0
      const sel = window.getSelection()
      const text = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.toString().trim() : ''
      const node = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).commonAncestorContainer : null
      const el = node instanceof Element ? node : node?.parentElement
      const inWorkArea = !!el?.closest?.('.work-pane, .body-col, .term-col')
      const count = inWorkArea && text ? Array.from(text).length : 0
      if (!count && document.activeElement instanceof Element && document.activeElement.closest('.cm-editor')) return
      setSelectionCharCount((prev) => (prev === count ? prev : count))
    }
    const scheduleRead = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(readSelection)
    }
    const onEditorSelection = (event: Event): void => {
      const detail = (event as CustomEvent<TextSelectionOverlayDetail | null>).detail
      setSelectionCharCount((prev) => (prev === (detail?.count ?? 0) ? prev : detail?.count ?? 0))
    }

    document.addEventListener('selectionchange', scheduleRead)
    document.addEventListener('mouseup', scheduleRead)
    document.addEventListener('keyup', scheduleRead)
    window.addEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', scheduleRead)
      document.removeEventListener('mouseup', scheduleRead)
      document.removeEventListener('keyup', scheduleRead)
      window.removeEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
  }, [])

  const rememberSessionForTerm = (term: TermTab, sessionId: string, title?: string, mtime?: number): void => {
    const key = `${term.ssh ? `${term.ssh.user}@${term.ssh.host}:${term.ssh.port ?? 22}` : 'local'}:${sessionId}:${title ?? ''}:${term.caseNumber ?? ''}:${term.cwd}`
    if (rememberedSessionsRef.current.has(key)) return
    rememberedSessionsRef.current.add(key)
    void window.lt.sessions.remember(sessionRememberInput(term, sessionId, title, mtime)).catch(() => {})
  }

  // claude 세션 제목(ai-title)을 주기적으로 읽어 탭 이름에 반영 (수동 변경한 탭 제외)
  const termKey = termTabs.map((t) => t.id + ':' + t.cwd).join('|')
  useEffect(() => {
    if (termTabs.length === 0) return
    let alive = true
    const tick = (): void => {
      termTabs.forEach((t) => {
        if (t.renamed || t.ssh) return // 원격 transcript 조회는 세션 목록을 열 때만 수행
        // 이 터미널이 시작된 이후의 세션만 매칭 (과거 세션 제목 방지)
        window.lt.sessions.current(t.cwd, (t.createdAt ?? 0) - 3000, t.ssh).then((r) => {
          if (!alive || !r) return
          rememberSessionForTerm(t, r.sessionId, r.title)
          if (!r.title) return
          setTermTabs((tabs) =>
            tabs.map((x) =>
              x.id === t.id && !x.renamed && x.sessionTitle !== r.title
                ? { ...x, sessionTitle: r.title }
                : x
            )
          )
        })
      })
    }
    tick()
    const iv = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey])

  // 문서 탭 순서 변경 (탭 바 안에서 드래그 재정렬)
  const reorderDocs = (fromId: string, toId: string): void => {
    setDocTabs((ts) => {
      const a = [...ts]
      const fi = a.findIndex((x) => x.id === fromId)
      const ti = a.findIndex((x) => x.id === toId)
      if (fi < 0 || ti < 0 || fi === ti) return ts
      const [m] = a.splice(fi, 1)
      a.splice(ti, 0, m)
      return a
    })
  }
  const reorderTerms = (fromId: string, toId: string): void => {
    setTermTabs((ts) => {
      const a = [...ts]
      const fi = a.findIndex((x) => x.id === fromId)
      const ti = a.findIndex((x) => x.id === toId)
      if (fi < 0 || ti < 0 || fi === ti) return ts
      const [m] = a.splice(fi, 1)
      a.splice(ti, 0, m)
      return a
    })
  }

  const rememberLocalCase = (
    drafts: string,
    records: string | undefined,
    name: string,
    caseMeta?: CaseMeta
  ): void => {
    setCurrentCase({ drafts, records, name, meta: caseMeta })
    window.lt.case.addHistory({ drafts, records, name }).then(setRecent)
  }

  // ── 사건 작업 탭 (기본: Agent Panel, 명시 fallback: PTY 터미널) ──
  const createLocalCaseTab = (
    kind: 'agent' | 'terminal',
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right',
    suggestedOptions?: FolderMatchSuggestion[]
  ): void => {
    const tab: TermTab = {
      id: newId(),
      title: name,
      kind,
      cwd: drafts,
      recordsFolder: records,
      suggestedRecords: suggested,
      suggestedRecordOptions: suggestedOptions,
      autoClaude: kind === 'terminal',
      createdAt: Date.now(),
      side,
      ...caseMeta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    rememberLocalCase(drafts, records, name, caseMeta)
    preloadPastSessions(tab.cwd, tab)
  }

  const createCase = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right',
    suggestedOptions?: FolderMatchSuggestion[]
  ): void => createLocalCaseTab('agent', drafts, name, records, suggested, caseMeta, side, suggestedOptions)

  const createCaseTerminal = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right',
    suggestedOptions?: FolderMatchSuggestion[]
  ): void => createLocalCaseTab('terminal', drafts, name, records, suggested, caseMeta, side, suggestedOptions)

  const historyDraftsForTerm = (t: TermTab): string =>
    t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd

  const addCase = async (side: DockSide = 'right'): Promise<void> => {
    const picked = await window.lt.dialog.pickFolder({
      title: '사건(작성서류) 폴더 선택',
      defaultPath: draftsRoot
    })
    if (!picked) return
    // 이전에 페어링한 소송기록 폴더가 있으면 '추천'만 (자동 적용하지 않고 물어봄)
    const paired = await window.lt.case.getPairing(picked.path)
    createCase(picked.path, picked.name, undefined, paired ?? undefined, undefined, side)
  }

  const addTerm = async (side: DockSide = 'right'): Promise<void> => {
    const picked = await window.lt.dialog.pickFolder({
      title: '터미널로 실행할 사건(작성서류) 폴더 선택',
      defaultPath: draftsRoot
    })
    if (!picked) return
    const paired = await window.lt.case.getPairing(picked.path)
    createCaseTerminal(picked.path, picked.name, undefined, paired ?? undefined, undefined, side)
  }

  // 원격(SSH) 사건 작업 탭 — 기본은 Agent, 명시 fallback은 터미널.
  // 파일 패널(탐색기·뷰어·에디터)은 ssh://<profileId>/<경로> URI로 원격 파일을 다룬다.
  const createRemoteCase = (
    profile: SshProfile,
    remotePath: string,
    name?: string,
    meta?: CaseMeta,
    records?: string,
    side: DockSide = 'right',
    kind: 'agent' | 'terminal' = 'agent'
  ): { id: string; title: string } => {
    const title = name || remotePath.replace(/\/+$/, '').split('/').pop() || profile.label
    const draftsUri = remoteUri(profile.id, remotePath)
    const ssh = sshConnFromProfile(profile)
    const tab: TermTab = {
      id: newId(),
      title,
      kind,
      cwd: remotePath,
      recordsFolder: records,
      autoClaude: kind === 'terminal',
      createdAt: Date.now(),
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      side,
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    setCurrentCase({
      drafts: draftsUri,
      records,
      name: title,
      meta,
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      remotePath
    })
    preloadPastSessions(tab.cwd, tab)
    window.lt.case.addHistory({ drafts: draftsUri, records, name: title }).then(setRecent)
    // 소송기록이 정해졌으면 페어링 기억(다음에 자동 적용) — 로컬과 동일
    if (records) window.lt.case.setPairing(draftsUri, records)
    return { id: tab.id, title }
  }

  const attachRemoteRecords = (
    tabId: string,
    profile: SshProfile,
    remotePath: string,
    title: string,
    records?: string,
    suggestions?: FolderMatchSuggestion[]
  ): void => {
    if (!records && !suggestions?.length) return
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              recordsFolder: records,
              suggestedRecords: records ? undefined : suggestions?.[0]?.path,
              suggestedRecordOptions: records ? undefined : suggestions
            }
          : t
      )
    )
    setCurrentCase((c) =>
      c?.profileId === profile.id && c.remotePath === remotePath && records ? { ...c, records } : c
    )
    if (!records) return
    const drafts = remoteUri(profile.id, remotePath)
    window.lt.case.setPairing(drafts, records)
    window.lt.case.addHistory({ drafts, records, name: title }).then(setRecent)
  }

  const resolveRemoteRecordsLater = (
    tabId: string,
    profile: SshProfile,
    remotePath: string,
    title: string,
    c?: JsCase
  ): void => {
    void resolveRemoteRecords(profile, remotePath, c)
      .then((r) => attachRemoteRecords(tabId, profile, remotePath, title, r.records, r.suggestions))
      .catch(() => {})
  }

  // ssh:// URI에서 원격 plain 경로만 추출 (createRemoteCase의 cwd용)
  const remotePlain = (uri: string, profileId: string): string =>
    uri.startsWith('ssh://' + profileId) ? uri.slice(('ssh://' + profileId).length) : uri

  // 원격 사건의 소송기록 폴더를 로컬과 동일한 우선순위로 결정:
  // ① 기억된 페어링(getPairing) → ② 소송기록 루트에서 사건번호/폴더명 매칭.
  // draftsRemotePath = 원격 작성서류(사건) 폴더 plain 경로, c = (있으면) JuriSupport 사건.
  const resolveRemoteRecords = async (
    profile: SshProfile,
    draftsRemotePath: string,
    c?: JsCase
  ): Promise<{ records?: string; suggestions?: FolderMatchSuggestion[] }> => {
    const draftsKey = remoteUri(profile.id, draftsRemotePath)
    const paired = await window.lt.case.getPairing(draftsKey)
    if (paired) return { records: paired }
    if (!profile.recordsRoot) return {}
    const recRoot = remoteUri(profile.id, profile.recordsRoot)
    if (c) return resolveFolderMatch(await matchCaseFolders(recRoot, c))
    const name = draftsRemotePath.replace(/\/+$/, '').split('/').pop() ?? ''
    const matched = await matchRemoteByName(recRoot, name)
    return matched ? { records: matched } : {}
  }

  // 원격 루트(ssh:// URI)에서 폴더명으로 매칭 — 소송기록 폴더 자동 지정용. 매칭 항목의 ssh:// URI 반환.
  const matchRemoteByName = async (rootUri: string, name: string): Promise<string | undefined> => {
    try {
      const list = await window.lt.fs.list(rootUri)
      const dirs = list.filter((e) => e.isDir)
      const n = matchNorm(name)
      if (n.length < 2) return undefined
      return (
        dirs.find((d) => matchNorm(d.name) === n)?.path ??
        dirs.find((d) => {
          const dn = matchNorm(d.name)
          return dn.includes(n) || n.includes(dn)
        })?.path
      )
    } catch {
      return undefined
    }
  }

  const syncProfileForRemote = (profileId: string): SshProfile =>
    sshProfiles.find((p) => p.id === profileId) ?? sshProfiles[0]

  const localMirrorPathForSync = (
    localPath: string,
    profile: SshProfile,
    root?: string
  ): string => {
    const name = localPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    return root ? root.replace(/\/+$/, '') + '/' + name : ''
  }

  // rclone 동기화 모달 열기 — 맥의 작성서류 폴더(원격 경로)를 추정해 프리필.
  // (클라우드 경유 모델: 맥에서 rclone 실행 → 맥 폴더 ↔ OneDrive 클라우드)
  const openSync = (): void => {
    if (sshProfiles.length === 0) {
      window.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }
    const cur = termTabs.find((t) => t.id === activeTerm)
    if (cur?.ssh && cur.profileId) {
      // 활성 사건이 원격 → 그 맥 폴더를 그대로 사용
      const profile = syncProfileForRemote(cur.profileId)
      setSyncInit({ profile, macFolder: cur.cwd })
    } else {
      // 활성 사건이 로컬 → 첫 프로필의 원격 작성서류 루트 하위 동일 폴더명으로 추정
      const localPath = cur?.cwd ?? currentCase?.drafts ?? ''
      const profile = sshProfiles[0]
      setSyncInit({
        profile,
        macFolder: localMirrorPathForSync(localPath, profile, profile.draftsRoot)
      })
    }
  }

  // 소송기록 폴더는 기록뷰어에서 클라우드 → 맥/로컬 최신화만 제공한다.
  const openRecordsSync = (): void => {
    if (sshProfiles.length === 0) {
      window.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }
    if (!activeRecordsFolder) {
      window.alert('먼저 소송기록 폴더를 지정하세요.')
      return
    }
    const remote = parseRemoteUri(activeRecordsFolder)
    if (remote) {
      setSyncInit({
        profile: syncProfileForRemote(remote.profileId),
        macFolder: remote.path,
        folderLabel: '소송기록 폴더',
        directions: 'pull-only'
      })
      return
    }
    const profile = sshProfiles[0]
    setSyncInit({
      profile,
      macFolder: localMirrorPathForSync(activeRecordsFolder, profile, profile.recordsRoot),
      folderLabel: '소송기록 폴더',
      directions: 'pull-only'
    })
  }

  // 📁/＋ 클릭: 저장된 SSH 프로필이 있으면 접속 선택 메뉴, 없으면 바로 로컬 폴더 선택.
  const openConnOrLocal = async (): Promise<void> => {
    const s = await window.lt.settings.get()
    const profs = s.sshProfiles ?? []
    setSshProfiles(profs)
    if (profs.length > 0) setConnMenu(true)
    else void addCase()
  }

  // 최근 사건은 사용자가 명시적으로 고른 것이므로 연결된 소송기록을 바로 적용
  const openRecent = async (entry: {
    drafts: string
    records?: string
    name: string
  }): Promise<void> => {
    const remote = parseRemoteUri(entry.drafts)
    if (!remote) {
      createCase(entry.drafts, entry.name, entry.records)
      return
    }
    const s = await window.lt.settings.get()
    const profiles = s.sshProfiles ?? []
    setSshProfiles(profiles)
    const profile = profiles.find((p) => p.id === remote.profileId)
    if (!profile) {
      window.alert('이 최근 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      return
    }
    createRemoteCase(profile, remote.path, entry.name, undefined, entry.records)
  }

  // 과거 claude 세션 이어서 열기 (claude --resume). 지정한 cwd/사건 컨텍스트에서.
  const openPastSession = (
    sessionId: string,
    cwd: string,
    title?: string,
    source?: TermTab,
    side: DockSide = termSide(source)
  ): void => {
    const base =
      currentCase && (currentCase.drafts === cwd || currentCase.remotePath === cwd)
        ? currentCase
        : undefined
    const meta = base?.meta
    const ssh = source?.ssh ?? base?.ssh
    const sshLabel = source?.sshLabel ?? base?.sshLabel
    const profileId = source?.profileId ?? base?.profileId
    const tab: TermTab = {
      id: newId(),
      title: title ? title : base?.name ?? cwd.split(/[\\/]/).pop() ?? '세션',
      kind: 'agent',
      cwd,
      recordsFolder: base?.records ?? source?.recordsFolder,
      autoClaude: false,
      createdAt: Date.now(),
      resumeSessionId: sessionId,
      renamed: !!title, // 과거 세션 제목을 그대로 쓰면 자동 갱신 안 함
      jsId: source?.jsId,
      court: source?.court,
      caseNumber: source?.caseNumber,
      caseName: source?.caseName,
      client: source?.client,
      ssh,
      sshLabel,
      profileId,
      side,
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
  }

  // ＋T / 터미널로 실행: 같은 사건에서 PTY 터미널(claude 자동 실행)을 연다.
  // 활성 탭이 없으면 마지막 사건에서, 그것도 없으면 폴더 선택.
  const addTermSame = (
    preferredSide?: DockSide,
    sourceTermId = activeTerm,
    options?: { reuseAgentTab?: boolean }
  ): void => {
    const cur = termTabs.find((t) => t.id === sourceTermId)
    const side = preferredSide ?? termSide(cur)
    if (!cur) {
      if (currentCase) {
        if (currentCase.ssh && currentCase.profileId && currentCase.remotePath) {
          const saved = sshProfiles.find((p) => p.id === currentCase.profileId)
          const profile: SshProfile =
            saved ?? {
              id: currentCase.profileId,
              label: currentCase.sshLabel ?? currentCase.profileId,
              host: currentCase.ssh.host,
              user: currentCase.ssh.user,
              port: currentCase.ssh.port,
              identityFile: currentCase.ssh.identityFile
            }
          createRemoteCase(
            profile,
            currentCase.remotePath,
            currentCase.name,
            currentCase.meta,
            currentCase.records,
            side,
            'terminal'
          )
        } else {
          createCaseTerminal(currentCase.drafts, currentCase.name, currentCase.records, undefined, currentCase.meta, side)
        }
      } else {
        void addTerm(side)
      }
      return
    }
    if (options?.reuseAgentTab && isAgentTab(cur)) {
      void window.lt.agent.close(cur.id)
      setAgentAttachmentRequests((requests) => {
        if (!requests[cur.id]) return requests
        const next = { ...requests }
        delete next[cur.id]
        return next
      })
      setTermAttention((current) => {
        if (!current.has(cur.id)) return current
        const next = new Set(current)
        next.delete(cur.id)
        return next
      })
      setTermStatus((current) => {
        if (!current.has(cur.id)) return current
        const next = new Map(current)
        next.delete(cur.id)
        return next
      })
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === cur.id
            ? {
                ...t,
                kind: 'terminal',
                autoClaude: true,
                createdAt: Date.now(),
                sessionTitle: undefined,
                side
              }
            : t
        )
      )
      setActiveTerm(cur.id)
      setWorkActive(side, termKeyOf(cur.id))
      return
    }
    const tab: TermTab = {
      id: newId(),
      title: cur.title,
      cwd: cur.cwd,
      recordsFolder: cur.recordsFolder,
      suggestedRecords: cur.suggestedRecords,
      suggestedRecordOptions: cur.suggestedRecordOptions,
      autoClaude: true, // 새 터미널도 일괄적으로 claude 실행
      createdAt: Date.now(),
      jsId: cur.jsId,
      court: cur.court,
      caseNumber: cur.caseNumber,
      caseName: cur.caseName,
      client: cur.client,
      ssh: cur.ssh, // 원격 사건이면 같은 접속으로 새 터미널
      sshLabel: cur.sshLabel,
      profileId: cur.profileId,
      side
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
  }

  const addAgentSame = (preferredSide?: DockSide, sourceTermId = activeTerm): void => {
    const cur = termTabs.find((t) => t.id === sourceTermId)
    const side = preferredSide ?? termSide(cur)
    const ssh = cur?.ssh ?? currentCase?.ssh
    const cwd = cur?.cwd ?? (ssh ? currentCase?.remotePath : currentCase?.drafts)
    if (!cwd) {
      void (async () => {
        const picked = await window.lt.dialog.openCase()
        if (!picked) return
        createCase(picked.path, picked.name, undefined, undefined, undefined, side)
      })()
      return
    }
    const title = cur?.title ?? currentCase?.name ?? cwd.split(/[\\/]/).pop() ?? '세션'
    const tab: TermTab = {
      id: newId(),
      title,
      kind: 'agent',
      cwd,
      recordsFolder: cur?.recordsFolder ?? currentCase?.records,
      autoClaude: false,
      createdAt: Date.now(),
      jsId: cur?.jsId ?? currentCase?.meta?.jsId,
      court: cur?.court ?? currentCase?.meta?.court,
      caseNumber: cur?.caseNumber ?? currentCase?.meta?.caseNumber,
      caseName: cur?.caseName ?? currentCase?.meta?.caseName,
      client: cur?.client ?? currentCase?.meta?.client,
      ssh,
      sshLabel: cur?.sshLabel ?? currentCase?.sshLabel,
      profileId: cur?.profileId ?? currentCase?.profileId,
      side
    }
    setTermTabs((tabs) => [...tabs, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
  }

  // 추천 소송기록 폴더 적용 ('열기' 클릭 시)
  const applySuggested = (path?: string): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    if (!cur) return
    if (!cur.suggestedRecords && !path) return
    const rec = path ?? cur.suggestedRecords
    if (!rec) return
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === activeTerm
          ? {
              ...t,
              recordsFolder: rec,
              suggestedRecords: undefined,
              suggestedRecordOptions: undefined
            }
          : t
      )
    )
    setCurrentCase((c) => (c ? { ...c, records: rec } : c))
    const drafts = historyDraftsForTerm(cur)
    window.lt.case.setPairing(drafts, rec)
    window.lt.case.addHistory({ drafts, records: rec, name: cur.title }).then(setRecent)
  }

  const removeTermTab = (id: string): void => {
    setTermTabs((tabs) => closeTab(tabs, id, activeTerm, setActiveTerm))
    setTermBracketedPasteMode((m) => {
      if (!(id in m)) return m
      const n = { ...m }
      delete n[id]
      return n
    })
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
    setTermStatus((m) => {
      if (!m.has(id)) return m
      const n = new Map(m)
      n.delete(id)
      return n
    })
  }
  const closeTerm = (id: string): boolean => {
    const tab = termTabs.find((t) => t.id === id)
    if (isAgentTab(tab)) window.lt.agent.close(id)
    else window.lt.pty.kill(id)
    removeTermTab(id)
    return true
  }
  const detachTerm = (id: string): boolean => {
    removeTermTab(id)
    return true
  }

  // 터미널 선택 → 활성화 + 완료(주목) 표시 해제
  const selectTerm = (id: string): void => {
    activateTermTab(id)
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  // 터미널 작업 상태(진행중/완료/질문대기). 완료·질문 전이에서만 소리.
  const onTermStatus = (id: string, status: TermRunStatus): void => {
    setTermStatus((m) => {
      const n = new Map(m)
      n.set(id, status)
      return n
    })
    if (status === 'working') {
      setTermAttention((s) => {
        if (!s.has(id)) return s
        const n = new Set(s)
        n.delete(id)
        return n
      })
    } else {
      playNotificationSound(notificationSound, notificationVolume)
      window.lt.app.requestAttention(status)
      const bg = id !== activeTermRef.current
      if (bg) setTermAttention((s) => new Set(s).add(id))
      if (status === 'question' && bg) pushToast(id)
    }
  }
  const onTermBracketedPasteMode = (id: string, enabled: boolean): void => {
    setTermBracketedPasteMode((m) => (m[id] === enabled ? m : { ...m, [id]: enabled }))
  }

  // 질문/확인 대기 팝업(토스트)
  const toastSeq = useRef(0)
  const pushToast = (termId: string): void => {
    const t = termTabs.find((x) => x.id === termId)
    const key = ++toastSeq.current
    setToasts((ts) => [...ts.filter((x) => x.termId !== termId), { key, termId, title: t?.title ?? '세션' }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 12000)
  }
  const dismissToast = (key: number): void => setToasts((ts) => ts.filter((x) => x.key !== key))

  // Ctrl+Tab: 같은 종류 탭 순환 (터미널끼리 / 문서끼리)
  const cycleTerm = (dir: number, sourceTermId = activeTerm): void => {
    const cur = termTabs.find((t) => t.id === sourceTermId)
    const side = termSide(cur)
    const scoped = termTabs.filter((t) => termSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === sourceTermId)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    selectTerm(scoped[ni].id)
  }
  const cycleDoc = (dir: number): void => {
    const cur = docTabs.find((t) => t.id === activeDoc)
    const side = docSide(cur)
    const scoped = docTabs.filter((t) => docSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === activeDoc)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    activateDocTab(scoped[ni].id)
  }

  // 활성 사건(또는 마지막 사건)에 소송기록 폴더를 지정/탐색 → 뷰어 연결 + 페어링 기억.
  // 터미널이 닫혀 있어도 현재 사건 컨텍스트에 적용된다.
  const pickRecords = async (): Promise<void> => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const remoteCtx =
      cur?.ssh && cur.profileId
        ? {
            profileId: cur.profileId,
            draftsPath: cur.cwd,
            title: cur.title,
            records: cur.recordsFolder
          }
        : !cur && currentCase?.ssh && currentCase.profileId && currentCase.remotePath
          ? {
              profileId: currentCase.profileId,
              draftsPath: currentCase.remotePath,
              title: currentCase.name,
              records: currentCase.records
            }
          : null
    if (remoteCtx) {
      let profiles = sshProfiles
      let prof = profiles.find((p) => p.id === remoteCtx.profileId)
      if (!prof) {
        const s = await window.lt.settings.get()
        profiles = s.sshProfiles ?? []
        setSshProfiles(profiles)
        prof = profiles.find((p) => p.id === remoteCtx.profileId)
      }
      if (prof) {
        const currentRecords =
          remoteCtx.records && isRemotePath(remoteCtx.records)
            ? remotePlain(remoteCtx.records, prof.id)
            : undefined
        setRecordsPick({
          profile: prof,
          draftsPath: remoteCtx.draftsPath,
          title: remoteCtx.title,
          startPath: currentRecords || prof.recordsRoot || '~'
        })
      } else {
        window.alert('이 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      }
      return
    }
    const draftsForPair = cur?.cwd ?? currentCase?.drafts
    const r = await window.lt.dialog.pickFolder({
      title: '소송기록 폴더 선택',
      defaultPath: recordsRoot ?? currentCase?.records
    })
    if (!r) return
    if (cur) {
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === activeTerm
            ? {
                ...t,
                recordsFolder: r.path,
                suggestedRecords: undefined,
                suggestedRecordOptions: undefined
              }
            : t
        )
      )
    }
    // 터미널 유무와 무관하게 현재 사건 컨텍스트에도 반영(뷰어가 이걸 참조)
    setCurrentCase((c) => (c ? { ...c, records: r.path } : c))
    if (draftsForPair) {
      window.lt.case.setPairing(draftsForPair, r.path)
      window.lt.case
        .addHistory({ drafts: draftsForPair, records: r.path, name: cur?.title ?? currentCase?.name ?? '사건' })
        .then(setRecent)
    }
  }

  const onOutline = (path: string, parsed: ParsedRecord): void => setPdfRecord({ path, parsed })
  const jumpToPage = (page: number): void => {
    jumpNonce.current += 1
    setPdfJump({ page, nonce: jumpNonce.current })
  }

  // 마지막으로 연 사건 컨텍스트 — 터미널을 모두 닫아도 유지(탐색기·뷰어·새 터미널 기준)
  const [currentCase, setCurrentCase] = useState<CurrentCase | null>(null)

  // 사건 지정 해제 — 마지막 사건 컨텍스트를 비워 '+'·'이 사건에서 열기'가 더는 그 사건을 열지 않게.
  // (탐색기·뷰어 패널도 활성 터미널이 없으면 비워진다)
  const clearCase = (): void => {
    setCurrentCase(null)
    setFolderRecord(null)
    setPdfRecord(null)
  }

  const activeDocTab = docTabs.find((t) => t.id === activeDoc)
  const activeTermTab = termTabs.find((t) => t.id === activeTerm)
  // 활성 터미널이 있으면 그 사건, 없으면(터미널 다 닫힘) 마지막 사건 컨텍스트 유지
  // 원격 탭의 작성서류 폴더는 ssh:// URI로 변환(패널·탐색기용). 터미널은 plain cwd를 그대로 씀.
  const activeDraftsFolder =
    activeTermTab && activeTermTab.ssh && activeTermTab.profileId
      ? remoteUri(activeTermTab.profileId, activeTermTab.cwd)
      : (activeTermTab?.cwd ?? currentCase?.drafts)
  const activeRecordsFolder = activeTermTab?.recordsFolder ?? currentCase?.records
  const activeSuggestedRecords = activeTermTab?.suggestedRecords
  const activeSuggestedRecordOptions = activeTermTab?.suggestedRecordOptions
  const defaultCaseOpenProfileId = caseOpenProfileId(
    resolveCaseOpenTarget(caseOpenTarget, sshProfiles)
  )
  const isViewer = mode === 'viewer'
  const sessionCaseSource = currentCaseSessionSource(currentCase, sshProfiles)

  const handleAgentAttachmentRequestsHandled = (
    termId: string,
    requestIds: string[]
  ): void => {
    if (requestIds.length === 0) return
    setAgentAttachmentRequests((current) => {
      const requests = current[termId] ?? []
      if (requests.length === 0) return current
      const handled = new Set(requestIds)
      const remaining = requests.filter((request) => !handled.has(request.id))
      if (remaining.length === requests.length) return current
      const next = { ...current }
      if (remaining.length > 0) next[termId] = remaining
      else delete next[termId]
      return next
    })
  }

  const queueAgentAttachment = (
    term: TermTab,
    attachment: AgentAttachment,
    inputText?: string
  ): void => {
    const request: AgentAttachmentRequest = {
      id: newId(),
      attachment,
      focusPrompt: true,
      inputText
    }
    setAgentAttachmentRequests((current) => ({
      ...current,
      [term.id]: [...(current[term.id] ?? []), request]
    }))
    setActiveTerm(term.id)
    setWorkActive(termSide(term), termKeyOf(term.id))
    setTermFocusNonce((current) => ({ ...current, [term.id]: (current[term.id] ?? 0) + 1 }))
  }

  const selectionAttachmentLabel = (docName?: string): string => {
    const source = docName?.trim() || '선택 영역'
    selectionAttachmentSeqRef.current += 1
    return `${source} 선택 ${selectionAttachmentSeqRef.current}`
  }

  const selectionAttachmentForAgent = (
    text: string,
    opts: { docPath?: string; docName?: string },
    term: TermTab
  ): AgentAttachment => {
    const trimmed = text.trim()
    const readablePath = opts.docPath ? claudeReadablePath(opts.docPath, term) : undefined
    const body = [
      opts.docName ? `문서: ${opts.docName}` : undefined,
      readablePath ? `문서 경로: ${readablePath}` : undefined,
      `선택 길이: ${formatCharCount(trimmed.length)}자`,
      '',
      trimmed
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n')
    return {
      kind: 'selection',
      label: selectionAttachmentLabel(opts.docName),
      path: readablePath,
      text: body
    }
  }

  const agentSelectionInputText = (attachment: AgentAttachment): string =>
    `「${attachment.label}」 선택 부분에 대해 `

  const buildWorkspaceSnapshot = async (): Promise<WorkspaceSnapshot> => {
    const docs = docTabs.map(toWorkspaceDoc).filter((t): t is WorkspaceDocTabPayload => !!t)
    const terminals = await Promise.all(
      termTabs.map(async (t) => {
        if (isAgentTab(t)) return { ...t, side: termSide(t) }
        const current = await window.lt.sessions
          .current(t.cwd, (t.createdAt ?? 0) - 3000, t.ssh)
          .catch(() => null)
        if (current?.sessionId) rememberSessionForTerm(t, current.sessionId, current.title)
        return {
          ...t,
          side: termSide(t),
          resumeSessionId: current?.sessionId ?? t.resumeSessionId,
          sessionTitle: current?.title ?? t.sessionTitle
        }
      })
    )
    return {
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      mode,
      docs,
      terminals,
      activeDoc,
      activeTerm,
      activeWork,
      currentCase,
      crop: { on: cropOn, ratio: cropRatio }
    }
  }

  const sanitizeWorkspaceTerm = (raw: unknown): TermTab | null => {
    if (!raw || typeof raw !== 'object') return null
    const t = raw as Partial<TermTab>
    if (typeof t.cwd !== 'string' || !t.cwd) return null
    return {
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      title: typeof t.title === 'string' && t.title ? t.title : t.cwd.split(/[\\/]/).pop() || '세션',
      kind: t.kind === 'agent' ? 'agent' : 'terminal',
      cwd: t.cwd,
      recordsFolder: typeof t.recordsFolder === 'string' ? t.recordsFolder : undefined,
      suggestedRecords: typeof t.suggestedRecords === 'string' ? t.suggestedRecords : undefined,
      suggestedRecordOptions: Array.isArray(t.suggestedRecordOptions)
        ? t.suggestedRecordOptions
            .filter(
              (s): s is FolderMatchSuggestion =>
                !!s &&
                typeof s === 'object' &&
                typeof s.path === 'string' &&
                typeof s.name === 'string' &&
                typeof s.reason === 'string' &&
                typeof s.score === 'number'
            )
            .slice(0, 6)
        : undefined,
      autoClaude: t.kind === 'agent' ? false : (t.autoClaude ?? true),
      jsId: typeof t.jsId === 'string' ? t.jsId : undefined,
      court: typeof t.court === 'string' ? t.court : undefined,
      caseNumber: typeof t.caseNumber === 'string' ? t.caseNumber : undefined,
      caseName: typeof t.caseName === 'string' ? t.caseName : undefined,
      client: typeof t.client === 'string' ? t.client : undefined,
      sessionTitle: typeof t.sessionTitle === 'string' ? t.sessionTitle : undefined,
      renamed: !!t.renamed,
      createdAt: Date.now(),
      resumeSessionId: typeof t.resumeSessionId === 'string' ? t.resumeSessionId : undefined,
      ssh: t.ssh,
      sshLabel: typeof t.sshLabel === 'string' ? t.sshLabel : undefined,
      profileId: typeof t.profileId === 'string' ? t.profileId : undefined,
      side: t.side ?? 'right'
    }
  }

  const restoreWorkspaceSnapshot = (snapshot: WorkspaceSnapshot): void => {
    const snapshotDocs = Array.isArray(snapshot.docs) ? snapshot.docs : []
    const snapshotTerms = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
    const nextDocs = [...docTabs]
    const docIdMap = new Map<string, string>()
    for (const saved of snapshotDocs) {
      const tab = toDocTab(saved)
      if (!tab) continue
      const existingById = nextDocs.find((t) => t.id === tab.id)
      const existingByPath = tab.path ? nextDocs.find((t) => t.path === tab.path) : undefined
      const existing = existingById ?? existingByPath
      if (existing) {
        docIdMap.set(saved.id, existing.id)
        continue
      }
      nextDocs.push(tab)
      docIdMap.set(saved.id, tab.id)
    }

    const nextTerms = [...termTabs]
    const termIdSet = new Set(nextTerms.map((t) => t.id))
    for (const saved of snapshotTerms) {
      const tab = sanitizeWorkspaceTerm(saved)
      if (!tab || termIdSet.has(tab.id)) continue
      nextTerms.push(tab)
      termIdSet.add(tab.id)
    }

    setDocTabs(nextDocs)
    setTermTabs(nextTerms)

    const activeDocId =
      (snapshot.activeDoc && docIdMap.get(snapshot.activeDoc)) ||
      (activeDoc && nextDocs.some((t) => t.id === activeDoc) ? activeDoc : nextDocs[0]?.id ?? '')
    const activeTermId =
      (snapshot.activeTerm && nextTerms.some((t) => t.id === snapshot.activeTerm)
        ? snapshot.activeTerm
        : undefined) ||
      (activeTerm && nextTerms.some((t) => t.id === activeTerm) ? activeTerm : nextTerms[0]?.id ?? '')
    setActiveDoc(activeDocId)
    setActiveTerm(activeTermId)

    const validKeys = new Set([
      ...nextDocs.map((t) => docKey(t.id)),
      ...nextTerms.map((t) => termKeyOf(t.id))
    ])
    const firstKeyForSide = (side: DockSide): string => {
      const doc = nextDocs.find((t) => docSide(t) === side)
      if (doc) return docKey(doc.id)
      const term = nextTerms.find((t) => termSide(t) === side)
      return term ? termKeyOf(term.id) : ''
    }
    const left =
      isWorkKey(snapshot.activeWork?.left) && validKeys.has(snapshot.activeWork.left)
        ? snapshot.activeWork.left
        : firstKeyForSide('left')
    const activeTermTab = nextTerms.find((t) => t.id === activeTermId)
    const right =
      isWorkKey(snapshot.activeWork?.right) && validKeys.has(snapshot.activeWork.right)
        ? snapshot.activeWork.right
        : firstKeyForSide('right')
    setActiveWork({ left, right })

    if (isWorkspaceMode(snapshot.mode)) setMode(snapshot.mode)
    const restoredCase = sanitizeCurrentCase(snapshot.currentCase)
    const nextCurrentCase = restoredCase ?? (activeTermTab ? currentCaseFromTerm(activeTermTab) : currentCase)
    setCurrentCase(nextCurrentCase)
    nextTerms.forEach((term) => preloadPastSessions(term.cwd, term))
    const restoredCaseSource = currentCaseSessionSource(nextCurrentCase, sshProfiles)
    if (restoredCaseSource) preloadPastSessions(restoredCaseSource.cwd, restoredCaseSource)
    if (snapshot.crop) {
      setCropOn(!!snapshot.crop.on)
      if (Number.isFinite(snapshot.crop.ratio)) setCropRatio(snapshot.crop.ratio)
    }
    setTreeRefresh((n) => n + 1)
  }

  const saveWorkspace = async (exportFile = false): Promise<void> => {
    const snapshot = await buildWorkspaceSnapshot()
    const skippedDocs = docTabs.length - snapshot.docs.length
    const result = exportFile
      ? await window.lt.workspace.exportFile(snapshot)
      : await window.lt.workspace.save(snapshot)
    if (result.canceled) return
    if (!result.ok) {
      window.alert('작업환경 저장 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    window.alert(
      `작업환경 저장 완료\n문서 ${snapshot.docs.length}개, 터미널 ${snapshot.terminals.length}개` +
        (skippedDocs > 0 ? `\n임시/미저장 문서 ${skippedDocs}개는 제외했습니다.` : '') +
        (result.path ? `\n${result.path}` : '')
    )
  }

  const applyWorkspaceLoadResult = (result: WorkspaceLoadResult): void => {
    if (result.canceled) return
    if (!result.ok) {
      window.alert('작업환경 복원 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    if (!result.snapshot) {
      window.alert('저장된 작업환경이 없습니다.')
      return
    }
    restoreWorkspaceSnapshot(result.snapshot)
    window.alert(
      `작업환경 복원 완료${result.entry?.label ? `\n${result.entry.label}` : ''}\n문서 ${result.snapshot.docs?.length ?? 0}개, 터미널 ${
        result.snapshot.terminals?.length ?? 0
      }개`
    )
  }

  const openSavedWorkspacePicker = async (): Promise<void> => {
    setWorkspacePick({ loading: true, entries: [] })
    const list = await window.lt.workspace.list()
    if (!list.ok) {
      setWorkspacePick({
        loading: false,
        entries: [],
        error: list.error ?? '작업환경 목록을 불러오지 못했습니다.'
      })
      return
    }
    setWorkspacePick({ loading: false, entries: list.entries ?? [] })
  }

  const loadSavedWorkspaceEntry = async (entry: WorkspaceEntry): Promise<void> => {
    const result = await window.lt.workspace.load(entry.id)
    if (result.ok && result.snapshot) setWorkspacePick(null)
    applyWorkspaceLoadResult(result)
  }

  const restoreWorkspace = async (importFile = false): Promise<void> => {
    if (!importFile) {
      await openSavedWorkspacePicker()
      return
    }
    applyWorkspaceLoadResult(await window.lt.workspace.importFile())
  }

  useEffect(() => {
    if (!isRemotePath(activeDraftsFolder) && !isRemotePath(activeRecordsFolder)) return
    const timer = setInterval(() => setTreeRefresh((x) => x + 1), 5000)
    return () => clearInterval(timer)
  }, [activeDraftsFolder, activeRecordsFolder])

  const copyPathsTo = (dir: string, paths: string[]): void => {
    if (!paths.length) return
    window.lt.fs.copyInto(dir, paths).then((r) => {
      if (r.copied.length === 0) {
        window.alert('붙여넣기/복사할 수 있는 파일이 없습니다.')
        return
      }
      setTreeRefresh((n) => n + 1)
    })
  }
  // 외부 파일을 특정 폴더로 복사 (드래그앤드롭)
  const copyFilesTo = (dir: string, files: FileList): void => {
    const paths = Array.from(files)
      .map((f) => window.lt.fs.pathForFile(f))
      .filter(Boolean)
    copyPathsTo(dir, paths)
  }
  const pasteFilesTo = async (dir: string): Promise<void> => {
    const clip = await window.lt.fs.clipboardFiles()
    if (clip.paths.length === 0) {
      window.alert('클립보드에 붙여넣을 로컬 파일 경로가 없습니다.')
      return
    }
    copyPathsTo(dir, clip.paths)
  }
  const onDropFiles = (files: FileList): void => {
    if (activeDraftsFolder) copyFilesTo(activeDraftsFolder, files)
  }
  const downloadEntry = (path: string, name: string, isDir: boolean): void => {
    if (!isRemotePath(path)) return
    window.lt.fs.download(path).then((r) => {
      if (r.canceled) return
      if (!r.ok) {
        window.alert('다운로드 실패: ' + (r.error ?? '알 수 없는 오류'))
        return
      }
      window.alert(
        `${isDir ? '폴더' : '파일'} 다운로드 완료: ${name}` +
          (r.count !== undefined ? `\n파일 ${r.count}개` : '') +
          (r.path ? `\n${r.path}` : '')
      )
    })
  }

  const replaceAppPathPrefix = (from: string, to: string): void => {
    setDocTabs((tabs) =>
      tabs.map((t) => {
        const nextPath = replacePathPrefix(t.path, from, to)
        if (!nextPath || nextPath === t.path) return t
        const direct = t.path === from
        return {
          ...t,
          path: nextPath,
          title: direct ? fileNameFromPath(nextPath) : t.title,
          kind: direct ? docKindForPath(nextPath) : t.kind
        }
      })
    )
    setTermTabs((tabs) =>
      tabs.map((t) => {
        const cwdPath =
          t.ssh && t.profileId
            ? parseRemoteUri(replacePathPrefix(remoteUri(t.profileId, t.cwd), from, to) ?? '')?.path
            : replacePathPrefix(t.cwd, from, to)
        const nextRecords = replacePathPrefix(t.recordsFolder, from, to)
        const nextSuggested = replacePathPrefix(t.suggestedRecords, from, to)
        const nextOptions = t.suggestedRecordOptions?.map((option) => ({
          ...option,
          path: replacePathPrefix(option.path, from, to) ?? option.path
        }))
        const changed =
          (cwdPath && cwdPath !== t.cwd) ||
          nextRecords !== t.recordsFolder ||
          nextSuggested !== t.suggestedRecords ||
          nextOptions?.some((option, i) => option.path !== t.suggestedRecordOptions?.[i]?.path)
        if (!changed) return t
        return {
          ...t,
          cwd: cwdPath ?? t.cwd,
          recordsFolder: nextRecords,
          suggestedRecords: nextSuggested,
          suggestedRecordOptions: nextOptions
        }
      })
    )
    setCurrentCase((c) => {
      if (!c) return c
      const nextDrafts = replacePathPrefix(c.drafts, from, to) ?? c.drafts
      const nextRecords = replacePathPrefix(c.records, from, to)
      const nextRemotePath =
        c.profileId && c.remotePath
          ? parseRemoteUri(replacePathPrefix(remoteUri(c.profileId, c.remotePath), from, to) ?? '')
              ?.path ?? c.remotePath
          : c.remotePath
      if (
        nextDrafts === c.drafts &&
        nextRecords === c.records &&
        nextRemotePath === c.remotePath
      )
        return c
      const nextCase = { ...c, drafts: nextDrafts, records: nextRecords, remotePath: nextRemotePath }
      void window.lt.case.addHistory({
        drafts: nextCase.drafts,
        records: nextCase.records,
        name: nextCase.name
      }).then(setRecent)
      if (nextCase.records) void window.lt.case.setPairing(nextCase.drafts, nextCase.records)
      return nextCase
    })
    setPdfRecord((record) => {
      if (!record) return record
      const nextPath = replacePathPrefix(record.path, from, to)
      return nextPath && nextPath !== record.path ? { ...record, path: nextPath } : record
    })
  }

  // 트리 내부 이동 (드래그앤드롭)
  const moveEntry = (src: string, destDir: string): void => {
    window.lt.fs.move(src, destDir).then((r) => {
      if (!r.ok) {
        if (r.error) console.warn('[move]', r.error)
        return
      }
      setTreeRefresh((n) => n + 1)
      if (r.path) replaceAppPathPrefix(src, r.path)
    })
  }

  const renameEntry = (path: string, name: string): void => {
    window.lt.fs.rename(path, name).then((r) => {
      if (!r.ok || !r.path) {
        if (r.error) window.alert('이름 변경 실패: ' + r.error)
        return
      }
      const nextRoot = r.path
      setTreeRefresh((n) => n + 1)
      replaceAppPathPrefix(path, nextRoot)
    })
  }

  const renameDocTab = (id: string, title: string): void => {
    const tab = docTabs.find((t) => t.id === id)
    if (!tab) return
    const nextTitle = title.trim() || tab.title
    if (!tab.path || (tab.kind !== 'mdview' && tab.kind !== 'markdown')) {
      const displayTitle =
        tab.kind === 'mdview' || tab.kind === 'markdown'
          ? markdownRenameName(nextTitle, tab.title) || nextTitle
          : nextTitle
      setDocTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, title: displayTitle } : t)))
      return
    }

    const currentName = fileNameFromPath(tab.path)
    const nextName = markdownRenameName(nextTitle, currentName)
    if (!nextName || nextName === currentName) return
    window.lt.fs.rename(tab.path, nextName).then((r) => {
      if (!r.ok || !r.path) {
        if (r.error) window.alert('이름 변경 실패: ' + r.error)
        return
      }
      const previousPath = tab.path as string
      const nextPath = r.path
      setTreeRefresh((n) => n + 1)
      replaceAppPathPrefix(previousPath, nextPath)
    })
  }

  // 파일/폴더 삭제 (확인은 FileTree에서 받음) — 삭제 후 트리 새로고침 + 해당 문서 탭 닫기
  const deleteEntry = (path: string): void => {
    window.lt.fs.delete(path).then((r) => {
      if (!r.ok) {
        if (r.error) window.alert('삭제 실패: ' + r.error)
        return
      }
      setTreeRefresh((n) => n + 1)
      // 삭제된 파일(또는 폴더 하위)을 열어둔 문서 탭이 있으면 닫는다
      setDocTabs((tabs) => {
        const dead = tabs.filter((t) => t.path && (t.path === path || t.path.startsWith(path + '/') || t.path.startsWith(path + '\\')))
        if (dead.length === 0) return tabs
        let next = tabs
        for (const d of dead) next = closeTab(next, d.id, activeDoc, setActiveDoc)
        return next
      })
    })
  }

  // 탐색기 인라인 생성: 버튼 → 트리에 입력칸 표시
  const newFile = (): void => {
    if (!activeDraftsFolder) {
      addDoc()
      return
    }
    setMode('explorer')
    setPendingCreate({ type: 'file', dir: activeDraftsFolder })
  }
  const newFolder = (): void => {
    if (!activeDraftsFolder) return
    setMode('explorer')
    setPendingCreate({ type: 'folder', dir: activeDraftsFolder })
  }

  const onCreateEntry = (name: string, type: 'file' | 'folder', targetDir?: string): void => {
    const createSide = pendingCreate?.side ?? 'left'
    setPendingCreate(null)
    const dir = targetDir ?? activeDraftsFolder
    if (!dir) return
    const n = name.trim()
    if (type === 'folder') {
      if (n) {
        window.lt.fs.mkdir(dir, n).then((r) => {
          if (r.ok) setTreeRefresh((x) => x + 1)
          else if (r.error) window.alert('폴더 생성 실패: ' + r.error)
        })
      }
      return
    }
    // 파일: 이름 없으면 무제 스크래치(저장 시 이름 물어봄)
    if (!n) {
      const id = `doc-${++docSeq}`
      setDocTabs((t) => [...t, { id, title: '무제.md', kind: 'mdview', side: 'left' }])
      setActiveDoc(id)
      setWorkActive('left', docKey(id))
      return
    }
    const fn = /\.[^.]+$/.test(n) ? n : n + '.md'
    window.lt.fs.createFile(dir, fn).then((r) => {
      if (r.ok && r.path) {
        setTreeRefresh((x) => x + 1)
        openFile(r.path, r.path.split(/[\\/]/).pop() ?? fn, createSide)
      } else if (r.error) {
        window.alert('문서 생성 실패: ' + r.error)
      }
    })
  }

  const activePdfPath = activeDocTab?.kind === 'pdf' ? activeDocTab.path : undefined
  const outlineRecord = pdfRecord && pdfRecord.path === activePdfPath ? pdfRecord.parsed : null
  // 패널 표시: 소송기록 폴더 분류(우선) → 없으면 열린 PDF의 목차
  const panelRecord = folderRecord ?? outlineRecord

  // 활성 PDF가 바뀌면 이전 점프 신호 제거 (새 뷰어에 stale 점프 방지)
  useEffect(() => {
    setPdfJump(undefined)
  }, [activePdfPath])

  // 소송기록 폴더의 PDF 파일명 파싱 → 문서/서증/첨부 분류
  useEffect(() => {
    if (!isViewer || !activeRecordsFolder) {
      setFolderRecord(null)
      return
    }
    let alive = true
    window.lt.fs.listPdfs(activeRecordsFolder).then((files) => {
      if (alive) setFolderRecord(parseRecordFiles(files))
    })
    return () => {
      alive = false
    }
  }, [isViewer, activeRecordsFolder, treeRefresh])

  // 문서(파일) 순서: 본안 → 서증 → 첨부
  const recordOrder: OutlineItem[] = panelRecord
    ? [...panelRecord.documents, ...panelRecord.evidences, ...panelRecord.attachments].filter(
        (it) => it.path
      )
    : []
  const recordItems = recordOrder.map((it) => ({ path: it.path as string, label: it.label }))

  // 목록 항목 열기: 폴더 기록이면 그 문서를 '새 탭'으로 열기(이미 열렸으면 포커스),
  // 단일 PDF 목차면 현재 PDF 페이지 점프.
  const onOpenItem = (it: OutlineItem): void => {
    if (it.path) openFile(it.path, it.label)
    else if (it.page > 0) jumpToPage(it.page)
  }

  // 임의 터미널에 텍스트 주입. 대상 프로그램이 bracketed paste를 켠 경우에만 감싼다.
  const pasteToTerm = (termId: string, payload: string): void => {
    const tab = termTabsRef.current.find((t) => t.id === termId)
    const normalized = normalizePasteForPty(payload)
    const text = termBracketedPasteModeRef.current[termId]
      ? `\x1b[200~${normalized}\x1b[201~`
      : normalized
    setActiveTerm(termId)
    setWorkActive(termSide(tab), termKeyOf(termId))
    setTermFocusNonce((n) => ({ ...n, [termId]: (n[termId] ?? 0) + 1 }))
    window.lt.pty.write(termId, text)
  }

  // Claude 질문 전송: Agent 탭이면 SDK로, 터미널이면 paste로, 문서 전용 창이면 메인 창으로 전달.
  const activeTermRef = useRef(activeTerm)
  activeTermRef.current = activeTerm
  const sendClaude = (payload: string, opts?: { displayText?: string }): void => {
    const tab = resolveClaudeTargetTab(termTabs, activeTerm, activeWork)
    if (tab && isAgentTab(tab)) {
      void window.lt.agent.send(tab.id, { text: payload, displayText: opts?.displayText })
      return
    }
    if (tab) pasteToTerm(tab.id, payload)
    else window.lt.claude.ask(payload)
  }

  const buildFreshFilePrompt = async (
    path: string,
    label: string,
    term?: TermTab
  ): Promise<string> => {
    const stat = await window.lt.fs.stat(path).catch((e) => ({
      ok: false as const,
      error: String(e)
    }))
    const readablePath = claudeReadablePath(path, term)
    const note = fileAccessNote(path, term)
    const lines = [
      '작업 기준 파일:',
      `- 파일명: ${label}`,
      `- 앱 경로: ${path}`,
      readablePath !== path ? `- Claude가 직접 읽을 경로: ${readablePath}` : undefined,
      stat.ok
        ? `- 현재 저장본: ${stat.size} bytes, 수정시각 ${formatFileMtime(stat.mtimeMs)}`
        : `- 현재 저장본 확인 실패: ${stat.error}`,
      note ? `- ${note}` : undefined,
      '',
      '반드시 다음 순서로 진행해줘:',
      '1. 위 경로의 현재 저장된 파일을 디스크에서 다시 읽는다.',
      '2. 이전 대화의 초안, 임시 파일, 기억 속 내용은 기준으로 쓰지 않는다.',
      '3. 요청한 부분만 수정하고 사용자가 편집한 다른 부분은 보존한다.',
      '4. 수정 후 변경 요약과 보존 여부를 알려준다.',
      ''
    ].filter((line): line is string => line !== undefined)
    return lines.join('\n')
  }

  const claudeSelectionContextDir = (docPath?: string): string | undefined => {
    const target = activeTermTab ?? sessionCaseSource
    if (target?.ssh && target.profileId) return remoteUri(target.profileId, target.cwd)
    if (target?.cwd) return target.cwd
    if (docPath) return dirnameForClaudeContext(docPath)
    if (currentCase?.drafts) return currentCase.drafts
    return draftsRoot
  }

  const createClaudeSelectionContext = async (
    text: string,
    opts: { docPath?: string; docName?: string }
  ): Promise<{ path: string; readablePath: string } | null> => {
    const dir = claudeSelectionContextDir(opts.docPath)
    if (!dir) return null
    const target = activeTermTab ?? sessionCaseSource
    const content = [
      '# legal-terminal 선택 본문',
      opts.docName ? `문서: ${opts.docName}` : undefined,
      opts.docPath ? `문서 경로: ${claudeReadablePath(opts.docPath, target)}` : undefined,
      `생성: ${new Date().toLocaleString('ko-KR')}`,
      '',
      text
    ].filter((line): line is string => line !== undefined).join('\n')
    const result = await window.lt.fs.createFile(dir, selectionContextFileName(), content)
    if (!result.ok || !result.path) return null
    return {
      path: result.path,
      readablePath: claudeReadablePath(result.path, target)
    }
  }

  const hiddenSelectionDisplay = (docName: string | undefined, text: string): string =>
    [
      `${docName ? `「${docName}」 ` : ''}선택 본문 ${formatCharCount(text.length)}자를 Claude 컨텍스트로 추가했습니다.`,
      '원문은 화면 표시에서 숨겼습니다.'
    ].join('\n')
  // 메인 창: 다른 창에서 온 Claude 질문을 활성 Claude surface에 주입.
  useEffect(
    () =>
      window.lt.claude.onIncoming((payload) => {
        const tab = resolveClaudeTargetTab(
          termTabsRef.current,
          activeTermRef.current,
          activeWorkRef.current
        )
        if (tab && isAgentTab(tab)) void window.lt.agent.send(tab.id, { text: payload })
        else if (tab) pasteToTerm(tab.id, payload)
      }),
    []
  )

  // 파일 1개를 "물어보기" 형태로 전송 (경로 포함 → claude가 실제 파일을 읽음).
  const askAboutFile = (termId: string, path: string, label: string): void => {
    const term = termTabs.find((t) => t.id === termId)
    void buildFreshFilePrompt(path, label, term).then((prompt) => {
      if (isAgentTab(term)) void window.lt.agent.send(termId, { text: `${prompt}위 파일에 대해 ` })
      else pasteToTerm(termId, `${prompt}위 파일에 대해 `)
    })
  }

  const terminalSnippetPrompt = (text: string): string =>
    [
      '다음 JSON의 text 값을 사용자가 선택한 터미널 출력 원문으로 보고 답해줘.',
      '문서 본문 선택이나 파일 인용이 아니라, 터미널 로그/응답 출력 스니펫으로만 취급해줘.',
      JSON.stringify({ kind: 'terminal-output', text }),
      ''
    ].join('\n')

  const askAboutTerminalSelection = (termId: string, text: string): void => {
    const selected = text.trim()
    if (!selected) return
    pasteToTerm(termId, terminalSnippetPrompt(selected))
  }

  // 활성 문서명+경로 + (있으면) 선택 텍스트로 claude 프롬프트 주입. 텍스트 없으면 문서 전체에 대해 묻기.
  const askClaude = (text: string, opts?: { docPath?: string }): void => {
    void (async () => {
      const d = docTabs.find((x) => x.id === activeDoc)
      const docPath = opts?.docPath ?? d?.path
      const docName = opts?.docPath ? (opts.docPath.split(/[\\/]/).pop() ?? d?.title) : d?.title
      const ref = docName ? `「${docName}」${docPath ? `(${docPath})` : ''}` : ''
      const t = text.trim()
      if (t && activeTermTab && isAgentTab(activeTermTab)) {
        const attachment = selectionAttachmentForAgent(t, { docPath, docName }, activeTermTab)
        queueAgentAttachment(activeTermTab, attachment, agentSelectionInputText(attachment))
        return
      }
      const filePrompt =
        docPath && docName ? await buildFreshFilePrompt(docPath, docName, activeTermTab) : ''
      let payload: string
      let displayText: string | undefined
      if (t) {
        displayText = hiddenSelectionDisplay(docName, t)
        const selectionContext = await createClaudeSelectionContext(t, { docPath, docName })
        payload = selectionContext
          ? [
              filePrompt || (ref ? `${ref} 중 다음 선택 본문:` : '다음 선택 본문:'),
              '선택 본문 원문은 화면에 붙여넣지 않고 아래 컨텍스트 파일에 저장했어.',
              `- 선택 본문 파일: ${selectionContext.readablePath}`,
              filePrompt
                ? '선택 본문 파일은 위치 힌트야. 최종 기준은 위 경로에서 다시 읽은 현재 저장본으로 삼아줘.'
                : '먼저 이 파일을 읽고 선택 본문을 기준으로 이어지는 요청에 답해줘.',
              ''
            ].join('\n')
          : filePrompt
            ? `${filePrompt}아래 선택 내용은 위치 힌트야. 최종 기준은 위 경로에서 다시 읽은 현재 저장본으로 삼아줘.\n\n<selection>\n${t}\n</selection>\n\n`
            : ref
              ? `${ref} 중 다음 부분:\n"${t}"\n\n`
              : `"${t}"\n\n`
      } else if (docName) {
        payload = filePrompt ? `${filePrompt}위 파일에 대해 ` : `${ref} 파일에 대해 `
      } else return
      sendClaude(payload, { displayText })
    })()
  }

  const sendMarkdownToJuriSupport = (doc: MarkdownDocumentPayload): void => {
    const prompt = buildJuriSupportLegalDocumentPrompt(doc, {
      caseId: activeTermTab?.jsId ?? currentCase?.meta?.jsId,
      court: activeTermTab?.court ?? currentCase?.meta?.court,
      caseNumber: activeTermTab?.caseNumber ?? currentCase?.meta?.caseNumber,
      caseName: activeTermTab?.caseName ?? currentCase?.meta?.caseName,
      client: activeTermTab?.client ?? currentCase?.meta?.client
    })
    sendClaude(prompt)
  }

  // ── 사건 대시보드 동작 ──
  // 토큰 변경 등으로 좌측 '다가오는 기일' 패널을 새로고침하기 위한 nonce
  const [jsNonce, setJsNonce] = useState(0)
  const [todoNonce, setTodoNonce] = useState(0)
  // 세션 목록 드롭다운 + 사건 필터('all' | jsId | '__folder__')
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  // claude 완료 주목 표시가 필요한 터미널 id 집합 + 진행중/완료 상태
  const [termAttention, setTermAttention] = useState<Set<string>>(new Set())
  const [termStatus, setTermStatus] = useState<Map<string, TermRunStatus>>(new Map())
  const [toasts, setToasts] = useState<{ key: number; termId: string; title: string }[]>([])

  const updatePdfStatus = (tabId: string, status: PdfViewStatus): void => {
    setPdfStatus((s) => (samePdfStatus(s[tabId], status) ? s : { ...s, [tabId]: status }))
  }
  const activePdfStatus = activeDocTab?.kind === 'pdf' ? pdfStatus[activeDocTab.id] : undefined
  const activeTermRunStatus = activeTerm ? termStatus.get(activeTerm) : undefined
  const selectionStatus = selectionCharCount > 0 ? `선택 ${formatCharCount(selectionCharCount)}자` : undefined
  const statusInfo =
    joinStatus([
      selectionStatus,
      describeDocStatus(activeDocTab, !!activeDocTab && dirtyDocs.has(activeDocTab.id), activePdfStatus),
      describeCaseStatus(activeTermTab, currentCase),
      describeRecordsStatus(activeRecordsFolder, activeSuggestedRecords, !!(activeTermTab || currentCase)),
      describeTermStatus(activeTermTab, activeTermRunStatus),
      bridgeStatus || undefined
    ]) || '작업환경 준비'
  const windowTitle = buildWindowTitle({
    term: activeTermTab,
    currentCase,
    doc: activeDocTab,
    docOnly,
    termOnly
  })

  useEffect(() => {
    document.title = windowTitle
    void window.lt.app.setWindowTitle(windowTitle).catch(() => {})
  }, [windowTitle])

  // Ctrl+W 등으로 터미널 닫기 — claude가 작업 중이면 확인 후 닫는다.
  const closeTermWithConfirm = (id: string): boolean => {
    if (termStatus.get(id) === 'working') {
      if (!window.confirm('claude가 아직 작업 중입니다. 이 터미널을 닫을까요?')) return false
    }
    return closeTerm(id)
  }
  const closeCurrentWindowSoon = (): void => {
    window.setTimeout(() => void window.lt.app.closeWindow(), 0)
  }
  const closeDetachedDoc = (id: string): void => {
    const shouldCloseWindow = docOnly && docTabs.length <= 1
    if (closeDoc(id) && shouldCloseWindow) closeCurrentWindowSoon()
  }
  const closeDetachedTerm = (id: string): void => {
    const shouldCloseWindow = termOnly && termTabs.length <= 1
    if (closeTermWithConfirm(id) && shouldCloseWindow) closeCurrentWindowSoon()
  }
  const detachDocAfterMove = (id: string): void => {
    const shouldCloseWindow = docOnly && docTabs.length <= 1
    if (closeDoc(id) && shouldCloseWindow) closeCurrentWindowSoon()
  }
  const detachTermAfterMove = (id: string): void => {
    const shouldCloseWindow = termOnly && termTabs.length <= 1
    if (detachTerm(id) && shouldCloseWindow) closeCurrentWindowSoon()
  }
  closeActiveTermRef.current = (): void => {
    if (activeTerm) closeDetachedTerm(activeTerm)
  }
  closeActiveTabRef.current = (): void => {
    const activeEl = document.activeElement as HTMLElement | null
    const termId = focusedTermId(activeEl)
    const docId = focusedDocId(activeEl)
    if (termId && termTabs.some((t) => t.id === termId)) {
      closeDetachedTerm(termId)
      return
    }
    if (docId && docTabs.some((d) => d.id === docId)) {
      closeDetachedDoc(docId)
      return
    }
    const side = focusedWorkSide(activeEl)
    const parsed = side ? parseWorkKey(activeWork[side]) : null
    if (parsed?.kind === 'terminal') {
      closeDetachedTerm(parsed.id)
      return
    }
    if (parsed?.kind === 'doc') {
      closeDetachedDoc(parsed.id)
      return
    }
    if (activeTerm) {
      closeDetachedTerm(activeTerm)
      return
    }
    if (activeDoc) closeDetachedDoc(activeDoc)
    else if ((docOnly && docTabs.length === 0) || (termOnly && termTabs.length === 0)) {
      closeCurrentWindowSoon()
    }
  }

  const caseRef = (c: JsCase): string => `${c.caseNumber ?? ''} ${c.caseName ?? ''}`.trim() || c.id

  const resolveFolderMatch = (
    suggestions: FolderMatchSuggestion[]
  ): { records?: string; suggestions?: FolderMatchSuggestion[] } => {
    const top = suggestions[0]
    if (!top) return {}
    const nextScore = suggestions[1]?.score ?? 0
    if (top.reason === '사건번호 일치' && top.score > nextScore) return { records: top.path }
    return { suggestions }
  }

  // 폴더명 자동 매칭 후보 (사건번호 우선 → 사건명/당사자명 부분일치)
  const matchCaseFolders = async (root: string, c: JsCase): Promise<FolderMatchSuggestion[]> => {
    try {
      const list = await window.lt.fs.list(root)
      const dirs = list.filter((e) => e.isDir)
      const candidates = new Map<string, FolderMatchSuggestion>()
      const put = (path: string, name: string, reason: string, score: number): void => {
        const prev = candidates.get(path)
        if (!prev || score > prev.score) candidates.set(path, { path, name, reason, score })
      }
      if (c.caseNumber) {
        const no = matchNorm(c.caseNumber)
        for (const d of dirs) {
          const dn = matchNorm(d.name)
          if (dn.includes(no)) put(d.path, d.name, '사건번호 일치', dn === no ? 120 : 100)
        }
      }
      const caseNameKey = matchNorm(c.caseName)
      if (caseNameKey.length >= 2) {
        for (const d of dirs) {
          if (matchNorm(d.name).includes(caseNameKey)) put(d.path, d.name, '사건명 일치', 80)
        }
      }
      const partyKeys = c.parties
        .map((p) => p.party.name)
        .filter(Boolean)
        .map((s) => matchNorm(s as string))
        .filter((s) => s.length >= 2)
      for (const d of dirs) {
        const dn = matchNorm(d.name)
        if (partyKeys.some((k) => dn.includes(k))) put(d.path, d.name, '당사자명 일치', 60)
      }
      return [...candidates.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  const matchCaseFolder = async (root: string, c: JsCase): Promise<string | undefined> =>
    (await matchCaseFolders(root, c))[0]?.path

  // 좌클릭: 사건 작업환경 열기 (폴더 매칭 → 없으면 직접 지정 → 터미널/뷰어 연결)
  const openCaseWorkspace = async (c: JsCase): Promise<void> => {
    const saved = c.id ? await window.lt.case.getJsPairing(c.id) : undefined
    let drafts = saved?.drafts
    let records = saved?.records
    let recordSuggestions: FolderMatchSuggestion[] = []
    if (!drafts && draftsRoot) drafts = await matchCaseFolder(draftsRoot, c)
    if (!records && recordsRoot) {
      const resolved = resolveFolderMatch(await matchCaseFolders(recordsRoot, c))
      records = resolved.records
      recordSuggestions = resolved.records ? [] : (resolved.suggestions ?? [])
    }
    if (!drafts) {
      // 자동 매칭 실패 → 사용자가 직접 작성서류 폴더 지정
      const picked = await window.lt.dialog.pickFolder({
        title: `「${caseRef(c)}」 작성서류 폴더 선택`,
        defaultPath: draftsRoot
      })
      if (!picked) return
      drafts = picked.path
    }
    if (c.id) await window.lt.case.setJsPairing(c.id, drafts, records)
    const suggested = records ? undefined : recordSuggestions[0]?.path
    // 세션 자동 명명: 법원(약칭) · 사건번호 · 사건명
    const court = c.court || ''
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const opponent = c.parties
      .filter((p) => p.role === 'opponent')
      .map((p) => p.party.name)
      .join(', ')
    const partyNames = [client, opponent].filter(Boolean).join(' / ')
    const name =
      [court && abbrevCourt(court), c.caseNumber, c.caseName, client].filter(Boolean).join(' ') ||
      caseRef(c)
    const meta: CaseMeta = {
      jsId: c.id || undefined,
      court: court || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined,
      opponent: opponent || undefined,
      partyNames: partyNames || undefined
    }
    setCurrentCase({ drafts, records, name, meta })
    const existing = termTabs.find((t) => t.cwd === drafts || (t.jsId && t.jsId === c.id))
    if (existing) {
      activateTermTab(existing.id)
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                ...meta,
                title: name,
                recordsFolder: records ?? t.recordsFolder,
                suggestedRecords: suggested,
                suggestedRecordOptions: recordSuggestions.length ? recordSuggestions : undefined
              }
            : t
        )
      )
    } else {
      createCase(drafts, name, records, suggested, meta, 'right', recordSuggestions)
    }
    setMode('explorer')
  }

  // 우클릭: 사건을 원격(SSH 프로필)에서 열기 — 원격 draftsRoot에서 폴더명 매칭, 실패 시 수동 선택.
  const [remoteCasePick, setRemoteCasePick] = useState<{
    profile: SshProfile
    name: string
    meta: CaseMeta
    caseData: JsCase
  } | null>(null)
  const openCaseRemote = async (c: JsCase, profile: SshProfile): Promise<void> => {
    const court = c.court || ''
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const opponent = c.parties
      .filter((p) => p.role === 'opponent')
      .map((p) => p.party.name)
      .join(', ')
    const partyNames = [client, opponent].filter(Boolean).join(' / ')
    const name =
      [court && abbrevCourt(court), c.caseNumber, c.caseName, client].filter(Boolean).join(' ') ||
      caseRef(c)
    const meta: CaseMeta = {
      jsId: c.id || undefined,
      court: court || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined,
      opponent: opponent || undefined,
      partyNames: partyNames || undefined
    }
    // 원격 작성서류 루트에서 폴더명(사건번호/당사자) 자동 매칭
    let matchedUri: string | undefined
    if (profile.draftsRoot) {
      matchedUri = await matchCaseFolder(remoteUri(profile.id, profile.draftsRoot), c)
    }
    if (matchedUri) {
      const remotePath = remotePlain(matchedUri, profile.id)
      const opened = createRemoteCase(profile, remotePath, name, meta)
      // 소송기록 매칭은 터미널을 먼저 띄운 뒤 붙인다. SFTP/키 문제로 터미널 생성이 막히면 안 된다.
      resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, c)
      setMode('explorer')
    } else {
      // 작성서류 매칭 실패 → 폴더 선택기로 직접 지정 (소송기록은 picker onPick에서 resolve)
      setRemoteCasePick({ profile, name, meta, caseData: c })
    }
  }

  // 우클릭: Claude에 사건 브리핑 요청
  const briefCaseToClaude = (c: JsCase): void => {
    const idPart = c.id ? `(JuriSupport id: ${c.id})` : ''
    sendClaude(`「${caseRef(c)}」 사건${idPart}의 다가오는 기일과 진행상황을 정리해줘.\n`)
  }
  // 우클릭: 준비서면 초안 시작 (/brief-protocol 슬래시커맨드)
  const draftCaseWithClaude = (c: JsCase): void => {
    sendClaude(`/brief-protocol ${caseRef(c)} `)
  }

  // 탐색기/외부에서 터미널로 드래그드롭한 파일들을 그 터미널 프롬프트에 주입.
  const dropFilesToTerm = (termId: string, paths: string[]): void => {
    if (!paths.length) return
    const tab = termTabs.find((t) => t.id === termId)
    setActiveTerm(termId)
    setWorkActive(termSide(tab), termKeyOf(termId))
    if (paths.length === 1) {
      const p = paths[0]
      askAboutFile(termId, p, p.split(/[\\/]/).pop() ?? p)
    } else {
      void Promise.all(
        paths.map((p) => buildFreshFilePrompt(p, p.split(/[\\/]/).pop() ?? p, tab))
      ).then((prompts) => {
        pasteToTerm(termId, `${prompts.join('\n')}위 파일들에 대해:\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`)
      })
    }
  }

  // 탭 드래그 중 여부 — 창 전체에서 '이동' 커서를 보이게 해 '금지' 표시를 막는다.
  const [tabDragging, setTabDragging] = useState(false)
  // 탭 드래그 중일 때 셸 어디서든 dragover를 허용(이동 커서) — 실제 찢기는 onDragEnd가 처리.
  const shellDragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!tabDragging && !e.dataTransfer.types.includes(TAB_DND_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: React.DragEvent) => {
      if (tabDragging || e.dataTransfer.types.includes(TAB_DND_TYPE)) e.preventDefault()
    }
  }

  // 본문(문서) 렌더 — 좌/우 작업 영역과 '문서 전용 창'에서 재사용
  const renderDocContent = (tab?: DocTab): ReactNode => (
    <>
      {!tab && <Empty label="열린 문서가 없습니다" actionLabel="새 문서" onAction={() => addDoc('left')} />}
      {tab?.kind === 'welcome' && <Welcome recent={recent} onOpen={openRecent} />}
      {tab?.kind === 'file' && <FileView key={tab.path} path={tab.path as string} />}
      {tab?.kind === 'image' && (
        <ImageViewer
          key={tab.path}
          path={tab.path as string}
          onNavigate={(dir) => navigateImage(tab.path as string, dir)}
        />
      )}
      {tab?.kind === 'hwp' && <HwpView key={tab.path} path={tab.path as string} />}
      {tab?.kind === 'csv' && <CsvView key={tab.path} path={tab.path as string} />}
      {(tab?.kind === 'mdview' || tab?.kind === 'markdown') && (
        <MarkdownEditor
          key={tab.id}
          title={tab.title}
          path={tab.path}
          defaultDir={draftsRoot}
          onPath={(p) => setDocPath(tab.id, p)}
          onAsk={(savedPath) => askClaude('', { docPath: savedPath })}
          onSendToJuriSupport={sendMarkdownToJuriSupport}
          onDirty={(d) =>
            setDirtyDocs((s) => {
              const has = s.has(tab.id)
              if (d === has) return s
              const n = new Set(s)
              if (d) n.add(tab.id)
              else n.delete(tab.id)
              return n
            })
          }
        />
      )}
      {tab?.kind === 'pdf' &&
        (recordItems.some((i) => i.path === tab.path) ? (
          <RecordViewer
            key={tab.id}
            items={recordItems}
            startPath={tab.path as string}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onCurrent={(it) =>
              setDocTabs((tabs) =>
                tabs.map((t) => (t.id === tab.id ? { ...t, path: it.path, title: it.label } : t))
              )
            }
            onAskDoc={() => askClaude('')}
            onStatus={(status) => updatePdfStatus(tab.id, status)}
          />
        ) : (
          <PdfViewer
            key={tab.path}
            path={tab.path as string}
            onOutline={onOutline}
            jumpTo={pdfJump}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onAskDoc={() => askClaude('')}
            onStatus={(status) => updatePdfStatus(tab.id, status)}
          />
        ))}
      {tab?.kind === 'diff' && <DiffPreview diff={agentDiffs[tab.diffId ?? '']?.diff} />}
      {tab?.kind === 'settings' && <SettingsView />}
    </>
  )

  const docTabBar = (
    <TabBar
      tabs={docTabs.map((t) => ({
        id: t.id,
        title: t.title,
        tooltip: t.path,
        path: t.path,
        renamable: t.kind === 'mdview' || t.kind === 'markdown',
        dragPayload: docTabDragPayload(t, docSide(t))
      }))}
      activeId={activeDoc}
      onSelect={activateDocTab}
      onClose={closeDetachedDoc}
      onAdd={() => addDoc('left')}
      addTitle="새 문서"
      dropSide="left"
      onReorder={reorderDocs}
      onTearOut={detachDocAfterMove}
      onDragActive={setTabDragging}
      onRename={renameDocTab}
    />
  )

  const docsPanel = (
    <DocsPanel
      key="docs"
      mode={mode}
      draftsFolder={activeDraftsFolder}
      recordsFolder={activeRecordsFolder}
      suggestedRecords={activeSuggestedRecords}
      suggestedRecordOptions={activeSuggestedRecordOptions}
      record={panelRecord}
      refreshNonce={treeRefresh}
      onOpenFile={openFile}
      onDropTo={copyFilesTo}
      onMove={moveEntry}
      onRename={renameEntry}
      onDelete={deleteEntry}
      onPasteTo={pasteFilesTo}
      onDownload={downloadEntry}
      onPickRecords={pickRecords}
      onSyncRecords={sshProfiles.length > 0 ? openRecordsSync : undefined}
      onApplySuggested={applySuggested}
      onOpenItem={onOpenItem}
      onDropFiles={onDropFiles}
      onNewFolder={newFolder}
      onNewFile={newFile}
      onSync={sshProfiles.length > 0 ? openSync : undefined}
      onOpenWorkspace={() => void openConnOrLocal()}
      onOpenCase={openCaseWorkspace}
      onOpenRemote={openCaseRemote}
      sshProfiles={sshProfiles}
      defaultOpenProfileId={defaultCaseOpenProfileId}
      onBrief={briefCaseToClaude}
      onDraft={draftCaseWithClaude}
      jsNonce={jsNonce}
      todoNonce={todoNonce}
      onTodoChanged={() => setTodoNonce((n) => n + 1)}
      pendingCreate={pendingCreate}
      onRequestCreate={(dir, type) => setPendingCreate({ type, dir })}
      onCreateEntry={onCreateEntry}
      onCancelCreate={() => setPendingCreate(null)}
    />
  )

  const terminalPanel = (
    <div className="term-col" key="terminal">
      <TabBar
        tabs={termTabs.map((t) => ({
          id: t.id,
          title: t.renamed
            ? t.title
            : t.sessionTitle
              ? `${t.title} · ${t.sessionTitle}`
              : isAgentTab(t)
                ? `Agent · ${t.title}`
                : t.title,
          attention: termAttention.has(t.id) && termStatus.get(t.id) !== 'question',
          working: termStatus.get(t.id) === 'working',
          question: termStatus.get(t.id) === 'question' && termAttention.has(t.id),
          renamable: true,
          dragPayload: { kind: 'terminal', tab: { ...t } } as TabPayload,
          tooltip: [
            isAgentTab(t) && 'Claude Agent',
            t.ssh && `🔗 ${t.sshLabel ?? '원격'} (${t.ssh.user}@${t.ssh.host})`,
            t.court && `${t.court}`,
            t.caseNumber,
            t.caseName,
            t.client && `의뢰인 ${t.client}`,
            t.cwd
          ]
            .filter(Boolean)
            .join('\n')
        }))}
        activeId={activeTerm}
        onSelect={selectTerm}
        onClose={closeDetachedTerm}
        onAdd={() => addAgentSame(termSide(activeTermTab))}
        addTitle="새 Agent"
        dropSide="right"
        onReorder={reorderTerms}
        onTearOut={detachTermAfterMove}
        onDragActive={setTabDragging}
        onRename={(id, title) =>
          setTermTabs((tabs) =>
            tabs.map((t) => (t.id === id ? { ...t, title, renamed: true } : t))
          )
        }
        extraLeft={[
          {
            label: '☰',
            title: '세션 목록',
            active: sessionListOpen,
            onClick: () => {
              const cur = termTabs.find((t) => t.id === activeTerm)
              setSessionFilter(cur?.jsId ?? sessionCaseSource?.jsId ?? 'all')
              setSessionListOpen((v) => !v)
            }
          }
        ]}
        menu={{
          label: '▾',
          title: '작업 추가 메뉴',
          items: [
            {
              label: '터미널로 실행',
              title: '현재 사건을 터미널로 실행',
              onClick: () => addTermSame(termSide(activeTermTab), activeTerm, { reuseAgentTab: true })
            }
          ]
        }}
      />
      {sessionListOpen && (
        <SessionList
          sessions={termTabs}
          activeId={activeTerm}
          filter={sessionFilter}
          onFilter={setSessionFilter}
          caseCwd={sessionCaseSource?.cwd ?? currentCase?.drafts}
          caseSource={sessionCaseSource}
          onSelect={(id) => {
            selectTerm(id)
            setSessionListOpen(false)
          }}
          onResume={(sid, cwd, title, source) => {
            openPastSession(sid, cwd, title, source)
            setSessionListOpen(false)
          }}
          onClose={() => setSessionListOpen(false)}
        />
      )}
      <div className="term-stack">
        {termTabs.length === 0 &&
          (currentCase ? (
            <Empty
              label={`「${currentCase.name}」 — Claude 탭이 모두 닫혔습니다`}
              actionLabel="이 사건에서 Agent 열기"
              onAction={() => addAgentSame('right')}
              secondaryLabel="터미널로 실행"
              onSecondary={() => addTermSame('right')}
            />
          ) : (
            <Empty
              label="사건 폴더를 열어 시작하세요 (작성문서 또는 사건기록 폴더)"
              actionLabel="사건 폴더 열기"
              onAction={() => void openConnOrLocal()}
              secondaryLabel="새 작업환경 만들기"
              onSecondary={openNewWorkspaceWindow}
            />
          ))}
        {termTabs.map((t) => (
          <div
            key={t.id}
            className="term-pane"
            data-term-id={t.id}
            data-work-side={termSide(t)}
            tabIndex={isAgentTab(t) ? -1 : undefined}
            onFocus={() => selectTerm(t.id)}
            onMouseDown={(e) => {
              selectTerm(t.id)
              if (!isAgentTab(t)) return
              const target = e.target as HTMLElement
              if (!target.closest('input, textarea, button, select, a')) e.currentTarget.focus()
            }}
            style={{ display: t.id === activeTerm ? 'block' : 'none' }}
          >
            {isAgentTab(t) ? (
              <AgentPanel
                id={t.id}
                cwd={t.cwd}
                title={t.title}
                resumeSessionId={t.resumeSessionId}
                ssh={t.ssh}
                profileId={t.profileId}
                visible={t.id === activeTerm}
                attachmentRequests={agentAttachmentRequests[t.id] ?? []}
                onAttachmentRequestsHandled={(requestIds) =>
                  handleAgentAttachmentRequestsHandled(t.id, requestIds)
                }
                onStatus={(s) => onTermStatus(t.id, s)}
                onOpenTerminal={() => addTermSame(termSide(t), t.id, { reuseAgentTab: true })}
                onOpenDiff={openAgentDiff}
              />
            ) : (
              <Terminal
                id={t.id}
                cwd={t.cwd}
                autoClaude={t.autoClaude ?? false}
                resumeSessionId={t.resumeSessionId}
                ssh={t.ssh}
                visible={t.id === activeTerm}
                focusNonce={termFocusNonce[t.id] ?? 0}
                todoContext={todoContextForTerm(t)}
                onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                onAskSelection={(text) => askAboutTerminalSelection(t.id, text)}
                onNewTerminal={() => addTermSame(termSide(t), t.id)}
                onRequestClose={() => closeTermWithConfirm(t.id)}
                onStatus={(s) => onTermStatus(t.id, s)}
                onBracketedPasteModeChange={(enabled) => onTermBracketedPasteMode(t.id, enabled)}
                onTodoChanged={() => setTodoNonce((n) => n + 1)}
                onNewAgent={() => addAgentSame(termSide(t), t.id)}
                onCycleTab={(dir) => cycleTerm(dir, t.id)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )

  const renderWorkPane = (side: DockSide): ReactNode => {
    if (side === 'left' && mode === 'cases') {
      return (
        <div className="work-pane work-left" key="cases" data-work-side="left">
          <CasesDashboard
            onOpenWorkspace={openCaseWorkspace}
            onOpenRemote={openCaseRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultCaseOpenProfileId}
            onBrief={briefCaseToClaude}
            onDraft={draftCaseWithClaude}
            onChanged={() => setJsNonce((n) => n + 1)}
          />
        </div>
      )
    }

    if (side === 'left' && mode === 'todos') {
      return (
        <div className="work-pane work-left" key="todos" data-work-side="left">
          <TodosDashboard
            nonce={todoNonce}
            onChanged={() => setTodoNonce((n) => n + 1)}
            onOpenWorkspace={openCaseWorkspace}
            onOpenRemote={openCaseRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultCaseOpenProfileId}
            onBrief={briefCaseToClaude}
            onDraft={draftCaseWithClaude}
            onAskClaudeTodoUpdate={(prompt) =>
              sendClaude(prompt, { displayText: '할일 변경분을 기준으로 클코 갱신 요청을 보냈습니다.' })
            }
          />
        </div>
      )
    }

    const docs = docTabs.filter((t) => docSide(t) === side)
    const terms = termTabs.filter((t) => termSide(t) === side)
    const workTabs = [
      ...docs.map((t) => ({
        id: docKey(t.id),
        title: t.title,
        tooltip: t.path,
        path: t.path,
        renamable: t.kind === 'mdview' || t.kind === 'markdown',
        dragPayload: docTabDragPayload(t, side)
      })),
      ...terms.map((t) => ({
        id: termKeyOf(t.id),
        title: t.renamed
          ? t.title
          : t.sessionTitle
            ? `${t.title} · ${t.sessionTitle}`
            : isAgentTab(t)
              ? `Agent · ${t.title}`
              : t.title,
        attention: termAttention.has(t.id) && termStatus.get(t.id) !== 'question',
        working: termStatus.get(t.id) === 'working',
        question: termStatus.get(t.id) === 'question' && termAttention.has(t.id),
        renamable: true,
        dragPayload: { kind: 'terminal', tab: { ...t, side } } as TabPayload,
        tooltip: [
          isAgentTab(t) && 'Claude Agent',
          t.ssh && `🔗 ${t.sshLabel ?? '원격'} (${t.ssh.user}@${t.ssh.host})`,
          t.court && `${t.court}`,
          t.caseNumber,
          t.caseName,
          t.client && `의뢰인 ${t.client}`,
          t.cwd
        ]
          .filter(Boolean)
          .join('\n')
      }))
    ]
    const activeKey = workTabs.some((t) => t.id === activeWork[side])
      ? activeWork[side]
      : (workTabs[0]?.id ?? '')
    const activeParsed = parseWorkKey(activeKey)
    const activeDocForPane =
      activeParsed?.kind === 'doc' ? docs.find((t) => t.id === activeParsed.id) : undefined
    const visibleTermId = activeParsed?.kind === 'terminal' ? activeParsed.id : ''
    const hasTerms = terms.length > 0
    const sessionListSide = termSide(activeTermTab)
    const canOpenSessionList = hasTerms || (side === sessionListSide && !!sessionCaseSource)
    const canMoveActiveTab = !!activeKey

    return (
      <div className={`work-pane work-${side}`} key={side} data-work-side={side}>
        <TabBar
          tabs={workTabs}
          activeId={activeKey}
          onSelect={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') activateDocTab(parsed.id)
            else selectTerm(parsed.id)
          }}
          onClose={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') closeDoc(parsed.id)
            else closeTerm(parsed.id)
          }}
          onAdd={() => (side === 'right' ? addAgentSame(side) : addDoc(side))}
          addTitle={side === 'right' ? '새 Agent' : '새 문서'}
          dropSide={side}
          onReorder={(from, to) => {
            const f = parseWorkKey(from)
            const t = parseWorkKey(to)
            if (!f || !t || f.kind !== t.kind) return
            if (f.kind === 'doc') reorderDocs(f.id, t.id)
            else reorderTerms(f.id, t.id)
          }}
          onTearOut={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') closeDoc(parsed.id)
            else detachTerm(parsed.id)
          }}
          onDragActive={setTabDragging}
          onRename={(key, title) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') {
              renameDocTab(parsed.id, title)
              return
            }
            setTermTabs((tabs) =>
              tabs.map((t) => (t.id === parsed.id ? { ...t, title, renamed: true } : t))
            )
          }}
          extraLeft={[
            ...(canMoveActiveTab
              ? [
                  {
                    label: side === 'left' ? '⇥' : '⇤',
                    title:
                      activeParsed?.kind === 'doc'
                        ? side === 'left'
                          ? '문서를 오른쪽으로 이동'
                          : '문서를 왼쪽으로 이동'
                        : side === 'left'
                          ? '터미널을 오른쪽으로 이동'
                          : '터미널을 왼쪽으로 이동',
                    onClick: () => moveWorkTabToSide(activeKey, otherSide(side))
                  }
                ]
              : []),
            ...(canOpenSessionList
              ? [
                  {
                    label: '☰',
                    title: '세션 목록',
                    active: sessionListOpen && side === sessionListSide,
                    onClick: () => {
                      const cur =
                        terms.find((t) => t.id === activeTerm) ??
                        terms[0]
                      if (cur) {
                        setActiveTerm(cur.id)
                        setWorkActive(side, termKeyOf(cur.id))
                        setSessionFilter(cur.jsId ?? 'all')
                      } else {
                        setSessionFilter(sessionCaseSource?.jsId ?? 'all')
                      }
                      setSessionListOpen((v) => !(v && side === sessionListSide))
                    }
                  }
                ]
              : [])
          ]}
          extra={
            side === 'left'
              ? {
                  label: '＋A',
                  title: '새 Agent',
                  onClick: () => addAgentSame(side)
                }
              : undefined
          }
          menu={
            side === 'right'
              ? {
                  label: '▾',
                  title: '작업 추가 메뉴',
                  items: [
                    {
                      label: '터미널로 실행',
                      title: '현재 사건을 터미널로 실행',
                      onClick: () => addTermSame(side, activeTerm, { reuseAgentTab: true })
                    }
                  ]
                }
              : {
                  label: '▾',
                  title: '작업 추가 메뉴',
                  items: [
                    {
                      label: '새 터미널',
                      title: '이 패널에 터미널 열기',
                      onClick: () => addTermSame(side)
                    }
                  ]
                }
          }
        />
        {sessionListOpen && side === sessionListSide && (
          <SessionList
            sessions={termTabs}
            activeId={activeTerm}
            filter={sessionFilter}
            onFilter={setSessionFilter}
            caseCwd={sessionCaseSource?.cwd ?? currentCase?.drafts}
            caseSource={sessionCaseSource}
            onSelect={(id) => {
              selectTerm(id)
              setSessionListOpen(false)
            }}
            onResume={(sid, cwd, title, source) => {
              openPastSession(sid, cwd, title, source, side)
              setSessionListOpen(false)
            }}
            onClose={() => setSessionListOpen(false)}
          />
        )}
        <div className="work-content">
          {workTabs.length === 0 &&
            (side === 'right' ? (
              currentCase ? (
                <Empty
                  label={`「${currentCase.name}」 — 오른쪽에 열린 탭이 없습니다`}
                  actionLabel="이 사건에서 Agent 열기"
                  onAction={() => addAgentSame(side)}
                  secondaryLabel="터미널로 실행"
                  onSecondary={() => addTermSame(side)}
                />
              ) : (
                <Empty
                  label="오른쪽에 열린 탭이 없습니다"
                  actionLabel="작업환경 시작"
                  onAction={() => void openConnOrLocal()}
                />
              )
            ) : (
              <Empty label="왼쪽에 열린 탭이 없습니다" actionLabel="새 문서" onAction={() => addDoc(side)} />
            ))}
          {activeDocForPane && (
            <div
              className="doc-content"
              data-doc-id={activeDocForPane.id}
              data-work-side={side}
              tabIndex={-1}
              onMouseDown={(e) => {
                activateDocTab(activeDocForPane.id)
                const target = e.target as HTMLElement
                if (shouldFocusDocContainer(target)) e.currentTarget.focus()
              }}
            >
              {renderDocContent(activeDocForPane)}
            </div>
          )}
          {terms.map((t) => (
            <div
              key={t.id}
              className="term-pane"
              data-term-id={t.id}
              data-work-side={side}
              tabIndex={isAgentTab(t) ? -1 : undefined}
              onFocus={() => selectTerm(t.id)}
              onMouseDown={(e) => {
                selectTerm(t.id)
                if (!isAgentTab(t)) return
                const target = e.target as HTMLElement
                if (!target.closest('input, textarea, button, select, a')) e.currentTarget.focus()
              }}
              style={{ display: t.id === visibleTermId ? 'block' : 'none' }}
            >
              {isAgentTab(t) ? (
                <AgentPanel
                  id={t.id}
                  cwd={t.cwd}
                  title={t.title}
                  resumeSessionId={t.resumeSessionId}
                  ssh={t.ssh}
                  profileId={t.profileId}
                  visible={t.id === visibleTermId}
                  attachmentRequests={agentAttachmentRequests[t.id] ?? []}
                  onAttachmentRequestsHandled={(requestIds) =>
                    handleAgentAttachmentRequestsHandled(t.id, requestIds)
                  }
                  onStatus={(s) => onTermStatus(t.id, s)}
                  onOpenTerminal={() => addTermSame(side, t.id, { reuseAgentTab: true })}
                  onOpenDiff={openAgentDiff}
                />
              ) : (
                <Terminal
                  id={t.id}
                  cwd={t.cwd}
                  autoClaude={t.autoClaude ?? false}
                  resumeSessionId={t.resumeSessionId}
                  ssh={t.ssh}
                  visible={t.id === visibleTermId}
                  focusNonce={termFocusNonce[t.id] ?? 0}
                  todoContext={todoContextForTerm(t)}
                  onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                  onAskSelection={(text) => askAboutTerminalSelection(t.id, text)}
                  onNewTerminal={() => addTermSame(side, t.id)}
                  onRequestClose={() => closeTermWithConfirm(t.id)}
                  onStatus={(s) => onTermStatus(t.id, s)}
                  onBracketedPasteModeChange={(enabled) => onTermBracketedPasteMode(t.id, enabled)}
                  onTodoChanged={() => setTodoNonce((n) => n + 1)}
                  onNewAgent={() => addAgentSame(side, t.id)}
                  onCycleTab={(dir) => cycleTerm(dir, t.id)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // 탭을 창 밖으로 찢어낸 '문서 전용 창': 터미널·탐색기·액티비티바 없이 문서만.
  if (docOnly) {
    return (
      <div className="shell-doconly" {...shellDragProps}>
        <div className="body-col">
          {docTabBar}
          <div
            className="doc-content"
            data-doc-id={activeDocTab?.id}
            data-work-side="left"
            tabIndex={-1}
            onMouseDown={(e) => {
              const target = e.target as HTMLElement
              if (shouldFocusDocContainer(target)) e.currentTarget.focus()
            }}
          >
            {renderDocContent(activeDocTab)}
          </div>
        </div>
        <div className="statusbar">
          <span className="status-left">legal-terminal · 문서</span>
          <span className="status-right">{statusInfo}</span>
        </div>
        <SelectionAsk onAsk={askClaude} />
        <SelectionMenu onAsk={askClaude} />
      </div>
    )
  }

  if (termOnly) {
    return (
      <div className="shell-terminalonly" {...shellDragProps}>
        {terminalPanel}
        <div className="statusbar">
          <span className="status-left">legal-terminal · 터미널</span>
          <span className="status-right">{statusInfo}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`shell ${isViewer ? 'mode-viewer' : 'mode-default'}`}
      {...shellDragProps}
    >
      {/* ── 액티비티바 (모드 전환) ── */}
      <div className="activitybar" key="activity">
        <div className="activitybar-top">
          {ACTIVITY.map((item) => (
            <button
              key={item.id}
              className={`activity-item ${mode === item.id ? 'active' : ''}`}
              title={item.label}
              onClick={() => setMode(item.id)}
            >
              <item.Icon />
            </button>
          ))}
        </div>
        <div className="activitybar-bottom">
          <button
            className="activity-item"
            title="작업환경 저장 (Shift: 파일로 내보내기)"
            onClick={(e) => void saveWorkspace(e.shiftKey)}
          >
            <IconSave />
          </button>
          <button
            className="activity-item"
            title="저장된 작업환경 가져오기 (Shift: JSON 파일에서 가져오기)"
            onClick={(e) => void restoreWorkspace(e.shiftKey)}
          >
            <IconSync />
          </button>
          <button className="activity-item" title="새 작업환경 만들기" onClick={openNewWorkspaceWindow}>
            <IconWorkspace />
          </button>
          <button className="activity-item" title="설정" onClick={openSettings}>
            <IconSettings />
          </button>
        </div>
      </div>

      <div className="side-col" key="side">
        {docsPanel}
      </div>

      {renderWorkPane('left')}

      {/* ── 서증·첨부서류 (뷰어 모드에서만) ── */}
      {isViewer && <EvidencePanel key="evid" record={panelRecord} onOpenItem={onOpenItem} />}

      {renderWorkPane('right')}

      <div className="statusbar" key="status">
        <span className="status-left">legal-terminal · {modeLabel(mode)}</span>
        <span className="status-right">{statusInfo}</span>
      </div>

      <SelectionAsk onAsk={askClaude} />
      <SelectionMenu onAsk={askClaude} />

      {workspacePick && (
        <WorkspacePicker
          loading={workspacePick.loading}
          entries={workspacePick.entries}
          error={workspacePick.error}
          onLoad={(entry) => void loadSavedWorkspaceEntry(entry)}
          onRefresh={() => void openSavedWorkspacePicker()}
          onClose={() => setWorkspacePick(null)}
        />
      )}

      {/* 접속 선택 (로컬 / 저장된 SSH 프로필) */}
      {connMenu && (
        <ConnMenu
          profiles={sshProfiles}
          onLocal={() => {
            setConnMenu(false)
            void addCase()
          }}
          onRemote={(p) => {
            setConnMenu(false)
            setRemotePick(p)
          }}
          onManage={() => {
            setConnMenu(false)
            openSettings()
          }}
          onClose={() => setConnMenu(false)}
        />
      )}

      {/* 원격 사건(작성서류) 폴더 선택 */}
      {remotePick && (
        <RemoteFolderPicker
          profile={remotePick}
          onCancel={() => setRemotePick(null)}
          onPick={async (remotePath) => {
            const prof = remotePick
            setRemotePick(null)
            const opened = createRemoteCase(prof, remotePath)
            resolveRemoteRecordsLater(opened.id, prof, remotePath, opened.title)
          }}
        />
      )}

      {/* 사건(JuriSupport) 원격 열기 — 자동 매칭 실패 시 폴더 직접 선택 */}
      {remoteCasePick && (
        <RemoteFolderPicker
          profile={remoteCasePick.profile}
          title={`「${remoteCasePick.name}」 작성서류 폴더 선택`}
          onCancel={() => setRemoteCasePick(null)}
          onPick={async (remotePath) => {
            const { profile, name, meta, caseData } = remoteCasePick
            setRemoteCasePick(null)
            const opened = createRemoteCase(profile, remotePath, name, meta)
            resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, caseData)
            setMode('explorer')
          }}
        />
      )}

      {/* rclone 동기화 모달 */}
      {syncInit && (
        <SyncModal
          profiles={sshProfiles}
          init={syncInit}
          onClose={() => setSyncInit(null)}
        />
      )}

      {/* 원격 소송기록 폴더 선택 (기록뷰어) */}
      {recordsPick && (
        <RemoteFolderPicker
          profile={recordsPick.profile}
          title="소송기록 폴더 선택"
          confirmLabel="이 폴더로 지정"
          startPath={recordsPick.startPath}
          onCancel={() => setRecordsPick(null)}
          onPick={(remotePath) => {
            const uri = remoteUri(recordsPick.profile.id, remotePath)
            const cur = termTabs.find((t) => t.id === activeTerm)
            setTermTabs((tabs) =>
              tabs.map((t) =>
                activeTerm && t.id === activeTerm
                  ? {
                      ...t,
                      recordsFolder: uri,
                      suggestedRecords: undefined,
                      suggestedRecordOptions: undefined
                    }
                  : t
              )
            )
            setCurrentCase((c) => (c ? { ...c, records: uri } : c))
            // 페어링 기억 → 다음에 이 사건을 열면 자동 적용
            const draftsPath = recordsPick.draftsPath ?? (cur?.ssh ? cur.cwd : undefined)
            if (draftsPath) {
              const drafts = remoteUri(recordsPick.profile.id, draftsPath)
              window.lt.case.setPairing(drafts, uri)
              window.lt.case
                .addHistory({ drafts, records: uri, name: recordsPick.title ?? cur?.title ?? '사건' })
                .then(setRecent)
            }
            setRecordsPick(null)
          }}
        />
      )}

      {/* claude 질문/확인 대기 팝업 */}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div
              key={t.key}
              className="toast"
              onClick={() => {
                selectTerm(t.termId)
                dismissToast(t.key)
              }}
            >
              <span className="toast-icon">❓</span>
              <span className="toast-body">
                <b>{t.title}</b>
                <span className="toast-sub">claude가 확인/입력을 기다립니다 — 클릭하여 이동</span>
              </span>
              <button
                className="toast-x"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissToast(t.key)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const SELECTION_ACTION_TARGET_SELECTOR = '.text-doc, .file-view, .pdf-viewer, .textLayer, .csv-wrap'
const SELECTION_ACTION_EXCLUDE_SELECTOR =
  '.terminal-surface, .xterm, .agent-panel, .tabs, .sidebar, .activitybar, .statusbar, button, input, textarea, select'

const elementFromSelectionNode = (node: Node | null | undefined): Element | null =>
  node instanceof Element ? node : (node?.parentElement ?? null)

const canShowSelectionActions = (element: Element | null): boolean => {
  if (!element) return false
  if (element.closest(SELECTION_ACTION_EXCLUDE_SELECTOR)) return false
  return !!element.closest(SELECTION_ACTION_TARGET_SELECTOR)
}

// 본문에서 텍스트 선택 후 우클릭 → 컨텍스트 메뉴 (Claude/법제처/법고을/엘박스)
function SelectionMenu({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [menu, setMenu] = useState<{
    x: number
    y: number
    text: string
    queryText: string
    markdown?: string
  } | null>(null)
  const editorSelectionRef = useRef<TextSelectionOverlayDetail | null>(null)

  useEffect(() => {
    const onCtx = (e: MouseEvent): void => {
      const sel = window.getSelection()
      const target = e.target instanceof Element ? e.target : null
      const anchor = elementFromSelectionNode(sel?.anchorNode)
      const el = anchor ?? target
      const editorDetail = editorSelectionRef.current
      const targetEditor = target?.closest('.cm-editor') ?? null
      const anchorEditor = anchor?.closest('.cm-editor') ?? null
      const activeEditor =
        document.activeElement instanceof Element ? document.activeElement.closest('.cm-editor') : null
      const contextEditor = targetEditor ?? anchorEditor
      const isEditorContext =
        !!contextEditor && (anchorEditor === contextEditor || activeEditor === contextEditor)
      const markdown = isEditorContext && editorDetail?.markdown?.trim() ? editorDetail.markdown : undefined
      const text = (markdown ?? sel?.toString() ?? '').trim()
      if (!text || !canShowSelectionActions(el)) return // 선택 없으면 기본 메뉴
      e.preventDefault()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        text,
        queryText: markdown ? markdownToPlainText(markdown) || text : text,
        markdown
      })
    }
    const onEditorSelection = (event: Event): void => {
      const detail = (event as CustomEvent<TextSelectionOverlayDetail | null>).detail
      editorSelectionRef.current = detail?.markdown?.trim() ? detail : null
    }
    const close = (): void => setMenu(null)
    document.addEventListener('contextmenu', onCtx)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    return () => {
      document.removeEventListener('contextmenu', onCtx)
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
  }, [])

  if (!menu) return null
  const q = encodeURIComponent(menu.queryText)
  const open = (url: string): void => void window.lt.app.openExternal(url)
  const items: { label: string; act: () => void }[] = [
    ...(menu.markdown
      ? [
          {
            label: 'MD로 복사하기',
            act: () => {
              void writeMarkdownClipboard(menu.markdown!, 'markdown')
            }
          },
          {
            label: '텍스트로 복사하기',
            act: () => {
              void writeMarkdownClipboard(menu.markdown!, 'text')
            }
          }
        ]
      : []),
    { label: '✳ Claude에 물어보기', act: () => onAsk(menu.text) },
    { label: '법제처 검색', act: () => open(`https://www.law.go.kr/LSW/lsSc.do?menuId=1&query=${q}`) },
    {
      label: '법고을 검색',
      act: () => open(`https://lx.scourt.go.kr/sc/krcom/sc/cs/search/cmmnSearchList.do?searchWord=${q}`)
    },
    { label: '엘박스 검색', act: () => open(`https://lbox.kr/search?query=${q}`) }
  ]
  return (
    <ul
      className="ctx-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 150) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <li
          key={i}
          className="ctx-item"
          onClick={() => {
            it.act()
            setMenu(null)
          }}
        >
          {it.label}
        </li>
      ))}
    </ul>
  )
}

// 본문에서 텍스트를 선택하면 떠오르는 "Claude에 묻기" 버튼
function SelectionAsk({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [box, setBox] = useState<TextSelectionOverlayDetail | null>(null)

  useEffect(() => {
    let frame = 0
    let pointerSelecting = false
    let pendingEditorDetail: TextSelectionOverlayDetail | null = null

    const updateFromSelection = (): void => {
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      const visibleText = text.trim()
      if (!sel || sel.rangeCount === 0 || !visibleText) {
        if (!(document.activeElement instanceof Element) || !document.activeElement.closest('.cm-editor')) {
          setBox(null)
        }
        return
      }
      const el = elementFromSelectionNode(sel.anchorNode)
      if (!canShowSelectionActions(el)) {
        setBox(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setBox(null)
        return
      }
      setBox({ x: rect.left + rect.width / 2, y: rect.top - 6, text, count: Array.from(visibleText).length })
    }

    const scheduleUpdate = (): void => {
      if (pointerSelecting) return
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        updateFromSelection()
      })
    }

    const applyEditorDetail = (detail: TextSelectionOverlayDetail | null): void => {
      if (!detail?.text.trim()) {
        setBox(null)
        return
      }
      setBox(detail)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary || event.button !== 0) return
      pointerSelecting = true
      pendingEditorDetail = null
      setBox(null)
    }
    const onPointerUp = (): void => {
      if (!pointerSelecting) return
      pointerSelecting = false
      const detail = pendingEditorDetail
      pendingEditorDetail = null
      if (detail) applyEditorDetail(detail)
      else scheduleUpdate()
    }
    const onPointerCancel = (): void => {
      pointerSelecting = false
      pendingEditorDetail = null
      setBox(null)
    }
    const onEditorSelection = (event: Event): void => {
      const detail = (event as CustomEvent<TextSelectionOverlayDetail | null>).detail
      if (pointerSelecting) {
        pendingEditorDetail = detail
        setBox(null)
        return
      }
      applyEditorDetail(detail)
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('dragstart', onPointerCancel, true)
    document.addEventListener('selectionchange', scheduleUpdate)
    document.addEventListener('keyup', scheduleUpdate)
    window.addEventListener('blur', onPointerCancel)
    window.addEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('dragstart', onPointerCancel, true)
      document.removeEventListener('selectionchange', scheduleUpdate)
      document.removeEventListener('keyup', scheduleUpdate)
      window.removeEventListener('blur', onPointerCancel)
      window.removeEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
  }, [])

  if (!box) return null
  return (
    <button
      className="sel-ask"
      style={{ left: box.x, top: box.y }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={() => {
        onAsk(box.text)
        setBox(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      ✳ Claude에 묻기
    </button>
  )
}

function modeLabel(mode: Mode): string {
  return { explorer: '탐색기', cases: '사건', viewer: '기록뷰어', todos: '할일' }[mode]
}

/** 탭 닫기 공통: 닫힌 탭이 활성이면 이웃으로 활성 이동 */
function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void
): T[] {
  const idx = tabs.findIndex((t) => t.id === id)
  const next = tabs.filter((t) => t.id !== id)
  if (id === activeId) setActive(next.length > 0 ? next[Math.min(idx, next.length - 1)].id : '')
  return next
}

// ── 좌측 문서 패널 (모드별) ──
// 탐색기 모드 = 작성서류 폴더 트리. 뷰어 모드 = 열린 PDF의 본안 문서 목차(없으면 소송기록 폴더 트리).
function DocsPanel({
  mode,
  draftsFolder,
  recordsFolder,
  suggestedRecords,
  suggestedRecordOptions,
  record,
  refreshNonce,
  onOpenFile,
  onDropTo,
  onMove,
  onRename,
  onDelete,
  onPasteTo,
  onDownload,
  onPickRecords,
  onSyncRecords,
  onApplySuggested,
  onOpenItem,
  onDropFiles,
  onNewFolder,
  onNewFile,
  onSync,
  onOpenWorkspace,
  onOpenCase,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft,
  jsNonce,
  todoNonce,
  onTodoChanged,
  pendingCreate,
  onRequestCreate,
  onCreateEntry,
  onCancelCreate
}: {
  mode: Mode
  draftsFolder?: string
  recordsFolder?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
  record: ParsedRecord | null
  refreshNonce: number
  onOpenFile: (path: string, name: string) => void
  onDropTo: (dir: string, files: FileList) => void
  onMove: (src: string, destDir: string) => void
  onRename: (path: string, name: string) => void
  onDelete: (path: string, name: string, isDir: boolean) => void
  onPasteTo: (dir: string) => void
  onDownload: (path: string, name: string, isDir: boolean) => void
  onPickRecords: () => void
  onSyncRecords?: () => void
  onApplySuggested: (path?: string) => void
  onOpenItem: (it: OutlineItem) => void
  onDropFiles: (files: FileList) => void
  onNewFolder: () => void
  onNewFile: () => void
  onSync?: () => void
  onOpenWorkspace: () => void
  onOpenCase: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief: (c: JsCase) => void
  onDraft: (c: JsCase) => void
  jsNonce: number
  todoNonce: number
  onTodoChanged: () => void
	  pendingCreate: PendingCreateRequest | null
  onRequestCreate: (dir: string, type: 'file' | 'folder') => void
  onCreateEntry: (name: string, type: 'file' | 'folder', dir?: string) => void
  onCancelCreate: () => void
}): JSX.Element {
  const title = { explorer: '탐색기', cases: '다가오는 기일', viewer: '문서', todos: '오늘 할일' }[mode]
  const [dragOver, setDragOver] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SORT_MODE)
  const [fileFindOpen, setFileFindOpen] = useState(false)
  const [fileFindQuery, setFileFindQuery] = useState('')
  const canDrop = mode === 'explorer' && !!draftsFolder
  const canDropFiles = (e: React.DragEvent): boolean =>
    canDrop && e.dataTransfer.types.includes('Files')
  const closeFileFind = (): void => {
    setFileFindOpen(false)
    setFileFindQuery('')
  }
  useEffect(() => {
    let alive = true
    const applySettings = (settings: AppSettings): void => {
      if (alive) setSortMode(resolveSortMode(settings.explorerSortMode))
    }
    window.lt.settings.get().then(applySettings).catch(() => {})
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [])
  const updateSortMode = (nextMode: SortMode): void => {
    setSortMode(nextMode)
    void window.lt.settings.set({ explorerSortMode: nextMode }).then(emitSettingsUpdated).catch(() => {})
  }
  return (
    <div
      className={`sidebar ${dragOver ? 'drag-over' : ''}`}
      tabIndex={0}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement
        if (!target.closest('input, button, select')) e.currentTarget.focus()
      }}
      onKeyDown={(e) => {
        const primary = e.metaKey || e.ctrlKey
        if (mode !== 'explorer' || !primary || e.shiftKey || e.altKey) return
        if (e.key.toLowerCase() !== 'f') return
        e.preventDefault()
        e.stopPropagation()
        setFileFindOpen(true)
      }}
      onDragOver={(e) => {
        if (!canDropFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!canDropFiles(e)) return
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files)
      }}
    >
      {dragOver && (
        <div className="drop-guide sidebar-drop-guide" role="status" aria-live="polite">
          <strong>작성서류 폴더에 복사</strong>
          <span>파일을 현재 사건 폴더에 추가</span>
        </div>
      )}
      <div className={`sidebar-header ${mode === 'explorer' ? 'explorer-header' : ''}`}>
        {mode === 'explorer' ? (
          <>
            <div className="sidebar-header-main">
              <span className="sidebar-title">{title}</span>
              <span className="header-actions explorer-actions">
                <button className="tool-btn" title="새 작업환경 열기" onClick={onOpenWorkspace}>
                  <IconWorkspace size={15} />
                  <span className="sr-only">새 작업환경 열기</span>
                </button>
                <button className="tool-btn" title="새 파일" disabled={!draftsFolder} onClick={onNewFile}>
                  <IconNewFile size={15} />
                  <span className="sr-only">새 파일</span>
                </button>
                <button
                  className={`tool-btn ${fileFindOpen ? 'on' : ''}`}
                  title="파일명 찾기"
                  disabled={!draftsFolder}
                  onClick={() => setFileFindOpen((v) => !v)}
                >
                  <IconSearch size={15} />
                  <span className="sr-only">파일명 찾기</span>
                </button>
                <button
                  className="tool-btn"
                  title="새 폴더"
                  disabled={!draftsFolder}
                  onClick={onNewFolder}
                >
                  <IconNewFolder size={15} />
                  <span className="sr-only">새 폴더</span>
                </button>
                {onSync && (
                  <button
                    className="tool-btn"
                    title="rclone 동기화 (로컬 ↔ 맥미니)"
                    disabled={!draftsFolder}
                    onClick={onSync}
                  >
                    <IconSync size={15} />
                    <span className="sr-only">동기화</span>
                  </button>
                )}
              </span>
            </div>
            <div className="explorer-sort-row">
              <select
                className="sort-select explorer-sort-select"
                value={sortMode}
                title="정렬"
                aria-label="탐색기 정렬"
                disabled={!draftsFolder}
                onChange={(e) => updateSortMode(resolveSortMode(e.target.value))}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {fileFindOpen && (
              <div className="explorer-find-row">
                <FindBar
                  value={fileFindQuery}
                  placeholder="파일명 찾기"
                  resultLabel={fileFindQuery.trim() ? '파일명' : ''}
                  onChange={setFileFindQuery}
                  onClose={closeFileFind}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <span className="sidebar-title">{title}</span>
            <span className="header-actions">
              {mode === 'viewer' && recordsFolder && (
                <>
                  {onSyncRecords && (
                    <button
                      className="tool-btn"
                      title="소송기록 클라우드에서 최신화"
                      onClick={onSyncRecords}
                    >
                      <IconSync size={15} />
                      <span className="sr-only">소송기록 최신화</span>
                    </button>
                  )}
                  <button className="header-btn" title="소송기록 폴더 변경" onClick={onPickRecords}>
                    변경
                  </button>
                </>
              )}
            </span>
          </>
        )}
      </div>
      <div className="sidebar-body">
        {mode === 'explorer' &&
          (draftsFolder ? (
            <FileTree
              root={draftsFolder}
              refreshNonce={refreshNonce}
              onOpenFile={onOpenFile}
              onDropTo={onDropTo}
              onMove={onMove}
              onRename={onRename}
              onDelete={onDelete}
              onPasteTo={onPasteTo}
              onDownload={onDownload}
              pendingCreate={pendingCreate}
              sortMode={sortMode}
              filter={fileFindOpen ? fileFindQuery : ''}
              onRequestCreate={onRequestCreate}
              onCreate={onCreateEntry}
              onCancelCreate={onCancelCreate}
            />
          ) : (
            <p className="muted pad">활성 사건이 없습니다. 오른쪽에서 사건 폴더를 여세요.</p>
          ))}
        {mode === 'viewer' &&
          (record ? (
            <>
              <CaseHeader record={record} />
              {record.documents.length ? (
                <OutlineList items={record.documents} onOpen={onOpenItem} />
              ) : (
                <p className="muted pad small">본안 문서가 없습니다.</p>
              )}
            </>
          ) : (
            <RecordsBody
              {...{
                draftsFolder,
                suggestedRecords,
                suggestedRecordOptions,
                onPickRecords,
                onApplySuggested
              }}
            />
          ))}
        {mode === 'cases' && (
          <UpcomingHearings
            nonce={jsNonce}
            onPick={onOpenCase}
            onOpenRemote={onOpenRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultOpenProfileId}
            onBrief={onBrief}
            onDraft={onDraft}
          />
        )}
        {mode === 'todos' && <TodayTodos nonce={todoNonce} onChanged={onTodoChanged} />}
      </div>
    </div>
  )
}

// ── 서증·첨부서류 패널 (뷰어 모드) ──
function EvidencePanel({
  record,
  onOpenItem
}: {
  record: ParsedRecord | null
  onOpenItem: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <div className="evid-panel">
      <div className="sidebar-header">서증 · 첨부서류</div>
      <div className="sidebar-body">
        {record ? (
          <>
            <SectionLabel text={`서증 (${record.evidences.length})`} />
            {record.evidences.length ? (
              <OutlineList items={record.evidences} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">서증 없음</p>
            )}
            <SectionLabel text={`첨부서류 (${record.attachments.length})`} />
            {record.attachments.length ? (
              <OutlineList items={record.attachments} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">첨부서류 없음</p>
            )}
          </>
        ) : (
          <p className="muted pad">소송기록 폴더를 지정하면 서증·첨부서류가 분류됩니다.</p>
        )}
      </div>
    </div>
  )
}

// 법원·사건번호 한 줄 (상단 1회 표시)
function CaseHeader({ record }: { record: ParsedRecord }): JSX.Element {
  return (
    <div className="case-header">
      {[record.court, record.caseNo].filter(Boolean).join(' · ') || '사건 정보 없음'}
    </div>
  )
}

function SectionLabel({ text }: { text: string }): JSX.Element {
  return <div className="section-label">{text}</div>
}

// 목차/서증 항목 리스트 — 클릭 시 파일 열기(폴더 기반) 또는 페이지 점프(목차 기반)
function OutlineList({
  items,
  onOpen
}: {
  items: OutlineItem[]
  onOpen: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <ul className="outline-list">
      {items.map((it, i) => (
        <li
          key={i}
          className={`outline-item ${it.party ? 'party-' + it.party : ''}`}
          title={it.path ? `${it.rawTitle}\n(끌어서 터미널에 놓으면 Claude에 질문)` : it.rawTitle}
          onClick={() => onOpen(it)}
          draggable={!!it.path}
          onDragStart={
            it.path
              ? (e) => {
                  if (cancelIfTerminalPointerDrag(e)) return
                  e.dataTransfer.setData(LT_PATH, it.path as string)
                  e.dataTransfer.effectAllowed = 'copyMove'
                }
              : undefined
          }
        >
          <span className="outline-label">{it.label}</span>
          {it.page > 0 && <span className="outline-page">{it.page}</span>}
        </li>
      ))}
    </ul>
  )
}

// 뷰어 모드: 소송기록 미지정 시 — 추천 폴더 제안(있으면) 또는 선택 버튼
function RecordsBody({
  draftsFolder,
  suggestedRecords,
  suggestedRecordOptions,
  onPickRecords,
  onApplySuggested
}: {
  draftsFolder?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
  onPickRecords: () => void
  onApplySuggested: (path?: string) => void
}): JSX.Element {
  const suggestions =
    suggestedRecordOptions?.length
      ? suggestedRecordOptions
      : suggestedRecords
        ? [
            {
              path: suggestedRecords,
              name: fileNameFromPath(suggestedRecords),
              reason: '이전 연결',
              score: 0
            }
          ]
        : []
  if (suggestions.length)
    return (
      <div className="suggest pad">
        <p className="muted small">연결할 수 있는 소송기록 폴더 후보가 있습니다:</p>
        <div className="suggest-list">
          {suggestions.slice(0, 6).map((s) => (
            <button
              key={s.path}
              className="suggest-option"
              title={s.path}
              onClick={() => onApplySuggested(s.path)}
            >
              <span className="suggest-name">{s.name}</span>
              <span className="suggest-reason">{s.reason}</span>
              <span className="suggest-path">{s.path}</span>
            </button>
          ))}
        </div>
        <div className="suggest-actions">
          <button className="empty-action" onClick={() => onApplySuggested(suggestions[0]?.path)}>
            첫 후보 열기
          </button>
          <button className="header-btn" onClick={onPickRecords}>
            다른 폴더…
          </button>
        </div>
      </div>
    )
  if (draftsFolder)
    return (
      <Empty
        label="이 사건의 소송기록 폴더가 지정되지 않았습니다"
        actionLabel="소송기록 폴더 선택"
        onAction={onPickRecords}
      />
    )
  return <p className="muted pad">사건을 먼저 여세요 (오른쪽 터미널의 ＋).</p>
}

interface TabBarProps {
  tabs: {
    id: string
    title: string
    tooltip?: string
    path?: string
    dragPayload?: TabPayload
    attention?: boolean
    working?: boolean
    question?: boolean
    renamable?: boolean
  }[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd?: () => void
  addTitle: string
  dropSide?: DockSide
  extra?: TabBarAction | TabBarAction[]
  menu?: {
    label?: string
    icon?: ReactNode
    title: string
    items: TabBarAction[]
  }
  extraLeft?:
    | TabBarAction
    | TabBarAction[]
  // 탭 재정렬(같은 창) + 창 간 이동/찢기. 둘 다 주어질 때만 탭이 draggable.
  onReorder?: (fromId: string, toId: string) => void
  onTearOut?: (id: string) => void
  onDragActive?: (active: boolean) => void
  onRename?: (id: string, title: string) => void
}

interface TabBarAction {
  label?: string
  icon?: ReactNode
  title: string
  active?: boolean
  onClick: () => void
}

function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onAdd,
  addTitle,
  dropSide,
  extra,
  menu,
  extraLeft,
  onReorder,
  onTearOut,
  onDragActive,
  onRename
}: TabBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [dropHint, setDropHint] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const dragId = useRef<string | null>(null)
  const dropHintTimer = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const draggable = !!onTearOut
  const extraLeftItems = extraLeft ? (Array.isArray(extraLeft) ? extraLeft : [extraLeft]) : []
  const extraItems = extra ? (Array.isArray(extra) ? extra : [extra]) : []

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = (): void => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length])

  useEffect(
    () => () => {
      if (dropHintTimer.current) window.clearTimeout(dropHintTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target && menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const scrollBy = (d: number): void => scrollRef.current?.scrollBy({ left: d, behavior: 'smooth' })
  const isTabDrop = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(TAB_DND_TYPE)
  const showDropHint = (): void => {
    setDropHint(true)
    if (dropHintTimer.current) window.clearTimeout(dropHintTimer.current)
    dropHintTimer.current = window.setTimeout(() => setDropHint(false), 180)
  }
  const clearDropHint = (): void => {
    if (dropHintTimer.current) window.clearTimeout(dropHintTimer.current)
    dropHintTimer.current = null
    setDropHint(false)
  }
  const isMiddleButton = (e: React.MouseEvent): boolean => e.button === 1
  const onMiddleMouseDown = (e: React.MouseEvent): void => {
    if (!isMiddleButton(e)) return
    e.preventDefault()
  }
  const addOnMiddleClick = (e: React.MouseEvent): void => {
    if (!isMiddleButton(e) || !onAdd) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('.tab, button, .tab-menu-wrap')) return
    e.preventDefault()
    e.stopPropagation()
    onAdd()
  }
  const closeOnMiddleClick = (e: React.MouseEvent, id: string): void => {
    if (!isMiddleButton(e)) return
    e.preventDefault()
    e.stopPropagation()
    onClose(id)
  }

  return (
    <div
      className={`tabs ${dropHint ? 'drop-target' : ''}`}
      data-drop-side={dropSide}
      onMouseDown={onMiddleMouseDown}
      onAuxClick={addOnMiddleClick}
      onDragOver={(e) => {
        if (!draggable || !isTabDrop(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        showDropHint()
      }}
      onDrop={(e) => {
        if (!draggable || !isTabDrop(e)) return
        e.preventDefault()
        e.stopPropagation()
        clearDropHint()
        void window.lt.tabs.dropOnTabBar(dropSide)
      }}
      onDragLeave={() => clearDropHint()}
    >
      {extraLeftItems.map((item, i) => (
        <button
          key={i}
          className={`tab-add ${item.active ? 'on' : ''}`}
          title={item.title}
          onClick={(e) => {
            e.stopPropagation()
            item.onClick()
          }}
        >
          {item.icon ?? item.label}
        </button>
      ))}
      {overflow && (
        <button className="tab-scroll" title="왼쪽" onClick={() => scrollBy(-180)}>
          ‹
        </button>
      )}
      <div className="tabs-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''} ${t.attention ? 'attention' : ''} ${t.working ? 'working' : ''} ${t.question ? 'question' : ''}`}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => closeOnMiddleClick(e, t.id)}
            title={
              t.working
                ? `${t.tooltip ?? t.title}\n⟳ 작업 중`
                : t.question
                  ? `${t.tooltip ?? t.title}\n❓ 확인/질문 대기`
                  : t.attention
                    ? `${t.tooltip ?? t.title}\n✓ 완료`
                    : (t.tooltip ?? t.title)
            }
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    if (cancelIfTerminalPointerDrag(e)) return
                    dragId.current = t.id
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData(TAB_DND_TYPE, t.id)
                    onDragActive?.(true)
                    if (t.dragPayload) void window.lt.tabs.beginDrag(t.dragPayload)
                  }
                : undefined
            }
            onDragOver={
              draggable
                ? (e) => {
                    if (dragId.current && dragId.current !== t.id) e.preventDefault()
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault()
                    if (dragId.current && dragId.current !== t.id) {
                      e.stopPropagation()
                      onReorder?.(dragId.current, t.id)
                      void window.lt.tabs.endDrag()
                    }
                    dragId.current = null
                  }
                : undefined
            }
            onDragEnd={
              draggable
                ? async () => {
                    const id = dragId.current
                    dragId.current = null
                    onDragActive?.(false)
                    if (!id || !t.dragPayload) return
                    await new Promise((resolve) => window.setTimeout(resolve, 20))
                    const r = await window.lt.tabs.endDrag()
                    if (r?.action === 'moved' && r.removeSource !== false) onTearOut?.(id)
                  }
                : undefined
            }
            onDoubleClick={
              onRename && t.renamable
                ? (e) => {
                    e.stopPropagation()
                    setEditing({ id: t.id, value: t.title })
                  }
                : undefined
            }
          >
            {t.working ? (
              <span className="tab-spin" title="작업 중">
                ⟳
              </span>
            ) : t.question ? (
              <span className="tab-q" title="확인/질문 대기">
                ❓
              </span>
            ) : (
              t.attention && (
                <span className="tab-dot" title="완료">
                  ●
                </span>
              )
            )}
            {editing?.id === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                value={editing.value}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename?.(t.id, editing.value.trim() || t.title)
                    setEditing(null)
                  } else if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => {
                  onRename?.(t.id, editing.value.trim() || t.title)
                  setEditing(null)
                }}
              />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            <button
              className="tab-close"
              title="닫기"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {overflow && (
        <button className="tab-scroll" title="오른쪽" onClick={() => scrollBy(180)}>
          ›
        </button>
      )}
      {extraItems.map((item, i) => (
        <button key={i} className="tab-add" title={item.title} onClick={item.onClick}>
          {item.icon ?? item.label}
        </button>
      ))}
      {onAdd && (
        <button className="tab-add" title={addTitle} onClick={onAdd}>
          ＋
        </button>
      )}
      {menu && menu.items.length > 0 && (
        <div className="tab-menu-wrap" ref={menuRef}>
          <button
            className={`tab-add tab-menu-trigger ${menuOpen ? 'on' : ''}`}
            title={menu.title}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((open) => !open)
            }}
          >
            {menu.icon ?? menu.label ?? '▾'}
          </button>
          {menuOpen && (
            <div className="tab-menu" role="menu">
              {menu.items.map((item, i) => (
                <button
                  key={i}
                  className="tab-menu-item"
                  role="menuitem"
                  title={item.title}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    item.onClick()
                  }}
                >
                  {item.icon && <span className="tab-menu-icon">{item.icon}</span>}
                  <span>{item.label ?? item.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 세션(터미널) 목록 드롭다운 — 사건별 필터 + 선택
function SessionList({
  sessions,
  activeId,
  filter,
  onFilter,
  caseCwd,
  caseSource,
  onSelect,
  onResume,
  onClose
}: {
  sessions: TermTab[]
  activeId: string
  filter: string
  onFilter: (f: string) => void
  caseCwd?: string
  caseSource?: TermTab
  onSelect: (id: string) => void
  onResume: (sessionId: string, cwd: string, title?: string, source?: TermTab) => void
  onClose: () => void
}): JSX.Element {
  const [past, setPast] = useState<SessionListEntry[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const close = (): void => onClose()
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [onClose])

  // 필터 옵션: 전체 + 사건별(jsId) + 폴더 세션
  const caseOpts: { value: string; label: string }[] = []
  const seen = new Set<string>()
  let hasFolder = false
  for (const s of sessions) {
    if (s.jsId) {
      if (!seen.has(s.jsId)) {
        seen.add(s.jsId)
        caseOpts.push({
          value: s.jsId,
          label: [s.caseNumber, s.caseName].filter(Boolean).join(' ') || s.title
        })
      }
    } else hasFolder = true
  }
  if (caseSource?.jsId) {
    if (!seen.has(caseSource.jsId)) {
      seen.add(caseSource.jsId)
      caseOpts.push({
        value: caseSource.jsId,
        label:
          [caseSource.caseNumber, caseSource.caseName].filter(Boolean).join(' ') ||
          caseSource.title
      })
    }
  } else if (caseSource) {
    hasFolder = true
  }
  const shownBase = sessions.filter((s) =>
    filter === 'all' ? true : filter === '__folder__' ? !s.jsId : s.jsId === filter
  )
  const shown = shownBase.filter((s) =>
    matchesSearch(
      [
        s.title,
        s.sessionTitle,
        s.caseNumber,
        s.caseName,
        s.court,
        s.client,
        pathLeaf(s.cwd),
        s.cwd,
        s.recordsFolder,
        s.sshLabel
      ],
      query
    )
  )

  // 과거 세션을 읽을 cwd: 필터된 사건의 열린 세션 cwd → 없으면 현재 사건 cwd
  const activeSession = sessions.find((s) => s.id === activeId)
  const caseFallback =
    filter !== 'all' && filter !== '__folder__'
      ? caseSource?.jsId === filter
        ? caseSource
        : undefined
      : filter === '__folder__'
        ? caseSource && !caseSource.jsId
          ? caseSource
          : undefined
        : caseSource
  const filterSource =
    filter !== 'all' && filter !== '__folder__'
      ? (sessions.find((s) => s.jsId === filter) ?? caseFallback)
    : filter === '__folder__'
        ? (shownBase.find((s) => s.id === activeId) ?? shownBase[0] ?? caseFallback)
        : (activeSession ?? caseFallback)
  const filterCwd =
    filter !== 'all' && filter !== '__folder__'
      ? (filterSource?.cwd ?? caseCwd)
      : (filterSource?.cwd ?? caseCwd)

  useEffect(() => {
    if (!filterCwd) {
      setPast([])
      return
    }
    let alive = true
    const cached = cachedPastSessions(filterCwd, filterSource, query)
    if (cached) setPast(cached)
    else setPast(null)
    loadPastSessions(filterCwd, filterSource, query, !!cached)
      .then((r) => {
        if (!alive) return
        setPast(r)
      })
      .catch(() => {
        if (alive && !cached) setPast([])
      })
    return () => {
      alive = false
    }
  }, [
    filterCwd,
    filterSource?.id,
    filterSource?.caseNumber,
    filterSource?.caseName,
    filterSource?.cwd,
    filterSource?.profileId,
    filterSource?.ssh?.host,
    filterSource?.ssh?.user,
    filterSource?.ssh?.port,
    filterSource?.ssh?.identityFile,
    query
  ])

  const fmt = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  }

  return (
    <div
      className="session-list"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sl-head">
        <span className="sl-title">세션</span>
        <select className="sl-filter" value={filter} onChange={(e) => onFilter(e.target.value)}>
          <option value="all">전체 사건</option>
          {caseOpts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {hasFolder && <option value="__folder__">폴더 세션</option>}
        </select>
      </div>
      <div className="sl-search-row">
        <input
          className="sl-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="사건번호·사건명·작성서류 폴더명 검색"
        />
      </div>
      <ul className="sl-list">
        <li className="sl-section">열린 세션</li>
        {shown.length === 0 && <li className="muted pad small">열린 세션이 없습니다.</li>}
        {shown.map((s) => (
          <li
            key={s.id}
            className={`sl-row ${s.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.cwd}
          >
            <span className="sl-name">{s.title}</span>
            <span className="sl-sub">
              {[s.client && `의뢰인 ${s.client}`, s.court].filter(Boolean).join(' · ') || s.cwd}
            </span>
          </li>
        ))}

        <li className="sl-section">과거 세션 (이어서 열기)</li>
        {!filterCwd && <li className="muted pad small">사건을 먼저 여세요.</li>}
        {filterCwd && past === null && <li className="muted pad small">불러오는 중…</li>}
        {filterCwd && past && past.length === 0 && (
          <li className="muted pad small">과거 세션이 없습니다.</li>
        )}
        {filterCwd &&
          past?.map((p) => (
            <li
              key={p.sessionId}
              className="sl-row past"
              onClick={() => onResume(p.sessionId, filterCwd, p.title, filterSource)}
              title={`${p.sessionId}\n${p.cwd ?? filterCwd}\nclaude --resume 로 이어서 열기`}
            >
              <span className="sl-name">↻ {p.title || '(제목 없음)'}</span>
              <span className="sl-sub">
                {[p.transcriptTitle && p.transcriptTitle !== p.title ? p.transcriptTitle : undefined, p.folderName, fmt(p.mtime)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
      </ul>
    </div>
  )
}

const RECENT_CASES_PAGE_SIZE = 10

function Welcome({
  recent,
  onOpen
}: {
  recent: { drafts: string; records?: string; name: string; ts: number }[]
  onOpen: (e: { drafts: string; records?: string; name: string }) => void | Promise<void>
}): JSX.Element {
  const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_CASES_PAGE_SIZE)
  const visibleRecent = recent.slice(0, recentVisibleCount)
  const hasMoreRecent = recentVisibleCount < recent.length

  useEffect(() => {
    setRecentVisibleCount(RECENT_CASES_PAGE_SIZE)
  }, [recent.length])

  return (
    <div className="welcome">
      <h1>legal-terminal</h1>
      <p className="subtitle">Claude Code · Markdown 준비서면 · 전자소송기록 뷰어 — 한 화면에서</p>

      {recent.length > 0 && (
        <div className="recent">
          <h2 className="recent-title">최근 사건</h2>
          <ul className="recent-list">
            {visibleRecent.map((r) => (
              <li key={r.drafts} className="recent-item" onClick={() => void onOpen(r)} title={r.drafts}>
                <span className="recent-name">⚖️ {r.name}</span>
                {isRemotePath(r.drafts) && <span className="recent-tag">원격</span>}
                {r.records && <span className="recent-tag">기록 연결됨</span>}
              </li>
            ))}
          </ul>
          {hasMoreRecent && (
            <button
              className="recent-more"
              type="button"
              onClick={() => setRecentVisibleCount((count) => count + RECENT_CASES_PAGE_SIZE)}
            >
              더 보기
            </button>
          )}
        </div>
      )}

      <ul className="welcome-list">
        <li>📁 <b>탐색기 모드</b> — 작성서류 폴더의 파일트리에서 문서를 본문에 엽니다</li>
        <li>📄 <b>기록뷰어 모드</b> — 문서 | 본문 | 서증·첨부서류 | 터미널</li>
        <li>✳️ <b>Claude</b> — 오른쪽 터미널에서 <code>/brief-protocol</code> 실행 (모드 전환에도 유지)</li>
      </ul>
    </div>
  )
}

function DocPlaceholder({ title }: { title: string }): JSX.Element {
  return (
    <div className="welcome">
      <h2>{title}</h2>
      <p className="muted">M2에서 Monaco Markdown 에디터 + 라이브 프리뷰가 여기에 들어갑니다.</p>
    </div>
  )
}

interface TextFindRange {
  start: number
  end: number
}

function findTextRanges(text: string, query: string): TextFindRange[] {
  const needle = query.trim()
  if (!needle) return []
  const haystack = text.toLocaleLowerCase('ko-KR')
  const target = needle.toLocaleLowerCase('ko-KR')
  const out: TextFindRange[] = []
  let index = haystack.indexOf(target)
  while (index >= 0 && out.length < 2000) {
    out.push({ start: index, end: index + needle.length })
    index = haystack.indexOf(target, index + Math.max(needle.length, 1))
  }
  return out
}

/** 텍스트 문서 표시 — 자동 줄바꿈 기본 ON(토글) */
function TextDoc({ text, note }: { text: string; note?: string }): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const [docFont, setDocFont] = useState({ family: DEFAULT_MD_FONT, size: DEFAULT_MD_FONT_SIZE })
  const rootRef = useRef<HTMLDivElement>(null)
  const ranges = findTextRanges(text, findQuery)
  const activeFindIndex = ranges.length ? Math.max(0, Math.min(findIndex, ranges.length - 1)) : -1

  useEffect(() => {
    let alive = true
    const applySettings = (s: AppSettings): void => {
      if (!alive) return
      setDocFont({ family: s.mdFont || DEFAULT_MD_FONT, size: s.mdFontSize || DEFAULT_MD_FONT_SIZE })
    }
    window.lt.settings.get().then(applySettings).catch(() => {})
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [])

  useEffect(() => {
    if (findIndex !== activeFindIndex) setFindIndex(activeFindIndex)
  }, [activeFindIndex, findIndex])

  useEffect(() => {
    if (!findOpen || activeFindIndex < 0) return
    rootRef.current
      ?.querySelector('.text-find-active')
      ?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [activeFindIndex, findOpen, findQuery])

  const nextFind = (): void =>
    setFindIndex((i) => (ranges.length ? (i + 1 + ranges.length) % ranges.length : -1))
  const prevFind = (): void =>
    setFindIndex((i) => (ranges.length ? (i - 1 + ranges.length) % ranges.length : -1))

  const renderText = (): ReactNode => {
    if (!ranges.length) return text
    const parts: ReactNode[] = []
    let pos = 0
    ranges.forEach((range, i) => {
      if (range.start > pos) parts.push(text.slice(pos, range.start))
      parts.push(
        <mark key={`${range.start}-${i}`} className={i === activeFindIndex ? 'text-find-active' : 'text-find-match'}>
          {text.slice(range.start, range.end)}
        </mark>
      )
      pos = range.end
    })
    if (pos < text.length) parts.push(text.slice(pos))
    return parts
  }

  return (
    <div
      ref={rootRef}
      className="text-doc"
      tabIndex={0}
      onKeyDown={(e) => {
        const primary = e.metaKey || e.ctrlKey
        if (!primary || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
      }}
    >
      <div className="text-toolbar">
        <button
          className={`tb-btn ${wrap ? 'on' : ''}`}
          title="자동 줄바꿈"
          onClick={() => setWrap((w) => !w)}
        >
          줄바꿈
        </button>
        <span className="tb-divider" />
        <button
          className={`tb-btn ${findOpen ? 'on' : ''}`}
          title="문서에서 찾기"
          onClick={() => setFindOpen((v) => !v)}
        >
          <IconSearch size={14} />
          <span className="sr-only">문서에서 찾기</span>
        </button>
      </div>
      {findOpen && (
        <FindBar
          value={findQuery}
          placeholder="문서에서 찾기"
          resultLabel={findQuery.trim() ? `${activeFindIndex + 1}/${ranges.length}` : ''}
          onChange={(v) => {
            setFindQuery(v)
            setFindIndex(0)
          }}
          onPrev={prevFind}
          onNext={nextFind}
          onClose={() => setFindOpen(false)}
        />
      )}
      <pre
        className={`file-view ${wrap ? 'wrap' : ''}`}
        style={{ fontFamily: docFont.family, fontSize: `${docFont.size}px` }}
      >
        {renderText()}
        {note ? '\n\n' + note : ''}
      </pre>
    </div>
  )
}

/** 텍스트 파일 미리보기 (md/txt/csv/json…). MD 옵시디언식 라이브 프리뷰는 추후 CodeMirror로. */
function FileView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{
    loading: boolean
    text: string
    binary: boolean
    truncated: boolean
    err: string
  }>({ loading: true, text: '', binary: false, truncated: false, err: '' })

  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', binary: false, truncated: false, err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          text: r.text,
          binary: r.kind === 'binary',
          truncated: !!r.truncated,
          err: ''
        })
      })
      .catch((e) => alive && setState((s) => ({ ...s, loading: false, err: String(e) })))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>
  if (state.binary)
    return (
      <div className="welcome">
        <p className="muted">텍스트로 미리볼 수 없는 형식입니다.</p>
      </div>
    )
  return <TextDoc text={state.text} note={state.truncated ? '… (이하 생략, 2MB 초과)' : undefined} />
}

/** HWP/HWPX — 텍스트만 추출해 표시 */
function HwpView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; text: string; err: string }>({
    loading: true,
    text: '',
    err: ''
  })
  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', err: '' })
    window.lt.fs
      .readHwpText(path)
      .then((r) => {
        if (!alive) return
        setState({ loading: false, text: r.text, err: r.ok ? '' : r.error || '추출 실패' })
      })
      .catch((e) => alive && setState({ loading: false, text: '', err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])
  if (state.loading) return <div className="welcome"><p className="muted">HWP/HWPX 텍스트 추출 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">{state.err}</p></div>
  return <TextDoc text={state.text} />
}

// CSV 파싱 (따옴표·구분자 처리)
function parseCsv(text: string, delim: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.length))
}

function detectDelim(firstLine: string): string {
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ','
}

/** CSV — 표(기본) / 색상 텍스트(열별 색상) */
function CsvView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; rows: string[][]; err: string }>({
    loading: true,
    rows: [],
    err: ''
  })
  const [mode, setMode] = useState<'table' | 'color'>('table')

  useEffect(() => {
    let alive = true
    setState({ loading: true, rows: [], err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        const text = r.text.replace(/^﻿/, '')
        const delim = detectDelim(text.split('\n')[0] ?? '')
        setState({ loading: false, rows: parseCsv(text, delim), err: '' })
      })
      .catch((e) => alive && setState({ loading: false, rows: [], err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>

  const [header, ...body] = state.rows
  return (
    <div className="text-doc">
      <div className="text-toolbar">
        <button className={`tb-btn ${mode === 'table' ? 'on' : ''}`} onClick={() => setMode('table')}>
          표
        </button>
        <button className={`tb-btn ${mode === 'color' ? 'on' : ''}`} onClick={() => setMode('color')}>
          색상
        </button>
        <span className="tb-sep-text">{state.rows.length}행</span>
      </div>
      <div className="csv-wrap">
        {mode === 'table' ? (
          <table className="csv-table">
            {header && (
              <thead>
                <tr>
                  {header.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={`csv-c${ci % 8}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="csv-color">
            {state.rows.map((r, ri) => (
              <div key={ri}>
                {r.map((c, ci) => (
                  <span key={ci}>
                    <span className={`csv-c${ci % 8}`}>{c}</span>
                    {ci < r.length - 1 && <span className="csv-delim">,</span>}
                  </span>
                ))}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 이미지 뷰어 — 폭맞춤(기본)/원본, Ctrl+휠 줌 */
function ImageViewer({
  path,
  onNavigate
}: {
  path: string
  onNavigate?: (dir: 1 | -1) => void
}): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'fit_page' | 'fit_width' | 'custom'>('fit_page')
  const [scale, setScale] = useState(1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navLock = useRef(false)

  useEffect(() => {
    let alive = true
    let made = ''
    setErr('')
    window.lt.fs
      .readBytes(path)
      .then((ab) => {
        if (!alive) return
        made = URL.createObjectURL(new Blob([ab]))
        setUrl(made)
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [path, remoteVersion])

  const zoomBy = (f: number): void => {
    setMode('custom')
    setScale((s) => Math.max(0.1, Math.min(8, +(s * f).toFixed(3))))
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
      return
    }
    // 스크롤이 끝(위/아래)에 닿으면 정렬순 이전/다음 이미지로 이동
    const el = wrapRef.current
    if (!el || !onNavigate) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const atTop = el.scrollTop <= 2
    if (e.deltaY > 0 && atBottom && !navLock.current) {
      navLock.current = true
      onNavigate(1)
      setTimeout(() => (navLock.current = false), 400)
    } else if (e.deltaY < 0 && atTop && !navLock.current) {
      navLock.current = true
      onNavigate(-1)
      setTimeout(() => (navLock.current = false), 400)
    }
  }

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || mode !== 'custom') return
    let dragging = false
    let sx = 0
    let sy = 0
    let sl = 0
    let st = 0
    const down = (e: MouseEvent): void => {
      if (e.button !== 0) return
      dragging = true
      sx = e.clientX
      sy = e.clientY
      sl = wrap.scrollLeft
      st = wrap.scrollTop
      wrap.classList.add('grabbing')
      e.preventDefault()
    }
    const move = (e: MouseEvent): void => {
      if (!dragging) return
      wrap.scrollLeft = sl - (e.clientX - sx)
      wrap.scrollTop = st - (e.clientY - sy)
    }
    const up = (): void => {
      dragging = false
      wrap.classList.remove('grabbing')
    }
    wrap.addEventListener('mousedown', down)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      wrap.removeEventListener('mousedown', down)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      wrap.classList.remove('grabbing')
    }
  }, [mode])

  const imgStyle: React.CSSProperties =
    mode === 'fit_page'
      ? { maxWidth: '100%', maxHeight: '100%' }
      : mode === 'fit_width'
        ? { width: '100%', height: 'auto' }
        : { width: `${scale * 100}%`, height: 'auto' }

  if (err) return <div className="welcome"><p className="muted">이미지 열기 실패: {err}</p></div>
  return (
    <div className="image-doc">
      <div className="pdf-toolbar">
        <button
          className={`tb-btn ${mode === 'fit_page' ? 'on' : ''}`}
          title="쪽 맞춤"
          onClick={() => setMode('fit_page')}
        >
          쪽맞춤
        </button>
        <button
          className={`tb-btn ${mode === 'fit_width' ? 'on' : ''}`}
          title="폭 맞춤"
          onClick={() => setMode('fit_width')}
        >
          폭맞춤
        </button>
        <button className="tb-btn" title="축소" onClick={() => zoomBy(1 / 1.1)}>
          －
        </button>
        <button className="tb-btn pct" onClick={() => setMode('fit_page')}>
          {mode === 'custom' ? `${Math.round(scale * 100)}%` : '맞춤'}
        </button>
        <button className="tb-btn" title="확대" onClick={() => zoomBy(1.1)}>
          ＋
        </button>
      </div>
      <div
        className={`image-wrap ${mode === 'fit_page' ? 'center' : ''} ${mode === 'custom' ? 'pannable' : ''}`}
        ref={wrapRef}
        onWheel={onWheel}
      >
        {url && <img src={url} style={imgStyle} draggable={false} alt="" />}
      </div>
    </div>
  )
}

function SettingsView(): JSX.Element {
  const [s, setS] = useState<AppSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [termFontSizeInput, setTermFontSizeInput] = useState(String(DEFAULT_TERM_FONT_SIZE))
  const [mdFontSizeInput, setMdFontSizeInput] = useState(String(DEFAULT_MD_FONT_SIZE))
  const [agentFontSizeInput, setAgentFontSizeInput] = useState(String(DEFAULT_AGENT_FONT_SIZE))
  const [notificationVolumeInput, setNotificationVolumeInput] = useState(DEFAULT_NOTIFICATION_VOLUME)

  useEffect(() => {
    const applySettings = (v: AppSettings): void => {
      setS({
        ...v,
        caseOpenTarget: resolveCaseOpenTarget(v.caseOpenTarget, v.sshProfiles ?? [])
      })
      setLoaded(true)
    }
    window.lt.settings.get().then(applySettings)
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  useEffect(() => {
    setTermFontSizeInput(String(s.termFontSize ?? DEFAULT_TERM_FONT_SIZE))
  }, [s.termFontSize])

  useEffect(() => {
    setMdFontSizeInput(String(s.mdFontSize ?? DEFAULT_MD_FONT_SIZE))
  }, [s.mdFontSize])

  useEffect(() => {
    setAgentFontSizeInput(String(s.agentFontSize ?? DEFAULT_AGENT_FONT_SIZE))
  }, [s.agentFontSize])

  useEffect(() => {
    setNotificationVolumeInput(clampNotificationVolume(s.notificationVolume))
  }, [s.notificationVolume])

  const savePatch = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await window.lt.settings.set(patch)
    setS(next)
    emitSettingsUpdated(next)
  }

  const commitTermFontSize = async (): Promise<void> => {
    const next = clampFontSize(termFontSizeInput, s.termFontSize ?? DEFAULT_TERM_FONT_SIZE)
    setTermFontSizeInput(String(next))
    if (next !== (s.termFontSize ?? DEFAULT_TERM_FONT_SIZE)) await savePatch({ termFontSize: next })
  }

  const commitMdFontSize = async (): Promise<void> => {
    const next = clampFontSize(mdFontSizeInput, s.mdFontSize ?? DEFAULT_MD_FONT_SIZE)
    setMdFontSizeInput(String(next))
    if (next !== (s.mdFontSize ?? DEFAULT_MD_FONT_SIZE)) await savePatch({ mdFontSize: next })
  }

  const commitAgentFontSize = async (): Promise<void> => {
    const next = clampFontSize(agentFontSizeInput, s.agentFontSize ?? DEFAULT_AGENT_FONT_SIZE)
    setAgentFontSizeInput(String(next))
    if (next !== (s.agentFontSize ?? DEFAULT_AGENT_FONT_SIZE)) await savePatch({ agentFontSize: next })
  }

  const commitNotificationVolume = async (): Promise<void> => {
    const next = clampNotificationVolume(notificationVolumeInput)
    setNotificationVolumeInput(next)
    if (next !== clampNotificationVolume(s.notificationVolume)) {
      await savePatch({ notificationVolume: next })
    }
  }

  const pick = async (key: 'draftsRoot' | 'recordsRoot'): Promise<void> => {
    const title =
      key === 'draftsRoot'
        ? '작성서류 루트 폴더 선택 (모든 사건)'
        : '소송기록 루트 폴더 선택 (사건별 전자소송기록)'
    const r = await window.lt.dialog.pickFolder({ title, defaultPath: s[key] })
    if (!r) return
    await savePatch({ [key]: r.path })
  }

  const profiles = s.sshProfiles ?? []
  const caseOpenValue = resolveCaseOpenTarget(s.caseOpenTarget, profiles)
  const notificationSound = resolveNotificationSound(s.notificationSound)
  const notificationVolume = clampNotificationVolume(notificationVolumeInput)
  const mdFontValue = s.mdFont === DEFAULT_MD_FONT ? '' : s.mdFont ?? ''
  const mdFontOptions =
    mdFontValue && !MD_FONT_OPTIONS.some((option) => option.value === mdFontValue)
      ? [...MD_FONT_OPTIONS, { label: `현재 설정 (${mdFontValue})`, value: mdFontValue }]
      : MD_FONT_OPTIONS

  return (
    <div className="settings">
      <h1>설정</h1>
      <p className="muted">사건을 열 때 두 폴더를 자동으로 짝지으려면 아래 두 루트를 지정하세요.</p>

      <section className="setting-row">
        <div className="setting-label">
          작성서류 루트 <span className="muted small">— 모든 사건의 작성서류 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.draftsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('draftsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          소송기록 루트 <span className="muted small">— 사건별 전자소송기록 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.recordsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('recordsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          사건 기본 열기 <span className="muted small">— 사건 대시보드에서 클릭할 때 사용할 위치</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={caseOpenValue}
            onChange={(e) => savePatch({ caseOpenTarget: e.target.value })}
          >
            <option value={CASE_OPEN_LOCAL}>로컬</option>
            {profiles.map((p) => (
              <option key={p.id} value={remoteCaseOpenTarget(p.id)}>
                원격: {p.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          PDF 기본 배율 <span className="muted small">— 전자소송기록을 열 때 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={s.pdfZoom ?? 'fit_page'}
            onChange={async (e) => {
              await savePatch({ pdfZoom: e.target.value })
            }}
          >
            <option value="fit_page">쪽 맞춤</option>
            <option value="fit_width">폭 맞춤</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
            <option value="200">200%</option>
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          터미널 폰트 <span className="muted small">— 새 터미널부터 적용</span>
        </div>
        <div className="setting-value">
          <input
            className="setting-input"
            placeholder="예: Cascadia Mono, D2Coding, Consolas"
            defaultValue={s.termFont ?? ''}
            onBlur={async (e) => {
              await savePatch({ termFont: e.target.value.trim() })
            }}
          />
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">터미널 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={termFontSizeInput}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTermFontSizeInput(e.target.value)}
            onBlur={() => {
              void commitTermFontSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setTermFontSizeInput(String(s.termFontSize ?? DEFAULT_TERM_FONT_SIZE))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          작업 완료 알림음 <span className="muted small">— 완료·질문 대기 전환 시 재생</span>
        </div>
        <div className="setting-value notification-sound-row">
          <select
            className="setting-select"
            value={notificationSound}
            onChange={(e) => {
              const nextSound = resolveNotificationSound(e.target.value)
              setS((current) => ({ ...current, notificationSound: nextSound }))
              void savePatch({ notificationSound: nextSound })
              playNotificationSound(nextSound, notificationVolume)
            }}
          >
            {NOTIFICATION_SOUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="header-btn setting-preview-btn"
            type="button"
            onClick={() => playNotificationSound(notificationSound, notificationVolume)}
          >
            미리듣기
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">알림음 볼륨</div>
        <div className="setting-value notification-volume-row">
          <input
            className="setting-range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={notificationVolume}
            aria-label="알림음 볼륨"
            onChange={(e) => {
              const nextVolume = clampNotificationVolume(e.target.value)
              setNotificationVolumeInput(nextVolume)
            }}
            onPointerUp={() => {
              void commitNotificationVolume()
            }}
            onKeyUp={() => {
              void commitNotificationVolume()
            }}
            onBlur={() => {
              void commitNotificationVolume()
            }}
          />
          <span className="setting-range-value">{notificationVolume}%</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          마크다운 폰트 <span className="muted small">— 편집기·텍스트·HWP 미리보기에 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select font-select"
            value={mdFontValue}
            onChange={(e) => {
              void savePatch({ mdFont: e.target.value || undefined })
            }}
          >
            {mdFontOptions.map((option) => (
              <option key={option.value || 'default'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="header-btn setting-reset-btn"
            type="button"
            onClick={() => {
              void savePatch({ mdFont: undefined })
            }}
          >
            기본값 복원
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">마크다운 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={mdFontSizeInput}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setMdFontSizeInput(e.target.value)}
            onBlur={() => {
              void commitMdFontSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setMdFontSizeInput(String(s.mdFontSize ?? DEFAULT_MD_FONT_SIZE))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          Agent 답변 글자 크기 <span className="muted small">— Agent Panel 출력에 즉시 적용</span>
        </div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={agentFontSizeInput}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setAgentFontSizeInput(e.target.value)}
            onBlur={() => {
              void commitAgentFontSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setAgentFontSizeInput(String(s.agentFontSize ?? DEFAULT_AGENT_FONT_SIZE))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row col">
        <div className="setting-label">
          SSH 접속 프로필{' '}
          <span className="muted small">— 원격 서버에서 사건·claude 실행 (사건 열기 → 접속 선택)</span>
        </div>
        <SshProfilesEditor />
      </section>

      <p className="muted small">
        {loaded ? '변경 즉시 저장됩니다 (터미널·마크다운 편집기는 새로 열 때 적용).' : '불러오는 중…'}
      </p>
    </div>
  )
}

// 설정 화면의 SSH 프로필 목록 편집기 (추가/수정/삭제 즉시 저장)
function SshProfilesEditor(): JSX.Element {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  // 루트 '찾아보기' — 해당 ssh에 접속해 원격 폴더를 탐색·선택
  const [picking, setPicking] = useState<{
    profile: SshProfile
    field: 'draftsRoot' | 'recordsRoot'
  } | null>(null)

  useEffect(() => {
    window.lt.settings.get().then((s) => setProfiles(s.sshProfiles ?? []))
  }, [])

  const save = (next: SshProfile[]): void => {
    setProfiles(next)
    void window.lt.settings.set({ sshProfiles: next }).then(emitSettingsUpdated)
  }
  const update = (id: string, patch: Partial<SshProfile>): void =>
    save(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const add = (): void => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ssh-${Date.now()}`
    save([...profiles, { id, label: '새 서버', host: '', user: '' }])
  }
  const remove = (id: string): void => save(profiles.filter((p) => p.id !== id))

  return (
    <div className="ssh-editor">
      {profiles.length === 0 && (
        <p className="muted small">저장된 프로필이 없습니다. 아래에서 추가하세요.</p>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="ssh-card">
          <div className="ssh-card-head">
            <input
              className="setting-input"
              placeholder="이름 (예: 사무실 서버)"
              defaultValue={p.label}
              onBlur={(e) => update(p.id, { label: e.target.value.trim() || '서버' })}
            />
            <button className="header-btn danger" onClick={() => remove(p.id)} title="삭제">
              삭제
            </button>
          </div>
          <div className="ssh-grid">
            <label>
              호스트
              <input
                className="setting-input"
                placeholder="example.com 또는 192.168.0.10"
                defaultValue={p.host}
                onBlur={(e) => update(p.id, { host: e.target.value.trim() })}
              />
            </label>
            <label>
              사용자
              <input
                className="setting-input"
                placeholder="ubuntu"
                defaultValue={p.user}
                onBlur={(e) => update(p.id, { user: e.target.value.trim() })}
              />
            </label>
            <label>
              포트
              <input
                className="setting-input narrow"
                type="number"
                placeholder="22"
                defaultValue={p.port ?? ''}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10)
                  update(p.id, { port: Number.isNaN(n) ? undefined : n })
                }}
              />
            </label>
            <label className="wide">
              개인키 파일 <span className="muted small">(비우면 ssh-agent·기본 키)</span>
              <input
                className="setting-input"
                placeholder="/Users/me/.ssh/id_ed25519"
                defaultValue={p.identityFile ?? ''}
                onBlur={(e) => update(p.id, { identityFile: e.target.value.trim() || undefined })}
              />
            </label>
            <label className="wide">
              원격 작성서류 루트 <span className="muted small">(사건 폴더 고를 때 시작 위치)</span>
              <div className="root-row">
                <input
                  key={'d:' + (p.draftsRoot ?? '')}
                  className="setting-input"
                  placeholder="/Users/me/OneDrive/진행중사건"
                  defaultValue={p.draftsRoot ?? ''}
                  onBlur={(e) => update(p.id, { draftsRoot: e.target.value.trim() || undefined })}
                />
                <button
                  className="header-btn"
                  type="button"
                  disabled={!p.host || !p.user}
                  title={!p.host || !p.user ? '호스트·사용자를 먼저 입력하세요' : '원격에서 폴더 찾기'}
                  onClick={() => setPicking({ profile: p, field: 'draftsRoot' })}
                >
                  찾아보기
                </button>
              </div>
            </label>
            <label className="wide">
              원격 소송기록 루트 <span className="muted small">(기록뷰어에서 소송기록 폴더 고를 때 시작 위치)</span>
              <div className="root-row">
                <input
                  key={'r:' + (p.recordsRoot ?? '')}
                  className="setting-input"
                  placeholder="/Users/me/OneDrive/소송기록"
                  defaultValue={p.recordsRoot ?? ''}
                  onBlur={(e) => update(p.id, { recordsRoot: e.target.value.trim() || undefined })}
                />
                <button
                  className="header-btn"
                  type="button"
                  disabled={!p.host || !p.user}
                  title={!p.host || !p.user ? '호스트·사용자를 먼저 입력하세요' : '원격에서 폴더 찾기'}
                  onClick={() => setPicking({ profile: p, field: 'recordsRoot' })}
                >
                  찾아보기
                </button>
              </div>
            </label>
            <label className="wide">
              SSH 빠른 시작 폴더 <span className="muted small">(줄마다 원격 경로)</span>
              <textarea
                key={'q:' + remoteQuickStartInputValue(p.quickStartPaths)}
                className="setting-input ssh-quickstart-input"
                rows={3}
                placeholder={'/Users/me/Library/CloudStorage/OneDrive\n/home/me/cases'}
                defaultValue={remoteQuickStartInputValue(p.quickStartPaths)}
                onBlur={(e) => {
                  const quickStartPaths = remoteQuickStartInputToPaths(e.target.value)
                  update(p.id, {
                    quickStartPaths: quickStartPaths.length > 0 ? quickStartPaths : undefined
                  })
                }}
              />
            </label>
          </div>
        </div>
      ))}
      <button className="empty-action" onClick={add}>
        ＋ 프로필 추가
      </button>

      {picking && (
        <RemoteFolderPicker
          profile={picking.profile}
          title={picking.field === 'draftsRoot' ? '작성서류 루트 선택' : '소송기록 루트 선택'}
          confirmLabel="이 폴더로 지정"
          startPath={
            picking.field === 'draftsRoot'
              ? picking.profile.draftsRoot
              : picking.profile.recordsRoot
          }
          onCancel={() => setPicking(null)}
          onPick={(remotePath) => {
            update(picking.profile.id, { [picking.field]: remotePath } as Partial<SshProfile>)
            setPicking(null)
          }}
        />
      )}
    </div>
  )
}

function WorkspacePicker({
  loading,
  entries,
  error,
  onLoad,
  onRefresh,
  onClose
}: {
  loading: boolean
  entries: WorkspaceEntry[]
  error?: string
  onLoad: (entry: WorkspaceEntry) => void
  onRefresh: () => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const filteredEntries = entries.filter((entry) =>
    matchesSearch(
      [
        entry.label,
        entry.caseNumber,
        entry.caseName,
        entry.court,
        entry.client,
        entry.folderName,
        entry.cwd,
        entry.recordsFolder,
        entry.sshLabel,
        entry.searchText
      ],
      query
    )
  )
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal workspace-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">저장된 작업환경 가져오기</div>
        <input
          className="workspace-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="사건번호·사건명·작성서류 폴더명 검색"
        />
        <div className="workspace-list">
          {loading && <p className="muted pad small">불러오는 중…</p>}
          {!loading && error && <p className="muted pad small">불러오기 실패: {error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="muted pad small">저장된 작업환경이 없습니다.</p>
          )}
          {!loading && !error && entries.length > 0 && filteredEntries.length === 0 && (
            <p className="muted pad small">검색 결과가 없습니다.</p>
          )}
          {!loading &&
            !error &&
            filteredEntries.map((entry, index) => (
              <button
                key={entry.id}
                className="workspace-row"
                type="button"
                title={describeWorkspaceEntry(entry, index)}
                onClick={() => onLoad(entry)}
              >
                <span className="workspace-row-main">
                  <span className="workspace-row-title">{entry.label}</span>
                  <span className="muted small">
                    {[entry.caseNumber, entry.folderName, formatWorkspaceSavedAt(entry.savedAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="workspace-row-meta">
                  문서 {entry.docs} · 터미널 {entry.terminals}
                </span>
              </button>
            ))}
        </div>
        <div className="modal-actions">
          <button className="header-btn" type="button" onClick={onRefresh}>
            새로고침
          </button>
          <button className="header-btn" type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

// 사건 열기 시 접속 선택 (로컬 / 저장된 SSH 프로필)
function ConnMenu({
  profiles,
  onLocal,
  onRemote,
  onManage,
  onClose
}: {
  profiles: SshProfile[]
  onLocal: () => void
  onRemote: (p: SshProfile) => void
  onManage: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal conn-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">사건 열기 — 접속 선택</div>
        <button className="conn-row" onClick={onLocal}>
          <span className="conn-ic">💻</span>
          <span className="conn-main">
            <b>이 컴퓨터 (로컬)</b>
            <span className="muted small">로컬 폴더에서 사건 선택</span>
          </span>
        </button>
        {profiles.map((p) => (
          <button key={p.id} className="conn-row" onClick={() => onRemote(p)}>
            <span className="conn-ic">🔗</span>
            <span className="conn-main">
              <b>{p.label}</b>
              <span className="muted small">
                {p.user}@{p.host}
                {p.port ? `:${p.port}` : ''}
              </span>
            </span>
          </button>
        ))}
        <div className="modal-actions">
          <button className="header-btn" onClick={onManage}>
            ＋ 프로필 관리…
          </button>
          <button className="header-btn" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

function parentRemotePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '~') return '~'
  if (trimmed.startsWith('~/')) {
    const parent = trimmed.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    return parent === '~' || !parent ? '~' : parent
  }
  return trimmed.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
}

function remoteCrumbs(path: string): { label: string; path: string }[] {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '~') return [{ label: '~', path: '~' }]
  if (trimmed.startsWith('~/')) {
    const parts = trimmed.slice(2).split('/').filter(Boolean)
    let acc = '~'
    return [
      { label: '~', path: '~' },
      ...parts.map((part) => {
        acc += '/' + part
        return { label: part, path: acc }
      })
    ]
  }
  if (!trimmed.startsWith('/')) return [{ label: trimmed, path: trimmed }]
  const parts = trimmed.split('/').filter(Boolean)
  let acc = ''
  return [
    { label: '루트', path: '/' },
    ...parts.map((part) => {
      acc += '/' + part
      return { label: part, path: acc }
    })
  ]
}

function remotePathParts(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
}

function oneDrivePartIndex(path: string): number {
  return remotePathParts(path).findIndex((part) => part.toLowerCase().startsWith('onedrive'))
}

function looksLikeOneDrivePath(path: string): boolean {
  return oneDrivePartIndex(path) >= 0
}

function cloudPathFromOneDrivePath(path: string): string {
  const parts = remotePathParts(path)
  const i = parts.findIndex((part) => part.toLowerCase().startsWith('onedrive'))
  return i >= 0 ? parts.slice(i + 1).join('/').normalize('NFC') : ''
}

interface RemoteStartPoint {
  label: string
  path: string
}

const REMOTE_FALLBACK_START_POINTS: RemoteStartPoint[] = [
  { label: '홈', path: '~' },
  { label: '루트 /', path: '/' },
  { label: '/Users', path: '/Users' },
  { label: '/home', path: '/home' },
  { label: '/Volumes', path: '/Volumes' },
  { label: 'CloudStorage', path: '~/Library/CloudStorage' },
  { label: 'OneDrive', path: '~/Library/CloudStorage/OneDrive' },
  { label: 'Documents', path: '~/Documents' }
]
const REMOTE_FOLDER_SEARCH_DEPTH = 5
const REMOTE_FOLDER_SEARCH_LIMIT = 150

function addRemoteStartPoint(
  points: RemoteStartPoint[],
  seen: Set<string>,
  label: string,
  path?: string
): void {
  const trimmed = path?.trim()
  if (!trimmed) return
  const key = trimmed.replace(/\/+$/, '') || '/'
  if (seen.has(key)) return
  seen.add(key)
  points.push({ label, path: trimmed })
}

function profileRemoteStartPoints(profile: SshProfile): RemoteStartPoint[] {
  const points: RemoteStartPoint[] = []
  const seen = new Set<string>()
  for (const path of normalizeRemoteQuickStartPaths(profile.quickStartPaths)) {
    addRemoteStartPoint(points, seen, pathLeaf(path) ?? path, path)
  }
  addRemoteStartPoint(points, seen, '작성서류 루트', profile.draftsRoot)
  addRemoteStartPoint(points, seen, '소송기록 루트', profile.recordsRoot)
  return points.length > 0 ? points : REMOTE_FALLBACK_START_POINTS
}

function joinRemotePickerPath(dir: string, name: string): string {
  const cleanDir = dir.trim().replace(/\/+$/, '')
  if (!cleanDir || cleanDir === '~') return `~/${name}`
  if (cleanDir === '/') return `/${name}`
  return `${cleanDir}/${name}`
}

// 원격(SSH) 사건 폴더 탐색·선택. ssh.listDir(키/agent 인증)로 목록을 받고,
// 실패 시(비밀번호 인증 등) 원격 경로를 직접 입력하는 폴백을 제공한다.
function RemoteFolderPicker({
  profile,
  title = '사건(작성서류) 폴더 선택',
  startPath,
  confirmLabel = '이 폴더로 사건 열기',
  onPick,
  onCancel
}: {
  profile: SshProfile
  title?: string
  startPath?: string
  confirmLabel?: string
  onPick: (remotePath: string) => void
  onCancel: () => void
}): JSX.Element {
  const initial = (startPath ?? profile.draftsRoot)?.trim() || '~'
  const [cwd, setCwd] = useState<string>(initial)
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null)
  const [err, setErr] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [pathInput, setPathInput] = useState(initial)
  const [syncOpen, setSyncOpen] = useState<{
    macFolder: string
    reloadPath: string
    folderLabel: string
  } | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SORT_MODE)
  const [folderQuery, setFolderQuery] = useState('')
  const [folderSearching, setFolderSearching] = useState(false)
  const [folderSearchResults, setFolderSearchResults] = useState<RemoteEntry[] | null>(null)
  const [folderSearchErr, setFolderSearchErr] = useState('')
  const [folderSearchTruncated, setFolderSearchTruncated] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createFolderErr, setCreateFolderErr] = useState('')
  const folderSearchSeq = useRef(0)
  const loadSeq = useRef(0)

  const load = (path: string): void => {
    const nextPath = path.trim() || '~'
    const seq = ++loadSeq.current
    folderSearchSeq.current++
    setPathInput(nextPath)
    setLoading(true)
    setErr('')
    setFolderSearching(false)
    setFolderSearchResults(null)
    setFolderSearchErr('')
    setFolderSearchTruncated(false)
    window.lt.ssh
      .listDir(profile, nextPath)
      .then((r) => {
        if (loadSeq.current !== seq) return
        setLoading(false)
        if (r.ok) {
          setCwd(r.cwd)
          setPathInput(r.cwd)
          setEntries(r.entries)
        } else {
          setErr(r.error)
          setEntries(null)
        }
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return
        setLoading(false)
        setErr(e instanceof Error ? e.message : String(e))
        setEntries(null)
      })
  }

  useEffect(() => {
    load(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    const applySettings = (settings: AppSettings): void => {
      if (alive) setSortMode(resolveSortMode(settings.remotePickerSortMode))
    }
    window.lt.settings.get().then(applySettings).catch(() => {})
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [])

  const updateSortMode = (nextMode: SortMode): void => {
    setSortMode(nextMode)
    void window.lt.settings.set({ remotePickerSortMode: nextMode }).then(emitSettingsUpdated).catch(() => {})
  }

  const up = (): void => {
    load(parentRemotePath(cwd))
  }
  const dirs = sortEntries(entries?.filter((e) => e.isDir) ?? [], sortMode)
  const crumbs = remoteCrumbs(cwd)
  const canUsePathInput = pathInput.trim().length > 0
  const syncPath = (pathInput.trim() || cwd).trim()
  const canSyncOneDrive = looksLikeOneDrivePath(syncPath)
  const syncFolderLabel = title.includes('소송기록') ? '소송기록 폴더' : '사건폴더'
  const quickStartPoints = profileRemoteStartPoints(profile)
  const visibleDirs = folderSearchResults ? sortEntries(folderSearchResults, sortMode) : dirs
  const folderQueryText = folderQuery.trim()
  const canCreateFolder = !loading && !err && !!cwd.trim() && !!newFolderName.trim() && !creatingFolder
  const canPickCurrentFolder = !loading && !folderSearching && !err && !!cwd.trim()
  const closeSync = (): void => {
    const reloadPath = syncOpen?.reloadPath
    setSyncOpen(null)
    if (reloadPath) load(reloadPath)
  }
  const clearFolderSearch = (): void => {
    folderSearchSeq.current++
    setFolderQuery('')
    setFolderSearching(false)
    setFolderSearchResults(null)
    setFolderSearchErr('')
    setFolderSearchTruncated(false)
  }
  const searchFolders = (): void => {
    if (!folderQueryText) {
      clearFolderSearch()
      return
    }
    const seq = ++folderSearchSeq.current
    setFolderSearching(true)
    setFolderSearchResults(null)
    setFolderSearchErr('')
    setFolderSearchTruncated(false)

    void window.lt.ssh
      .searchDirs(profile, cwd, {
        query: folderQueryText,
        maxDepth: REMOTE_FOLDER_SEARCH_DEPTH,
        limit: REMOTE_FOLDER_SEARCH_LIMIT
      })
      .then((r) => {
        if (folderSearchSeq.current !== seq) return
        setFolderSearching(false)
        if (r.ok) {
          setFolderSearchResults(r.entries)
          setFolderSearchTruncated(!!r.truncated)
        } else {
          setFolderSearchResults([])
          setFolderSearchErr(r.error)
        }
      })
      .catch((e: unknown) => {
        if (folderSearchSeq.current !== seq) return
        setFolderSearchResults([])
        setFolderSearchErr(e instanceof Error ? e.message : String(e))
        setFolderSearchTruncated(false)
        setFolderSearching(false)
      })
  }
  const createRemoteFolder = (): void => {
    const name = newFolderName.trim()
    if (!name || creatingFolder) return
    if (/[\\/]/.test(name)) {
      setCreateFolderErr('폴더 이름에는 / 또는 \\ 문자를 넣을 수 없습니다.')
      return
    }
    const parentUri = remoteUri(profile.id, cwd)
    const createdPath = joinRemotePickerPath(cwd, name)
    setCreatingFolder(true)
    setCreateFolderErr('')
    window.lt.fs
      .mkdir(parentUri, name)
      .then((r) => {
        setCreatingFolder(false)
        if (!r.ok) {
          setCreateFolderErr(r.error ?? '폴더를 만들지 못했습니다.')
          return
        }
        setNewFolderName('')
        clearFolderSearch()
        load(createdPath)
      })
      .catch((e: unknown) => {
        setCreatingFolder(false)
        setCreateFolderErr(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <>
      <div className="modal-overlay" onMouseDown={onCancel}>
        <div className="modal remote-picker" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-title">
            🔗 {profile.label} — {title}
          </div>
          <p className="muted small remote-hint">
            기본은 사용자 홈(/Users/사용자명 또는 /home/사용자명)에서 시작합니다. 위치가 다르면 루트(/)에서 다시 찾아보세요.
          </p>
          <div className="remote-path">
            <button className="header-btn" onClick={up} title="상위 폴더">
              ↑
            </button>
            <div className="remote-path-main">
              <div className="remote-breadcrumbs" aria-label="현재 경로">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="remote-crumb-wrap">
                    {i > 0 && <span className="remote-crumb-sep">/</span>}
                    <button className="remote-crumb" type="button" onClick={() => load(c.path)}>
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
              <code className="remote-cwd">{cwd}</code>
            </div>
            <button className="header-btn" onClick={() => load(cwd)} title="새로고침">
              ⟳
            </button>
            <select
              className="sort-select remote-sort"
              value={sortMode}
              title="정렬"
              aria-label="원격 폴더 정렬"
              onChange={(e) => updateSortMode(resolveSortMode(e.target.value))}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              className="header-btn"
              type="button"
              disabled={!canSyncOneDrive}
              title={
                canSyncOneDrive
                  ? '현재 OneDrive 위치를 rclone으로 클라우드에서 최신화'
                  : 'OneDrive 또는 CloudStorage/OneDrive 폴더로 이동한 뒤 사용하세요'
              }
              onClick={() =>
                setSyncOpen({
                  macFolder: syncPath,
                  reloadPath: syncPath,
                  folderLabel: syncFolderLabel
                })
              }
            >
              OneDrive 최신화
            </button>
          </div>
          <div className="remote-quick">
            <span className="muted small">빠른 시작</span>
            {quickStartPoints.map((p) => (
              <button
                key={p.path}
                className="remote-chip"
                type="button"
                title={p.path}
                onClick={() => load(p.path)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <form
            className="remote-jump"
            onSubmit={(e) => {
              e.preventDefault()
              if (canUsePathInput) load(pathInput)
            }}
          >
            <input
              className="setting-input"
              placeholder="원격 경로 입력: /Users/me/OneDrive/진행중사건"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
            />
            <button className="header-btn" type="submit" disabled={!canUsePathInput}>
              이동
            </button>
            <button
              className="header-btn"
              type="button"
              disabled={!canUsePathInput}
              onClick={() => canUsePathInput && onPick(pathInput.trim())}
            >
              입력 경로 선택
            </button>
          </form>
          <form
            className="remote-search"
            onSubmit={(e) => {
              e.preventDefault()
              searchFolders()
            }}
          >
            <input
              className="setting-input"
              placeholder="현재 폴더 아래 폴더명 검색"
              value={folderQuery}
              onChange={(e) => setFolderQuery(e.target.value)}
            />
            <button className="header-btn" type="submit" disabled={!folderQueryText || loading || folderSearching}>
              {folderSearching ? '검색 중' : '검색'}
            </button>
            {(folderQuery || folderSearchResults) && (
              <button className="header-btn" type="button" onClick={clearFolderSearch}>
                지우기
              </button>
            )}
          </form>
          <form
            className="remote-create"
            onSubmit={(e) => {
              e.preventDefault()
              createRemoteFolder()
            }}
          >
            <input
              className="setting-input"
              placeholder="현재 위치에 새 폴더 이름"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button className="header-btn" type="submit" disabled={!canCreateFolder}>
              {creatingFolder ? '생성 중' : '새 폴더'}
            </button>
          </form>
          {createFolderErr && <pre className="remote-err">{createFolderErr}</pre>}
          {folderSearchErr && <pre className="remote-err">{folderSearchErr}</pre>}
          {folderSearchTruncated && (
            <p className="muted small remote-hint">
              검색 결과가 많아 상위 {REMOTE_FOLDER_SEARCH_LIMIT}개만 표시합니다.
            </p>
          )}
          <div className="remote-list">
            {loading && <p className="muted pad small">불러오는 중…</p>}
            {!loading && folderSearching && <p className="muted pad small">폴더를 검색하는 중…</p>}
            {!loading && err && (
              <div className="pad">
                <p className="muted small">
                  목록을 가져오지 못했습니다. 다른 시작 위치를 눌러보거나 경로를 직접 입력하세요.
                </p>
                <pre className="remote-err">{err}</pre>
              </div>
            )}
            {!loading && !folderSearching && !err && visibleDirs.length === 0 && (
              <p className="muted pad small">
                {folderSearchResults
                  ? '검색 결과가 없습니다.'
                  : `하위 폴더가 없습니다. 아래 ‘${confirmLabel}’를 누르거나 상위로 이동하세요.`}
              </p>
            )}
            {!loading &&
              !folderSearching &&
              !err &&
              visibleDirs.map((e) => (
                <button
                  key={e.path}
                  className={`remote-row ${folderSearchResults ? 'remote-search-row' : ''}`}
                  onClick={() => load(e.path)}
                  title={e.path}
                >
                  <span className="remote-row-name">📁 {e.name}</span>
                  {folderSearchResults && <span className="remote-row-path">{e.path}</span>}
                </button>
              ))}
          </div>
          <div className="modal-actions">
            <button
              className="empty-action"
              type="button"
              disabled={!canPickCurrentFolder}
              onClick={() => {
                if (canPickCurrentFolder) onPick(cwd)
              }}
            >
              {loading ? '불러오는 중' : confirmLabel}
            </button>
            <button className="header-btn" onClick={onCancel}>
              취소
            </button>
          </div>
        </div>
      </div>
      {syncOpen && (
        <SyncModal
          profiles={[profile]}
          init={{
            profile,
            macFolder: syncOpen.macFolder,
            folderLabel: syncOpen.folderLabel,
            directions: 'pull-only'
          }}
          onClose={closeSync}
        />
      )}
    </>
  )
}

// rclone 동기화 모달 (클라우드 경유) — 맥에서 rclone 실행: 맥 사건폴더 ↔ OneDrive 클라우드.
// 올리기(맥→클라우드)/내리기(클라우드→맥) 두 버튼. Windows는 자신의 OneDrive 앱으로 받음.
function SyncModal({
  profiles,
  init,
  onClose
}: {
  profiles: SshProfile[]
  init: {
    profile: SshProfile
    macFolder: string
    folderLabel?: string
    directions?: 'both' | 'pull-only'
  }
  onClose: () => void
}): JSX.Element {
  const [profileId, setProfileId] = useState(init.profile.id)
  const [macFolder, setMacFolder] = useState(init.macFolder)
  const [remoteName, setRemoteName] = useState('') // 예: "onedrive:"
  const [cloudPath, setCloudPath] = useState(cloudPathFromOneDrivePath(init.macFolder))
  const [syncMode, setSyncMode] = useState<'full' | 'folders'>('full')
  const [info, setInfo] = useState<{ installed: boolean; remotes: string[]; error?: string } | null>(
    null
  )
  const [log, setLog] = useState<string[]>([])
  const [runningDirection, setRunningDirection] = useState<'pull' | 'push' | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const profile = profiles.find((p) => p.id === profileId) ?? init.profile
  const running = runningDirection !== null
  const folderLabel = init.folderLabel ?? '사건폴더'
  const pullOnly = init.directions === 'pull-only'
  const runningLabel =
    runningDirection === 'pull' ? '내리기' : runningDirection === 'push' ? '올리기' : ''

  // 진행 로그 구독
  useEffect(() => window.lt.sync.onProgress((line) => setLog((l) => [...l, line])), [])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // 프로필 바뀌면 맥 rclone 정보(설치/리모트) 다시 조회
  const probe = (): void => {
    setInfo(null)
    window.lt.sync.remoteInfo(profile).then((r) => {
      setInfo(r)
      if (r.installed && r.remotes.length && !remoteName) {
        setRemoteName(r.remotes.find((x) => /one/i.test(x)) ?? r.remotes[0])
      }
    })
  }
  useEffect(probe, [profileId]) // eslint-disable-line react-hooks/exhaustive-deps

  const normalizedCloudPath = cloudPath.trim().replace(/^\/+/, '').normalize('NFC')
  const dest = remoteName ? remoteName + normalizedCloudPath : ''
  const canRun = Boolean(!running && info?.installed && macFolder.trim() && remoteName)
  const run = (direction: 'pull' | 'push'): void => {
    if (!canRun) return
    const label = direction === 'pull' ? '내리기' : '올리기'
    const modeLabel = syncMode === 'folders' ? '폴더명만' : '전체'
    setRunningDirection(direction)
    setLog((l) => [...l, `${label} 시작 (${modeLabel}): ${dest}`])
    window.lt.sync
      .run({ profile, direction, mode: syncMode, macFolder, dest })
      .then((r) => {
        if (!r.ok && r.error) setLog((l) => [...l, '오류: ' + r.error])
      })
      .catch((e) => setLog((l) => [...l, '오류: ' + String(e)]))
      .finally(() => setRunningDirection(null))
  }
  const cancelRun = (): void => {
    if (!running) return
    setLog((l) => [...l, `${runningLabel} 중단 요청...`])
    window.lt.sync.cancel()
  }

  return (
    <div className="modal-overlay" onMouseDown={running ? undefined : onClose}>
      <div className="modal sync-modal" aria-busy={running} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          ⇅ 동기화 (맥미니 rclone · {folderLabel}
          {pullOnly ? ' ← OneDrive 클라우드' : ' ↔ OneDrive 클라우드'})
        </div>

        <label className="sync-field">
          접속 프로필 (맥미니)
          <select
            className="setting-select"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.user}@{p.host})
              </option>
            ))}
          </select>
        </label>

        {info && !info.installed && (
          <div className="pad">
            <p className="muted small">
              맥미니에서 rclone을 실행할 수 없습니다. (rclone 미설치이거나 SSH 키/agent 인증이
              아닐 수 있습니다.)
            </p>
            {info.error && <pre className="remote-err">{info.error}</pre>}
            <p className="muted small">
              맥미니 터미널에서 <code>rclone config</code> 로 OneDrive 리모트를 한 번 만들어 두세요.
            </p>
            <button className="empty-action" onClick={probe}>
              다시 확인
            </button>
          </div>
        )}

        {info?.installed && (
          <>
            <label className="sync-field">
              rclone 리모트 (맥의 OneDrive 설정)
              <select
                className="setting-select"
                value={remoteName}
                onChange={(e) => setRemoteName(e.target.value)}
              >
                {info.remotes.length === 0 && <option value="">(설정된 리모트 없음)</option>}
                {info.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="sync-field">
              맥 {folderLabel}
              <input
                className="setting-input"
                value={macFolder}
                placeholder="/Users/me/Library/CloudStorage/OneDrive/진행중사건/사건폴더"
                onChange={(e) => setMacFolder(e.target.value)}
              />
            </label>
            <label className="sync-field">
              클라우드 경로 (리모트 내부)
              <input
                className="setting-input"
                value={cloudPath}
                placeholder="진행중사건/사건폴더 (비우면 OneDrive 루트)"
                onChange={(e) => setCloudPath(e.target.value)}
              />
            </label>
            <div className="sync-field">
              동기화 범위
              <div className="sync-mode" role="group" aria-label="동기화 범위">
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'full' ? 'active' : ''}`}
                  disabled={running}
                  onClick={() => setSyncMode('full')}
                >
                  전체
                </button>
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'folders' ? 'active' : ''}`}
                  disabled={running}
                  onClick={() => setSyncMode('folders')}
                >
                  폴더명만
                </button>
              </div>
            </div>
            <p className="muted small">
              대상: <code>{dest || '(리모트:경로 미정)'}</code> ·{' '}
              {syncMode === 'folders' ? (
                <>
                  파일 복사 없이 폴더 구조만 생성(<b>삭제 전파 안 함</b>)
                </>
              ) : (
                <>
                  copy --update(빈 폴더 포함, <b>삭제 전파 안 함</b>)
                </>
              )}
            </p>
            <div className="sync-buttons">
              {!pullOnly && (
                <button className="empty-action" disabled={!canRun} onClick={() => run('push')}>
                  {runningDirection === 'push' ? '올리기 진행 중...' : '⬆ 올리기 (맥 → 클라우드)'}
                </button>
              )}
              <button className="empty-action" disabled={!canRun} onClick={() => run('pull')}>
                {runningDirection === 'pull' ? '내리기 진행 중...' : '⬇ 내리기 (클라우드 → 맥)'}
              </button>
            </div>
            {running && (
              <div className="sync-status" role="status" aria-live="polite">
                <div className="sync-status-main">
                  <span className="sync-spinner" aria-hidden="true" />
                  <div>
                    <b>{runningLabel} 진행 중...</b>
                    <span>완료될 때까지 동기화 버튼은 비활성화됩니다.</span>
                  </div>
                </div>
                <button className="header-btn danger" onClick={cancelRun}>
                  중단
                </button>
              </div>
            )}
            {log.length > 0 && (
              <pre className="sync-log" ref={logRef}>
                {log.join('\n')}
              </pre>
            )}
          </>
        )}

        {!info && <p className="muted pad small">맥미니 rclone 확인 중…</p>}

        <div className="modal-actions">
          <button className="header-btn" onClick={onClose} disabled={running}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

function Empty({
  label,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary
}: {
  label: string
  actionLabel: string
  onAction: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}): JSX.Element {
  return (
    <div className="empty">
      <p className="muted">{label}</p>
      <button className="empty-action" onClick={onAction}>
        ＋ {actionLabel}
      </button>
      {secondaryLabel && onSecondary && (
        <button className="header-btn empty-secondary" onClick={onSecondary}>
          {secondaryLabel}
        </button>
      )}
    </div>
  )
}
