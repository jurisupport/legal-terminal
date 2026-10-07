import { mediaMimeType, mediaSelectionKey, formatMediaTime, normalizeMediaSelection, type MediaAskRequest, type MediaSelection, type MediaViewState } from '../../shared/media'
import MediaViewer from './viewer/MediaViewer'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode
} from 'react'
import Terminal from './terminal/Terminal'
import CaseSidebar, { type SidebarCase, type SidebarTask } from './CaseSidebar'
import AgentPanel, {
  DiffPreview,
  type AgentAttachmentRequest,
  type AgentDraftState,
  type AgentDiffOpenRequest,
  type AgentProviderHandoff,
  type AgentInlineActions
} from './agent/AgentPanel'
import InlineSelectionCommand from './agent/InlineSelectionCommand'
import { preloadSessionTranscripts } from './agent/transcriptCache'
import {
  expandSessionSearchLimit,
  matchesSearch,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_RECENT_LIMIT
} from './search/sessionSearch'
import FileTree, { LT_PATH, sortEntries, type PendingCreateRequest, type SortMode } from './filetree/FileTree'
import PdfViewer, { type PdfViewStatus } from './viewer/PdfViewer'
import RecordViewer from './viewer/RecordViewer'
import { parseRecordFiles, type ParsedRecord, type OutlineItem } from './viewer/recordOutline'
import {
  IconExplorer,
  IconCases,
  IconCaseTabs,
  IconTodos,
  IconViewer,
  IconSettings,
  IconNewFile,
  IconNewFolder,
  IconSync,
  IconWorkspace,
  IconParentFolder,
  IconSearch,
  IconSave,
  IconSaveAs
} from './icons/Icons'
import MarkdownEditor, {
  MARKDOWN_CENTER_SELECTION_EVENT,
  TEXT_SELECTION_OVERLAY_EVENT,
  claudeDraftFileName,
  type MarkdownClaudeDraftHandler,
  type MarkdownSaveHandler,
  type MarkdownDocumentPayload,
  type MarkdownRevealRequest,
  type MarkdownSelectionRange,
  type TextSelectionOverlayDetail
} from './editor/MarkdownEditor'
import { markdownToPlainText, writeMarkdownClipboard } from './markdownClipboard'
import FindBar from './search/FindBar'
import CasesDashboard, { JS_TOKEN_UPDATED_EVENT } from './dashboard/CasesDashboard'
import ProjectsDashboard from './dashboard/ProjectsDashboard'
import type { Project, ProjectCaseLink, ProjectFolderLink } from '../../shared/project'
import SetupChecklist from './welcome/SetupChecklist'
import { clearCaseListCache } from './dashboard/caseListCache'
import UpcomingHearings from './dashboard/UpcomingHearings'
import { isActiveHearing } from './dashboard/hearings'
import TodosDashboard from './dashboard/TodosDashboard'
import TodayTodos from './dashboard/TodayTodos'
import TodoSummary, { TodoHeaderBadge } from './dashboard/TodoSummary'
import { todoAgentPrompt } from '../../shared/agentTodo'
import { useTodoSnapshot, type TodoSnapshot } from './dashboard/useTodoSnapshot'
import { useCaseManagementUi } from './dashboard/useCaseManagementUi'
import NextActionProposal, { type NextActionRequest } from './NextActionProposal'
import { kstDateKey, type TodoFilter } from '../../shared/todoSummary'
import type { JsTodo, JsUpcomingHearing } from './env'
import { buildAgentWorkspaceContext, resolveAgentContextKind, type AgentContextKind, type AgentWorkspaceContext } from '../../shared/agentWorkspaceContext'
import HearingRecordPanel, {
  buildHearingRecordTitle,
  resolveHearingRecordPath,
  type HearingRecordCase
} from './hearing/HearingRecordPanel'
import { cancelIfTerminalPointerDrag } from './dragGuard'
import { closeTab } from './tabSelection'
import {
  normalizeRemoteQuickStartPaths,
  remoteQuickStartInputToPaths,
  remoteQuickStartInputValue,
  remoteStartPointKey,
  toggleRemoteQuickStartPath
} from './remoteQuickStart'
import {
  pathBelongsToCaseFolder,
  rankCaseFolders,
  rebaseCaseFolderToRoot,
  trustedCaseFolder,
  type CaseFolderInfo,
  type FolderMatchSuggestion
} from './caseFolderMatch'
import { mergeWorkspaceSessions } from './workspaceSessions'
import { agentTabsOnly, isAgentTabClosed } from '../../shared/workspaceAgentTabs'
import type {
  AppSettings,
  AgentAttachment,
  AgentProvider,
  OfficeProfileSettings,
  CaseSessionSummary,
  JsCase,
  JsHearing,
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
  WorkspaceCaseTabPayload,
  WorkspaceSnapshot,
  FsDownloadProgress
} from './env'

type Mode = 'explorer' | 'cases' | 'viewer' | 'todos'
type DockSide = 'left' | 'right'
type ResizablePane = 'side' | 'left' | 'evidence'
type RecentCase = { drafts: string; records?: string; name: string; ts: number }
type SyncMode = 'full' | 'folders' | 'file'
type SyncDirection = 'pull' | 'push' | 'bi'
interface SyncModalInit {
  profile: SshProfile
  macFolder: string
  folderLabel?: string
  directions?: 'both' | 'pull-only'
  initialMode?: SyncMode
  lockMode?: boolean
}

function isComposingInputKeyEvent(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229
}

interface ActivityItem {
  id: Mode
  label: string
  Icon: (props: { size?: number }) => JSX.Element
}

interface SlashCommand {
  id: string
  label: string
  detail: string
  keywords?: string
  shortcut?: string
  run: () => void
}

const ACTIVITY: ActivityItem[] = [
  { id: 'cases', label: '사건', Icon: IconCases },
  { id: 'explorer', label: '탐색기', Icon: IconExplorer },
  { id: 'viewer', label: '기록뷰어', Icon: IconViewer },
  { id: 'todos', label: '할일', Icon: IconTodos }
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
const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude'
const DEFAULT_SIDE_PANE_WIDTH = 272
const DEFAULT_EVIDENCE_PANE_WIDTH = 280
const MIN_SIDE_PANE_WIDTH = 160
const MIN_WORK_PANE_WIDTH = 220
const MIN_EVIDENCE_PANE_WIDTH = 180
const MIN_RIGHT_PANE_WIDTH = 220
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const APP_WINDOW_TITLE = 'legal-terminal'
const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"
const DEFAULT_NOTIFICATION_SOUND: NotificationSound = 'chime'
const DEFAULT_NOTIFICATION_VOLUME = 85
const REMOTE_RECORD_AUTO_DOWNLOAD_INTERVAL_MS = 30_000

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

type ExplorerToolButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string
  tooltip?: string
  children: ReactNode
}

function ExplorerToolButton({
  label,
  tooltip = label,
  className = '',
  children,
  ...buttonProps
}: ExplorerToolButtonProps): JSX.Element {
  return (
    <button
      {...buttonProps}
      className={['tool-btn', 'explorer-tool-btn', className].filter(Boolean).join(' ')}
      title={tooltip}
      aria-label={label}
      data-tooltip={tooltip}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}

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
  identityFile: profile.identityFile,
  remoteControl: profile.remoteControl
})

interface DocTab {
  mediaState?: MediaViewState
  id: string
  title: string
  kind:
    | 'welcome'
    | 'markdown'
    | 'mdview'
    | 'file'
    | 'pdf'
    | 'image'
    | 'media'
    | 'hwp'
    | 'docx'
    | 'csv'
    | 'settings'
    | 'diff'
    | 'hearing'
  caseTabId?: string
  path?: string
  diffId?: string
  hearingCase?: HearingRecordCase
  hearingDrafts?: string
  hearing?: JsHearing
  side?: DockSide
}

interface DocScrollPosition {
  key: string
  top: number
  left: number
}

interface CaseDocumentUpdates {
  paths: string[]
  latestAt: number
}

interface DirtyDocTarget {
  id: string
  title: string
  kind: DocTab['kind']
  path?: string
}

interface CloseWindowPromptState {
  docs: DirtyDocTarget[]
  saving: boolean
  error?: string
}

type SaveDirtyDocResult = { ok: true } | { ok: false; error: string }

/**
 * 터미널 1개 = 사건 1개.
 * cwd = 작성서류 폴더(claude 작업·탐색기 기준). recordsFolder = 소송기록 폴더(뷰어 기준, 별도 지정).
 */
interface TermTab {
  todoManagement?: boolean
  selectedTaskId?: string
  contextKind?: AgentContextKind
  projectId?: string
  id: string
  title: string
  kind?: 'terminal' | 'agent'
  caseTabId?: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string // 페어링으로 추천된 소송기록 폴더 (사용자가 '열기' 눌러야 적용)
  suggestedRecordOptions?: FolderMatchSuggestion[]
  autoClaude?: boolean // 명시적으로 터미널을 열 때만 claude 자동 실행
  autoAgent?: AgentProvider
  agentProvider?: AgentProvider
  // JuriSupport 사건에서 연 세션의 메타 (자동 명명·사건별 필터용)
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  memo?: string
  originDevice?: 'android' | 'desktop'
  sessionTitle?: string // claude 세션 제목(ai-title) — transcript에서 자동 반영
  renamed?: boolean // 사용자가 직접 이름 변경 → 자동 반영 중단
  createdAt?: number // 세션 시작 시각 — 이 이후의 transcript만 현재 세션으로 매칭
  resumeSessionId?: string // 과거 세션 이어서 열기
  forkFromSessionId?: string // 새 세션에 맥락만 주입할 원본 세션
  handoffContext?: AgentProviderHandoff // 프로바이더 전환 시 이어받은 대화 맥락 — 첫 지시에 합쳐 전달
  ssh?: SshConn // 주어지면 원격(SSH) 사건 — cwd는 원격 경로, claude도 원격에서 실행
  sshLabel?: string // 접속 프로필 이름 (탭 툴팁/표시용)
  profileId?: string // 원격 파일 패널 라우팅용 (ssh://<profileId>/<경로>)
  side?: DockSide
}

type WorkTabKind = 'doc' | 'terminal'
type WorkTabKey = `${WorkTabKind}:${string}`
type TermRunStatus = 'idle' | 'working' | 'done' | 'question'

const docSide = (tab?: DocTab): DockSide => tab?.side ?? 'left'
const termSide = (tab?: TermTab): DockSide => tab?.side ?? 'right'
const isAgentTab = (tab?: TermTab): tab is TermTab & { kind: 'agent' } => tab?.kind === 'agent'
const isAgentProvider = (value: unknown): value is AgentProvider => value === 'claude' || value === 'codex'
const resolveAgentProvider = (value: unknown, _ssh?: SshConn): AgentProvider =>
  isAgentProvider(value) ? value : DEFAULT_AGENT_PROVIDER
const isClaudeAgentTab = (tab?: TermTab): tab is TermTab & { kind: 'agent' } =>
  isAgentTab(tab) && resolveAgentProvider(tab.agentProvider, tab.ssh) === 'claude'
const agentProviderLabel = (term: TermTab): string =>
  resolveAgentProvider(term.agentProvider, term.ssh) === 'codex' ? 'Codex Agent' : 'Claude Agent'
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
const workKeysForSide = (
  docs: readonly DocTab[],
  terms: readonly TermTab[],
  side: DockSide
): WorkTabKey[] => [
  ...docs.filter((tab) => docSide(tab) === side).map((tab) => docKey(tab.id)),
  ...terms.filter((tab) => termSide(tab) === side).map((tab) => termKeyOf(tab.id))
]
const resolveActiveWorkKey = (
  keys: readonly WorkTabKey[],
  activeKey: string
): WorkTabKey | '' =>
  keys.some((key) => key === activeKey) ? (activeKey as WorkTabKey) : (keys[0] ?? '')
const nextWorkKeyAfterClose = (
  keys: readonly WorkTabKey[],
  closedKey: WorkTabKey
): WorkTabKey | '' => {
  const idx = keys.findIndex((key) => key === closedKey)
  const next = keys.filter((key) => key !== closedKey)
  if (next.length === 0) return ''
  return next[Math.min(idx < 0 ? 0 : idx, next.length - 1)]
}

const bumpFocusNonce = (current: Record<string, number>, id: string): Record<string, number> => ({
  ...current,
  [id]: (current[id] ?? 0) + 1
})

const resolveClaudeAgentTargetTab = (
  tabs: TermTab[],
  activeTermId: string,
  activeWorkBySide: Record<DockSide, string>
): (TermTab & { kind: 'agent' }) | undefined => {
  const active = tabs.find((tab) => tab.id === activeTermId)
  if (isClaudeAgentTab(active)) return active
  for (const side of ['right', 'left'] as DockSide[]) {
    const parsed = parseWorkKey(activeWorkBySide[side] ?? '')
    if (parsed?.kind !== 'terminal') continue
    const visible = tabs.find((tab) => tab.id === parsed.id)
    if (isClaudeAgentTab(visible)) return visible
  }
  return tabs.find(isClaudeAgentTab)
}

// 원격 파일 패널이 쓰는 ssh:// URI 빌더 (main의 remoteFs와 동일 스킴)
const remoteUri = (profileId: string, p: string): string =>
  'ssh://' + profileId + (p.startsWith('/') ? p : '/' + p)

const isRemotePath = (p?: string): p is string => !!p && p.startsWith('ssh://')
const remoteJsPairingKey = (profileId: string, caseId: string): string => `remote:${profileId}:${caseId}`
const REMOTE_FILE_CHANGED_EVENT = 'lt:remote-file-changed'
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
    const onRemoteFileChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ paths?: unknown }>).detail
      const paths = Array.isArray(detail?.paths)
        ? detail.paths.filter((item): item is string => typeof item === 'string')
        : []
      if (!paths.includes(path)) return
      sigRef.current = ''
      setVersion((v) => v + 1)
      tick()
    }
    tick()
    window.addEventListener(REMOTE_FILE_CHANGED_EVENT, onRemoteFileChanged)
    const timer = setInterval(tick, intervalMs)
    return () => {
      alive = false
      window.removeEventListener(REMOTE_FILE_CHANGED_EVENT, onRemoteFileChanged)
      clearInterval(timer)
    }
  }, [path, intervalMs])

  return version
}
interface CaseMeta {
  contextKind?: AgentContextKind
  projectId?: string
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  memo?: string
}
interface CurrentCase {
  drafts: string
  records?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
  name: string
  meta?: CaseMeta
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
  remotePath?: string
}
type OpenedCase = CurrentCase & { term?: TermTab; termId?: string }

interface ClaudeDraftPromptOptions {
  sourcePath?: string
  sourceTitle?: string
  instruction?: string
}
interface ClaudeSelectionSource {
  docId?: string
  docPath?: string
  docTitle?: string
  text?: string
  range?: NonNullable<AgentAttachment['source']>['range']
}
interface ClaudeAskOptions extends ClaudeDraftPromptOptions {
  docPath?: string | null
  sourceLabel?: string
  selectionSource?: ClaudeSelectionSource
  agentQuoteMessageId?: string
}

interface InlineSelectionContext {
  key: string
  caseId: string
  caseName: string
  source: ClaudeSelectionSource
  sourceSide: DockSide
  text: string
  x: number
  y: number
  domRange?: Range
  sourceElement?: HTMLElement
  targetId: string
}

type CaseWorkspaceTab = WorkspaceCaseTabPayload

const WORKSPACE_VERSION = 1
const RESTORABLE_DOC_KINDS = new Set<DocTab['kind']>([
  'markdown',
  'mdview',
  'file',
  'pdf',
  'image',
  'media',
  'hwp',
  'docx',
  'csv',
  'settings',
  'hearing'
])

const isRestorableDocKind = (value: unknown): value is DocTab['kind'] =>
  typeof value === 'string' && RESTORABLE_DOC_KINDS.has(value as DocTab['kind'])

const normalizeDocKind = (kind: DocTab['kind'], path?: string): DocTab['kind'] =>
  path && mediaMimeType(path) ? 'media' : path && docKindForPath(path) === 'mdview' ? 'mdview' : kind

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
const shouldFocusAgentPrompt = (target: HTMLElement): boolean =>
  !target.closest(
    'input, textarea, button, select, a, [contenteditable="true"], [role="button"], [role="textbox"], .agent-md-wrap, .agent-card-text, .agent-card-input, .agent-process-step-text'
  )
const isTextEntryTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], .cm-editor, .xterm')

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

const parentLocalPath = (path: string): string | undefined => {
  const clean = path.replace(/[\\/]+$/, '')
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (slash < 0) return undefined
  if (slash === 0) return clean === '/' ? undefined : '/'
  const parent = clean.slice(0, slash)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${clean[slash]}`
  return parent
}

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
    case 'docx':
      return 'DOCX'
    case 'csv':
      return 'CSV'
    case 'diff':
      return '변경 비교'
    case 'hearing':
      return '기일 기록'
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
  a.path === b.path &&
  a.page === b.page &&
  a.pages === b.pages &&
  a.zoomPct === b.zoomPct &&
  a.zoomMode === b.zoomMode &&
  a.rotation === b.rotation &&
  a.cropOn === b.cropOn &&
  a.cropRatio === b.cropRatio

const pdfStatusKey = (path?: string): string => path ?? ''

const sanitizePdfStatus = (value: unknown): PdfViewStatus | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PdfViewStatus>
  if (typeof raw.path !== 'string' || !raw.path) return null
  const page = Number.isFinite(raw.page) ? Math.max(1, Math.floor(raw.page as number)) : 1
  const pages = Number.isFinite(raw.pages) ? Math.max(0, Math.floor(raw.pages as number)) : 0
  const zoomPct = Number.isFinite(raw.zoomPct) ? Math.max(10, Math.round(raw.zoomPct as number)) : 100
  const zoomMode =
    raw.zoomMode === 'fit_width' || raw.zoomMode === 'fit_page' || raw.zoomMode === 'custom'
      ? raw.zoomMode
      : 'fit_page'
  const rotation = Number.isFinite(raw.rotation)
    ? ((Math.floor((raw.rotation as number) / 90) * 90) % 360 + 360) % 360
    : 0
  const cropRatio = Number.isFinite(raw.cropRatio) ? Math.max(0, Math.min(0.5, raw.cropRatio as number)) : 0.05
  return { path: raw.path, page, pages, zoomPct, zoomMode, rotation, cropOn: !!raw.cropOn, cropRatio }
}

const sameDocScrollPosition = (a: DocScrollPosition | undefined, b: DocScrollPosition): boolean =>
  !!a && a.key === b.key && a.top === b.top && a.left === b.left

const docScrollKey = (tab: Pick<DocTab, 'id' | 'path'>): string => tab.path ?? tab.id

function useRestoredScroll<T extends HTMLElement>(
  scrollKey: string | undefined,
  initialScroll: DocScrollPosition | undefined,
  onScrollPosition: ((position: DocScrollPosition) => void) | undefined,
  restoreToken: unknown
): { ref: RefObject<T>; onScroll: () => void } {
  const ref = useRef<T>(null)
  const onScrollPositionRef = useRef(onScrollPosition)
  const rafRef = useRef<number | null>(null)
  const restoredForRef = useRef('')
  onScrollPositionRef.current = onScrollPosition

  const emit = (): void => {
    const el = ref.current
    if (!el || !scrollKey) return
    onScrollPositionRef.current?.({ key: scrollKey, top: el.scrollTop, left: el.scrollLeft })
  }

  const onScroll = (): void => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      emit()
    })
  }

  useEffect(() => {
    const el = ref.current
    if (!el || !scrollKey || initialScroll?.key !== scrollKey) return
    const restoreId = `${scrollKey}:${String(restoreToken)}`
    if (restoredForRef.current === restoreId) return
    restoredForRef.current = restoreId
    const { top, left } = initialScroll
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = top
      el.scrollLeft = left
    })
    return () => window.cancelAnimationFrame(frame)
  }, [initialScroll?.key, restoreToken, scrollKey])

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      emit()
    },
    [scrollKey]
  )

  return { ref, onScroll }
}

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
      pdfStatus.rotation ? `${pdfStatus.rotation}°` : undefined,
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
            : term.autoAgent === 'codex'
              ? 'Codex 완료'
              : term.autoClaude
                ? 'Claude 완료'
                : '터미널 완료'
          : agent
            ? 'Agent 대기'
            : term.autoAgent === 'codex'
              ? 'Codex 대기'
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

const matchNorm = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFC')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.,()[\]{}·]+/g, '')

const caseFolderInfo = (c: Pick<JsCase, 'caseNumber' | 'caseName' | 'parties'>): CaseFolderInfo => ({
  caseNumber: c.caseNumber,
  caseName: c.caseName,
  partyNames: c.parties.map((party) => party.party.name).filter(Boolean)
})

const fileNameFromPath = (path: string): string =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i
const TEXT_EDIT_EXT_RE = /\.(txt|json|csv|log|ya?ml|html?|xml|js|ts|tsx|css|py|sh|ini|toml)$/i
const HTML_EXT_RE = /\.html?$/i
const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
const isPlainTextEditPath = (path?: string): boolean => !!path && TEXT_EDIT_EXT_RE.test(path)
const isHtmlPath = (path?: string): path is string => !!path && HTML_EXT_RE.test(path)

const markdownRenameName = (title: string, currentName: string): string => {
  const next = title.trim()
  const ext = currentName.match(MARKDOWN_EXT_RE)?.[0]
  if (!next || !ext || MARKDOWN_EXT_RE.test(next) || FILE_EXT_RE.test(next)) return next
  return `${next}${ext}`
}

const docKindForPath = (path: string): DocTab['kind'] => {
  const lower = path.toLowerCase()
  if (mediaMimeType(lower)) return 'media'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/.test(lower)) return 'image'
  if (/\.(hwp|hwpx)$/.test(lower)) return 'hwp'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.hearing.json')) return 'hearing'
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'mdview'
  if (HTML_EXT_RE.test(lower)) return 'file'
  if (TEXT_EDIT_EXT_RE.test(lower)) return 'mdview'
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
    projectId: source?.contextKind === 'project' ? source.projectId : undefined,
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

const agentWorkspaceContextForTerm = (source: TermTab, appVersion?: string): AgentWorkspaceContext => ({
  kind: resolveAgentContextKind(source),
  projectId: source.projectId,
  todoManagement: source.todoManagement,
  cwd: source.cwd,
  appVersion,
  caseId: source.jsId,
  selectedTaskId: source.selectedTaskId,
  court: source.court,
  caseNumber: source.caseNumber,
  caseName: source.caseName,
  client: source.client,
  opponent: source.opponent,
  recordsFolder: source.recordsFolder
})

const agentCaseContextForTerm = (source: TermTab): string =>
  buildAgentWorkspaceContext(agentWorkspaceContextForTerm(source))

const sessionRememberInput = (
  source: TermTab,
  sessionId: string,
  title?: string,
  mtime?: number
): SessionRememberInput => ({
  ...(sessionContextForTerm(source) ?? {}),
  sessionId,
  originDevice: source.originDevice,
  cwd: source.cwd,
  title: koreanSessionTitle(source) || title,
  transcriptTitle: title,
  mtime,
  ssh: source.ssh
})

const sessionListCache = new Map<string, { entries: SessionListEntry[]; fetchedAt: number }>()
const sessionListInflight = new Map<string, Promise<SessionListEntry[]>>()

const sessionListKey = (
  cwd: string,
  ssh?: SshConn,
  context?: SessionSearchContext,
  limit = 40
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
    context: context ?? null,
    limit
  })

const cachedPastSessions = (
  cwd: string,
  source?: TermTab,
  query = '',
  limit = 40
): SessionListEntry[] | undefined => {
  const context = sessionContextForTerm(source, query)
  return sessionListCache.get(sessionListKey(cwd, source?.ssh, context, limit))?.entries
}

const loadPastSessions = (
  cwd: string,
  source?: TermTab,
  query = '',
  refresh = false,
  limit = 40
): Promise<SessionListEntry[]> => {
  const context = sessionContextForTerm(source, query)
  const key = sessionListKey(cwd, source?.ssh, context, limit)
  const inflight = sessionListInflight.get(key)
  if (inflight) return inflight
  if (!refresh) {
    const cached = sessionListCache.get(key)
    const freshMs = source?.ssh ? 3 * 60_000 : 60_000
    if (cached && Date.now() - cached.fetchedAt < freshMs) return Promise.resolve(cached.entries)
  }
  const request = window.lt.sessions
    .list(cwd, source?.ssh, context, limit)
    .then((entries) => {
      if (source) {
        // 제목·시각 등 세션 고유 정보만 인덱스에 보충한다. 현재 사건의 caseNumber·caseName을
        // 폴더의 모든 과거 세션에 일괄로 찍으면, 폴더를 공유하는 다른 사건의 세션까지
        // 이 사건 것으로 기록돼 사건 대시보드 매칭이 틀어진다 — 사건 연결은 실제로
        // 세션이 열린 터미널에서만(sessionRememberInput 단건 호출) 기록한다.
        entries.slice(0, SESSION_SEARCH_RECENT_LIMIT).forEach((entry) => {
          void window.lt.sessions
            .remember({
              sessionId: entry.sessionId,
              originDevice: entry.originDevice,
              cwd: entry.cwd || source.cwd,
              transcriptTitle: entry.transcriptTitle || entry.title,
              mtime: entry.mtime,
              folderName: pathLeaf(entry.cwd || source.cwd),
              profileId: source.profileId,
              sshLabel: source.sshLabel,
              ssh: source.ssh
            })
            .catch(() => {})
        })
      }
      sessionListCache.set(key, { entries, fetchedAt: Date.now() })
      return entries
    })
    .finally(() => {
      sessionListInflight.delete(key)
    })
  sessionListInflight.set(key, request)
  return request
}

// 원격에서는 목록만 읽고, 대화 본문은 작업을 선택할 때 불러온다.
const PRELOAD_TRANSCRIPT_COUNT = 3

const preloadPastSessions = (cwd?: string, source?: TermTab): void => {
  if (!cwd) return
  void loadPastSessions(cwd, source)
    .then((entries) => {
      if (source?.ssh) return
      preloadSessionTranscripts(
        entries.slice(0, PRELOAD_TRANSCRIPT_COUNT).map((entry) => entry.sessionId),
        source?.ssh
      )
    })
    .catch(() => {})
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
    agentProvider: 'claude',
    contextKind: currentCase.meta?.contextKind,
    projectId: currentCase.meta?.projectId,
    jsId: currentCase.meta?.jsId,
    court: currentCase.meta?.court,
    caseNumber: currentCase.meta?.caseNumber,
    caseName: currentCase.meta?.caseName,
    client: currentCase.meta?.client,
    opponent: currentCase.meta?.opponent,
    partyNames: currentCase.meta?.partyNames,
    memo: currentCase.meta?.memo,
    ssh,
    sshLabel: currentCase.sshLabel ?? savedProfile?.label,
    profileId,
    side: 'right'
  }
}

const todoContextForTerm = (term: TermTab): TodoTerminalContext => ({
  terminalId: term.id,
  cwd: term.cwd,
  contextKind: term.contextKind,
  projectId: term.projectId,
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
    caseTabId: tab.caseTabId,
    path: tab.path,
    mediaState: tab.mediaState,
    side: docSide(tab)
  }
}

const toDocTab = (tab: WorkspaceDocTabPayload): DocTab | null => {
  if (!RESTORABLE_DOC_KINDS.has(tab.kind)) return null
  if (tab.kind !== 'settings' && !tab.path) return null
  return {
    id: tab.id || newId(),
    title: tab.title || tab.path?.split(/[\\/]/).pop() || '문서',
    kind: normalizeDocKind(tab.kind, tab.path),
    caseTabId: tab.caseTabId,
    path: tab.path,
    mediaState: tab.mediaState,
    side: tab.side ?? 'left'
  }
}

const docTabDragPayload = (tab: DocTab, side: DockSide = docSide(tab)): TabPayload | undefined => {
  if (!tab.path || !RESTORABLE_DOC_KINDS.has(tab.kind) || tab.kind === 'settings') return undefined
  const doc: DocumentTabPayload = {
    id: tab.id,
    title: tab.title,
    kind: normalizeDocKind(tab.kind, tab.path) as DocumentTabPayload['kind'],
    caseTabId: tab.caseTabId,
    path: tab.path,
    mediaState: tab.mediaState,
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
    suggestedRecords: typeof c.suggestedRecords === 'string' ? c.suggestedRecords : undefined,
    suggestedRecordOptions: Array.isArray(c.suggestedRecordOptions)
      ? c.suggestedRecordOptions.filter(
          (item): item is FolderMatchSuggestion =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as FolderMatchSuggestion).path === 'string' &&
            typeof (item as FolderMatchSuggestion).name === 'string' &&
            typeof (item as FolderMatchSuggestion).reason === 'string' &&
            typeof (item as FolderMatchSuggestion).score === 'number'
        )
      : undefined,
    name: c.name,
    meta: c.meta,
    ssh: c.ssh,
    sshLabel: typeof c.sshLabel === 'string' ? c.sshLabel : undefined,
    profileId: typeof c.profileId === 'string' ? c.profileId : undefined,
    remotePath: typeof c.remotePath === 'string' ? c.remotePath : undefined
  }
}

const safeHash = (value: string): string => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const normalizedCasePathKey = (path?: string): string => (path ?? '').normalize('NFC').replace(/[\\/]+$/, '')

const caseProfileKey = (source: CurrentCase): string =>
  source.profileId ?? (source.ssh ? source.sshLabel ?? 'remote' : 'local')

const caseIdentityKey = (source: CurrentCase): string => {
  const profileKey = caseProfileKey(source)
  if (source.meta?.contextKind === 'project') return `project:${source.meta.projectId ?? normalizedCasePathKey(source.drafts)}`
  if (source.meta?.contextKind === 'global') return `global:${profileKey}:${normalizedCasePathKey(source.remotePath ?? source.drafts)}`
  if (source.meta?.jsId) return `js:${profileKey}:${source.meta.jsId}`
  return `drafts:${profileKey}:${normalizedCasePathKey(source.remotePath ?? source.drafts)}`
}

const caseTabId = (source: CurrentCase, tabs: readonly CaseWorkspaceTab[] = []): string => {
  const existing = findCaseTab(tabs, source)
  if (existing) return existing.id
  const base = `case-${safeHash(caseIdentityKey(source))}`
  let id = base
  for (let suffix = 1; tabs.some((tab) => tab.id === id); suffix += 1) id = `${base}-${suffix}`
  return id
}

const findCaseTab = (
  tabs: readonly CaseWorkspaceTab[],
  source: CurrentCase
): CaseWorkspaceTab | undefined => {
  const identity = caseIdentityKey(source)
  const path = normalizedCasePathKey(source.remotePath ?? source.drafts)
  return tabs.find((tab) => caseIdentityKey(tab) === identity) ?? tabs.find((tab) =>
    !!path &&
    (tab.meta?.contextKind === 'global') === (source.meta?.contextKind === 'global') &&
    (tab.meta?.contextKind === 'project') === (source.meta?.contextKind === 'project') &&
    (source.meta?.contextKind !== 'project' || tab.meta?.projectId === source.meta.projectId) &&
    caseProfileKey(tab) === caseProfileKey(source) &&
    normalizedCasePathKey(tab.remotePath ?? tab.drafts) === path &&
    !(tab.meta?.jsId && source.meta?.jsId && tab.meta.jsId !== source.meta.jsId)
  )
}

const pathMatchesCasePrefix = (path: string, prefix?: string): boolean => {
  if (!prefix) return false
  const cleanPath = path.replace(/[\\/]+$/, '')
  const cleanPrefix = prefix.replace(/[\\/]+$/, '')
  return cleanPath === cleanPrefix || cleanPath.startsWith(`${cleanPrefix}/`) || cleanPath.startsWith(`${cleanPrefix}\\`)
}

const caseTabPathPrefixes = (tab: CaseWorkspaceTab): string[] => {
  if (tab.meta?.contextKind === 'global') return []
  const prefixes = [tab.drafts, tab.records, tab.remotePath]
  if (tab.profileId && tab.remotePath) prefixes.push(remoteUri(tab.profileId, tab.remotePath))
  return prefixes.filter((path): path is string => !!path)
}

const inferCaseTabIdForPath = (
  path: string | undefined,
  tabs: readonly CaseWorkspaceTab[]
): string | undefined => {
  if (!path) return undefined
  let best: { id: string; length: number } | undefined
  for (const tab of tabs) {
    for (const prefix of caseTabPathPrefixes(tab)) {
      if (!pathMatchesCasePrefix(path, prefix)) continue
      const length = prefix.replace(/[\\/]+$/, '').length
      if (!best || length > best.length) best = { id: tab.id, length }
    }
  }
  return best?.id
}

const caseTabFromCurrentCase = (
  source: CurrentCase,
  activeTermId?: string
): CaseWorkspaceTab => ({
  id: caseTabId(source),
  name: source.name,
  drafts: source.drafts,
  records: source.records,
  suggestedRecords: source.suggestedRecords,
  suggestedRecordOptions: source.suggestedRecordOptions,
  meta: source.meta,
  ssh: source.ssh,
  sshLabel: source.sshLabel,
  profileId: source.profileId,
  remotePath: source.remotePath,
  activeTermId,
  updatedAt: Date.now()
})

const currentCaseFromCaseTab = (tab: CaseWorkspaceTab): CurrentCase => ({
  drafts: tab.drafts,
  records: tab.records,
  suggestedRecords: tab.suggestedRecords,
  suggestedRecordOptions: tab.suggestedRecordOptions,
  name: tab.name,
  meta: tab.meta,
  ssh: tab.ssh,
  sshLabel: tab.sshLabel,
  profileId: tab.profileId,
  remotePath: tab.remotePath
})

const upsertCaseTab = (
  tabs: readonly CaseWorkspaceTab[],
  incoming: CaseWorkspaceTab
): CaseWorkspaceTab[] => {
  const matchingId = tabs.find((tab) => tab.id === incoming.id)
  const existing = matchingId && incoming.id !== caseTabId(incoming)
    ? matchingId
    : findCaseTab(tabs, incoming)
  const merged: CaseWorkspaceTab = existing
    ? {
        ...existing,
        ...incoming,
        id: existing.id,
        records: incoming.records ?? existing.records,
        suggestedRecords: incoming.records ? undefined : incoming.suggestedRecords,
        suggestedRecordOptions: incoming.records ? undefined : incoming.suggestedRecordOptions,
        meta: {
          ...existing.meta,
          ...Object.fromEntries(Object.entries(incoming.meta ?? {}).filter(([, value]) => value !== undefined))
        },
        ssh: incoming.ssh ?? existing.ssh,
        sshLabel: incoming.sshLabel ?? existing.sshLabel,
        profileId: incoming.profileId ?? existing.profileId,
        remotePath: incoming.remotePath ?? existing.remotePath,
        activeDocId: incoming.activeDocId ?? existing.activeDocId,
        activeTermId: incoming.activeTermId ?? existing.activeTermId,
        activeWork: incoming.activeWork ?? existing.activeWork,
        selectedTaskId: incoming.selectedTaskId ?? existing.selectedTaskId,
        updatedAt: incoming.updatedAt ?? Date.now()
      }
    : matchingId ? { ...incoming, id: caseTabId(incoming, tabs) } : incoming
  return [merged, ...tabs.filter((tab) => tab.id !== merged.id)]
}

const mergeCaseTabs = (
  base: readonly CaseWorkspaceTab[],
  incoming: readonly CaseWorkspaceTab[]
): CaseWorkspaceTab[] =>
  incoming.reduce<CaseWorkspaceTab[]>((tabs, tab) => upsertCaseTab(tabs, tab), [...base])

const sanitizeCaseWorkspaceTab = (value: unknown): CaseWorkspaceTab | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<CaseWorkspaceTab>
  const source = sanitizeCurrentCase(raw)
  if (!source) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : caseTabId(source)
  return {
    ...caseTabFromCurrentCase(source, typeof raw.activeTermId === 'string' ? raw.activeTermId : undefined),
    id,
    activeDocId: typeof raw.activeDocId === 'string' ? raw.activeDocId : undefined,
    selectedTaskId: typeof raw.selectedTaskId === 'string' ? raw.selectedTaskId : undefined,
    activeWork:
      raw.activeWork && typeof raw.activeWork === 'object'
        ? {
            left: typeof raw.activeWork.left === 'string' ? raw.activeWork.left : undefined,
            right: typeof raw.activeWork.right === 'string' ? raw.activeWork.right : undefined
          }
        : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
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

const hasAgentDraft = (draft?: AgentDraftState): draft is AgentDraftState =>
  !!draft && (draft.input.trim().length > 0 || draft.attachments.length > 0)

const sameAgentDraft = (a: AgentDraftState | undefined, b: AgentDraftState): boolean =>
  !!a && a.input === b.input && a.attachments === b.attachments

const agentAttachmentKey = (attachment: AgentAttachment): string =>
  attachment.kind === 'media-range' && attachment.media
    ? `media:${mediaSelectionKey(attachment.media)}`
    : attachment.kind === 'selection'
    ? `${attachment.kind}:${attachment.label}:${attachment.text ?? ''}`
    : `${attachment.kind}:${attachment.path ?? attachment.label}`

export default function App(): JSX.Element {
  const docOnly = window.location.hash.includes('docOnly')
  const termOnly = window.location.hash.includes('termOnly')
  const [mode, setMode] = useState<Mode>('explorer')
  const [caseDashboardView, setCaseDashboardView] = useState<'cases' | 'projects'>('cases')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const projectOpeningRef = useRef(new Map<string, Promise<void>>())
  const projectManagementVisible = mode === 'cases' && caseDashboardView === 'projects'
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [paneWidths, setPaneWidths] = useState<{
    side: number
    left?: number
    evidence: number
  }>({ side: DEFAULT_SIDE_PANE_WIDTH, evidence: DEFAULT_EVIDENCE_PANE_WIDTH })
  const shellRef = useRef<HTMLDivElement>(null)
  const paneResizeRef = useRef<{
    pointerId: number
    pane: ResizablePane
    startX: number
    startWidth: number
    min: number
    max: number
    width: number
  } | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<string>('')
  const [platform, setPlatform] = useState<string>('')
  const [selectionCharCount, setSelectionCharCount] = useState(0)
  const [slashCommandsOpen, setSlashCommandsOpen] = useState(false)

  const [docTabs, setDocTabs] = useState<DocTab[]>(() =>
    docOnly ? [] : [{ id: 'doc-welcome', title: '시작하기.md', kind: 'welcome', side: 'left' }]
  )
  const [agentDiffs, setAgentDiffs] = useState<Record<string, AgentDiffOpenRequest>>({})
  const [activeDoc, setActiveDoc] = useState<string>(() => (docOnly ? '' : 'doc-welcome'))
  // 실제 파일에 저장되지 않은 변경사항이 있는 문서 id 집합 — 닫기 전 확인용
  const [dirtyDocs, setDirtyDocs] = useState<Set<string>>(new Set())
  const [caseDocumentUpdates, setCaseDocumentUpdates] = useState<Record<string, CaseDocumentUpdates>>({})
  const docTabsRef = useRef<DocTab[]>(docTabs)
  const dirtyDocsRef = useRef<Set<string>>(dirtyDocs)
  const [mediaReveals, setMediaReveals] = useState<Record<string, { selection: MediaSelection; nonce: number }>>({})
  const [markdownRevealRequests, setMarkdownRevealRequests] = useState<Record<string, MarkdownRevealRequest>>({})
  const markdownRevealSeqRef = useRef(0)
  const markdownSaveHandlersRef = useRef<Map<string, MarkdownSaveHandler>>(new Map())
  const markdownClaudeDraftHandlersRef = useRef<Map<string, MarkdownClaudeDraftHandler>>(new Map())
  const requestWindowCloseRef = useRef<() => void>(() => {})
  const [closeWindowPrompt, setCloseWindowPrompt] = useState<CloseWindowPromptState | null>(null)

  const [termTabs, setTermTabs] = useState<TermTab[]>([])
  const [activeTerm, setActiveTerm] = useState<string>('')
  const [mountedTermIds, setMountedTermIds] = useState<Set<string>>(new Set())
  const [caseTabs, setCaseTabs] = useState<CaseWorkspaceTab[]>([])
  const [discoveredCaseTabs, setDiscoveredCaseTabs] = useState<CaseWorkspaceTab[]>([])
  const [savedCaseLabels, setSavedCaseLabels] = useState<WorkspaceEntry[]>([])
  const [activeCaseTabId, setActiveCaseTabId] = useState<string>('')
  const activeCaseTabIdRef = useRef(activeCaseTabId)
  activeCaseTabIdRef.current = activeCaseTabId
  const caseTabCycleOrderRef = useRef<string[]>([])
  const [caseTabsOpen, setCaseTabsOpen] = useState(false)
  const [sidebarView, setSidebarView] = useState<'cases' | 'files'>('cases')
  const [caseAttentionOnly, setCaseAttentionOnly] = useState(false)
  const caseAttentionOrderRef = useRef<string[]>([])
  const [caseTabContextMenu, setCaseTabContextMenu] = useState<{
    x: number
    y: number
    tabId: string
  } | null>(null)
  const [agentAttachmentRequests, setAgentAttachmentRequests] = useState<Record<string, AgentAttachmentRequest[]>>({})
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentDraftState>>({})
  const [inlineSelection, setInlineSelection] = useState<InlineSelectionContext | null>(null)
  const inlineActionsRef = useRef(new Map<string, AgentInlineActions>())
  const [inlineReadyIds, setInlineReadyIds] = useState<Set<string>>(new Set())
  const registerInlineActions = useCallback((id: string, actions: AgentInlineActions | null): void => {
    if (actions) inlineActionsRef.current.set(id, actions)
    else inlineActionsRef.current.delete(id)
    setInlineReadyIds((current) => {
      if (current.has(id) === Boolean(actions)) return current
      const next = new Set(current)
      if (actions) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const [agentDraftClearNonce, setAgentDraftClearNonce] = useState<Record<string, number>>({})
  const [termFocusNonce, setTermFocusNonce] = useState<Record<string, number>>({})
  const [termBracketedPasteMode, setTermBracketedPasteMode] = useState<Record<string, boolean>>({})
  const termBracketedPasteModeRef = useRef<Record<string, boolean>>({})
  termBracketedPasteModeRef.current = termBracketedPasteMode

  useEffect(() => {
    const ids = caseTabs.map((tab) => tab.id)
    const liveIds = new Set(ids)
    const nextOrder = caseTabCycleOrderRef.current.filter((id) => liveIds.has(id))
    const seen = new Set(nextOrder)
    for (const id of ids) {
      if (seen.has(id)) continue
      nextOrder.push(id)
      seen.add(id)
    }
    caseTabCycleOrderRef.current = nextOrder
    setCaseDocumentUpdates((updates) => {
      const next = Object.fromEntries(Object.entries(updates).filter(([id]) => liveIds.has(id)))
      return Object.keys(next).length === Object.keys(updates).length ? updates : next
    })
  }, [caseTabs])
  const termTabsRef = useRef<TermTab[]>([])
  const caseTabsRef = useRef<CaseWorkspaceTab[]>([])
  const autoRestoreWorkspaceRef = useRef<(source: CurrentCase) => Promise<void>>(async () => {})
  const autoRestoreInFlightRef = useRef<Map<string, Promise<boolean>>>(new Map())
  const autoRestoreDoneRef = useRef<Set<string>>(new Set())
  const autoSaveEligibleRef = useRef<Set<string>>(new Set())
  const closedAutomaticCasesRef = useRef<Set<string>>(new Set())
  const pendingCaseClosesRef = useRef(new Map<string, () => Promise<void>>())
  const pendingWorkspaceReopensRef = useRef(new Map<string, { id: string; terminals: TermTab[] }>())
  const [retainedSharedCases, setRetainedSharedCases] = useState<Set<string>>(new Set())
  const refreshAutomaticCasesRef = useRef<() => Promise<void>>(async () => {})
  const automaticCasesLoadingRef = useRef(false)
  const lastCaseDiscoveryRef = useRef(0)
  const [workspaceSyncError, setWorkspaceSyncError] = useState('')
  const autoWorkspaceSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveAllCaseWorkspacesRef = useRef<() => Promise<boolean>>(async () => true)
  const agentAttachmentRequestsRef = useRef<Record<string, AgentAttachmentRequest[]>>({})
  const agentDraftsRef = useRef<Record<string, AgentDraftState>>({})
  const selectionAttachmentSeqRef = useRef(0)
  const rememberedSessionsRef = useRef<Set<string>>(new Set())
  const forceWindowCloseRef = useRef(false)
  const [activeWork, setActiveWork] = useState<Record<DockSide, string>>({
    left: docOnly ? '' : docKey('doc-welcome'),
    right: ''
  })
  const activeWorkRef = useRef(activeWork)
  activeWorkRef.current = activeWork
  const [draftsRoot, setDraftsRoot] = useState<string | undefined>()
  const [recordsRoot, setRecordsRoot] = useState<string | undefined>()
  const [caseOpenTarget, setCaseOpenTarget] = useState<string>(CASE_OPEN_LOCAL)
  const [agentDefaultProvider, setAgentDefaultProvider] = useState<AgentProvider>(DEFAULT_AGENT_PROVIDER)
  const [notificationSound, setNotificationSound] =
    useState<NotificationSound>(DEFAULT_NOTIFICATION_SOUND)
  const [notificationVolume, setNotificationVolume] = useState(DEFAULT_NOTIFICATION_VOLUME)
  const [notifyDone, setNotifyDone] = useState(true)
  // SSH 접속 프로필 + 접속 선택/원격 폴더 선택 모달 상태
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([])
  const workspaceHostsSignature = JSON.stringify(sshProfiles)
  const workspaceHostsRef = useRef(workspaceHostsSignature)
  workspaceHostsRef.current = workspaceHostsSignature
  const [workspaceSettingsReady, setWorkspaceSettingsReady] = useState(false)
  const [connMenu, setConnMenu] = useState(false)
  const [newCaseOpen, setNewCaseOpen] = useState(false)
  const [remotePick, setRemotePick] = useState<SshProfile | null>(null)
  const [projectFolderPick, setProjectFolderPick] = useState<{
    profile?: SshProfile
    resolve: (folder: ProjectFolderLink | null) => void
    reject: (error: unknown) => void
  } | null>(null)
  const [draftsPick, setDraftsPick] = useState<{
    profile: SshProfile
    startPath?: string
    termId?: string
    source?: CurrentCase
  } | null>(null)
  const [recordsPick, setRecordsPick] = useState<{
    profile: SshProfile
    draftsPath?: string
    title?: string
    startPath?: string
    termId?: string
    source?: CurrentCase
  } | null>(null)
  const [syncInit, setSyncInit] = useState<SyncModalInit | null>(null)
  const [syncMinimized, setSyncMinimized] = useState(false)
  const [workspacePick, setWorkspacePick] = useState<{
    loading: boolean
    entries: WorkspaceEntry[]
    error?: string
  } | null>(null)

  // 활성 PDF의 목차 분류 결과 + 페이지 점프 신호
  const [pdfRecord, setPdfRecord] = useState<{ path: string; parsed: ParsedRecord } | null>(null)
  const [pdfStatus, setPdfStatus] = useState<Record<string, PdfViewStatus>>({})
  const [docScrollPositions, setDocScrollPositions] = useState<Record<string, DocScrollPosition>>({})
  const [pdfJump, setPdfJump] = useState<{ docId: string; path: string; page: number; nonce: number } | undefined>()
  const jumpNonce = useRef(0)


  // 소송기록 폴더의 PDF 파일명을 파싱한 분류 결과 (폴더 기반 기록)
  const [folderRecord, setFolderRecord] = useState<ParsedRecord | null>(null)

  // 여백 자르기는 앱 전역으로 유지 (문서 바꿔도 적용 지속)
  const [cropOn, setCropOn] = useState(false)
  const [cropRatio, setCropRatio] = useState(0.05)

  // 최근 사건 히스토리
  const [recent, setRecent] = useState<RecentCase[]>([])

  // 탐색기 트리 새로고침 트리거 (드래그드롭 복사 후)
  const [treeRefresh, setTreeRefresh] = useState(0)
  const recordsAutoDownloadInFlightRef = useRef('')
  const [downloadProgress, setDownloadProgress] = useState<FsDownloadProgress | null>(null)
  const downloadProgressHideTimerRef = useRef<number | null>(null)

  // 탐색기 인라인 생성 (VS Code식: 트리에 입력칸이 떠서 이름 입력)
  const [pendingCreate, setPendingCreate] = useState<PendingCreateRequest | null>(null)
  const closeActiveTermRef = useRef<() => void>(() => {})
  const closeActiveTabRef = useRef<() => void>(() => {})
  const closeActiveCaseTabRef = useRef<() => void>(() => {})

  useEffect(() => {
    const applySettings = (s: AppSettings): void => {
      const profiles = s.sshProfiles ?? []
      setDraftsRoot(s.draftsRoot)
      setRecordsRoot(s.recordsRoot)
      setSshProfiles(profiles)
      setWorkspaceSettingsReady(true)
      setCaseOpenTarget(resolveCaseOpenTarget(s.caseOpenTarget, profiles))
      setAgentDefaultProvider(resolveAgentProvider(s.agentDefaultProvider))
      setNotificationSound(resolveNotificationSound(s.notificationSound))
      setNotificationVolume(clampNotificationVolume(s.notificationVolume))
      setNotifyDone(s.notifyDone !== false)
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
    // 이전 버전의 최근 사건에는 이름만 남아 있다. 로컬 저장본의 표시 정보만 보완한다.
    void window.lt.workspace.list().then((result) => {
      if (result.ok) setSavedCaseLabels(result.entries ?? [])
    }).catch(() => {})
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  useEffect(() => {
    const clearHideTimer = (): void => {
      if (downloadProgressHideTimerRef.current === null) return
      window.clearTimeout(downloadProgressHideTimerRef.current)
      downloadProgressHideTimerRef.current = null
    }

    const unsubscribe = window.lt.fs.onDownloadProgress((progress) => {
      clearHideTimer()
      setDownloadProgress(progress)
      if (progress.phase === 'done' || progress.phase === 'error') {
        downloadProgressHideTimerRef.current = window.setTimeout(
          () => {
            setDownloadProgress((current) => (current?.id === progress.id ? null : current))
            downloadProgressHideTimerRef.current = null
          },
          progress.phase === 'done' ? 2500 : 6000
        )
      }
    })

    return () => {
      clearHideTimer()
      unsubscribe()
    }
  }, [])

  docTabsRef.current = docTabs
  dirtyDocsRef.current = dirtyDocs
  termTabsRef.current = termTabs
  caseTabsRef.current = caseTabs
  agentAttachmentRequestsRef.current = agentAttachmentRequests
  agentDraftsRef.current = agentDrafts
  useEffect(() => {
    const killWindowTerms = (): void => {
      for (const t of termTabsRef.current) {
        if (isAgentTab(t)) void window.lt.agent.close(t.id)
        else window.lt.pty.kill(t.id)
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!forceWindowCloseRef.current && dirtyDocsRef.current.size > 0) {
        event.preventDefault()
        event.returnValue = ''
        return
      }
      killWindowTerms()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  useEffect(() => window.lt.app.onCloseActiveTab(() => closeActiveTabRef.current()), [])
  useEffect(() => window.lt.app.onCloseActiveCaseTab(() => closeActiveCaseTabRef.current()), [])
  useEffect(() => window.lt.app.onCloseWindowRequest(() => requestWindowCloseRef.current()), [])
  useEffect(() => {
    if (!caseTabsOpen) return
    const closeFromPointer = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.case-tabs-trigger, .case-tabs-flyout')) return
      setCaseTabsOpen(false)
    }
    const closeFromKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCaseTabsOpen(false)
    }
    document.addEventListener('mousedown', closeFromPointer)
    window.addEventListener('keydown', closeFromKey)
    return () => {
      document.removeEventListener('mousedown', closeFromPointer)
      window.removeEventListener('keydown', closeFromKey)
    }
  }, [caseTabsOpen])
  useEffect(() => {
    if (!caseTabContextMenu) return
    const close = (): void => setCaseTabContextMenu(null)
    const closeFromKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('keydown', closeFromKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', closeFromKey)
      window.removeEventListener('blur', close)
    }
  }, [caseTabContextMenu])
  const setWorkActive = useCallback((side: DockSide, key: WorkTabKey): void => {
    setActiveWork((active) => ({ ...active, [side]: key }))
  }, [])

  useEffect(() => {
    let alive = true
    window.lt.fs
      .listDocumentDrafts()
      .then(async (result) => {
        if (!alive || !result.ok) return
        const drafts = (result.drafts ?? []).filter((draft) => !draft.path && draft.content.trim())
        if (drafts.length === 0) return
        if (!(await window.lt.dialog.confirm(`임시저장된 새 문서 ${drafts.length}개가 있습니다. 복구 탭을 열까요?`))) return
        if (!alive) return
        const used = new Set(docTabsRef.current.map((tab) => tab.id))
        const created = drafts.map((draft): DocTab => {
          let id = draft.draftId || newId()
          if (used.has(id)) id = newId()
          used.add(id)
          return {
            id,
            title: draft.title || '무제.md',
            kind: 'mdview',
            side: 'left'
          }
        })
        setDocTabs((tabs) => [...tabs, ...created.filter((tab) => !tabs.some((item) => item.id === tab.id))])
        const first = created[0]
        if (first) {
          setActiveDoc(first.id)
          setWorkActive('left', docKey(first.id))
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [setWorkActive])

  const focusWorkTargetSoon = useCallback((side: DockSide, key: WorkTabKey | '', force = false): void => {
    window.requestAnimationFrame(() => {
      const pane = Array.from(document.querySelectorAll<HTMLElement>('.work-pane[data-work-side]')).find(
        (el) => datasetSide(el.dataset.workSide) === side
      )
      if (!pane) return
      const active = document.activeElement
      if (!force && active instanceof Element && pane.contains(active)) return

      const parsed = parseWorkKey(key)
      if (parsed?.kind === 'doc') {
        const doc = Array.from(pane.querySelectorAll<HTMLElement>('[data-doc-id]')).find(
          (el) => el.dataset.docId === parsed.id
        )
        doc?.focus({ preventScroll: true })
        return
      }
      if (parsed?.kind === 'terminal') {
        const term = Array.from(pane.querySelectorAll<HTMLElement>('[data-term-id]')).find(
          (el) => el.dataset.termId === parsed.id
        )
        const tab = termTabsRef.current.find((item) => item.id === parsed.id)
        if (isAgentTab(tab)) {
          setTermFocusNonce((current) => bumpFocusNonce(current, parsed.id))
        } else {
          term?.focus({ preventScroll: true })
        }
        return
      }

      pane.focus({ preventScroll: true })
    })
  }, [])
  const activateWorkKeyAfterClose = useCallback(
    (side: DockSide, key: WorkTabKey | ''): void => {
      setActiveWork((active) => ({ ...active, [side]: key }))
      const parsed = parseWorkKey(key)
      if (parsed?.kind === 'doc') {
        setActiveDoc(parsed.id)
        focusWorkTargetSoon(side, key)
        return
      }
      if (parsed?.kind === 'terminal') {
        setActiveTerm(parsed.id)
        const tab = termTabsRef.current.find((item) => item.id === parsed.id)
        if (tab) {
          const nextCase = currentCaseFromTerm(tab)
          setCurrentCase(nextCase)
          registerCaseTabFromTerm(tab)
        }
        if (isAgentTab(tab)) {
          focusWorkTargetSoon(side, key)
        } else {
          setTermFocusNonce((current) => bumpFocusNonce(current, parsed.id))
        }
        return
      }
      focusWorkTargetSoon(side, key)
    },
    [focusWorkTargetSoon]
  )
  const focusedWorkSide = (element = document.activeElement as HTMLElement | null): DockSide | undefined =>
    datasetSide(closestHTMLElement(element, '[data-work-side]')?.dataset.workSide)
  const focusedTermId = (element = document.activeElement as HTMLElement | null): string | undefined =>
    closestHTMLElement(element, '[data-term-id]')?.dataset.termId
  const focusedDocId = (element = document.activeElement as HTMLElement | null): string | undefined =>
    closestHTMLElement(element, '[data-doc-id]')?.dataset.docId
  const activateDocTab = (id: string): void => {
    const tab = docTabs.find((t) => t.id === id)
    const caseTabIdValue = tab?.caseTabId ?? activeCaseTabId
    clearCaseDocumentUpdates(caseTabIdValue, tab?.path)
    setActiveDoc(id)
    const side = docSide(tab)
    const key = docKey(id)
    setWorkActive(side, key)
    updateCaseTabActivity(caseTabIdValue, {
      activeDocId: id,
      activeWork: { ...activeWork, [side]: key }
    })
  }
  const openAgentDiff = useCallback(
    (request: AgentDiffOpenRequest, sourceCaseTabId?: string): void => {
      const id = `agent-diff-${request.id}`
      const caseTabIdValue = sourceCaseTabId ?? currentCaseTabIdForNewTab(termTabs.find((t) => t.id === activeTerm))
      setAgentDiffs((diffs) => ({ ...diffs, [request.id]: request }))
      setDocTabs((tabs) => {
        const existing = tabs.find((tab) => tab.kind === 'diff' && tab.diffId === request.id)
        if (existing) {
          return tabs.map((tab) =>
            tab.id === existing.id ? { ...tab, title: request.title, caseTabId: caseTabIdValue, side: 'left' } : tab
          )
        }
        return [
          ...tabs,
          { id, title: request.title, kind: 'diff', diffId: request.id, caseTabId: caseTabIdValue, side: 'left' }
        ]
      })
      setMode('explorer')
      setActiveDoc(id)
      setWorkActive('left', docKey(id))
      updateCaseTabActivity(caseTabIdValue, {
        activeDocId: id,
        activeWork: { ...activeWork, left: docKey(id) }
      })
    },
    [activeTerm, activeWork, setWorkActive, termTabs]
  )
  const activateTermTab = (id: string): void => {
    const tab = termTabs.find((t) => t.id === id)
    const caseTabIdValue = tab?.caseTabId ?? activeCaseTabId
    if (tab?.caseTabId) setActiveCaseTabId(tab.caseTabId)
    setActiveTerm(id)
    const side = termSide(tab)
    const key = termKeyOf(id)
    setWorkActive(side, key)
    updateCaseTabActivity(caseTabIdValue, {
      activeTermId: id,
      activeWork: { ...activeWork, [side]: key }
    })
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

  const dirtyDocTitles = (ids = dirtyDocsRef.current): string[] =>
    docTabsRef.current
      .filter((tab) => ids.has(tab.id))
      .map((tab) => tab.title || tab.path?.split(/[\\/]/).pop() || '문서')

  const dirtyDocTargets = (ids = dirtyDocsRef.current): DirtyDocTarget[] =>
    docTabsRef.current
      .filter((tab) => ids.has(tab.id))
      .map((tab) => ({
        id: tab.id,
        title: tab.title || tab.path?.split(/[\\/]/).pop() || '문서',
        kind: tab.kind,
        path: tab.path
      }))

  const clearDirtyDoc = (id: string): void => {
    if (dirtyDocsRef.current.has(id)) {
      const nextRef = new Set(dirtyDocsRef.current)
      nextRef.delete(id)
      dirtyDocsRef.current = nextRef
    }
    setDirtyDocs((ids) => {
      if (!ids.has(id)) return ids
      const next = new Set(ids)
      next.delete(id)
      return next
    })
  }

  const confirmCloseDirtyDocs = async (scope: 'tab' | 'window', title?: string): Promise<boolean> => {
    const names = scope === 'tab' && title ? [title] : dirtyDocTitles()
    if (names.length === 0) return true
    const shown = names.slice(0, 5).map((name) => `- ${name}`)
    const more = names.length > shown.length ? `\n- 외 ${names.length - shown.length}개` : ''
    const target = scope === 'tab' ? '이 문서' : '이 창'
    return window.lt.dialog.confirm(
      `저장하지 않은 변경사항이 있습니다.\n\n${shown.join('\n')}${more}\n\n` +
        `변경사항은 실제 파일에 저장되지 않았고, 복구용 임시저장본만 남아 있습니다.\n${target}을 닫을까요?`
    )
  }

  const saveDirtyDocFromDraft = async (doc: DirtyDocTarget): Promise<SaveDirtyDocResult> => {
    if (doc.kind !== 'mdview' && doc.kind !== 'markdown') {
      return { ok: false, error: `「${doc.title}」 문서는 자동 저장을 지원하지 않습니다.` }
    }
    const identity = { path: doc.path, draftId: doc.id }
    const draftResult = await window.lt.fs.loadDocumentDraft(identity).catch((e) => ({
      ok: false as const,
      error: String(e)
    }))
    if (!draftResult.ok) {
      return { ok: false, error: `「${doc.title}」 임시저장본을 읽지 못했습니다: ${draftResult.error ?? '알 수 없는 오류'}` }
    }
    const draft = draftResult.draft
    if (!draft) {
      return { ok: false, error: `「${doc.title}」 임시저장본을 찾지 못했습니다. 문서를 다시 열어 저장하세요.` }
    }

    if (!doc.path) {
      const result = await window.lt.fs.saveAs(draft.content, doc.title)
      if (!result.ok || !result.path) {
        return { ok: false, error: `「${doc.title}」 저장이 완료되지 않았습니다.` }
      }
      setDocPath(doc.id, result.path)
      clearDirtyDoc(doc.id)
      void window.lt.fs.deleteDocumentDraft({ draftId: doc.id }).catch(() => {})
      return { ok: true }
    }

    const stat = await window.lt.fs.stat(doc.path).catch(() => null)
    const draftSavedAt = Date.parse(draft.savedAt)
    if (
      stat?.ok &&
      Number.isFinite(draftSavedAt) &&
      typeof stat.mtimeMs === 'number' &&
      stat.mtimeMs > draftSavedAt + 1000 &&
      !(await window.lt.dialog.confirm(
        `「${doc.title}」 파일이 임시저장 이후 외부에서 변경된 것 같습니다.\n\n현재 임시저장본으로 덮어쓸까요?`
      ))
    ) {
      return { ok: false, error: `「${doc.title}」 저장을 취소했습니다.` }
    }

    if (!docTabsRef.current.some((tab) => tab.id === doc.id)) return { ok: true }
    const result = await window.lt.fs.writeText(doc.path, draft.content)
    if (!result.ok) {
      return { ok: false, error: `「${doc.title}」 저장 실패: ${result.error ?? '알 수 없는 오류'}` }
    }
    clearDirtyDoc(doc.id)
    void window.lt.fs.deleteDocumentDraft(identity).catch(() => {})
    return { ok: true }
  }

  const saveDirtyDocForClose = async (doc: DirtyDocTarget): Promise<SaveDirtyDocResult> => {
    const handler = markdownSaveHandlersRef.current.get(doc.id)
    if (handler) {
      try {
        const savedPath = await handler()
        if (savedPath || !dirtyDocsRef.current.has(doc.id)) return { ok: true }
        return { ok: false, error: `「${doc.title}」 저장이 완료되지 않았습니다.` }
      } catch (e) {
        return { ok: false, error: `「${doc.title}」 저장 실패: ${String(e)}` }
      }
    }
    return saveDirtyDocFromDraft(doc)
  }

  const forceCloseWindow = async (): Promise<void> => {
    await autoWorkspaceSaveChainRef.current.catch(() => {})
    await saveAllCaseWorkspacesRef.current().catch(() => {})
    forceWindowCloseRef.current = true
    setCloseWindowPrompt(null)
    void window.lt.app.forceCloseWindow()
  }

  const saveDirtyDocsAndClose = async (): Promise<void> => {
    const targets = dirtyDocTargets()
    setCloseWindowPrompt((prompt) =>
      prompt ? { ...prompt, docs: targets, saving: true, error: undefined } : prompt
    )
    for (const doc of targets) {
      if (!dirtyDocsRef.current.has(doc.id)) continue
      const result = await saveDirtyDocForClose(doc)
      if (!result.ok) {
        setCloseWindowPrompt({
          docs: dirtyDocTargets(),
          saving: false,
          error: result.error
        })
        return
      }
    }
    const remaining = dirtyDocTargets()
    if (remaining.length > 0) {
      setCloseWindowPrompt({
        docs: remaining,
        saving: false,
        error: '아직 저장되지 않은 문서가 있습니다.'
      })
      return
    }
    await forceCloseWindow()
  }

  requestWindowCloseRef.current = (): void => {
    const docs = dirtyDocTargets()
    if (docs.length === 0) {
      void forceCloseWindow()
      return
    }
    setCloseWindowPrompt({ docs, saving: false })
  }

  // ── 본문(문서) 탭 ──
  // 활성 사건 폴더가 있으면 거기에 실제 파일을 만들어 연다(VS Code식). 없으면 메모리 스크래치.
  const addDoc = (side: DockSide = 'left'): void => {
    const t = termTabs.find((t) => t.id === activeTerm)
    // 원격 사건이면 ssh:// URI로 만들어 원격에 생성 (plain cwd면 로컬에 잘못 생성됨)
    // 터미널이 아직 없으면(폴더 연 직후) 사건 컨텍스트의 작성서류 폴더로 폴백 — 원격이면 ssh:// URI
    const dir = t ? (t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd) : activeDraftsFolder
    if (dir) {
      setMode('explorer')
      setPendingCreate({ type: 'file', dir, side })
      return
    }
    const n = ++docSeq
    const tab: DocTab = {
      id: newId(),
      title: `새 문서 ${n}.md`,
      kind: 'mdview',
      caseTabId: currentCaseTabIdForNewTab(),
      side
    }
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
  const closeDoc = async (id: string, opts: { confirmDirty?: boolean } = {}): Promise<boolean> => {
    let tab = docTabsRef.current.find((t) => t.id === id)
    if (!tab) return false
    const confirmDirty = opts.confirmDirty ?? true
    if (confirmDirty && dirtyDocsRef.current.has(id) && !(await confirmCloseDirtyDocs('tab', tab.title))) return false
    tab = docTabsRef.current.find((t) => t.id === id)
    if (!tab) return false
    const side = docSide(tab)
    const closingKey = docKey(id)
    const sideKeys = workKeysForSide(visibleDocTabs, visibleTermTabs, side)
    const nextKey =
      resolveActiveWorkKey(sideKeys, activeWork[side]) === closingKey
        ? nextWorkKeyAfterClose(sideKeys, closingKey)
        : undefined
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
    setDocTabs((tabs) => closeTab(tabs, id, activeDoc, setActiveDoc, visibleDocTabs))
    if (nextKey !== undefined) activateWorkKeyAfterClose(side, nextKey)
    return true
  }

  const openNewCaseLauncher = (): void => {
    setCaseTabsOpen(false)
    setNewCaseOpen(true)
  }

  const openBlankWorkspaceWindow = (): void => {
    setNewCaseOpen(false)
    void window.lt.app.newWindow()
  }

  // 단축키: Ctrl/Cmd+Shift+E 탐색기 토글 / Ctrl/Cmd+T 새 Agent / Ctrl/Cmd+Shift+T 새 터미널 / Ctrl/Cmd+W 탭 닫기 / Ctrl/Cmd+Shift+W 사건탭 닫기(Windows: Ctrl+Alt+W도 지원) / Ctrl/Cmd+N 새 문서 / Ctrl/Cmd+Shift+N 새 사건
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        !slashCommandsOpen &&
        e.key === '/' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.isComposing &&
        !e.repeat &&
        !isTextEntryTarget(e.target)
      ) {
        e.preventDefault()
        e.stopPropagation()
        setSlashCommandsOpen(true)
        return
      }
      const activeEl = document.activeElement as HTMLElement | null
      const k = e.key.toLowerCase()
      const isKey = (key: string, code?: string): boolean => k === key || (!!code && e.code === code)
      const isT = isKey('t', 'KeyT')
      const isMinus = e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract'
      const isPlus = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd'
      const isZero = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0'
      const termId = focusedTermId(activeEl)
      const docId = focusedDocId(activeEl)
      const workSideForShortcut = focusedWorkSide(activeEl)
      const workTabForShortcut = workSideForShortcut ? parseWorkKey(activeWork[workSideForShortcut]) : null
      const resolvedWorkKeyForShortcut = workSideForShortcut
        ? resolveActiveWorkKey(
            workKeysForSide(visibleDocTabs, visibleTermTabs, workSideForShortcut),
            activeWork[workSideForShortcut]
          )
        : ''
      const sourceWorkKeyForShortcut =
        termId ? termKeyOf(termId) : docId ? docKey(docId) : resolvedWorkKeyForShortcut || undefined
      const sourceTermId =
        termId ?? (workTabForShortcut?.kind === 'terminal' ? workTabForShortcut.id : activeTerm)
      const termSideForShortcut =
        workSideForShortcut ?? termSide(termTabs.find((t) => t.id === sourceTermId))
      const primary = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey
      const explorerShortcut =
        primary && e.shiftKey && !e.altKey && isKey('e', 'KeyE')
      const closeCaseTabShortcut =
        primary && isKey('w', 'KeyW') && (e.shiftKey || (platform !== 'darwin' && e.altKey))
      const pageCycleShortcut = (k === 'pageup' || k === 'pagedown') && !e.altKey && (primary || e.ctrlKey)
      const macCtrlTab = platform === 'darwin' && e.ctrlKey && !e.metaKey && k === 'tab'
      const macCtrlTInWorkArea =
        platform === 'darwin' && !!(termId || workSideForShortcut) && e.ctrlKey && !e.metaKey && isT
      if (explorerShortcut) {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'explorer') setExplorerVisible((visible) => !visible)
        else {
          setMode('explorer')
          setExplorerVisible(true)
        }
        return
      }
      if (closeCaseTabShortcut) {
        e.preventDefault()
        e.stopPropagation()
        closeActiveCaseTabRef.current()
        return
      }
      if (primary && !e.altKey && !e.shiftKey && isKey('s', 'KeyS')) {
        const handler = markdownSaveHandlersRef.current.get(activeDoc)
        if (!handler) return
        e.preventDefault()
        e.stopPropagation()
        void handler()
        return
      }
      if (primary && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        cycleCaseTab(e.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (pageCycleShortcut) {
        e.preventDefault()
        e.stopPropagation()
        cycleWorkTab(k === 'pageup' ? -1 : 1, workSideForShortcut, sourceWorkKeyForShortcut)
        return
      }
      if ((!primary && !macCtrlTInWorkArea && !macCtrlTab) || e.altKey) return
      if (isT) {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) addTermSame(termSideForShortcut, sourceTermId)
        else addAgentSame(termSideForShortcut, sourceTermId)
        return
      }
      if (isMinus) {
        e.preventDefault()
        e.stopPropagation()
        cycleCaseTab(-1)
      } else if (isPlus) {
        e.preventDefault()
        e.stopPropagation()
        cycleCaseTab(1)
      } else if (isZero) {
        e.preventDefault()
        e.stopPropagation()
        setCaseTabsOpen((open) => !open)
      } else if (isKey('w', 'KeyW') && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        closeActiveTabRef.current()
      } else if (isKey('n', 'KeyN') && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openNewCaseLauncher()
      } else if (isKey('o', 'KeyO') && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        setCaseTabsOpen((open) => !open)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDoc, activeTerm, activeWork, termTabs, docTabs, platform, caseTabs, activeCaseTabId, mode, slashCommandsOpen]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const clearCaseDocumentUpdates = (caseTabIdValue: string | undefined, path: string | undefined): void => {
    if (!caseTabIdValue || !path) return
    setCaseDocumentUpdates((updates) => {
      const current = updates[caseTabIdValue]
      if (!current?.paths.includes(path)) return updates
      const next = { ...updates }
      const paths = current.paths.filter((item) => item !== path)
      if (paths.length) next[caseTabIdValue] = { ...current, paths }
      else delete next[caseTabIdValue]
      return next
    })
  }

  useEffect(() => {
    const liveCaseTabIds = new Set(caseTabs.map((tab) => tab.id))
    const onDocumentChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ paths?: unknown; caseTabId?: unknown }>).detail
      const paths = Array.isArray(detail?.paths)
        ? detail.paths.filter((item): item is string => typeof item === 'string')
        : []
      if (paths.length === 0) return
      const explicitCaseTabId = typeof detail?.caseTabId === 'string' ? detail.caseTabId : undefined
      setCaseDocumentUpdates((updates) => {
        const next = { ...updates }
        const now = Date.now()
        let changed = false
        for (const path of paths) {
          const caseTabIdValue = explicitCaseTabId ?? inferCaseTabIdForPath(path, caseTabs)
          if (!caseTabIdValue || !liveCaseTabIds.has(caseTabIdValue)) continue
          const visible = caseTabIdValue === activeCaseTabId && docTabs.some((doc) =>
            doc.path === path && caseIdForDoc(doc) === caseTabIdValue &&
            activeWorkKeyForSide(docSide(doc)) === docKey(doc.id))
          if (visible && document.hasFocus()) continue
          const current = next[caseTabIdValue]
          const pathSet = new Set(current?.paths ?? [])
          pathSet.add(path)
          next[caseTabIdValue] = { paths: [...pathSet], latestAt: now }
          changed = true
        }
        return changed ? next : updates
      })
    }
    window.addEventListener(REMOTE_FILE_CHANGED_EVENT, onDocumentChanged)
    return () => window.removeEventListener(REMOTE_FILE_CHANGED_EVENT, onDocumentChanged)
  }, [activeCaseTabId, activeWork, caseTabs, docTabs, termTabs])

  const openFile = (
    path: string,
    name: string,
    side: DockSide = 'left',
    caseTabIdOverride?: string
  ): string => {
    const caseTabIdValue = caseTabIdOverride ?? currentCaseTabIdForNewTab() ?? inferCaseTabIdForPath(path, caseTabs)
    const existing = docTabs.find((t) => t.path === path && caseIdForDoc(t) === caseTabIdValue)
    if (caseTabIdValue) {
      const caseTab = caseTabs.find((tab) => tab.id === caseTabIdValue)
      if (caseTab) setCurrentCase(currentCaseFromCaseTab(caseTab))
      setActiveCaseTabId(caseTabIdValue)
    }
    if (existing) {
      activateDocTab(existing.id)
      return existing.id
    }
    clearCaseDocumentUpdates(caseTabIdValue, path)
    const kind = docKindForPath(path)
    const tab: DocTab = { id: newId(), title: name, kind, caseTabId: caseTabIdValue, path, side }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
    updateCaseTabActivity(caseTabIdValue, {
      activeDocId: tab.id,
      activeWork: { ...activeWork, [side]: docKey(tab.id) }
    })
    return tab.id
  }

  const markdownRangeFromAttachmentSource = (
    source: AgentAttachment['source'] | undefined
  ): MarkdownSelectionRange | undefined => {
    const range = source?.range
    if (
      typeof range?.startLine !== 'number' ||
      typeof range.startColumn !== 'number' ||
      typeof range.endLine !== 'number' ||
      typeof range.endColumn !== 'number'
    )
      return undefined
    return {
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn
    }
  }

  const openAgentAttachmentSource = (attachment: AgentAttachment): void => {
    const source = attachment.source
    if (!source) return
    const page = source.range?.startPage
    const isPdfQuote = typeof page === 'number' && Number.isSafeInteger(page) && page > 0
    const existing =
      (source.docId ? docTabsRef.current.find((tab) =>
        tab.id === source.docId && (!isPdfQuote || !source.path || tab.path === source.path)
      ) : undefined) ??
      (source.path ? docTabsRef.current.find((tab) => tab.path === source.path) : undefined)
    let docId: string | undefined
    if (existing) {
      activateDocTab(existing.id)
      docId = existing.id
    } else if (source.path) {
      docId = openFile(source.path, source.title ?? fileNameFromPath(source.path), 'left')
    }
    if (!docId) return
    const path = source.path ?? existing?.path
    if (attachment.kind === 'media-range' && attachment.media) {
      if (attachment.media.compositionId) return // The immutable captured frame is the quoted source.
      setMediaReveals((current) => ({ ...current, [docId]: { selection: attachment.media!, nonce: ++jumpNonce.current } }))
      return
    }
    if (isPdfQuote && path) {
      setPdfJump({ docId, path, page, nonce: ++jumpNonce.current })
      return
    }
    const range = markdownRangeFromAttachmentSource(source)
    if (!range && !source.text) return
    setMarkdownRevealRequests((current) => ({
      ...current,
      [docId]: {
        nonce: ++markdownRevealSeqRef.current,
        range,
        text: source.text
      }
    }))
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
      suggestedRecords: t.suggestedRecords,
      suggestedRecordOptions: t.suggestedRecordOptions,
      name: t.title,
      meta: {
        contextKind: t.contextKind,
        projectId: t.projectId,
        jsId: t.jsId,
        court: t.court,
        caseNumber: t.caseNumber,
        caseName: t.caseName,
        client: t.client,
        opponent: t.opponent,
        partyNames: t.partyNames,
        memo: t.memo
      },
      ssh: t.ssh,
      sshLabel: t.sshLabel,
      profileId: t.profileId,
      remotePath: t.ssh ? t.cwd : undefined
    }
  }

  const resolveCaseTabId = (source: CurrentCase, tabs = caseTabsRef.current): string =>
    caseTabId(source, tabs)

  const markWorkspaceReopened = (source: CurrentCase, term?: TermTab): void => {
    const key = workspaceLocationKey(source)
    const terminals = pendingWorkspaceReopensRef.current.get(key)?.terminals ?? []
    pendingWorkspaceReopensRef.current.set(key, {
      id: newId(), terminals: term && isAgentTab(term)
        ? [...terminals.filter((item) => item.id !== term.id), term] : terminals
    })
    closedAutomaticCasesRef.current.delete(key)
    pendingCaseClosesRef.current.delete(key)
    setRetainedSharedCases((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const registerCaseTab = (
    source: CurrentCase,
    activeTermId?: string,
    id = resolveCaseTabId(source)
  ): CaseWorkspaceTab => {
    const incoming = { ...caseTabFromCurrentCase(source, activeTermId), id }
    const nextTabs = upsertCaseTab(caseTabsRef.current, incoming)
    const tab = nextTabs[0]
    caseTabsRef.current = nextTabs
    setCaseTabs((tabs) => upsertCaseTab(tabs, { ...incoming, id: tab.id }))
    setActiveCaseTabId(tab.id)
    return tab
  }

  const registerCaseTabFromTerm = (term: TermTab, reopen = false): CaseWorkspaceTab => {
    if (reopen) markWorkspaceReopened(currentCaseFromTerm(term), term)
    const tab = registerCaseTab(currentCaseFromTerm(term), term.id, term.caseTabId)
    if (term.caseTabId !== tab.id) {
      setTermTabs((tabs) => tabs.map((item) => item.id === term.id ? { ...item, caseTabId: tab.id } : item))
    }
    return tab
  }

  const caseIdForTerm = (term: TermTab): string => term.caseTabId ?? resolveCaseTabId(currentCaseFromTerm(term))
  const caseIdForDoc = (doc: DocTab): string | undefined =>
    doc.caseTabId ?? inferCaseTabIdForPath(doc.path, caseTabs)
  const currentCaseTabIdForNewTab = (source?: TermTab): string | undefined =>
    source?.caseTabId || activeCaseTabId || (currentCase ? resolveCaseTabId(currentCase) : undefined)
  const visibleInActiveCase = (caseTabIdValue?: string): boolean =>
    docOnly || termOnly || (caseTabIdValue ?? '') === activeCaseTabId
  const isSharedDocTab = (tab: DocTab): boolean => tab.kind === 'settings'
  const isDocVisibleInActiveCase = (tab: DocTab): boolean =>
    isSharedDocTab(tab) || visibleInActiveCase(caseIdForDoc(tab))
  const updateCaseTabActivity = (
    caseTabIdValue: string | undefined,
    patch: Partial<Pick<CaseWorkspaceTab, 'activeDocId' | 'activeTermId' | 'activeWork'>>
  ): void => {
    if (!caseTabIdValue) return
    setCaseTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === caseTabIdValue
          ? {
              ...tab,
              ...patch,
              activeWork: patch.activeWork ?? tab.activeWork,
              updatedAt: Date.now()
            }
          : tab
      )
    )
  }

  const openCaseContext = (source: CurrentCase, activeTermId?: string): CaseWorkspaceTab => {
    markWorkspaceReopened(source)
    const tab = registerCaseTab(source, activeTermId)
    source = currentCaseFromCaseTab(tab)
    setCurrentCase(source)
    if (activeTermId) {
      setActiveTerm(activeTermId)
    } else {
      setActiveTerm((id) => {
        const current = termTabsRef.current.find((term) => term.id === id)
        return current && caseIdForTerm(current) === tab.id ? id : ''
      })
    }
    const sessionSource = currentCaseSessionSource(source, sshProfiles)
    preloadPastSessions(sessionSource?.cwd, sessionSource)
    if (source.meta?.contextKind !== 'project') void window.lt.case.addHistory({
      drafts: source.drafts,
      records: source.records,
      name: source.name
    }).then(setRecent)
    void autoRestoreWorkspaceRef.current(source).catch(() => {})
    return tab
  }

  // 다른 창에서 찢겨/이동돼 온 탭 수신 → 문서 또는 터미널 열기.
  const receiveTabRef = useRef<(p: TabPayload) => void>(() => {})
  receiveTabRef.current = (p) => {
    if (p.kind === 'terminal') {
      const rawTab = p.tab as TermTab
      const receivedCase = currentCaseFromTerm(rawTab)
      const tab = {
        ...rawTab,
        caseTabId: resolveCaseTabId(receivedCase),
        agentProvider: rawTab.kind === 'agent' ? resolveAgentProvider(rawTab.agentProvider, rawTab.ssh) : undefined,
        side: rawTab.side ?? 'right'
      }
      setTermTabs((tabs) =>
        tabs.some((t) => t.id === tab.id)
          ? tabs.map((t) => (t.id === tab.id ? { ...t, side: termSide(tab) } : t))
          : [...tabs, tab]
      )
      setActiveTerm(tab.id)
      setCurrentCase(receivedCase)
      registerCaseTabFromTerm(tab, true)
      setWorkActive(termSide(tab), termKeyOf(tab.id))
      preloadPastSessions(tab.cwd, tab)
      if (receivedCase.meta?.contextKind !== 'project') void window.lt.case
        .addHistory({ drafts: receivedCase.drafts, records: receivedCase.records, name: receivedCase.name })
        .then(setRecent)
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
    const caseTabIdValue =
      (caseTabsRef.current.some((tab) => tab.id === payload?.caseTabId) ? payload?.caseTabId : undefined) ??
      inferCaseTabIdForPath(path, caseTabsRef.current) ??
      currentCaseTabIdForNewTab()
    const existing = path
      ? docTabs.find((t) => t.path === path && caseIdForDoc(t) === caseTabIdValue)
      : payload?.id
        ? docTabs.find((t) => t.id === payload.id)
        : undefined
    if (existing) {
      setDocTabs((tabs) => tabs.map((t) => (t.id === existing.id ? { ...t, side } : t)))
      setActiveDoc(existing.id)
      setWorkActive(side, docKey(existing.id))
      return
    }
    const id = payload?.id && !docTabs.some((t) => t.id === payload.id) ? payload.id : newId()
    const tab: DocTab = { id, title, kind, caseTabId: caseTabIdValue, path, side, mediaState: payload?.mediaState }
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
    const key = `${term.ssh ? `${term.ssh.user}@${term.ssh.host}:${term.ssh.port ?? 22}` : 'local'}:${sessionId}:${title ?? ''}:${term.caseNumber ?? ''}:${term.cwd}:${term.originDevice ?? ''}`
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
    caseMeta?: CaseMeta,
    activeTermId?: string,
    suggested?: string,
    suggestedOptions?: FolderMatchSuggestion[]
  ): void => {
    const source = {
      drafts,
      records,
      suggestedRecords: records ? undefined : suggested,
      suggestedRecordOptions: records ? undefined : suggestedOptions,
      name,
      meta: caseMeta
    }
    setCurrentCase(source)
    registerCaseTab(source, activeTermId)
    if (caseMeta?.contextKind !== 'project') window.lt.case.addHistory({ drafts, records, name }).then(setRecent)
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
    suggestedOptions?: FolderMatchSuggestion[],
    agentProviderOverride?: AgentProvider
  ): TermTab => {
    const source: CurrentCase = { drafts, records, name, meta: caseMeta }
    const caseTabIdValue = resolveCaseTabId(source)
    const tab: TermTab = {
      id: newId(),
      title: name,
      kind,
      caseTabId: caseTabIdValue,
      cwd: drafts,
      recordsFolder: records,
      suggestedRecords: suggested,
      suggestedRecordOptions: suggestedOptions,
      autoClaude: kind === 'terminal',
      agentProvider: kind === 'agent' ? resolveAgentProvider(agentProviderOverride ?? agentDefaultProvider) : undefined,
      createdAt: Date.now(),
      originDevice: 'desktop',
      side,
      ...caseMeta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    rememberLocalCase(drafts, records, name, caseMeta, tab.id, suggested, suggestedOptions)
    markWorkspaceReopened(source, tab)
    preloadPastSessions(tab.cwd, tab)
    return tab
  }

  const createCase = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right',
    suggestedOptions?: FolderMatchSuggestion[],
    agentProviderOverride?: AgentProvider
  ): TermTab =>
    createLocalCaseTab('agent', drafts, name, records, suggested, caseMeta, side, suggestedOptions, agentProviderOverride)

  const createCaseTerminal = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right',
    suggestedOptions?: FolderMatchSuggestion[]
  ): TermTab => createLocalCaseTab('terminal', drafts, name, records, suggested, caseMeta, side, suggestedOptions)

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
    openCaseContext({
      drafts: picked.path,
      name: picked.name,
      suggestedRecords: paired ?? undefined
    })
    setMode('explorer')
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
    kind: 'agent' | 'terminal' = 'agent',
    agentProviderOverride?: AgentProvider
  ): TermTab => {
    const title = name || remotePath.replace(/\/+$/, '').split('/').pop() || profile.label
    const draftsUri = remoteUri(profile.id, remotePath)
    const ssh = sshConnFromProfile(profile)
    const source: CurrentCase = {
      drafts: draftsUri,
      records,
      name: title,
      meta,
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      remotePath
    }
    const caseTabIdValue = resolveCaseTabId(source)
    const tab: TermTab = {
      id: newId(),
      title,
      kind,
      caseTabId: caseTabIdValue,
      cwd: remotePath,
      recordsFolder: records,
      autoClaude: kind === 'terminal',
      agentProvider: kind === 'agent' ? resolveAgentProvider(agentProviderOverride ?? agentDefaultProvider, ssh) : undefined,
      createdAt: Date.now(),
      originDevice: 'desktop',
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      side,
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    setCurrentCase(source)
    registerCaseTab(source, tab.id)
    preloadPastSessions(tab.cwd, tab)
    window.lt.case.addHistory({ drafts: draftsUri, records, name: title }).then(setRecent)
    markWorkspaceReopened(source, tab)
    // 소송기록이 정해졌으면 페어링 기억(다음에 자동 적용) — 로컬과 동일
    if (records) window.lt.case.setPairing(draftsUri, records)
    return tab
  }

  const openRemoteCaseContext = (
    profile: SshProfile,
    remotePath: string,
    name?: string,
    meta?: CaseMeta,
    records?: string,
    suggestions?: FolderMatchSuggestion[]
  ): { id: string; title: string; source: CurrentCase } => {
    const title = name || remotePath.replace(/\/+$/, '').split('/').pop() || profile.label
    const draftsUri = remoteUri(profile.id, remotePath)
    const source: CurrentCase = {
      drafts: draftsUri,
      records,
      suggestedRecords: records ? undefined : suggestions?.[0]?.path,
      suggestedRecordOptions: records ? undefined : suggestions,
      name: title,
      meta,
      ssh: sshConnFromProfile(profile),
      sshLabel: profile.label,
      profileId: profile.id,
      remotePath
    }
    const tab = openCaseContext(source)
    if (records) window.lt.case.setPairing(draftsUri, records)
    return { id: tab.id, title, source }
  }

  const attachRemoteRecords = (
    tabId: string,
    profile: SshProfile,
    remotePath: string,
    title: string,
    records?: string,
    suggestions?: FolderMatchSuggestion[],
    caseId?: string
  ): void => {
    if (!records && !suggestions?.length) return
    const suggestedRecords = records ? undefined : suggestions?.[0]?.path
    const suggestedRecordOptions = records ? undefined : suggestions
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              recordsFolder: records,
              suggestedRecords,
              suggestedRecordOptions
            }
          : t
      )
    )
    setCurrentCase((c) =>
      c?.profileId === profile.id && c.remotePath === remotePath
        ? {
            ...c,
            records: records ?? c.records,
            suggestedRecords,
            suggestedRecordOptions
          }
        : c
    )
    const drafts = remoteUri(profile.id, remotePath)
    setCaseTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId || (tab.profileId === profile.id && tab.remotePath === remotePath)
          ? {
              ...tab,
              records: records ?? tab.records,
              suggestedRecords,
              suggestedRecordOptions,
              updatedAt: Date.now()
            }
          : tab
      )
    )
    if (!records) return
    window.lt.case.setPairing(drafts, records)
    if (caseId) window.lt.case.setJsPairing(remoteJsPairingKey(profile.id, caseId), drafts, records)
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
      .then((r) => attachRemoteRecords(tabId, profile, remotePath, title, r.records, r.suggestions, c?.id))
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

  const relativePathForSync = (rootPath: string, filePath: string): string | undefined => {
    const rootNorm = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const fileNorm = filePath.replace(/\\/g, '/')
    if (!rootNorm) return undefined
    if (fileNorm === rootNorm) return ''
    return fileNorm.startsWith(rootNorm + '/') ? fileNorm.slice(rootNorm.length + 1) : undefined
  }

  const joinSyncPath = (basePath: string, relativePath: string): string => {
    const base = basePath.replace(/\/+$/, '')
    const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!base) return rel
    if (!rel) return base
    if (base === '/') return `/${rel}`
    return `${base}/${rel}`
  }

  const localMirrorFilePathForSync = (
    localFilePath: string,
    localFolderPath: string,
    profile: SshProfile,
    root?: string
  ): string => {
    const mirrorFolder = localMirrorPathForSync(localFolderPath, profile, root)
    if (!mirrorFolder) return ''
    const relativePath = relativePathForSync(localFolderPath, localFilePath) ?? fileNameFromPath(localFilePath)
    return joinSyncPath(mirrorFolder, relativePath)
  }

  // rclone 동기화 모달 열기 — 맥의 작성서류 폴더(원격 경로)를 추정해 프리필.
  // (클라우드 경유 모델: 맥에서 rclone 실행 → 맥 폴더 ↔ OneDrive 클라우드)
  const showSync = (init: SyncModalInit): void => {
    setSyncInit((current) => current ?? init)
    setSyncMinimized(false)
  }
  const openSync = (): void => {
    if (sshProfiles.length === 0) {
      void window.lt.dialog.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }
    const remote = parseRemoteUri(activeDraftsFolder ?? '')
    if (remote) {
      // 활성 터미널이 없어도 탐색기에 지정된 원격 경로를 그대로 사용
      const profile = syncProfileForRemote(remote.profileId)
      showSync({ profile, macFolder: remote.path })
    } else {
      // 활성 사건이 로컬 → 첫 프로필의 원격 작성서류 루트 하위 동일 폴더명으로 추정
      const localPath = activeDraftsFolder ?? ''
      const profile = sshProfiles[0]
      showSync({
        profile,
        macFolder: localMirrorPathForSync(localPath, profile, profile.draftsRoot)
      })
    }
  }

  const openFileSync = (path: string, name: string): void => {
    if (sshProfiles.length === 0) {
      void window.lt.dialog.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }

    const remote = parseRemoteUri(path)
    let profile: SshProfile
    let macFilePath = ''
    if (remote) {
      profile = syncProfileForRemote(remote.profileId)
      macFilePath = remote.path
    } else {
      profile = sshProfiles[0]
      const localRoot =
        activeDraftsFolder && !isRemotePath(activeDraftsFolder)
          ? activeDraftsFolder
          : parentLocalPath(path)
      if (localRoot) {
        macFilePath = localMirrorFilePathForSync(path, localRoot, profile, profile.draftsRoot)
      }
    }

    if (!macFilePath) {
      void window.lt.dialog.alert('이 파일의 동기화 대상 경로를 계산하지 못했습니다.')
      return
    }
    if (!looksLikeOneDrivePath(macFilePath)) {
      void window.lt.dialog.alert('OneDrive 경로에 있는 파일만 rclone으로 동기화할 수 있습니다.')
      return
    }

    showSync({
      profile,
      macFolder: macFilePath,
      folderLabel: name || '파일',
      initialMode: 'file',
      lockMode: true
    })
  }

  // 소송기록 폴더는 기록뷰어에서 클라우드 → 맥/로컬 최신화만 제공한다.
  const openRecordsSync = (): void => {
    if (sshProfiles.length === 0) {
      void window.lt.dialog.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }
    if (!activeRecordsFolder) {
      void window.lt.dialog.alert('먼저 소송기록 폴더를 지정하세요.')
      return
    }
    const remote = parseRemoteUri(activeRecordsFolder)
    if (remote) {
      showSync({
        profile: syncProfileForRemote(remote.profileId),
        macFolder: remote.path,
        folderLabel: '소송기록 폴더',
        directions: 'pull-only'
      })
      return
    }
    const profile = sshProfiles[0]
    showSync({
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
      openCaseContext({ drafts: entry.drafts, records: entry.records, name: entry.name })
      setMode('explorer')
      return
    }
    const s = await window.lt.settings.get()
    const profiles = s.sshProfiles ?? []
    setSshProfiles(profiles)
    const profile = profiles.find((p) => p.id === remote.profileId)
    if (!profile) {
      await window.lt.dialog.alert('이 최근 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      return
    }
    openRemoteCaseContext(profile, remote.path, entry.name, undefined, entry.records)
    setMode('explorer')
  }

  // 과거 claude 세션 이어서 열기 (claude --resume). 지정한 cwd/사건 컨텍스트에서.
  const openPastSession = (
    sessionId: string,
    cwd: string,
    title?: string,
    source?: TermTab,
    side: DockSide = termSide(source),
    fallbackCase?: OpenedCase, // 대시보드에서 방금 연 사건 — currentCase state가 아직 갱신 전일 수 있다
    forceNew = false,
    originDevice?: TermTab['originDevice']
  ): void => {
    const matchesCwd = (c?: CurrentCase | null): boolean =>
      !!c && (c.drafts === cwd || c.remotePath === cwd)
    const base = source
      ? currentCaseFromTerm({ ...source, cwd })
      : matchesCwd(fallbackCase)
        ? fallbackCase
        : matchesCwd(currentCase)
          ? currentCase
          : undefined
    const meta = base?.meta
    const ssh = source?.ssh ?? base?.ssh
    const sshLabel = source?.sshLabel ?? base?.sshLabel
    const profileId = source?.profileId ?? base?.profileId
    const existing = !forceNew
      ? termTabs.find(
          (t) =>
            isAgentTab(t) &&
            t.resumeSessionId === sessionId &&
            t.cwd === cwd &&
            t.profileId === profileId &&
            resolveAgentContextKind(t) === resolveAgentContextKind(meta ?? {}) &&
            t.jsId === meta?.jsId && t.caseNumber === meta?.caseNumber && t.caseName === meta?.caseName
        )
      : undefined
    if (existing) {
      if (!existing.originDevice && originDevice) {
        setTermTabs((tabs) => tabs.map((tab) => tab.id === existing.id ? { ...tab, originDevice } : tab))
      }
      selectTerm(existing.id)
      return
    }
    const tab: TermTab = {
      id: newId(),
      title: title ? title : base?.name ?? cwd.split(/[\\/]/).pop() ?? '세션',
      kind: 'agent',
      caseTabId: source?.caseTabId ?? (base ? resolveCaseTabId(base) : currentCaseTabIdForNewTab(source)),
      cwd,
      recordsFolder: base?.records ?? source?.recordsFolder,
      autoClaude: false,
      agentProvider: 'claude',
      createdAt: Date.now(),
      resumeSessionId: sessionId,
      originDevice,
      renamed: !!title, // 과거 세션 제목을 그대로 쓰면 자동 갱신 안 함
      todoManagement: source?.todoManagement,
      contextKind: source?.contextKind ?? base?.meta?.contextKind,
      projectId: source?.projectId ?? base?.meta?.projectId,
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
    registerCaseTabFromTerm(tab, true)
    preloadPastSessions(tab.cwd, tab)
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
    const terminalAutoAgent = isAgentTab(cur)
      ? options?.reuseAgentTab
        ? resolveAgentProvider(cur.agentProvider, cur.ssh)
        : undefined
      : cur.autoAgent
    const terminalAutoClaude = terminalAutoAgent ? terminalAutoAgent === 'claude' : !isAgentTab(cur)
    if (options?.reuseAgentTab && isAgentTab(cur)) {
      void window.lt.agent.close(cur.id)
      setAgentAttachmentRequests((requests) => {
        if (!requests[cur.id]) return requests
        const next = { ...requests }
        delete next[cur.id]
        return next
      })
      setAgentDrafts((drafts) => {
        if (!drafts[cur.id]) return drafts
        const next = { ...drafts }
        delete next[cur.id]
        return next
      })
      setAgentDraftClearNonce((nonces) => {
        if (!(cur.id in nonces)) return nonces
        const next = { ...nonces }
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
                autoClaude: terminalAutoClaude,
                autoAgent: terminalAutoAgent,
                agentProvider: undefined,
                createdAt: Date.now(),
                sessionTitle: undefined,
                side
              }
            : t
        )
      )
      setActiveTerm(cur.id)
      setWorkActive(side, termKeyOf(cur.id))
      registerCaseTabFromTerm({ ...cur, kind: 'terminal', autoClaude: terminalAutoClaude, autoAgent: terminalAutoAgent, side })
      return
    }
    const tab: TermTab = {
      id: newId(),
      title: cur.title,
      caseTabId: cur.caseTabId,
      cwd: cur.cwd,
      recordsFolder: cur.recordsFolder,
      suggestedRecords: cur.suggestedRecords,
      suggestedRecordOptions: cur.suggestedRecordOptions,
      autoClaude: terminalAutoClaude,
      autoAgent: terminalAutoAgent,
      createdAt: Date.now(),
      originDevice: 'desktop',
      todoManagement: cur.todoManagement,
      contextKind: cur.contextKind,
      projectId: cur.projectId,
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
    registerCaseTabFromTerm(tab, true)
  }

  const addAgentSame = (
    preferredSide?: DockSide,
    sourceTermId = activeTerm,
    options?: { provider?: AgentProvider }
  ): TermTab | undefined => {
    const cur = termTabs.find((t) => t.id === sourceTermId)
    const side = preferredSide ?? termSide(cur)
    const agentProviderOverride = options?.provider
    const ssh = cur?.ssh ?? currentCase?.ssh
    const cwd = cur?.cwd ?? (ssh ? currentCase?.remotePath : currentCase?.drafts)
    if (!cwd) {
      void (async () => {
        const picked = await window.lt.dialog.openCase()
        if (!picked) return
        createCase(picked.path, picked.name, undefined, undefined, undefined, side, undefined, agentProviderOverride)
      })()
      return undefined
    }
    const title = cur?.title ?? currentCase?.name ?? cwd.split(/[\\/]/).pop() ?? '세션'
    const tab: TermTab = {
      id: newId(),
      title,
      kind: 'agent',
      caseTabId: cur?.caseTabId ?? currentCaseTabIdForNewTab(cur),
      cwd,
      recordsFolder: cur?.recordsFolder ?? currentCase?.records,
      autoClaude: false,
      agentProvider: resolveAgentProvider(agentProviderOverride ?? cur?.agentProvider ?? agentDefaultProvider, ssh),
      createdAt: Date.now(),
      originDevice: 'desktop',
      todoManagement: cur?.todoManagement,
      contextKind: cur?.contextKind ?? currentCase?.meta?.contextKind,
      projectId: cur?.projectId ?? currentCase?.meta?.projectId,
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
    const shouldMoveDraft =
      isAgentTab(cur) &&
      (!agentProviderOverride || resolveAgentProvider(cur.agentProvider, cur.ssh) === agentProviderOverride)
    moveAgentDraft(shouldMoveDraft ? cur.id : undefined, tab.id)
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    registerCaseTabFromTerm(tab, true)
    return tab
  }

  const changeAgentProvider = (
    termId: string,
    provider: AgentProvider,
    handoff?: AgentProviderHandoff
  ): void => {
    const current = termTabsRef.current.find((term) => term.id === termId)
    if (!current || !isAgentTab(current)) return
    const nextProvider = resolveAgentProvider(provider, current.ssh)
    if (current.agentProvider === nextProvider) return

    // 대화가 이미 있는 탭이면 세션을 버리지 않고 같은 독의 새 탭에서 연다.
    // 맥락은 패널 타임라인에서 추출한 transcript를 첫 지시에 합쳐 전달한다.
    // (세션 파일을 읽지 않으므로 Claude↔Codex 양방향·원격에서도 즉시 동작)
    if (handoff && handoff.count > 0) {
      openForkedAgentTab(current, {
        cwd: current.cwd,
        title: `${current.title} · ${nextProvider === 'codex' ? 'Codex' : 'Claude'}`,
        side: termSide(current),
        ssh: current.ssh,
        sshLabel: current.sshLabel,
        profileId: current.profileId,
        provider: nextProvider,
        handoffContext: handoff
      })
      return
    }

    void window.lt.agent.close(termId)
    setTermTabs((tabs) =>
      tabs.map((term) =>
        term.id === termId
          ? {
              ...term,
              agentProvider: nextProvider,
              resumeSessionId: undefined,
              forkFromSessionId: undefined,
              handoffContext: undefined,
              sessionTitle: undefined,
              createdAt: Date.now()
            }
          : term
      )
    )
  }

  const consumeAgentHandoff = (termId: string): void => {
    setTermTabs((tabs) =>
      tabs.map((term) => (term.id === termId ? { ...term, handoffContext: undefined } : term))
    )
  }

  const openForkedAgentTab = (
    source: TermTab,
    opts: {
      cwd: string
      title: string
      side: DockSide
      forkFromSessionId?: string
      ssh?: SshConn
      sshLabel?: string
      profileId?: string
      provider?: AgentProvider
      handoffContext?: AgentProviderHandoff
    }
  ): void => {
    const tab: TermTab = {
      ...source,
      id: newId(),
      title: opts.title,
      kind: 'agent',
      cwd: opts.cwd,
      autoClaude: false,
      agentProvider: resolveAgentProvider(opts.provider ?? source.agentProvider, opts.ssh),
      createdAt: Date.now(),
      originDevice: 'desktop',
      resumeSessionId: undefined,
      forkFromSessionId: opts.forkFromSessionId,
      handoffContext: opts.handoffContext,
      sessionTitle: undefined,
      renamed: true,
      ssh: opts.ssh,
      sshLabel: opts.sshLabel,
      profileId: opts.profileId,
      side: opts.side
    }
    setTermTabs((tabs) => [...tabs, tab])
    moveAgentDraft(source.id, tab.id)
    setActiveTerm(tab.id)
    setWorkActive(opts.side, termKeyOf(tab.id))
    registerCaseTabFromTerm(tab, true)
    preloadPastSessions(tab.cwd, tab)
  }

  const resolveForkSourceSessionId = async (source: TermTab): Promise<string | undefined> => {
    const agentSnapshot = await window.lt.agent.snapshot(source.id).catch(() => null)
    const snapshotSessionId =
      agentSnapshot?.ok && agentSnapshot.session?.resumeSessionId
        ? agentSnapshot.session.resumeSessionId
        : undefined
    const current = snapshotSessionId
      ? null
      : await window.lt.sessions
          .current(source.cwd, (source.createdAt ?? 0) - 3000, source.ssh)
          .catch(() => null)
    const sessionId = snapshotSessionId ?? current?.sessionId
    if (!sessionId) return undefined
    const title = agentSnapshot?.ok ? agentSnapshot.session?.title : current?.title
    rememberSessionForTerm(source, sessionId, title)
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === source.id
          ? {
              ...t,
              resumeSessionId: sessionId,
              sessionTitle: t.renamed ? t.sessionTitle : title ?? t.sessionTitle
            }
          : t
      )
    )
    return sessionId
  }

  const forkAgentTab = async (sourceTermId: string, preferredSide?: DockSide): Promise<void> => {
    const source = termTabsRef.current.find((t) => t.id === sourceTermId)
    if (!source || !isAgentTab(source)) return
    const side = preferredSide ?? termSide(source)
    const forkFromSessionId = await resolveForkSourceSessionId(source)
    openForkedAgentTab(source, {
      cwd: source.cwd,
      title: `${source.title} · fork`,
      side,
      forkFromSessionId,
      ssh: source.ssh,
      sshLabel: source.sshLabel,
      profileId: source.profileId
    })
  }

  const forkAgentWorktreeTab = async (
    sourceTermId: string,
    preferredSide?: DockSide
  ): Promise<void> => {
    const source = termTabsRef.current.find((t) => t.id === sourceTermId)
    if (!source || !isAgentTab(source)) return
    if (source.ssh) {
      await window.lt.dialog.alert('원격 Agent 탭은 아직 worktree fork를 지원하지 않습니다.')
      return
    }
    const side = preferredSide ?? termSide(source)
    const [forkFromSessionId, result] = await Promise.all([
      resolveForkSourceSessionId(source),
      window.lt.agent.worktreeFork({ cwd: source.cwd })
    ])
    if (!result.ok || !result.path) {
      await window.lt.dialog.alert(result.error || 'Git worktree 생성에 실패했습니다.')
      return
    }
    openForkedAgentTab(source, {
      cwd: result.path,
      title: `${source.title} · worktree`,
      side,
      forkFromSessionId
    })
  }

  const agentTabContextMenuItems = (termId: string, side: DockSide): TabBarAction[] => {
    const tab = termTabsRef.current.find((t) => t.id === termId)
    if (!tab || !isAgentTab(tab)) return []
    return [
      {
        label: 'Fork',
        title: '현재 대화 맥락을 새 Agent 세션으로 fork',
        onClick: () => void forkAgentTab(termId, side)
      },
      {
        label: 'Worktree Fork',
        title: tab.ssh
          ? '원격 Agent 탭은 아직 worktree fork를 지원하지 않습니다'
          : 'Git worktree를 만들고 새 Agent 탭에서 열기',
        onClick: () => void forkAgentWorktreeTab(termId, side)
      }
    ]
  }

  // 추천 소송기록 폴더 적용 ('열기' 클릭 시)
  const applySuggested = (path?: string): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const rec = path ?? cur?.suggestedRecords ?? currentCase?.suggestedRecords
    if (!rec) return
    const source = cur ? currentCaseFromTerm(cur) : currentCase
    if (!source) return
    const nextSource: CurrentCase = {
      ...source,
      records: rec,
      suggestedRecords: undefined,
      suggestedRecordOptions: undefined
    }
    const targetCaseTabId = cur ? caseIdForTerm(cur) : resolveCaseTabId(source)
    setTermTabs((tabs) =>
      tabs.map((t) =>
        caseIdForTerm(t) === targetCaseTabId
          ? {
              ...t,
              recordsFolder: rec,
              suggestedRecords: undefined,
              suggestedRecordOptions: undefined
            }
          : t
      )
    )
    setCurrentCase(nextSource)
    setCaseTabs((tabs) => upsertCaseTab(tabs, { ...caseTabFromCurrentCase(nextSource, cur?.id), id: targetCaseTabId }))
    const drafts = cur ? historyDraftsForTerm(cur) : nextSource.drafts
    window.lt.case.setPairing(drafts, rec)
    saveJsPairing(nextSource, drafts, rec)
    window.lt.case.addHistory({ drafts, records: rec, name: nextSource.name }).then(setRecent)
  }

  const removeTermTab = (id: string): void => {
    const tab = termTabs.find((t) => t.id === id)
    const side = termSide(tab)
    const closingKey = termKeyOf(id)
    const sideKeys = workKeysForSide(visibleDocTabs, visibleTermTabs, side)
    const nextKey =
      tab && resolveActiveWorkKey(sideKeys, activeWork[side]) === closingKey
        ? nextWorkKeyAfterClose(sideKeys, closingKey)
        : undefined
    setTermTabs((tabs) => closeTab(tabs, id, activeTerm, setActiveTerm, visibleTermTabs))
    setTermBracketedPasteMode((m) => {
      if (!(id in m)) return m
      const n = { ...m }
      delete n[id]
      return n
    })
    setAgentDrafts((drafts) => {
      if (!drafts[id]) return drafts
      const next = { ...drafts }
      delete next[id]
      return next
    })
    setAgentDraftClearNonce((nonces) => {
      if (!(id in nonces)) return nonces
      const next = { ...nonces }
      delete next[id]
      return next
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
    if (nextKey !== undefined) activateWorkKeyAfterClose(side, nextKey)
  }
  const closeTerm = (id: string): boolean => {
    const tab = termTabs.find((t) => t.id === id)
    if (!tab) return false
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
  const selectTerm = (id: string, reopen = true): void => {
    const tab = termTabs.find((t) => t.id === id)
    activateTermTab(id)
    if (tab) {
      const nextCase = currentCaseFromTerm(tab)
      setCurrentCase(nextCase)
      registerCaseTabFromTerm(tab, reopen)
      updateCaseTabActivity(caseIdForTerm(tab), {
        activeTermId: tab.id,
        activeWork: { ...activeWork, [termSide(tab)]: termKeyOf(tab.id) }
      })
    }
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
    dismissToastForTerm(id)
    window.lt.app.dismissNotify(id)
  }

  const activeWorkKeyForSide = (side: DockSide): WorkTabKey | '' =>
    resolveActiveWorkKey(workKeysForSide(visibleDocTabs, visibleTermTabs, side), activeWork[side])

  const isTermVisibleInCurrentWorkspace = (id: string): boolean => {
    if (termOnly) return id === activeTerm
    return (['left', 'right'] as DockSide[]).some((side) => {
      const parsed = parseWorkKey(activeWorkKeyForSide(side))
      return parsed?.kind === 'terminal' && parsed.id === id
    })
  }

  // 터미널 작업 상태(진행중/완료/질문대기).
  // 컨벤션: 보고 있는 작업(탭 표시 + 창 포커스)은 조용히 넘어가고, 그 외에는 알린다.
  // 창 포커스 중 → 앱 내 알림음 + 토스트. 비포커스 → OS 네이티브 알림(소리·집중 모드는 OS가 결정) + 독 주목.
  const onTermStatus = (id: string, status: TermRunStatus): void => {
    const previousStatus = termStatusRef.current.get(id)
    // 같은 렌더 사이에 done → idle이 도착해도 최신 완료 상태를 유지한다.
    const nextStatus = status === 'idle' && previousStatus === 'done' ? 'done' : status
    termStatusRef.current = new Map(termStatusRef.current).set(id, nextStatus)
    setTermStatus((m) => {
      if (m.get(id) === nextStatus) return m
      const n = new Map(m)
      n.set(id, nextStatus)
      return n
    })
    const clearNotices = (): void => {
      setTermAttention((s) => {
        if (!s.has(id)) return s
        const n = new Set(s)
        n.delete(id)
        return n
      })
      dismissToastForTerm(id)
      window.lt.app.dismissNotify(id)
    }
    if (status === 'idle') {
      if (nextStatus !== 'done') clearNotices()
      return
    }
    if (status === 'working') {
      clearNotices()
      return
    }
    if (isTermVisibleInCurrentWorkspace(id) && document.hasFocus()) {
      clearNotices()
      return
    }
    setTermAttention((s) => new Set(s).add(id))
    if (status === 'done' && !notifyDone) {
      dismissToastForTerm(id)
      return
    }
    pushToast(id, status)
    if (document.hasFocus()) {
      playNotificationSound(notificationSound, notificationVolume)
      return
    }
    window.lt.app.requestAttention(status)
    const term = termTabs.find((t) => t.id === id)
    window.lt.app.notify({
      termId: id,
      title: term?.title ?? '세션',
      body: status === 'question' ? '확인/입력을 기다립니다' : '작업이 완료되었습니다',
      urgency: status
    })
  }
  const onTermBracketedPasteMode = (id: string, enabled: boolean): void => {
    setTermBracketedPasteMode((m) => (m[id] === enabled ? m : { ...m, [id]: enabled }))
  }

  // 질문/완료 팝업(토스트). 질문 대기는 사용자 행동이 필요하므로 처리할 때까지 유지, 완료만 자동 소멸.
  const toastSeq = useRef(0)
  const pushToast = (termId: string, status: 'done' | 'question'): void => {
    const t = termTabs.find((x) => x.id === termId)
    const key = ++toastSeq.current
    setToasts((ts) => [
      ...ts.filter((x) => x.termId !== termId),
      { key, termId, title: t?.title ?? '세션', status }
    ])
    if (status === 'done') {
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 12000)
    }
  }
  const dismissToastForTerm = (termId: string): void =>
    setToasts((ts) => ts.filter((x) => x.termId !== termId))
  const dismissToast = (key: number): void => setToasts((ts) => ts.filter((x) => x.key !== key))

  // Ctrl+Tab: 같은 종류 탭 순환 (터미널끼리 / 문서끼리)
  const cycleTerm = (dir: number, sourceTermId = activeTerm): void => {
    const cur = termTabs.find((t) => t.id === sourceTermId)
    const side = termSide(cur)
    const scoped = visibleTermTabs.filter((t) => termSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === sourceTermId)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    selectTerm(scoped[ni].id)
  }
  const cycleDoc = (dir: number): void => {
    const cur = docTabs.find((t) => t.id === activeDoc)
    const side = docSide(cur)
    const scoped = visibleDocTabs.filter((t) => docSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === activeDoc)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    activateDocTab(scoped[ni].id)
  }
  const activateWorkTab = (side: DockSide, key: WorkTabKey): void => {
    const parsed = parseWorkKey(key)
    if (parsed?.kind === 'doc') {
      activateDocTab(parsed.id)
      focusWorkTargetSoon(side, key, true)
      return
    }
    if (parsed?.kind === 'terminal') {
      const tab = termTabs.find((t) => t.id === parsed.id)
      selectTerm(parsed.id)
      if (isAgentTab(tab)) focusWorkTargetSoon(side, key, true)
      else {
        setTermFocusNonce((current) => ({
          ...current,
          [parsed.id]: (current[parsed.id] ?? 0) + 1
        }))
      }
    }
  }
  const cycleWorkTab = (dir: number, side?: DockSide, sourceKey?: WorkTabKey): void => {
    const fallbackSide =
      side ??
      (sourceKey
        ? (() => {
            const parsed = parseWorkKey(sourceKey)
            if (parsed?.kind === 'doc') return docSide(visibleDocTabs.find((t) => t.id === parsed.id))
            if (parsed?.kind === 'terminal') return termSide(visibleTermTabs.find((t) => t.id === parsed.id))
            return undefined
          })()
        : undefined) ??
      docSide(visibleDocTabs.find((t) => t.id === activeDoc))
    const scoped = workKeysForSide(visibleDocTabs, visibleTermTabs, fallbackSide)
    if (scoped.length < 2) return
    const activeKey =
      sourceKey && scoped.includes(sourceKey)
        ? sourceKey
        : resolveActiveWorkKey(scoped, activeWork[fallbackSide])
    const i = scoped.findIndex((key) => key === activeKey)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    activateWorkTab(fallbackSide, scoped[ni])
  }

  const saveJsPairing = (
    source: CurrentCase | undefined,
    drafts: string,
    records?: string
  ): void => {
    const jsId = source?.meta?.jsId
    if (!jsId) return
    const key = source?.profileId ? remoteJsPairingKey(source.profileId, jsId) : jsId
    void window.lt.case.setJsPairing(key, drafts, records)
  }

  const applyDraftsFolder = (
    target: { term?: TermTab; termId?: string; source?: CurrentCase } | undefined,
    next: {
      drafts: string
      cwd: string
      name: string
      ssh?: SshConn
      sshLabel?: string
      profileId?: string
      remotePath?: string
    }
  ): void => {
    const cur =
      target?.term ??
      (target?.termId ? termTabs.find((t) => t.id === target.termId) : undefined) ??
      termTabs.find((t) => t.id === activeTerm)
    const source = target?.source ?? (cur ? currentCaseFromTerm(cur) : currentCase ?? undefined)
    const caseTabIdValue = cur?.caseTabId ?? activeCaseTabId ?? (source ? resolveCaseTabId(source) : undefined)
    const records = cur?.recordsFolder ?? source?.records
    const name = source?.meta?.jsId ? source.name : next.name
    const nextSource: CurrentCase = {
      drafts: next.drafts,
      records,
      name,
      meta: source?.meta,
      ssh: next.ssh,
      sshLabel: next.sshLabel,
      profileId: next.profileId,
      remotePath: next.remotePath
    }

    setTermTabs((tabs) =>
      tabs.map((t) =>
        caseTabIdValue && caseIdForTerm(t) === caseTabIdValue
          ? {
              ...t,
              title: t.id === cur?.id ? name : t.title,
              cwd: next.cwd,
              recordsFolder: records,
              suggestedRecords: undefined,
              suggestedRecordOptions: undefined,
              ssh: next.ssh,
              sshLabel: next.sshLabel,
              profileId: next.profileId
            }
          : t
      )
    )
    setCurrentCase(nextSource)
    setCaseTabs((tabs) =>
      upsertCaseTab(tabs, {
        ...caseTabFromCurrentCase(nextSource, cur?.id),
        id: caseTabIdValue ?? resolveCaseTabId(nextSource)
      })
    )
    setActiveCaseTabId(caseTabIdValue ?? resolveCaseTabId(nextSource))
    void window.lt.case.addHistory({ drafts: next.drafts, records, name }).then(setRecent)
    if (records) void window.lt.case.setPairing(next.drafts, records)
    saveJsPairing(nextSource, next.drafts, records)
    setTreeRefresh((n) => n + 1)
    setMode('explorer')
  }

  const pickDrafts = async (): Promise<void> => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const source = cur ? currentCaseFromTerm(cur) : currentCase ?? undefined
    if (!source) return
    const remoteCtx =
      cur?.ssh && cur.profileId
        ? { profileId: cur.profileId, path: cur.cwd, termId: cur.id, source: currentCaseFromTerm(cur) }
        : source.ssh && source.profileId && source.remotePath
          ? { profileId: source.profileId, path: source.remotePath, source }
          : null
    if (remoteCtx) {
      let prof = sshProfiles.find((p) => p.id === remoteCtx.profileId)
      if (!prof) {
        const s = await window.lt.settings.get()
        setSshProfiles(s.sshProfiles ?? [])
        prof = s.sshProfiles?.find((p) => p.id === remoteCtx.profileId)
      }
      if (!prof) {
        await window.lt.dialog.alert('이 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
        return
      }
      setDraftsPick({
        profile: prof,
        startPath: remoteCtx.path || prof.draftsRoot || '~',
        termId: remoteCtx.termId,
        source: remoteCtx.source
      })
      return
    }
    const picked = await window.lt.dialog.pickFolder({
      title: '작성서류 폴더 선택',
      defaultPath: source.drafts || draftsRoot
    })
    if (!picked) return
    applyDraftsFolder(
      { term: cur, source },
      { drafts: picked.path, cwd: picked.path, name: picked.name || pathLeaf(picked.path) || '사건' }
    )
  }

  // 활성 사건(또는 지정한 사건)에 소송기록 폴더를 지정/탐색 → 뷰어 연결 + 페어링 기억.
  // 터미널이 닫혀 있어도 사건 컨텍스트에 적용된다.
  const pickRecords = async (target?: { term?: TermTab; termId?: string; source?: CurrentCase }): Promise<void> => {
    let cur: TermTab | undefined
    if (target?.term) cur = target.term
    else if (target?.termId) cur = termTabs.find((t) => t.id === target.termId)
    else if (!target?.source) cur = termTabs.find((t) => t.id === activeTerm)
    const source = target?.source ?? (cur ? currentCaseFromTerm(cur) : currentCase ?? undefined)
    const remoteCtx =
      cur?.ssh && cur.profileId
        ? {
            profileId: cur.profileId,
            draftsPath: cur.cwd,
            title: cur.title,
            records: cur.recordsFolder,
            source: currentCaseFromTerm(cur),
            termId: cur.id
          }
        : source?.ssh && source.profileId && source.remotePath
          ? {
              profileId: source.profileId,
              draftsPath: source.remotePath,
              title: source.name,
              records: source.records,
              source,
              termId: target?.termId
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
          startPath: currentRecords || prof.recordsRoot || '~',
          termId: remoteCtx.termId,
          source: remoteCtx.source
        })
      } else {
        await window.lt.dialog.alert('이 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      }
      return
    }
    const draftsForPair = cur ? historyDraftsForTerm(cur) : source?.drafts
    const r = await window.lt.dialog.pickFolder({
      title: '소송기록 폴더 선택',
      defaultPath: recordsRoot ?? source?.records
    })
    if (!r) return
    if (cur) {
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === cur.id
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
    const nextSource = source ? { ...source, records: r.path } : undefined
    // 터미널 유무와 무관하게 사건 컨텍스트에도 반영(뷰어가 이걸 참조)
    setCurrentCase((c) => nextSource ?? (c ? { ...c, records: r.path } : c))
    if (cur) registerCaseTabFromTerm({ ...cur, recordsFolder: r.path })
    else if (nextSource) registerCaseTab(nextSource)
    if (draftsForPair) {
      window.lt.case.setPairing(draftsForPair, r.path)
      saveJsPairing(
        nextSource ?? (cur ? currentCaseFromTerm({ ...cur, recordsFolder: r.path }) : undefined),
        draftsForPair,
        r.path
      )
      window.lt.case
        .addHistory({ drafts: draftsForPair, records: r.path, name: cur?.title ?? source?.name ?? '사건' })
        .then(setRecent)
    }
    setMode('viewer')
  }

  const onOutline = (path: string, parsed: ParsedRecord): void => setPdfRecord({ path, parsed })
  const jumpToPage = (page: number): void => {
    const doc = docTabsRef.current.find((tab) => tab.id === activeDoc)
    if (!doc?.path) return
    jumpNonce.current += 1
    setPdfJump({ docId: doc.id, path: doc.path, page, nonce: jumpNonce.current })
  }

  // 마지막으로 연 사건 컨텍스트 — 터미널을 모두 닫아도 유지(탐색기·뷰어·새 터미널 기준)
  const [currentCase, setCurrentCase] = useState<CurrentCase | null>(null)

  // 사건 지정 해제 — 마지막 사건 컨텍스트를 비워 '+'·'이 사건에서 열기'가 더는 그 사건을 열지 않게.
  // (탐색기·뷰어 패널도 활성 터미널이 없으면 비워진다)
  const clearCase = (): void => {
    setCurrentCase(null)
    setActiveCaseTabId('')
    setFolderRecord(null)
    setPdfRecord(null)
  }

  const visibleDocTabs = docTabs.filter(isDocVisibleInActiveCase)
  const visibleTermTabs = termTabs.filter((term) => visibleInActiveCase(caseIdForTerm(term)))
  const activeTermIds = new Set<string>(activeTerm ? [activeTerm] : [])
  for (const key of Object.values(activeWork)) {
    const parsed = parseWorkKey(key)
    if (parsed?.kind === 'terminal') activeTermIds.add(parsed.id)
  }
  const activeTermIdsKey = [...activeTermIds].sort().join('|')
  const termIdsKeyForMount = termTabs.map((term) => term.id).join('|')
  useEffect(() => {
    const liveIds = new Set(termTabs.map((term) => term.id))
    setMountedTermIds((ids) => {
      let changed = false
      const next = new Set<string>()
      for (const id of ids) {
        if (liveIds.has(id)) next.add(id)
        else changed = true
      }
      for (const id of activeTermIds) {
        if (!liveIds.has(id) || next.has(id)) continue
        next.add(id)
        changed = true
      }
      return changed ? next : ids
    })
  }, [activeTermIdsKey, termIdsKeyForMount]) // eslint-disable-line react-hooks/exhaustive-deps
  const shouldMountTermPane = (term: TermTab): boolean =>
    mountedTermIds.has(term.id) || activeTermIds.has(term.id)
  const activeDocTab = visibleDocTabs.find((t) => t.id === activeDoc)
  const activeTermTab = visibleTermTabs.find((t) => t.id === activeTerm)
  // 활성 터미널이 있으면 그 사건, 없으면(터미널 다 닫힘) 마지막 사건 컨텍스트 유지
  // 원격 탭의 작성서류 폴더는 ssh:// URI로 변환(패널·탐색기용). 터미널은 plain cwd를 그대로 씀.
  const activeDraftsFolder =
    activeTermTab && activeTermTab.ssh && activeTermTab.profileId
      ? remoteUri(activeTermTab.profileId, activeTermTab.cwd)
      : (activeTermTab?.cwd ?? currentCase?.drafts)
  const activeRecordsFolder = activeTermTab?.recordsFolder ?? currentCase?.records
  const activeSuggestedRecords = activeTermTab?.suggestedRecords ?? currentCase?.suggestedRecords
  const activeSuggestedRecordOptions = activeTermTab?.suggestedRecordOptions ?? currentCase?.suggestedRecordOptions
  const sameCaseFolder = (left?: string, right?: string): boolean => {
    if (!left || !right) return false
    const clean = (value: string): string => value.replace(/[\\/]+$/, '')
    return clean(left) === clean(right)
  }
  const openFolderInNewWorkspace = async (folderPath: string, folderName: string): Promise<void> => {
    const title = folderName || pathLeaf(folderPath) || '사건'
    const keepRecords = sameCaseFolder(folderPath, activeDraftsFolder) ? activeRecordsFolder : undefined
    const remote = parseRemoteUri(folderPath)

    if (remote) {
      const profile = sshProfiles.find((p) => p.id === remote.profileId)
      if (!profile) {
        await window.lt.dialog.alert('원격 접속 프로필을 찾을 수 없어 새 작업환경을 열 수 없습니다.')
        return
      }
      const resolved: { records?: string; suggestions?: FolderMatchSuggestion[] } = keepRecords
        ? { records: keepRecords }
        : await resolveRemoteRecords(profile, remote.path).catch(() => ({}))
      openRemoteCaseContext(profile, remote.path, title, undefined, resolved.records, resolved.suggestions)
      return
    }

    const paired = keepRecords ? undefined : await window.lt.case.getPairing(folderPath).catch(() => undefined)
    openCaseContext({
      drafts: folderPath,
      records: keepRecords,
      suggestedRecords: keepRecords ? undefined : paired,
      name: title
    })
  }

  const goParentDraftsFolder = (): void => {
    const current = activeDraftsFolder
    const cur = termTabs.find((t) => t.id === activeTerm)
    const source = cur ? currentCaseFromTerm(cur) : currentCase ?? undefined
    if (!current || !source) return

    const remote = parseRemoteUri(current)
    if (remote) {
      const parent = parentRemotePath(remote.path)
      if (parent === remote.path) return
      const profile = sshProfiles.find((p) => p.id === remote.profileId)
      applyDraftsFolder(
        { term: cur, source },
        {
          drafts: remoteUri(remote.profileId, parent),
          cwd: parent,
          name: pathLeaf(parent) || source.name,
          ssh: profile ? sshConnFromProfile(profile) : source.ssh,
          sshLabel: profile?.label ?? source.sshLabel,
          profileId: remote.profileId,
          remotePath: parent
        }
      )
      return
    }

    const parent = parentLocalPath(current)
    if (!parent || parent === current) return
    applyDraftsFolder(
      { term: cur, source },
      { drafts: parent, cwd: parent, name: pathLeaf(parent) || source.name }
    )
  }

  const defaultCaseOpenProfileId = caseOpenProfileId(
    resolveCaseOpenTarget(caseOpenTarget, sshProfiles)
  )
  const isViewer = mode === 'viewer'
  const sessionCaseSource = currentCaseSessionSource(currentCase, sshProfiles)

  const handleAgentDraftChange = (termId: string, draft: AgentDraftState): void => {
    setAgentDrafts((current) => {
      if (!hasAgentDraft(draft)) {
        if (!current[termId]) return current
        const next = { ...current }
        delete next[termId]
        return next
      }
      if (sameAgentDraft(current[termId], draft)) return current
      return { ...current, [termId]: draft }
    })
  }

  const moveAgentDraft = (fromId: string | undefined, toId: string): void => {
    if (!fromId || fromId === toId) return
    const draft = agentDraftsRef.current[fromId]
    const pendingRequests = agentAttachmentRequestsRef.current[fromId] ?? []
    if (!hasAgentDraft(draft) && pendingRequests.length === 0) return
    if (hasAgentDraft(draft)) {
      setAgentDrafts((current) => {
        const next = { ...current, [toId]: { input: draft.input, attachments: [...draft.attachments] } }
        delete next[fromId]
        return next
      })
    }
    if (pendingRequests.length > 0) {
      setAgentAttachmentRequests((current) => {
        const draftKeys = hasAgentDraft(draft) ? new Set(draft.attachments.map(agentAttachmentKey)) : undefined
        const moving = (current[fromId] ?? pendingRequests).filter(
          (request) => !draftKeys?.has(agentAttachmentKey(request.attachment))
        )
        if (moving.length === 0) {
          const next = { ...current }
          delete next[fromId]
          return next
        }
        const next = { ...current, [toId]: [...(current[toId] ?? []), ...moving] }
        delete next[fromId]
        return next
      })
    }
    setAgentDraftClearNonce((current) => ({
      ...current,
      [fromId]: (current[fromId] ?? 0) + 1
    }))
  }

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

  const mediaProjectDir = (sourcePath: string): string | undefined => {
    const remote = parseRemoteUri(sourcePath)
    const target = activeTermTab
    if (target && (remote ? target.profileId === remote.profileId : !target.ssh)) {
      const folder = target.profileId && target.ssh ? remoteUri(target.profileId, target.cwd) : target.cwd
      if (pathBelongsToCaseFolder(sourcePath, folder)) return folder
    }
    return remote ? remoteUri(remote.profileId, parentRemotePath(remote.path)) : parentLocalPath(sourcePath)
  }

  const askMedia = async (request: MediaAskRequest): Promise<'attached' | 'forwarded'> => {
    const selection = normalizeMediaSelection(request.selection)
    if (!selection) throw new Error('선택한 미디어 정보를 확인할 수 없습니다.')
    if (docOnly) {
      await window.lt.media.forwardAsk(request)
      return 'forwarded'
    }
    const candidate = resolveClaudeAgentTargetTab(visibleTermTabs, activeTerm, activeWork) ?? activeTermTab
    const target = isAgentTab(activeTermTab) ? activeTermTab : isAgentTab(candidate) ? candidate : createClaudeAgentForPrompt(selection.sourcePath)
    if (!target) throw new Error('미디어를 질문할 Agent 작업을 먼저 열어 주세요.')
    const remote = parseRemoteUri(selection.sourcePath)
    if ((remote && target.profileId !== remote.profileId) || (!remote && target.ssh)) {
      throw new Error('이 미디어와 같은 로컬/SSH 작업환경의 Agent를 선택해 주세요.')
    }
    if (!(await confirmCaseFileScope(target, selection.sourcePath))) throw new Error('미디어 첨부를 취소했습니다.')
    let capturePath = selection.capturePath
    let captureUri: string | undefined
    if (request.capture?.byteLength) {
      const targetDir = target.ssh && target.profileId ? remoteUri(target.profileId, target.cwd) : target.cwd
      const saved = await window.lt.media.saveCapture({ bytes: request.capture, targetDir })
      captureUri = saved.path
      capturePath = parseRemoteUri(saved.path)?.path ?? saved.path
    }
    const projectDir = mediaProjectDir(selection.sourcePath)
    const media = { ...selection, capturePath, projectDir: projectDir ? parseRemoteUri(projectDir)?.path ?? projectDir : undefined }
    const sourceName = fileNameFromPath(selection.sourcePath)
    const rangeLabel = selection.start !== undefined && selection.end !== undefined
      ? `${formatMediaTime(selection.start)}–${formatMediaTime(selection.end)}` : formatMediaTime(selection.time)
    const sourceDoc = docTabsRef.current.find((doc) => doc.path === selection.sourcePath || doc.mediaState?.sourcePath === selection.sourcePath)
    queueAgentAttachment(target, {
      kind: 'media-range', label: `${sourceName} · ${rangeLabel}`, media,
      path: remote?.path ?? selection.sourcePath, origin: remote ? 'remote' : 'local', access: 'workspace-path',
      source: selection.compositionId && captureUri
        ? { path: captureUri, title: `${selection.compositionId} · 프레임 ${selection.frame}` }
        : { docId: sourceDoc?.id, path: selection.sourcePath, title: sourceName },
      text: `선택한 리뷰 버전: ${selection.versionId}`
    }, '선택한 장면/구간을 다음과 같이 수정해줘: ')
    if (capturePath) queueAgentAttachment(target, {
      kind: 'file', label: `화면 캡처 · ${formatMediaTime(selection.captureTime ?? selection.time)}`,
      path: capturePath, origin: remote ? 'remote' : 'local', access: 'workspace-path',
      text: '사용자가 보고 있던 미디어 프레임입니다. 실제 이미지 읽기 도구로 확인하세요.'
    })
    return 'attached'
  }
  const askMediaRef = useRef(askMedia)
  askMediaRef.current = askMedia
  useEffect(() => {
    if (docOnly) return
    return window.lt.media.onAsk((request) => {
      void askMediaRef.current(request).catch((error) => window.lt.dialog.alert(error instanceof Error ? error.message : String(error)))
    })
  }, [])

  const openRemotion = async (projectDir?: string): Promise<void> => {
    if (!projectDir) { await window.lt.dialog.alert('Remotion 프로젝트 폴더를 먼저 열어 주세요.'); return }
    try {
      const result = await window.lt.remotion.open({ projectDir })
      if (!result.ok) await window.lt.dialog.alert(result.error || 'Remotion 미리보기를 열지 못했습니다.')
    } catch (error) { await window.lt.dialog.alert(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => window.lt.remotion.onSelection((preview) => {
    try {
      if (!/^data:image\/(png|jpeg);base64,/.test(preview.captureDataUrl) || preview.captureDataUrl.length > 7 * 1024 * 1024) throw new Error('Remotion 캡처 이미지를 확인할 수 없습니다.')
      const bytes = Uint8Array.from(atob(preview.captureDataUrl.split(',')[1]), (char) => char.charCodeAt(0))
      void askMediaRef.current({
        selection: {
          sourcePath: preview.sourcePath, versionId: preview.version,
          time: preview.frame / preview.fps, captureTime: preview.frame / preview.fps,
          ...(preview.endFrame !== undefined ? { start: preview.startFrame / preview.fps, end: preview.endFrame / preview.fps } : {}),
          frame: preview.frame, fps: preview.fps, compositionId: preview.compositionId
        }, capture: bytes
      }).catch((error) => window.lt.dialog.alert(error instanceof Error ? error.message : String(error)))
    } catch (error) { void window.lt.dialog.alert(error instanceof Error ? error.message : String(error)) }
  }), [])

  const selectionAttachmentLabel = (docName?: string): string => {
    const source = docName?.trim() || '선택 영역'
    selectionAttachmentSeqRef.current += 1
    return `${source} 선택 ${selectionAttachmentSeqRef.current}`
  }

  const selectionAttachmentForAgent = (
    text: string,
    opts: { docPath?: string; docName?: string; sourceLabel?: string; selectionSource?: ClaudeSelectionSource },
    term: TermTab
  ): AgentAttachment => {
    const trimmed = text.trim()
    const readablePath = opts.docPath ? claudeReadablePath(opts.docPath, term) : undefined
    const sourceLabel = opts.sourceLabel ?? opts.docName
    const page = opts.selectionSource?.range?.startPage
    const pageLabel = typeof page === 'number' && Number.isSafeInteger(page) && page > 0
      ? `PDF ${page}쪽`
      : undefined
    const body = [
      sourceLabel ? `${opts.docPath ? '문서' : '출처'}: ${sourceLabel}` : undefined,
      readablePath ? `문서 경로: ${readablePath}` : undefined,
      pageLabel ? `인용 위치: ${pageLabel} (파일의 실제 쪽번호)` : undefined,
      `선택 길이: ${formatCharCount(trimmed.length)}자`,
      '',
      trimmed
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n')
    return {
      kind: 'selection',
      label: selectionAttachmentLabel([sourceLabel, pageLabel].filter(Boolean).join(' · ')),
      path: readablePath,
      source: opts.selectionSource
        ? {
            docId: opts.selectionSource.docId,
            path: opts.selectionSource.docPath,
            title: opts.selectionSource.docTitle ?? sourceLabel,
            text: opts.selectionSource.text ?? trimmed,
            range: opts.selectionSource.range
          }
        : undefined,
      text: body
    }
  }

  const agentSelectionInputText = (attachment: AgentAttachment): string =>
    `「${attachment.label}」 선택 부분에 대해 `

  const inlineTargetsForCase = (caseId: string, sourceSide: DockSide): TermTab[] =>
    termTabsRef.current.filter((term) => isAgentTab(term) && caseIdForTerm(term) === caseId && termSide(term) !== sourceSide)

  const createInlineAgent = (caseId: string, sourceSide: DockSide): TermTab => {
    const tab = caseTabsRef.current.find((item) => item.id === caseId)
    if (!tab) throw new Error('원문 사건이 닫혔습니다. 사건을 다시 열어 주세요.')
    const source = currentCaseFromCaseTab(tab)
    const side = otherSide(sourceSide)
    if (source.ssh) {
      const profile = sshProfiles.find((item) => item.id === source.profileId)
      if (!profile || !source.remotePath) throw new Error('원문 사건의 원격 연결 설정을 확인해 주세요.')
      return createRemoteCase(profile, source.remotePath, source.name, source.meta, source.records, side, 'agent')
    }
    return createCase(source.drafts, source.name, source.records, source.suggestedRecords, source.meta, side, source.suggestedRecordOptions)
  }

  const openInlineSelection = (box: SelectionActionBox): void => {
    const captured = box.askOpts?.selectionSource
    const doc = docTabsRef.current.find((item) => item.id === captured?.docId)
    const caseId = doc ? caseIdForDoc(doc) : undefined
    const caseTab = caseTabsRef.current.find((item) => item.id === caseId)
    if (!doc || !caseTab || !box.text.trim()) {
      void window.lt.dialog.alert('사건 폴더에서 문서를 연 뒤 선택한 부분에 지시해 주세요.')
      return
    }
    const sourceSide = docSide(doc)
    const candidates = inlineTargetsForCase(caseTab.id, sourceSide)
    const sourcePath = captured?.docPath ?? doc.path
    const sourceTitle = captured?.docTitle ?? (sourcePath && sourcePath !== doc.path ? fileNameFromPath(sourcePath) : doc.title)
    try {
      const target = candidates.find((item) => item.id === activeTerm) ?? candidates[0] ?? createInlineAgent(caseTab.id, sourceSide)
      setMountedTermIds((current) => current.has(target.id) ? current : new Set(current).add(target.id))
      setInlineSelection({
        key: newId(), caseId: caseTab.id, caseName: caseTabTitle(caseTab), sourceSide,
        source: { ...captured, docId: doc.id, docPath: sourcePath, docTitle: sourceTitle, text: box.text },
        text: box.text, x: box.x, y: box.bottom ?? box.y + 12,
        domRange: box.domRange, sourceElement: box.sourceElement, targetId: target.id
      })
    } catch (error) {
      void window.lt.dialog.alert(error instanceof Error ? error.message : String(error))
    }
  }

  const changeInlineTarget = (id: string): void => {
    if (!inlineSelection) return
    try {
      const target = id === '__new__'
        ? createInlineAgent(inlineSelection.caseId, inlineSelection.sourceSide)
        : inlineTargetsForCase(inlineSelection.caseId, inlineSelection.sourceSide).find((item) => item.id === id)
      if (target) {
        setMountedTermIds((current) => current.has(target.id) ? current : new Set(current).add(target.id))
        setInlineSelection((current) => current ? { ...current, targetId: target.id } : null)
      }
    } catch (error) {
      void window.lt.dialog.alert(error instanceof Error ? error.message : String(error))
    }
  }

  const submitInlineSelection = async (text: string): Promise<{ ok: boolean; error?: string }> => {
    const selection = inlineSelection
    if (!selection) return { ok: false, error: '선택한 원문을 다시 확인해 주세요.' }
    if (activeCaseTabIdRef.current !== selection.caseId) return { ok: false, error: `${selection.caseName} 사건으로 돌아와 전송해 주세요. 입력한 지시는 유지됩니다.` }
    const target = inlineTargetsForCase(selection.caseId, selection.sourceSide).find((item) => item.id === selection.targetId)
    const actions = target && inlineActionsRef.current.get(target.id)
    if (!target || !actions) return { ok: false, error: '선택한 Agent 세션이 닫혔거나 아직 준비 중입니다. 보낼 곳을 확인해 주세요.' }
    const path = selection.source.docPath
    if (path && !await confirmCaseFileScope(target, path, selection.source.docTitle)) return { ok: false, error: '전송을 취소했습니다. 입력한 지시는 유지됩니다.' }
    if (activeCaseTabIdRef.current !== selection.caseId ||
      !inlineTargetsForCase(selection.caseId, selection.sourceSide).some((item) => item.id === target.id) ||
      inlineActionsRef.current.get(target.id) !== actions) return { ok: false, error: '사건 또는 세션이 변경되었습니다. 보낼 곳을 다시 확인해 주세요.' }
    const attachment = selectionAttachmentForAgent(selection.text, {
      docPath: path, docName: selection.source.docTitle, selectionSource: selection.source
    }, target)
    const result = await actions.submit({ text, attachment })
    if (result.ok && activeCaseTabIdRef.current === selection.caseId && termTabsRef.current.some((item) => item.id === target.id)) {
      setActiveTerm(target.id)
      setWorkActive(termSide(target), termKeyOf(target.id))
    }
    return result
  }

  const buildWorkspaceSnapshot = async (onlyCaseTabId?: string): Promise<WorkspaceSnapshot> => {
    const sourceDocs = onlyCaseTabId
      ? docTabsRef.current.filter((tab) => !isSharedDocTab(tab) && caseIdForDoc(tab) === onlyCaseTabId)
      : docTabs
    const sourceTerms = onlyCaseTabId
      ? termTabsRef.current.filter((tab) => caseIdForTerm(tab) === onlyCaseTabId)
      : termTabs
    const docs = sourceDocs
      .map((tab) => toWorkspaceDoc({ ...tab, caseTabId: tab.caseTabId ?? caseIdForDoc(tab) }))
      .filter((t): t is WorkspaceDocTabPayload => !!t)
    const terminals = await Promise.all(
      sourceTerms.map(async (t) => {
        const caseTabIdValue = caseIdForTerm(t)
        if (isAgentTab(t)) {
          const agentSnapshot = await window.lt.agent.snapshot(t.id).catch(() => null)
          const resumeSessionId =
            agentSnapshot?.ok && agentSnapshot.session?.resumeSessionId
              ? agentSnapshot.session.resumeSessionId
              : t.resumeSessionId
          if (resumeSessionId) rememberSessionForTerm(t, resumeSessionId, t.sessionTitle)
          return {
            ...t,
            todoManagement: agentSnapshot?.session?.workspaceContext?.todoManagement === false ? false : t.todoManagement,
            caseTabId: caseTabIdValue,
            side: termSide(t),
            resumeSessionId
          }
        }
        const current = await window.lt.sessions
          .current(t.cwd, (t.createdAt ?? 0) - 3000, t.ssh)
          .catch(() => null)
        if (current?.sessionId) rememberSessionForTerm(t, current.sessionId, current.title)
        return {
          ...t,
          caseTabId: caseTabIdValue,
          side: termSide(t),
          resumeSessionId: current?.sessionId ?? t.resumeSessionId,
          sessionTitle: current?.title ?? t.sessionTitle
        }
      })
    )
    const caseTabFromTermPayload = (term: TermTab): CaseWorkspaceTab => {
      const source = currentCaseFromTerm(term)
      return {
        ...caseTabFromCurrentCase(source, term.id),
        id: term.caseTabId ?? resolveCaseTabId(source)
      }
    }
    const selectedCaseTabs = onlyCaseTabId
      ? caseTabsRef.current.filter((tab) => tab.id === onlyCaseTabId)
      : caseTabs
    const caseTabsWithActivity = selectedCaseTabs.map((tab) =>
      tab.id === activeCaseTabId
        ? {
            ...tab,
            activeDocId: activeDocTab && !isSharedDocTab(activeDocTab) ? activeDocTab.id : tab.activeDocId,
            activeTermId: activeTermTab?.id ?? tab.activeTermId,
            activeWork,
            updatedAt: Date.now()
          }
        : tab
    )
    const selectedCurrentCase = onlyCaseTabId
      ? caseTabsWithActivity[0]
        ? currentCaseFromCaseTab(caseTabsWithActivity[0])
        : sourceTerms[0]
          ? currentCaseFromTerm(sourceTerms[0])
          : undefined
      : currentCase
    const snapshotCaseTabs = mergeCaseTabs(
      caseTabsWithActivity,
      [
        ...terminals.map((term) => caseTabFromTermPayload(term)),
        ...(selectedCurrentCase
          ? [
              caseTabFromCurrentCase(
                selectedCurrentCase,
                sourceTerms.some((term) => term.id === activeTerm) ? activeTerm : sourceTerms[0]?.id
              )
            ]
          : [])
      ]
    )
    const snapshotActiveDoc = sourceDocs.some((tab) => tab.id === activeDoc)
      ? activeDoc
      : caseTabsWithActivity[0]?.activeDocId
    const snapshotActiveTerm = sourceTerms.some((tab) => tab.id === activeTerm)
      ? activeTerm
      : caseTabsWithActivity[0]?.activeTermId ?? sourceTerms[0]?.id
    const snapshotActiveWork =
      onlyCaseTabId && activeCaseTabId !== onlyCaseTabId
        ? (caseTabsWithActivity[0]?.activeWork ?? {})
        : activeWork
    const snapshotDocPaths = new Set(docs.map((doc) => doc.path).filter(Boolean))
    const snapshotPdfStatus = onlyCaseTabId
      ? Object.fromEntries(
          Object.entries(pdfStatus).filter(([, status]) => snapshotDocPaths.has(status.path))
        )
      : pdfStatus
    return {
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      mode: onlyCaseTabId ? 'explorer' : mode,
      docs,
      terminals,
      caseTabs: snapshotCaseTabs,
      activeDoc: snapshotActiveDoc,
      activeTerm: snapshotActiveTerm,
      activeCaseTabId: onlyCaseTabId ?? activeCaseTabId,
      activeWork: snapshotActiveWork,
      currentCase: selectedCurrentCase,
      pdfStatus: snapshotPdfStatus,
      crop: { on: cropOn, ratio: cropRatio }
    }
  }

  const sanitizeWorkspaceTerm = (raw: unknown): TermTab | null => {
    if (!raw || typeof raw !== 'object') return null
    const t = raw as Partial<TermTab>
    if (typeof t.cwd !== 'string' || !t.cwd) return null
    const savedProfile = sshProfiles.find((profile) => profile.id === t.profileId)
    const ssh = t.ssh
      ? { ...t.ssh, remoteControl: savedProfile?.remoteControl ?? t.ssh.remoteControl }
      : undefined
    return {
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      title: typeof t.title === 'string' && t.title ? t.title : t.cwd.split(/[\\/]/).pop() || '세션',
      kind: t.kind === 'agent' ? 'agent' : 'terminal',
      caseTabId: typeof t.caseTabId === 'string' ? t.caseTabId : undefined,
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
      autoAgent: t.kind === 'agent' ? undefined : isAgentProvider(t.autoAgent) ? t.autoAgent : undefined,
      agentProvider: t.kind === 'agent' ? resolveAgentProvider(t.agentProvider, ssh) : undefined,
      todoManagement: typeof t.todoManagement === 'boolean' ? t.todoManagement : undefined,
      selectedTaskId: typeof t.selectedTaskId === 'string' ? t.selectedTaskId : undefined,
      contextKind: t.contextKind === 'global' || t.contextKind === 'case' || t.contextKind === 'folder' || t.contextKind === 'project' ? t.contextKind : undefined,
      projectId: typeof t.projectId === 'string' ? t.projectId : undefined,
      jsId: typeof t.jsId === 'string' ? t.jsId : undefined,
      court: typeof t.court === 'string' ? t.court : undefined,
      caseNumber: typeof t.caseNumber === 'string' ? t.caseNumber : undefined,
      caseName: typeof t.caseName === 'string' ? t.caseName : undefined,
      client: typeof t.client === 'string' ? t.client : undefined,
      opponent: typeof t.opponent === 'string' ? t.opponent : undefined,
      partyNames: typeof t.partyNames === 'string' ? t.partyNames : undefined,
      memo: typeof t.memo === 'string' ? t.memo : undefined,
      originDevice: t.originDevice === 'android' || t.originDevice === 'desktop' ? t.originDevice : undefined,
      sessionTitle: typeof t.sessionTitle === 'string' ? t.sessionTitle : undefined,
      renamed: !!t.renamed,
      createdAt: Date.now(),
      resumeSessionId: typeof t.resumeSessionId === 'string' ? t.resumeSessionId : undefined,
      ssh,
      sshLabel: typeof t.sshLabel === 'string' ? t.sshLabel : undefined,
      profileId: typeof t.profileId === 'string' ? t.profileId : undefined,
      side: t.side ?? 'right'
    }
  }

  const restoreWorkspaceSnapshot = (snapshot: WorkspaceSnapshot, activate = true): void => {
    const snapshotDocs = Array.isArray(snapshot.docs) ? snapshot.docs : []
    const snapshotTerms = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
    const restoredCase = sanitizeCurrentCase(snapshot.currentCase)
    const restoredCaseTabs = Array.isArray(snapshot.caseTabs)
      ? snapshot.caseTabs
          .map(sanitizeCaseWorkspaceTab)
          .filter((tab): tab is CaseWorkspaceTab => !!tab)
      : []

    // 저장된 ID는 다른 창의 ID와 충돌할 수 있으므로 사건별로 먼저 대응시킨다.
    let nextCaseTabs = [...caseTabsRef.current]
    const caseIdMap = new Map<string, string>()
    for (const tab of restoredCaseTabs) {
      const id = resolveCaseTabId(tab, nextCaseTabs)
      nextCaseTabs = upsertCaseTab(nextCaseTabs, { ...tab, id })
      caseIdMap.set(tab.id, id)
    }

    const nextTerms = [...termTabsRef.current]
    for (const saved of snapshotTerms) {
      const tab = sanitizeWorkspaceTerm(saved)
      if (!tab) continue
      const existing = nextTerms.find((term) => term.id === tab.id)
      const source = currentCaseFromTerm(existing ?? tab)
      const id = existing?.caseTabId ??
        (tab.caseTabId && caseIdMap.get(tab.caseTabId)) ?? resolveCaseTabId(source, nextCaseTabs)
      if (tab.caseTabId) caseIdMap.set(tab.caseTabId, id)
      if (existing) continue
      nextCaseTabs = upsertCaseTab(nextCaseTabs, { ...caseTabFromCurrentCase(source, tab.id), id })
      nextTerms.push({ ...tab, caseTabId: id })
    }
    if (restoredCase) {
      const tab = caseTabFromCurrentCase(restoredCase, snapshot.activeTerm || undefined)
      const id = resolveCaseTabId(restoredCase, nextCaseTabs)
      nextCaseTabs = upsertCaseTab(nextCaseTabs, { ...tab, id })
      if (!caseIdMap.has(tab.id)) caseIdMap.set(tab.id, id)
    }

    const nextDocs = [...docTabsRef.current]
    const docIdMap = new Map<string, string>()
    for (const saved of snapshotDocs) {
      const tab = toDocTab(saved)
      if (!tab) continue
      const caseTabIdValue =
        (tab.caseTabId && caseIdMap.get(tab.caseTabId)) ??
        tab.caseTabId ??
        inferCaseTabIdForPath(tab.path, nextCaseTabs) ??
        (nextCaseTabs.length === 1 && !isSharedDocTab(tab) ? nextCaseTabs[0].id : undefined)
      const nextTab = { ...tab, caseTabId: caseTabIdValue }
      const existingById = nextDocs.find((t) => t.id === nextTab.id)
      const existingByPath = nextTab.path
        ? nextDocs.find(
            (t) =>
              t.path === nextTab.path &&
              (t.caseTabId ?? inferCaseTabIdForPath(t.path, nextCaseTabs)) === nextTab.caseTabId
          )
        : undefined
      const existing = existingById ?? existingByPath
      if (existing) {
        docIdMap.set(saved.id, existing.id)
        continue
      }
      nextDocs.push(nextTab)
      docIdMap.set(saved.id, nextTab.id)
    }
    if (snapshot.pdfStatus && typeof snapshot.pdfStatus === 'object') {
      setPdfStatus((current) => {
        const restored: Record<string, PdfViewStatus> = {}
        for (const rawStatus of Object.values(snapshot.pdfStatus as Record<string, unknown>)) {
          const status = sanitizePdfStatus(rawStatus)
          if (!status) continue
          restored[pdfStatusKey(status.path)] = status
        }
        return { ...current, ...restored }
      })
    }

    const savedActiveCaseTabId =
      caseIdMap.get(snapshot.activeCaseTabId ?? '') ?? snapshot.activeCaseTabId
    const nextActiveCaseTabId =
      (typeof savedActiveCaseTabId === 'string' &&
      nextCaseTabs.some((tab) => tab.id === savedActiveCaseTabId)
        ? savedActiveCaseTabId
        : undefined) ??
      (restoredCase ? resolveCaseTabId(restoredCase, nextCaseTabs) : undefined) ??
      (activeCaseTabId && nextCaseTabs.some((tab) => tab.id === activeCaseTabId)
        ? activeCaseTabId
        : undefined) ??
      nextCaseTabs[0]?.id ??
      ''
    const caseDocs = nextDocs.filter(
      (doc) => isSharedDocTab(doc) || !nextActiveCaseTabId || doc.caseTabId === nextActiveCaseTabId
    )
    const caseTerms = nextTerms.filter(
      (term) => !nextActiveCaseTabId || caseIdForTerm(term) === nextActiveCaseTabId
    )
    const activeCaseTab = nextCaseTabs.find((tab) => tab.id === nextActiveCaseTabId)
    const activeDocId =
      (snapshot.activeDoc && docIdMap.get(snapshot.activeDoc)) ||
      (activeCaseTab?.activeDocId && caseDocs.some((t) => t.id === activeCaseTab.activeDocId)
        ? activeCaseTab.activeDocId
        : undefined) ||
      (activeDoc && caseDocs.some((t) => t.id === activeDoc) ? activeDoc : caseDocs[0]?.id ?? '')
    const activeTermId =
      (snapshot.activeTerm && caseTerms.some((t) => t.id === snapshot.activeTerm)
        ? snapshot.activeTerm
        : undefined) ||
      (activeCaseTab?.activeTermId && caseTerms.some((t) => t.id === activeCaseTab.activeTermId)
        ? activeCaseTab.activeTermId
        : undefined) ||
      (activeTerm && caseTerms.some((t) => t.id === activeTerm) ? activeTerm : caseTerms[0]?.id ?? '')
    const activeTermTab = nextTerms.find((t) => t.id === activeTermId)

    docTabsRef.current = nextDocs
    termTabsRef.current = nextTerms
    caseTabsRef.current = nextCaseTabs
    setDocTabs(nextDocs)
    setTermTabs(nextTerms)
    setCaseTabs(nextCaseTabs)
    if (!activate) return
    setActiveDoc(activeDocId)
    setActiveTerm(activeTermId)

    const validKeys = new Set([
      ...caseDocs.map((t) => docKey(t.id)),
      ...caseTerms.map((t) => termKeyOf(t.id))
    ])
    const firstKeyForSide = (side: DockSide): string => {
      const doc = caseDocs.find((t) => docSide(t) === side)
      if (doc) return docKey(doc.id)
      const term = caseTerms.find((t) => termSide(t) === side)
      return term ? termKeyOf(term.id) : ''
    }
    const restoredActiveWork = { ...(activeCaseTab?.activeWork ?? snapshot.activeWork) }
    for (const side of ['left', 'right'] as const) {
      const key = restoredActiveWork[side]
      const docId = key?.startsWith('doc:') ? docIdMap.get(key.slice(4)) : undefined
      if (docId) restoredActiveWork[side] = docKey(docId)
    }
    const left =
      isWorkKey(restoredActiveWork?.left) && validKeys.has(restoredActiveWork.left)
        ? restoredActiveWork.left
        : firstKeyForSide('left')
    const right =
      isWorkKey(restoredActiveWork?.right) && validKeys.has(restoredActiveWork.right)
        ? restoredActiveWork.right
        : firstKeyForSide('right')
    setActiveWork({ left, right })
    if (isAgentTab(activeTermTab)) {
      setTermFocusNonce((current) => bumpFocusNonce(current, activeTermTab.id))
    }

    if (isWorkspaceMode(snapshot.mode)) setMode(snapshot.mode)
    const nextCurrentCase = restoredCase ?? (activeTermTab ? currentCaseFromTerm(activeTermTab) : currentCase)
    setCurrentCase(nextCurrentCase)
    setActiveCaseTabId(nextActiveCaseTabId)
    const restoredCaseSource = currentCaseSessionSource(nextCurrentCase, sshProfiles)
    if (restoredCaseSource) preloadPastSessions(restoredCaseSource.cwd, restoredCaseSource)
    if (snapshot.crop) {
      setCropOn(!!snapshot.crop.on)
      if (Number.isFinite(snapshot.crop.ratio)) setCropRatio(snapshot.crop.ratio)
    }
    setTreeRefresh((n) => n + 1)
  }

  const workspaceLocation = (source: CurrentCase): { cwd: string; profileId?: string; ssh?: SshConn; caseId?: string } => ({
    caseId: source.meta?.jsId,
    cwd: source.remotePath ?? parseRemoteUri(source.drafts)?.path ?? source.drafts,
    profileId: source.profileId,
    ssh: source.ssh
  })

  const workspaceLocationKey = (source: CurrentCase): string => {
    const location = workspaceLocation(source)
    return `${location.profileId ?? 'local'}\0${normalizedCasePathKey(location.cwd)}\0${location.caseId ?? ''}`
  }

  const remoteWorkspacePath = (value: string | undefined, profileId: string): string | undefined => {
    if (!value) return undefined
    return remoteUri(profileId, parseRemoteUri(value)?.path ?? value)
  }

  // 공유 파일은 그것을 저장한 컴퓨터의 SSH 프로필 id를 담을 수 있다. 현재 컴퓨터의
  // 프로필로 갈아끼우고, 원격 호스트에서 직접 저장한 로컬 경로도 ssh:// URI로 바꾼다.
  const rebaseRemoteWorkspace = (
    snapshot: WorkspaceSnapshot,
    source: CurrentCase
  ): WorkspaceSnapshot => {
    if (!source.ssh || !source.profileId) return snapshot
    const profileId = source.profileId
    const ssh = source.ssh
    const docs = (snapshot.docs ?? []).map((doc) => ({
      ...doc,
      caseTabId: undefined,
      path: remoteWorkspacePath(doc.path, profileId),
      mediaState: doc.mediaState ? { ...doc.mediaState, sourcePath: remoteWorkspacePath(doc.mediaState.sourcePath, profileId) } : undefined
    }))
    const terminals = (snapshot.terminals ?? []).map((term) => ({
      ...term,
      caseTabId: undefined,
      recordsFolder: remoteWorkspacePath(term.recordsFolder ?? source.records, profileId),
      suggestedRecords: remoteWorkspacePath(term.suggestedRecords, profileId),
      suggestedRecordOptions: term.suggestedRecordOptions?.map((item) => ({
        ...item,
        path: remoteWorkspacePath(item.path, profileId) ?? item.path
      })),
      ssh,
      sshLabel: source.sshLabel,
      profileId
    }))
    const storedCase =
      snapshot.currentCase && typeof snapshot.currentCase === 'object'
        ? (snapshot.currentCase as Partial<CurrentCase>)
        : undefined
    const records = remoteWorkspacePath(storedCase?.records ?? source.records, profileId)
    const suggestedRecords = remoteWorkspacePath(
      storedCase?.suggestedRecords ?? source.suggestedRecords,
      profileId
    )
    const sourceRemotePath = source.remotePath ?? parseRemoteUri(source.drafts)?.path ?? source.drafts
    const currentCase: CurrentCase = {
      ...storedCase,
      ...source,
      drafts: remoteUri(profileId, sourceRemotePath),
      records,
      suggestedRecords,
      suggestedRecordOptions: (storedCase?.suggestedRecordOptions ?? source.suggestedRecordOptions)?.map(
        (item) => ({ ...item, path: remoteWorkspacePath(item.path, profileId) ?? item.path })
      ),
      ssh,
      sshLabel: source.sshLabel,
      profileId,
      remotePath: sourceRemotePath
    }
    return {
      ...snapshot,
      workspaceId: undefined,
      docs,
      terminals,
      caseTabs: undefined,
      activeCaseTabId: undefined,
      currentCase
    }
  }

  const saveCaseWorkspace = async (caseTabIdValue: string): Promise<void> => {
    const tab = caseTabsRef.current.find((item) => item.id === caseTabIdValue)
    if (!tab) return
    const source = currentCaseFromCaseTab(tab)
    const key = workspaceLocationKey(source)
    if (autoRestoreInFlightRef.current.has(key)) return
    if (!autoRestoreDoneRef.current.has(key) && !(await restoreAutomaticWorkspace(source))) {
      throw new Error('사건 작업환경을 복원하지 못해 자동 저장을 보류했습니다.')
    }
    const reopen = pendingWorkspaceReopensRef.current.get(key)
    const snapshot = await buildWorkspaceSnapshot(caseTabIdValue)
    snapshot.workspaceLabel = tab.name
    snapshot.workspaceReopen = !!reopen
    snapshot.workspaceIntentId = reopen?.id
    snapshot.reopenAgentTabs = reopen?.terminals.flatMap((term) => {
      const live = snapshot.terminals.find((item) => item.id === term.id)
      return live ? [live] : []
    })
    if (!caseTabsRef.current.some((item) => item.id === caseTabIdValue)) return
    const result = await window.lt.workspace.autoSave(snapshot, workspaceLocation(source))
    if (!result.ok || result.remoteError) throw new Error(result.remoteError || result.error || '사건탭 저장 실패')
    if (pendingWorkspaceReopensRef.current.get(key) === reopen) pendingWorkspaceReopensRef.current.delete(key)
  }

  const saveAllCaseWorkspaces = async (): Promise<boolean> => {
    const results = await Promise.allSettled([
      ...caseTabsRef.current.map((tab) => saveCaseWorkspace(tab.id)),
      ...[...pendingCaseClosesRef.current.values()].map((save) => save())
    ])
    setWorkspaceSyncError(results.some((result) => result.status === 'rejected')
      ? '사건탭 공유 실패 · 연결 후 다시 시도합니다' : '')
    return results.every((result) => result.status === 'fulfilled')
  }
  saveAllCaseWorkspacesRef.current = saveAllCaseWorkspaces

  const restoreAutomaticWorkspace = async (source: CurrentCase, refresh = false): Promise<boolean> => {
    const id = resolveCaseTabId(source)
    const key = workspaceLocationKey(source)
    if (!refresh && autoRestoreDoneRef.current.has(key)) return true
    const existing = autoRestoreInFlightRef.current.get(key)
    if (existing) return existing
    const account = todoAccountGeneration.current
    const run = async (): Promise<boolean> => {
      try {
        const termsBeforeLoad = termTabsRef.current
        const result = await window.lt.workspace.autoLoad(workspaceLocation(source), !refresh)
        if (account !== todoAccountGeneration.current) return true
        // A background response must not undo a tab closed while the read was in flight.
        if (refresh && termsBeforeLoad !== termTabsRef.current) return true
        const local = !refresh && result.local?.snapshot
          ? rebaseRemoteWorkspace(agentTabsOnly(result.local.snapshot), source)
          : undefined
        const remote = result.remote?.snapshot
          ? rebaseRemoteWorkspace(agentTabsOnly(result.remote.snapshot), source)
          : undefined
        if (remote && local) local.terminals = local.terminals.filter((term) => !isAgentTabClosed(remote, term))
        if (refresh && remote && !pendingWorkspaceReopensRef.current.has(key)) {
          if (remote.workspaceOpen === false) {
            await closeCaseTab(id, true)
            await window.lt.workspace.autoObserve(workspaceLocation(source), result.remote!.snapshot!)
            return true
          }
          for (const term of termTabsRef.current) {
            if (caseIdForTerm(term) === id && isAgentTabClosed(remote, term) && !hasLocalTermWork(term)) closeTerm(term.id)
          }
        }
        const selected = local && remote ? mergeWorkspaceSessions(local, remote) : remote ?? local
        // The case may have been closed while the remote read was in progress.
        if (!caseTabsRef.current.some((tab) => tab.id === id)) return true
        if (result.ok) autoRestoreDoneRef.current.add(key)
        if (selected?.terminals.length) {
          const merged = mergeWorkspaceSessions({
            ...selected, docs: [], terminals: termTabsRef.current, activeTerm: undefined
          }, selected)
          // Preserve a document/agent opened while loading; only append missing agent tabs.
          const existingIds = new Set(termTabsRef.current.map((term) => term.id))
          const added = merged.terminals.filter((term) => !existingIds.has(term.id))
          if (added.length) {
            restoreWorkspaceSnapshot(
              { ...selected, terminals: added, activeTerm: merged.activeTerm },
              activeCaseTabIdRef.current === id && !termTabsRef.current.some((term) => caseIdForTerm(term) === id)
            )
            autoSaveEligibleRef.current.add(id)
          }
        }
        // Keep the local backup usable offline, but leave remote restoration retryable.
        if (!result.ok) throw new Error(result.error || '에이전트 탭을 불러오지 못했습니다.')
        if (refresh && result.remote?.snapshot) {
          await window.lt.workspace.autoObserve(workspaceLocation(source), result.remote.snapshot)
        }
        return true
      } catch (error) {
        if (refresh) setWorkspaceSyncError('사건탭 공유 실패 · 연결 후 다시 시도합니다')
        else await window.lt.dialog.alert('에이전트 탭 복원 실패: ' + String(error) + '\n사건·폴더를 다시 열면 재시도합니다.')
        return false
      }
    }
    const request = run().finally(() => {
      if (autoRestoreInFlightRef.current.get(key) === request) autoRestoreInFlightRef.current.delete(key)
    })
    autoRestoreInFlightRef.current.set(key, request)
    return request
  }
  autoRestoreWorkspaceRef.current = async (source) => {
    if (!(await restoreAutomaticWorkspace(source))) throw new Error('사건 작업환경을 복원하지 못했습니다.')
  }

  refreshAutomaticCasesRef.current = async () => {
    if (automaticCasesLoadingRef.current) return
    automaticCasesLoadingRef.current = true
    const refresh = async (): Promise<void> => {
      const account = todoAccountGeneration.current
      let expectedTerms = termTabsRef.current
      // Flush local closes before reading. Only applied responses are acknowledged
      // so a discarded read cannot turn an unseen remote tab into a local deletion.
      if (!(await saveAllCaseWorkspacesRef.current())) return
      if (account !== todoAccountGeneration.current || workspaceHostsRef.current !== workspaceHostsSignature) return
      // 열어 둔 사건만 최신화하고, 전체 사건 목록은 3분 동안 재사용한다.
      if (Date.now() - lastCaseDiscoveryRef.current < 3 * 60_000) {
        let failed = false
        for (const tab of [...caseTabsRef.current]) {
          if (account !== todoAccountGeneration.current || expectedTerms !== termTabsRef.current) return
          if (!(await restoreAutomaticWorkspace(currentCaseFromCaseTab(tab), true))) failed = true
          expectedTerms = termTabsRef.current
        }
        setWorkspaceSyncError(failed ? '사건탭 공유 실패 · 연결 후 다시 시도합니다' : '')
        return
      }
      // Query each host once even when it has multiple local profile names.
      const profiles = [...new Map(sshProfiles.map((profile) =>
        [`${profile.user}@${profile.host}:${profile.port ?? 22}`, profile])).values()]
      const results = await Promise.allSettled([undefined, ...profiles].map(async (profile) => {
        const result = await window.lt.workspace.autoList(profile ? sshConnFromProfile(profile) : undefined, true)
        if (!result.ok) throw new Error(result.error)
        return { profile, result }
      }))
      if (account !== todoAccountGeneration.current || workspaceHostsRef.current !== workspaceHostsSignature) return
      let failed = results.some((result) => result.status === 'rejected')
      // 실패한 서버도 매 포커스마다 재접속하지 않는다. online 이벤트나 다음 주기에 재시도한다.
      lastCaseDiscoveryRef.current = Date.now()
      for (const response of results) {
        if (response.status !== 'fulfilled') continue
        const { profile, result } = response.value
        for (const snapshot of result.snapshots ?? []) {
          if (account !== todoAccountGeneration.current || expectedTerms !== termTabsRef.current) return
          const stored = sanitizeCurrentCase(snapshot.currentCase)
          if (!stored || !stored.drafts.startsWith('/')) continue
          const source: CurrentCase = {
            name: stored.name,
            drafts: profile ? remoteUri(profile.id, stored.drafts) : stored.drafts,
            records: stored.records ? profile ? remoteUri(profile.id, stored.records) : stored.records : undefined,
            meta: stored.meta,
            ssh: profile ? sshConnFromProfile(profile) : undefined,
            sshLabel: profile?.label,
            profileId: profile?.id,
            remotePath: profile ? stored.drafts : undefined
          }
          const key = workspaceLocationKey(source)
          if (pendingCaseClosesRef.current.has(key)) continue
          const existing = findCaseTab(caseTabsRef.current, source)
          if (snapshot.workspaceOpen !== false) closedAutomaticCasesRef.current.delete(key)
          if (!existing) {
            // 목록만 발견한다. 탭 복원과 자동 저장은 사용자가 사건을 열었을 때 시작한다.
            const updatedAt = Date.parse(snapshot.savedAt) || 0
            setDiscoveredCaseTabs((tabs) => upsertCaseTab(tabs, { ...caseTabFromCurrentCase(source), updatedAt }))
            continue
          }
          if (!(await restoreAutomaticWorkspace(source, true))) failed = true
          expectedTerms = termTabsRef.current
        }
      }
      setWorkspaceSyncError(failed ? '사건탭 공유 실패 · 연결 후 다시 시도합니다' : '')
    }
    const pending = autoWorkspaceSaveChainRef.current.then(refresh)
    autoWorkspaceSaveChainRef.current = pending.catch(() => {
      setWorkspaceSyncError('사건탭 공유 실패 · 연결 후 다시 시도합니다')
    })
    try {
      await autoWorkspaceSaveChainRef.current
    } finally {
      automaticCasesLoadingRef.current = false
      if (workspaceHostsRef.current !== workspaceHostsSignature) void refreshAutomaticCasesRef.current()
    }
  }

  useEffect(() => {
    if (!workspaceSettingsReady || docOnly || termOnly) return
    lastCaseDiscoveryRef.current = 0
    const refresh = (): void => { void refreshAutomaticCasesRef.current() }
    const reconnect = (): void => {
      lastCaseDiscoveryRef.current = 0
      refresh()
    }
    const flush = (): void => {
      autoWorkspaceSaveChainRef.current = autoWorkspaceSaveChainRef.current
        .then(async () => { await saveAllCaseWorkspacesRef.current() }).catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('online', reconnect)
    window.addEventListener('blur', flush)
    const timer = window.setInterval(() => {
      if (document.hasFocus()) refresh()
    }, 30_000)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('blur', flush)
      window.clearInterval(timer)
    }
  }, [workspaceSettingsReady, workspaceHostsSignature, docOnly, termOnly])

  const automaticWorkspaceSignature = JSON.stringify({
    reopens: [...pendingWorkspaceReopensRef.current].map(([key, intent]) => [key, intent.id]),
    cases: caseTabs.map((tab) => [tab.id, tab.activeDocId, tab.activeTermId, tab.activeWork, tab.selectedTaskId]),
    docs: docTabs
      .filter((tab) => !isSharedDocTab(tab))
      .map((tab) => [tab.id, tab.caseTabId ?? caseIdForDoc(tab), tab.path, tab.side]),
    terminals: termTabs.map((tab) => [
      tab.id,
      tab.caseTabId ?? caseIdForTerm(tab),
      tab.cwd,
      tab.title,
      tab.agentProvider,
      tab.resumeSessionId,
      tab.sessionTitle,
      tab.originDevice,
      tab.selectedTaskId,
      tab.side
    ])
  })
  useEffect(() => {
    if (caseTabs.length === 0) return
    const timer = window.setTimeout(() => {
      autoWorkspaceSaveChainRef.current = autoWorkspaceSaveChainRef.current
        .then(async () => { await saveAllCaseWorkspacesRef.current() })
        .catch(() => {})
    }, 1200)
    return () => window.clearTimeout(timer)
    // automaticWorkspaceSignature is the deliberately small persistence surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automaticWorkspaceSignature])

  // A blank agent gets its resumable conversation ID only after its first request.
  // Persist that transition even when no tab is opened, selected or closed afterwards.
  useEffect(() => window.lt.agent.onEvent((event) => {
    if (typeof event.sessionId !== 'string' ||
      (event.type !== 'session:init' && !(event.type === 'status' && event.status === 'done'))) return
    const id = event.sessionId
    void window.lt.agent.snapshot(id).then((result) => {
      const resumeSessionId = result.ok ? result.session?.resumeSessionId : undefined
      if (!resumeSessionId) return
      setTermTabs((tabs) => {
        if (!tabs.some((tab) => tab.id === id && tab.resumeSessionId !== resumeSessionId)) return tabs
        return tabs.map((tab) => tab.id === id ? { ...tab, resumeSessionId } : tab)
      })
    }).catch(() => {})
  }), [])

  const saveWorkspace = async (exportFile = false): Promise<void> => {
    const snapshot = await buildWorkspaceSnapshot()
    const skippedDocs = docTabs.length - snapshot.docs.length
    const result = exportFile
      ? await window.lt.workspace.exportFile(snapshot)
      : await window.lt.workspace.save(snapshot)
    if (result.canceled) return
    if (!result.ok) {
      await window.lt.dialog.alert('작업환경 저장 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    await window.lt.dialog.alert(
      `${exportFile ? '작업환경 내보내기' : '작업환경 저장'} 완료\n문서 ${snapshot.docs.length}개, 터미널 ${snapshot.terminals.length}개` +
        (skippedDocs > 0 ? `\n임시/미저장 문서 ${skippedDocs}개는 제외했습니다.` : '') +
        (result.path ? `\n\n${exportFile ? '내보낸 파일 위치' : '저장 위치'}:\n${result.path}` : '')
    )
  }

  const applyWorkspaceLoadResult = (result: WorkspaceLoadResult): void => {
    if (result.canceled) return
    if (!result.ok) {
      void window.lt.dialog.alert('작업환경 복원 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    if (!result.snapshot) {
      void window.lt.dialog.alert('저장된 작업환경이 없습니다.')
      return
    }
    restoreWorkspaceSnapshot(result.snapshot)
    const restoredCase = sanitizeCurrentCase(result.snapshot.currentCase)
    if (restoredCase) markWorkspaceReopened(restoredCase)
    for (const saved of result.snapshot.caseTabs ?? []) {
      const tab = sanitizeCaseWorkspaceTab(saved)
      if (tab) markWorkspaceReopened(currentCaseFromCaseTab(tab))
    }
    for (const saved of result.snapshot.terminals ?? []) {
      const term = sanitizeWorkspaceTerm(saved)
      if (term) markWorkspaceReopened(currentCaseFromTerm(term), term)
    }
    void window.lt.dialog.alert(
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
    const result = await window.lt.workspace.importFile()
    if (result.ok && result.snapshot) setWorkspacePick(null)
    applyWorkspaceLoadResult(result)
  }

  const openCaseListFromLauncher = (): void => {
    setNewCaseOpen(false)
    setCaseDashboardView('cases')
    setMode('cases')
  }

  const openFolderFromLauncher = (): void => {
    setNewCaseOpen(false)
    void openConnOrLocal()
  }

  const openSavedWorkspaceFromLauncher = (): void => {
    setNewCaseOpen(false)
    void restoreWorkspace(false)
  }

  const openRecentFromLauncher = (entry: RecentCase): void => {
    setNewCaseOpen(false)
    void openRecent(entry)
  }

  useEffect(() => {
    if (!isRemotePath(activeDraftsFolder) && !isRemotePath(activeRecordsFolder)) return
    const timer = setInterval(() => setTreeRefresh((x) => x + 1), 5000)
    return () => clearInterval(timer)
  }, [activeDraftsFolder, activeRecordsFolder])

  useEffect(() => {
    const dirs = Array.from(
      new Set(
        [activeDraftsFolder, activeRecordsFolder].filter(
          (dir): dir is string => !!dir && !isRemotePath(dir)
        )
      )
    )
    if (!dirs.length) return

    let timer: number | undefined
    const refreshSoon = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTreeRefresh((x) => x + 1), 200)
    }
    const unwatch = dirs.map((dir) => window.lt.fs.watch(dir, refreshSoon))
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      for (const off of unwatch) off()
    }
  }, [activeDraftsFolder, activeRecordsFolder])

  useEffect(() => {
    if (!activeRecordsFolder || !isRemotePath(activeRecordsFolder)) return
    let alive = true
    const run = (): void => {
      if (recordsAutoDownloadInFlightRef.current === activeRecordsFolder) return
      recordsAutoDownloadInFlightRef.current = activeRecordsFolder
      window.lt.fs
        .autoDownloadRecords(activeRecordsFolder)
        .then((r) => {
          if (!alive || !r.ok || r.inProgress) return
          if ((r.downloaded ?? 0) > 0) setTreeRefresh((x) => x + 1)
        })
        .catch(() => {})
        .finally(() => {
          if (recordsAutoDownloadInFlightRef.current === activeRecordsFolder) {
            recordsAutoDownloadInFlightRef.current = ''
          }
        })
    }
    run()
    const timer = setInterval(run, REMOTE_RECORD_AUTO_DOWNLOAD_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
      if (recordsAutoDownloadInFlightRef.current === activeRecordsFolder) {
        recordsAutoDownloadInFlightRef.current = ''
      }
    }
  }, [activeRecordsFolder])

  const copyPathsTo = (dir: string, paths: string[]): void => {
    if (!paths.length) return
    window.lt.fs.copyInto(dir, paths).then((r) => {
      if (r.copied.length === 0) {
        void window.lt.dialog.alert('붙여넣기/복사할 수 있는 파일이 없습니다.')
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
      await window.lt.dialog.alert('클립보드에 붙여넣을 로컬 파일 경로가 없습니다.')
      return
    }
    copyPathsTo(dir, clip.paths)
  }
  const onDropFiles = (files: FileList): void => {
    if (activeDraftsFolder) copyFilesTo(activeDraftsFolder, files)
  }
  const downloadEntries = (paths: string[]): void => {
    const remotePaths = paths.filter(isRemotePath)
    if (!remotePaths.length) return
    window.lt.fs
      .download(remotePaths)
      .then(async (r) => {
        if (!r.canceled && !r.ok) await window.lt.dialog.alert('다운로드 실패: ' + (r.error ?? '알 수 없는 오류'))
      })
      .catch((e) => window.lt.dialog.alert('다운로드 실패: ' + String(e)))
      .finally(() => {
        if (activeTerm) setTermFocusNonce((current) => bumpFocusNonce(current, activeTerm))
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
    setCaseTabs((tabs) =>
      tabs.map((tab) => {
        const nextDrafts = replacePathPrefix(tab.drafts, from, to) ?? tab.drafts
        const nextRecords = replacePathPrefix(tab.records, from, to)
        const nextRemotePath =
          tab.profileId && tab.remotePath
            ? parseRemoteUri(replacePathPrefix(remoteUri(tab.profileId, tab.remotePath), from, to) ?? '')
                ?.path ?? tab.remotePath
            : tab.remotePath
        if (
          nextDrafts === tab.drafts &&
          nextRecords === tab.records &&
          nextRemotePath === tab.remotePath
        )
          return tab
        const next = { ...tab, drafts: nextDrafts, records: nextRecords, remotePath: nextRemotePath }
        return { ...next, id: resolveCaseTabId(currentCaseFromCaseTab(next)), updatedAt: Date.now() }
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
        if (r.error) void window.lt.dialog.alert('이름 변경 실패: ' + r.error)
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
        if (r.error) void window.lt.dialog.alert('이름 변경 실패: ' + r.error)
        return
      }
      const previousPath = tab.path as string
      const nextPath = r.path
      setTreeRefresh((n) => n + 1)
      replaceAppPathPrefix(previousPath, nextPath)
    })
  }

  // 파일/폴더 삭제 (확인은 FileTree에서 받음) — 삭제 후 트리 새로고침 + 해당 문서 탭 닫기
  const deleteEntry = async (path: string): Promise<void> => {
    const r = await window.lt.fs.delete(path)
    if (!r.ok) {
      if (r.error) await window.lt.dialog.alert('삭제 실패: ' + r.error)
      return
    }
    setTreeRefresh((n) => n + 1)
    // 삭제된 파일(또는 폴더 하위)을 열어둔 문서 탭이 있으면 닫는다
    setDocTabs((tabs) => {
      const dead = tabs.filter(
        (t) => t.path && (t.path === path || t.path.startsWith(path + '/') || t.path.startsWith(path + '\\'))
      )
      if (dead.length === 0) return tabs
      let next = tabs
      for (const d of dead) next = closeTab(next, d.id, activeDoc, setActiveDoc, visibleDocTabs)
      return next
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
          else if (r.error) void window.lt.dialog.alert('폴더 생성 실패: ' + r.error)
        })
      }
      return
    }
    // 파일: 이름 없으면 무제 스크래치(저장 시 이름 물어봄)
    if (!n) {
      const id = newId()
      setDocTabs((t) => [
        ...t,
        { id, title: '무제.md', kind: 'mdview', caseTabId: currentCaseTabIdForNewTab(), side: 'left' }
      ])
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
        void window.lt.dialog.alert('문서 생성 실패: ' + r.error)
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

  type SendClaudeOptions = { displayText?: string; contextPath?: string; pasteOnly?: boolean }

  const focusTermTabForPrompt = (tab: TermTab): void => {
    setActiveTerm(tab.id)
    setWorkActive(termSide(tab), termKeyOf(tab.id))
    setTermFocusNonce((current) => bumpFocusNonce(current, tab.id))
  }

  const pasteDraftToAgent = (tab: TermTab & { kind: 'agent' }, payload: string): void => {
    setAgentDrafts((current) => {
      const draft = current[tab.id]
      const input = draft?.input
        ? `${draft.input}${/\s$/.test(draft.input) ? '' : '\n'}${payload}`
        : payload
      return {
        ...current,
        [tab.id]: {
          input,
          attachments: draft?.attachments ?? []
        }
      }
    })
    focusTermTabForPrompt(tab)
  }

  const sendToClaudeAgent = (
    tab: TermTab & { kind: 'agent' },
    payload: string,
    opts?: SendClaudeOptions
  ): void => {
    focusTermTabForPrompt(tab)
    void window.lt.agent.send(tab.id, { text: payload, displayText: opts?.displayText, workspaceContext: agentWorkspaceContextForTerm(tab, contextAppVersion) })
  }

  const createClaudeAgentForPrompt = (contextPath?: string): (TermTab & { kind: 'agent' }) | undefined => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const side = termSide(cur)
    const hasCaseContext = !!cur || !!currentCase
    if (!hasCaseContext && contextPath) {
      const dir = dirnameForClaudeContext(contextPath)
      const remote = dir ? parseRemoteUri(dir) : null
      if (remote) {
        const profile = sshProfiles.find((p) => p.id === remote.profileId)
        if (profile) {
          const tab = createRemoteCase(
            profile,
            remote.path,
            pathLeaf(remote.path) ?? '세션',
            undefined,
            undefined,
            side,
            'agent',
            'claude'
          )
          return isClaudeAgentTab(tab) ? tab : undefined
        }
      } else if (dir) {
        const tab = createCase(
          dir,
          pathLeaf(dir) ?? '세션',
          undefined,
          undefined,
          undefined,
          side,
          undefined,
          'claude'
        )
        return isClaudeAgentTab(tab) ? tab : undefined
      }
    }
    const tab = addAgentSame(side, activeTerm, { provider: 'claude' })
    return isClaudeAgentTab(tab) ? tab : undefined
  }

  // Claude 질문 전송: Claude Agent 탭을 우선 사용하고, 없으면 새 Claude Agent 탭에 초안으로 붙인다.
  const sendClaude = (payload: string, opts?: SendClaudeOptions): void => {
    if (docOnly) {
      void window.lt.claude.ask(payload)
      return
    }
    const tab = resolveClaudeAgentTargetTab(visibleTermTabs, activeTerm, activeWork)
    if (tab) {
      if (opts?.pasteOnly) pasteDraftToAgent(tab, payload)
      else sendToClaudeAgent(tab, payload, opts)
      return
    }
    const created = createClaudeAgentForPrompt(opts?.contextPath)
    if (created) pasteDraftToAgent(created, payload)
  }

  // 미저장 편집 중(dirty)인 md 문서 탭을 경로로 찾는다.
  const isEditableMarkdownTab = (tab: DocTab): boolean => tab.kind === 'markdown' || tab.kind === 'mdview'

  const dirtyMarkdownTabForPath = (path?: string): DocTab | undefined => {
    if (!path) return undefined
    return docTabsRef.current.find(
      (tab) => isEditableMarkdownTab(tab) && tab.path === path && dirtyDocsRef.current.has(tab.id)
    )
  }

  // dirty 문서의 현재 편집 내용으로 Claude 작업본(.claude-draft.md)을 만든다.
  // 편집기가 화면에 떠 있으면 라이브 버퍼를, 아니면 복구용 임시저장본을 쓴다.
  const createDirtyDocClaudeDraft = async (
    tab: DocTab
  ): Promise<{ draftPath: string; sourcePath?: string; sourceTitle?: string } | undefined> => {
    const handler = markdownClaudeDraftHandlersRef.current.get(tab.id)
    if (handler) {
      const draftPath = await handler().catch(() => undefined)
      if (!draftPath) return undefined
      setTreeRefresh((current) => current + 1)
      return { draftPath, sourcePath: tab.path, sourceTitle: tab.title }
    }
    if (!tab.path) return undefined
    const loaded = await window.lt.fs.loadDocumentDraft({ path: tab.path, draftId: tab.id }).catch(() => null)
    if (!loaded?.ok || !loaded.draft) return undefined
    const dir = dirnameForClaudeContext(tab.path)
    if (!dir) return undefined
    const created = await window.lt.fs
      .createFile(dir, claudeDraftFileName(tab.path, tab.title), loaded.draft.content)
      .catch(() => null)
    if (!created?.ok || !created.path) return undefined
    setTreeRefresh((current) => current + 1)
    return { draftPath: created.path, sourcePath: tab.path, sourceTitle: tab.title }
  }

  // 에이전트 패널 전송 직전: 첨부한 md 파일이 미저장 편집 중이면 작업본 첨부로 치환한다.
  const prepareAgentAttachmentForSend = async (attachment: AgentAttachment): Promise<AgentAttachment | null> => {
    if (attachment.kind !== 'file' || !attachment.path || attachment.access !== 'workspace-path') return null
    const tab =
      dirtyMarkdownTabForPath(attachment.path) ??
      docTabsRef.current.find(
        (candidate) =>
          isEditableMarkdownTab(candidate) &&
          !!candidate.path &&
          dirtyDocsRef.current.has(candidate.id) &&
          parseRemoteUri(candidate.path)?.path === attachment.path
      )
    if (!tab) return null
    const draft = await createDirtyDocClaudeDraft(tab)
    if (!draft) return null
    return {
      ...attachment,
      // 같은 SSH 프로필 첨부는 원격 URI 대신 원격 실제 경로를 쓴다 (attachmentForPath와 동일 규칙)
      path: parseRemoteUri(draft.draftPath)?.path ?? draft.draftPath,
      label: `${attachment.label} (임시저장본)`,
      source: { path: tab.path, title: tab.title },
      text: [
        attachment.text,
        '이 첨부는 사용자가 편집기에서 아직 저장하지 않은 최신 편집 내용을 담은 임시 작업본 파일입니다.',
        draft.sourcePath ? `원본 문서(디스크 저장본, 오래된 내용일 수 있음): ${draft.sourcePath}` : undefined,
        '분석과 수정은 이 작업본 파일을 기준으로 하고, 원본 문서 파일은 직접 수정하지 마세요.'
      ]
        .filter(Boolean)
        .join('\n')
    }
  }

  const buildFreshFilePrompt = async (
    path: string,
    label: string,
    term?: TermTab,
    draft?: ClaudeDraftPromptOptions
  ): Promise<string> => {
    const stat = await window.lt.fs.stat(path).catch((e) => ({
      ok: false as const,
      error: String(e)
    }))
    const readablePath = claudeReadablePath(path, term)
    const sourceReadablePath = draft?.sourcePath ? claudeReadablePath(draft.sourcePath, term) : undefined
    const isClaudeDraft = !!draft?.sourcePath && draft.sourcePath !== path
    const note = fileAccessNote(path, term)
    const lines = [
      isClaudeDraft ? 'Claude 작업본 파일:' : '작업 기준 파일:',
      `- 파일명: ${label}`,
      `- 앱 경로: ${path}`,
      readablePath !== path ? `- Claude가 직접 읽을 경로: ${readablePath}` : undefined,
      isClaudeDraft ? `- 원본 문서: ${draft?.sourceTitle || pathLeaf(draft?.sourcePath) || '원본 문서'}` : undefined,
      isClaudeDraft && draft?.sourcePath ? `- 원본 앱 경로: ${draft.sourcePath}` : undefined,
      isClaudeDraft && sourceReadablePath && sourceReadablePath !== draft?.sourcePath
        ? `- 원본을 Claude가 직접 읽을 경로: ${sourceReadablePath}`
        : undefined,
      stat.ok
        ? `- 현재 저장본: ${stat.size} bytes, 수정시각 ${formatFileMtime(stat.mtimeMs)}`
        : `- 현재 저장본 확인 실패: ${stat.error}`,
      note ? `- ${note}` : undefined,
      '',
      '반드시 다음 순서로 진행해줘:',
      ...(isClaudeDraft
        ? [
            '1. 위 Claude 작업본 파일을 디스크에서 다시 읽는다.',
            '2. 원본 문서 경로는 비교/참고용으로만 사용하고 직접 수정하지 않는다.',
            '3. 편집이 필요하면 Claude 작업본 파일만 수정한다.',
            '4. 사용자가 원본 반영을 명시적으로 요청하기 전에는 원본 파일에 쓰지 않는다.',
            '5. 수정 후 원본과 작업본의 차이 또는 변경 요약을 알려준다.'
          ]
        : [
            '1. 위 경로의 현재 저장된 파일을 디스크에서 다시 읽는다.',
            '2. 이전 대화의 초안, 임시 파일, 기억 속 내용은 기준으로 쓰지 않는다.',
            '3. 요청한 부분만 수정하고 사용자가 편집한 다른 부분은 보존한다.',
            '4. 수정 후 변경 요약과 보존 여부를 알려준다.'
          ]),
      draft?.instruction ? '' : undefined,
      draft?.instruction ? '추가 요청:' : undefined,
      draft?.instruction,
      ''
    ].filter((line): line is string => line !== undefined)
    return lines.join('\n')
  }

  const confirmCaseFileScope = async (term: TermTab | undefined, path: string, label?: string): Promise<boolean> => {
    if (!term?.jsId) return true
    if (
      pathBelongsToCaseFolder(path, term.cwd) ||
      (!!term.recordsFolder && pathBelongsToCaseFolder(path, term.recordsFolder))
    ) return true
    return window.lt.dialog.confirm(
      `「${label || fileNameFromPath(path)}」은 현재 사건의 작성서류·소송기록 폴더 밖에 있습니다. 다른 사건 자료일 수 있습니다. 그래도 이 Agent에 첨부할까요?`
    )
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
      opts.docName ? `${opts.docPath ? '문서' : '출처'}: ${opts.docName}` : undefined,
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
  const sendClaudeRef = useRef(sendClaude)
  sendClaudeRef.current = sendClaude
  useEffect(
    () =>
      window.lt.claude.onIncoming((payload) => {
        sendClaudeRef.current(payload)
      }),
    []
  )

  // 파일 1개를 "물어보기" 형태로 전송 (경로 포함 → claude가 실제 파일을 읽음).
  const askAboutFile = async (termId: string, path: string, label: string): Promise<void> => {
    const term = termTabsRef.current.find((t) => t.id === termId)
    if (!term || !(await confirmCaseFileScope(term, path, label))) return
    if (!termTabsRef.current.some((t) => t.id === termId)) return
    const prompt = await buildFreshFilePrompt(path, label, term)
    if (!termTabsRef.current.some((t) => t.id === termId)) return
    if (isAgentTab(term)) void window.lt.agent.send(termId, { text: `${prompt}위 파일에 대해 `, workspaceContext: agentWorkspaceContextForTerm(term, contextAppVersion) })
    else pasteToTerm(termId, `${prompt}위 파일에 대해 `)
  }

  const terminalSnippetPrompt = (text: string): string =>
    [
      '다음 JSON의 text 값을 사용자가 선택한 터미널 출력 원문으로 보고 답해줘.',
      '문서 본문 선택이나 파일 인용이 아니라, 터미널 로그/응답 출력 스니펫으로만 취급해줘.',
      JSON.stringify({ kind: 'terminal-output', text }),
      ''
    ].join('\n')

  const askAboutTerminalSelection = (termId: string, text: string): void => {
    if (!text.trim()) return
    pasteToTerm(termId, terminalSnippetPrompt(text))
  }

  // 활성 문서명+경로 + (있으면) 선택 텍스트로 claude 프롬프트 주입. 텍스트 없으면 문서 전체에 대해 묻기.
  const askClaude = (text: string, opts?: ClaudeAskOptions): void => {
    const targetTab = resolveClaudeAgentTargetTab(visibleTermTabs, activeTerm, activeWork) ?? activeTermTab
    const promptTarget = targetTab ?? sessionCaseSource
    void (async () => {
      const d = docTabsRef.current.find((x) => x.id === (opts?.selectionSource?.docId ?? activeDoc))
      let docPath = opts?.docPath === null ? undefined : (opts?.docPath ?? opts?.selectionSource?.docPath ?? d?.path)
      let sourcePath = opts?.sourcePath
      let sourceTitle = opts?.sourceTitle
      // 대상 md 문서가 미저장 편집 중이면 작업본을 만들어 그걸 분석 기준으로 삼는다.
      if (!sourcePath && opts?.docPath !== null) {
        const dirtyTab = docPath
          ? dirtyMarkdownTabForPath(docPath)
          : !opts?.docPath && d && isEditableMarkdownTab(d) && dirtyDocs.has(d.id)
            ? d
            : undefined
        const draft = dirtyTab ? await createDirtyDocClaudeDraft(dirtyTab) : undefined
        if (draft) {
          docPath = draft.draftPath
          sourcePath = draft.sourcePath
          sourceTitle = draft.sourceTitle
        }
      }
      const docName =
        opts?.docPath === null
          ? undefined
          : docPath && docPath !== d?.path
            ? fileNameFromPath(docPath)
            : d?.title
      const sourceLabel = opts?.sourceLabel ?? docName
      const ref = sourceLabel ? `「${sourceLabel}」${docPath ? `(${docPath})` : ''}` : ''
      const t = text.trim()
      if (docPath && !(await confirmCaseFileScope(promptTarget, docPath, sourceLabel))) return
      if (targetTab && !termTabsRef.current.some((term) => term.id === targetTab.id)) return
      const selectionSource =
        t && opts?.selectionSource
          ? {
              ...opts.selectionSource,
              docPath: opts.selectionSource.docPath ?? docPath,
              docTitle: opts.selectionSource.docTitle ?? sourceLabel,
              text: opts.selectionSource.text ?? t
            }
          : undefined
      if (t && !docOnly) {
        const selectionTarget = isClaudeAgentTab(targetTab) ? targetTab : createClaudeAgentForPrompt(docPath)
        if (selectionTarget) {
          const attachment = selectionAttachmentForAgent(
            t,
            { docPath, docName, sourceLabel, selectionSource },
            selectionTarget
          )
          queueAgentAttachment(selectionTarget, attachment, agentSelectionInputText(attachment))
          return
        }
      }
      const filePrompt =
        docPath && docName
          ? await buildFreshFilePrompt(docPath, docName, promptTarget, {
              sourcePath,
              sourceTitle
            })
          : ''
      let payload: string
      let displayText: string | undefined
      if (t) {
        displayText = hiddenSelectionDisplay(sourceLabel, t)
        const selectionContext = await createClaudeSelectionContext(t, { docPath, docName: sourceLabel })
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
        payload = filePrompt ? `${filePrompt}${opts?.instruction ? '' : '위 파일에 대해 '}` : `${ref} 파일에 대해 `
      } else return
      const quotePage = selectionSource?.range?.startPage
      if (typeof quotePage === 'number' && Number.isSafeInteger(quotePage) && quotePage > 0) {
        payload = `인용 위치: PDF ${quotePage}쪽 (파일의 실제 쪽번호)\n${payload}`
      }
      if (targetTab && !termTabsRef.current.some((term) => term.id === targetTab.id)) return
      sendClaude(payload, { displayText, contextPath: docPath, pasteOnly: true })
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

  const summarizeHearingReportWithClaude = (path: string, title: string): void => {
    void (async () => {
      const filePrompt = await buildFreshFilePrompt(path, title, activeTermTab)
      sendClaude(
        [
          filePrompt,
          '위 기일 결과 보고서를 읽고 바로 사용할 수 있게 정리해줘.',
          '',
          '정리 형식:',
          '1. 핵심 결론',
          '2. 재판부 지시사항',
          '3. 상대방 주장/제출사항',
          '4. 우리 쪽 후속 조치',
          '5. 다음 기일까지 확인할 쟁점',
          '',
          '기록에 없는 내용은 추측하지 말고 "확인 필요"로 표시해줘.'
        ].join('\n'),
        { displayText: `「${title}」 보고서를 Claude에 정리 요청했습니다.` }
      )
    })()
  }

  // ── 사건 대시보드 동작 ──
  // 토큰 변경 등으로 좌측 '다가오는 기일' 패널을 새로고침하기 위한 nonce
  const [jsNonce, setJsNonce] = useState(0)
  const [todoNonce, setTodoNonce] = useState(0)
  const todoManagerPendingRender = useRef(false)
  const todoManagerTab = useRef<TermTab | null>(null)
  const todoAccountGeneration = useRef(0)
  const todoSnapshot = useTodoSnapshot(todoNonce)
  const caseUi = useCaseManagementUi(todoSnapshot)
  const taskStartPending = useRef(false)
  const [todoCaseFilter, setTodoCaseFilter] = useState('')
  const [upcomingHearings, setUpcomingHearings] = useState<JsUpcomingHearing[] | undefined>()
  const [hearingsComplete, setHearingsComplete] = useState(false)
  const [nextActionRequest, setNextActionRequest] = useState<NextActionRequest | null>(null)
  useEffect(() => window.lt.js.onTokenChanged(() => {
    window.dispatchEvent(new Event(JS_TOKEN_UPDATED_EVENT))
  }), [])
  useEffect(() => {
    if (!caseUi.state || !todoSnapshot.todos || todoSnapshot.error) return
    const selectionFor = (caseId?: string): string | undefined => {
      const id = caseId && caseUi.state!.ui.selectedTaskByCase[caseId]
      return id && todoSnapshot.todos!.some((todo) => todo.id === id && todo.caseId === caseId &&
        todo.type !== 'memo' && ['pending', 'in_progress'].includes(todo.status)) ? id : undefined
    }
    setTermTabs((tabs) => tabs.some((tab) => tab.selectedTaskId !== selectionFor(tab.jsId))
      ? tabs.map((tab) => ({ ...tab, selectedTaskId: selectionFor(tab.jsId) })) : tabs)
    setCaseTabs((tabs) => tabs.some((tab) => tab.selectedTaskId !== selectionFor(tab.meta?.jsId))
      ? tabs.map((tab) => ({ ...tab, selectedTaskId: selectionFor(tab.meta?.jsId) })) : tabs)
  }, [caseUi.state, todoSnapshot.todos, todoSnapshot.error, termTabs, caseTabs])
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('open')
  const [todoFilterNonce, setTodoFilterNonce] = useState(0)
  const [contextAppVersion, setContextAppVersion] = useState<string>()
  const [hearingSummary, setHearingSummary] = useState<{todayCount: number; weekCount: number; fetchedAt: string} | null>(null)
  const [summaryHearingsError, setSummaryHearingsError] = useState('')
  const [summaryHearingsLoading, setSummaryHearingsLoading] = useState(false)
  useEffect(() => { void window.lt.app.info().then((info) => setContextAppVersion(info.version)).catch(() => {}) }, [])
  useEffect(() => {
    let cancelled = false
    if (todoSnapshot.hasToken !== true) {
      setHearingSummary(null)
      setUpcomingHearings(undefined)
      setHearingsComplete(false)
      setSummaryHearingsLoading(false)
      return
    }
    setSummaryHearingsLoading(true)
    setHearingsComplete(false)
    void window.lt.js.upcomingHearings().then(async (result) => {
      if (cancelled) return
      if (result.ok && result.complete && result.hearings) {
        const today = kstDateKey(new Date())
        setUpcomingHearings(result.hearings)
        setHearingsComplete(true)
        setHearingSummary({ todayCount: result.hearings.filter((h) => kstDateKey(h.dateTime) === today).length,
          weekCount: result.hearings.length, fetchedAt: result.fetchedAt ?? new Date().toISOString() })
        setSummaryHearingsError('')
      } else {
        setSummaryHearingsError(result.error ?? '기일 전체 목록을 확인하지 못했습니다.')
        const fallback = await window.lt.js.hearingSummary()
        if (!cancelled && fallback.ok && fallback.summary) setHearingSummary(fallback.summary)
      }
    }).catch((error) => { if (!cancelled) setSummaryHearingsError(String(error)) })
      .finally(() => { if (!cancelled) setSummaryHearingsLoading(false) })
    return () => { cancelled = true }
  }, [jsNonce, todoSnapshot.hasToken, todoSnapshot.fetchedAt])
  const openTodoSummary = (filter: TodoFilter = 'open'): void => {
    setTodoCaseFilter('')
    setTodoFilter(filter)
    setTodoFilterNonce((value) => value + 1)
    setMode('todos')
  }
  const openGlobalTodoWork = async (rows?: JsTodo[]): Promise<void> => {
    const accountGeneration = todoAccountGeneration.current
    try {
      const settings = await window.lt.settings.get()
      const profileId = caseOpenProfileId(settings.caseOpenTarget)
      const profile = settings.sshProfiles?.find((item) => item.id === profileId)
      if (profileId && !profile) throw new Error('기본 원격 연결을 찾을 수 없습니다. 설정에서 연결을 확인해 주세요.')
      let cwd = profile ? profile.draftsRoot?.trim() : settings.draftsRoot
      if (profile && (!cwd || !cwd.startsWith('/'))) {
        const resolved = await window.lt.ssh.listDir(profile, cwd || '~')
        if (!resolved.ok) throw new Error(resolved.error)
        cwd = resolved.cwd
      } else if (!profile && (!cwd || parseRemoteUri(cwd))) {
        cwd = (await window.lt.app.info()).homeDirectory
      }
      if (!cwd) throw new Error('할일 대화의 작업 위치를 확인하지 못했습니다.')
      if (accountGeneration !== todoAccountGeneration.current) return
      const atLocation = (term: TermTab): boolean =>
        normalizedCasePathKey(term.cwd) === normalizedCasePathKey(cwd) && (profile
          ? term.profileId === profile.id && term.ssh?.host === profile.host && term.ssh?.user === profile.user &&
            (term.ssh?.port ?? 22) === (profile.port ?? 22) && term.ssh?.identityFile === profile.identityFile &&
            Boolean(term.ssh?.remoteControl) === Boolean(profile.remoteControl)
          : !term.ssh)
      const manager = termTabsRef.current.find((term) => isAgentTab(term) && term.contextKind === 'global' && atLocation(term) &&
        (term.todoManagement === true || (term.todoManagement === undefined && term.title === '전체 할일 정리')))
      let tab = manager ?? (todoManagerTab.current && atLocation(todoManagerTab.current) ? todoManagerTab.current : null)
      if (tab && !termTabsRef.current.some((term) => term.id === tab!.id) && !todoManagerPendingRender.current) tab = null
      if (!tab) {
        // Resolve the destination before this synchronous creation, so rapid clicks reuse the pending tab.
        tab = profile
          ? createRemoteCase(profile, cwd, '전체 할일 정리', { contextKind: 'global' }, undefined, 'right')
          : createCase(cwd, '전체 할일 정리', undefined, undefined, { contextKind: 'global' }, 'right')
        todoManagerPendingRender.current = true
      }
      const selected = { ...tab, todoManagement: true, side: 'right' as const }
      todoManagerTab.current = selected
      setTermTabs((tabs) => tabs.map((item) => item.id === selected.id ? selected : item))
      registerCaseTabFromTerm(selected, true)
      setActiveTerm(selected.id)
      setWorkActive('right', termKeyOf(selected.id))
      if (rows?.length) {
        const prompt = todoAgentPrompt(rows)
        queueAgentAttachment(selected, { kind: 'selection', label: `선택한 할일 ${rows.length}건`, text: prompt }, '첨부한 선택 할일만 정리해줘.')
      }
      setTermFocusNonce((current) => ({ ...current, [selected.id]: (current[selected.id] ?? 0) + 1 }))
      setMode('todos')
    } catch (error) {
      if (accountGeneration === todoAccountGeneration.current) {
        await window.lt.dialog.alert('할일 에이전트를 열지 못했습니다: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
  useEffect(() => {
    if (todoManagerTab.current && termTabs.some((term) => term.id === todoManagerTab.current!.id)) todoManagerPendingRender.current = false
    else if (!todoManagerPendingRender.current) todoManagerTab.current = null
  }, [termTabs])
  const selectedWorkspaceTask = todoSnapshot.todos?.find((todo) => todo.id ===
    caseUi.state?.ui.selectedTaskByCase[currentCase?.meta?.jsId ?? ''] &&
    todo.caseId === currentCase?.meta?.jsId && todo.type !== 'memo' && ['pending', 'in_progress'].includes(todo.status))
  const todoSummary = <><TodoSummary snapshot={todoSnapshot} onFilter={openTodoSummary}
    onGlobalWork={() => void openGlobalTodoWork()} hearingSummary={hearingSummary}
    upcomingHearings={upcomingHearings} hearingsComplete={hearingsComplete}
    onOpenCase={(c) => void openCaseDefault(c)}
    hearingsLoading={summaryHearingsLoading} hearingsError={summaryHearingsError} />
    <TodayTodos snapshot={todoSnapshot} caseUi={caseUi} onChanged={() => setTodoNonce((n) => n + 1)}
      onStartTask={startCaseTask} onAskNextAction={askNextAction} onOpenTodos={() => openTodoSummary()} />
  </>

  // 설정창에서 JuriSupport 토큰을 바꾸면 기일·할 일 패널도 새로고침한다.
  useEffect(() => {
    const onTokenUpdated = (): void => {
      todoAccountGeneration.current++
      setNextActionRequest(null)
      setWorkspaceSyncError('')
      remoteCasePickerResolve.current?.(undefined)
      remoteCasePickerResolve.current = null
      setRemoteCasePick(null)
      todoManagerTab.current = null
      setTermTabs((tabs) => tabs.map((term) => ({ ...term, selectedTaskId: undefined,
        ...(term.contextKind === 'global' && (term.todoManagement || term.title === '전체 할일 정리') ? { todoManagement: false } : {}) })))
      setCaseTabs((tabs) => tabs.map((tab) => ({ ...tab, selectedTaskId: undefined })))
      setUpcomingHearings(undefined)
      setHearingsComplete(false)
      setJsNonce((n) => n + 1)
      setTodoNonce((n) => n + 1)
    }
    window.addEventListener(JS_TOKEN_UPDATED_EVENT, onTokenUpdated)
    return () => window.removeEventListener(JS_TOKEN_UPDATED_EVENT, onTokenUpdated)
  }, [])
  // 세션 목록 드롭다운 + 사건 필터('all' | jsId | '__folder__')
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  // claude 완료 주목 표시가 필요한 터미널 id 집합 + 진행중/완료 상태
  const [termAttention, setTermAttention] = useState<Set<string>>(new Set())
  const [termStatus, setTermStatus] = useState<Map<string, TermRunStatus>>(new Map())
  const termStatusRef = useRef(termStatus)
  termStatusRef.current = termStatus
  const [toasts, setToasts] = useState<{
    key: number
    termId: string
    title: string
    status: 'done' | 'question'
  }[]>([])

  // 독/작업표시줄 배지 = 미확인 완료·질문 개수
  useEffect(() => {
    window.lt.app.setBadgeCount(new Set([
      ...termAttention,
      ...[...termStatus].filter(([, status]) => status === 'question').map(([id]) => id)
    ]).size)
  }, [termAttention, termStatus])

  // 창 포커스 복귀 → 화면에 보이는 작업의 알림(배지·토스트·OS 알림)은 확인한 것으로 처리.
  // OS 알림 클릭 → 해당 터미널/에이전트 탭으로 이동.
  const notifyFocusAckRef = useRef<() => void>(() => {})
  notifyFocusAckRef.current = () => {
    const visible = [...termAttention].filter((id) => isTermVisibleInCurrentWorkspace(id))
    if (visible.length === 0) return
    setTermAttention((s) => {
      const n = new Set(s)
      for (const id of visible) n.delete(id)
      return n
    })
    for (const id of visible) {
      dismissToastForTerm(id)
      window.lt.app.dismissNotify(id)
    }
  }
  const selectTermRef = useRef<(id: string) => void>(() => {})
  selectTermRef.current = selectTerm
  useEffect(() => {
    const onFocus = (): void => notifyFocusAckRef.current()
    window.addEventListener('focus', onFocus)
    const offActivate = window.lt.app.onNotifyActivate((termId) => selectTermRef.current(termId))
    return () => {
      window.removeEventListener('focus', onFocus)
      offActivate()
    }
  }, [])

  const termsForCaseTab = (tab: CaseWorkspaceTab): TermTab[] =>
    termTabs.filter((term) => caseIdForTerm(term) === tab.id)
  const docsForCaseTab = (tab: CaseWorkspaceTab): DocTab[] =>
    docTabs.filter((doc) => !isSharedDocTab(doc) && caseIdForDoc(doc) === tab.id)
  const caseTabRows = caseTabs.map((tab) => {
    const terms = termsForCaseTab(tab)
    const docs = docsForCaseTab(tab)
    const documentUpdates = caseDocumentUpdates[tab.id]
    const active =
      tab.id === activeCaseTabId ||
      terms.some((term) => term.id === activeTerm) ||
      docs.some((doc) => doc.id === activeDoc)
    const noticeTerms = terms.filter((term) => termStatus.get(term.id) === 'question' ||
      (termAttention.has(term.id) && termStatus.get(term.id) === 'done'))
    const documentUpdateCount = documentUpdates?.paths.length ?? 0
    const working = terms.some((term) => termStatus.get(term.id) === 'working')
    const questionTaskCount = noticeTerms.filter((term) => termStatus.get(term.id) === 'question').length
    const doneTaskCount = noticeTerms.filter((term) => termStatus.get(term.id) === 'done').length
    const tabCount = terms.length + docs.length
    return {
      tab,
      terms,
      docs,
      noticeTerms,
      active,
      documentUpdateCount,
      documentUpdateLatestAt: documentUpdates?.latestAt,
      questionTaskCount,
      doneTaskCount,
      status: documentUpdateCount
        ? `업데이트 ${documentUpdateCount}개`
        : questionTaskCount
          ? `확인 대기 ${questionTaskCount}개`
          : working
            ? '작업 중'
            : doneTaskCount
              ? `완료 ${doneTaskCount}개`
            : tabCount
              ? `${tabCount}개 탭`
              : '작업 탭 없음'
      }
  })
  const visibleCaseTabRows = caseAttentionOnly
    ? caseTabRows.filter((row) => row.questionTaskCount + row.doneTaskCount + row.documentUpdateCount > 0)
    : caseTabRows
  const totalCaseDocumentUpdateCount = caseTabRows.reduce((sum, row) => sum + row.documentUpdateCount, 0)
  const totalCaseDoneTaskCount = caseTabRows.reduce((sum, row) => sum + row.doneTaskCount, 0)
  const totalCaseQuestionTaskCount = caseTabRows.reduce((sum, row) => sum + row.questionTaskCount, 0)
  const totalCaseNoticeCount =
    totalCaseDocumentUpdateCount + totalCaseQuestionTaskCount + totalCaseDoneTaskCount
  const caseTabsShortcut = platform === 'darwin' ? '⌘0' : 'Ctrl+0'
  const closeCaseTabShortcut = platform === 'darwin' ? '⌘⇧W' : 'Ctrl+Shift+W / Ctrl+Alt+W'
  const caseTabActivityTitle =
    totalCaseNoticeCount > 0
      ? `사건탭 · ${[
          totalCaseDocumentUpdateCount > 0 ? `업데이트 ${totalCaseDocumentUpdateCount}개` : undefined,
          totalCaseQuestionTaskCount > 0 ? `확인 대기 ${totalCaseQuestionTaskCount}개` : undefined,
          totalCaseDoneTaskCount > 0 ? `완료 작업 ${totalCaseDoneTaskCount}개` : undefined
        ]
          .filter(Boolean)
          .join(' · ')} (${caseTabsShortcut})`
      : `사건탭 (${caseTabsShortcut})`
  const caseTabActivityBadgeClass =
    totalCaseDocumentUpdateCount > 0
      ? 'update'
      : totalCaseQuestionTaskCount > 0
        ? 'question'
        : totalCaseDoneTaskCount > 0
          ? 'done'
          : ''
  const caseTabActivityBadgeCount = totalCaseNoticeCount > 0 ? totalCaseNoticeCount : caseTabs.length
  const caseTabTitle = (tab: CaseWorkspaceTab): string =>
    [
      tab.meta?.court ? abbrevCourt(tab.meta.court) : undefined,
      tab.meta?.caseNumber,
      tab.meta?.caseName,
      tab.meta?.client
    ]
      .filter(Boolean)
      .join(' ') ||
    tab.name ||
    pathLeaf(tab.remotePath ?? tab.drafts) ||
    '사건'
  const caseTabSubtitle = (tab: CaseWorkspaceTab): string =>
    joinStatus([
      tab.sshLabel ? `원격 ${tab.sshLabel}` : '로컬',
      tab.records ? '소송기록 연결' : undefined,
      tab.remotePath ?? tab.drafts
    ])

  // 열린 탭과 열어본 사건을 같은 사건 식별 규칙으로 합쳐 탐색 목록을 만든다.
  const sidebarCaseTabs = [...caseTabs]
  for (const tab of discoveredCaseTabs) {
    if (tab.profileId && !sshProfiles.some((profile) => profile.id === tab.profileId &&
      sessionListKey('', sshConnFromProfile(profile)) === sessionListKey('', tab.ssh))) continue
    if (!findCaseTab(sidebarCaseTabs, tab)) sidebarCaseTabs.push(tab)
  }
  for (const entry of recent) {
    const remote = parseRemoteUri(entry.drafts)
    const profile = remote ? sshProfiles.find((item) => item.id === remote.profileId) : undefined
    const source: CurrentCase = {
      ...entry,
      profileId: remote?.profileId,
      remotePath: remote?.path,
      ssh: profile ? sshConnFromProfile(profile) : undefined,
      sshLabel: profile?.label
    }
    const existing = findCaseTab(sidebarCaseTabs, source)
    if (existing) {
      // 대화 제목으로 갱신된 작업 탭 이름 대신 사건을 열 때 저장한 이름을 표시한다.
      sidebarCaseTabs[sidebarCaseTabs.indexOf(existing)] = { ...existing, name: entry.name }
      continue
    }
    sidebarCaseTabs.push({ ...caseTabFromCurrentCase(source), id: caseTabId(source, sidebarCaseTabs), updatedAt: entry.ts })
  }
  const sidebarCases: SidebarCase[] = sidebarCaseTabs.map((tab) => {
    const saved = savedCaseLabels.find((entry) => entry.label === tab.name &&
      entry.profileId === tab.profileId &&
      normalizedCasePathKey(entry.cwd) === normalizedCasePathKey(tab.remotePath ?? tab.drafts) &&
      (!tab.meta?.caseNumber || entry.caseNumber === tab.meta.caseNumber))
    return {
      id: tab.id,
      title: [tab.meta?.caseNumber ?? saved?.caseNumber, tab.meta?.caseName ?? saved?.caseName].filter(Boolean).join(' ') || tab.name || '사건',
      participants: tab.meta?.partyNames || [tab.meta?.client ?? saved?.client, tab.meta?.opponent].filter(Boolean).join(' / ') || undefined,
      subtitle: caseTabSubtitle(tab),
      active: tab.id === activeCaseTabId,
      updatedAt: tab.updatedAt ?? 0,
      historyKey: sessionListKey(tab.remotePath ?? tab.drafts, tab.ssh, sessionContextForTerm(currentCaseSessionSource(tab, sshProfiles))),
      unavailable: !!tab.profileId && !tab.ssh,
      tasks: termsForCaseTab(tab).map((term) => ({
        id: term.id,
        title: term.sessionTitle || term.title,
        mtime: term.createdAt ?? 0,
        originDevice: term.originDevice,
        sessionId: term.agentProvider === 'codex' ? undefined : term.resumeSessionId,
        active: tab.id === activeCaseTabId && isTermVisibleInCurrentWorkspace(term.id),
        status: termStatus.get(term.id) === 'working' ? '작업 중'
          : termStatus.get(term.id) === 'question' ? '확인 대기'
            : termAttention.has(term.id) ? '완료' : undefined
      }))
    }
  })
  const projectCaseChoices: ProjectCaseLink[] = sidebarCaseTabs
    .filter((tab) => tab.meta?.contextKind !== 'global' && tab.meta?.contextKind !== 'folder' && tab.meta?.contextKind !== 'project')
    .map((tab) => ({
      key: tab.meta?.jsId ? `js:${tab.meta.jsId}` : `folder:${tab.profileId ?? 'local'}:${normalizedCasePathKey(tab.remotePath ?? tab.drafts)}`,
      name: sidebarCases.find((item) => item.id === tab.id)?.title ?? tab.name,
      jsId: tab.meta?.jsId,
      caseNumber: tab.meta?.caseNumber,
      court: tab.meta?.court,
      drafts: tab.drafts,
      records: tab.records,
      profileId: tab.profileId,
      remotePath: tab.remotePath
    }))
  const projectAgentVisible = projectManagementVisible && !!selectedProjectId &&
    currentCase?.meta?.projectId === selectedProjectId && termTabs.some((term) =>
      isAgentTab(term) && term.contextKind === 'project' && term.projectId === selectedProjectId && termSide(term) === 'right'
    )
  const openProjectWork = (project: Project, newConversation = false): Promise<void> => {
    const pending = projectOpeningRef.current.get(project.id)
    if (pending) return pending
    const operation = (async (): Promise<void> => {
      const { cwd, project: latest } = await window.lt.projects.workspace(project.id)
      const source: CurrentCase = {
        drafts: cwd, name: `프로젝트 · ${latest.name}`,
        meta: { contextKind: 'project', projectId: latest.id }
      }
      markWorkspaceReopened(source)
      const workspace = registerCaseTab(source)
      setCurrentCase(source)
      activeCaseTabIdRef.current = workspace.id
      if (!(await restoreAutomaticWorkspace(source))) throw new Error('프로젝트 대화를 복원하지 못했습니다. 다시 시도해 주세요.')
      const conversations = termTabsRef.current.filter((term) => isAgentTab(term) &&
        term.contextKind === 'project' && term.projectId === latest.id && term.cwd === cwd && !term.ssh)
      let tab = !newConversation
        ? conversations.find((term) => term.id === activeTerm) ?? conversations.find((term) => term.id === workspace.activeTermId) ?? conversations[0]
        : undefined
      if (!tab) {
        tab = createCase(cwd, source.name, undefined, undefined, source.meta, 'right')
        // Keep rapid navigation and workspace persistence aware of a newly queued React tab.
        termTabsRef.current = [...termTabsRef.current, tab]
      }
      const selected = { ...tab, side: 'right' as const }
      setTermTabs((tabs) => tabs.map((item) => item.id === selected.id ? selected : item))
      registerCaseTabFromTerm(selected, true)
      setCurrentCase(source)
      setActiveTerm(selected.id)
      setWorkActive('right', termKeyOf(selected.id))
      setTermFocusNonce((current) => bumpFocusNonce(current, selected.id))
      setSelectedProjectId(latest.id)
      setCaseDashboardView('projects')
      setMode('cases')
    })().finally(() => { projectOpeningRef.current.delete(project.id) })
    projectOpeningRef.current.set(project.id, operation)
    return operation
  }
  const showProjects = (): void => {
    setCaseDashboardView('projects')
    setMode('cases')
    setExplorerVisible(true)
  }
  const pickProjectFolder = async (): Promise<ProjectFolderLink | null> => {
    const settings = await window.lt.settings.get()
    const profiles = settings.sshProfiles ?? []
    setSshProfiles(profiles)
    if (!profiles.length) return window.lt.dialog.pickFolder({ title: '프로젝트 참고 폴더 선택' })
    return new Promise((resolve, reject) => setProjectFolderPick({ resolve, reject }))
  }
  const openProjectFolder = async (folder: ProjectFolderLink): Promise<void> => {
    const remote = parseRemoteUri(folder.path)
    const existing = sidebarCaseTabs.find((tab) =>
      tab.meta?.contextKind !== 'global' && tab.profileId === remote?.profileId &&
      normalizedCasePathKey(tab.remotePath ?? tab.drafts) === normalizedCasePathKey(remote?.path ?? folder.path)
    )
    // A reference can point at an existing case folder; preserve its known case identity.
    if (existing && (!remote || existing.ssh)) {
      if (caseTabs.some((tab) => tab.id === existing.id)) openCaseTab(existing)
      else openCaseContext(currentCaseFromCaseTab(existing))
      setSidebarView('files')
      setMode('explorer')
      return
    }
    if (remote) {
      const settings = await window.lt.settings.get()
      const profile = settings.sshProfiles?.find((item) => item.id === remote.profileId)
      if (!profile) throw new Error('참고 폴더의 SSH 연결 설정을 찾을 수 없습니다. 설정에서 연결을 확인해 주세요.')
      openRemoteCaseContext(profile, remote.path, folder.name, existing?.meta ?? { contextKind: 'folder' })
    } else {
      const result = await window.lt.fs.stat(folder.path)
      if (!result.ok || !result.isDir) throw new Error('참고 폴더를 찾을 수 없습니다. 이동하거나 삭제되었는지 확인해 주세요.')
      openCaseContext({ drafts: folder.path, name: folder.name, meta: { contextKind: 'folder' } })
    }
    setSidebarView('files')
    setMode('explorer')
  }
  const openProjectCase = async (item: ProjectCaseLink): Promise<void> => {
    const tab = sidebarCaseTabs.find((candidate) =>
      candidate.profileId === item.profileId &&
      (item.jsId ? candidate.meta?.jsId === item.jsId :
        !!item.drafts && normalizedCasePathKey(candidate.drafts) === normalizedCasePathKey(item.drafts))
    )
    if (tab && (!tab.profileId || tab.ssh)) {
      if (caseTabs.some((entry) => entry.id === tab.id)) openCaseTab(tab)
      else {
        openCaseContext(currentCaseFromCaseTab(tab))
        setMode('explorer')
      }
      return
    }
    if (item.drafts || (item.profileId && item.remotePath)) {
      const remote = item.drafts ? parseRemoteUri(item.drafts) : null
      const profileId = item.profileId ?? remote?.profileId
      const meta: CaseMeta = { jsId: item.jsId, caseNumber: item.caseNumber, court: item.court, caseName: item.name }
      if (profileId) {
        const settings = await window.lt.settings.get()
        const profile = settings.sshProfiles?.find((entry) => entry.id === profileId)
        if (!profile) throw new Error('이 사건의 SSH 연결 설정을 찾을 수 없습니다. 설정에서 연결을 확인해 주세요.')
        const path = item.remotePath ?? remote?.path
        if (!path) throw new Error('원격 사건의 작성서류 폴더를 확인해 주세요.')
        openRemoteCaseContext(profile, path, item.name, meta, item.records)
      } else {
        if (!item.drafts) throw new Error('사건의 작성서류 폴더를 확인해 주세요.')
        const result = await window.lt.fs.stat(item.drafts)
        if (!result.ok || !result.isDir) throw new Error('사건 폴더를 찾을 수 없습니다. 사건을 다시 열고 프로젝트 연결을 수정해 주세요.')
        openCaseContext({ drafts: item.drafts, records: item.records, name: item.name, meta })
      }
      setMode('explorer')
      return
    }
    if (!item.jsId) throw new Error('열 수 있는 사건 정보가 없습니다. 프로젝트의 사건 연결을 수정해 주세요.')
    const result = await window.lt.js.getCase(item.jsId)
    if (!result.ok || !result.case) throw new Error(result.error || '사건을 불러오지 못했습니다. JuriSupport 연결을 확인해 주세요.')
    const settings = await window.lt.settings.get()
    const profiles = settings.sshProfiles ?? []
    const profileId = caseOpenProfileId(resolveCaseOpenTarget(settings.caseOpenTarget, profiles))
    const profile = profiles.find((entry) => entry.id === profileId)
    if (profile) await openCaseRemote(result.case, profile)
    else await openCaseWorkspace(result.case, true)
  }
  const sidebarSessionSource = (id: string): TermTab | undefined => {
    const tab = sidebarCaseTabs.find((item) => item.id === id)
    if (!tab || (tab.profileId && !tab.ssh)) return undefined
    const source = currentCaseSessionSource(tab, sshProfiles)
    return source ? { ...source, caseTabId: resolveCaseTabId(tab) } : undefined
  }
  const openSidebarTask = (caseId: string, task: SidebarTask): void => {
    const tab = sidebarCaseTabs.find((item) => item.id === caseId)
    if (!tab) return
    const term = termsForCaseTab(tab).find((item) => item.id === task.id)
    if (term) {
      if (!term.originDevice && task.originDevice) {
        setTermTabs((tabs) => tabs.map((item) => item.id === term.id ? { ...item, originDevice: task.originDevice } : item))
      }
      openCaseTab(tab, { side: termSide(term), key: termKeyOf(term.id) })
      return
    }
    const source = sidebarSessionSource(caseId)
    if (source && task.sessionId) {
      openPastSession(task.sessionId, source.cwd, task.title, source, undefined, undefined, false, task.originDevice)
      setMode('explorer')
    }
  }
  const newSidebarTask = (caseId: string): void => {
    const tab = sidebarCaseTabs.find((item) => item.id === caseId)
    if (!tab) return
    if (tab.profileId) {
      const saved = sshProfiles.find((profile) => profile.id === tab.profileId)
      const profile = saved ?? (tab.ssh ? { ...tab.ssh, id: tab.profileId, label: tab.sshLabel ?? tab.name } : undefined)
      const remotePath = tab.remotePath ?? parseRemoteUri(tab.drafts)?.path
      if (!profile || !remotePath) {
        void window.lt.dialog.alert('이 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 확인하세요.')
        return
      }
      createRemoteCase(profile, remotePath, tab.name, tab.meta, tab.records)
    } else {
      createCase(tab.drafts, tab.name, tab.records, tab.suggestedRecords, tab.meta, 'right', tab.suggestedRecordOptions)
    }
    setMode('explorer')
  }

  const openCaseTab = (tab: CaseWorkspaceTab, targetWork?: { side: DockSide; key: WorkTabKey }): void => {
    const terms = termsForCaseTab(tab)
    const docs = docsForCaseTab(tab)
    const target = targetWork ? parseWorkKey(targetWork.key) : null
    const preferred =
      terms.find((term) => target?.kind === 'terminal' && term.id === target.id) ||
      terms.find((term) => term.id === tab.activeTermId) ||
      terms.find((term) => term.id === activeTerm) ||
      terms[0]
    const preferredDoc =
      docs.find((doc) => target?.kind === 'doc' && doc.id === target.id) ||
      docs.find((doc) => doc.id === tab.activeDocId) ||
      docs.find((doc) => doc.id === activeDoc) ||
      docs[0]
    const source = currentCaseFromCaseTab(tab)
    const pastSessionSource = currentCaseSessionSource(source, sshProfiles)
    setCurrentCase(source)
    setActiveCaseTabId(tab.id)
    preloadPastSessions(pastSessionSource?.cwd, pastSessionSource)
    setCaseTabs((tabs) =>
      upsertCaseTab(tabs, {
        ...tab,
        activeDocId: target?.kind === 'doc' ? target.id : preferredDoc?.id ?? tab.activeDocId,
        activeTermId: preferred?.id ?? tab.activeTermId,
        updatedAt: Date.now()
      })
    )
    setCaseTabsOpen(false)
    setMode('explorer')
    const validKeys = new Set([
      ...docs.map((doc) => docKey(doc.id)),
      ...terms.map((term) => termKeyOf(term.id))
    ])
    const firstKeyForSide = (side: DockSide): string => {
      const doc = docs.find((item) => docSide(item) === side)
      if (doc) return docKey(doc.id)
      const term = terms.find((item) => termSide(item) === side)
      return term ? termKeyOf(term.id) : ''
    }
    const nextWork = {
      left:
        isWorkKey(tab.activeWork?.left) && validKeys.has(tab.activeWork.left)
          ? tab.activeWork.left
          : firstKeyForSide('left'),
      right:
        isWorkKey(tab.activeWork?.right) && validKeys.has(tab.activeWork.right)
          ? tab.activeWork.right
          : firstKeyForSide('right')
    }
    if (targetWork) nextWork[targetWork.side] = targetWork.key
    setActiveWork(nextWork)
    const viewedTerms = terms.filter((term) => nextWork[termSide(term)] === termKeyOf(term.id))
    setTermAttention((ids) => {
      const next = new Set(ids)
      for (const term of viewedTerms) next.delete(term.id)
      return next.size === ids.size ? ids : next
    })
    for (const term of viewedTerms) {
      dismissToastForTerm(term.id)
      window.lt.app.dismissNotify(term.id)
    }
    for (const doc of docs) {
      if (nextWork[docSide(doc)] === docKey(doc.id)) clearCaseDocumentUpdates(tab.id, doc.path)
    }
    updateCaseTabActivity(tab.id, {
      activeDocId: target?.kind === 'doc' ? target.id : preferredDoc?.id ?? tab.activeDocId,
      activeTermId: preferred?.id ?? tab.activeTermId,
      activeWork: nextWork
    })
    if (target?.kind === 'doc') setActiveDoc(target.id)
    else if (preferredDoc) setActiveDoc(preferredDoc.id)
    if (preferred) {
      setActiveTerm(preferred.id)
      if (isAgentTab(preferred)) {
        setTermFocusNonce((current) => bumpFocusNonce(current, preferred.id))
      }
      return
    }
    setActiveTerm('')
  }

  const openNextCaseAttention = (): void => {
    const targets = caseTabRows.flatMap(({ tab, noticeTerms }) => [
      ...noticeTerms.map((term) => ({ key: termKeyOf(term.id), tab, term, path: undefined as string | undefined })),
      ...(caseDocumentUpdates[tab.id]?.paths ?? []).map((path) => ({
        key: `${tab.id}:path:${path}`, tab, term: undefined as TermTab | undefined, path
      }))
    ])
    if (!targets.length) return
    // 읽은 완료가 목록에서 사라져도, 아직 남은 질문과 다른 사건을 차례로 방문한다.
    const pending = new Map(targets.map((target) => [target.key, target]))
    const order = [...new Set([...caseAttentionOrderRef.current, ...pending.keys()])]
      .filter((key) => pending.has(key))
    const target = pending.get(order[0])!
    caseAttentionOrderRef.current = [...order.slice(1), order[0]]
    if (target.term) {
      selectTerm(target.term.id)
      openCaseTab(target.tab, { side: termSide(target.term), key: termKeyOf(target.term.id) })
      focusWorkTargetSoon(termSide(target.term), termKeyOf(target.term.id), true)
    } else if (target.path) {
      const id = openFile(target.path, pathLeaf(target.path) ?? target.path, 'left', target.tab.id)
      const side = docSide(docTabs.find((doc) => doc.id === id))
      openCaseTab(target.tab, { side, key: docKey(id) })
      focusWorkTargetSoon(side, docKey(id), true)
    }
  }

  const pickRecordsForCaseTab = (tabId: string): void => {
    const tab = caseTabs.find((item) => item.id === tabId)
    if (!tab) return
    const preferred =
      termsForCaseTab(tab).find((term) => term.id === tab.activeTermId) ??
      termsForCaseTab(tab)[0]
    openCaseTab(tab)
    setCaseTabContextMenu(null)
    void pickRecords({
      term: preferred,
      termId: preferred?.id,
      source: currentCaseFromCaseTab(tab)
    })
  }

  const hasLocalTermWork = (term: TermTab): boolean =>
    !isAgentTab(term) || ['working', 'question'].includes(termStatusRef.current.get(term.id) ?? '') ||
    hasAgentDraft(agentDraftsRef.current[term.id]) || !!agentAttachmentRequestsRef.current[term.id]?.length

  const closeCaseTab = async (tabId: string, fromSync = false): Promise<void> => {
    const tab = caseTabsRef.current.find((item) => item.id === tabId)
    if (!tab) return
    const docs = docTabsRef.current.filter((doc) => !isSharedDocTab(doc) && caseIdForDoc(doc) === tabId)
    const terms = termTabsRef.current.filter((term) => caseIdForTerm(term) === tabId)
    const dirty = docs.filter((doc) => dirtyDocsRef.current.has(doc.id))
    if (fromSync) {
      const key = workspaceLocationKey(currentCaseFromCaseTab(tab))
      const retain = dirty.length > 0 || terms.some(hasLocalTermWork) || inlineSelection?.caseId === tabId
      setRetainedSharedCases((current) => {
        const next = new Set(current)
        if (retain) next.add(key)
        else next.delete(key)
        return next
      })
      if (retain) return
    }
    if (dirty.length > 0) {
      const names = dirty.slice(0, 5).map((doc) => `- ${doc.title}`)
      const more = dirty.length > names.length ? `\n- 외 ${dirty.length - names.length}개` : ''
      if (
        !(await window.lt.dialog.confirm(
          `이 사건탭에 저장하지 않은 문서가 있습니다.\n\n${names.join('\n')}${more}\n\n사건탭을 닫을까요?`
        ))
      )
        return
    }
    if (!caseTabsRef.current.some((item) => item.id === tabId)) return
    const working = terms.filter((term) => termStatus.get(term.id) === 'working')
    if (working.length > 0 && !(await window.lt.dialog.confirm('이 사건탭에 아직 작업 중인 Claude/Agent가 있습니다. 닫을까요?'))) {
      return
    }

    if (!caseTabsRef.current.some((item) => item.id === tabId)) return
    autoSaveEligibleRef.current.add(tabId)
    const closingSnapshot = fromSync ? undefined : await buildWorkspaceSnapshot(tabId)
    if (closingSnapshot) {
      closingSnapshot.workspaceLabel = tab.name
      closingSnapshot.workspaceOpen = false
      closingSnapshot.workspaceIntentId = newId()
    }
    if (!caseTabsRef.current.some((item) => item.id === tabId)) return
    const docIds = new Set(docs.map((doc) => doc.id))
    const termIds = new Set(terms.map((term) => term.id))
    if (
      docTabsRef.current.some((doc) => !isSharedDocTab(doc) && caseIdForDoc(doc) === tabId && !docIds.has(doc.id)) ||
      termTabsRef.current.some((term) => caseIdForTerm(term) === tabId && !termIds.has(term.id))
    ) return
    const source = currentCaseFromCaseTab(tab)
    pendingWorkspaceReopensRef.current.delete(workspaceLocationKey(source))
    closedAutomaticCasesRef.current.add(workspaceLocationKey(source))
    const closingIndex = caseTabsRef.current.findIndex((item) => item.id === tabId)
    const nextCaseTab = caseTabsRef.current[closingIndex + 1] ?? caseTabsRef.current[closingIndex - 1]
    caseTabsRef.current = caseTabsRef.current.filter((item) => item.id !== tabId)
    const saveClosedCase = async (): Promise<void> => {
      if (!closingSnapshot) return
      if (pendingCaseClosesRef.current.get(workspaceLocationKey(source)) !== saveClosedCase) return
      const result = await window.lt.workspace.autoSave(closingSnapshot, workspaceLocation(source))
      if (!result.ok || result.remoteError) throw new Error(result.remoteError || result.error || '사건탭 닫힘 공유 실패')
      if (pendingCaseClosesRef.current.get(workspaceLocationKey(source)) === saveClosedCase) {
        pendingCaseClosesRef.current.delete(workspaceLocationKey(source))
      }
    }
    if (!fromSync) {
      pendingCaseClosesRef.current.set(workspaceLocationKey(source), saveClosedCase)
      autoWorkspaceSaveChainRef.current = autoWorkspaceSaveChainRef.current.then(saveClosedCase)
        .catch(() => setWorkspaceSyncError('사건탭 닫힘 공유 실패 · 연결 후 다시 시도합니다'))
    }
    for (const term of terms) {
      if (!termTabsRef.current.some((item) => item.id === term.id)) continue
      if (isAgentTab(term)) void window.lt.agent.close(term.id)
      else window.lt.pty.kill(term.id)
    }
    setDocTabs((tabs) => tabs.filter((doc) => !docIds.has(doc.id)))
    setTermTabs((tabs) => tabs.filter((term) => !termIds.has(term.id)))
    setDirtyDocs((ids) => {
      const next = new Set(ids)
      for (const id of docIds) next.delete(id)
      return next
    })
    setPdfStatus((status) => {
      const next = { ...status }
      for (const id of docIds) delete next[id]
      return next
    })
    setAgentAttachmentRequests((requests) => {
      const next = { ...requests }
      for (const id of termIds) delete next[id]
      return next
    })
    setAgentDrafts((drafts) => {
      const next = { ...drafts }
      for (const id of termIds) delete next[id]
      return next
    })
    setAgentDraftClearNonce((nonces) => {
      const next = { ...nonces }
      for (const id of termIds) delete next[id]
      return next
    })
    setTermAttention((ids) => {
      const next = new Set(ids)
      for (const id of termIds) next.delete(id)
      return next
    })
    setTermStatus((status) => {
      const next = new Map(status)
      for (const id of termIds) next.delete(id)
      return next
    })
    setTermBracketedPasteMode((modes) => {
      const next = { ...modes }
      for (const id of termIds) delete next[id]
      return next
    })
    setCaseTabs((tabs) => tabs.filter((item) => item.id !== tabId))
    setCaseTabContextMenu(null)
    const sourceKey = workspaceLocationKey(currentCaseFromCaseTab(tab))
    autoRestoreDoneRef.current.delete(sourceKey)
    autoSaveEligibleRef.current.delete(tabId)

    if (activeCaseTabIdRef.current !== tabId) return
    setDocTabs((tabs) => tabs.filter((doc) => doc.kind !== 'welcome'))
    setActiveCaseTabId('')
    setCurrentCase(null)
    setActiveDoc('')
    setActiveTerm('')
    setActiveWork({ left: '', right: '' })
    setFolderRecord(null)
    setPdfRecord(null)
    setMode('explorer')
    setCaseTabsOpen(false)
    if (nextCaseTab) openCaseTab(nextCaseTab)
  }
  closeActiveCaseTabRef.current = (): void => {
    const tabId = activeCaseTabId || caseTabRows.find((row) => row.active)?.tab.id
    if (tabId) void closeCaseTab(tabId)
  }

  const cycleCaseTab = (dir: number): void => {
    if (caseTabRows.length === 0) return
    const rowsById = new Map(caseTabRows.map((row) => [row.tab.id, row]))
    const orderedIds: string[] = []
    const seen = new Set<string>()
    for (const id of caseTabCycleOrderRef.current) {
      if (!rowsById.has(id) || seen.has(id)) continue
      orderedIds.push(id)
      seen.add(id)
    }
    for (const row of caseTabRows) {
      if (seen.has(row.tab.id)) continue
      orderedIds.push(row.tab.id)
      seen.add(row.tab.id)
    }
    caseTabCycleOrderRef.current = orderedIds
    if (orderedIds.length < 2) return

    const currentId =
      activeCaseTabId && rowsById.has(activeCaseTabId)
        ? activeCaseTabId
        : caseTabRows.find((row) => row.active)?.tab.id
    const currentIndex = currentId ? orderedIds.indexOf(currentId) : -1
    const baseIndex = currentIndex < 0 ? (dir > 0 ? -1 : 0) : currentIndex
    const nextIndex =
      ((baseIndex + dir) % orderedIds.length + orderedIds.length) % orderedIds.length
    const nextRow = rowsById.get(orderedIds[nextIndex])
    if (nextRow) openCaseTab(nextRow.tab)
  }

  const updatePdfStatus = (status: PdfViewStatus): void => {
    const key = pdfStatusKey(status.path)
    setPdfStatus((s) => (samePdfStatus(s[key], status) ? s : { ...s, [key]: status }))
  }
  const updateDocScrollPosition = (tabId: string, position: DocScrollPosition): void => {
    setDocScrollPositions((s) => (sameDocScrollPosition(s[tabId], position) ? s : { ...s, [tabId]: position }))
  }
  const scrollPositionForDoc = (tab: DocTab): DocScrollPosition | undefined => {
    const key = docScrollKey(tab)
    const position = docScrollPositions[tab.id]
    return position?.key === key ? position : undefined
  }
  const pdfStatusForTab = (tab: DocTab): PdfViewStatus | undefined => {
    const status = pdfStatus[pdfStatusKey(tab.path)] ?? pdfStatus[tab.id]
    return status?.path === tab.path ? status : undefined
  }
  const activePdfStatus = activeDocTab?.kind === 'pdf' ? pdfStatusForTab(activeDocTab) : undefined
  const activeTermRunStatus = activeTerm ? termStatus.get(activeTerm) : undefined
  const selectionStatus = selectionCharCount > 0 ? `선택 ${formatCharCount(selectionCharCount)}자` : undefined
  const statusInfo =
    joinStatus([
      selectionStatus,
      describeDocStatus(activeDocTab, !!activeDocTab && dirtyDocs.has(activeDocTab.id), activePdfStatus),
      describeCaseStatus(activeTermTab, currentCase),
      describeRecordsStatus(activeRecordsFolder, activeSuggestedRecords, !!(activeTermTab || currentCase)),
      describeTermStatus(activeTermTab, activeTermRunStatus),
      bridgeStatus || workspaceSyncError || undefined,
      retainedSharedCases.size ? '다른 PC에서 닫은 사건 · 이 PC의 미저장·진행 중 작업은 유지됩니다' : undefined
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
  const closeTermWithConfirm = async (id: string): Promise<boolean> => {
    if (!termTabsRef.current.some((term) => term.id === id)) return false
    if (termStatus.get(id) === 'working') {
      if (!(await window.lt.dialog.confirm('claude가 아직 작업 중입니다. 이 터미널을 닫을까요?'))) return false
    }
    if (!termTabsRef.current.some((term) => term.id === id)) return false
    return closeTerm(id)
  }
  const closeCurrentWindowSoon = (): void => {
    window.setTimeout(() => void window.lt.app.closeWindow(), 0)
  }
  const closeDetachedDoc = async (id: string): Promise<void> => {
    if (await closeDoc(id)) {
      if (docOnly && docTabsRef.current.every((tab) => tab.id === id)) closeCurrentWindowSoon()
    }
  }
  const closeDetachedTerm = async (id: string): Promise<void> => {
    if (await closeTermWithConfirm(id)) {
      if (termOnly && termTabsRef.current.every((tab) => tab.id === id)) closeCurrentWindowSoon()
    }
  }
  const detachDocAfterMove = async (id: string): Promise<void> => {
    if (await closeDoc(id, { confirmDirty: false })) {
      if (docOnly && docTabsRef.current.every((tab) => tab.id === id)) closeCurrentWindowSoon()
    }
  }
  const detachTermAfterMove = (id: string): void => {
    const shouldCloseWindow = termOnly && termTabs.length <= 1
    if (detachTerm(id) && shouldCloseWindow) closeCurrentWindowSoon()
  }
  closeActiveTermRef.current = (): void => {
    if (activeTerm) void closeDetachedTerm(activeTerm)
  }
  closeActiveTabRef.current = (): void => {
    const activeEl = document.activeElement as HTMLElement | null
    const termId = focusedTermId(activeEl)
    const docId = focusedDocId(activeEl)
    if (termId && termTabs.some((t) => t.id === termId)) {
      void closeDetachedTerm(termId)
      return
    }
    if (docId && docTabs.some((d) => d.id === docId)) {
      void closeDetachedDoc(docId)
      return
    }
    const side = focusedWorkSide(activeEl)
    const parsed = side ? parseWorkKey(activeWork[side]) : null
    if (parsed?.kind === 'terminal') {
      void closeDetachedTerm(parsed.id)
      return
    }
    if (parsed?.kind === 'doc') {
      void closeDetachedDoc(parsed.id)
      return
    }
    if (activeTerm) {
      void closeDetachedTerm(activeTerm)
      return
    }
    if (activeDoc) void closeDetachedDoc(activeDoc)
    else if ((docOnly && docTabs.length === 0) || (termOnly && termTabs.length === 0)) {
      closeCurrentWindowSoon()
    }
  }

  const caseRef = (c: JsCase): string => `${c.caseNumber ?? ''} ${c.caseName ?? ''}`.trim() || c.id
  const loadCaseDetail = async (c: JsCase): Promise<JsCase> => {
    if (!c.id) return c
    try {
      const result = await window.lt.js.getCase(c.id)
      const detail =
        result.ok && result.case && typeof result.case === 'object'
          ? (result.case as Partial<JsCase>)
          : null
      if (!detail) return c
      return {
        ...c,
        ...detail,
        parties: Array.isArray(detail.parties) ? detail.parties : c.parties,
        hearings: Array.isArray(detail.hearings) ? detail.hearings : c.hearings,
        memo: detail.memo ?? c.memo
      } as JsCase
    } catch {
      return c
    }
  }

  const hearingCaseFromJsCase = (c: JsCase): HearingRecordCase => {
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const opponent = c.parties
      .filter((p) => p.role === 'opponent')
      .map((p) => p.party.name)
      .join(', ')
    return {
      jsId: c.id || undefined,
      court: c.court || undefined,
      division: c.division || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined,
      opponent: opponent || undefined,
      partyNames: [client, opponent].filter(Boolean).join(' / ') || undefined,
      memo: c.memo?.trim() || undefined,
      title: caseRef(c)
    }
  }

  const hearingCaseFromCurrent = (c: CurrentCase): HearingRecordCase => ({
    ...c.meta,
    title: c.name
  })

  const nearestHearing = (hearings?: JsHearing[]): JsHearing | undefined => {
    const valid = (hearings ?? [])
      .filter(isActiveHearing)
      .map((h) => ({ hearing: h, time: new Date(h.dateTime).getTime() }))
      .filter((item) => Number.isFinite(item.time))
      .sort((a, b) => Math.abs(a.time - Date.now()) - Math.abs(b.time - Date.now()))
    return valid[0]?.hearing
  }

  const openHearingRecordTab = async (
    drafts: string,
    hearingCase: HearingRecordCase,
    hearing?: JsHearing,
    side: DockSide = 'right'
  ): Promise<void> => {
    // 해당 날짜의 기록이 없으면 같은 사건의 최근 기록을 이어서 연다.
    const path = await resolveHearingRecordPath(drafts, hearingCase, hearing)
    const existing = docTabs.find((tab) => tab.kind === 'hearing' && tab.path === path)
    if (existing) {
      moveDocToSide(existing.id, side)
      return
    }
    const tab: DocTab = {
      id: newId(),
      title: buildHearingRecordTitle(hearingCase, hearing),
      kind: 'hearing',
      caseTabId: currentCaseTabIdForNewTab(activeTermTab),
      path,
      hearingCase,
      hearingDrafts: drafts,
      hearing,
      side
    }
    setDocTabs((tabs) => [...tabs, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }

  const openHearingRecordForCurrent = (side: DockSide = 'right'): void => {
    const source = activeTermTab ? currentCaseFromTerm(activeTermTab) : currentCase
    if (!source?.drafts) return
    void openHearingRecordTab(source.drafts, hearingCaseFromCurrent(source), undefined, side)
  }

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
      return rankCaseFolders(
        list.filter((entry) => entry.isDir),
        caseFolderInfo(c)
      )
    } catch {
      return []
    }
  }

  const matchCaseFolder = async (root: string, c: JsCase): Promise<string | undefined> =>
    trustedCaseFolder(await matchCaseFolders(root, c), caseFolderInfo(c))

  const canonicalLocalDrafts = async (folder: string): Promise<string> => {
    if (!draftsRoot) return folder
    const candidate = rebaseCaseFolderToRoot(folder, draftsRoot)
    if (candidate === folder) return folder
    const result = await window.lt.fs.stat(candidate).catch(() => null)
    return result?.ok && result.isDir ? candidate : folder
  }

  // 좌클릭: 사건 작업환경 열기 (폴더 매칭 → 없으면 직접 지정 → 사건 컨텍스트 연결)
  const openCaseWorkspace = async (
    c: JsCase,
    detailLoaded = false,
    activateExistingTerm = true
  ): Promise<OpenedCase | null> => {
    const account = todoAccountGeneration.current
    // 사건 선택 즉시 탐색기로 전환 — 상세 조회·폴더 매칭이 끝날 때까지 대시보드에 머물지 않는다
    setMode('explorer')
    if (!detailLoaded) c = await loadCaseDetail(c)
    if (account !== todoAccountGeneration.current) return null
    const saved = c.id ? await window.lt.case.getJsPairing(c.id) : undefined
    let drafts = saved?.drafts ? await canonicalLocalDrafts(saved.drafts) : undefined
    let records = saved?.records
    let recordSuggestions: FolderMatchSuggestion[] = []
    if (draftsRoot) {
      const matched = await matchCaseFolder(draftsRoot, c)
      if (!drafts || (matched && !pathBelongsToCaseFolder(drafts, matched))) drafts = matched ?? drafts
    }
    if (!records && recordsRoot) {
      const resolved = resolveFolderMatch(await matchCaseFolders(recordsRoot, c))
      records = resolved.records
      recordSuggestions = resolved.records ? [] : (resolved.suggestions ?? [])
    }
    if (account !== todoAccountGeneration.current) return null
    if (!drafts) {
      // 자동 매칭 실패 → 사용자가 직접 작성서류 폴더 지정
      const picked = await window.lt.dialog.pickFolder({
        title: `「${caseRef(c)}」 작성서류 폴더 선택`,
        defaultPath: draftsRoot
      })
      if (!picked) return null
      drafts = await canonicalLocalDrafts(picked.path)
    }
    if (account !== todoAccountGeneration.current) return null
    if (c.id) await window.lt.case.setJsPairing(c.id, drafts, records)
    if (account !== todoAccountGeneration.current) return null
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
      partyNames: partyNames || undefined,
      memo: c.memo?.trim() || undefined
    }
    const openedCase: CurrentCase = {
      drafts,
      records,
      suggestedRecords: suggested,
      suggestedRecordOptions: recordSuggestions.length ? recordSuggestions : undefined,
      name,
      meta
    }
    const existing = termTabsRef.current.find((t) => !t.ssh && t.cwd === drafts &&
      t.contextKind !== 'global' && (!t.jsId || t.jsId === c.id))
    let term: TermTab | undefined
    let termId: string | undefined
    if (existing) {
      term = existing
      termId = existing.id
      if (activateExistingTerm) activateTermTab(existing.id)
      openCaseContext(openedCase, existing.id)
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
      openCaseContext(openedCase)
    }
    return { ...openedCase, term, termId }
  }

  const pickRecordsForCase = async (c: JsCase): Promise<void> => {
    const opened = await openCaseWorkspace(c)
    if (!opened) return
    await pickRecords({ term: opened.term, termId: opened.termId, source: opened })
  }

  const findSshProfile = async (profileId: string): Promise<SshProfile | undefined> => {
    const cached = sshProfiles.find((profile) => profile.id === profileId)
    if (cached) return cached
    try {
      const profiles = (await window.lt.settings.get()).sshProfiles ?? []
      setSshProfiles(profiles)
      return profiles.find((profile) => profile.id === profileId)
    } catch {
      return undefined
    }
  }

  // 대시보드 작업 이력에서 과거 세션 이어하기: 사건 작업환경을 연 뒤 그 세션을 복원한다.
  const resumeCaseSession = async (
    c: JsCase,
    s: CaseSessionSummary,
    forceNew = false
  ): Promise<void> => {
    if (s.profileId) {
      if (!s.cwd) {
        await window.lt.dialog.alert('원격 세션의 작업 폴더 정보가 없어 이어서 열 수 없습니다.')
        return
      }
      const profile = await findSshProfile(s.profileId)
      if (!profile) {
        await window.lt.dialog.alert('이 세션에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
        return
      }
      const opened = await openCaseRemote(c, profile, s.cwd)
      if (!opened) return
      openPastSession(s.sessionId, s.cwd, s.title, undefined, undefined, opened.source, forceNew, s.originDevice)
      return
    }
    const opened = await openCaseWorkspace(c)
    if (!opened) return
    openPastSession(
      s.sessionId,
      s.cwd ?? opened.drafts,
      s.title,
      opened.term,
      undefined,
      opened,
      forceNew,
      s.originDevice
    )
  }

  const resumePathSession = async (
    sessionId: string,
    cwd: string,
    title?: string,
    profileId?: string,
    forceNew = false,
    originDevice?: TermTab['originDevice']
  ): Promise<void> => {
    setMode('explorer')
    if (!profileId) {
      openPastSession(sessionId, cwd, title, undefined, undefined, undefined, forceNew, originDevice)
      return
    }
    const profile = await findSshProfile(profileId)
    if (!profile) {
      await window.lt.dialog.alert('이 세션에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      return
    }
    const opened = openRemoteCaseContext(profile, cwd, title)
    resolveRemoteRecordsLater(opened.id, profile, cwd, opened.title)
    openPastSession(sessionId, cwd, title, undefined, undefined, opened.source, forceNew, originDevice)
  }

  const openHearingRecordForCase = async (c: JsCase): Promise<void> => {
    setMode('explorer')
    const existing = docTabsRef.current.find(
      (tab) => tab.kind === 'hearing' && tab.hearingCase?.jsId === c.id
    )
    if (existing) {
      if (existing.caseTabId) setActiveCaseTabId(existing.caseTabId)
      moveDocToSide(existing.id, 'right')
      return
    }

    // 재판정에서는 웹·폴더 조회보다 입력창이 먼저 열려야 한다.
    const shellCase = hearingCaseFromJsCase(c)
    const shellHearing = nearestHearing(c.hearings)
    const shellSource: CurrentCase = {
      drafts: '',
      name: caseRef(c),
      meta: {
        jsId: shellCase.jsId,
        court: shellCase.court,
        caseNumber: shellCase.caseNumber,
        caseName: shellCase.caseName,
        client: shellCase.client,
        opponent: shellCase.opponent,
        partyNames: shellCase.partyNames,
        memo: shellCase.memo
      }
    }
    const knownCaseTab = caseTabs.find((tab) => tab.id === resolveCaseTabId(shellSource))
    const shellCaseTab = knownCaseTab ?? registerCaseTab(shellSource)
    if (knownCaseTab) setActiveCaseTabId(knownCaseTab.id)
    const shellTab: DocTab = {
      id: newId(),
      title: buildHearingRecordTitle(shellCase, shellHearing),
      kind: 'hearing',
      caseTabId: shellCaseTab.id,
      hearingCase: shellCase,
      hearing: shellHearing,
      side: 'right'
    }
    setCurrentCase(knownCaseTab ? currentCaseFromCaseTab(knownCaseTab) : shellSource)
    setDocTabs((tabs) => [...tabs, shellTab])
    setActiveDoc(shellTab.id)
    setWorkActive('right', docKey(shellTab.id))
    updateCaseTabActivity(shellCaseTab.id, {
      activeDocId: shellTab.id,
      activeWork: { ...activeWork, right: docKey(shellTab.id) }
    })

    const detail = await loadCaseDetail(c)
    const opened = await openCaseWorkspace(detail, true, false)
    if (!opened) return
    const hearingCase = hearingCaseFromJsCase(detail)
    const hearing = nearestHearing(detail.hearings)
    const path = await resolveHearingRecordPath(opened.drafts, hearingCase, hearing)
    setDocTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === shellTab.id
          ? {
              ...tab,
              title: buildHearingRecordTitle(hearingCase, hearing),
              caseTabId: resolveCaseTabId(opened),
              path,
              hearingCase,
              hearingDrafts: opened.drafts,
              hearing
            }
          : tab
      )
    )
  }

  // 우클릭: 사건을 원격(SSH 프로필)에서 열기 — 원격 draftsRoot에서 폴더명 매칭, 실패 시 수동 선택.
  const [remoteCasePick, setRemoteCasePick] = useState<{
    profile: SshProfile
    name: string
    meta: CaseMeta
    caseData: JsCase
    account: number
  } | null>(null)
  const remoteCasePickerResolve = useRef<((result: { id: string; title: string; source: CurrentCase } | undefined) => void) | null>(null)
  const openCaseRemote = async (
    c: JsCase,
    profile: SshProfile,
    remotePath?: string
  ): Promise<{ id: string; title: string; source: CurrentCase } | undefined> => {
    const account = todoAccountGeneration.current
    // 사건 선택 즉시 탐색기로 전환 — 상세 조회·원격 폴더 매칭(SSH)이 끝날 때까지 대시보드에 머물지 않는다
    setMode('explorer')
    c = await loadCaseDetail(c)
    if (account !== todoAccountGeneration.current) return undefined
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
      partyNames: partyNames || undefined,
      memo: c.memo?.trim() || undefined
    }
    if (remotePath) {
      const opened = openRemoteCaseContext(profile, remotePath, name, meta)
      resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, c)
      return opened
    }
    const saved = c.id ? await window.lt.case.getJsPairing(remoteJsPairingKey(profile.id, c.id)) : undefined
    if (account !== todoAccountGeneration.current) return undefined
    const savedRemote = saved?.drafts ? parseRemoteUri(saved.drafts) : null
    const savedRecords = saved?.records
    if (savedRemote?.profileId === profile.id) {
      const opened = openRemoteCaseContext(profile, savedRemote.path, name, meta, savedRecords)
      if (!savedRecords) resolveRemoteRecordsLater(opened.id, profile, savedRemote.path, opened.title, c)
      return opened
    }
    // 원격 작성서류 루트에서 폴더명(사건번호/당사자) 자동 매칭
    let matchedUri: string | undefined
    if (profile.draftsRoot) {
      matchedUri = await matchCaseFolder(remoteUri(profile.id, profile.draftsRoot), c)
    }
    if (account !== todoAccountGeneration.current) return undefined
    if (matchedUri) {
      const remotePath = remotePlain(matchedUri, profile.id)
      if (c.id) await window.lt.case.setJsPairing(remoteJsPairingKey(profile.id, c.id), matchedUri)
      if (account !== todoAccountGeneration.current) return undefined
      const opened = openRemoteCaseContext(profile, remotePath, name, meta)
      // 소송기록 매칭은 사건 컨텍스트를 먼저 띄운 뒤 비동기로 붙인다.
      resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, c)
      return opened
    } else {
      // 작성서류 매칭 실패 → 폴더 선택기로 직접 지정 (소송기록은 picker onPick에서 resolve)
      remoteCasePickerResolve.current?.(undefined)
      return new Promise((resolve) => {
        remoteCasePickerResolve.current = resolve
        setRemoteCasePick({ profile, name, meta, caseData: c, account })
      })
    }
  }

  const openCaseDefault = async (c: JsCase): Promise<CurrentCase | null> => {
    const account = todoAccountGeneration.current
    let profiles = sshProfiles
    let target = resolveCaseOpenTarget(caseOpenTarget, profiles)
    try {
      const settings = await window.lt.settings.get()
      profiles = settings.sshProfiles ?? []
      target = resolveCaseOpenTarget(settings.caseOpenTarget, profiles)
      setSshProfiles(profiles)
      setCaseOpenTarget(target)
    } catch {
      // 현재 렌더의 설정 state로 폴백한다.
    }
    if (account !== todoAccountGeneration.current) return null
    const profileId = caseOpenProfileId(target)
    const profile = profileId ? profiles.find((p) => p.id === profileId) : undefined
    if (profile) return (await openCaseRemote(c, profile))?.source ?? null
    return openCaseWorkspace(c)
  }

  async function openTaskWorkspace(todo: JsTodo): Promise<{ tab: CaseWorkspaceTab; task: JsTodo } | null> {
    if (taskStartPending.current) return null
    const account = todoAccountGeneration.current
    taskStartPending.current = true
    try {
      const live = await window.lt.todo.get(todo.id)
      if (account !== todoAccountGeneration.current) return null
      if (!live.ok || !live.todo) throw new Error(live.error || '현재 할일을 확인하지 못했습니다.')
      const task = live.todo
      if (task.type === 'memo' || !['pending', 'in_progress'].includes(task.status)) {
        todoSnapshot.refresh()
        throw new Error('이미 처리되었거나 변경된 할일입니다. 목록을 다시 확인해 주세요.')
      }
      if (!task.caseId) throw new Error('이 할일에 사건이 연결되어 있지 않습니다. 사건을 연결한 뒤 작업환경을 열어 주세요.')
      if (todo.caseId && todo.caseId !== task.caseId) throw new Error('할일의 연결 사건이 변경되었습니다. 목록을 다시 확인해 주세요.')
      const current = await window.lt.js.getCase(task.caseId)
      if (account !== todoAccountGeneration.current) return null
      if (!current.ok || !current.case) throw new Error(current.error || '사건에 접근할 수 없습니다.')
      let tab = caseTabsRef.current.find((item) => item.meta?.jsId === task.caseId)
      if (tab) {
        openCaseTab(tab)
        await autoRestoreWorkspaceRef.current(currentCaseFromCaseTab(tab))
        if (account !== todoAccountGeneration.current) return null
        tab = caseTabsRef.current.find((item) => item.meta?.jsId === task.caseId)
      }
      else {
        const opened = await openCaseDefault(current.case)
        if (!opened || account !== todoAccountGeneration.current) return null
        await autoRestoreWorkspaceRef.current(opened)
        if (account !== todoAccountGeneration.current) return null
        tab = caseTabsRef.current.find((item) => item.meta?.jsId === task.caseId)
      }
      if (!tab) throw new Error('사건 작업환경을 확인하지 못했습니다.')
      if (!await caseUi.update((ui) => ({ selectedTaskByCase: {
        ...ui.selectedTaskByCase, [task.caseId!]: task.id
      } }))) throw new Error('다음 할일 선택을 저장하지 못했습니다. 개인 선택을 새로 불러온 뒤 다시 시도해 주세요.')
      if (account !== todoAccountGeneration.current) return null
      openCaseTab(tab)
      setCaseTabs((tabs) => tabs.map((item) => item.id === tab!.id ? { ...item, selectedTaskId: task.id } : item))
      setTermTabs((tabs) => tabs.map((item) => item.jsId === task.caseId ? { ...item, selectedTaskId: task.id } : item))
      todoSnapshot.refresh()
      return { tab, task }
    } finally { taskStartPending.current = false }
  }

  async function startCaseTask(todo: JsTodo): Promise<void> { await openTaskWorkspace(todo) }

  function openCaseTodos(caseId: string): void {
    setTodoCaseFilter(caseId)
    setTodoFilter('open')
    setTodoFilterNonce((value) => value + 1)
    setMode('todos')
  }

  function askNextAction(todo: JsTodo): void {
    const account = todoAccountGeneration.current
    void openTaskWorkspace(todo).then((opened) => {
      if (!opened || account !== todoAccountGeneration.current) return
      const { tab, task } = opened
      const source = currentCaseFromCaseTab(tab)
      let agent = termTabsRef.current.find((term) => isAgentTab(term) && term.jsId === todo.caseId &&
        caseIdForTerm(term) === tab.id)
      if (!agent) {
        if (source.ssh && source.profileId && source.remotePath) {
          const profile = sshProfiles.find((item) => item.id === source.profileId)
          if (!profile) throw new Error('원격 연결을 확인해 주세요.')
          agent = createRemoteCase(profile, source.remotePath, source.name, source.meta, source.records, 'right')
        } else agent = createCase(source.drafts, source.name, source.records, undefined, source.meta, 'right')
      }
      const request = { id: newId(), task, sessionId: agent.id }
      setNextActionRequest(request)
      const text = [`[next-action:${request.id}]`, todoAgentPrompt([task]), '',
        '이 할일에서 지금 시작할 수 있는 작은 다음 행동 하나만 제안해줘. 완료나 저장은 하지 마.',
        '제안 첫 줄은 "다음 행동: 구체적인 행동"으로 쓰고, 근거와 확인할 점을 짧게 알려줘. 원문에 없는 기한은 만들지 마.'].join('\n')
      queueAgentAttachment(agent, { kind: 'selection', label: '다음 행동 제안 요청', text },
        '첨부한 할일의 다음 행동 하나를 제안해줘. 아직 저장하거나 실행하지 마.')
    }).catch((error) => { if (account === todoAccountGeneration.current) void window.lt.dialog.alert(String(error)) })
  }

  // 우클릭: Claude에 사건 브리핑 요청
  const briefCaseToClaude = (c: JsCase): void => {
    const idPart = c.id ? `(JuriSupport id: ${c.id})` : ''
    sendClaude(`「${caseRef(c)}」 사건${idPart}의 다가오는 기일과 진행상황을 정리해줘.\n`)
  }
  // 탐색기/외부에서 터미널로 드래그드롭한 파일들을 그 터미널 프롬프트에 주입.
  const dropFilesToTerm = (termId: string, paths: string[]): void => {
    if (!paths.length) return
    const tab = termTabs.find((t) => t.id === termId)
    setActiveTerm(termId)
    setWorkActive(termSide(tab), termKeyOf(termId))
    if (paths.length === 1) {
      const p = paths[0]
      void askAboutFile(termId, p, p.split(/[\\/]/).pop() ?? p)
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
  useEffect(() => {
    if (!tabDragging) return
    const clear = (): void => setTabDragging(false)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [tabDragging])
  // 탭 드래그 중일 때 셸 어디서든 dragover를 허용(이동 커서) — 실제 찢기는 onDragEnd가 처리.
  const shellDragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!tabDragging && !e.dataTransfer.types.includes(TAB_DND_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: React.DragEvent) => {
      setTabDragging(false)
      if (tabDragging || e.dataTransfer.types.includes(TAB_DND_TYPE)) e.preventDefault()
    }
  }

  // 본문(문서) 렌더 — 좌/우 작업 영역과 '문서 전용 창'에서 재사용
  const renderDocContent = (tab?: DocTab): ReactNode => (
    <>
      {!tab && <Empty label="열린 문서가 없습니다" actionLabel="새 문서" onAction={() => addDoc('left')} />}
      {tab?.kind === 'welcome' && <Welcome recent={recent} onOpen={openRecent} summary={todoSummary} />}
      {tab?.kind === 'file' && tab.path && (
        isHtmlPath(tab.path) ? (
          <HtmlView key={tab.path} path={tab.path} onAsk={askClaude}
            onInline={docOnly ? undefined : openInlineSelection} inlineOpen={Boolean(inlineSelection)} />
        ) : (
          <FileView
            key={tab.path}
            path={tab.path}
            scrollKey={docScrollKey(tab)}
            initialScroll={scrollPositionForDoc(tab)}
            onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
          />
        )
      )}
      {tab?.kind === 'media' && tab.path && (
        <MediaViewer
          key={tab.id}
          path={tab.path}
          active={docOnly ? activeDoc === tab.id : visibleDocTabs.some((item) => item.id === tab.id) && activeWorkKeyForSide(docSide(tab)) === docKey(tab.id)}
          projectDir={mediaProjectDir(tab.path)}
          initialState={tab.mediaState}
          reveal={mediaReveals[tab.id]}
          onStateChange={(state) => setDocTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, mediaState: state } : item))}
          onAsk={askMedia}
          onRemotionPreview={() => void openRemotion(mediaProjectDir(tab.path!))}
        />
      )}
      {tab?.kind === 'image' && (
        <ImageViewer
          key={tab.path}
          path={tab.path as string}
          scrollKey={docScrollKey(tab)}
          initialScroll={scrollPositionForDoc(tab)}
          onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
          onNavigate={(dir) => navigateImage(tab.path as string, dir)}
        />
      )}
      {tab?.kind === 'hwp' && (
        <HwpView
          key={tab.path}
          path={tab.path as string}
          scrollKey={docScrollKey(tab)}
          initialScroll={scrollPositionForDoc(tab)}
          onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
        />
      )}
      {tab?.kind === 'docx' && (
        <DocxView
          key={tab.path}
          path={tab.path as string}
          scrollKey={docScrollKey(tab)}
          initialScroll={scrollPositionForDoc(tab)}
          onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
        />
      )}
      {tab?.kind === 'csv' && (
        <CsvView
          key={tab.path}
          path={tab.path as string}
          scrollKey={docScrollKey(tab)}
          initialScroll={scrollPositionForDoc(tab)}
          onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
        />
      )}
      {tab?.kind === 'hearing' && (
        <HearingRecordPanel
          key={tab.id}
          draftsDir={tab.hearingDrafts ?? activeDraftsFolder}
          initialCase={tab.hearingCase ?? (currentCase ? hearingCaseFromCurrent(currentCase) : undefined)}
          initialHearing={tab.hearing}
          initialPath={tab.path}
          visible={activeDoc === tab.id}
          onSavedPath={(path, title) =>
            setDocTabs((tabs) =>
              tabs.some((item) => item.id === tab.id && (item.path !== path || item.title !== title))
                ? tabs.map((item) => (item.id === tab.id ? { ...item, path, title } : item))
                : tabs
            )
          }
          onOpenReport={(path, title) => openFile(path, title, 'left')}
          onSummarizeReport={summarizeHearingReportWithClaude}
          onTasksChanged={() => setTodoNonce((value) => value + 1)}
        />
      )}
      {(tab?.kind === 'mdview' || tab?.kind === 'markdown') && (
        <MarkdownEditor
          key={tab.id}
          title={tab.title}
          path={tab.path}
          draftId={tab.id}
          platform={platform}
          defaultDir={draftsRoot}
          plainText={isPlainTextEditPath(tab.path)}
          onPath={(p) => setDocPath(tab.id, p)}
          scrollKey={docScrollKey(tab)}
          initialScroll={scrollPositionForDoc(tab)}
          onScrollPosition={(position) => updateDocScrollPosition(tab.id, position)}
          revealRequest={markdownRevealRequests[tab.id]}
          onAsk={(draftPath, meta) => {
            if (draftPath) {
              setTreeRefresh((current) => current + 1)
              openFile(draftPath, fileNameFromPath(draftPath), docSide(tab), caseIdForDoc(tab))
            }
            askClaude('', { docPath: draftPath, ...meta })
          }}
          onSendToJuriSupport={sendMarkdownToJuriSupport}
          onSaveHandler={(handler) => {
            if (handler) markdownSaveHandlersRef.current.set(tab.id, handler)
            else markdownSaveHandlersRef.current.delete(tab.id)
          }}
          onClaudeDraftHandler={(handler) => {
            if (handler) markdownClaudeDraftHandlersRef.current.set(tab.id, handler)
            else markdownClaudeDraftHandlersRef.current.delete(tab.id)
          }}
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
            jumpTo={pdfJump?.docId === tab.id ? pdfJump : undefined}
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
            initialStatus={pdfStatusForTab(tab)}
            onStatus={updatePdfStatus}
          />
        ) : (
          <PdfViewer
            key={tab.path}
            path={tab.path as string}
            onOutline={onOutline}
            jumpTo={pdfJump?.docId === tab.id ? pdfJump : undefined}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onAskDoc={() => askClaude('')}
            initialStatus={pdfStatusForTab(tab)}
            onStatus={updatePdfStatus}
          />
        ))}
      {tab?.kind === 'diff' && <DiffPreview diff={agentDiffs[tab.diffId ?? '']?.diff} alwaysExpanded />}
      {tab?.kind === 'settings' && <SettingsView onSync={showSync} />}
    </>
  )

  const docTabBar = (
    <TabBar
      tabs={docTabs.map((t) => ({
        id: t.id,
        title: t.title,
        tooltip: t.path,
        path: t.path,
        dirty: dirtyDocs.has(t.id),
        renamable: t.kind === 'mdview' || t.kind === 'markdown',
        dragPayload: dirtyDocs.has(t.id) ? undefined : docTabDragPayload(t, docSide(t))
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
      onRefresh={() => setTreeRefresh((current) => current + 1)}
      onRemotionPreview={() => void openRemotion(activeDraftsFolder)}
      onOpenFile={openFile}
      onDropTo={copyFilesTo}
      onMove={moveEntry}
      onRename={renameEntry}
      onDelete={deleteEntry}
      onPasteTo={pasteFilesTo}
      onDownload={downloadEntries}
      onSyncFile={sshProfiles.length > 0 ? openFileSync : undefined}
      onOpenWorkspaceFromFolder={openFolderInNewWorkspace}
      onGoParentFolder={goParentDraftsFolder}
      onPickDrafts={pickDrafts}
      onPickRecords={pickRecords}
      onSyncRecords={sshProfiles.length > 0 ? openRecordsSync : undefined}
      onApplySuggested={applySuggested}
      onOpenItem={onOpenItem}
      onDropFiles={onDropFiles}
      onNewFolder={newFolder}
      onNewFile={newFile}
      onSync={sshProfiles.length > 0 ? openSync : undefined}
      onOpenWorkspace={openNewCaseLauncher}
      onOpenCase={openCaseDefault}
      onOpenLocalCase={openCaseWorkspace}
      onOpenRemote={openCaseRemote}
      sshProfiles={sshProfiles}
      defaultOpenProfileId={defaultCaseOpenProfileId}
      onPickCaseRecords={pickRecordsForCase}
      onBrief={briefCaseToClaude}
      onHearingRecord={(c) => void openHearingRecordForCase(c)}
      jsNonce={jsNonce}
      todoSnapshot={todoSnapshot}
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
            isAgentTab(t) && agentProviderLabel(t),
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
        getContextMenuItems={(id) =>
          agentTabContextMenuItems(id, termSide(termTabs.find((t) => t.id === id)))
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
            ...(currentCase
              ? [
                  {
                    label: '기일 기록',
                    title: '현재 사건의 기일 진행사항 기록',
                    onClick: () => openHearingRecordForCurrent('right')
                  }
                ]
              : []),
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
          onResume={(sid, cwd, title, source, originDevice) => {
            openPastSession(sid, cwd, title, source, undefined, undefined, false, originDevice)
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
              actionLabel="새 사건 추가"
              onAction={openNewCaseLauncher}
              secondaryLabel="작성서류 폴더 열기"
              onSecondary={() => void openConnOrLocal()}
            />
          ))}
        {termTabs.map((t) => (
          <div
            key={t.id}
            className="term-pane"
            data-term-id={t.id}
            data-work-side={termSide(t)}
            tabIndex={isAgentTab(t) ? -1 : undefined}
            onFocus={() => selectTerm(t.id, false)}
            onMouseDown={(e) => {
              selectTerm(t.id)
              if (!isAgentTab(t)) return
              const target = e.target as HTMLElement
              if (shouldFocusAgentPrompt(target)) {
                setTermFocusNonce((current) => bumpFocusNonce(current, t.id))
              }
            }}
            style={{ display: t.id === activeTerm ? 'block' : 'none' }}
          >
            {isAgentTab(t) ? (
              <AgentPanel
                id={t.id}
                cwd={t.cwd}
                title={t.title}
                provider={resolveAgentProvider(t.agentProvider, t.ssh)}
                resumeSessionId={t.resumeSessionId}
                forkFromSessionId={t.forkFromSessionId}
                initialHandoff={t.handoffContext}
                ssh={t.ssh}
                profileId={t.profileId}
                caseTabId={t.caseTabId}
                caseContext={agentCaseContextForTerm(t)}
                workspaceContext={agentWorkspaceContextForTerm(t, contextAppVersion)}
                onTasksChanged={() => setTodoNonce((value) => value + 1)}
                visible={t.id === activeTerm}
                focusNonce={termFocusNonce[t.id] ?? 0}
                initialDraft={agentDrafts[t.id]}
                clearDraftNonce={agentDraftClearNonce[t.id]}
                attachmentRequests={agentAttachmentRequests[t.id] ?? []}
                onDraftChange={(draft) => handleAgentDraftChange(t.id, draft)}
                onInlineActions={registerInlineActions}
                onAttachmentRequestsHandled={(requestIds) =>
                  handleAgentAttachmentRequestsHandled(t.id, requestIds)
                }
                onStatus={(s) => onTermStatus(t.id, s)}
                onFork={() => void forkAgentTab(t.id, termSide(t))}
                onProviderChange={(provider, handoff) => changeAgentProvider(t.id, provider, handoff)}
                onHandoffConsumed={() => consumeAgentHandoff(t.id)}
                onWorktreeFork={() => void forkAgentWorktreeTab(t.id, termSide(t))}
                onOpenTerminal={() => addTermSame(termSide(t), t.id, { reuseAgentTab: true })}
                onOpenDiff={(request) => openAgentDiff(request, caseIdForTerm(t))}
                onOpenFile={(path, title) => openFile(path, title ?? fileNameFromPath(path), 'left', t.caseTabId)}
                onOpenAttachmentSource={openAgentAttachmentSource}
                onPrepareAttachment={prepareAgentAttachmentForSend}
              />
            ) : (
              <Terminal
                id={t.id}
                cwd={t.cwd}
                autoClaude={t.autoClaude ?? false}
                autoAgent={t.autoAgent}
                resumeSessionId={t.resumeSessionId}
                ssh={t.ssh}
                visible={t.id === activeTerm}
                focusNonce={termFocusNonce[t.id] ?? 0}
                todoContext={todoContextForTerm(t)}
                onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                onAskSelection={(text) => askAboutTerminalSelection(t.id, text)}
                onNewTerminal={() => addTermSame(termSide(t), t.id)}
                onRequestClose={() => void closeTermWithConfirm(t.id)}
                onRequestCloseCaseTab={() => closeActiveCaseTabRef.current()}
                onStatus={(s) => onTermStatus(t.id, s)}
                onBracketedPasteModeChange={(enabled) => onTermBracketedPasteMode(t.id, enabled)}
                onTodoChanged={() => setTodoNonce((n) => n + 1)}
                onNewAgent={() => addAgentSame(termSide(t), t.id)}
                onCycleTab={(dir) => cycleTerm(dir, t.id)}
                onCyclePageTab={(dir) => cycleWorkTab(dir, termSide(t), termKeyOf(t.id))}
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
          <div className="case-management-nav" role="group" aria-label="사건 관리 보기">
            <button type="button" aria-pressed={caseDashboardView === 'cases'} onClick={() => setCaseDashboardView('cases')}>개별 사건</button>
            <button type="button" aria-pressed={caseDashboardView === 'projects'} onClick={() => setCaseDashboardView('projects')}>프로젝트</button>
          </div>
          {caseDashboardView === 'projects' ? (
            <ProjectsDashboard
              cases={projectCaseChoices}
              onOpenCase={openProjectCase}
              onPickFolder={pickProjectFolder}
              onOpenFolder={openProjectFolder}
              onOpenWork={openProjectWork}
              workOpen={projectAgentVisible}
              onAddCase={openNewCaseLauncher}
              selectedId={selectedProjectId}
              onSelect={setSelectedProjectId}
            />
          ) : (
          <CasesDashboard
            snapshot={todoSnapshot}
            caseUi={caseUi}
            hearings={hearingsComplete ? upcomingHearings : undefined}
            onStartTask={startCaseTask}
            onAskNextAction={askNextAction}
            onOpenTodos={openCaseTodos}
            onOpenWorkspace={openCaseWorkspace}
            onOpenDefault={openCaseDefault}
            onOpenRemote={openCaseRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultCaseOpenProfileId}
            onPickRecords={pickRecordsForCase}
            onBrief={briefCaseToClaude}
            onHearingRecord={(c) => void openHearingRecordForCase(c)}
            onResumeSession={(c, s, newTab) => void resumeCaseSession(c, s, newTab)}
            onResumePath={(sessionId, cwd, title, profileId, newTab, originDevice) =>
              void resumePathSession(sessionId, cwd, title, profileId, newTab, originDevice)
            }
            onChanged={() => setJsNonce((n) => n + 1)}
          />
          )}
        </div>
      )
    }

    if (side === 'left' && mode === 'todos') {
      return (
        <div className="work-pane work-left todo-work-pane" key="todos" data-work-side="left">
          {todoSummary}
          <TodosDashboard
            snapshot={todoSnapshot}
            initialCaseId={todoCaseFilter}
            onStartTask={startCaseTask}
            onAskNextAction={askNextAction}
            onOpenEvidenceFile={(path, label) => { openFile(path, label ?? fileNameFromPath(path)) }}
            initialFilter={todoFilter}
            filterNonce={todoFilterNonce}
            onGlobalWork={() => void openGlobalTodoWork()}
            nonce={todoNonce}
            onChanged={() => setTodoNonce((n) => n + 1)}
            onOpenWorkspace={openCaseWorkspace}
            onOpenDefault={openCaseDefault}
            onOpenRemote={openCaseRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultCaseOpenProfileId}
            onPickRecords={pickRecordsForCase}
            onBrief={briefCaseToClaude}
            onManageTodos={(rows) => void openGlobalTodoWork(rows)}
          />
        </div>
      )
    }

    const docs = visibleDocTabs.filter((t) => docSide(t) === side)
    const terms = visibleTermTabs.filter((t) => termSide(t) === side)
    const mountedTerms = termTabs.filter((t) => termSide(t) === side && shouldMountTermPane(t))
    const workTabs = [
      ...docs.map((t) => ({
        id: docKey(t.id),
        title: t.title,
        tooltip: t.path,
        path: t.path,
        dirty: dirtyDocs.has(t.id),
        renamable: t.kind === 'mdview' || t.kind === 'markdown',
        dragPayload: dirtyDocs.has(t.id) ? undefined : docTabDragPayload(t, side)
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
          isAgentTab(t) && agentProviderLabel(t),
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
    const activeKey = activeWorkKeyForSide(side)
    const activeParsed = parseWorkKey(activeKey)
    const activeDocForPane =
      activeParsed?.kind === 'doc' ? docs.find((t) => t.id === activeParsed.id) : undefined
    const mountedDocs = [...docs, ...docTabs.filter((tab) =>
      tab.kind === 'media' && docSide(tab) === side && !docs.some((item) => item.id === tab.id)
    )].filter(
      (t) =>
        t.id === activeDocForPane?.id ||
        t.kind === 'mdview' ||
        t.kind === 'markdown' ||
        t.kind === 'media' ||
        t.kind === 'hearing'
    )
    const visibleTermId = activeParsed?.kind === 'terminal' ? activeParsed.id : ''
    const hasTerms = terms.length > 0
    const sessionListSide = termSide(activeTermTab)
    const canOpenSessionList = hasTerms || (side === sessionListSide && !!sessionCaseSource)
    const canMoveActiveTab = !!activeKey

    return (
      <div className={`work-pane work-${side}`} key={side} data-work-side={side} tabIndex={-1}>
        <TabBar
          tabs={workTabs}
          activeId={activeKey}
          onSelect={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            activateWorkTab(side, key as WorkTabKey)
          }}
          onClose={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') void closeDoc(parsed.id)
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
            if (parsed.kind === 'doc') void closeDoc(parsed.id, { confirmDirty: false })
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
          getContextMenuItems={(key) => {
            const parsed = parseWorkKey(key)
            return parsed?.kind === 'terminal' ? agentTabContextMenuItems(parsed.id, side) : []
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
                    ...(currentCase || activeTermTab
                      ? [
                          {
                            label: '기일 기록',
                            title: '현재 사건의 기일 진행사항 기록',
                            onClick: () => openHearingRecordForCurrent(side)
                          }
                        ]
                      : []),
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
            sessions={visibleTermTabs}
            activeId={activeTerm}
            filter={sessionFilter}
            onFilter={setSessionFilter}
            caseCwd={sessionCaseSource?.cwd ?? currentCase?.drafts}
            caseSource={sessionCaseSource}
            onSelect={(id) => {
              selectTerm(id)
              setSessionListOpen(false)
            }}
            onResume={(sid, cwd, title, source, originDevice) => {
              openPastSession(sid, cwd, title, source, side, undefined, false, originDevice)
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
                  actionLabel="새 사건 추가"
                  onAction={openNewCaseLauncher}
                />
              )
            ) : (
              <Empty label="왼쪽에 열린 탭이 없습니다" actionLabel="새 문서" onAction={() => addDoc(side)} />
            ))}
          {mountedDocs.map((doc) => (
            <div
              key={doc.id}
              className="doc-content"
              data-doc-id={doc.id}
              data-work-side={side}
              tabIndex={-1}
              onMouseDown={(e) => {
                activateDocTab(doc.id)
                const target = e.target as HTMLElement
                if (shouldFocusDocContainer(target)) e.currentTarget.focus()
              }}
              style={{ display: doc.id === activeDocForPane?.id ? 'flex' : 'none' }}
            >
              {renderDocContent(doc)}
            </div>
          ))}
          {mountedTerms.map((t) => (
            <div
              key={t.id}
              className="term-pane"
              data-term-id={t.id}
              data-work-side={side}
              tabIndex={isAgentTab(t) ? -1 : undefined}
              onFocus={() => selectTerm(t.id, false)}
              onMouseDown={(e) => {
                selectTerm(t.id)
                if (!isAgentTab(t)) return
                const target = e.target as HTMLElement
                if (shouldFocusAgentPrompt(target)) {
                  setTermFocusNonce((current) => bumpFocusNonce(current, t.id))
                }
              }}
              style={{ display: t.id === visibleTermId ? 'block' : 'none' }}
            >
              {isAgentTab(t) ? (
                <AgentPanel
                  id={t.id}
                  cwd={t.cwd}
                  title={t.title}
                  provider={resolveAgentProvider(t.agentProvider, t.ssh)}
                  resumeSessionId={t.resumeSessionId}
                  forkFromSessionId={t.forkFromSessionId}
                  initialHandoff={t.handoffContext}
                  ssh={t.ssh}
                  profileId={t.profileId}
                  caseTabId={t.caseTabId}
                  caseContext={agentCaseContextForTerm(t)}
                workspaceContext={agentWorkspaceContextForTerm(t, contextAppVersion)}
                onTasksChanged={() => setTodoNonce((value) => value + 1)}
                  visible={t.id === visibleTermId && (!projectManagementVisible || projectAgentVisible)}
                  focusNonce={termFocusNonce[t.id] ?? 0}
                  initialDraft={agentDrafts[t.id]}
                  clearDraftNonce={agentDraftClearNonce[t.id]}
                  attachmentRequests={agentAttachmentRequests[t.id] ?? []}
                  onDraftChange={(draft) => handleAgentDraftChange(t.id, draft)}
                  onInlineActions={registerInlineActions}
                  onAttachmentRequestsHandled={(requestIds) =>
                    handleAgentAttachmentRequestsHandled(t.id, requestIds)
                  }
                  onStatus={(s) => onTermStatus(t.id, s)}
                  onFork={() => void forkAgentTab(t.id, side)}
                  onProviderChange={(provider, handoff) => changeAgentProvider(t.id, provider, handoff)}
                  onHandoffConsumed={() => consumeAgentHandoff(t.id)}
                  onWorktreeFork={() => void forkAgentWorktreeTab(t.id, side)}
                  onOpenTerminal={() => addTermSame(side, t.id, { reuseAgentTab: true })}
                  onOpenDiff={(request) => openAgentDiff(request, caseIdForTerm(t))}
                  onOpenFile={(path, title) => openFile(path, title ?? fileNameFromPath(path), 'left', t.caseTabId)}
                  onOpenAttachmentSource={openAgentAttachmentSource}
                  onPrepareAttachment={prepareAgentAttachmentForSend}
                />
              ) : (
                <Terminal
                  id={t.id}
                  cwd={t.cwd}
                  autoClaude={t.autoClaude ?? false}
                  autoAgent={t.autoAgent}
                  resumeSessionId={t.resumeSessionId}
                  ssh={t.ssh}
                  visible={t.id === visibleTermId && (!projectManagementVisible || projectAgentVisible)}
                  focusNonce={termFocusNonce[t.id] ?? 0}
                  todoContext={todoContextForTerm(t)}
                  onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                  onAskSelection={(text) => askAboutTerminalSelection(t.id, text)}
                  onNewTerminal={() => addTermSame(side, t.id)}
                  onRequestClose={() => void closeTermWithConfirm(t.id)}
                  onRequestCloseCaseTab={() => closeActiveCaseTabRef.current()}
                  onStatus={(s) => onTermStatus(t.id, s)}
                  onBracketedPasteModeChange={(enabled) => onTermBracketedPasteMode(t.id, enabled)}
                  onTodoChanged={() => setTodoNonce((n) => n + 1)}
                  onNewAgent={() => addAgentSame(side, t.id)}
                  onCycleTab={(dir) => cycleTerm(dir, t.id)}
                  onCyclePageTab={(dir) => cycleWorkTab(dir, side, termKeyOf(t.id))}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const closeWindowDialog = closeWindowPrompt ? (
    <UnsavedWindowCloseDialog
      state={closeWindowPrompt}
      onSaveAndClose={() => void saveDirtyDocsAndClose()}
      onDiscardAndClose={forceCloseWindow}
      onCancel={() => setCloseWindowPrompt(null)}
    />
  ) : null

  const paneSelector = (pane: ResizablePane): string =>
    pane === 'side' ? '.side-col' : pane === 'left' ? '.work-left' : '.evid-panel'
  const paneCssVariable = (pane: ResizablePane): string =>
    pane === 'side'
      ? '--side-pane-width'
      : pane === 'left'
        ? '--left-pane-width'
        : '--evidence-pane-width'
  const paneMinimum = (pane: ResizablePane): number =>
    pane === 'side'
      ? MIN_SIDE_PANE_WIDTH
      : pane === 'left'
        ? MIN_WORK_PANE_WIDTH
        : MIN_EVIDENCE_PANE_WIDTH
  const paneMaximum = (pane: ResizablePane): number => {
    const paneWidth = currentPaneWidth(pane)
    const rightWidth =
      shellRef.current?.querySelector<HTMLElement>('.work-right')?.getBoundingClientRect().width ??
      MIN_RIGHT_PANE_WIDTH
    return Math.max(paneMinimum(pane), paneWidth + Math.max(0, rightWidth - MIN_RIGHT_PANE_WIDTH))
  }
  const currentPaneWidth = (pane: ResizablePane): number => {
    const element = shellRef.current?.querySelector<HTMLElement>(paneSelector(pane))
    return element?.getBoundingClientRect().width ?? paneMinimum(pane)
  }
  const setPaneWidth = (pane: ResizablePane, width: number): void => {
    const nextWidth = Math.round(Math.max(paneMinimum(pane), Math.min(width, paneMaximum(pane))))
    shellRef.current?.style.setProperty(paneCssVariable(pane), `${nextWidth}px`)
    setPaneWidths((current) => ({ ...current, [pane]: nextWidth }))
  }
  const startPaneResize = (pane: ResizablePane, event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary || event.button !== 0) return
    const startWidth = currentPaneWidth(pane)
    paneResizeRef.current = {
      pointerId: event.pointerId,
      pane,
      startX: event.clientX,
      startWidth,
      min: paneMinimum(pane),
      max: paneMaximum(pane),
      width: startWidth
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.documentElement.classList.add('pane-resizing')
    event.preventDefault()
    event.stopPropagation()
  }
  const movePaneResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = paneResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const width = Math.round(
      Math.max(resize.min, Math.min(resize.startWidth + event.clientX - resize.startX, resize.max))
    )
    resize.width = width
    shellRef.current?.style.setProperty(paneCssVariable(resize.pane), `${width}px`)
    event.preventDefault()
  }
  const finishPaneResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = paneResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    paneResizeRef.current = null
    document.documentElement.classList.remove('pane-resizing')
    setPaneWidths((current) => ({ ...current, [resize.pane]: resize.width }))
  }
  const resizePaneFromKey = (
    pane: ResizablePane,
    event: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setPaneWidth(pane, currentPaneWidth(pane) + (event.key === 'ArrowLeft' ? -16 : 16))
  }
  const explorerShortcutLabel = platform === 'darwin' ? '⌘⇧E' : 'Ctrl+Shift+E'
  const selectActivityMode = (nextMode: Mode): void => {
    if (nextMode === 'explorer' && mode === 'explorer') {
      setExplorerVisible((visible) => !visible)
      return
    }
    setMode(nextMode)
    setExplorerVisible(true)
  }
  const shellStyle = {
    '--side-pane-width': `${paneWidths.side}px`,
    ...(paneWidths.left ? { '--left-pane-width': `${paneWidths.left}px` } : {}),
    '--evidence-pane-width': `${paneWidths.evidence}px`
  } as React.CSSProperties
  const primaryShortcut = platform === 'darwin' ? '⌘' : 'Ctrl+'
  const slashCommands: SlashCommand[] = [
    ...(!docOnly && !termOnly
      ? [
          {
            id: 'new-case',
            label: '새 사건',
            detail: '사건 목록, 폴더 또는 저장된 작업환경에서 시작',
            keywords: '사건 추가 열기 workspace',
            shortcut: `${primaryShortcut}⇧N`,
            run: openNewCaseLauncher
          },
          {
            id: 'case-tabs',
            label: '열린 사건탭 목록',
            detail: '현재 열려 있는 사건 작업공간 보기',
            keywords: '사건 탭 전환',
            shortcut: `${primaryShortcut}0`,
            run: () => setCaseTabsOpen(true)
          },
          {
            id: 'cases',
            label: '사건 목록',
            detail: 'JuriSupport 사건 대시보드 열기',
            keywords: 'dashboard jurisupport',
            run: () => {
              setMode('cases')
              setExplorerVisible(true)
            }
          },
          {
            id: 'explorer',
            label: '탐색기',
            detail: '작성서류와 소송기록 탐색기 열기',
            keywords: '파일 폴더 explorer',
            shortcut: `${primaryShortcut}⇧E`,
            run: () => {
              setMode('explorer')
              setExplorerVisible(true)
            }
          },
          {
            id: 'viewer',
            label: '기록뷰어',
            detail: '소송기록과 서증 보기',
            keywords: '기록 pdf evidence',
            run: () => {
              setMode('viewer')
              setExplorerVisible(true)
            }
          },
          {
            id: 'todos',
            label: '할 일',
            detail: '전체 할 일 대시보드 열기',
            keywords: '할일 todo task',
            run: () => {
              setMode('todos')
              setExplorerVisible(true)
            }
          }
        ]
      : []),
    ...(!termOnly
      ? [
          {
            id: 'new-document',
            label: '새 문서',
            detail: '현재 작업공간에 새 문서 만들기',
            keywords: '파일 작성 markdown',
            shortcut: `${primaryShortcut}N`,
            run: () => addDoc('left')
          },
          ...(markdownSaveHandlersRef.current.has(activeDoc)
            ? [
                {
                  id: 'save-document',
                  label: '현재 문서 저장',
                  detail: activeDocTab?.title ?? '열린 문서 저장',
                  keywords: 'save 파일',
                  shortcut: `${primaryShortcut}S`,
                  run: () => void markdownSaveHandlersRef.current.get(activeDoc)?.()
                }
              ]
            : [])
        ]
      : []),
    ...(!docOnly
      ? [
          {
            id: 'new-agent',
            label: '새 Agent',
            detail: '현재 사건에서 새 AI 작업 시작',
            keywords: '에이전트 claude codex ai',
            shortcut: `${primaryShortcut}T`,
            run: () => addAgentSame(termSide(activeTermTab), activeTerm)
          },
          {
            id: 'new-terminal',
            label: '새 터미널',
            detail: '현재 사건에서 셸 터미널 열기',
            keywords: 'shell console',
            shortcut: `${primaryShortcut}⇧T`,
            run: () => addTermSame(termSide(activeTermTab), activeTerm)
          }
        ]
      : []),
    ...(!docOnly && !termOnly
      ? [
          {
            id: 'save-workspace',
            label: '작업환경 저장',
            detail: '열린 사건, 문서와 작업 탭 저장',
            keywords: 'workspace snapshot',
            run: () => void saveWorkspace(false)
          },
          {
            id: 'restore-workspace',
            label: '작업환경 가져오기',
            detail: '저장된 작업환경 복원',
            keywords: 'workspace restore 불러오기',
            run: () => void restoreWorkspace(false)
          },
          {
            id: 'remotion-preview',
            label: 'Remotion 미리보기',
            detail: '현재 프로젝트의 영상을 렌더링 전에 확인',
            keywords: '영상 쇼츠 preview',
            run: () => { void openRemotion(activeDraftsFolder) }
          },
          {
            id: 'settings',
            label: '설정',
            detail: '앱 설정 열기',
            keywords: 'preferences 환경',
            run: openSettings
          }
        ]
      : [])
  ]
  const slashCommandPalette = slashCommandsOpen ? (
    <SlashCommandPalette commands={slashCommands} onClose={() => setSlashCommandsOpen(false)} />
  ) : null

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
            {activeDocTab?.kind !== 'media' && renderDocContent(activeDocTab)}
            {docTabs.filter((doc) => doc.kind === 'media').map((doc) => (
              <div key={doc.id} style={{ display: doc.id === activeDoc ? 'block' : 'none', height: '100%', minHeight: 0 }}>
                {renderDocContent(doc)}
              </div>
            ))}
          </div>
        </div>
        <div className="statusbar">
          <span className="status-left">legal-terminal · 문서</span>
          <span className="status-right">{statusInfo}</span>
        </div>
        <SelectionAsk onAsk={askClaude} />
        <SelectionMenu onAsk={askClaude} />
        {slashCommandPalette}
        {closeWindowDialog}
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
        {slashCommandPalette}
        {closeWindowDialog}
      </div>
    )
  }

  return (
    <div
      ref={shellRef}
      className={`shell ${isViewer ? 'mode-viewer' : 'mode-default'} ${explorerVisible ? '' : 'explorer-hidden'} ${projectManagementVisible && !projectAgentVisible ? 'project-management' : ''}`}
      style={shellStyle}
      {...shellDragProps}
    >
      <div className="workspace-todo-header">
        <TodoHeaderBadge snapshot={todoSnapshot} onOpen={() => openTodoSummary('overdue')} />
        {selectedWorkspaceTask && <div className="todo-actions" aria-label="현재 사건의 다음 행동">
          <span>내 다음 행동: {selectedWorkspaceTask.title}</span>
          <span className="muted small">{selectedWorkspaceTask.dueDate ? `기한 ${kstDateKey(selectedWorkspaceTask.dueDate) || '날짜 확인 필요'} · ` : ''}
            {selectedWorkspaceTask.waitingFor ? `대기 · ${selectedWorkspaceTask.waitingFor}` : ''}
            {selectedWorkspaceTask.reviewAt ? ` · 재확인 ${kstDateKey(selectedWorkspaceTask.reviewAt) || '날짜 확인 필요'}` : ''}</span>
          <button className="todo-small" onClick={() => openCaseTodos(selectedWorkspaceTask.caseId!)}>사건 업무</button>
          <button className="todo-small" onClick={() => askNextAction(selectedWorkspaceTask)}>다음 행동 제안</button>
        </div>}
        {nextActionRequest && <NextActionProposal key={nextActionRequest.id} request={nextActionRequest}
          activeCaseId={currentCase?.meta?.jsId} onClose={() => setNextActionRequest(null)}
          onSaved={() => setTodoNonce((value) => value + 1)} />}
      </div>
      {/* ── 액티비티바 (모드 전환) ── */}
      <div className="activitybar" key="activity">
        <div className="activitybar-top">
          {ACTIVITY.map((item) => (
            <button
              key={item.id}
              className={`activity-item ${mode === item.id && (item.id !== 'explorer' || explorerVisible) ? 'active' : ''}`}
              title={
                item.id === 'explorer'
                  ? `탐색기 표시/숨기기 (${explorerShortcutLabel})`
                  : item.label
              }
              aria-pressed={mode === item.id && (item.id !== 'explorer' || explorerVisible)}
              onClick={() => selectActivityMode(item.id)}
            >
              <item.Icon />
            </button>
          ))}
          <button
            className={`activity-item case-tabs-trigger ${caseTabsOpen ? 'active' : ''} ${
              totalCaseDocumentUpdateCount > 0 ? 'has-updates' : ''
            } ${
              totalCaseDocumentUpdateCount === 0 && totalCaseQuestionTaskCount > 0
                ? 'has-question'
                : ''
            } ${
              totalCaseDocumentUpdateCount === 0 &&
              totalCaseQuestionTaskCount === 0 &&
              totalCaseDoneTaskCount > 0
                ? 'has-done'
                : ''
            }`}
            title={caseTabActivityTitle}
            aria-label={caseTabActivityTitle}
            aria-expanded={caseTabsOpen}
            aria-controls="case-tabs-flyout"
            onClick={() => setCaseTabsOpen((open) => !open)}
          >
            <IconCaseTabs />
            {caseTabActivityBadgeCount > 0 && (
              <span className={`activity-badge ${caseTabActivityBadgeClass}`}>
                {caseTabActivityBadgeCount}
              </span>
            )}
          </button>
        </div>
        {caseTabsOpen && (
          <div id="case-tabs-flyout" className="case-tabs-flyout" role="dialog" aria-label="사건탭" onMouseDown={(e) => e.stopPropagation()}>
            <div className="case-tabs-head">
              <span>사건탭</span>
              <button className="case-tabs-close" title="닫기" onClick={() => setCaseTabsOpen(false)}>
                ×
              </button>
            </div>
            <div className="case-tabs-filter">
              <label>
                <input type="checkbox" checked={caseAttentionOnly} onChange={(event) => setCaseAttentionOnly(event.target.checked)} />
                확인 필요만
              </label>
              <button type="button" disabled={totalCaseNoticeCount === 0} onClick={openNextCaseAttention}>
                다음 확인 작업 →
              </button>
            </div>
            <div className="case-tabs-list">
              {visibleCaseTabRows.length === 0 ? (
                <div className="case-tabs-empty" role="status">{caseTabs.length === 0 ? '열린 사건탭 없음' : '확인이 필요한 작업 없음'}</div>
              ) : (
                visibleCaseTabRows.map(({
                  tab,
                  active,
                  status,
                  questionTaskCount,
                  doneTaskCount,
                  documentUpdateCount,
                  documentUpdateLatestAt
                }) => (
                  <button
                    key={tab.id}
                    className={`case-tab-row ${active ? 'active' : ''} ${documentUpdateCount > 0 ? 'has-updates' : ''} ${
                      documentUpdateCount === 0 && questionTaskCount > 0 ? 'has-question' : ''
                    } ${
                      documentUpdateCount === 0 && questionTaskCount === 0 && doneTaskCount > 0 ? 'has-done' : ''
                    }`}
                    title={`${caseTabTitle(tab)}${documentUpdateCount > 0 ? ` · 업데이트 ${documentUpdateCount}개` : ''}${
                      questionTaskCount > 0 ? ` · 확인 대기 ${questionTaskCount}개` : ''
                    }${
                      doneTaskCount > 0 ? ` · 완료 작업 ${doneTaskCount}개` : ''
                    }\n${caseTabSubtitle(tab)}${
                      documentUpdateLatestAt
                        ? `\n최근 업데이트 ${new Date(documentUpdateLatestAt).toLocaleTimeString('ko-KR')}`
                        : ''
                    }`}
                    onClick={() => openCaseTab(tab)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCaseTabContextMenu({
                        x: Math.max(8, Math.min(e.clientX, window.innerWidth - 220 - 8)),
                        y: Math.max(8, Math.min(e.clientY, window.innerHeight - 48 - 8)),
                        tabId: tab.id
                      })
                    }}
                  >
                    <span className="case-tab-row-main">
                      <span className="case-tab-row-titleline">
                        <span className="case-tab-row-title">{caseTabTitle(tab)}</span>
                        {documentUpdateCount > 0 && (
                          <span
                            className="case-tab-row-update-badge"
                            title={`업데이트 ${documentUpdateCount}개`}
                            aria-label={`업데이트 ${documentUpdateCount}개`}
                          >
                            {documentUpdateCount}
                          </span>
                        )}
                        {questionTaskCount > 0 && (
                          <span
                            className="case-tab-row-question-badge"
                            title={`확인 대기 ${questionTaskCount}개`}
                            aria-label={`확인 대기 ${questionTaskCount}개`}
                          >
                            {questionTaskCount}
                          </span>
                        )}
                        {doneTaskCount > 0 && (
                          <span
                            className="case-tab-row-done-badge"
                            title={`완료된 작업 ${doneTaskCount}개`}
                            aria-label={`완료된 작업 ${doneTaskCount}개`}
                          >
                            {doneTaskCount}
                          </span>
                        )}
                      </span>
                      <span className="case-tab-row-sub">{caseTabSubtitle(tab)}</span>
                    </span>
                    <span className="case-tab-row-status">{status}</span>
                  </button>
                ))
              )}
            </div>
            <div className="case-tabs-actions">
              <button className="case-tabs-add" type="button" onClick={openNewCaseLauncher}>
                + 새 사건
              </button>
            </div>
            {caseTabContextMenu && (
              <div
                className="tab-context-menu"
                role="menu"
                style={{ left: caseTabContextMenu.x, top: caseTabContextMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  className="tab-context-menu-item"
                  role="menuitem"
                  title="이 사건의 전자소송기록 폴더를 직접 지정합니다"
                  onClick={(e) => {
                    e.stopPropagation()
                    pickRecordsForCaseTab(caseTabContextMenu.tabId)
                  }}
                >
                  <span>소송기록 폴더 지정</span>
                </button>
                <button
                  className="tab-context-menu-item"
                  role="menuitem"
                  title={`이 사건탭과 여기에 속한 문서/터미널 탭을 닫습니다 (${closeCaseTabShortcut})`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeCaseTab(caseTabContextMenu.tabId)
                  }}
                >
                  <span>사건탭 닫기</span>
                </button>
              </div>
            )}
          </div>
        )}
        <div className="activitybar-bottom">
          <button
            className="activity-item"
            title={`새 사건 추가 (${platform === 'darwin' ? '⌘⇧N' : 'Ctrl+Shift+N'})`}
            onClick={openNewCaseLauncher}
          >
            <IconWorkspace />
          </button>
          <button
            className="activity-item"
            title="현재 작업환경 저장"
            onClick={(e) => void saveWorkspace(e.shiftKey)}
          >
            <IconSave />
          </button>
          <button
            className="activity-item"
            title="작업환경 JSON 파일로 내보내기 (저장 위치 선택)"
            onClick={() => void saveWorkspace(true)}
          >
            <IconSaveAs />
          </button>
          <button
            className="activity-item"
            title="저장된 작업환경 불러오기"
            onClick={(e) => void restoreWorkspace(e.shiftKey)}
          >
            <IconSync />
          </button>
          <button className="activity-item" title="설정" onClick={openSettings}>
            <IconSettings size={20} />
          </button>
        </div>
      </div>

      {explorerVisible && (
        <div className="side-col" key="side">
          <div className="side-view-switch" role="group" aria-label="사이드바 보기">
            <button type="button" aria-pressed={sidebarView === 'cases'} onClick={() => setSidebarView('cases')}>
              <IconCases size={15} /> 사건
            </button>
            <button type="button" aria-pressed={sidebarView === 'files'} onClick={() => setSidebarView('files')}>
              <IconExplorer size={15} /> 파일
            </button>
          </div>
          <button className="project-open-button" type="button" aria-pressed={projectManagementVisible} onClick={showProjects}>
            <IconWorkspace size={15} /> 프로젝트 관리
          </button>
          {sidebarView === 'cases' ? (
            <CaseSidebar
              cases={sidebarCases}
              onOpenCase={(id) => {
                const tab = sidebarCaseTabs.find((item) => item.id === id)
                if (!tab) return
                if (caseTabs.some((item) => item.id === id)) openCaseTab(tab)
                else if (tab.profileId && !tab.ssh) void openRecent(tab)
                else {
                  openCaseContext(currentCaseFromCaseTab(tab))
                  setMode('explorer')
                }
              }}
              onOpenTask={openSidebarTask}
              onNewTask={newSidebarTask}
              onAddCase={openNewCaseLauncher}
              loadSessions={(id, limit, refresh) => {
                const source = sidebarSessionSource(id)
                return source ? loadPastSessions(source.cwd, source, '', refresh, limit) : Promise.resolve([])
              }}
            />
          ) : docsPanel}
        </div>
      )}

      {explorerVisible && (
        <div
          className="pane-resizer pane-resizer-side"
          role="separator"
          aria-label="탐색기 너비 조절"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => startPaneResize('side', event)}
          onPointerMove={movePaneResize}
          onPointerUp={finishPaneResize}
          onPointerCancel={finishPaneResize}
          onLostPointerCapture={finishPaneResize}
          onKeyDown={(event) => resizePaneFromKey('side', event)}
        />
      )}

      {renderWorkPane('left')}

      <div
        className="pane-resizer pane-resizer-work"
        role="separator"
        aria-label={isViewer ? '왼쪽 작업 영역과 서증 영역 너비 조절' : '좌우 작업 영역 너비 조절'}
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => startPaneResize('left', event)}
        onPointerMove={movePaneResize}
        onPointerUp={finishPaneResize}
        onPointerCancel={finishPaneResize}
        onLostPointerCapture={finishPaneResize}
        onKeyDown={(event) => resizePaneFromKey('left', event)}
      />

      {/* ── 서증·첨부서류 (뷰어 모드에서만) ── */}
      {isViewer && <EvidencePanel key="evid" record={panelRecord} onOpenItem={onOpenItem} />}

      {isViewer && (
        <div
          className="pane-resizer pane-resizer-evidence"
          role="separator"
          aria-label="서증 영역과 오른쪽 작업 영역 너비 조절"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => startPaneResize('evidence', event)}
          onPointerMove={movePaneResize}
          onPointerUp={finishPaneResize}
          onPointerCancel={finishPaneResize}
          onLostPointerCapture={finishPaneResize}
          onKeyDown={(event) => resizePaneFromKey('evidence', event)}
        />
      )}

      {renderWorkPane('right')}

      <div className="statusbar" key="status">
        <span className="status-left">legal-terminal · {projectManagementVisible ? '프로젝트' : modeLabel(mode)}</span>
        <span className="status-right">{statusInfo}</span>
      </div>

      <SelectionAsk onAsk={askClaude} onInline={openInlineSelection} inlineOpen={Boolean(inlineSelection)} />
      <SelectionMenu onAsk={askClaude} />
      {inlineSelection && (
        <InlineSelectionCommand key={inlineSelection.key} x={inlineSelection.x} y={inlineSelection.y}
          domRange={inlineSelection.domRange} sourceElement={inlineSelection.sourceElement}
          caseName={inlineSelection.caseName}
          sourceLabel={`${inlineSelection.source.docTitle ?? '선택 영역'}${inlineSelection.source.range?.startPage ? ` · PDF ${inlineSelection.source.range.startPage}쪽` : ''}`}
          text={inlineSelection.text} targetId={inlineSelection.targetId}
          targets={inlineTargetsForCase(inlineSelection.caseId, inlineSelection.sourceSide).map((term, index) => ({
            id: term.id, label: `${index + 1}. ${agentProviderLabel(term)} · ${term.sessionTitle ?? term.title}`
          }))}
          ready={inlineReadyIds.has(inlineSelection.targetId)} onTargetChange={changeInlineTarget}
          suggest={(prefix) => inlineActionsRef.current.get(inlineSelection.targetId)?.suggest(prefix)}
          onSubmit={submitInlineSelection} onClose={() => setInlineSelection(null)} />
      )}
      {slashCommandPalette}
      {closeWindowDialog}

      {newCaseOpen && (
        <NewCaseLauncher
          recent={recent}
          onCases={openCaseListFromLauncher}
          onFolder={openFolderFromLauncher}
          onSavedWorkspace={openSavedWorkspaceFromLauncher}
          onRecent={openRecentFromLauncher}
          onNewWindow={openBlankWorkspaceWindow}
          onClose={() => setNewCaseOpen(false)}
        />
      )}

      {workspacePick && (
        <WorkspacePicker
          loading={workspacePick.loading}
          entries={workspacePick.entries}
          error={workspacePick.error}
          onLoad={(entry) => void loadSavedWorkspaceEntry(entry)}
          onImportFile={() => void restoreWorkspace(true)}
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
      {projectFolderPick && (projectFolderPick.profile ? (
        <RemoteFolderPicker
          profile={projectFolderPick.profile}
          title="프로젝트 참고 폴더 선택"
          confirmLabel="이 폴더 연결"
          onSync={showSync}
          onCancel={() => { projectFolderPick.resolve(null); setProjectFolderPick(null) }}
          onPick={async (path) => {
            const request = projectFolderPick
            const profile = request.profile!
            try {
              if (!path.startsWith('/')) {
                const result = await window.lt.ssh.listDir(profile, path)
                if (!result.ok || !result.cwd?.startsWith('/')) throw new Error('원격 폴더의 전체 경로를 확인하지 못했습니다. 연결 상태와 경로를 확인해 주세요.')
                path = result.cwd
              }
              request.resolve({ path: remoteUri(profile.id, path), name: pathLeaf(path) || profile.label })
            } catch (error) { request.reject(error) }
            finally { setProjectFolderPick((current) => current?.resolve === request.resolve ? null : current) }
          }}
        />
      ) : (
        <ConnMenu
          title="참고 폴더 — 위치 선택"
          localDescription="이 컴퓨터의 참고 폴더 연결"
          profiles={sshProfiles}
          onLocal={() => {
            const request = projectFolderPick
            setProjectFolderPick(null)
            void window.lt.dialog.pickFolder({ title: '프로젝트 참고 폴더 선택' }).then(request.resolve, request.reject)
          }}
          onRemote={(profile) => setProjectFolderPick({ ...projectFolderPick, profile })}
          onManage={() => { projectFolderPick.resolve(null); setProjectFolderPick(null); openSettings() }}
          onClose={() => { projectFolderPick.resolve(null); setProjectFolderPick(null) }}
        />
      ))}
      {remotePick && (
        <RemoteFolderPicker
          profile={remotePick}
          onSync={showSync}
          onCancel={() => setRemotePick(null)}
          onPick={async (remotePath) => {
            const prof = remotePick
            setRemotePick(null)
            const opened = openRemoteCaseContext(prof, remotePath)
            resolveRemoteRecordsLater(opened.id, prof, remotePath, opened.title)
          }}
        />
      )}

      {/* 열린 사건의 원격 작성서류 폴더 변경 */}
      {draftsPick && (
        <RemoteFolderPicker
          profile={draftsPick.profile}
          onSync={showSync}
          title="작성서류 폴더 선택"
          confirmLabel="이 폴더로 지정"
          startPath={draftsPick.startPath}
          onCancel={() => setDraftsPick(null)}
          onPick={(remotePath) => {
            const profile = draftsPick.profile
            setDraftsPick(null)
            applyDraftsFolder(
              { termId: draftsPick.termId, source: draftsPick.source },
              {
                drafts: remoteUri(profile.id, remotePath),
                cwd: remotePath,
                name: pathLeaf(remotePath) || profile.label,
                ssh: sshConnFromProfile(profile),
                sshLabel: profile.label,
                profileId: profile.id,
                remotePath
              }
            )
          }}
        />
      )}

      {/* 사건(JuriSupport) 원격 열기 — 자동 매칭 실패 시 폴더 직접 선택 */}
      {remoteCasePick && (
        <RemoteFolderPicker
          profile={remoteCasePick.profile}
          onSync={showSync}
          title={`「${remoteCasePick.name}」 작성서류 폴더 선택`}
          onCancel={() => {
            remoteCasePickerResolve.current?.(undefined)
            remoteCasePickerResolve.current = null
            setRemoteCasePick(null)
          }}
          onPick={async (remotePath) => {
            const { profile, name, meta, caseData, account } = remoteCasePick
            const resolve = remoteCasePickerResolve.current
            remoteCasePickerResolve.current = null
            setRemoteCasePick(null)
            if (account !== todoAccountGeneration.current) { resolve?.(undefined); return }
            try {
              if (caseData.id) await window.lt.case.setJsPairing(
                  remoteJsPairingKey(profile.id, caseData.id), remoteUri(profile.id, remotePath))
              if (account !== todoAccountGeneration.current) { resolve?.(undefined); return }
              const opened = openRemoteCaseContext(profile, remotePath, name, meta)
              resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, caseData)
              setMode('explorer')
              resolve?.(opened)
            } catch (error) {
              resolve?.(undefined)
              void window.lt.dialog.alert('사건 폴더 연결을 저장하지 못했습니다: ' + String(error))
            }
          }}
        />
      )}

      {/* rclone 동기화 모달 */}
      {syncInit && (
        <SyncModal
          profiles={sshProfiles}
          init={syncInit}
          minimized={syncMinimized}
          onMinimize={() => setSyncMinimized(true)}
          onRestore={() => setSyncMinimized(false)}
          onFinished={() => {
            void window.lt.ssh.clearDirCache()
              .catch(() => {})
              .finally(() => setTreeRefresh((n) => n + 1))
          }}
          onClose={() => {
            setSyncInit(null)
            setTreeRefresh((n) => n + 1)
          }}
        />
      )}

      {/* 원격 소송기록 폴더 선택 (기록뷰어) */}
      {recordsPick && (
        <RemoteFolderPicker
          profile={recordsPick.profile}
          onSync={showSync}
          title="소송기록 폴더 선택"
          confirmLabel="이 폴더로 지정"
          startPath={recordsPick.startPath}
          onCancel={() => setRecordsPick(null)}
          onPick={(remotePath) => {
            const uri = remoteUri(recordsPick.profile.id, remotePath)
            const cur = recordsPick.termId
              ? termTabs.find((t) => t.id === recordsPick.termId)
              : termTabs.find((t) => t.id === activeTerm)
            const source = recordsPick.source ?? (cur ? currentCaseFromTerm(cur) : currentCase ?? undefined)
            setTermTabs((tabs) =>
              tabs.map((t) =>
                cur && t.id === cur.id
                  ? {
                      ...t,
                      recordsFolder: uri,
                      suggestedRecords: undefined,
                      suggestedRecordOptions: undefined
                    }
                  : t
              )
            )
            const nextSource = source ? { ...source, records: uri } : undefined
            setCurrentCase((c) => nextSource ?? (c ? { ...c, records: uri } : c))
            if (cur) registerCaseTabFromTerm({ ...cur, recordsFolder: uri })
            else if (nextSource) registerCaseTab(nextSource)
            // 페어링 기억 → 다음에 이 사건을 열면 자동 적용
            const draftsPath = recordsPick.draftsPath ?? (cur?.ssh ? cur.cwd : nextSource?.remotePath)
            if (draftsPath) {
              const drafts = remoteUri(recordsPick.profile.id, draftsPath)
              window.lt.case.setPairing(drafts, uri)
              saveJsPairing(
                nextSource ?? (cur ? currentCaseFromTerm({ ...cur, recordsFolder: uri }) : undefined),
                drafts,
                uri
              )
              window.lt.case
                .addHistory({ drafts, records: uri, name: recordsPick.title ?? cur?.title ?? source?.name ?? '사건' })
                .then(setRecent)
            }
            setRecordsPick(null)
            setMode('viewer')
          }}
        />
      )}

      {downloadProgress && <DownloadProgressToast progress={downloadProgress} />}

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
              <span className="toast-icon">{t.status === 'question' ? '?' : '✓'}</span>
              <span className="toast-body">
                <b>{t.title}</b>
                <span className="toast-sub">
                  {t.status === 'question'
                    ? '확인/입력을 기다립니다 · 클릭하여 이동'
                    : '작업이 완료되었습니다 · 클릭하여 이동'}
                </span>
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

function SlashCommandPalette({
  commands,
  onClose
}: {
  commands: SlashCommand[]
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const visible = commands.filter((command) =>
    matchesSearch([command.label, command.detail, command.keywords], query)
  )
  const run = (command?: SlashCommand): void => {
    if (!command) return
    onClose()
    command.run()
  }

  useEffect(() => selectedRef.current?.scrollIntoView({ block: 'nearest' }), [selected])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (visible.length > 0) {
        setSelected((current) =>
          (current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length
        )
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      run(visible[selected])
    }
  }

  return (
    <div className="modal-overlay slash-palette-overlay" onMouseDown={onClose}>
      <div
        className="modal slash-palette"
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="slash-palette-search">
          <span aria-hidden="true">/</span>
          <input
            autoFocus
            role="combobox"
            value={query}
            placeholder="명령 검색…"
            aria-label="명령 검색"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="slash-command-list"
            aria-activedescendant={visible[selected] ? `slash-command-${visible[selected].id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="slash-palette-list" id="slash-command-list" role="listbox">
          {visible.map((command, index) => (
            <button
              key={command.id}
              id={`slash-command-${command.id}`}
              ref={index === selected ? selectedRef : undefined}
              className={`slash-palette-row ${index === selected ? 'active' : ''}`}
              type="button"
              role="option"
              aria-selected={index === selected}
              onMouseMove={() => setSelected(index)}
              onClick={() => run(command)}
            >
              <span className="slash-palette-row-main">
                <span className="slash-palette-label">{command.label}</span>
                <span className="slash-palette-detail">{command.detail}</span>
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {visible.length === 0 && <div className="slash-palette-empty">일치하는 명령이 없습니다.</div>}
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function DownloadProgressToast({ progress }: { progress: FsDownloadProgress }): JSX.Element {
  const total = Math.max(0, progress.totalFiles)
  const completed = total > 0 ? Math.min(progress.completedFiles, total) : progress.completedFiles
  const totalBytes = Math.max(0, progress.totalBytes ?? 0)
  const downloadedBytes =
    totalBytes > 0
      ? Math.min(Math.max(0, progress.downloadedBytes ?? 0), totalBytes)
      : Math.max(0, progress.downloadedBytes ?? 0)
  const byteDetail =
    totalBytes > 0
      ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
      : downloadedBytes > 0
        ? formatBytes(downloadedBytes)
        : ''
  const currentFileFraction =
    progress.phase === 'downloading' && total > 1 && totalBytes > 0 && downloadedBytes < totalBytes
      ? downloadedBytes / totalBytes
      : 0
  const percent =
    progress.phase === 'done'
      ? 100
      : total > 1
        ? Math.round(((completed + currentFileFraction) / total) * 100)
        : totalBytes > 0
          ? Math.round((downloadedBytes / totalBytes) * 100)
          : total > 0
            ? Math.round((completed / total) * 100)
            : 0
  const active = progress.phase === 'preparing' || progress.phase === 'downloading'
  const title =
    progress.phase === 'preparing'
      ? `${progress.name} 목록 확인 중`
      : progress.phase === 'done'
        ? `${progress.name} 다운로드 완료`
        : progress.phase === 'error'
          ? `${progress.name} 다운로드 실패`
          : `${progress.name} 다운로드 중`
  const detail =
    progress.phase === 'preparing'
      ? '원격 폴더를 살펴보는 중입니다.'
      : progress.phase === 'error'
        ? progress.error || '알 수 없는 오류'
        : byteDetail
          ? `${byteDetail}${total > 1 ? ` · 파일 ${completed}/${total}개` : ''}${progress.currentFile ? ` · ${progress.currentFile}` : ''}`
          : total > 0
            ? `파일 ${completed}/${total}개${progress.currentFile ? ` · ${progress.currentFile}` : ''}`
          : progress.isDir
              ? '빈 폴더 또는 파일 목록 생성 중'
              : progress.currentFile || '파일을 내려받는 중입니다.'

  return (
    <div className={`download-progress ${progress.phase}`} role="status" aria-live="polite">
      <div className="download-progress-head">
        <div className="download-progress-title">
          {active && (
            <span className="download-progress-spinner" aria-hidden="true">
              @
            </span>
          )}
          <strong>{title}</strong>
        </div>
        <span className="download-progress-percent">{percent}%</span>
      </div>
      <div
        className="download-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="download-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="download-progress-detail" title={detail}>
        {detail}
      </div>
    </div>
  )
}

const SELECTION_ACTION_TARGET_SELECTOR =
  '.text-doc, .file-view, .pdf-viewer, .textLayer, .csv-wrap, .agent-md-body, .agent-card-text, .agent-card-input, .agent-process-step-text'
const SELECTION_ACTION_EXCLUDE_SELECTOR =
  '.terminal-surface, .xterm, .tabs, .sidebar, .activitybar, .statusbar, button, input, textarea, select'
const SELECTION_ACTION_CONTROL_SELECTOR = '.sel-actions, .ctx-menu, .inline-selection-command'

const elementFromSelectionNode = (node: Node | null | undefined): Element | null =>
  node?.nodeType === Node.ELEMENT_NODE ? node as Element : (node?.parentElement ?? null)

const isSelectionActionControl = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest(SELECTION_ACTION_CONTROL_SELECTOR)

const canShowSelectionActions = (element: Element | null): boolean => {
  if (!element) return false
  if (element.ownerDocument.defaultView?.frameElement?.matches('.html-frame')) {
    return !element.closest('button, input, textarea, select')
  }
  if (element.closest(SELECTION_ACTION_EXCLUDE_SELECTOR)) return false
  return !!element.closest(SELECTION_ACTION_TARGET_SELECTOR)
}

const centerMarkdownSelection = (draftId?: string): void => {
  if (!draftId) return
  window.dispatchEvent(new CustomEvent(MARKDOWN_CENTER_SELECTION_EVENT, { detail: { draftId } }))
}

const selectionSourceForElement = (
  element: Element | null,
  text: string,
  detail?: TextSelectionOverlayDetail | null
): ClaudeSelectionSource | undefined => {
  const sourceElement = element?.ownerDocument.defaultView?.frameElement ?? element
  const docId =
    closestHTMLElement(sourceElement as HTMLElement | null, '[data-doc-id]')?.dataset.docId ??
    detail?.editorDraftId
  const range = detail?.range
  if (!docId && !range) return undefined
  if (sourceElement !== element) return { docId, text }
  const pdfLayer = element?.closest<HTMLElement>('.textLayer[data-pdf-page]')
  const page = Number(pdfLayer?.dataset.pdfPage)
  const selection = element?.ownerDocument.defaultView?.getSelection()
  const selectedRange = selection?.rangeCount === 1 ? selection.getRangeAt(0) : undefined
  if (pdfLayer && Number.isSafeInteger(page) && page > 0 && selectedRange &&
      pdfLayer.contains(selectedRange.startContainer) && pdfLayer.contains(selectedRange.endContainer)) {
    return { docId, docPath: pdfLayer.dataset.pdfPath, text, range: { startPage: page, endPage: page } }
  }
  return { docId, text, range }
}

const askOptionsForSelectionElement = (
  element: Element | null,
  selectionSource?: ClaudeSelectionSource
): ClaudeAskOptions | undefined =>
  element?.closest('.agent-panel')
    ? {
        docPath: null,
        sourceLabel: 'Agent 패널',
        agentQuoteMessageId: element?.closest<HTMLElement>('.agent-msg.assistant')?.id
      }
    : selectionSource
      ? { selectionSource }
      : undefined

const quoteAgentPanelSelection = (opts?: ClaudeAskOptions): boolean => {
  const button = opts?.agentQuoteMessageId
    ? document
        .getElementById(opts.agentQuoteMessageId)
        ?.querySelector<HTMLButtonElement>('[data-agent-quote]')
    : undefined
  button?.click()
  return !!button
}

type SelectionAskHandler = (text: string, opts?: ClaudeAskOptions) => void
type SelectionActionBox = TextSelectionOverlayDetail & { askOpts?: ClaudeAskOptions; sourceElement?: HTMLElement }
type SelectionActionProps = {
  onAsk: SelectionAskHandler
  selectionDocument?: Document
  onInline?: (box: SelectionActionBox) => void
  inlineOpen?: boolean
}

// 본문에서 텍스트 선택 후 우클릭 → 컨텍스트 메뉴 (Claude/법제처/법고을/엘박스)
function SelectionMenu({ onAsk, selectionDocument = document }: SelectionActionProps): JSX.Element | null {
  const [menu, setMenu] = useState<{
    x: number
    y: number
    text: string
    queryText: string
    markdown?: string
    editorDraftId?: string
    askOpts?: ClaudeAskOptions
  } | null>(null)
  const editorSelectionRef = useRef<TextSelectionOverlayDetail | null>(null)

  useEffect(() => {
    const sourceFrame = selectionDocument.defaultView?.frameElement
    const onCtx = (e: MouseEvent): void => {
      const sel = selectionDocument.getSelection()
      const target = elementFromSelectionNode(e.target as Node | null)
      const anchor = elementFromSelectionNode(sel?.anchorNode)
      const el = anchor ?? target
      const editorDetail = editorSelectionRef.current
      const targetEditor = target?.closest('.cm-editor') ?? null
      const anchorEditor = anchor?.closest('.cm-editor') ?? null
      const activeEditor = selectionDocument.activeElement?.closest('.cm-editor') ?? null
      const contextEditor = targetEditor ?? anchorEditor
      const isEditorContext =
        !!contextEditor && (anchorEditor === contextEditor || activeEditor === contextEditor)
      const markdown = isEditorContext && editorDetail?.markdown?.trim() ? editorDetail.markdown : undefined
      const text = (markdown ?? sel?.toString() ?? '').trim()
      if (!text || !canShowSelectionActions(el)) return // 선택 없으면 기본 메뉴
      const selectionSource = selectionSourceForElement(el, text, markdown ? editorDetail : null)
      const frameRect = sourceFrame?.getBoundingClientRect()
      e.preventDefault()
      setMenu({
        x: e.clientX + (frameRect?.left ?? 0) + (sourceFrame?.clientLeft ?? 0),
        y: e.clientY + (frameRect?.top ?? 0) + (sourceFrame?.clientTop ?? 0),
        text,
        queryText: markdown ? markdownToPlainText(markdown) || text : text,
        markdown,
        editorDraftId: editorDetail?.editorDraftId,
        askOpts: askOptionsForSelectionElement(sourceFrame ?? el, selectionSource)
      })
    }
    const onEditorSelection = (event: Event): void => {
      const detail = (event as CustomEvent<TextSelectionOverlayDetail | null>).detail
      editorSelectionRef.current = detail?.markdown?.trim() ? detail : null
    }
    const close = (): void => setMenu(null)
    selectionDocument.addEventListener('contextmenu', onCtx)
    selectionDocument.addEventListener('click', close)
    selectionDocument.addEventListener('scroll', close, true)
    if (!sourceFrame) window.addEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      selectionDocument.removeEventListener('contextmenu', onCtx)
      selectionDocument.removeEventListener('click', close)
      selectionDocument.removeEventListener('scroll', close, true)
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
  }, [selectionDocument])

  if (!menu) return null
  const q = encodeURIComponent(menu.queryText)
  const open = (url: string): void => void window.lt.app.openExternal(url)
  const items: { label: string; act: () => void }[] = [
    ...(menu.markdown
      ? [
          {
            label: '가운데 정렬',
            act: () => centerMarkdownSelection(menu.editorDraftId)
          },
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
    {
      label: '✳ Claude에 물어보기',
      act: () => {
        if (!quoteAgentPanelSelection(menu.askOpts)) onAsk(menu.text, menu.askOpts)
      }
    },
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
function SelectionAsk({ onAsk, onInline, inlineOpen = false, selectionDocument = document }: SelectionActionProps): JSX.Element | null {
  const [box, setBox] = useState<SelectionActionBox | null>(null)
  const boxRef = useRef(box)
  boxRef.current = box
  useEffect(() => {
    if (!onInline) return
    const openFromKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || inlineOpen ||
          !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return
      if (elementFromSelectionNode(event.target as Node | null)?.closest(selectionDocument === document ? '.agent-panel, .terminal-surface, input, textarea, select' : 'input, textarea, select')) return
      const selected = boxRef.current
      if (!selected?.askOpts?.selectionSource?.docId) return
      event.preventDefault()
      event.stopPropagation()
      onInline(selected)
    }
    selectionDocument.addEventListener('keydown', openFromKey, true)
    return () => selectionDocument.removeEventListener('keydown', openFromKey, true)
  }, [onInline, inlineOpen, selectionDocument])

  useEffect(() => {
    const sourceFrame = selectionDocument.defaultView?.frameElement
    let frame = 0
    let pointerSelecting = false
    let pendingEditorDetail: TextSelectionOverlayDetail | null = null

    const updateFromSelection = (): void => {
      if (document.activeElement?.closest('.inline-selection-command')) return
      const sel = selectionDocument.getSelection()
      const text = sel?.toString() ?? ''
      const visibleText = text.trim()
      if (!sel || sel.rangeCount === 0 || !visibleText) {
        if (!selectionDocument.activeElement?.closest('.cm-editor')) {
          setBox(null)
        }
        return
      }
      const el = elementFromSelectionNode(sel.anchorNode)
      if (!canShowSelectionActions(el) || (sourceFrame && !sourceFrame.getClientRects().length)) {
        setBox(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setBox(null)
        return
      }
      const frameRect = sourceFrame?.getBoundingClientRect()
      setBox({
        x: rect.left + rect.width / 2 + (frameRect?.left ?? 0) + (sourceFrame?.clientLeft ?? 0),
        y: rect.top - 6 + (frameRect?.top ?? 0) + (sourceFrame?.clientTop ?? 0),
        bottom: rect.bottom + (frameRect?.top ?? 0) + (sourceFrame?.clientTop ?? 0),
        domRange: sel.getRangeAt(0).cloneRange(),
        sourceElement: (sourceFrame ?? el)?.closest<HTMLElement>('[data-doc-id]') ?? undefined,
        text,
        count: Array.from(visibleText).length,
        askOpts: askOptionsForSelectionElement(
          sourceFrame ?? el,
          selectionSourceForElement(el, visibleText)
        )
      })
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
      const activeEditor = document.activeElement instanceof Element ? document.activeElement.closest('.cm-editor') : null
      const docElement = activeEditor?.closest('[data-doc-id]') ?? null
      const selectionSource = selectionSourceForElement(docElement, detail.text, detail)
      setBox({
        ...detail,
        sourceElement: docElement instanceof HTMLElement ? docElement : undefined,
        askOpts: askOptionsForSelectionElement(docElement, selectionSource)
      })
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary || event.button !== 0) return
      if (isSelectionActionControl(event.target)) return
      if (frame) cancelAnimationFrame(frame)
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
      if (frame) cancelAnimationFrame(frame)
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
    const onOuterPointerDown = (event: PointerEvent): void => {
      if (!isSelectionActionControl(event.target)) onPointerCancel()
    }

    selectionDocument.addEventListener('pointerup', onPointerUp)
    selectionDocument.addEventListener('pointerdown', onPointerDown)
    selectionDocument.addEventListener('pointercancel', onPointerCancel)
    selectionDocument.addEventListener('dragstart', onPointerCancel, true)
    selectionDocument.addEventListener('selectionchange', scheduleUpdate)
    selectionDocument.addEventListener('keyup', scheduleUpdate)
    if (sourceFrame) {
      selectionDocument.addEventListener('scroll', onPointerCancel, true)
      document.addEventListener('scroll', onPointerCancel, true)
      document.addEventListener('pointerdown', onOuterPointerDown)
      window.addEventListener('resize', onPointerCancel)
    } else {
      window.addEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
    window.addEventListener('blur', onPointerCancel)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      selectionDocument.removeEventListener('pointerup', onPointerUp)
      selectionDocument.removeEventListener('pointerdown', onPointerDown)
      selectionDocument.removeEventListener('pointercancel', onPointerCancel)
      selectionDocument.removeEventListener('dragstart', onPointerCancel, true)
      selectionDocument.removeEventListener('selectionchange', scheduleUpdate)
      selectionDocument.removeEventListener('keyup', scheduleUpdate)
      selectionDocument.removeEventListener('scroll', onPointerCancel, true)
      document.removeEventListener('scroll', onPointerCancel, true)
      document.removeEventListener('pointerdown', onOuterPointerDown)
      window.removeEventListener('resize', onPointerCancel)
      window.removeEventListener('blur', onPointerCancel)
      window.removeEventListener(TEXT_SELECTION_OVERLAY_EVENT, onEditorSelection)
    }
  }, [selectionDocument])

  if (!box || inlineOpen) return null
  const centerDraftId = box.editorDraftId
  return (
    <div
      className="sel-actions"
      style={{ left: box.x, top: box.y }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {centerDraftId && (
        <button
          type="button"
          onClick={() => {
            centerMarkdownSelection(centerDraftId)
            setBox(null)
          }}
        >
          가운데
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          if (onInline && box.askOpts?.selectionSource?.docId) onInline(box)
          else if (!quoteAgentPanelSelection(box.askOpts)) onAsk(box.text, box.askOpts)
          setBox(null)
          selectionDocument.getSelection()?.removeAllRanges()
        }}
      >
        {onInline && box.askOpts?.selectionSource?.docId ? '이 부분에 지시 · ⌘/Ctrl+J' : '✳ Claude에 묻기'}
      </button>
    </div>
  )
}

function modeLabel(mode: Mode): string {
  return { explorer: '탐색기', cases: '사건', viewer: '기록뷰어', todos: '할일' }[mode]
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
  onRefresh,
  onRemotionPreview,
  onOpenFile,
  onDropTo,
  onMove,
  onRename,
  onDelete,
  onPasteTo,
  onDownload,
  onSyncFile,
  onOpenWorkspaceFromFolder,
  onGoParentFolder,
  onPickDrafts,
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
  onOpenLocalCase,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onPickCaseRecords,
  onBrief,
  onHearingRecord,
  jsNonce,
  todoSnapshot,
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
  onRefresh: () => void
  onRemotionPreview: () => void
  onOpenFile: (path: string, name: string) => void
  onDropTo: (dir: string, files: FileList) => void
  onMove: (src: string, destDir: string) => void
  onRename: (path: string, name: string) => void
  onDelete: (path: string, name: string, isDir: boolean) => void | Promise<void>
  onPasteTo: (dir: string) => void
  onDownload: (paths: string[]) => void
  onSyncFile?: (path: string, name: string) => void
  onOpenWorkspaceFromFolder: (path: string, name: string) => void
  onGoParentFolder: () => void
  onPickDrafts: () => void
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
  onOpenLocalCase: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onPickCaseRecords?: (c: JsCase) => void | Promise<void>
  onBrief: (c: JsCase) => void
  onHearingRecord?: (c: JsCase) => void
  jsNonce: number
  todoSnapshot: TodoSnapshot
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
                <ExplorerToolButton label="새 사건 추가" tooltip="새 사건 추가" onClick={onOpenWorkspace}>
                  <IconWorkspace size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="상위 폴더로 이동"
                  tooltip="상위 폴더로 이동"
                  disabled={!draftsFolder}
                  onClick={onGoParentFolder}
                >
                  <IconParentFolder size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="작성서류 폴더 변경"
                  tooltip="작성서류 폴더 변경"
                  disabled={!draftsFolder}
                  onClick={onPickDrafts}
                >
                  <IconSaveAs size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton label="Remotion 미리보기" tooltip="현재 프로젝트의 Remotion 미리보기" disabled={!draftsFolder} onClick={onRemotionPreview}>
                  <span aria-hidden="true">▶</span>
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="폴더 새로고침"
                  tooltip="현재 폴더 목록 새로고침"
                  disabled={!draftsFolder}
                  onClick={onRefresh}
                >
                  <span aria-hidden="true">⟳</span>
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="소송기록 폴더 변경"
                  tooltip="소송기록 폴더 변경"
                  disabled={!draftsFolder}
                  onClick={onPickRecords}
                >
                  <IconViewer size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="새 파일"
                  tooltip="새 파일 만들기"
                  disabled={!draftsFolder}
                  onClick={onNewFile}
                >
                  <IconNewFile size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="파일명 찾기"
                  tooltip="파일명 찾기"
                  className={fileFindOpen ? 'on' : ''}
                  disabled={!draftsFolder}
                  onClick={() => setFileFindOpen((v) => !v)}
                >
                  <IconSearch size={15} />
                </ExplorerToolButton>
                <ExplorerToolButton
                  label="새 폴더"
                  tooltip="새 폴더 만들기"
                  disabled={!draftsFolder}
                  onClick={onNewFolder}
                >
                  <IconNewFolder size={15} />
                </ExplorerToolButton>
                {onSync && (
                  <ExplorerToolButton
                    label="동기화"
                    tooltip="rclone 동기화 (로컬 ↔ 맥미니)"
                    disabled={!draftsFolder}
                    onClick={onSync}
                  >
                    <IconSync size={15} />
                  </ExplorerToolButton>
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
                  <button className="tool-btn" title="소송기록 폴더 목록 새로고침" onClick={onRefresh}>
                    <span aria-hidden="true">⟳</span>
                    <span className="sr-only">소송기록 폴더 새로고침</span>
                  </button>
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
              onSyncFile={onSyncFile}
              onOpenWorkspaceFromFolder={onOpenWorkspaceFromFolder}
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
            onOpenWorkspace={onOpenLocalCase}
            onOpenRemote={onOpenRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultOpenProfileId}
            onPickRecords={onPickCaseRecords}
            onBrief={onBrief}
            onHearingRecord={onHearingRecord}
            onTodoChanged={onTodoChanged}
          />
        )}
        {mode === 'todos' && <div className="muted pad small">오늘 요약에서 기한과 선택한 업무를 확인하세요.</div>}
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
    dirty?: boolean
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
  getContextMenuItems?: (id: string) => TabBarAction[]
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
  onRename,
  getContextMenuItems
}: TabBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [dropHint, setDropHint] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number
    y: number
    items: TabBarAction[]
  } | null>(null)
  const dragId = useRef<string | null>(null)
  const dropHintTimer = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const renameDone = useRef(false)
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

  useEffect(() => {
    if (!tabContextMenu) return
    const close = (): void => setTabContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', close)
    }
  }, [tabContextMenu])

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
  const startRename = (id: string, value: string): void => {
    renameDone.current = false
    setEditing({ id, value })
  }
  const finishRename = (id: string, fallbackTitle: string, commit: boolean): void => {
    if (!editing || editing.id !== id || renameDone.current) return
    renameDone.current = true
    if (commit) onRename?.(id, editing.value.trim() || fallbackTitle)
    setEditing(null)
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
            className={`tab ${t.id === activeId ? 'active' : ''} ${t.attention ? 'attention' : ''} ${t.working ? 'working' : ''} ${t.question ? 'question' : ''} ${t.dirty ? 'dirty' : ''}`}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => {
              const items = getContextMenuItems?.(t.id) ?? []
              if (items.length === 0) return
              e.preventDefault()
              e.stopPropagation()
              onSelect(t.id)
              setMenuOpen(false)
              const menuWidth = 220
              const menuHeight = Math.min(360, items.length * 34 + 10)
              setTabContextMenu({
                x: Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8)),
                y: Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8)),
                items
              })
            }}
            onAuxClick={(e) => closeOnMiddleClick(e, t.id)}
            title={
              t.working
                ? `${t.tooltip ?? t.title}\n⟳ 작업 중`
                : t.question
                  ? `${t.tooltip ?? t.title}\n❓ 확인/질문 대기`
                  : t.attention
                    ? `${t.tooltip ?? t.title}\n✓ 완료`
                    : t.dirty
                      ? `${t.tooltip ?? t.title}\n저장하지 않은 변경사항`
                    : (t.tooltip ?? t.title)
            }
            draggable={draggable && editing?.id !== t.id}
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
                    startRename(t.id, t.title)
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
            ) : t.dirty ? (
              <span className="tab-dirty" title="저장하지 않은 변경사항">
                ●
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
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (isComposingInputKeyEvent(e)) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    finishRename(t.id, t.title, true)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    finishRename(t.id, t.title, false)
                  }
                }}
                onBlur={() => finishRename(t.id, t.title, true)}
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
      {tabContextMenu && (
        <div
          className="tab-context-menu"
          role="menu"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {tabContextMenu.items.map((item, i) => (
            <button
              key={i}
              className="tab-context-menu-item"
              role="menuitem"
              title={item.title}
              onClick={(e) => {
                e.stopPropagation()
                setTabContextMenu(null)
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
  onResume: (sessionId: string, cwd: string, title?: string, source?: TermTab, originDevice?: TermTab['originDevice']) => void
  onClose: () => void
}): JSX.Element {
  const [past, setPast] = useState<SessionListEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [pastLimit, setPastLimit] = useState(SESSION_SEARCH_RECENT_LIMIT)

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
    const cached = cachedPastSessions(filterCwd, filterSource, query, pastLimit)
    if (cached) setPast(cached)
    else setPast(null)
    loadPastSessions(filterCwd, filterSource, query, false, pastLimit)
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
    query,
    pastLimit
  ])

  const shownPast = past?.filter((s) =>
    matchesSearch(
      [s.transcriptTitle, s.title, s.caseNumber, s.caseName, s.folderName, s.cwd, s.sessionId],
      query
    )
  )

  // 날짜 그룹(오늘/어제/…) + 그룹 안에서는 시각만 — 훑어보기 좋게
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayLabel = (ms: number): string => {
    const diffDays = Math.floor((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86400000)
    if (diffDays <= 0) return '오늘'
    if (diffDays === 1) return '어제'
    if (diffDays < 7) return '지난 7일'
    if (diffDays < 30) return '지난 30일'
    return '이전'
  }
  const fmt = (ms: number): string => {
    const d = new Date(ms)
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const diffDays = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86400000)
    return diffDays <= 1 ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
  }
  const filterFolder = pathLeaf(filterCwd)

  return (
    <div
      className="session-list"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sl-head">
        <span className="sl-title">세션</span>
        <select
          className="sl-filter"
          value={filter}
          onChange={(e) => {
            setPastLimit(SESSION_SEARCH_RECENT_LIMIT)
            onFilter(e.target.value)
          }}
        >
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
          onChange={(e) => {
            setQuery(e.target.value)
            setPastLimit(SESSION_SEARCH_RECENT_LIMIT)
          }}
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
              {[s.sessionTitle, s.client && `의뢰인 ${s.client}`, s.court]
                .filter(Boolean)
                .join(' · ') || s.cwd}
            </span>
          </li>
        ))}

        <li className="sl-section">과거 세션 (이어서 열기)</li>
        {!filterCwd && <li className="muted pad small">사건을 먼저 여세요.</li>}
        {filterCwd && past === null && <li className="muted pad small">불러오는 중…</li>}
        {filterCwd && shownPast && shownPast.length === 0 && (
          <li className="muted pad small">
            {query.trim() ? `최근 ${pastLimit}개에서 검색 결과가 없습니다.` : '과거 세션이 없습니다.'}
          </li>
        )}
        {filterCwd &&
          shownPast?.map((p, i) => {
            const group = dayLabel(p.mtime)
            const prevGroup = i > 0 ? dayLabel(shownPast[i - 1].mtime) : undefined
            // 대화 내용 제목을 앞세우고, 사건/폴더 맥락은 보조 줄로
            const name = p.transcriptTitle || p.title || '(제목 없음)'
            const caseLabel =
              [p.caseNumber, p.caseName].filter(Boolean).join(' ') ||
              (p.folderName !== filterFolder ? p.folderName : undefined)
            return (
              <Fragment key={p.sessionId}>
                {group !== prevGroup && <li className="sl-daysep">{group}</li>}
                <li
                  className="sl-row past"
                  onClick={() => onResume(p.sessionId, p.cwd ?? filterCwd, p.title, filterSource, p.originDevice)}
                  title={`${p.sessionId}\n${p.cwd ?? filterCwd}\nclaude --resume 로 이어서 열기`}
                >
                  <span className="sl-name">{name}</span>
                  <span className="sl-sub">
                    <span className="sl-time">{fmt(p.mtime)}</span>
                    {caseLabel && filter === 'all' ? ` · ${caseLabel}` : ''}
                  </span>
                </li>
              </Fragment>
            )
          })}
        {query.trim() &&
          past &&
          past.length >= pastLimit &&
          pastLimit < SESSION_SEARCH_MAX_LIMIT && (
            <li className="sl-more-row">
              <button
                className="sl-more"
                type="button"
                onClick={() => setPastLimit(expandSessionSearchLimit)}
              >
                더 오래된 세션에서 검색
              </button>
            </li>
          )}
      </ul>
    </div>
  )
}

const RECENT_CASES_PAGE_SIZE = 10

function Welcome({
  recent,
  onOpen,
  summary
}: {
  summary?: ReactNode
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
      <p className="subtitle">사건기록부터 준비서면까지, 한 화면에서.</p>
      {summary}

      <SetupChecklist />

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

type CodeLanguage = 'json' | 'html'

interface CodeTokenRange {
  start: number
  end: number
  className: string
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

function codeLanguageForPath(path: string): CodeLanguage | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (HTML_EXT_RE.test(lower)) return 'html'
  return undefined
}

function jsonTokenRanges(text: string): CodeTokenRange[] {
  const ranges: CodeTokenRange[] = []
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g
  for (const match of text.matchAll(tokenRe)) {
    const raw = match[0]
    const start = match.index ?? 0
    if (match[1]) {
      ranges.push({
        start,
        end: start + match[1].length,
        className: match[2] ? 'code-json-key' : 'code-string'
      })
    } else if (/^-?\d/.test(raw)) {
      ranges.push({ start, end: start + raw.length, className: 'code-number' })
    } else if (/^(?:true|false|null)$/.test(raw)) {
      ranges.push({ start, end: start + raw.length, className: 'code-atom' })
    } else {
      ranges.push({ start, end: start + raw.length, className: 'code-punct' })
    }
  }
  return ranges
}

function htmlTagTokenRanges(start: number, tag: string): CodeTokenRange[] {
  const ranges: CodeTokenRange[] = []
  const tagName = tag.match(/^<\/?\s*([A-Za-z][\w:.-]*)/)
  ranges.push({ start, end: start + (tag.startsWith('</') ? 2 : 1), className: 'code-punct' })
  if (tag.endsWith('/>')) ranges.push({ start: start + tag.length - 2, end: start + tag.length, className: 'code-punct' })
  else ranges.push({ start: start + tag.length - 1, end: start + tag.length, className: 'code-punct' })
  if (tagName?.index !== undefined) {
    const nameStart = start + tagName.index + tagName[0].lastIndexOf(tagName[1])
    ranges.push({ start: nameStart, end: nameStart + tagName[1].length, className: 'code-html-tag' })
  }
  const attrStart = tagName ? tagName.index! + tagName[0].length : 1
  const attrs = tag.slice(attrStart, tag.endsWith('/>') ? -2 : -1)
  const attrRe = /([:@A-Za-z_][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g
  for (const match of attrs.matchAll(attrRe)) {
    const name = match[1]
    const localStart = attrStart + (match.index ?? 0)
    const absoluteStart = start + localStart
    ranges.push({ start: absoluteStart, end: absoluteStart + name.length, className: 'code-html-attr' })
    if (match[2]) {
      const equalStart = absoluteStart + name.length
      ranges.push({ start: equalStart, end: equalStart + match[2].length, className: 'code-punct' })
    }
    if (match[3]) {
      const valueStart = absoluteStart + name.length + (match[2]?.length ?? 0)
      ranges.push({ start: valueStart, end: valueStart + match[3].length, className: 'code-string' })
    }
  }
  return ranges
}

function htmlTokenRanges(text: string): CodeTokenRange[] {
  const ranges: CodeTokenRange[] = []
  const tokenRe = /<!--[\s\S]*?-->|<!doctype[\s\S]*?>|<\/?[A-Za-z][^>]*?>/gi
  for (const match of text.matchAll(tokenRe)) {
    const token = match[0]
    const start = match.index ?? 0
    if (token.startsWith('<!--')) {
      ranges.push({ start, end: start + token.length, className: 'code-comment' })
    } else if (/^<!doctype/i.test(token)) {
      ranges.push({ start, end: start + token.length, className: 'code-doctype' })
    } else {
      ranges.push(...htmlTagTokenRanges(start, token))
    }
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end)
}

function codeTokenRanges(text: string, language?: CodeLanguage): CodeTokenRange[] {
  if (language === 'json') return jsonTokenRanges(text)
  if (language === 'html') return htmlTokenRanges(text)
  return []
}

/** 텍스트 문서 표시 — 자동 줄바꿈 기본 ON(토글) */
function TextDoc({
  text,
  note,
  language,
  actions,
  scrollKey,
  initialScroll,
  onScrollPosition
}: {
  text: string
  note?: string
  language?: CodeLanguage
  actions?: ReactNode
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
}): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const [docFont, setDocFont] = useState({ family: DEFAULT_MD_FONT, size: DEFAULT_MD_FONT_SIZE })
  const rootRef = useRef<HTMLDivElement>(null)
  const { ref: scrollRef, onScroll } = useRestoredScroll<HTMLPreElement>(
    scrollKey,
    initialScroll,
    onScrollPosition,
    text.length
  )
  const ranges = findTextRanges(text, findQuery)
  const tokenRanges = useMemo(() => codeTokenRanges(text, language), [language, text])
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
    if (!ranges.length && !tokenRanges.length) return text
    const bounds = new Set([0, text.length])
    for (const range of ranges) {
      bounds.add(range.start)
      bounds.add(range.end)
    }
    for (const range of tokenRanges) {
      bounds.add(range.start)
      bounds.add(range.end)
    }
    const points = [...bounds].sort((a, b) => a - b)
    const parts: ReactNode[] = []
    let tokenCursor = 0
    let findCursor = 0
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i]
      const end = points[i + 1]
      if (start === end) continue
      while (tokenRanges[tokenCursor] && tokenRanges[tokenCursor].end <= start) tokenCursor++
      while (ranges[findCursor] && ranges[findCursor].end <= start) findCursor++
      const token = tokenRanges[tokenCursor]
      const matchedToken = token && token.start <= start && end <= token.end
      const findRange = ranges[findCursor]
      const matchedFind = findRange && findRange.start <= start && end <= findRange.end
      const chunk = text.slice(start, end)
      const node = matchedToken ? <span className={token.className}>{chunk}</span> : chunk
      parts.push(
        matchedFind ? (
          <mark
            key={`${start}-${end}`}
            className={findCursor === activeFindIndex ? 'text-find-active' : 'text-find-match'}
          >
            {node}
          </mark>
        ) : (
          <span key={`${start}-${end}`}>{node}</span>
        )
      )
    }
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
        {actions && (
          <>
            <span className="tb-divider" />
            {actions}
          </>
        )}
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
        ref={scrollRef}
        className={`file-view ${wrap ? 'wrap' : ''}`}
        style={{ fontFamily: docFont.family, fontSize: `${docFont.size}px` }}
        onScroll={onScroll}
      >
        {renderText()}
        {note ? '\n\n' + note : ''}
      </pre>
    </div>
  )
}

/** 텍스트 파일 미리보기 (md/txt/csv/json…). MD 옵시디언식 라이브 프리뷰는 추후 CodeMirror로. */
function FileView({
  path,
  scrollKey,
  initialScroll,
  onScrollPosition
}: {
  path: string
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
}): JSX.Element {
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
  return (
    <TextDoc
      text={state.text}
      note={state.truncated ? '… (이하 생략, 2MB 초과)' : undefined}
      language={codeLanguageForPath(path)}
      scrollKey={scrollKey}
      initialScroll={initialScroll}
      onScrollPosition={onScrollPosition}
    />
  )
}

function localFileBaseHref(path: string): string | undefined {
  if (path.startsWith('ssh://')) return undefined
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash < 0) return undefined
  let encoded = path
    .slice(0, slash + 1)
    .replace(/\\/g, '/')
    .split('/')
    .map((part, index) => (index === 0 && part === '' ? '' : encodeURIComponent(part)))
    .join('/')
  encoded = encoded.replace(/^([A-Za-z])%3A\//, '$1:/')
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

const HTML_VIEWER_DEFAULT_STYLE = `<style data-lt-html-viewer-defaults>
:root { color-scheme: light; }
::highlight(inline-command-source) { background-color: rgba(98, 170, 245, 0.35); }
html {
  min-height: 100%;
  background: #f3f4f6;
}
body {
  box-sizing: border-box;
  max-width: 960px;
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 40px 48px;
  color: #1f2328;
  background: #fff;
  font: 15px/1.72 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
h1, h2, h3, h4 {
  line-height: 1.3;
  margin: 1.35em 0 0.55em;
}
p, ul, ol, blockquote, table, pre {
  margin-top: 0;
  margin-bottom: 1em;
}
ul, ol { padding-left: 1.6em; }
blockquote {
  padding-left: 1em;
  border-left: 3px solid #d0d7de;
  color: #57606a;
}
img, video {
  max-width: 100%;
  height: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 0.5em 0.65em;
  border: 1px solid #d0d7de;
}
pre {
  overflow: auto;
  padding: 14px 16px;
  border-radius: 6px;
  background: #f6f8fa;
}
code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
@media (max-width: 720px) {
  body { padding: 22px 20px 36px; }
}
</style>`

function htmlWithLocalBase(html: string, path: string): string {
  const base = localFileBaseHref(path)
  const tags = `${base && !/<base\b/i.test(html) ? `<base href="${base}">` : ''}${HTML_VIEWER_DEFAULT_STYLE}`
  return /<head[\s>]/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, (head) => head + tags)
    : tags + html
}

function HtmlView({ path, onAsk, onInline, inlineOpen }: SelectionActionProps & { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [selectionDocument, setSelectionDocument] = useState<Document | null>(null)
  const [mode, setMode] = useState<'render' | 'code'>('render')
  const [state, setState] = useState<{ loading: boolean; text: string; truncated: boolean; err: string }>({
    loading: true,
    text: '',
    truncated: false,
    err: ''
  })

  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', truncated: false, err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          text: r.kind === 'text' ? r.text : '',
          truncated: !!r.truncated,
          err: r.kind === 'text' ? '' : 'HTML로 볼 수 없는 파일입니다.'
        })
      })
      .catch((e) => alive && setState({ loading: false, text: '', truncated: false, err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>
  if (mode === 'code') {
    return (
      <TextDoc
        text={state.text}
        note={state.truncated ? '… (이하 생략, 2MB 초과)' : undefined}
        language="html"
        actions={
          <button className="tb-btn" title="HTML 렌더링 보기" onClick={() => setMode('render')}>
            렌더
          </button>
        }
      />
    )
  }

  return (
    <div className="html-doc">
      <div className="text-toolbar">
        <button className="tb-btn on" title="HTML 렌더링 보기">
          렌더
        </button>
        <button className="tb-btn" title="HTML 코드 보기" onClick={() => setMode('code')}>
          코드
        </button>
        <span className="tb-divider" />
        {!path.startsWith('ssh://') && (
          <button
            className="tb-btn"
            title="스크립트와 복사 기능을 사용하려면 기본 브라우저로 열기"
            onClick={() => void window.lt.app.openHtml(path)}
          >
            브라우저로 열기
          </button>
        )}
        <span className="muted small">스크립트는 미리보기에서 실행되지 않습니다.</span>
      </div>
      <iframe
        className="html-frame"
        title={fileNameFromPath(path)}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={htmlWithLocalBase(state.text, path)}
        onLoad={(event) => setSelectionDocument(event.currentTarget.contentDocument)}
      />
      {selectionDocument && <SelectionAsk onAsk={onAsk} onInline={onInline} inlineOpen={inlineOpen} selectionDocument={selectionDocument} />}
      {selectionDocument && <SelectionMenu onAsk={onAsk} selectionDocument={selectionDocument} />}
    </div>
  )
}

/** HWP/HWPX — 본문과 표를 Markdown으로 추출해 표시 */
function HwpView({
  path,
  scrollKey,
  initialScroll,
  onScrollPosition
}: {
  path: string
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
}): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; markdown: string; err: string }>({
    loading: true,
    markdown: '',
    err: ''
  })
  useEffect(() => {
    let alive = true
    setState({ loading: true, markdown: '', err: '' })
    window.lt.fs
      .readHwpMarkdown(path)
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          markdown: r.markdown,
          err: r.ok ? '' : r.error || 'Markdown 추출 실패'
        })
      })
      .catch((e) => alive && setState({ loading: false, markdown: '', err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  const saveMarkdown = async (): Promise<void> => {
    const defaultName = fileNameFromPath(path).replace(/\.(hwp|hwpx)$/i, '.md')
    const defaultPath = path.startsWith('ssh://') ? defaultName : path.replace(/\.(hwp|hwpx)$/i, '.md')
    const result = await window.lt.fs.saveAs(state.markdown, defaultPath)
    if (!result.ok && result.error) await window.lt.dialog.alert('Markdown 저장 실패: ' + result.error)
  }

  if (state.loading) return <div className="welcome"><p className="muted">HWP/HWPX Markdown 추출 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">{state.err}</p></div>
  return (
    <TextDoc
      text={state.markdown}
      scrollKey={scrollKey}
      initialScroll={initialScroll}
      onScrollPosition={onScrollPosition}
      actions={
        <button
          className="tb-btn"
          title="Markdown 파일로 저장"
          disabled={!state.markdown}
          onClick={() => void saveMarkdown()}
        >
          <IconSave size={14} />
          <span>MD</span>
        </button>
      }
    />
  )
}

/** DOCX — Word 본문 텍스트만 추출해 표시 */
function DocxView({
  path,
  scrollKey,
  initialScroll,
  onScrollPosition
}: {
  path: string
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
}): JSX.Element {
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
      .readDocxText(path)
      .then((r) => {
        if (!alive) return
        setState({ loading: false, text: r.text, err: r.ok ? '' : r.error || '추출 실패' })
      })
      .catch((e) => alive && setState({ loading: false, text: '', err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])
  if (state.loading) return <div className="welcome"><p className="muted">DOCX 텍스트 추출 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">{state.err}</p></div>
  return (
    <TextDoc
      text={state.text}
      scrollKey={scrollKey}
      initialScroll={initialScroll}
      onScrollPosition={onScrollPosition}
    />
  )
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
function CsvView({
  path,
  scrollKey,
  initialScroll,
  onScrollPosition
}: {
  path: string
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
}): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; rows: string[][]; err: string }>({
    loading: true,
    rows: [],
    err: ''
  })
  const [mode, setMode] = useState<'table' | 'color'>('table')
  const { ref: scrollRef, onScroll } = useRestoredScroll<HTMLDivElement>(
    scrollKey,
    initialScroll,
    onScrollPosition,
    `${state.rows.length}:${mode}`
  )

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
      <div className="csv-wrap" ref={scrollRef} onScroll={onScroll}>
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
  scrollKey,
  initialScroll,
  onScrollPosition,
  onNavigate
}: {
  path: string
  scrollKey?: string
  initialScroll?: DocScrollPosition
  onScrollPosition?: (position: DocScrollPosition) => void
  onNavigate?: (dir: 1 | -1) => void
}): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'fit_page' | 'fit_width' | 'custom'>('fit_page')
  const [scale, setScale] = useState(1)
  const { ref: wrapRef, onScroll } = useRestoredScroll<HTMLDivElement>(
    scrollKey,
    initialScroll,
    onScrollPosition,
    `${url}:${mode}:${scale}`
  )
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
        onScroll={onScroll}
        onWheel={onWheel}
      >
        {url && <img src={url} style={imgStyle} draggable={false} alt="" />}
      </div>
    </div>
  )
}

type UpdateUiState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest' }
  | { status: 'available'; latestVersion: string }
  | { status: 'error'; message: string }

function SettingsView({ onSync }: { onSync: (init: SyncModalInit) => void }): JSX.Element {
  const [s, setS] = useState<AppSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [appVersion, setAppVersion] = useState('확인 중...')
  const [update, setUpdate] = useState<UpdateUiState>({ status: 'idle' })
  const [termFontSizeInput, setTermFontSizeInput] = useState(String(DEFAULT_TERM_FONT_SIZE))
  const [mdFontSizeInput, setMdFontSizeInput] = useState(String(DEFAULT_MD_FONT_SIZE))
  const [agentFontSizeInput, setAgentFontSizeInput] = useState(String(DEFAULT_AGENT_FONT_SIZE))
  const [notificationVolumeInput, setNotificationVolumeInput] = useState(DEFAULT_NOTIFICATION_VOLUME)
  const [jsTokenStatus, setJsTokenStatus] = useState<'ok' | 'missing' | 'locked' | null>(null)
  const [jsTokenInput, setJsTokenInput] = useState('')
  const [jsTokenMsg, setJsTokenMsg] = useState('')
  const [dictationKeyStatus, setDictationKeyStatus] = useState<
    'ok' | 'missing' | 'locked' | 'unavailable' | null
  >(null)
  const [dictationKeyInput, setDictationKeyInput] = useState('')
  const [dictationKeyMsg, setDictationKeyMsg] = useState('')
  const [office, setOffice] = useState<OfficeProfileSettings>({})
  const [officeMsg, setOfficeMsg] = useState('')

  useEffect(() => {
    const applySettings = (v: AppSettings): void => {
      setS({
        ...v,
        caseOpenTarget: resolveCaseOpenTarget(v.caseOpenTarget, v.sshProfiles ?? [])
      })
      setLoaded(true)
    }
    window.lt.settings.get().then(applySettings)
    window.lt.app.info().then((info) => setAppVersion(info.version)).catch(() => setAppVersion('알 수 없음'))
    window.lt.js.tokenStatus().then(setJsTokenStatus).catch(() => setJsTokenStatus(null))
    window.lt.dictation.keyStatus().then(setDictationKeyStatus).catch(() => setDictationKeyStatus(null))
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  const checkUpdateNow = async (): Promise<void> => {
    setUpdate({ status: 'checking' })
    const r = await window.lt.update.check()
    if (!r.ok) {
      setUpdate({ status: 'error', message: r.error ?? '알 수 없는 오류' })
    } else if (!r.updateAvailable || !r.latestVersion) {
      setUpdate({ status: 'latest' })
    } else {
      setUpdate({ status: 'available', latestVersion: r.latestVersion })
    }
  }

  // JuriSupport 토큰 저장/삭제 — 대시보드·기일 패널이 이벤트로 즉시 다시 연결된다.
  const applyJsToken = async (token: string, doneMsg: string): Promise<void> => {
    try {
      await window.lt.js.setToken(token)
      setJsTokenInput('')
      setJsTokenMsg(doneMsg)
      setJsTokenStatus(await window.lt.js.tokenStatus())
      clearCaseListCache()
      window.dispatchEvent(new Event(JS_TOKEN_UPDATED_EVENT))
    } catch (e) {
      setJsTokenMsg(`실패: ${String(e instanceof Error ? e.message : e)}`)
    }
  }

  const saveJsToken = (): void => {
    const t = jsTokenInput.trim()
    if (t) void applyJsToken(t, '토큰을 저장했습니다. 사건 대시보드가 다시 연결됩니다.')
  }

  const deleteJsToken = async (): Promise<void> => {
    if (!(await window.lt.dialog.confirm('JuriSupport 토큰을 삭제할까요? 사건 대시보드 연결이 해제됩니다.'))) return
    await applyJsToken('', '토큰을 삭제했습니다.')
  }

  const applyDictationKey = async (key: string, message: string): Promise<void> => {
    try {
      await window.lt.dictation.setKey(key)
      setDictationKeyInput('')
      setDictationKeyMsg(message)
      setDictationKeyStatus(await window.lt.dictation.keyStatus())
    } catch (error) {
      setDictationKeyMsg(`실패: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  const saveDictationKey = (): void => {
    const key = dictationKeyInput.trim()
    if (key) void applyDictationKey(key, 'OpenAI API 키를 안전하게 저장했습니다.')
  }

  const deleteDictationKey = async (): Promise<void> => {
    if (!(await window.lt.dialog.confirm('OpenAI API 키를 삭제할까요? 음성 받아쓰기를 사용할 수 없게 됩니다.'))) return
    await applyDictationKey('', 'OpenAI API 키를 삭제했습니다.')
  }

  useEffect(() => {
    setOffice(s.officeProfile ?? {})
  }, [s.officeProfile])

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

  // 사무실 정보 — 입력 필드에서 포커스가 빠질 때 저장 (빈 값은 제거)
  const commitOffice = async (next: OfficeProfileSettings): Promise<void> => {
    const cleaned: OfficeProfileSettings = {}
    for (const [key, value] of Object.entries(next)) {
      const trimmed = typeof value === 'string' ? value.trim() : value
      if (trimmed) cleaned[key as keyof OfficeProfileSettings] = trimmed as never
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(s.officeProfile ?? {})) {
      await savePatch({ officeProfile: cleaned })
    }
  }

  const pickOfficeLogo = async (): Promise<void> => {
    const r = await window.lt.dialog.pickOfficeLogo()
    if (!r) return
    if (!('path' in r)) {
      setOfficeMsg(r.error)
      return
    }
    setOfficeMsg('')
    const next = { ...office, logoPath: r.path }
    setOffice(next)
    await commitOffice(next)
  }

  const officeField = (
    key: Exclude<keyof OfficeProfileSettings, 'footerText' | 'logoPath' | 'hideOfficeName'>,
    placeholder: string
  ): JSX.Element => (
    <input
      className="setting-input"
      placeholder={placeholder}
      value={office[key] ?? ''}
      onChange={(e) => setOffice({ ...office, [key]: e.target.value })}
      onBlur={() => {
        void commitOffice(office)
      }}
    />
  )

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
  const agentProviderValue = resolveAgentProvider(s.agentDefaultProvider)
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
        <div className="setting-label">현재 버전</div>
        <div className="setting-value">
          <code>{appVersion}</code>
          {update.status === 'available' ? (
            <button
              className="empty-action"
              onClick={() =>
                void window.lt.app.openExternal('https://github.com/jurisupport/legal-terminal')
              }
            >
              GitHub에서 받기
            </button>
          ) : (
            <button
              className="empty-action"
              disabled={update.status === 'checking'}
              onClick={() => void checkUpdateNow()}
            >
              {update.status === 'checking' ? '확인 중…' : '업데이트 확인'}
            </button>
          )}
          {update.status === 'latest' && <span className="muted small">최신 버전입니다.</span>}
          {update.status === 'available' && (
            <span className="muted small">새 버전 {update.latestVersion}이 나왔습니다.</span>
          )}
          {update.status === 'error' && (
            <span className="muted small">업데이트 확인 실패: {update.message}</span>
          )}
        </div>
      </section>

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
          OpenAI API 키 <span className="muted small">— 기일기록 음성 받아쓰기·AI 보정</span>
        </div>
        <div className="setting-value">
          <code>
            {dictationKeyStatus === 'ok' && '키 저장됨 (암호화) · API 연결·잔액 미확인'}
            {dictationKeyStatus === 'missing' && '미설정'}
            {dictationKeyStatus === 'locked' && '불러오기 실패 — 다시 붙여넣기 필요'}
            {dictationKeyStatus === 'unavailable' && '암호 저장소를 사용할 수 없음'}
            {dictationKeyStatus === null && '확인 중…'}
          </code>
          <input
            type="password"
            className="setting-input"
            placeholder="OpenAI API 키(sk-…) 붙여넣기"
            value={dictationKeyInput}
            disabled={dictationKeyStatus === 'unavailable'}
            onChange={(event) => setDictationKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveDictationKey()
            }}
          />
          <button
            className="empty-action"
            onClick={saveDictationKey}
            disabled={!dictationKeyInput.trim() || dictationKeyStatus === 'unavailable'}
          >
            저장
          </button>
          {dictationKeyStatus !== 'missing' && dictationKeyStatus !== null && (
            <button className="empty-action" onClick={deleteDictationKey}>
              삭제
            </button>
          )}
        </div>
        {dictationKeyStatus === 'unavailable' && (
          <p className="muted small">운영체제 암호 저장소를 사용할 수 없어 API 키를 저장하지 않습니다.</p>
        )}
        {dictationKeyMsg && <p className="muted small">{dictationKeyMsg}</p>}
      </section>

      <section className="setting-row">
        <div className="setting-label">
          JuriSupport 토큰 <span className="muted small">— 사건 대시보드·기일·할 일 연동 (MCP)</span>
        </div>
        <div className="setting-value">
          <code>
            {jsTokenStatus === 'ok' && '연결됨 (토큰 저장됨)'}
            {jsTokenStatus === 'missing' && '미설정'}
            {jsTokenStatus === 'locked' && '불러오기 실패 — 다시 붙여넣기 필요'}
            {jsTokenStatus === null && '확인 중…'}
          </code>
          <input
            type="password"
            className="setting-input"
            placeholder="새 MCP 토큰(eyJ…) 붙여넣기"
            value={jsTokenInput}
            onChange={(e) => setJsTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveJsToken()
            }}
          />
          <button className="empty-action" onClick={saveJsToken} disabled={!jsTokenInput.trim()}>
            저장
          </button>
          {jsTokenStatus !== 'missing' && jsTokenStatus !== null && (
            <button className="empty-action" onClick={deleteJsToken}>
              삭제
            </button>
          )}
        </div>
        {jsTokenStatus === 'locked' && (
          <p className="muted small">
            토큰이 저장돼 있지만 복호화하지 못했습니다. 앱 업데이트 후 키체인(암호 저장소) 접근이
            초기화되면 생기는 현상으로, JuriSupport 웹 → 프로필 → MCP 연결에서 토큰을 복사해 다시
            붙여넣으면 됩니다.
          </p>
        )}
        {jsTokenMsg && <p className="muted small">{jsTokenMsg}</p>}
      </section>

      <section className="setting-row">
        <div className="setting-label">
          서면 사무실 정보{' '}
          <span className="muted small">
            — HWPX 내보내기 하단(푸터)에 표시. 직접 입력한 값이 JuriSupport 계정 정보보다 우선
          </span>
        </div>
        <div className="setting-value setting-office">
          {officeField('officeName', '상호 (예: 법무법인 ○○)')}
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={office.hideOfficeName === true}
              onChange={(e) => {
                const next = { ...office, hideOfficeName: e.currentTarget.checked }
                setOffice(next)
                void commitOffice(next)
              }}
            />
            상호 표시 안 함 (로고만) — JuriSupport 상호도 무시
          </label>
          {officeField('phone', '전화 (예: 02-000-0000)')}
          {officeField('fax', '팩스')}
          {officeField('email', '이메일')}
          {officeField('address', '주소')}
          <textarea
            className="setting-input setting-office-footer"
            placeholder={'별도 푸터 텍스트 — 입력하면 사무실 정보 표 대신 이 내용이 들어갑니다 (줄바꿈 가능)'}
            rows={2}
            value={office.footerText ?? ''}
            onChange={(e) => setOffice({ ...office, footerText: e.target.value })}
            onBlur={() => {
              void commitOffice(office)
            }}
          />
          <div className="setting-office-logo">
            <code>{office.logoPath ? office.logoPath : '로고 미설정'}</code>
            <button className="empty-action" onClick={() => void pickOfficeLogo()}>
              로고 선택
            </button>
            {office.logoPath && (
              <button
                className="empty-action"
                onClick={() => {
                  const next = { ...office, logoPath: undefined }
                  setOffice(next)
                  void commitOffice(next)
                }}
              >
                제거
              </button>
            )}
          </div>
          {officeMsg && <p className="muted small">{officeMsg}</p>}
          <p className="muted small">
            로고 권장: 투명 배경 PNG, 3MB 이하, 가로:세로 2:1~4:1(4:1 최적), 세로 400px 이상,
            이미지 자체 여백 제거. 높이 약 1.7cm에 꽉 차게 들어갑니다.
          </p>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          원격 캐시 <span className="muted small">— 한 번 연 SSH 폴더·파일을 다음 실행에서도 재사용</span>
        </div>
        <div className="setting-value setting-cache-options">
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={s.remoteDirectoryCache === true}
              onChange={(e) => {
                void savePatch({ remoteDirectoryCache: e.currentTarget.checked })
              }}
            />
            <span>폴더 구조와 파일 목록을 이 Mac에 저장</span>
          </label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={s.remoteFileCache === true}
              onChange={(e) => {
                void savePatch({ remoteFileCache: e.currentTarget.checked })
              }}
            />
            <span>원격 파일 내용도 저장</span>
          </label>
          <button
            className="header-btn setting-reset-btn"
            type="button"
            onClick={() => {
              void window.lt.ssh.clearDirCache()
            }}
          >
            캐시 비우기
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          OneDrive 자동 올리기{' '}
          <span className="muted small">
            — 원격 OneDrive 경로에 파일을 저장하면 그 파일을 rclone으로 바로 클라우드에 올림
          </span>
        </div>
        <div className="setting-value">
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={s.syncAutoPushOnSave === true}
              onChange={(e) => {
                void savePatch({ syncAutoPushOnSave: e.currentTarget.checked })
              }}
            />
            <span>저장 후 자동 올리기 (맥미니에 rclone 필요)</span>
          </label>
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
          작업 완료 알림 <span className="muted small">— 질문 대기 알림은 항상 표시</span>
        </div>
        <div className="setting-value">
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={s.notifyDone !== false}
              onChange={(e) => {
                void savePatch({ notifyDone: e.currentTarget.checked })
              }}
            />
            <span>완료 시 알림음·토스트·OS 알림 표시 (끄면 탭 배지만)</span>
          </label>
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

      <section className="setting-row">
        <div className="setting-label">
          새 Agent 기본 AI <span className="muted small">— 새 Agent 탭부터 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={agentProviderValue}
            onChange={(e) => {
              void savePatch({ agentDefaultProvider: e.currentTarget.value as AgentProvider })
            }}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      </section>

      <section className="setting-row col">
        <div className="setting-label">
          SSH 접속 프로필{' '}
          <span className="muted small">— 원격 서버에서 사건·claude 실행 (사건 열기 → 접속 선택)</span>
        </div>
        <SshProfilesEditor onSync={onSync} />
      </section>

      <p className="muted small">
        {loaded ? '변경 즉시 저장됩니다 (터미널·마크다운 편집기는 새로 열 때 적용).' : '불러오는 중…'}
      </p>
    </div>
  )
}

// 설정 화면의 SSH 프로필 목록 편집기 (추가/수정/삭제 즉시 저장)
type SshTestResult = { busy?: boolean; ok?: boolean; message: string }

function SshProfilesEditor({ onSync }: { onSync: (init: SyncModalInit) => void }): JSX.Element {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [testResults, setTestResults] = useState<Record<string, SshTestResult>>({})
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
    save([...profiles, { id, label: '새 서버', host: '', user: '', remoteControl: true }])
  }
  const remove = (id: string): void => save(profiles.filter((p) => p.id !== id))
  const testConnection = async (profile: SshProfile): Promise<void> => {
    setTestResults((current) => ({
      ...current,
      [profile.id]: { busy: true, message: '접속 확인 중' }
    }))
    try {
      const result = await window.lt.ssh.test(profile)
      setTestResults((current) => ({
        ...current,
        [profile.id]: result.ok
          ? { ok: true, message: `연결됨: ${result.cwd}` }
          : { ok: false, message: result.error }
      }))
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [profile.id]: { ok: false, message: String(error) }
      }))
    }
  }

  return (
    <div className="ssh-editor">
      {profiles.length === 0 && (
        <p className="muted small">저장된 프로필이 없습니다. 아래에서 추가하세요.</p>
      )}
      {profiles.map((p) => {
        const testResult = testResults[p.id]
        return (
          <div key={p.id} className="ssh-card">
            <div className="ssh-card-head">
              <input
                className="setting-input"
                placeholder="이름 (예: 사무실 서버)"
                defaultValue={p.label}
                onBlur={(e) => update(p.id, { label: e.target.value.trim() || '서버' })}
              />
              <button
                className="header-btn"
                disabled={!p.host || !p.user || testResult?.busy}
                title={!p.host || !p.user ? '호스트·사용자를 먼저 입력하세요' : 'SSH 접속 확인'}
                onClick={() => void testConnection(p)}
              >
                {testResult?.busy ? '테스트 중' : '접속 테스트'}
              </button>
              <button className="header-btn danger" onClick={() => remove(p.id)} title="삭제">
                삭제
              </button>
            </div>
            {testResult && (
              <div className={`ssh-test-result ${testResult.ok ? 'ok' : testResult.busy ? '' : 'fail'}`}>
                {testResult.message}
              </div>
            )}
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
            <label className="wide setting-checkbox">
              <input
                type="checkbox"
                checked={p.remoteControl === true}
                onChange={(e) => update(p.id, { remoteControl: e.currentTarget.checked })}
              />
              <span>외부 원격 제어 사용 (Claude 터미널·Codex Agent)</span>
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
        )
      })}
      <button className="empty-action" onClick={add}>
        ＋ 프로필 추가
      </button>

      {picking && (
        <RemoteFolderPicker
          profile={picking.profile}
          onSync={onSync}
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

function UnsavedWindowCloseDialog({
  state,
  onSaveAndClose,
  onDiscardAndClose,
  onCancel
}: {
  state: CloseWindowPromptState
  onSaveAndClose: () => void
  onDiscardAndClose: () => void
  onCancel: () => void
}): JSX.Element {
  const shown = state.docs.slice(0, 6)
  const more = state.docs.length - shown.length
  return (
    <div className="modal-overlay" onMouseDown={state.saving ? undefined : onCancel}>
      <div
        className="modal unsaved-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-close-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title" id="unsaved-close-title">
          저장하지 않은 문서가 있습니다
        </div>
        <p className="unsaved-close-copy">
          창을 닫기 전에 변경사항을 파일에 저장할 수 있습니다.
        </p>
        <div className="unsaved-close-list">
          {shown.map((doc) => (
            <div className="unsaved-close-item" key={doc.id} title={doc.path ?? doc.title}>
              <span className="unsaved-close-name">{doc.title}</span>
              {doc.path && <span className="unsaved-close-path">{doc.path}</span>}
            </div>
          ))}
          {more > 0 && <div className="unsaved-close-more">외 {more}개 문서</div>}
        </div>
        {state.error && <div className="unsaved-close-error">{state.error}</div>}
        <div className="modal-actions unsaved-close-actions">
          <button className="header-btn primary" type="button" onClick={onSaveAndClose} disabled={state.saving}>
            {state.saving ? '저장 중...' : '저장하고 닫기'}
          </button>
          <button className="header-btn danger" type="button" onClick={onDiscardAndClose} disabled={state.saving}>
            저장하지 않고 닫기
          </button>
          <button className="header-btn" type="button" onClick={onCancel} disabled={state.saving}>
            취소
          </button>
        </div>
      </div>
    </div>
  )
}

function NewCaseLauncher({
  recent,
  onCases,
  onFolder,
  onSavedWorkspace,
  onRecent,
  onNewWindow,
  onClose
}: {
  recent: RecentCase[]
  onCases: () => void
  onFolder: () => void
  onSavedWorkspace: () => void
  onRecent: (entry: RecentCase) => void
  onNewWindow: () => void
  onClose: () => void
}): JSX.Element {
  const visibleRecent = recent.slice(0, 4)
  const recentSub = (entry: RecentCase): string =>
    [isRemotePath(entry.drafts) ? '원격' : '로컬', entry.records ? '기록 연결' : undefined, pathLeaf(entry.drafts)]
      .filter(Boolean)
      .join(' · ')

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal new-case-launcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">새 사건</div>
        <div className="new-case-options">
          <button className="new-case-row" type="button" onClick={onCases}>
            <span className="new-case-row-icon">
              <IconCases size={20} />
            </span>
            <span className="new-case-row-main">
              <span className="new-case-row-title">사건 목록</span>
              <span className="new-case-row-sub">JuriSupport 사건에서 선택</span>
            </span>
          </button>
          <button className="new-case-row" type="button" onClick={onFolder}>
            <span className="new-case-row-icon">
              <IconWorkspace size={20} />
            </span>
            <span className="new-case-row-main">
              <span className="new-case-row-title">작성서류 폴더</span>
              <span className="new-case-row-sub">로컬 또는 원격 폴더 선택</span>
            </span>
          </button>
          <button className="new-case-row" type="button" onClick={onSavedWorkspace}>
            <span className="new-case-row-icon">
              <IconSync size={20} />
            </span>
            <span className="new-case-row-main">
              <span className="new-case-row-title">저장된 작업환경</span>
              <span className="new-case-row-sub">스냅샷 복원</span>
            </span>
          </button>
        </div>
        {visibleRecent.length > 0 && (
          <div className="new-case-recent">
            <div className="new-case-section-title">최근 사건</div>
            {visibleRecent.map((entry) => (
              <button
                key={`${entry.drafts}:${entry.ts}`}
                className="new-case-recent-row"
                type="button"
                title={entry.drafts}
                onClick={() => onRecent(entry)}
              >
                <span className="new-case-row-title">{entry.name}</span>
                <span className="new-case-row-sub">{recentSub(entry)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="header-btn" type="button" onClick={onNewWindow}>
            빈 새 윈도우
          </button>
          <button className="header-btn" type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkspacePicker({
  loading,
  entries,
  error,
  onLoad,
  onImportFile,
  onRefresh,
  onClose
}: {
  loading: boolean
  entries: WorkspaceEntry[]
  error?: string
  onLoad: (entry: WorkspaceEntry) => void
  onImportFile: () => void
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
          autoFocus
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
          <button
            className="header-btn"
            type="button"
            title="다른 컴퓨터에서 내보낸 JSON 작업환경 파일 불러오기"
            onClick={onImportFile}
          >
            JSON 파일 선택…
          </button>
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
  title = '사건 열기 — 접속 선택',
  localDescription = '로컬 폴더에서 사건 선택',
  profiles,
  onLocal,
  onRemote,
  onManage,
  onClose
}: {
  title?: string
  localDescription?: string
  profiles: SshProfile[]
  onLocal: () => void
  onRemote: (p: SshProfile) => void
  onManage: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal conn-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <button className="conn-row" onClick={onLocal}>
          <span className="conn-ic">💻</span>
          <span className="conn-main">
            <b>이 컴퓨터 (로컬)</b>
            <span className="muted small">{localDescription}</span>
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
  onSync,
  onPick,
  onCancel
}: {
  profile: SshProfile
  title?: string
  startPath?: string
  confirmLabel?: string
  onSync: (init: SyncModalInit) => void
  onPick: (remotePath: string) => void
  onCancel: () => void
}): JSX.Element {
  const initial = (startPath ?? profile.draftsRoot)?.trim() || '~'
  const [cwd, setCwd] = useState<string>(initial)
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null)
  const [err, setErr] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [pathInput, setPathInput] = useState(initial)
  const [quickStartPaths, setQuickStartPaths] = useState<string[]>(() =>
    normalizeRemoteQuickStartPaths(profile.quickStartPaths)
  )
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

  const load = (path: string, opts?: { refresh?: boolean }): void => {
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
      .listDir(profile, nextPath, opts)
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
    setQuickStartPaths(normalizeRemoteQuickStartPaths(profile.quickStartPaths))
  }, [profile.id, profile.quickStartPaths])

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
  const quickStartPoints = profileRemoteStartPoints({ ...profile, quickStartPaths })
  const currentQuickStartSaved = quickStartPaths.some(
    (path) => remoteStartPointKey(path) === remoteStartPointKey(cwd)
  )
  const visibleDirs = folderSearchResults ? sortEntries(folderSearchResults, sortMode) : dirs
  const folderQueryText = folderQuery.trim()
  const canCreateFolder = !loading && !err && !!cwd.trim() && !!newFolderName.trim() && !creatingFolder
  const canPickCurrentFolder = !loading && !folderSearching && !err && !!cwd.trim()
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
        load(createdPath, { refresh: true })
      })
      .catch((e: unknown) => {
        setCreatingFolder(false)
        setCreateFolderErr(e instanceof Error ? e.message : String(e))
      })
  }
  const saveQuickStartPaths = (nextPaths: string[]): void => {
    const previousPaths = quickStartPaths
    setQuickStartPaths(nextPaths)
    void window.lt.settings
      .get()
      .then((settings) => {
        const profiles = settings.sshProfiles ?? []
        if (!profiles.some((p) => p.id === profile.id)) return settings
        return window.lt.settings.set({
          sshProfiles: profiles.map((p) =>
            p.id === profile.id
              ? { ...p, quickStartPaths: nextPaths.length > 0 ? nextPaths : undefined }
              : p
          )
        })
      })
      .then(emitSettingsUpdated)
      .catch(() => setQuickStartPaths(previousPaths))
  }

  const toggleCurrentQuickStart = (): void => {
    saveQuickStartPaths(toggleRemoteQuickStartPath(quickStartPaths, cwd))
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
            <button
              className="header-btn"
              onClick={() => load(cwd, { refresh: true })}
              title="현재 폴더 목록을 다시 읽기"
            >
              목록 새로고침
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
              onClick={() => {
                onSync({
                  profile,
                  macFolder: syncPath,
                  folderLabel: syncFolderLabel,
                  directions: 'pull-only',
                  initialMode: 'folders',
                  lockMode: true
                })
                onCancel()
              }}
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
            {!!cwd.trim() && (
              <button
                className="remote-chip"
                type="button"
                aria-pressed={currentQuickStartSaved}
                title={
                  currentQuickStartSaved
                    ? '현재 폴더를 이 SSH 프로필 빠른 시작에서 삭제'
                    : '현재 폴더를 이 SSH 프로필 빠른 시작에 저장'
                }
                onClick={toggleCurrentQuickStart}
              >
                {currentQuickStartSaved ? '− 현재 위치' : '+ 현재 위치'}
              </button>
            )}
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
    </>
  )
}

// rclone 동기화 모달 (클라우드 경유) — 맥에서 rclone 실행: 맥 사건폴더 ↔ OneDrive 클라우드.
// 올리기(맥→클라우드)/내리기(클라우드→맥) 두 버튼. Windows는 자신의 OneDrive 앱으로 받음.
function SyncModal({
  profiles,
  init,
  minimized,
  onMinimize,
  onRestore,
  onFinished,
  onClose
}: {
  profiles: SshProfile[]
  init: SyncModalInit
  minimized: boolean
  onMinimize: () => void
  onRestore: () => void
  onFinished: () => void
  onClose: () => void
}): JSX.Element {
  const [profileId, setProfileId] = useState(init.profile.id)
  const [macFolder, setMacFolder] = useState(init.macFolder)
  const [remoteName, setRemoteName] = useState('') // 예: "onedrive:"
  const [cloudPath, setCloudPath] = useState(cloudPathFromOneDrivePath(init.macFolder))
  // 사용자가 클라우드 경로를 직접 고치기 전까지는 맥 경로에서 자동 유도한다
  const [cloudPathEdited, setCloudPathEdited] = useState(false)
  const [syncMode, setSyncMode] = useState<SyncMode>(init.initialMode ?? 'full')
  const [info, setInfo] = useState<{ installed: boolean; remotes: string[]; error?: string } | null>(
    null
  )
  const [log, setLog] = useState<string[]>([])
  const [runningDirection, setRunningDirection] = useState<SyncDirection | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<{
    direction: 'pull' | 'push'
    items: { path: string; action: string }[]
  } | null>(null)
  const [needResync, setNeedResync] = useState(false)
  const [result, setResult] = useState('')
  const cancelRequested = useRef(false)
  const logRef = useRef<HTMLPreElement>(null)
  const profile = profiles.find((p) => p.id === profileId) ?? init.profile
  const running = runningDirection !== null
  const folderLabel = init.folderLabel ?? '사건폴더'
  const pullOnly = init.directions === 'pull-only'
  const modeLocked = !!init.lockMode
  const runningLabel =
    runningDirection === 'pull'
      ? '내리기'
      : runningDirection === 'push'
        ? '올리기'
        : runningDirection === 'bi'
          ? '양방향 동기화'
          : ''

  // 진행 로그 구독
  useEffect(() => window.lt.sync.onProgress((line) => setLog((l) => [...l, line])), [])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, minimized])

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
  const canRun = Boolean(
    !running &&
      info?.installed &&
      macFolder.trim() &&
      remoteName &&
      (syncMode !== 'file' || normalizedCloudPath)
  )
  const directionLabel = (direction: SyncDirection): string =>
    direction === 'pull' ? '내리기' : direction === 'push' ? '올리기' : '양방향 동기화'
  const run = (direction: SyncDirection, extra?: { resync?: boolean; confirmed?: boolean }): void => {
    if (!canRun) return
    const label = directionLabel(direction)
    const modeLabel = syncMode === 'folders' ? '폴더명만' : syncMode === 'file' ? '파일 1개' : '전체'
    setPreview(null)
    setNeedResync(false)
    setResult('')
    cancelRequested.current = false
    setRunningDirection(direction)
    // 전체/파일 복사는 dry-run으로 변경 목록을 먼저 보여주고 확인 후 실행한다.
    // 폴더명만 모드는 파일을 건드리지 않고, 양방향은 bisync 자체 안전장치(충돌 보존)에 맡긴다.
    if (direction !== 'bi' && syncMode !== 'folders' && !extra?.confirmed) {
      setPreviewing(true)
      setLog((l) => [...l, `${label} 미리보기 (${modeLabel}): ${dest}`])
      window.lt.sync
        .run({ profile, direction, mode: syncMode, macFolder, dest, dryRun: true })
        .then((r) => {
          if (!r.ok) {
            setResult(cancelRequested.current ? '동기화 중단됨' : '미리보기 실패 · 결과 확인')
            if (r.error) setLog((l) => [...l, '오류: ' + r.error])
            return
          }
          const items = r.changes ?? []
          if (items.length === 0) {
            setResult('이미 최신 상태입니다')
            setLog((l) => [...l, '이미 최신 상태입니다. 복사할 파일이 없습니다.'])
            return
          }
          setPreview({ direction, items })
        })
        .catch((e) => {
          setResult('미리보기 실패 · 결과 확인')
          setLog((l) => [...l, '오류: ' + String(e)])
        })
        .finally(() => {
          setPreviewing(false)
          setRunningDirection(null)
        })
      return
    }
    setLog((l) => [...l, `${label} 시작 (${modeLabel}): ${dest}`])
    window.lt.sync
      .run({ profile, direction, mode: syncMode, macFolder, dest, resync: extra?.resync })
      .then((r) => {
        setResult(
          r.ok ? '동기화 완료' : cancelRequested.current ? '동기화 중단됨' : '동기화 실패 · 결과 확인'
        )
        if (!r.ok && r.error) {
          setLog((l) => [...l, '오류: ' + r.error])
          // bisync 최초 실행은 기준 상태(--resync)가 없어 실패한다 → 안내 후 원클릭 재실행
          if (direction === 'bi' && /resync/i.test(r.error)) setNeedResync(true)
        }
      })
      .catch((e) => {
        setResult('동기화 실패 · 결과 확인')
        setLog((l) => [...l, '오류: ' + String(e)])
      })
      .finally(() => {
        setRunningDirection(null)
        onFinished()
      })
  }
  const cancelRun = (): void => {
    if (!running) return
    cancelRequested.current = true
    setLog((l) => [...l, `${runningLabel} 중단 요청...`])
    window.lt.sync.cancel()
  }

  if (minimized) {
    return (
      <div className="sync-status sync-background" aria-label="OneDrive 동기화">
        <div className="sync-status-main" role="status" aria-live="polite">
          {running && <span className="sync-spinner" aria-hidden="true" />}
          <div>
            <b>
              {running
                ? `${runningLabel} ${previewing ? '미리보기' : '진행'} 중…`
                : preview
                  ? '변경 목록 확인 필요'
                  : needResync
                    ? '첫 동기화 설정 필요'
                    : result || '동기화 대기'}
            </b>
            <span title={macFolder}>{folderLabel} · {macFolder}</span>
          </div>
        </div>
        <button className="header-btn" onClick={onRestore}>
          진행 상황 보기
        </button>
        {running ? (
          <button className="header-btn danger" onClick={cancelRun}>
            중단
          </button>
        ) : (
          <button className="header-btn" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="modal-overlay" onMouseDown={running ? onMinimize : onClose}>
      <div
        className="modal sync-modal"
        role="dialog"
        aria-modal="true"
        aria-label="OneDrive 동기화"
        aria-busy={running}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          ⇅ 동기화 (맥미니 rclone · {folderLabel}
          {pullOnly ? ' ← OneDrive 클라우드' : ' ↔ OneDrive 클라우드'})
        </div>

        <label className="sync-field">
          접속 프로필 (맥미니)
          <select
            className="setting-select"
            value={profileId}
            disabled={running}
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
                disabled={running}
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
              맥 {syncMode === 'file' ? '파일' : folderLabel}
              <input
                className="setting-input"
                value={macFolder}
                disabled={running}
                placeholder={
                  syncMode === 'file'
                    ? '/Users/me/Library/CloudStorage/OneDrive/진행중사건/사건폴더/서면.pdf'
                    : '/Users/me/Library/CloudStorage/OneDrive/진행중사건/사건폴더'
                }
                onChange={(e) => {
                  setMacFolder(e.target.value)
                  setPreview(null)
                  if (!cloudPathEdited) setCloudPath(cloudPathFromOneDrivePath(e.target.value))
                }}
              />
            </label>
            <label className="sync-field">
              클라우드 {syncMode === 'file' ? '파일 ' : ''}경로 (리모트 내부
              {cloudPathEdited ? '' : ' · 맥 경로에서 자동 계산'})
              <input
                className="setting-input"
                value={cloudPath}
                disabled={running}
                placeholder={
                  syncMode === 'file'
                    ? '진행중사건/사건폴더/서면.pdf'
                    : '진행중사건/사건폴더 (비우면 OneDrive 루트)'
                }
                onChange={(e) => {
                  setCloudPath(e.target.value)
                  setPreview(null)
                  // 직접 수정하면 자동 계산 중지. 전부 지우면(=OneDrive 루트) 이후 맥 경로
                  // 변경 시 자동 계산이 다시 켜진다.
                  setCloudPathEdited(e.target.value.trim() !== '')
                }}
              />
            </label>
            <div className="sync-field">
              동기화 범위
              <div className="sync-mode" role="group" aria-label="동기화 범위">
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'full' ? 'active' : ''}`}
                  disabled={running || modeLocked}
                  onClick={() => {
                    setSyncMode('full')
                    setPreview(null)
                  }}
                >
                  전체
                </button>
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'folders' ? 'active' : ''}`}
                  disabled={running || modeLocked}
                  onClick={() => {
                    setSyncMode('folders')
                    setPreview(null)
                  }}
                >
                  폴더명만
                </button>
                {syncMode === 'file' && (
                  <button
                    type="button"
                    className="sync-mode-btn active"
                    disabled
                  >
                    파일 1개
                  </button>
                )}
              </div>
            </div>
            <p className="muted small">
              대상: <code>{dest || '(리모트:경로 미정)'}</code> ·{' '}
              {syncMode === 'file' ? (
                <>
                  copyto --update(선택 파일 1개, <b>삭제 전파 안 함</b>)
                </>
              ) : syncMode === 'folders' ? (
                <>
                  파일 복사 없이 폴더 구조만 생성(<b>삭제 전파 안 함</b>)
                </>
              ) : (
                <>
                  양방향: bisync(<b>삭제 전파 포함</b>, 충돌 시 최신 파일 우선·진 쪽은 .conflict로
                  보존) / 올리기·내리기: copy --update(<b>삭제 전파 안 함</b>, 실행 전 미리보기)
                </>
              )}
            </p>
            <div className="sync-buttons">
              {!pullOnly && syncMode === 'full' && (
                <button className="empty-action" disabled={!canRun} onClick={() => run('bi')}>
                  {runningDirection === 'bi'
                    ? '양방향 동기화 진행 중...'
                    : '⇅ 양방향 동기화 (권장)'}
                </button>
              )}
              {!pullOnly && (
                <button className="empty-action" disabled={!canRun} onClick={() => run('push')}>
                  {runningDirection === 'push'
                    ? previewing
                      ? '올리기 미리보기 중...'
                      : '올리기 진행 중...'
                    : '⬆ 올리기 (맥 → 클라우드)'}
                </button>
              )}
              <button className="empty-action" disabled={!canRun} onClick={() => run('pull')}>
                {runningDirection === 'pull'
                  ? previewing
                    ? '내리기 미리보기 중...'
                    : '내리기 진행 중...'
                  : '⬇ 내리기 (클라우드 → 맥)'}
              </button>
            </div>
            {needResync && !running && (
              <div className="sync-status" role="status">
                <div className="sync-status-main">
                  <div>
                    <b>양방향 동기화 첫 실행</b>
                    <span>
                      이 폴더 쌍은 기준 상태가 아직 없습니다. 최초 1회 --resync로 양쪽 파일을
                      합쳐(같은 파일은 맥 쪽 우선) 기준을 만든 뒤부터 삭제·변경이 양방향으로
                      전파됩니다.
                    </span>
                  </div>
                </div>
                <button
                  className="empty-action"
                  disabled={!canRun}
                  onClick={() => run('bi', { resync: true, confirmed: true })}
                >
                  기준 상태 만들고 동기화
                </button>
              </div>
            )}
            {preview && !running && (
              <div className="sync-preview" role="status">
                <div className="sync-status-main">
                  <div>
                    <b>
                      {directionLabel(preview.direction)} 미리보기 — {preview.items.length}개
                      {preview.items.length >= 500 ? ' 이상' : ''} 변경 예정
                    </b>
                    <span>아래 목록을 확인한 뒤 진행하세요. 진행 전에는 아무것도 복사되지 않았습니다.</span>
                  </div>
                </div>
                <pre className="sync-log sync-preview-list">
                  {preview.items
                    .slice(0, 200)
                    .map((c) => `${c.action === 'copy' ? '복사' : c.action} · ${c.path}`)
                    .join('\n')}
                  {preview.items.length > 200 ? `\n... 외 ${preview.items.length - 200}개` : ''}
                </pre>
                <div className="sync-buttons">
                  <button
                    className="empty-action"
                    disabled={!canRun}
                    onClick={() => run(preview.direction, { confirmed: true })}
                  >
                    {directionLabel(preview.direction)} 진행
                  </button>
                  <button className="header-btn" onClick={() => setPreview(null)}>
                    취소
                  </button>
                </div>
              </div>
            )}
            {running && (
              <div className="sync-status" role="status" aria-live="polite">
                <div className="sync-status-main">
                  <span className="sync-spinner" aria-hidden="true" />
                  <div>
                    <b>{runningLabel} 진행 중...</b>
                    <span>백그라운드에서 계속하면 다른 탭에서 작업할 수 있습니다.</span>
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
          <button className="header-btn" onClick={onMinimize}>
            {running ? '백그라운드에서 계속' : '접어두기'}
          </button>
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
