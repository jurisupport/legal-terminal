import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type MouseEvent
} from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { LT_PATH, LT_PATHS, readLtPaths } from '../filetree/FileTree'
import {
  IconClaude,
  IconFork,
  IconMention,
  IconSend,
  IconStop,
  IconTerminal,
  IconWorktree
} from '../icons/Icons'
import {
  percentText,
  rateLimitLabel,
  rateLimitTone,
  showRateLimitInBar,
  type AgentRateLimitUsageView
} from './rateLimitDisplay'
import { asRecord, numberValue, recordArray, stringArray, stringValue } from './values'
import {
  appendDiffFallbackText,
  diffFallbackText,
  diffTitle,
  diffViewFromParts,
  diffViewFromRecord,
  mergeDiffViews,
  normalizeDiffEdits,
  type DiffEdit,
  type DiffView
} from './diff'
import { DiffPreview } from './DiffPreview'
import { MarkdownMessage } from './MarkdownMessage'
import { ToolRow, toolDisplayName, toolStepDisplay, type ProcessStep } from './ToolRow'
import { quoteAgentRequest } from './quote'
import { currentAgentModel } from './modelDisplay'
import {
  invalidateSessionTranscript,
  loadSessionTranscript,
  transcriptSourceKey
} from './transcriptCache'
import {
  copyAgentOutput,
  htmlToMarkdown,
  markdownPreviewText,
  selectedHtml,
  selectionIntersectsElement,
  writeHtmlPlainClipboard,
  writeSelectionToClipboard,
  type AgentCopyMode
} from './markdown'
import {
  buildMentionIndex,
  filterMentionEntries,
  mentionTokenAt,
  type MentionEntry
} from './mention'
import type {
  AgentAttachment,
  AgentEvent,
  AgentMessageQuote,
  AgentModelOption,
  AgentPermissionMode,
  AgentProvider,
  AppSettings,
  SessionTranscript,
  SshConn
} from '../env'

export { DiffPreview } from './DiffPreview'
export type { DiffView } from './diff'

type AgentRunStatus = 'working' | 'done' | 'question'
type AgentSendDelivery = 'normal' | 'queue' | 'steer'
type AgentAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable' | 'error'
type AgentPanelStatus = 'idle' | 'working' | 'waiting_permission' | 'waiting_user' | 'done' | 'error'

const SETTINGS_UPDATED_EVENT = 'lt:settings-updated'
const DEFAULT_AGENT_FONT_SIZE = 13
const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'ask'
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const PROMPT_HISTORY_LIMIT = 100
const CONTEXT_ATTACHMENT_TEXT_LIMIT = 160_000
const FOLDER_ATTACHMENT_ENTRY_LIMIT = 120
const TIMELINE_BOTTOM_THRESHOLD = 36
const TIMELINE_PREVIEW_LIMIT = 78
const QUOTE_PREVIEW_LIMIT = 180
const REMOTE_FILE_CHANGED_EVENT = 'lt:remote-file-changed'
const ESC_INTERRUPT_ARM_MS = 2000

const clampAgentFontSize = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AGENT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)))
}

const isTimelineNearBottom = (timeline: HTMLDivElement): boolean =>
  timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= TIMELINE_BOTTOM_THRESHOLD

// 프로바이더 전환 시 새 탭으로 넘길 대화 맥락 (패널 타임라인에서 직접 추출)
export interface AgentProviderHandoff {
  transcript: string
  count: number
}

interface AgentPanelProps {
  id: string
  cwd: string
  title: string
  provider: AgentProvider
  resumeSessionId?: string
  forkFromSessionId?: string
  initialHandoff?: AgentProviderHandoff
  ssh?: SshConn
  profileId?: string
  caseTabId?: string
  caseContext?: string
  visible: boolean
  focusNonce?: number
  initialDraft?: AgentDraftState
  clearDraftNonce?: number
  attachmentRequests?: AgentAttachmentRequest[]
  onAttachmentRequestsHandled?: (requestIds: string[]) => void
  onDraftChange?: (draft: AgentDraftState) => void
  onStatus?: (status: AgentRunStatus) => void
  onFork?: () => void
  onProviderChange?: (provider: AgentProvider, handoff?: AgentProviderHandoff) => void
  onHandoffConsumed?: () => void
  onWorktreeFork?: () => void
  onOpenTerminal?: () => void
  onOpenDiff?: (request: AgentDiffOpenRequest) => void
  onOpenFile?: (path: string, title?: string) => void
  onOpenAttachmentSource?: (attachment: AgentAttachment) => void
  // 전송 직전 첨부를 바꿔치기할 기회 (예: 미저장 md 문서 → 임시저장 작업본). null이면 원본 유지.
  onPrepareAttachment?: (attachment: AgentAttachment) => Promise<AgentAttachment | null>
}

export interface AgentAttachmentRequest {
  id: string
  attachment: AgentAttachment
  focusPrompt?: boolean
  inputText?: string
}

export interface AgentDraftState {
  input: string
  attachments: AgentAttachment[]
}

interface TimelineItem {
  id: string
  kind:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'permission'
    | 'diff'
    | 'error'
    | 'auth'
    | 'process'
    | 'queue'
    | 'dialog'
    | 'plan'
  title?: string
  text?: string
  diff?: DiffView
  attachments?: AgentAttachment[]
  status?: string
  filePath?: string
  requestId?: string
  toolName?: string
  planMarkdown?: string
  dialogId?: string
  questions?: AgentDialogQuestion[]
  answers?: Record<string, string>
  queueId?: string
  inputPreview?: string
  decision?: 'allow' | 'reject'
  urls?: string[]
  codes?: string[]
  processSteps?: ProcessStep[]
  quote?: AgentMessageQuote
}

interface PendingAgentQuote extends AgentMessageQuote {
  text: string
}

interface AgentDialogOption {
  id: string
  label: string
  description?: string
  preview?: string
}

interface AgentDialogQuestion {
  id: string
  question: string
  header?: string
  options: AgentDialogOption[]
  multiSelect?: boolean
}

export interface AgentDiffOpenRequest {
  id: string
  title: string
  diff: DiffView
}

interface AgentTokenUsageView {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
  totalCostUsd?: number
  lastTurnTokens?: number
  updatedAt: number
}

interface AgentContextUsageView {
  totalTokens: number
  maxTokens: number
  remainingTokens: number
  percentage: number
  model?: string
  updatedAt: number
}

interface AgentUsageView {
  tokens: AgentTokenUsageView
  context?: AgentContextUsageView
  rateLimit?: AgentRateLimitUsageView
  rateLimits?: AgentRateLimitUsageView[]
}

interface SlashCommand {
  name: string
  label: string
  description: string
  mode?: AgentPermissionMode
  providers?: AgentProvider[]
  argumentHint?: string
  aliases?: string[]
  source?: 'app' | 'claude' | 'codex'
  expand?: (rest: string) => string
}

const modeLabels: { value: AgentPermissionMode; label: string; title: string }[] = [
  { value: 'ask', label: '확인', title: '편집과 명령 실행을 확인합니다' },
  { value: 'plan', label: '계획', title: '실행 전 계획을 먼저 봅니다' },
  { value: 'acceptEdits', label: '편집 자동', title: '파일 편집은 자동 허용합니다' },
  { value: 'bypassPermissions', label: '자동 허용', title: '모든 권한 요청을 자동 허용합니다' },
  { value: 'dontAsk', label: '거절', title: '승인되지 않은 작업을 거절합니다' }
]

const agentProviderLabels: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

const emptyStateSuggestions: { label: string; prompt: string }[] = [
  {
    label: '사건 폴더 요약',
    prompt: '이 사건 폴더의 구조와 주요 문서를 훑어보고 사건 개요를 요약해줘.'
  },
  {
    label: '쟁점 정리',
    prompt: '기록을 검토해서 당사자별 주장과 다툼 있는 쟁점을 표로 정리해줘.'
  },
  {
    label: '반박 논점',
    prompt: '상대방의 최근 서면을 읽고 반박 가능한 논점과 뒷받침할 증거를 정리해줘.'
  },
  {
    label: '다음 할 일',
    prompt: '사건 진행 상황을 검토하고 다음 기일까지 준비할 일 목록을 만들어줘.'
  }
]

const isAgentPermissionMode = (value: unknown): value is AgentPermissionMode =>
  typeof value === 'string' && modeLabels.some((option) => option.value === value)

const resolveAgentPermissionMode = (value: unknown): AgentPermissionMode =>
  isAgentPermissionMode(value) ? value : DEFAULT_AGENT_PERMISSION_MODE

const withSlashRest = (base: string, rest: string): string => (rest ? `${base}\n\n요청: ${rest}` : base)

const slashCommands: SlashCommand[] = [
  {
    name: '/plan',
    label: '계획',
    description: '실행 전 계획과 위험 요소를 먼저 봅니다',
    mode: 'plan',
    expand: (rest) =>
      withSlashRest(
        '먼저 실행 계획을 작성하고 필요한 확인 질문, 위험 요소, 검증 방법을 정리하세요. 사용자가 승인하기 전에는 파일을 변경하지 마세요.',
        rest
      )
  },
  {
    name: '/compact',
    label: '요약',
    description: '현재 맥락을 이어받기 좋게 압축합니다',
    expand: (rest) =>
      withSlashRest('현재 사건 폴더와 대화 맥락을 다음 작업자가 이어받을 수 있게 간결하게 요약하세요.', rest)
  },
  {
    name: '/resume',
    label: '이어하기',
    description: '기존 세션 맥락을 확인합니다',
    expand: (rest) =>
      withSlashRest('이 사건 폴더의 기존 작업 맥락을 확인하고 이어서 진행할 수 있는 상태를 요약하세요.', rest)
  },
  {
    name: '/mcp',
    label: 'MCP',
    description: 'MCP 상태를 봅니다. 서버 설정/OAuth 조작은 터미널 모드에서 실행합니다',
    providers: ['claude'],
    expand: (rest) =>
      withSlashRest('현재 사용 가능한 MCP, 도구, 연결 상태를 확인하고 작업에 쓸 수 있는 항목을 정리하세요.', rest)
  },
  {
    name: '/plugins',
    label: '플러그인',
    description: 'Claude Code 플러그인 상태를 확인합니다',
    providers: ['claude'],
    expand: (rest) =>
      withSlashRest('현재 Claude Code 플러그인과 스킬 상태를 확인하고 필요한 활성화 또는 설치 후보를 정리하세요.', rest)
  },
  {
    name: '/model',
    label: '모델',
    description: '모델과 추론 정도를 선택합니다'
  },
  {
    name: '/brief-protocol',
    label: '브리핑',
    description: '사건 브리핑 초안을 만듭니다',
    expand: (rest) =>
      withSlashRest('사건 폴더를 검토해 의뢰인 브리핑 초안을 작성하세요. 사실관계, 쟁점, 증거, 다음 행동을 나누어 정리하세요.', rest)
  },
  {
    name: '/cold-start-interview',
    label: '질문 시작',
    description: '작업 전 필요한 사실관계를 묻습니다',
    expand: (rest) =>
      withSlashRest('작업을 시작하기 전에 목표, 제약, 사실관계, 필요한 자료를 짧은 질문으로 먼저 확인하세요.', rest)
  }
]

const codexSlashCommands: SlashCommand[] = [
  { name: '/permissions', label: '권한', description: 'Codex 권한 모드를 확인하거나 변경합니다', source: 'codex', argumentHint: '[ask|auto|read-only]' },
  { name: '/ide', label: 'IDE', description: 'IDE 컨텍스트를 포함합니다', source: 'codex' },
  { name: '/keymap', label: '키맵', description: 'TUI 단축키 설정을 엽니다', source: 'codex' },
  { name: '/vim', label: 'Vim', description: 'TUI Vim 모드를 전환합니다', source: 'codex' },
  { name: '/sandbox-add-read-dir', label: 'Sandbox', description: '추가 읽기 디렉터리를 허용합니다', source: 'codex' },
  { name: '/agent', label: 'Agent', description: '에이전트 thread를 전환합니다', source: 'codex' },
  { name: '/apps', label: '앱', description: '사용 가능한 앱/커넥터를 봅니다', source: 'codex' },
  { name: '/plugins', label: '플러그인', description: 'Codex 플러그인 목록을 봅니다', source: 'codex' },
  { name: '/hooks', label: '훅', description: 'Codex lifecycle hook 목록을 봅니다', source: 'codex' },
  { name: '/clear', label: '초기화', description: '현재 패널 출력을 지우고 새 Codex thread로 전환합니다', source: 'codex' },
  { name: '/archive', label: '보관', description: '현재 Codex thread를 보관합니다', source: 'codex' },
  { name: '/delete', label: '삭제', description: '현재 세션 삭제는 TUI에서 실행합니다', source: 'codex' },
  { name: '/compact', label: '요약', description: 'Codex 컨텍스트 압축을 시작합니다', source: 'codex' },
  { name: '/copy', label: '복사', description: '최신 응답 복사는 TUI 전용입니다', source: 'codex' },
  { name: '/diff', label: 'Diff', description: '현재 Git diff를 봅니다', source: 'codex' },
  { name: '/exit', label: '나가기', description: 'Codex TUI를 종료합니다', source: 'codex' },
  { name: '/experimental', label: '실험 기능', description: 'Codex 실험 기능을 설정합니다', source: 'codex' },
  { name: '/approve', label: '승인', description: '자동 리뷰 거절을 한 번 승인합니다', source: 'codex' },
  { name: '/memories', label: '메모리', description: 'Codex memory 설정을 엽니다', source: 'codex' },
  { name: '/skills', label: '스킬', description: '사용 가능한 Codex skill을 봅니다', source: 'codex' },
  { name: '/import', label: 'Import', description: '외부 에이전트 설정 가져오기는 TUI에서 실행합니다', source: 'codex' },
  { name: '/feedback', label: '피드백', description: '피드백 전송은 TUI에서 실행합니다', source: 'codex' },
  { name: '/init', label: 'AGENTS.md', description: 'AGENTS.md 초기화는 TUI에서 실행합니다', source: 'codex' },
  { name: '/logout', label: '로그아웃', description: 'Codex 로그아웃은 TUI에서 실행합니다', source: 'codex' },
  { name: '/mcp', label: 'MCP', description: 'Codex MCP 서버 상태를 봅니다. 서버 설정/OAuth 조작은 터미널 모드에서 실행합니다', source: 'codex', argumentHint: '[verbose]' },
  { name: '/mention', label: 'Mention', description: '파일 mention 삽입은 TUI 전용입니다', source: 'codex' },
  { name: '/model', label: '모델', description: 'Codex 모델과 reasoning effort를 선택합니다', source: 'codex' },
  { name: '/fast', label: 'Fast', description: 'Fast service tier 전환은 TUI에서 실행합니다', source: 'codex' },
  { name: '/goal', label: '목표', description: 'Codex goal을 보거나 설정합니다', source: 'codex', argumentHint: '[objective|clear]' },
  { name: '/personality', label: '성격', description: '응답 성격 설정은 TUI에서 실행합니다', source: 'codex' },
  { name: '/ps', label: '프로세스', description: '백그라운드 터미널 확인은 TUI에서 실행합니다', source: 'codex' },
  { name: '/stop', label: '중지', description: '백그라운드 터미널 중지는 TUI에서 실행합니다', source: 'codex' },
  { name: '/fork', label: 'Fork', description: '현재 대화 fork는 TUI에서 실행합니다', source: 'codex' },
  { name: '/side', label: 'Side', description: 'Side conversation은 TUI에서 실행합니다', source: 'codex' },
  { name: '/btw', label: 'BTW', description: 'Side conversation alias입니다', source: 'codex' },
  { name: '/raw', label: 'Raw', description: 'Raw scrollback 전환은 TUI 전용입니다', source: 'codex' },
  { name: '/resume', label: '이어하기', description: '저장된 Codex 대화 재개는 TUI에서 실행합니다', source: 'codex' },
  { name: '/new', label: '새 대화', description: '새 Codex thread로 전환합니다', source: 'codex' },
  { name: '/quit', label: '종료', description: 'Codex TUI를 종료합니다', source: 'codex' },
  { name: '/review', label: '리뷰', description: '작업 트리 리뷰를 시작합니다', source: 'codex' },
  { name: '/status', label: '상태', description: '현재 Codex 세션 설정을 봅니다', source: 'codex' },
  { name: '/usage', label: '사용량', description: '계정 사용량을 봅니다', source: 'codex' },
  { name: '/debug-config', label: 'Config', description: 'Config 진단은 TUI에서 실행합니다', source: 'codex' },
  { name: '/statusline', label: '상태줄', description: 'TUI 상태줄 설정을 엽니다', source: 'codex' },
  { name: '/title', label: '제목', description: '터미널 제목 설정을 엽니다', source: 'codex' },
  { name: '/theme', label: '테마', description: 'TUI syntax theme를 고릅니다', source: 'codex' }
]

const codexPanelSlashCommandNames = new Set(codexSlashCommands.map((command) => command.name))
const codexTerminalOnlySlashCommandNames = new Set([
  '/agent',
  '/approve',
  '/btw',
  '/copy',
  '/debug-config',
  '/delete',
  '/exit',
  '/experimental',
  '/fast',
  '/feedback',
  '/fork',
  '/ide',
  '/import',
  '/init',
  '/keymap',
  '/logout',
  '/memories',
  '/mention',
  '/personality',
  '/ps',
  '/quit',
  '/raw',
  '/resume',
  '/sandbox-add-read-dir',
  '/side',
  '/statusline',
  '/stop',
  '/theme',
  '/title',
  '/vim'
])
const claudeTerminalOnlySlashCommandNames = new Set([
  '/exit',
  '/ide',
  '/keymap',
  '/logout',
  '/permissions',
  '/quit',
  '/status',
  '/statusline',
  '/theme',
  '/title',
  '/vim'
])

function isTerminalOnlySlashCommand(command: SlashCommand, provider: AgentProvider): boolean {
  const name = command.name.toLowerCase()
  return provider === 'codex'
    ? codexTerminalOnlySlashCommandNames.has(name)
    : claudeTerminalOnlySlashCommandNames.has(name)
}

function slashCommandSurfaceLabel(command: SlashCommand, provider: AgentProvider): string {
  if (command.name.toLowerCase() === '/mcp') return '상태 보기'
  return isTerminalOnlySlashCommand(command, provider) ? '터미널 전용' : '패널 실행'
}

function isInteractiveMcpArgument(argument: string): boolean {
  if (!argument.trim()) return false
  return /\b(add|auth|authorize|connect|config|configure|delete|disable|disconnect|enable|install|login|logout|oauth|remove|settings|setup|toggle|trust)\b/i.test(
    argument
  )
}

const agentStatusLabels: Record<AgentPanelStatus, string> = {
  idle: '대기',
  working: '작업 중',
  waiting_permission: '권한 확인 대기',
  waiting_user: '응답 대기',
  done: '완료',
  error: '오류'
}

const isActiveAgentStatus = (status: AgentPanelStatus): boolean =>
  status === 'working' || status === 'waiting_permission' || status === 'waiting_user'

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}초`
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
}

function timelineStatusLabel(item: TimelineItem): string | undefined {
  if (item.kind === 'diff' && item.status === 'applied') return '적용됨'
  if (item.kind === 'diff' && item.status === 'reverted') return '되돌림'
  if (item.kind !== 'queue' && (item.status === 'cancelled' || item.status === 'canceled')) return '중지됨'
  if (item.kind !== 'queue') return item.status
  if (item.status === 'queued') return '대기'
  if (item.status === 'priority') return '바로 지시 대기'
  if (item.status === 'started') return '실행 중'
  if (item.status === 'canceled') return '취소됨'
  return item.status
}

const INPUT_PREVIEW_LINE_LIMIT = 96

// 권한 요청 등의 입력 미리보기를 기본 한 줄로 접고, '자세히'로 원문을 펼친다.
function inputPreviewSummary(preview: string): string {
  try {
    const parsed = asRecord(JSON.parse(preview))
    const command = parsed ? stringValue(parsed.command) : undefined
    if (command) return command
  } catch {
    // JSON이 아니면 평문 전체를 한 줄로 접는다
  }
  return preview
}

function InputPreview({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const flat = inputPreviewSummary(text).replace(/\s+/g, ' ').trim()
  const summary =
    flat.length > INPUT_PREVIEW_LINE_LIMIT ? `${flat.slice(0, INPUT_PREVIEW_LINE_LIMIT)}…` : flat
  if (summary === text) return <pre className="agent-card-input">{text}</pre>
  return (
    <div className="agent-card-input-wrap">
      <pre className={`agent-card-input${expanded ? '' : ' single-line'}`}>
        {expanded ? text : summary}
      </pre>
      <button
        type="button"
        className="agent-diff-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '접기' : '자세히'}
      </button>
    </div>
  )
}

function isWaitingQueueItem(item: TimelineItem): boolean {
  return (
    item.kind === 'queue' &&
    Boolean(item.queueId) &&
    (item.status === 'queued' || item.status === 'priority')
  )
}

function interruptedTimelineItems(
  items: TimelineItem[],
  message = '사용자가 작업을 중지했습니다.'
): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === 'process') {
      const previousSteps = item.processSteps ?? []
      const processSteps = previousSteps.map((step) =>
        step.status === 'running' ? { ...step, status: 'cancelled' } : step
      )
      const hadRunningStep = previousSteps.some((step) => step.status === 'running')
      if (!hadRunningStep && item.status !== 'running') return item
      return { ...item, text: message, status: 'cancelled', processSteps }
    }
    if (item.kind === 'assistant' && item.status === 'streaming') return { ...item, status: 'cancelled' }
    if (
      (item.kind === 'permission' || item.kind === 'dialog') &&
      (item.status === 'waiting' || item.status === 'running')
    ) {
      return { ...item, status: 'cancelled' }
    }
    if (item.kind === 'auth' && item.status === 'running') return { ...item, status: 'cancelled' }
    return item
  })
}

function expandSlashInput(text: string, commands: SlashCommand[]): { text: string; mode?: AgentPermissionMode } {
  const match = text.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return { text }
  const command = commands.find((item) => item.name === match[1].toLowerCase())
  if (!command?.expand) return { text }
  return { text: command.expand((match[2] ?? '').trim()), mode: command.mode }
}

function slashCommandName(text: string): string | undefined {
  return text.match(/^(\/[^\s]+)/)?.[1].toLowerCase()
}

function normalizeSlashCommandName(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const name = trimmed.split(/\s+/, 1)[0]
  return name.startsWith('/') ? name : `/${name}`
}

function runtimeSlashCommandLabel(name: string): string {
  return name.replace(/^\//, '')
}

function runtimeSlashCommandDescription(command: SlashCommand): string {
  const description = command.description.trim()
  if (command.argumentHint) return `${description} ${command.argumentHint}`.trim()
  return description || (command.source === 'codex' ? 'Codex 명령' : 'Claude Code 명령')
}

function runtimeSlashCommandsFromEvent(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  return value
    .map((item): SlashCommand | undefined => {
      if (typeof item === 'string') {
        const name = normalizeSlashCommandName(item)
        return name ? { name, label: runtimeSlashCommandLabel(name), description: 'Claude Code 명령', source: 'claude' } : undefined
      }

      const record = asRecord(item)
      const name = normalizeSlashCommandName(stringValue(record?.name) ?? '')
      if (!record || !name) return undefined
      const description = stringValue(record.description) ?? ''
      const argumentHint = stringValue(record.argumentHint)
      const aliases = stringArray(record.aliases)
        .map((alias) => normalizeSlashCommandName(alias))
        .filter((alias): alias is string => Boolean(alias))
      return {
        name,
        label: runtimeSlashCommandLabel(name),
        description: description || 'Claude Code 명령',
        ...(argumentHint ? { argumentHint } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        source: 'claude'
      }
    })
    .filter((command): command is SlashCommand => {
      if (!command) return false
      const key = command.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function mergeSlashCommands(appCommands: SlashCommand[], runtimeCommands: SlashCommand[]): SlashCommand[] {
  const merged = new Map<string, SlashCommand>()
  for (const command of appCommands) merged.set(command.name.toLowerCase(), { ...command, source: 'app' })
  for (const command of runtimeCommands) {
    const key = command.name.toLowerCase()
    merged.set(key, command)
  }
  return [...merged.values()]
}

const compactNumberFormatter = new Intl.NumberFormat('ko-KR', {
  notation: 'compact',
  maximumFractionDigits: 1
})

const exactNumberFormatter = new Intl.NumberFormat('ko-KR')

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
})

function emptyAgentUsageView(): AgentUsageView {
  return {
    tokens: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      updatedAt: 0
    }
  }
}

function tokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  const rounded = Math.max(0, Math.round(value))
  return rounded >= 10_000 ? compactNumberFormatter.format(rounded) : exactNumberFormatter.format(rounded)
}

function exactTokenCount(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '-' : exactNumberFormatter.format(Math.max(0, Math.round(value)))
}

function cacheTokenTotal(tokens: AgentTokenUsageView): number {
  return tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens
}

function tokenUsageFromEvent(value: unknown): AgentTokenUsageView | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  return {
    turns: numberValue(record.turns) ?? 0,
    inputTokens: numberValue(record.inputTokens) ?? 0,
    outputTokens: numberValue(record.outputTokens) ?? 0,
    cacheCreationInputTokens: numberValue(record.cacheCreationInputTokens) ?? 0,
    cacheReadInputTokens: numberValue(record.cacheReadInputTokens) ?? 0,
    totalTokens: numberValue(record.totalTokens) ?? 0,
    totalCostUsd: numberValue(record.totalCostUsd),
    lastTurnTokens: numberValue(record.lastTurnTokens),
    updatedAt: numberValue(record.updatedAt) ?? Date.now()
  }
}

function contextUsageFromEvent(value: unknown): AgentContextUsageView | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const totalTokens = numberValue(record.totalTokens)
  const maxTokens = numberValue(record.maxTokens)
  const remainingTokens = numberValue(record.remainingTokens)
  const percentage = numberValue(record.percentage)
  if (
    totalTokens === undefined ||
    maxTokens === undefined ||
    remainingTokens === undefined ||
    percentage === undefined
  ) {
    return undefined
  }
  return {
    totalTokens,
    maxTokens,
    remainingTokens,
    percentage,
    model: stringValue(record.model),
    updatedAt: numberValue(record.updatedAt) ?? Date.now()
  }
}

function rateLimitUsageFromEvent(value: unknown): AgentRateLimitUsageView | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const status = stringValue(record.status)
  return {
    status: status === 'allowed' || status === 'allowed_warning' || status === 'rejected' ? status : undefined,
    rateLimitType: stringValue(record.rateLimitType),
    utilization: numberValue(record.utilization),
    remainingPercent: numberValue(record.remainingPercent),
    resetsAt: numberValue(record.resetsAt),
    isUsingOverage: typeof record.isUsingOverage === 'boolean' ? record.isUsingOverage : undefined,
    updatedAt: numberValue(record.updatedAt) ?? Date.now()
  }
}

function rateLimitUsagesFromEvent(value: unknown): AgentRateLimitUsageView[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((item) => rateLimitUsageFromEvent(item))
    .filter((item): item is AgentRateLimitUsageView => Boolean(item))
}

function usageTitle(usage: AgentUsageView, provider: AgentProvider): string {
  const tokens = usage.tokens
  const known = tokens.updatedAt > 0
  const lines = [
    `세션 토큰: ${exactTokenCount(known ? tokens.totalTokens : undefined)} ${known ? `(${tokens.turns}턴)` : '(집계 대기)'}`,
    `입력: ${exactTokenCount(known ? tokens.inputTokens : undefined)}, 출력: ${exactTokenCount(known ? tokens.outputTokens : undefined)}`,
    `캐시 생성: ${exactTokenCount(known ? tokens.cacheCreationInputTokens : undefined)}, 캐시 읽기: ${exactTokenCount(known ? tokens.cacheReadInputTokens : undefined)}`
  ]
  if (known && tokens.lastTurnTokens !== undefined) lines.push(`마지막 턴: ${exactTokenCount(tokens.lastTurnTokens)}`)
  if (provider === 'codex' && tokens.totalCostUsd !== undefined) lines.push(`비용: ${costFormatter.format(tokens.totalCostUsd)}`)
  if (usage.context) {
    lines.push(
      `컨텍스트: ${percentText(usage.context.percentage)} 사용, 잔여 ${exactTokenCount(usage.context.remainingTokens)} / ${exactTokenCount(usage.context.maxTokens)}`
    )
  }
  const limits = usage.rateLimits?.length ? usage.rateLimits : usage.rateLimit ? [usage.rateLimit] : []
  if (limits.length > 0) {
    lines.push(...limits.map((limit) => rateLimitLabel(limit)))
  }
  return lines.join('\n')
}

const dialogQuestions = (value: unknown): AgentDialogQuestion[] =>
  recordArray(value).map((question, questionIndex) => ({
    id: stringValue(question.id) ?? `q-${questionIndex}`,
    question: stringValue(question.question) ?? '',
    header: stringValue(question.header),
    multiSelect: question.multiSelect === true,
    options: recordArray(question.options).map((option, optionIndex) => ({
      id: stringValue(option.id) ?? `${questionIndex}-${optionIndex}`,
      label: stringValue(option.label) ?? '',
      description: stringValue(option.description),
      preview: stringValue(option.preview)
    })).filter((option) => option.label)
  })).filter((question) => question.question)

const isAuthFailureText = (text: string | undefined): boolean =>
  /failed to authenticate|invalid authentication credentials|api error:\s*401|401 unauthorized|refresh[_\s-]*token|sign in again|log out and sign in again/i.test(text ?? '')

const attachmentOrigin = (value: unknown): AgentAttachment['origin'] | undefined =>
  value === 'local' || value === 'remote' ? value : undefined

const attachmentAccess = (value: unknown): AgentAttachment['access'] | undefined =>
  value === 'workspace-path' || value === 'context-only' ? value : undefined

function attachmentSource(value: unknown): AgentAttachment['source'] | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const range = asRecord(source.range)
  const normalizedRange = range
    ? {
        startLine: numberValue(range.startLine),
        startColumn: numberValue(range.startColumn),
        endLine: numberValue(range.endLine),
        endColumn: numberValue(range.endColumn),
        startPage: numberValue(range.startPage),
        endPage: numberValue(range.endPage)
      }
    : undefined
  const normalized = {
    docId: stringValue(source.docId),
    path: stringValue(source.path),
    title: stringValue(source.title),
    text: stringValue(source.text),
    range: normalizedRange
  }
  if (
    !normalized.docId &&
    !normalized.path &&
    !normalized.title &&
    !normalized.text &&
    !Object.values(normalizedRange ?? {}).some((item) => item !== undefined)
  )
    return undefined
  return normalized
}

function fileNameFromPath(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean
}

function parseRemoteUri(uri: string): { profileId: string; path: string } | null {
  if (!uri.startsWith('ssh://')) return null
  const rest = uri.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { profileId: rest, path: '/' }
  return { profileId: rest.slice(0, slash), path: rest.slice(slash) }
}

function remoteUri(profileId: string, path: string): string {
  return 'ssh://' + profileId + (path.startsWith('/') ? path : '/' + path)
}

function normalizeRemotePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

function agentFilePathForApp(path: string | undefined, cwd: string, profileId?: string, ssh?: SshConn): string | undefined {
  if (!path) return undefined
  if (path.startsWith('ssh://')) return path
  if (!ssh || !profileId) return path
  const remotePath = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  return remoteUri(profileId, normalizeRemotePath(remotePath))
}

function createAgentPdfWorker(): pdfjs.PDFWorker {
  const port = new PdfJsWorker({ name: 'pdfjs-agent-attachment-worker' })
  return new pdfjs.PDFWorker({
    port
  } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0])
}

function pathExtension(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot).toLowerCase() : ''
}

function clipAttachmentContent(text: string): { content: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (normalized.length <= CONTEXT_ATTACHMENT_TEXT_LIMIT) {
    return { content: normalized, truncated: false }
  }
  return {
    content: normalized.slice(0, CONTEXT_ATTACHMENT_TEXT_LIMIT),
    truncated: true
  }
}

interface ExtractedAttachmentContent {
  content?: string
  truncated?: boolean
  note?: string
}

async function extractFolderAttachmentContent(path: string): Promise<ExtractedAttachmentContent> {
  try {
    const entries = await window.lt.fs.list(path)
    const visible = entries.slice(0, FOLDER_ATTACHMENT_ENTRY_LIMIT)
    const lines = visible.map((entry) => `${entry.isDir ? 'dir ' : 'file'}\t${entry.name}`)
    const omitted = entries.length - visible.length
    const summary = [
      `Folder listing for ${path}`,
      `Total entries: ${entries.length}`,
      omitted > 0 ? `Showing first ${visible.length}; ${omitted} omitted.` : undefined,
      '',
      ...lines
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n')
    return {
      content: summary,
      truncated: omitted > 0,
      note: omitted > 0 ? `폴더 항목이 많아 상위 ${visible.length}개만 첨부했습니다.` : undefined
    }
  } catch (e) {
    return { note: `폴더 목록 자동 첨부 실패: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function extractPdfAttachmentText(path: string): Promise<ExtractedAttachmentContent> {
  const ab = await window.lt.fs.readBytes(path)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(ab),
    worker: createAgentPdfWorker()
  })
  let doc: PDFDocumentProxy | null = null
  try {
    doc = await loadingTask.promise
    const pages: string[] = []
    let collected = ''
    let truncated = false
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo)
      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map((item) => {
          const value = (item as { str?: unknown }).str
          return typeof value === 'string' ? value : ''
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!pageText) continue
      pages.push(`[page ${pageNo}]\n${pageText}`)
      collected = pages.join('\n\n')
      if (collected.length > CONTEXT_ATTACHMENT_TEXT_LIMIT) {
        truncated = true
        break
      }
    }
    const clipped = clipAttachmentContent(collected)
    return {
      content: clipped.content,
      truncated: truncated || clipped.truncated,
      note: clipped.content ? undefined : 'PDF에서 추출 가능한 텍스트를 찾지 못했습니다.'
    }
  } finally {
    await loadingTask.destroy().catch(() => {})
    doc?.destroy()
  }
}

async function extractContextAttachmentContent(path: string): Promise<ExtractedAttachmentContent> {
  const ext = pathExtension(path)
  try {
    if (ext === '.pdf') return await extractPdfAttachmentText(path)
    if (ext === '.hwp' || ext === '.hwpx') {
      const hwp = await window.lt.fs.readHwpText(path)
      if (!hwp.ok) return { note: hwp.error || 'HWP/HWPX 본문을 추출하지 못했습니다.' }
      const clipped = clipAttachmentContent(hwp.text)
      return {
        content: clipped.content,
        truncated: clipped.truncated,
        note: clipped.content ? undefined : 'HWP/HWPX에서 추출 가능한 텍스트를 찾지 못했습니다.'
      }
    }
    const read = await window.lt.fs.readText(path)
    if (read.kind !== 'text') {
      return { note: '지원하지 않는 바이너리 파일이라 본문을 자동 첨부하지 못했습니다.' }
    }
    const clipped = clipAttachmentContent(read.text)
    return {
      content: clipped.content,
      truncated: read.truncated || clipped.truncated,
      note: clipped.content ? undefined : '텍스트 파일이 비어 있습니다.'
    }
  } catch (e) {
    return { note: `본문 자동 추출 실패: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function fileLikeClipboardType(type: string): boolean {
  return /^(Files|text\/uri-list|public\.file-url|NSFilenamesPboardType|x-special\/gnome-copied-files)$/i.test(type)
}

function pathLikeText(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (
    lines.length > 0 &&
    lines.length <= 20 &&
    lines.every((line) =>
      /^file:\/\/|^ssh:\/\/|^\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library)\/|^[A-Za-z]:[\\/]|^\\\\/.test(
        line
      )
    )
  )
}

function pathsFromPathLikeText(text: string): string[] {
  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        if (!line.startsWith('file://')) return line
        try {
          return decodeURIComponent(new URL(line).pathname)
        } catch {
          return decodeURIComponent(line.slice('file://'.length))
        }
      })
  )
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function mergePromptHistory(current: string[], entries: string[]): string[] {
  const merged = [...current]
  for (const entry of entries) {
    const prompt = entry.trim()
    if (!prompt) continue
    const existing = merged.indexOf(prompt)
    if (existing >= 0) merged.splice(existing, 1)
    merged.push(prompt)
  }
  return merged.slice(-PROMPT_HISTORY_LIMIT)
}

function textareaLineHeight(textarea: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(textarea)
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(lineHeight)) return lineHeight
  const fontSize = Number.parseFloat(style.fontSize)
  return Number.isFinite(fontSize) ? fontSize * 1.45 : 18
}

function textareaCaretTop(textarea: HTMLTextAreaElement, position: number): number {
  if (textarea.clientWidth <= 0) return 0

  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  mirror.textContent = textarea.value.slice(0, position)
  marker.textContent = '\u200b'
  mirror.appendChild(marker)

  const mirrorStyle = mirror.style
  mirrorStyle.position = 'absolute'
  mirrorStyle.visibility = 'hidden'
  mirrorStyle.left = '-10000px'
  mirrorStyle.top = '0'
  mirrorStyle.width = `${textarea.clientWidth}px`
  mirrorStyle.boxSizing = 'border-box'
  mirrorStyle.whiteSpace = 'pre-wrap'
  mirrorStyle.overflowWrap = 'anywhere'
  mirrorStyle.font = style.font
  mirrorStyle.lineHeight = style.lineHeight
  mirrorStyle.letterSpacing = style.letterSpacing
  mirrorStyle.textTransform = style.textTransform
  mirrorStyle.textAlign = style.textAlign
  mirrorStyle.textIndent = style.textIndent
  mirrorStyle.padding = style.padding
  mirrorStyle.border = '0'
  mirrorStyle.setProperty('tab-size', style.getPropertyValue('tab-size'))

  document.body.appendChild(mirror)
  const top = marker.offsetTop
  mirror.remove()
  return top
}

function caretOnLastVisualLine(textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  const lineHeight = textareaLineHeight(textarea)
  return (
    textareaCaretTop(textarea, textarea.selectionStart) >=
    textareaCaretTop(textarea, textarea.value.length) - lineHeight / 2
  )
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  )
}

function isAgentPromptKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.agent-prompt'))
}

function dataTransferPaths(dataTransfer: DataTransfer): string[] {
  const internal = readLtPaths(dataTransfer)
  if (internal.length) return internal
  return uniqueStrings(
    Array.from(dataTransfer.files)
      .map((file) => window.lt.fs.pathForFile(file))
      .filter(Boolean)
  )
}

function attachmentKindLabel(kind: AgentAttachment['kind']): string {
  if (kind === 'folder') return '폴더'
  if (kind === 'selection') return '선택'
  if (kind === 'pdf-page-range') return 'PDF'
  if (kind === 'terminal-snippet') return '터미널'
  return '파일'
}

function attachmentIdentity(attachment: AgentAttachment): string {
  if (attachment.kind === 'selection') return `${attachment.kind}:${attachment.label}:${attachment.text ?? ''}`
  return `${attachment.kind}:${attachment.path ?? attachment.label}`
}

function appendUniqueAttachments(current: AgentAttachment[], additions: AgentAttachment[]): AgentAttachment[] {
  const seen = new Set(current.map(attachmentIdentity))
  const merged = [...current]
  for (const attachment of additions) {
    const key = attachmentIdentity(attachment)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(attachment)
  }
  return merged
}

function attachmentReferenceText(attachment: AgentAttachment): string {
  if (attachment.kind === 'selection') return `「${attachment.label}」 선택 부분에 대해 `
  if (attachment.kind === 'folder') return `「${attachment.label}」 폴더에 대해 `
  if (attachment.kind === 'pdf-page-range') return `「${attachment.label}」 PDF 범위에 대해 `
  if (attachment.kind === 'terminal-snippet') return `「${attachment.label}」 터미널 출력에 대해 `
  return `「${attachment.label}」 파일에 대해 `
}

function attachmentTitle(attachment: AgentAttachment): string {
  const access =
    attachment.access === 'context-only'
      ? '질문 첨부 본문으로 전달됨'
      : attachment.access === 'workspace-path'
        ? '작업공간 경로로 전달됨'
        : undefined
  const source = attachment.source
    ? [
        attachment.source.title ? `원문: ${attachment.source.title}` : undefined,
        attachment.source.path ? `원문 경로: ${attachment.source.path}` : undefined
      ].filter(Boolean).join('\n')
    : undefined
  const detail = attachment.text
    ? attachment.text.length > 500
      ? `${attachment.text.slice(0, 500)}...`
      : attachment.text
    : undefined
  return [attachment.path, source, access, detail].filter(Boolean).join('\n\n') || attachment.label
}

function canOpenAttachmentSource(attachment: AgentAttachment): boolean {
  return !!attachment.source && (!!attachment.source.docId || !!attachment.source.path)
}

function messageQuote(value: unknown): AgentMessageQuote | undefined {
  const quote = asRecord(value)
  const messageId = stringValue(quote?.messageId)
  const preview = stringValue(quote?.preview)
  return messageId && preview ? { messageId, preview } : undefined
}

function quotePreview(text: string): string {
  const preview = markdownPreviewText(text).replace(/\s+/g, ' ').trim()
  if (!preview) return '에이전트 답변'
  return preview.length > QUOTE_PREVIEW_LIMIT ? `${preview.slice(0, QUOTE_PREVIEW_LIMIT)}...` : preview
}

function QuoteReference({
  quote,
  onOpen,
  onRemove
}: {
  quote: AgentMessageQuote
  onOpen: () => void
  onRemove?: () => void
}): JSX.Element {
  return (
    <div className="agent-quote-reference">
      <button type="button" className="agent-quote-preview" onClick={onOpen} title={quote.preview}>
        {quote.preview}
      </button>
      <span className="agent-copy-actions">
        <button type="button" title="인용한 답변으로 이동" onClick={onOpen}>
          원문
        </button>
        {onRemove && (
          <button type="button" title="인용 취소" aria-label="인용 취소" onClick={onRemove}>
            ×
          </button>
        )}
      </span>
    </div>
  )
}

function normalizeAgentAttachments(value: unknown): AgentAttachment[] {
  return recordArray(value)
    .flatMap((attachment): AgentAttachment[] => {
      const kind = stringValue(attachment.kind)
      const label = stringValue(attachment.label)
      if (
        !label ||
        (kind !== 'file' &&
          kind !== 'folder' &&
          kind !== 'selection' &&
          kind !== 'pdf-page-range' &&
          kind !== 'terminal-snippet')
      )
        return []
      const range = asRecord(attachment.range)
      return [
        {
          kind,
          label,
          path: stringValue(attachment.path),
          origin: attachmentOrigin(attachment.origin),
          access: attachmentAccess(attachment.access),
          range: range
            ? {
                startLine: numberValue(range.startLine),
                endLine: numberValue(range.endLine),
                startPage: numberValue(range.startPage),
                endPage: numberValue(range.endPage)
              }
            : undefined,
          source: attachmentSource(attachment.source),
          text: stringValue(attachment.text),
          content: stringValue(attachment.content),
          contentTruncated: attachment.contentTruncated === true
        }
      ]
    })
}

const eventSessionId = (event: AgentEvent): string | undefined => {
  const direct = stringValue(event.sessionId)
  if (direct) return direct
  const request = asRecord(event.request)
  return stringValue(request?.sessionId)
}

const upsertItem = (
  items: TimelineItem[],
  id: string,
  makeItem: () => TimelineItem,
  update: (item: TimelineItem) => TimelineItem
): TimelineItem[] => {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return [...items, makeItem()]
  return items.map((item, i) => (i === index ? update(item) : item))
}

const stepSummary = (step: ProcessStep): string =>
  [step.title, step.status && step.status !== 'running' ? step.status : undefined].filter(Boolean).join(' · ')

function processGroupId(items: TimelineItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'process') return item.id
    if (item.kind === 'user') return `process-${item.id}`
  }
  return 'process-session'
}

type ProcessStepPatch = Partial<ProcessStep> & { id: string }

function mergeProcessStep(existing: ProcessStep | undefined, patch: ProcessStepPatch): ProcessStep {
  return {
    id: patch.id,
    title: patch.title ?? existing?.title ?? '작업',
    text: patch.text ?? existing?.text,
    status: patch.status ?? existing?.status,
    toolName: patch.toolName ?? existing?.toolName,
    input: patch.input ?? existing?.input,
    output: patch.output ?? existing?.output,
    elapsedMs: patch.elapsedMs ?? existing?.elapsedMs
  }
}

function upsertProcessStep(items: TimelineItem[], patch: ProcessStepPatch): TimelineItem[] {
  const id = processGroupId(items)
  const makeItem = (): TimelineItem => {
    const step = mergeProcessStep(undefined, patch)
    return {
      id,
      kind: 'process',
      title: '작업 과정',
      text: stepSummary(step),
      status: step.status ?? 'running',
      processSteps: [step]
    }
  }
  const updateItem = (item: TimelineItem): TimelineItem => {
    const steps = item.processSteps ?? []
    const exists = steps.some((existing) => existing.id === patch.id)
    const nextSteps = exists
      ? steps.map((existing) => (existing.id === patch.id ? mergeProcessStep(existing, patch) : existing))
      : [...steps, mergeProcessStep(undefined, patch)]
    const latest = nextSteps[nextSteps.length - 1]
    const hasError = nextSteps.some((existing) => existing.status === 'error')
    const running = nextSteps.some((existing) => existing.status === 'running')
    return {
      ...item,
      title: '작업 과정',
      text: latest ? stepSummary(latest) : item.text,
      status: hasError ? 'error' : running ? 'running' : latest?.status ?? 'done',
      processSteps: nextSteps
    }
  }
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) return items.map((item, i) => (i === index ? updateItem(item) : item))

  const insertAfter = [...items].map((item) => item.kind).lastIndexOf('user')
  if (insertAfter < 0) return [...items, makeItem()]
  return [...items.slice(0, insertAfter + 1), makeItem(), ...items.slice(insertAfter + 1)]
}

// 편집형 도구의 권한 요청에는 승인 전에 변경 내용을 미리 보여준다.
const PERMISSION_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function permissionDiffFromRequest(
  toolName: string | undefined,
  input: Record<string, unknown> | null
): DiffView | undefined {
  if (!toolName || !input || !PERMISSION_EDIT_TOOLS.has(toolName)) return undefined
  const filePath = stringValue(input.file_path) ?? stringValue(input.notebook_path)
  const edits = normalizeDiffEdits(
    recordArray(input.edits).map((edit) => ({
      oldString: edit.old_string ?? edit.oldString,
      newString: edit.new_string ?? edit.newString
    }))
  )
  return diffViewFromParts({
    filePath,
    oldString: stringValue(input.old_string),
    newString: stringValue(input.new_string) ?? (toolName === 'Write' ? stringValue(input.content) : undefined),
    edits: edits.length > 0 ? edits : undefined
  })
}

function reduceTimeline(items: TimelineItem[], event: AgentEvent, agentLabel: string): TimelineItem[] {
  if (event.type === 'message:user') {
    return [
      ...items,
      {
        id: stringValue(event.messageId) ?? `user-${Date.now()}`,
        kind: 'user',
        title: '나',
        text: stringValue(event.text) ?? '',
        quote: messageQuote(event.quote),
        attachments: normalizeAgentAttachments(event.attachments)
      }
    ]
  }
  if (event.type === 'session:interrupted') {
    return interruptedTimelineItems(items, stringValue(event.message))
  }
  if (event.type === 'message:assistant_start') {
    const id = stringValue(event.messageId) ?? `assistant-${Date.now()}`
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'assistant', title: agentLabel, text: '', status: 'streaming' }),
      (item) => ({ ...item, status: item.status === 'done' ? 'done' : 'streaming' })
    )
  }
  if (event.type === 'message:assistant_delta') {
    const id = stringValue(event.messageId) ?? `assistant-${Date.now()}`
    const text = stringValue(event.text) ?? ''
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'assistant', title: agentLabel, text, status: 'streaming' }),
      (item) => ({ ...item, text: `${item.text ?? ''}${text}`, status: 'streaming' })
    )
  }
  if (event.type === 'message:assistant_replace') {
    const id = stringValue(event.messageId) ?? `assistant-${Date.now()}`
    const text = stringValue(event.text) ?? ''
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'assistant', title: agentLabel, text, status: 'streaming' }),
      (item) => ({ ...item, text, status: item.status === 'done' ? 'done' : 'streaming' })
    )
  }
  if (event.type === 'message:assistant_done') {
    const id = stringValue(event.messageId)
    if (!id) return items
    return items.map((item) => (item.id === id ? { ...item, status: 'done' } : item))
  }
  if (event.type === 'process:event') {
    return upsertProcessStep(items, {
      id: stringValue(event.processId) ?? `process-${Date.now()}`,
      title: stringValue(event.title) ?? '프로세스',
      text: stringValue(event.text),
      status: stringValue(event.status) ?? 'running'
    })
  }
  if (event.type === 'queue:added') {
    const queueId = stringValue(event.queueId) ?? `queue-${Date.now()}`
    const delivery = stringValue(event.delivery)
    const title = delivery === 'steer' ? '바로 지시 대기' : '대기 중인 지시'
    const queueItem: TimelineItem = {
      id: queueId,
      kind: 'queue',
      title,
      queueId,
      text: stringValue(event.text) ?? '',
      quote: messageQuote(event.quote),
      attachments: normalizeAgentAttachments(event.attachments),
      status: delivery === 'steer' ? 'priority' : 'queued'
    }
    if (items.some((item) => item.queueId === queueId)) {
      return items.map((item) => (item.queueId === queueId ? { ...item, ...queueItem } : item))
    }
    return [...items, queueItem]
  }
  if (event.type === 'queue:started') {
    const queueId = stringValue(event.queueId)
    if (!queueId) return items
    return items.filter((item) => item.queueId !== queueId)
  }
  if (event.type === 'queue:promoted') {
    const queueId = stringValue(event.queueId)
    if (!queueId) return items
    return items.map((item) =>
      item.queueId === queueId ? { ...item, title: '바로 지시 대기', status: 'priority' } : item
    )
  }
  if (event.type === 'queue:removed') {
    const queueId = stringValue(event.queueId)
    if (!queueId) return items
    return items.filter((item) => item.queueId !== queueId)
  }
  if (event.type === 'queue:cleared') {
    const queueIds = stringArray(event.queueIds)
    if (queueIds.length === 0) return items
    return items.map((item) =>
      item.queueId && queueIds.includes(item.queueId) ? { ...item, status: 'canceled' } : item
    )
  }
  if (event.type === 'tool:start') {
    const id = stringValue(event.toolId) ?? `tool-${Date.now()}`
    const name = stringValue(event.name) ?? 'tool'
    return upsertProcessStep(items, {
      id,
      title: `도구 · ${name}`,
      toolName: name,
      input: stringValue(event.inputPreview),
      status: 'running'
    })
  }
  if (event.type === 'tool:done') {
    const id = stringValue(event.toolId) ?? `tool-${Date.now()}`
    return upsertProcessStep(items, {
      id,
      output: stringValue(event.outputPreview),
      elapsedMs: numberValue(event.elapsedMs),
      status: event.isError ? 'error' : 'done'
    })
  }
  if (event.type === 'permission:request') {
    const request = asRecord(event.request)
    const requestId = stringValue(request?.requestId) ?? `permission-${Date.now()}`
    const toolName = stringValue(request?.toolName)
    const input = asRecord(request?.input)
    const planMarkdown =
      toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode' ? stringValue(input?.plan) : undefined
    return [
      ...items,
      {
        id: requestId,
        kind: 'permission',
        title: stringValue(request?.title) ?? (toolName ? toolDisplayName(toolName) : undefined) ?? '권한 요청',
        text: stringValue(request?.description) ?? stringValue(request?.decisionReason),
        requestId,
        toolName,
        inputPreview: stringValue(request?.inputPreview),
        diff: permissionDiffFromRequest(toolName, input),
        planMarkdown,
        status: 'waiting'
      }
    ]
  }
  if (event.type === 'plan:proposed') {
    const id = stringValue(event.planId) ?? `plan-${Date.now()}`
    const markdown = stringValue(event.markdown) ?? ''
    if (!markdown) return items
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'plan', title: '계획 제안', planMarkdown: markdown }),
      (item) => ({ ...item, planMarkdown: markdown })
    )
  }
  if (event.type === 'permission:resolved') {
    const requestId = stringValue(event.requestId)
    if (!requestId) return items
    return items.map((item) =>
      item.requestId === requestId
        ? { ...item, status: 'resolved', decision: event.decision === 'allow' ? 'allow' : 'reject' }
        : item
    )
  }
  if (event.type === 'dialog:request') {
    const dialog = asRecord(event.dialog)
    const dialogId = stringValue(dialog?.dialogId) ?? `dialog-${Date.now()}`
    return upsertItem(
      items,
      dialogId,
      () => ({
        id: dialogId,
        kind: 'dialog',
        title: stringValue(dialog?.title) ?? `${agentLabel} 질문`,
        text: stringValue(dialog?.dialogKind),
        status: 'waiting',
        dialogId,
        questions: dialogQuestions(dialog?.questions),
        inputPreview: stringValue(dialog?.payloadPreview)
      }),
      (item) => ({
        ...item,
        title: stringValue(dialog?.title) ?? item.title,
        status: 'waiting',
        questions: dialogQuestions(dialog?.questions),
        inputPreview: stringValue(dialog?.payloadPreview) ?? item.inputPreview
      })
    )
  }
  if (event.type === 'dialog:resolved') {
    const dialogId = stringValue(event.dialogId)
    if (!dialogId) return items
    const answers = asRecord(event.answers) as Record<string, string> | null
    return items.map((item) =>
      item.dialogId === dialogId
        ? {
            ...item,
            status: event.cancelled ? 'cancelled' : 'resolved',
            answers: answers ?? item.answers,
            text: stringValue(event.response) ?? item.text
          }
        : item
    )
  }
  if (event.type === 'diff:proposed') {
    const proposal = asRecord(event.proposal)
    const id = stringValue(proposal?.proposalId) ?? `diff-${Date.now()}`
    const filePath = stringValue(proposal?.filePath)
    const oldString = stringValue(proposal?.oldString)
    const newString = stringValue(proposal?.newString)
    const diff = diffViewFromRecord(proposal)
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'diff',
        title: diffTitle('변경 제안', filePath),
        filePath,
        text: diff ? undefined : diffFallbackText(oldString, newString),
        diff
      }),
      (item) => ({
        ...item,
        title: diffTitle('변경 제안', filePath),
        filePath: filePath ?? item.filePath,
        text: diff ? undefined : diffFallbackText(oldString, newString) ?? item.text,
        diff: diff ?? item.diff
      })
    )
  }
  if (event.type === 'diff:applied') {
    const id = stringValue(event.proposalId)
    if (!id) return items
    const filePath = stringValue(event.filePath)
    const oldString = stringValue(event.oldString)
    const newString = stringValue(event.newString)
    const diff = diffViewFromRecord(event)
    const fallbackText = diffFallbackText(oldString, newString)
    const appliedIndex = filePath
      ? items.findIndex((item) => item.kind === 'diff' && item.status === 'applied' && item.filePath === filePath)
      : -1
    const idIndex = items.findIndex((item) => item.id === id)
    const index = appliedIndex >= 0 ? appliedIndex : idIndex
    if (index < 0) {
      return [
        ...items,
        {
          id,
          kind: 'diff',
          title: diffTitle('변경 적용', filePath),
          status: 'applied',
          filePath,
          text: diff ? undefined : fallbackText,
          diff
        }
      ]
    }
    return items.flatMap((item, itemIndex) => {
      if (appliedIndex >= 0 && idIndex >= 0 && itemIndex === idIndex && idIndex !== appliedIndex) return []
      if (itemIndex !== index) return [item]
      const append = appliedIndex >= 0 && item.id !== id
      return [
        {
          ...item,
          id: append ? item.id : id,
          title: filePath ? diffTitle('변경 적용', filePath) : item.title,
          status: 'applied',
          filePath: filePath ?? item.filePath,
          text: diff ? undefined : append ? appendDiffFallbackText(item.text, fallbackText) : fallbackText ?? item.text,
          diff: append ? mergeDiffViews(item.diff, diff, filePath) : diff ?? item.diff
        }
      ]
    })
  }
  if (event.type === 'error') {
    return [
      ...items,
      {
        id: `error-${Date.now()}`,
        kind: 'error',
        title: '오류',
        text: stringValue(event.message) ?? '알 수 없는 오류'
      }
    ]
  }
  if (event.type === 'auth:started') {
    const id = `auth-${stringValue(event.sessionId) ?? Date.now()}`
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'auth',
        title: `${agentLabel} 로그인`,
        text: `${agentLabel} 로그인 절차를 시작했습니다.`,
        status: 'running'
      }),
      (item) => ({ ...item, status: 'running' })
    )
  }
  if (event.type === 'auth:output') {
    const id = `auth-${stringValue(event.sessionId) ?? Date.now()}`
    const text = stringValue(event.text) ?? ''
    const urls = stringArray(event.urls)
    const codes = stringArray(event.codes)
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'auth',
        title: `${agentLabel} 로그인`,
        text,
        status: 'running',
        urls,
        codes
      }),
      (item) => ({
        ...item,
        text: `${item.text ?? ''}${text}`,
        urls: [...new Set([...(item.urls ?? []), ...urls])],
        codes: [...new Set([...(item.codes ?? []), ...codes])]
      })
    )
  }
  if (event.type === 'auth:done') {
    const id = `auth-${stringValue(event.sessionId) ?? Date.now()}`
    const ok = event.ok === true
    const message = stringValue(event.message) ?? (ok ? `${agentLabel} 로그인이 완료되었습니다.` : `${agentLabel} 로그인이 실패했습니다.`)
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'auth',
        title: `${agentLabel} 로그인`,
        text: message,
        status: ok ? 'done' : 'error'
      }),
      (item) => ({ ...item, text: `${item.text ?? ''}\n${message}`, status: ok ? 'done' : 'error' })
    )
  }
  return items
}

function transcriptToTimeline(transcript: SessionTranscript, agentLabel: string): TimelineItem[] {
  return transcript.messages.map((message, index) => ({
    id: `history-${message.id || `${transcript.sessionId}-${index}`}`,
    kind: message.role === 'assistant' ? 'assistant' : 'user',
    title: message.role === 'assistant' ? agentLabel : '나',
    text: message.text
  }))
}

function forkTranscriptBody(transcript: SessionTranscript): string {
  const body = transcript.messages
    .map((message) => `### ${message.role}\n${message.text}`)
    .join('\n\n')
  return body.length > CONTEXT_ATTACHMENT_TEXT_LIMIT
    ? `[앞부분 일부 생략]\n${body.slice(-CONTEXT_ATTACHMENT_TEXT_LIMIT)}`
    : body
}

function forkContextPrompt(transcript: SessionTranscript): string {
  return [
    '다음은 새 독립 세션으로 fork한 원본 대화 transcript입니다.',
    '이 내용은 배경 맥락으로만 사용하고, 원본 세션에 이어붙이거나 원본 세션을 수정하지 마세요.',
    '아직 새 작업을 시작하지 말고 한 문장으로 맥락을 가져왔다는 사실만 확인하세요.',
    '',
    forkTranscriptBody(transcript)
  ].join('\n')
}

// 프로바이더 전환용: 핸드셰이크 턴 없이 첫 지시에 합쳐 보내는 맥락 프리앰블.
function handoffContextPreamble(transcriptBody: string): string {
  return [
    '다음은 사용자가 이 탭에서 다른 AI 어시스턴트와 진행하던 대화 transcript입니다.',
    '사용자가 어시스턴트를 전환했으므로, 이 대화의 맥락(사실관계, 요청, 이미 오간 답변과 제안)을 이어받으세요.',
    'transcript는 배경 맥락입니다. 다시 요약하거나 이어받았다고 따로 알릴 필요 없이, 마지막 흐름을 아는 상태에서 아래 사용자 지시를 바로 수행하세요.',
    '',
    transcriptBody,
    '',
    '---',
    '',
    '지금 처리할 사용자 지시:'
  ].join('\n')
}

// 타임라인의 사용자/어시스턴트 메시지를 프로바이더 전환용 transcript로 추출.
// 세션 파일에 의존하지 않아 Claude↔Codex 양방향·원격에서도 즉시 동작한다.
function providerHandoffFromTimeline(items: TimelineItem[]): AgentProviderHandoff | undefined {
  const messages = items.filter(
    (item) => (item.kind === 'user' || item.kind === 'assistant') && item.text && item.text.trim()
  )
  if (messages.length === 0) return undefined
  const body = messages
    .map((item) => `### ${item.kind === 'user' ? 'user' : 'assistant'}\n${item.text}`)
    .join('\n\n')
  const transcript =
    body.length > CONTEXT_ATTACHMENT_TEXT_LIMIT
      ? `[앞부분 일부 생략]\n${body.slice(-CONTEXT_ATTACHMENT_TEXT_LIMIT)}`
      : body
  return { transcript, count: messages.length }
}


function latestGeneratedPreview(items: TimelineItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'user') continue
    const source = item.text ?? item.title ?? ''
    const text = (item.kind === 'assistant' ? markdownPreviewText(source) : source).replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > TIMELINE_PREVIEW_LIMIT ? `${text.slice(0, TIMELINE_PREVIEW_LIMIT)}...` : text
  }
  return ''
}

export default function AgentPanel({
  id,
  cwd,
  title,
  provider,
  resumeSessionId,
  forkFromSessionId,
  initialHandoff,
  ssh,
  profileId,
  caseTabId,
  caseContext,
  visible,
  focusNonce = 0,
  initialDraft,
  clearDraftNonce,
  attachmentRequests = [],
  onAttachmentRequestsHandled,
  onDraftChange,
  onStatus,
  onFork,
  onProviderChange,
  onHandoffConsumed,
  onWorktreeFork,
  onOpenTerminal,
  onOpenDiff,
  onOpenFile,
  onOpenAttachmentSource,
  onPrepareAttachment
}: AgentPanelProps): JSX.Element {
  const usesClaudeRemoteAuth = Boolean(ssh) && provider === 'claude'
  const usesAgentAuth = usesClaudeRemoteAuth || provider === 'codex'
  const [items, setItems] = useState<TimelineItem[]>([])
  const [input, setInput] = useState(() => initialDraft?.input ?? '')
  const [quotedMessage, setQuotedMessage] = useState<PendingAgentQuote | null>(null)
  const [mode, setMode] = useState<AgentPermissionMode>(DEFAULT_AGENT_PERMISSION_MODE)
  const [status, setStatus] = useState<AgentPanelStatus>('idle')
  const [error, setError] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [runtimeSlashCommands, setRuntimeSlashCommands] = useState<SlashCommand[]>([])
  const [authActive, setAuthActive] = useState(false)
  const [authStatus, setAuthStatus] = useState<AgentAuthStatus>(usesAgentAuth ? 'checking' : 'unavailable')
  const [authStatusMessage, setAuthStatusMessage] = useState('')
  const [authInput, setAuthInput] = useState('')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [expandedProcessIds, setExpandedProcessIds] = useState<Set<string>>(new Set())
  const [agentFontSize, setAgentFontSize] = useState(DEFAULT_AGENT_FONT_SIZE)
  const [copyFeedback, setCopyFeedback] = useState('')
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number
    y: number
    html: string
    text: string
  } | null>(null)
  const [dialogChoices, setDialogChoices] = useState<Record<string, Record<string, string[]>>>({})
  const [dialogResponses, setDialogResponses] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<AgentAttachment[]>(() => initialDraft?.attachments ?? [])
  const [attachmentDropOver, setAttachmentDropOver] = useState(false)
  const [modelOptions, setModelOptions] = useState<AgentModelOption[]>([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelLoading, setModelLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string | undefined>()
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | undefined>()
  const [showNewOutputNotice, setShowNewOutputNotice] = useState(false)
  const [revertingDiffIds, setRevertingDiffIds] = useState<Set<string>>(new Set())
  const [usage, setUsage] = useState<AgentUsageView>(() => emptyAgentUsageView())
  const [escInterruptArmed, setEscInterruptArmed] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [pendingHandoff, setPendingHandoff] = useState<{ preamble: string; count: number } | null>(null)
  const [mentionState, setMentionState] = useState<{ query: string; start: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionEntries, setMentionEntries] = useState<MentionEntry[]>([])
  const mentionIndexCacheRef = useRef<{ root: string; entries: MentionEntry[] } | null>(null)
  const mentionMenuRef = useRef<HTMLDivElement>(null)
  const agentLabel = agentProviderLabels[provider]
  const createdRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowTimelineRef = useRef(true)
  const timelineUserScrollRef = useRef(false)
  const timelineUserScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const modelLoadStartedRef = useRef(false)
  const openedAuthUrlsRef = useRef<Set<string>>(new Set())
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedHistoryKeyRef = useRef<string | null>(null)
  const handledAttachmentRequestIdsRef = useRef<Set<string>>(new Set())
  const promptHistoryRef = useRef<string[]>([])
  const promptHistoryIndexRef = useRef<number | null>(null)
  const promptHistoryDraftRef = useRef('')
  const promptHistoryEditsRef = useRef<Map<number, string>>(new Map())
  const escInterruptArmedRef = useRef(false)
  const escInterruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const providerRef = useRef(provider)
  const clearDraftNonceRef = useRef(clearDraftNonce)
  const onDraftChangeRef = useRef(onDraftChange)

  const clearEscInterruptTimer = useCallback((): void => {
    if (escInterruptTimerRef.current) {
      clearTimeout(escInterruptTimerRef.current)
      escInterruptTimerRef.current = null
    }
  }, [])

  const disarmEscInterrupt = useCallback((): void => {
    clearEscInterruptTimer()
    escInterruptArmedRef.current = false
    setEscInterruptArmed(false)
  }, [clearEscInterruptTimer])

  const armEscInterrupt = useCallback((): void => {
    clearEscInterruptTimer()
    escInterruptArmedRef.current = true
    setEscInterruptArmed(true)
    escInterruptTimerRef.current = setTimeout(() => {
      escInterruptArmedRef.current = false
      setEscInterruptArmed(false)
      escInterruptTimerRef.current = null
    }, ESC_INTERRUPT_ARM_MS)
  }, [clearEscInterruptTimer])

  useEffect(() => clearEscInterruptTimer, [clearEscInterruptTimer])

  useEffect(() => {
    if (providerRef.current === provider) return
    providerRef.current = provider
    createdRef.current = false
    loadedHistoryKeyRef.current = null
    handledAttachmentRequestIdsRef.current.clear()
    setItems([])
    setRuntimeSlashCommands([])
    setAuthActive(false)
    setAuthInput('')
    setAttachments([])
    setQuotedMessage(null)
    setAuthStatus(usesAgentAuth ? 'checking' : 'unavailable')
    setAuthStatusMessage('')
    setModelOptions([])
    modelLoadStartedRef.current = false
    setModelPickerOpen(false)
    setSelectedModel(undefined)
    setSelectedReasoningEffort(undefined)
    setUsage(emptyAgentUsageView())
    setError('')
  }, [provider, ssh, usesAgentAuth])

  const focusPrompt = useCallback((position?: number): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const caret = Math.max(0, Math.min(position ?? textarea.value.length, textarea.value.length))
      textarea.focus()
      textarea.setSelectionRange(caret, caret)
    })
  }, [])

  const revealQuotedMessage = useCallback(
    (messageId: string): void => {
      document.getElementById(`agent-message-${id}-${messageId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    },
    [id]
  )

  useEffect(() => {
    if (!visible || authActive) return
    focusPrompt()
  }, [authActive, focusNonce, focusPrompt, visible])

  const resetPromptHistoryCursor = useCallback((): void => {
    promptHistoryIndexRef.current = null
    promptHistoryDraftRef.current = ''
    promptHistoryEditsRef.current.clear()
  }, [])

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange
  }, [onDraftChange])

  useEffect(() => {
    onDraftChangeRef.current?.({ input, attachments })
  }, [attachments, input])

  useEffect(() => {
    if (clearDraftNonceRef.current === clearDraftNonce) return
    clearDraftNonceRef.current = clearDraftNonce
    resetPromptHistoryCursor()
    setInput('')
    setAttachments([])
    setQuotedMessage(null)
  }, [clearDraftNonce, resetPromptHistoryCursor])

  const rememberPrompts = useCallback(
    (prompts: string[]): void => {
      promptHistoryRef.current = mergePromptHistory(promptHistoryRef.current, prompts)
      resetPromptHistoryCursor()
    },
    [resetPromptHistoryCursor]
  )

  const recallPromptHistory = useCallback(
    (direction: -1 | 1): boolean => {
      const history = promptHistoryRef.current
      if (history.length === 0) return false

      const currentIndex = promptHistoryIndexRef.current
      if (direction === 1 && currentIndex === null) return false
      if (direction === -1 && currentIndex === 0) return true

      // 탐색 중 수정한 내용은 세션 버퍼에 남겨 위/아래로 오가도 유지한다 (readline 방식)
      const edits = promptHistoryEditsRef.current
      if (currentIndex === null) {
        promptHistoryDraftRef.current = input
      } else if (input !== history[currentIndex]) {
        edits.set(currentIndex, input)
      } else {
        edits.delete(currentIndex)
      }

      let nextIndex: number | null
      if (direction === -1) {
        nextIndex = currentIndex === null ? history.length - 1 : currentIndex - 1
      } else if (currentIndex !== null && currentIndex >= history.length - 1) {
        nextIndex = null
      } else {
        nextIndex = (currentIndex ?? history.length - 1) + 1
      }

      promptHistoryIndexRef.current = nextIndex
      const nextInput =
        nextIndex === null ? promptHistoryDraftRef.current : (edits.get(nextIndex) ?? history[nextIndex])
      setInput(nextInput)
      focusPrompt(nextInput.length)
      return true
    },
    [focusPrompt, input]
  )

  const latestOutputPreview = useMemo(
    () => (showNewOutputNotice ? latestGeneratedPreview(items) : ''),
    [items, showNewOutputNotice]
  )

  const showTransientFeedback = useCallback((message: string): void => {
    setCopyFeedback(message)
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 1400)
  }, [])

  const persistPermissionMode = useCallback((nextMode: AgentPermissionMode): void => {
    window.lt.settings
      .set({ agentDefaultPermissionMode: nextMode })
      .then((settings) => {
        window.dispatchEvent(new CustomEvent<AppSettings>(SETTINGS_UPDATED_EVENT, { detail: settings }))
      })
      .catch(() => {
        /* 권한 모드 저장 실패는 현재 세션 동작을 막지 않는다. */
      })
  }, [])

  const selectPermissionMode = useCallback(
    (nextMode: AgentPermissionMode, persist = true): void => {
      setMode(nextMode)
      if (persist) persistPermissionMode(nextMode)
    },
    [persistPermissionMode]
  )

  const scrollTimelineToBottom = useCallback((): void => {
    shouldFollowTimelineRef.current = true
    setShowNewOutputNotice(false)
    const scroll = (): void => {
      const timeline = scrollRef.current
      timeline?.scrollTo({ top: timeline.scrollHeight })
    }
    scroll()
    window.requestAnimationFrame(scroll)
  }, [])

  const markTimelineUserScroll = useCallback((): void => {
    timelineUserScrollRef.current = true
    if (timelineUserScrollTimerRef.current) clearTimeout(timelineUserScrollTimerRef.current)
    timelineUserScrollTimerRef.current = setTimeout(() => {
      timelineUserScrollRef.current = false
      timelineUserScrollTimerRef.current = null
    }, 180)
  }, [])

  const updateTimelineFollowState = useCallback((): void => {
    const timeline = scrollRef.current
    if (!timeline) return
    const atBottom = isTimelineNearBottom(timeline)
    if (!timelineUserScrollRef.current && shouldFollowTimelineRef.current && !atBottom) return
    shouldFollowTimelineRef.current = atBottom
    if (atBottom) setShowNewOutputNotice(false)
  }, [])

  useEffect(() => {
    const off = window.lt.agent.onEvent((event) => {
      if (eventSessionId(event) !== id) return
      if (event.type === 'session:init' && event.slashCommands) {
        setRuntimeSlashCommands(runtimeSlashCommandsFromEvent(event.slashCommands))
      }
      if (event.type === 'session:commands') {
        setRuntimeSlashCommands(runtimeSlashCommandsFromEvent(event.commands))
      }
      if (event.type === 'usage:update') {
        const tokens = tokenUsageFromEvent(event.usage)
        const context = contextUsageFromEvent(event.context)
        const rateLimit = rateLimitUsageFromEvent(event.rateLimit)
        const rateLimits = rateLimitUsagesFromEvent(event.rateLimits)
        const hasRateLimits = Object.prototype.hasOwnProperty.call(event, 'rateLimits')
        setUsage((current) => ({
          tokens: tokens ?? current.tokens,
          context: context ?? current.context,
          rateLimit: rateLimit ?? rateLimits?.[0] ?? current.rateLimit,
          rateLimits: hasRateLimits ? (rateLimits ?? []) : current.rateLimits
        }))
      }
      if (event.type === 'auth:started') setAuthActive(true)
      if (event.type === 'auth:done') setAuthActive(false)
      if (event.type === 'auth:status') {
        const state = stringValue(event.state)
        if (
          state === 'checking' ||
          state === 'authenticated' ||
          state === 'unauthenticated' ||
          state === 'unavailable' ||
          state === 'error'
        ) {
          setAuthStatus(state)
          setAuthStatusMessage(stringValue(event.message) ?? '')
        }
      }
      if (event.type === 'auth:output') {
        for (const url of stringArray(event.urls)) {
          if (openedAuthUrlsRef.current.has(url)) continue
          openedAuthUrlsRef.current.add(url)
          void window.lt.app.openExternal(url)
        }
      }
      if (event.type === 'diff:applied') {
        const changedPath = agentFilePathForApp(stringValue(event.filePath), cwd, profileId, ssh)
        if (changedPath) {
          window.dispatchEvent(
            new CustomEvent(REMOTE_FILE_CHANGED_EVENT, { detail: { paths: [changedPath], caseTabId } })
          )
        }
      }
      if (event.type !== 'raw') setItems((prev) => reduceTimeline(prev, event, agentLabel))
      if (event.type === 'status') {
        const next = stringValue(event.status)
        if (
          next === 'working' ||
          next === 'waiting_permission' ||
          next === 'waiting_user' ||
          next === 'done' ||
          next === 'error'
        ) {
          setStatus(next)
          if (next === 'working') onStatus?.('working')
          else if (next === 'waiting_permission' || next === 'waiting_user') onStatus?.('question')
          else if (next === 'done') onStatus?.('done')
          else onStatus?.('question')
        } else if (next === 'idle') {
          setStatus('idle')
        }
      }
    })
    return off
  }, [agentLabel, cwd, id, onStatus, profileId, ssh])

  useEffect(() => {
    if (!settingsLoaded) return
    if (createdRef.current) return
    createdRef.current = true
    void window.lt.agent
      .create({
        id,
        cwd,
        title,
        provider,
        resumeSessionId,
        permissionMode: mode,
        source: ssh ? 'ssh' : 'local',
        ssh,
        context: caseContext
      })
      .then(async (result) => {
        if (!result.ok) setError(result.error ?? 'Agent 세션을 만들 수 없습니다.')
        if (!result.ok || !forkFromSessionId || resumeSessionId) return
        const transcript = await loadSessionTranscript(forkFromSessionId, ssh, { refresh: true }).catch(() => null)
        if (!transcript || transcript.messages.length === 0) return
        const sendResult = await window.lt.agent.send(id, {
          text: forkContextPrompt(transcript),
          displayText: `Fork 맥락 가져오기 · ${transcript.messages.length}개 메시지`
        })
        if (!sendResult.ok) setError(sendResult.error ?? 'Fork 맥락을 가져올 수 없습니다.')
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }, [caseContext, cwd, forkFromSessionId, id, mode, provider, resumeSessionId, settingsLoaded, ssh, title])

  // 프로바이더 전환으로 넘어온 대화 맥락을 보류해뒀다가 첫 지시에 합쳐 보낸다.
  useEffect(() => {
    if (!initialHandoff || initialHandoff.count === 0 || !initialHandoff.transcript.trim()) return
    setPendingHandoff({
      preamble: handoffContextPreamble(initialHandoff.transcript),
      count: initialHandoff.count
    })
  }, [initialHandoff])

  useEffect(() => {
    if (provider !== 'claude') return
    if (!resumeSessionId) return
    const historyKey = `${transcriptSourceKey(ssh)}:${resumeSessionId}`
    if (loadedHistoryKeyRef.current === historyKey) return
    loadedHistoryKeyRef.current = historyKey
    let alive = true
    void loadSessionTranscript(resumeSessionId, ssh)
      .then((transcript) => {
        // 이어 열린 순간부터 대화가 늘어나므로, 프리로드본은 여기서 한 번 쓰고 버린다.
        invalidateSessionTranscript(resumeSessionId, ssh)
        if (!alive || !transcript || transcript.messages.length === 0) return
        const historyItems = transcriptToTimeline(transcript, agentLabel)
        rememberPrompts(
          transcript.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.text)
        )
        setItems((current) => {
          const existing = new Set(current.map((item) => item.id))
          const missing = historyItems.filter((item) => !existing.has(item.id))
          if (missing.length === 0) return current
          return [...missing, ...current]
        })
      })
      .catch(() => {
        /* Resume context still works even when the transcript cannot be displayed. */
      })
    return () => {
      alive = false
    }
  }, [agentLabel, provider, rememberPrompts, resumeSessionId, ssh])

  useEffect(() => {
    if (!modeMenuOpen) return
    const close = (event: globalThis.MouseEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target && modeMenuRef.current?.contains(target)) return
      setModeMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [modeMenuOpen])

  useEffect(() => {
    let alive = true
    const applySettings = (settings: AppSettings): void => {
      if (!alive) return
      setAgentFontSize(clampAgentFontSize(settings.agentFontSize))
      setMode(resolveAgentPermissionMode(settings.agentDefaultPermissionMode))
      setSettingsLoaded(true)
    }
    window.lt.settings
      .get()
      .then(applySettings)
      .catch(() => {
        if (alive) setSettingsLoaded(true)
      })
    const onSettingsUpdated = (event: Event): void => {
      applySettings((event as CustomEvent<AppSettings>).detail)
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      alive = false
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [])

  useLayoutEffect(() => {
    if (!visible) return
    if (shouldFollowTimelineRef.current) {
      scrollTimelineToBottom()
      return
    }
    setShowNewOutputNotice(items.length > 0)
  }, [items, scrollTimelineToBottom, visible])

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      if (timelineUserScrollTimerRef.current) clearTimeout(timelineUserScrollTimerRef.current)
    },
    []
  )

  useEffect(() => {
    const onCopy = (event: globalThis.ClipboardEvent): void => {
      const selection = window.getSelection()
      const timeline = scrollRef.current
      if (!selection || selection.isCollapsed || !timeline || !event.clipboardData) return
      if (!selectionIntersectsElement(selection, timeline)) return
      if (!writeSelectionToClipboard(event.clipboardData, selection)) return
      event.preventDefault()
      setCopyFeedback('선택 영역 복사됨')
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 1200)
    }
    document.addEventListener('copy', onCopy, true)
    return () => document.removeEventListener('copy', onCopy, true)
  }, [])

  useEffect(() => {
    if (!selectionMenu) return
    const close = (): void => setSelectionMenu(null)
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
  }, [selectionMenu])

  const hasPrompt = useMemo(() => input.trim().length > 0 || attachments.length > 0, [attachments.length, input])
  const queuedCount = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === 'queue' &&
          (item.status === 'queued' || item.status === 'priority')
      ).length,
    [items]
  )
  const baseStatusLabel = agentStatusLabels[status]
  const currentModel = currentAgentModel(modelOptions, selectedModel, selectedReasoningEffort)
  const modelButtonLabel = modelLoading && modelOptions.length === 0
    ? '모델 확인 중'
    : currentModel.buttonLabel
  const escInterruptHint = `Esc ${Math.round(ESC_INTERRUPT_ARM_MS / 1000)}초 안에 한 번 더 누르면 중지`
  const statusLabel = escInterruptArmed ? `${baseStatusLabel}, ${escInterruptHint}` : baseStatusLabel
  const statusAccessibleLabel = queuedCount > 0 ? `${statusLabel}, 대기 ${queuedCount}` : statusLabel
  const needsAuth = useMemo(
    () => usesAgentAuth && items.some((item) => isAuthFailureText(item.text)),
    [items, usesAgentAuth]
  )
  const authCliUnavailable = usesAgentAuth && authStatus === 'unavailable'
  const authChecking = usesAgentAuth && authStatus === 'checking'
  const needsLogin = usesAgentAuth && authStatus !== 'authenticated' && (authStatus === 'unauthenticated' || needsAuth)
  const sendBlockedReason =
    !settingsLoaded
      ? 'Agent 설정 로드 중'
      : authActive
        ? `${agentLabel} 로그인 진행 중`
        : authChecking
          ? `${agentLabel} 상태 확인 중`
          : authCliUnavailable
            ? `${agentLabel} CLI 없음`
            : needsLogin
              ? `${agentLabel} 로그인 필요`
              : ''
  const canSubmit = useMemo(
    () => hasPrompt && !sendBlockedReason,
    [hasPrompt, sendBlockedReason]
  )
  const queuesNewInput = isActiveAgentStatus(status)
  const interruptible = queuesNewInput || authActive

  useEffect(() => {
    if (!queuesNewInput) {
      setElapsedSeconds(0)
      return
    }
    const startedAt = Date.now()
    setElapsedSeconds(0)
    const timer = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    )
    return () => clearInterval(timer)
  }, [queuesNewInput])

  const runningToolLabel = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind !== 'process') continue
      const running = (item.processSteps ?? []).filter((step) => step.status === 'running')
      const latest = running[running.length - 1]
      if (!latest) continue
      const display = toolStepDisplay(latest)
      return display.arg ? `${display.name}(${display.arg})` : display.name
    }
    return undefined
  }, [items])

  const waitingPermission = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind === 'permission' && item.status === 'waiting' && item.requestId) return item
    }
    return undefined
  }, [items])
  const stopButtonClassName = escInterruptArmed ? 'agent-stop-button armed' : 'agent-stop-button'
  const stopButtonTitle = escInterruptArmed
    ? `Esc ${Math.round(ESC_INTERRUPT_ARM_MS / 1000)}초 안에 한 번 더 누르면 중지됩니다`
    : '작업 중지'
  const slashToken = useMemo(() => {
    const trimmed = input.trimStart()
    if (!/^\/[^\s]*$/.test(trimmed)) return ''
    return trimmed.toLowerCase()
  }, [input])
  const allSlashCommands = useMemo(
    () =>
      mergeSlashCommands(
        slashCommands.filter((command) => !command.providers || command.providers.includes(provider)),
        provider === 'claude' ? runtimeSlashCommands : codexSlashCommands
      ),
    [provider, runtimeSlashCommands]
  )
  const slashMatches = useMemo(() => {
    if (!slashToken) return []
    const query = slashToken.slice(1)
    return allSlashCommands.filter((command) => {
      const haystack = [
        command.name.slice(1),
        ...((command.aliases ?? []).map((alias) => alias.replace(/^\//, ''))),
        command.label,
        command.description,
        command.argumentHint ?? ''
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    }).sort((a, b) => {
      const aTerminal = isTerminalOnlySlashCommand(a, provider)
      const bTerminal = isTerminalOnlySlashCommand(b, provider)
      return Number(aTerminal) - Number(bTerminal)
    })
  }, [allSlashCommands, provider, slashToken])
  const slashMenuRows = useMemo(() => {
    const panelRows = slashMatches
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => !isTerminalOnlySlashCommand(command, provider))
    const terminalRows = slashMatches
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => isTerminalOnlySlashCommand(command, provider))
    return [
      ...(panelRows.length > 0 ? [{ kind: 'heading' as const, label: '패널에서 실행' }] : []),
      ...panelRows.map((row) => ({ kind: 'command' as const, ...row })),
      ...(terminalRows.length > 0 ? [{ kind: 'heading' as const, label: '터미널 모드에서 실행' }] : []),
      ...terminalRows.map((row) => ({ kind: 'command' as const, ...row }))
    ]
  }, [provider, slashMatches])
  const showSlashMenu = slashMatches.length > 0 && !authActive

  useEffect(() => {
    setSlashIndex(0)
  }, [slashToken])

  useEffect(() => {
    setSlashIndex((current) => (slashMatches.length === 0 ? 0 : Math.min(current, slashMatches.length - 1)))
  }, [slashMatches.length])

  useLayoutEffect(() => {
    if (!visible) return
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const nextHeight = textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = nextHeight > textarea.offsetHeight ? 'auto' : 'hidden'
  }, [agentFontSize, input, visible])

  useLayoutEffect(() => {
    if (!showSlashMenu) return
    const active = slashMenuRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [showSlashMenu, slashIndex, slashMatches])

  // @-멘션: 커서 앞 토큰이 있으면 작업공간 파일 인덱스에서 후보를 찾는다.
  useEffect(() => {
    if (!mentionState) {
      setMentionEntries([])
      return
    }
    let alive = true
    const root = ssh && profileId ? remoteUri(profileId, cwd) : cwd
    const applyEntries = (entries: MentionEntry[]): void => {
      if (alive) setMentionEntries(filterMentionEntries(entries, mentionState.query))
    }
    const cached = mentionIndexCacheRef.current
    if (cached && cached.root === root) {
      applyEntries(cached.entries)
      return () => {
        alive = false
      }
    }
    void buildMentionIndex(root)
      .then((entries) => {
        mentionIndexCacheRef.current = { root, entries }
        applyEntries(entries)
      })
      .catch(() => {
        if (alive) setMentionEntries([])
      })
    return () => {
      alive = false
    }
  }, [cwd, mentionState, profileId, ssh])

  useEffect(() => {
    setMentionIndex(0)
  }, [mentionState?.query, mentionState?.start])

  // 전송·초기화 등으로 입력이 비면 멘션 메뉴도 닫는다.
  useEffect(() => {
    if (input === '') setMentionState(null)
  }, [input])

  const showMentionMenu = Boolean(mentionState) && mentionEntries.length > 0 && !authActive && !showSlashMenu

  useLayoutEffect(() => {
    if (!showMentionMenu) return
    const active = mentionMenuRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [showMentionMenu, mentionIndex, mentionEntries])

  const updateMentionFromTextarea = useCallback((textarea: HTMLTextAreaElement): void => {
    const caret = textarea.selectionStart ?? textarea.value.length
    const token = mentionTokenAt(textarea.value, caret)
    setMentionState((current) => {
      if (!token) return current === null ? current : null
      if (current && current.query === token.query && current.start === token.start) return current
      return token
    })
  }, [])

  const applySlashCommand = (command: SlashCommand): void => {
    resetPromptHistoryCursor()
    if (command.mode) setMode(command.mode)
    const nextInput = `${command.name} `
    setInput(nextInput)
    setError(
      isTerminalOnlySlashCommand(command, provider)
        ? `${command.name}은 터미널 TUI 전용 명령입니다. 조작하려면 상단 터미널 버튼으로 터미널 모드에서 실행해 주세요.`
        : ''
    )
    focusPrompt(nextInput.length)
  }

  const attachmentForPath = useCallback(
    async (path: string): Promise<AgentAttachment> => {
      const remote = parseRemoteUri(path)
      const sameRemote = remote && ssh && profileId && remote.profileId === profileId
      const readablePath = sameRemote ? remote.path : path
      const stat = await window.lt.fs.stat(path).catch(() => null)
      const access: AgentAttachment['access'] =
        sameRemote || (!remote && !ssh) ? 'workspace-path' : 'context-only'
      const isDir = stat?.ok && stat.isDir
      const extracted =
        stat?.ok && isDir
          ? await extractFolderAttachmentContent(path)
          : access === 'context-only' && stat?.ok
            ? await extractContextAttachmentContent(path)
            : undefined
      const notes = [
        access === 'context-only'
          ? '이 첨부는 현재 질문과 함께 전달된 참고 파일입니다. 원격 작업공간 경로로 읽으려 하지 말고 첨부 본문을 기준으로 검토하세요.'
          : undefined,
        sameRemote ? `앱 원격 URI: ${path}` : undefined,
        remote && !sameRemote
          ? '주의: 이 파일은 Legal Terminal 원격 URI입니다. 같은 SSH 프로필의 Agent가 아니면 Claude가 직접 읽지 못할 수 있습니다.'
          : undefined,
        !remote && ssh
          ? '주의: 이 파일은 로컬 경로입니다. 현재 Agent가 원격에서 실행 중이면 원격 서버에 같은 파일이 있어야 Claude가 직접 읽을 수 있습니다.'
          : undefined,
        isDir
          ? '폴더 첨부는 상위 목록 요약만 전달합니다. 필요한 파일 본문은 개별 첨부하거나 명시적으로 읽으세요.'
          : undefined,
        extracted?.note
      ].filter((note): note is string => Boolean(note))
      return {
        kind: isDir ? 'folder' : 'file',
        label: fileNameFromPath(readablePath),
        path: readablePath,
        origin: remote ? 'remote' : 'local',
        access,
        text: notes.length ? notes.join('\n') : undefined,
        content: extracted?.content,
        contentTruncated: extracted?.truncated
      }
    },
    [profileId, ssh]
  )

  const attachmentPathForInputPath = useCallback(
    async (path: string): Promise<string> => {
      if (!ssh || !profileId || parseRemoteUri(path)) return path
      try {
        const copied = await window.lt.fs.copyInto(remoteUri(profileId, cwd), [path])
        return copied.copied[0] ?? path
      } catch {
        return path
      }
    },
    [cwd, profileId, ssh]
  )

  const addPathAttachments = useCallback(
    (paths: string[], source: 'drop' | 'paste'): void => {
      const unique = uniqueStrings(paths)
      if (unique.length === 0 || authActive) return
      focusPrompt()
      void (async () => {
        const nextAttachments: AgentAttachment[] = []
        for (const path of unique) {
          nextAttachments.push(await attachmentForPath(await attachmentPathForInputPath(path)))
        }
        return nextAttachments
      })()
        .then((nextAttachments) => {
          setAttachments((current) => {
            return appendUniqueAttachments(current, nextAttachments)
          })
          showTransientFeedback(`${source === 'drop' ? '드롭' : '붙여넣기'} 파일 ${nextAttachments.length}개 첨부됨`)
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
    },
    [attachmentForPath, attachmentPathForInputPath, authActive, focusPrompt, showTransientFeedback]
  )

  const applyMentionEntry = useCallback(
    (entry: MentionEntry): void => {
      const state = mentionState
      if (!state) return
      setMentionState(null)
      const insert = `@${entry.relPath} `
      resetPromptHistoryCursor()
      setInput((current) => {
        const tokenEnd = Math.min(current.length, state.start + state.query.length + 1)
        return `${current.slice(0, state.start)}${insert}${current.slice(tokenEnd)}`
      })
      focusPrompt(state.start + insert.length)
      void attachmentForPath(entry.absPath)
        .then((attachment) => {
          setAttachments((current) => appendUniqueAttachments(current, [attachment]))
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
    },
    [attachmentForPath, focusPrompt, mentionState, resetPromptHistoryCursor]
  )

  // 컴포저의 @ 버튼: 커서 위치에 '@'를 넣어 멘션 검색을 연다.
  const insertMentionTrigger = useCallback((): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? input.length
    const before = input.slice(0, caret)
    const after = input.slice(caret)
    const needsSpace = before.length > 0 && !/\s$/.test(before)
    const insert = `${needsSpace ? ' ' : ''}@`
    const nextCaret = caret + insert.length
    resetPromptHistoryCursor()
    setInput(`${before}${insert}${after}`)
    setMentionState({ query: '', start: caret + (needsSpace ? 1 : 0) })
    focusPrompt(nextCaret)
  }, [focusPrompt, input, resetPromptHistoryCursor])

  useEffect(() => {
    const pending = attachmentRequests.filter(
      (request) => !handledAttachmentRequestIdsRef.current.has(request.id)
    )
    if (pending.length === 0) return

    for (const request of pending) handledAttachmentRequestIdsRef.current.add(request.id)
    setAttachments((current) => appendUniqueAttachments(current, pending.map((request) => request.attachment)))

    const inputText = pending
      .map((request) => request.inputText)
      .filter((text): text is string => !!text)
      .join('\n')
    if (inputText) {
      resetPromptHistoryCursor()
      setInput((current) => {
        if (!current) return inputText
        const separator = /\s$/.test(current) ? '' : '\n'
        return `${current}${separator}${inputText}`
      })
    }

    const selectionCount = pending.filter((request) => request.attachment.kind === 'selection').length
    const fileCount = pending.length - selectionCount
    const parts = [
      selectionCount > 0 ? `선택 영역 ${selectionCount}개` : undefined,
      fileCount > 0 ? `첨부 ${fileCount}개` : undefined
    ].filter((part): part is string => Boolean(part))
    showTransientFeedback(`${parts.join(', ')} 추가됨`)

    if (pending.some((request) => request.focusPrompt)) {
      focusPrompt()
    }
    onAttachmentRequestsHandled?.(pending.map((request) => request.id))
  }, [attachmentRequests, focusPrompt, onAttachmentRequestsHandled, resetPromptHistoryCursor, showTransientFeedback])

  const removeAttachment = (index: number): void => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
  }

  const insertAttachmentReference = (attachment: AgentAttachment): void => {
    const reference = attachmentReferenceText(attachment)
    resetPromptHistoryCursor()
    setInput((current) => {
      const separator = current.length === 0 || /\s$/.test(current) ? '' : ' '
      return `${current}${separator}${reference}`
    })
    focusPrompt()
  }

  const send = async (delivery?: AgentSendDelivery): Promise<void> => {
    const rawText = input.trim()
    const sendAttachments = attachments
    const commandName = rawText ? slashCommandName(rawText) : undefined
    const slashArgument = rawText.match(/^\/[^\s]+(?:\s+([\s\S]*))?$/)?.[1]?.trim() ?? ''
    if (commandName === '/mcp' && isInteractiveMcpArgument(slashArgument)) {
      setError('/mcp 설정/OAuth 조작은 터미널 TUI 전용입니다. 상단 터미널 버튼으로 터미널 모드에서 실행해 주세요.')
      return
    }
    if (commandName === '/model') {
      if (sendAttachments.length > 0) {
        setError('/model에는 첨부를 사용할 수 없습니다.')
        return
      }
      if (sendBlockedReason) {
        setError(sendBlockedReason)
        return
      }
      const tokens = slashArgument.split(/\s+/).filter(Boolean)
      const effortFlagIndex = tokens.findIndex((token) => token === 'effort' || token === '--effort')
      const requestedModel = tokens[0]
      const requestedEffort =
        effortFlagIndex >= 0 ? tokens[effortFlagIndex + 1] : tokens.length > 1 ? tokens[1] : undefined
      if (requestedModel) {
        const useDefault = requestedModel === 'default' || requestedModel === 'auto'
        await chooseModel(useDefault ? undefined : requestedModel, useDefault ? undefined : requestedEffort)
      } else {
        await openModelPicker()
      }
      rememberPrompts([rawText])
      setInput('')
      setAttachments([])
      setError('')
      return
    }
    if (
      commandName &&
      ((provider === 'claude' && claudeTerminalOnlySlashCommandNames.has(commandName)) ||
        (provider === 'codex' && codexTerminalOnlySlashCommandNames.has(commandName)))
    ) {
      setError(`${commandName}은 터미널 TUI 전용 명령입니다. 조작하려면 상단 터미널 버튼으로 터미널 모드에서 실행해 주세요.`)
      return
    }
    if (provider === 'codex' && commandName && codexPanelSlashCommandNames.has(commandName)) {
      if (sendAttachments.length > 0) {
        setError(`${commandName}에는 첨부를 사용할 수 없습니다.`)
        return
      }
      if (sendBlockedReason) {
        setError(sendBlockedReason)
        return
      }
      scrollTimelineToBottom()
      const result = await window.lt.agent.slashCommand(id, commandName, slashArgument)
      if (!result.ok) {
        setError(result.error ?? `${commandName} 명령을 실행할 수 없습니다.`)
        return
      }
      if (commandName === '/clear' || commandName === '/new') {
        setItems([])
        setQuotedMessage(null)
      }
      rememberPrompts([rawText])
      setInput('')
      setAttachments([])
      setError('')
      return
    }
    if (provider === 'claude' && rawText && slashCommandName(rawText) === '/mcp') {
      if (sendAttachments.length > 0) {
        setError('MCP 상태 확인에는 첨부를 사용할 수 없습니다.')
        return
      }
      if (sendBlockedReason) {
        setError(sendBlockedReason)
        return
      }
      scrollTimelineToBottom()
      const result = await window.lt.agent.mcpStatus(id)
      if (!result.ok) {
        setError(result.error ?? 'MCP 상태를 확인할 수 없습니다.')
        return
      }
      rememberPrompts([rawText])
      setInput('')
      setAttachments([])
      setError('')
      return
    }

    const expanded = rawText ? expandSlashInput(rawText, allSlashCommands) : { text: '' }
    const text = expanded.text
    if ((!text && sendAttachments.length === 0) || sendBlockedReason) {
      if (sendBlockedReason) setError(sendBlockedReason)
      return
    }
    scrollTimelineToBottom()
    const nextMode = expanded.mode ?? mode
    if (expanded.mode) selectPermissionMode(expanded.mode, false)
    if (rawText) rememberPrompts([rawText])
    setInput('')
    setAttachments([])
    setMentionState(null)
    setError('')
    const nextDelivery = delivery ?? (queuesNewInput ? 'queue' : 'normal')
    const handoff = pendingHandoff
    const quote = quotedMessage
    const requestText = quote ? quoteAgentRequest(quote.text, text) : text
    const displayText = text || (quote ? '인용한 답변에 대해' : '')
    // 미저장 문서 첨부 등을 전송 시점 내용으로 치환한다.
    const outgoingAttachments = onPrepareAttachment
      ? await Promise.all(
          sendAttachments.map(async (attachment) => (await onPrepareAttachment(attachment).catch(() => null)) ?? attachment)
        )
      : sendAttachments
    const result = await window.lt.agent.send(id, {
      text: handoff ? `${handoff.preamble}\n${requestText}` : requestText,
      ...(handoff || quote ? { displayText } : {}),
      ...(quote ? { quote: { messageId: quote.messageId, preview: quote.preview } } : {}),
      attachments: outgoingAttachments,
      permissionMode: nextMode,
      delivery: nextDelivery
    })
    if (!result.ok) {
      setError(result.error ?? 'Agent 요청을 보낼 수 없습니다.')
      setStatus('error')
      return
    }
    if (quote) setQuotedMessage((current) => (current === quote ? null : current))
    if (handoff) {
      setPendingHandoff(null)
      onHandoffConsumed?.()
    }
  }

  const promoteQueuedMessage = async (queueId: string): Promise<void> => {
    setError('')
    const result = await window.lt.agent.promoteQueued(id, queueId)
    if (!result.ok) setError(result.error ?? '대기 중인 지시를 바로 실행할 수 없습니다.')
  }

  const removeQueuedMessage = async (queueId: string): Promise<void> => {
    setError('')
    const result = await window.lt.agent.removeQueued(id, queueId)
    if (!result.ok) setError(result.error ?? '대기 중인 지시를 삭제할 수 없습니다.')
  }

  const openDiffFromItem = useCallback(
    (item: TimelineItem): void => {
      if (!item.diff || !onOpenDiff) return
      onOpenDiff({
        id: item.id,
        title: item.title ?? diffTitle('변경 비교', item.diff.filePath),
        diff: item.diff
      })
    },
    [onOpenDiff]
  )

  const openFileFromItem = useCallback(
    (item: TimelineItem): void => {
      if (!onOpenFile) return
      const path = agentFilePathForApp(item.diff?.filePath ?? item.filePath, cwd, profileId, ssh)
      if (!path) return
      onOpenFile(path, fileNameFromPath(path))
    },
    [cwd, onOpenFile, profileId, ssh]
  )

  const canRevertDiff = (diff: DiffView | undefined): boolean =>
    !!diff?.filePath && (diff.revertEdits?.length ?? 0) > 0

  const revertDiffItem = useCallback(
    async (item: TimelineItem): Promise<void> => {
      if (!item.diff || !canRevertDiff(item.diff)) return
      const path = agentFilePathForApp(item.diff.filePath, cwd, profileId, ssh)
      const edits = item.diff.revertEdits ?? []
      if (!path || edits.length === 0) return
      if (!window.confirm(`${fileNameFromPath(path)} 변경을 되돌릴까요?`)) return

      setRevertingDiffIds((current) => new Set(current).add(item.id))
      setError('')
      try {
        const read = await window.lt.fs.readText(path)
        if (read.kind !== 'text' || read.truncated) {
          throw new Error('텍스트 파일만 자동으로 되돌릴 수 있습니다.')
        }
        let next = read.text
        for (const edit of edits) {
          if (edit.oldString === undefined || edit.newString === undefined || edit.newString.length === 0) {
            throw new Error('자동 되돌리기에 필요한 변경 전후 텍스트가 부족합니다.')
          }
          const index = next.indexOf(edit.newString)
          if (index < 0) throw new Error('현재 파일에서 되돌릴 변경 내용을 찾지 못했습니다.')
          next = `${next.slice(0, index)}${edit.oldString}${next.slice(index + edit.newString.length)}`
        }
        const result = await window.lt.fs.writeText(path, next)
        if (!result.ok) throw new Error(result.error ?? '파일 저장 실패')
        window.dispatchEvent(new CustomEvent(REMOTE_FILE_CHANGED_EVENT, { detail: { paths: [path], caseTabId } }))
        setItems((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, status: 'reverted' } : candidate
          )
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setRevertingDiffIds((current) => {
          const next = new Set(current)
          next.delete(item.id)
          return next
        })
      }
    },
    [cwd, profileId, ssh]
  )

  const resolvePermission = useCallback(
    async (requestId: string, decision: 'allow' | 'reject', remember = false): Promise<void> => {
      setError('')
      const result = await window.lt.agent.approve({ sessionId: id, requestId, decision, remember })
      if (!result.ok) setError(result.error ?? '권한 응답을 보낼 수 없습니다.')
    },
    [id]
  )

  // 권한 요청 대기 중 1/2/3 단축키: 입력 중이 아닐 때(또는 빈 프롬프트에서) 바로 응답한다.
  useEffect(() => {
    if (!visible || !waitingPermission?.requestId) return
    const requestId = waitingPermission.requestId
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '1' && event.key !== '2' && event.key !== '3') return
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const inPrompt = isAgentPromptKeyboardTarget(event.target)
      if (isEditableKeyboardTarget(event.target)) {
        if (!inPrompt) return
        if ((textareaRef.current?.value ?? '').length > 0) return
      }
      event.preventDefault()
      if (event.key === '1') void resolvePermission(requestId, 'allow')
      else if (event.key === '2') void resolvePermission(requestId, 'allow', true)
      else void resolvePermission(requestId, 'reject')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resolvePermission, visible, waitingPermission])

  const toggleDialogChoice = (dialogId: string, question: AgentDialogQuestion, label: string): void => {
    setDialogChoices((current) => {
      const dialog = current[dialogId] ?? {}
      const selected = dialog[question.id] ?? []
      const nextSelected = question.multiSelect
        ? selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label]
        : [label]
      return {
        ...current,
        [dialogId]: {
          ...dialog,
          [question.id]: nextSelected
        }
      }
    })
  }

  const answerDialog = async (
    item: TimelineItem,
    answers?: Record<string, string>,
    response?: string,
    cancelled = false
  ): Promise<void> => {
    if (!item.dialogId) return
    const result = await window.lt.agent.answerDialog({
      sessionId: id,
      dialogId: item.dialogId,
      answers,
      response,
      cancelled
    })
    if (!result.ok) {
      setError(result.error ?? '선택 응답을 보낼 수 없습니다.')
      return
    }
    setDialogChoices((current) => {
      const next = { ...current }
      delete next[item.dialogId!]
      return next
    })
    setDialogResponses((current) => {
      const next = { ...current }
      delete next[item.dialogId!]
      return next
    })
  }

  const answerSingleOption = async (
    item: TimelineItem,
    question: AgentDialogQuestion,
    option: AgentDialogOption
  ): Promise<void> => {
    await answerDialog(item, { [question.question]: option.label })
  }

  const submitDialogChoices = async (item: TimelineItem): Promise<void> => {
    if (!item.dialogId) return
    const questions = item.questions ?? []
    const choices = dialogChoices[item.dialogId] ?? {}
    const answers: Record<string, string> = {}
    for (const question of questions) {
      const selected = choices[question.id] ?? []
      if (selected.length > 0) answers[question.question] = selected.join(', ')
    }
    const response = dialogResponses[item.dialogId]?.trim()
    if (Object.keys(answers).length === 0 && !response) {
      setError('선택하거나 직접 입력한 뒤 전송하세요.')
      return
    }
    setError('')
    await answerDialog(item, answers, response)
  }

  const interrupt = useCallback(async (): Promise<void> => {
    disarmEscInterrupt()
    const result = await window.lt.agent.interrupt(id)
    if (!result.ok) {
      setError(result.error ?? 'Agent 작업을 중지할 수 없습니다.')
      return
    }
    setAuthActive(false)
    setItems((current) => interruptedTimelineItems(current))
    setStatus('idle')
    onStatus?.('done')
  }, [disarmEscInterrupt, id, onStatus])

  useEffect(() => {
    if (!visible || !interruptible) {
      disarmEscInterrupt()
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.repeat) return
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        (isEditableKeyboardTarget(event.target) && !isAgentPromptKeyboardTarget(event.target))
      ) {
        disarmEscInterrupt()
        return
      }
      event.preventDefault()
      if (escInterruptArmedRef.current) {
        void interrupt()
        return
      }
      armEscInterrupt()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [armEscInterrupt, disarmEscInterrupt, interrupt, interruptible, visible])

  const startAuthLogin = async (): Promise<void> => {
    setError('')
    const result = await window.lt.agent.authLogin(id)
    if (!result.ok) setError(result.error ?? `${agentLabel} 로그인을 시작할 수 없습니다.`)
  }

  const sendAuthInput = async (): Promise<void> => {
    const text = authInput
    setAuthInput('')
    const result = await window.lt.agent.authInput(id, text)
    if (!result.ok) setError(result.error ?? `${agentLabel} 로그인 입력을 보낼 수 없습니다.`)
  }

  const loadModelOptions = useCallback(async (): Promise<void> => {
    if (modelLoadStartedRef.current) return
    modelLoadStartedRef.current = true
    setModelLoading(true)
    const result = await window.lt.agent.models(id)
    setModelLoading(false)
    if (!result.ok) {
      modelLoadStartedRef.current = false
      setError(result.error ?? `${agentLabel} 모델 목록을 불러올 수 없습니다.`)
      return
    }
    const models = result.models ?? []
    setModelOptions(models)
    if (models.length === 0) modelLoadStartedRef.current = false
    setSelectedModel(result.selectedModel)
    setSelectedReasoningEffort(result.selectedReasoningEffort)
  }, [agentLabel, id])

  useEffect(() => {
    if (!settingsLoaded || !visible || (usesAgentAuth && authStatus !== 'authenticated')) return
    void loadModelOptions()
  }, [authStatus, loadModelOptions, settingsLoaded, usesAgentAuth, visible])

  const openModelPicker = async (): Promise<void> => {
    setError('')
    setModelPickerOpen(true)
    await loadModelOptions()
  }

  const chooseModel = async (model?: string, reasoningEffort?: string): Promise<void> => {
    const result = await window.lt.agent.setModel(id, model, reasoningEffort)
    if (!result.ok) {
      setError(result.error ?? `${agentLabel} 모델을 선택할 수 없습니다.`)
      return
    }
    setSelectedModel(model)
    setSelectedReasoningEffort(reasoningEffort)
    setModelPickerOpen(false)
    setError('')
    showTransientFeedback(
      model
        ? `${agentLabel} 모델: ${model}${reasoningEffort ? ` / ${reasoningEffort}` : ''}`
        : `${agentLabel} 모델: 기본값`
    )
  }

  const copyAuthCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      setError('인증 코드를 클립보드에 복사할 수 없습니다.')
    }
  }

  const copyPrompt = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      showTransientFeedback('프롬프트 복사됨')
    } catch {
      setError('프롬프트를 클립보드에 복사할 수 없습니다.')
    }
  }

  const copyAssistant = async (markdown: string, mode: AgentCopyMode): Promise<void> => {
    try {
      await copyAgentOutput(markdown, mode)
      const label = mode === 'rich' ? '리치텍스트' : mode === 'markdown' ? 'Markdown 원문' : '일반 텍스트'
      setCopyFeedback(`${label}로 복사됨`)
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 1600)
    } catch {
      setError('출력을 클립보드에 복사할 수 없습니다.')
    }
  }

  const copyCodeBlock = async (code: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyFeedback('코드 복사됨')
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 1200)
      return true
    } catch {
      setError('코드를 클립보드에 복사할 수 없습니다.')
      return false
    }
  }

  const copySelection = (event: ClipboardEvent<HTMLDivElement>): void => {
    const selection = window.getSelection()
    const timeline = scrollRef.current
    if (!selection || selection.isCollapsed || !timeline || !selectionIntersectsElement(selection, timeline)) return
    if (!writeSelectionToClipboard(event.clipboardData, selection)) return
    event.preventDefault()
    setCopyFeedback('선택 영역 복사됨')
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 1200)
  }

  // 답변 드래그 후 우클릭 — 원문(Markdown)/서식 문서/텍스트 복사 메뉴.
  // 선택 내용은 메뉴를 여는 시점에 캡처한다(메뉴 클릭으로 선택이 풀려도 복사 가능).
  const openSelectionMenu = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea') || target.isContentEditable)
    )
      return
    const selection = window.getSelection()
    const timeline = scrollRef.current
    if (!selection || selection.isCollapsed || !timeline || !selectionIntersectsElement(selection, timeline)) return
    const text = selection.toString()
    if (!text.trim()) return
    event.preventDefault()
    setSelectionMenu({
      x: Math.min(event.clientX, window.innerWidth - 240),
      y: Math.min(event.clientY, window.innerHeight - 132),
      html: selectedHtml(selection),
      text
    })
  }

  const copySelectionFromMenu = async (mode: AgentCopyMode): Promise<void> => {
    const menu = selectionMenu
    setSelectionMenu(null)
    if (!menu) return
    try {
      if (mode === 'rich') {
        await writeHtmlPlainClipboard(`<meta charset="utf-8"><div>${menu.html}</div>`, menu.text)
      } else if (mode === 'markdown') {
        await navigator.clipboard.writeText(htmlToMarkdown(menu.html))
      } else {
        await navigator.clipboard.writeText(menu.text)
      }
      showTransientFeedback(
        mode === 'rich' ? '서식 문서로 복사됨' : mode === 'markdown' ? 'Markdown 원문으로 복사됨' : '텍스트로 복사됨'
      )
    } catch {
      setError('선택 영역을 클립보드에 복사할 수 없습니다.')
    }
  }

  const attachableTransfer = (dataTransfer: DataTransfer | null): dataTransfer is DataTransfer =>
    Boolean(
      dataTransfer &&
        (dataTransfer.types.includes(LT_PATH) ||
          dataTransfer.types.includes(LT_PATHS) ||
          dataTransfer.types.includes('Files'))
    )

  const onAttachmentDrag = (event: DragEvent<HTMLDivElement>): void => {
    if (!attachableTransfer(event.dataTransfer) || authActive) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setAttachmentDropOver(true)
  }

  const onAttachmentDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!attachableTransfer(event.dataTransfer) || authActive) return
    event.preventDefault()
    event.stopPropagation()
    setAttachmentDropOver(false)
    addPathAttachments(dataTransferPaths(event.dataTransfer), 'drop')
  }

  const addClipboardImageAttachment = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) {
      setError('클립보드 이미지를 읽을 수 없습니다.')
      return
    }
    const saved = await window.lt.fs.saveClipboardImage(bytes, file.type)
    addPathAttachments([saved.path], 'paste')
  }

  const onAttachmentPaste = (event: ClipboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || authActive) return
    const clipboard = event.clipboardData
    const directPaths = dataTransferPaths(clipboard)
    if (directPaths.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      addPathAttachments(directPaths, 'paste')
      return
    }
    const types = Array.from(clipboard.types)
    const text = clipboard.getData('text/plain')
    if (pathLikeText(text)) {
      event.preventDefault()
      event.stopPropagation()
      addPathAttachments(pathsFromPathLikeText(text), 'paste')
      return
    }
    // 스크린샷 등 경로 없는 비트맵은 paste 이벤트 안에서만 동기적으로 꺼낼 수 있다
    const imageFile =
      Array.from(clipboard.items)
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile() ?? null
    if (!types.some(fileLikeClipboardType)) {
      if (!imageFile) return
      event.preventDefault()
      event.stopPropagation()
      void addClipboardImageAttachment(imageFile).catch((e) =>
        setError(String(e instanceof Error ? e.message : e))
      )
      return
    }
    event.preventDefault()
    event.stopPropagation()
    void window.lt.fs
      .clipboardFiles()
      .then(async (clip) => {
        if (clip.paths.length > 0) {
          addPathAttachments(clip.paths, 'paste')
          return
        }
        if (imageFile) {
          await addClipboardImageAttachment(imageFile)
          return
        }
        setError('클립보드에서 파일 경로를 찾을 수 없습니다.')
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }

  const toggleProcess = (processId: string): void => {
    setExpandedProcessIds((current) => {
      const next = new Set(current)
      if (next.has(processId)) next.delete(processId)
      else next.add(processId)
      return next
    })
  }
  const currentMode = modeLabels.find((option) => option.value === mode) ?? modeLabels[0]
  const authButtonLabel =
    authActive
      ? '로그인 중'
      : authStatus === 'checking'
        ? '확인 중'
        : authStatus === 'authenticated'
          ? '계정 변경'
          : authStatus === 'unavailable'
            ? 'CLI 없음'
            : '로그인'
  const authButtonTitle =
    authStatusMessage ||
    (authStatus === 'authenticated'
      ? `${agentLabel} 계정 변경`
      : authStatus === 'checking'
        ? `${agentLabel} 로그인 상태를 확인하고 있습니다`
        : authStatus === 'unavailable'
          ? `${agentLabel} CLI를 찾을 수 없습니다`
          : `${agentLabel} 로그인`)
  const authButtonDisabled =
    authActive ||
    status === 'working' ||
    authStatus === 'checking' ||
    authStatus === 'unavailable'
  const visibleRateLimits = (usage.rateLimits?.length ? usage.rateLimits : usage.rateLimit ? [usage.rateLimit] : []).filter(
    showRateLimitInBar
  )
  const contextLabel = usage.context
    ? `컨텍스트 ${percentText(usage.context.percentage)} · 잔여 ${tokenCount(usage.context.remainingTokens)}`
    : '컨텍스트 대기'
  const tokensKnown = usage.tokens.updatedAt > 0
  const cacheTokens = cacheTokenTotal(usage.tokens)
  const limitLabels = visibleRateLimits.map((limit) => ({ label: rateLimitLabel(limit), tone: rateLimitTone(limit) }))
  const panelStyle = {
    '--agent-font-size': `${agentFontSize}px`
  } as CSSProperties

  return (
    <div
      className={`agent-panel ${attachmentDropOver ? 'file-drop-target' : ''}`}
      data-visible={visible ? 'true' : 'false'}
      style={panelStyle}
      onDragEnter={onAttachmentDrag}
      onDragOver={onAttachmentDrag}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setAttachmentDropOver(false)
      }}
      onDrop={onAttachmentDrop}
      onPaste={onAttachmentPaste}
    >
      {attachmentDropOver && (
        <div className="drop-guide agent-drop-guide" role="status" aria-live="polite">
          <strong>Agent에 파일 첨부</strong>
          <span>전송 전에 입력창 아래에서 확인할 수 있습니다</span>
        </div>
      )}
      <header className="agent-head">
        <div className="agent-title">
          <span className="agent-title-main">{title}</span>
          <span className="agent-title-sub" title={cwd}>
            {cwd}
          </span>
        </div>
        <div className="agent-head-actions">
          {onFork && (
            <button
              className="agent-icon-btn"
              title="현재 대화 맥락을 새 Agent 세션으로 fork"
              aria-label="Fork"
              onClick={onFork}
            >
              <IconFork />
            </button>
          )}
          {onWorktreeFork && (
            <button
              className="agent-icon-btn"
              disabled={Boolean(ssh)}
              title={
                ssh
                  ? '원격 Agent 탭은 아직 worktree fork를 지원하지 않습니다'
                  : 'Git worktree를 만들고 새 Agent 탭에서 열기'
              }
              aria-label="Worktree Fork"
              onClick={onWorktreeFork}
            >
              <IconWorktree />
            </button>
          )}
          {onOpenTerminal && (
            <button
              className="agent-icon-btn"
              title="터미널로 열기"
              aria-label="터미널로 열기"
              onClick={onOpenTerminal}
            >
              <IconTerminal />
            </button>
          )}
        </div>
      </header>

      <div className="agent-timeline-wrap">
        <div
          className="agent-timeline"
          ref={scrollRef}
          onScroll={updateTimelineFollowState}
          onWheel={markTimelineUserScroll}
          onPointerDown={markTimelineUserScroll}
          onTouchMove={markTimelineUserScroll}
          onKeyDown={markTimelineUserScroll}
          onCopy={copySelection}
          onContextMenu={openSelectionMenu}
        >
          {items.length === 0 && (
            <div className="agent-empty">
              <div className="agent-empty-icon" aria-hidden="true">
                <IconClaude size={30} />
              </div>
              <div className="agent-empty-title">{agentLabel} Agent</div>
              <div className="agent-empty-sub">
                {pendingHandoff
                  ? `이전 대화 ${pendingHandoff.count}개 메시지를 이어받았습니다. 하던 이야기를 그대로 이어서 지시하세요.`
                  : '사건 폴더를 기반으로 검토·정리·초안 작업을 시킬 수 있습니다.'}
              </div>
              <div className="agent-empty-suggestions">
                {emptyStateSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    className="agent-empty-suggestion"
                    title={suggestion.prompt}
                    onClick={() => {
                      resetPromptHistoryCursor()
                      setInput(suggestion.prompt)
                      focusPrompt(suggestion.prompt.length)
                    }}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((item) => {
            if (item.kind === 'process') {
              const steps = item.processSteps ?? []
              return (
                <div key={item.id} className="agent-tools">
                  {steps.map((step) => {
                    const stepKey = `${item.id}:${step.id}`
                    return (
                      <ToolRow
                        key={step.id}
                        step={step}
                        expanded={expandedProcessIds.has(stepKey)}
                        onToggle={() => toggleProcess(stepKey)}
                      />
                    )
                  })}
                </div>
              )
            }
            if (item.kind === 'plan') {
              return (
                <section key={item.id} className="agent-card plan">
                  <div className="agent-card-head">
                    <span>{item.title ?? '계획 제안'}</span>
                  </div>
                  {item.planMarkdown && (
                    <MarkdownMessage text={item.planMarkdown} onCopyCode={copyCodeBlock} />
                  )}
                </section>
              )
            }
            if (item.kind === 'user') {
              const userCopyText = item.text && item.text.trim().length > 0 ? item.text : ''
              return (
                <section key={item.id} className="agent-msg user">
                  <div className="agent-msg-bubble">
                    {item.quote && (
                      <QuoteReference
                        quote={item.quote}
                        onOpen={() => revealQuotedMessage(item.quote!.messageId)}
                      />
                    )}
                    <pre className="agent-card-text">{item.text}</pre>
                    {item.attachments && item.attachments.length > 0 && (
                      <div className="agent-attachments sent" aria-label="전송된 첨부">
                        {item.attachments.map((attachment, index) => {
                          const content = (
                            <>
                              <span className="agent-attachment-kind">
                                {attachmentKindLabel(attachment.kind)}
                              </span>
                              <span className="agent-attachment-label">{attachment.label}</span>
                            </>
                          )
                          return canOpenAttachmentSource(attachment) ? (
                            <button
                              key={`${attachment.path ?? attachment.label}-${index}`}
                              type="button"
                              className="agent-attachment-chip"
                              title={`${attachmentTitle(attachment)}\n\n클릭하면 원문 위치로 이동합니다`}
                              onClick={() => onOpenAttachmentSource?.(attachment)}
                            >
                              {content}
                            </button>
                          ) : (
                            <span
                              key={`${attachment.path ?? attachment.label}-${index}`}
                              className="agent-attachment-chip"
                              title={attachmentTitle(attachment)}
                            >
                              {content}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="agent-msg-tools" aria-label="메시지 작업">
                    {userCopyText && (
                      <button type="button" title="프롬프트 복사" onClick={() => void copyPrompt(userCopyText)}>
                        복사
                      </button>
                    )}
                  </div>
                </section>
              )
            }
            if (item.kind === 'assistant') {
              const cancelled = item.status === 'cancelled' || item.status === 'canceled'
              return (
                <section
                  key={item.id}
                  id={`agent-message-${id}-${item.id}`}
                  className={`agent-msg assistant ${item.status ?? ''}`}
                >
                  {item.text && (
                    <MarkdownMessage
                      text={item.text}
                      streaming={item.status === 'streaming'}
                      onCopyCode={copyCodeBlock}
                    />
                  )}
                  {cancelled && <div className="agent-msg-cancelled">중지됨</div>}
                  {item.text && item.status !== 'streaming' && (
                    <div className="agent-msg-tools" aria-label="출력 작업">
                      <button
                        type="button"
                        title="선택한 부분 또는 이 답변 전체를 인용해 지시"
                        onClick={() => {
                          const source = document.getElementById(`agent-message-${id}-${item.id}`)
                          const selection = window.getSelection()
                          const selected =
                            source &&
                            selection &&
                            !selection.isCollapsed &&
                            selectionIntersectsElement(selection, source)
                              ? selection.toString().trim()
                              : ''
                          const text = selected || item.text!
                          setQuotedMessage({
                            messageId: item.id,
                            preview: quotePreview(text),
                            text
                          })
                          focusPrompt()
                        }}
                      >
                        인용
                      </button>
                      <button
                        type="button"
                        title="리치텍스트로 복사"
                        onClick={() => void copyAssistant(item.text!, 'rich')}
                      >
                        복사
                      </button>
                      <button
                        type="button"
                        title="Markdown 원문으로 복사"
                        onClick={() => void copyAssistant(item.text!, 'markdown')}
                      >
                        MD
                      </button>
                      <button
                        type="button"
                        title="일반 텍스트로 복사"
                        onClick={() => void copyAssistant(item.text!, 'text')}
                      >
                        텍스트
                      </button>
                    </div>
                  )}
                </section>
              )
            }
            if (item.kind === 'dialog') {
            const questions = item.questions ?? []
            const dialogId = item.dialogId ?? item.id
            const waiting = item.status === 'waiting'
            const choices = dialogChoices[dialogId] ?? {}
            const directResponse = dialogResponses[dialogId] ?? ''
            const quickAnswer = waiting && questions.length === 1 && questions[0]?.multiSelect !== true
            return (
              <section key={item.id} className={`agent-card dialog ${item.status ?? ''}`}>
                <div className="agent-card-head">
                  <span>{item.title ?? `${agentLabel} 질문`}</span>
                  {item.status && <span className="agent-card-status">{item.status}</span>}
                </div>
                <div className="agent-question-list">
                  {questions.map((question) => (
                    <div key={question.id} className="agent-question">
                      <div className="agent-question-head">
                        {question.header && <span>{question.header}</span>}
                        <strong>{question.question}</strong>
                      </div>
                      <div className="agent-option-grid">
                        {question.options.map((option) => {
                          const selected = (choices[question.id] ?? []).includes(option.label)
                          return (
                            <button
                              key={option.id}
                              type="button"
                              className={`agent-option ${selected ? 'selected' : ''}`}
                              disabled={!waiting}
                              onClick={() =>
                                quickAnswer
                                  ? void answerSingleOption(item, question, option)
                                  : toggleDialogChoice(dialogId, question, option.label)
                              }
                            >
                              <span>{option.label}</span>
                              {option.description && <small>{option.description}</small>}
                              {option.preview && <pre>{option.preview}</pre>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {item.answers && (
                  <pre className="agent-card-input">
                    {Object.entries(item.answers)
                      .map(([question, answer]) => `${question}: ${answer}`)
                      .join('\n')}
                  </pre>
                )}
                {waiting && (
                  <>
                    <input
                      className="agent-question-freeform"
                      value={directResponse}
                      placeholder="직접 입력"
                      onChange={(e) =>
                        setDialogResponses((current) => ({
                          ...current,
                          [dialogId]: e.target.value
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        void submitDialogChoices(item)
                      }}
                    />
                    <div className="agent-card-actions agent-dialog-actions">
                      <button onClick={() => void submitDialogChoices(item)}>선택 전송</button>
                      <button onClick={() => void answerDialog(item, undefined, undefined, true)}>
                        취소
                      </button>
                    </div>
                  </>
                )}
              </section>
            )
          }
          const cardStatus = timelineStatusLabel(item)
          const waitingQueue = isWaitingQueueItem(item)
          const revertingDiff = revertingDiffIds.has(item.id)
          const showRevertDiff = item.kind === 'diff' && item.status === 'applied' && canRevertDiff(item.diff)
          const showOpenChangedFile =
            item.kind === 'diff' && !!onOpenFile && !!(item.diff?.filePath ?? item.filePath)
          const promptCopyText =
            item.kind === 'queue' && item.text && item.text.trim().length > 0 ? item.text : ''
          const diffToggleKey = `diff:${item.id}`
          if (item.kind === 'diff' && !expandedProcessIds.has(diffToggleKey)) {
            const dotStatus =
              item.status === 'applied' ? 'done' : item.status === 'reverted' ? 'cancelled' : ''
            return (
              <div key={item.id} className="agent-tools">
                <div className={`agent-tool-row diff ${item.status ?? ''}`}>
                  <button
                    type="button"
                    className="agent-tool-line"
                    aria-expanded={false}
                    title={item.diff?.filePath ?? item.filePath ?? item.title}
                    onClick={() => toggleProcess(diffToggleKey)}
                  >
                    <span className={`agent-tool-dot ${dotStatus}`} aria-hidden="true" />
                    <span className="agent-tool-name">{item.title}</span>
                    {item.diff && (
                      <span className="agent-diff-head-counts" aria-hidden="true">
                        <span className="agent-diff-count add">+{item.diff.additions}</span>
                        <span className="agent-diff-count remove">-{item.diff.deletions}</span>
                      </span>
                    )}
                    <span className="agent-tool-meta">
                      {item.status === 'reverted' && <span className="agent-tool-flag">되돌림</span>}
                      <span className="agent-process-chevron" aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            )
          }
          return (
            <section key={item.id} className={`agent-card ${item.kind} ${item.status ?? ''}`}>
              <div className="agent-card-head">
                {item.kind === 'diff' ? (
                  <button
                    type="button"
                    className="agent-card-head-toggle"
                    aria-expanded={true}
                    onClick={() => toggleProcess(diffToggleKey)}
                  >
                    <span className="agent-process-chevron expanded" aria-hidden="true">
                      ›
                    </span>
                    <span>{item.title}</span>
                  </button>
                ) : (
                  <span>{item.title}</span>
                )}
                <span className="agent-card-head-right">
                  {item.kind === 'diff' && item.diff && (
                    <span className="agent-diff-head-counts" aria-hidden="true">
                      <span className="agent-diff-count add">+{item.diff.additions}</span>
                      <span className="agent-diff-count remove">-{item.diff.deletions}</span>
                    </span>
                  )}
                  {promptCopyText && (
                    <span className="agent-copy-actions" aria-label="프롬프트 복사">
                      <button
                        type="button"
                        title="프롬프트 복사"
                        onClick={() => void copyPrompt(promptCopyText)}
                      >
                        복사
                      </button>
                    </span>
                  )}
                  {waitingQueue && item.queueId && (
                    <span className="agent-queue-actions" aria-label="대기 중인 지시 작업">
                      <button
                        type="button"
                        onClick={() => void promoteQueuedMessage(item.queueId!)}
                      >
                        바로 지시하기
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void removeQueuedMessage(item.queueId!)}
                      >
                        삭제
                      </button>
                    </span>
                  )}
                  {cardStatus && <span className="agent-card-status">{cardStatus}</span>}
                </span>
              </div>
              {item.quote && (
                <QuoteReference
                  quote={item.quote}
                  onOpen={() => revealQuotedMessage(item.quote!.messageId)}
                />
              )}
              {item.kind === 'diff' &&
                (Boolean(item.diff && onOpenDiff) || showOpenChangedFile || showRevertDiff) && (
                <div className="agent-card-actions">
                  {item.diff && onOpenDiff && (
                    <button
                      type="button"
                      title="변경 전후 비교를 문서 탭에서 열기"
                      onClick={() => openDiffFromItem(item)}
                    >
                      비교 보기
                    </button>
                  )}
                  {showOpenChangedFile && (
                    <button
                      type="button"
                      title="변경된 문서를 문서 탭에서 열기"
                      onClick={() => openFileFromItem(item)}
                    >
                      문서 열기
                    </button>
                  )}
                  {showRevertDiff && (
                    <button
                      type="button"
                      className="danger"
                      disabled={revertingDiff}
                      title="이 변경을 적용 전 텍스트로 되돌리기"
                      onClick={() => void revertDiffItem(item)}
                    >
                      {revertingDiff ? '되돌리는 중' : '되돌리기'}
                    </button>
                  )}
                </div>
              )}
              {item.kind === 'diff' && item.diff && (
                <DiffPreview
                  diff={item.diff}
                  alwaysExpanded={item.diff.additions + item.diff.deletions <= 40}
                />
              )}
              {item.kind === 'diff' && !item.diff && item.text && (
                <pre className="agent-card-text">{item.text}</pre>
              )}
              {item.kind !== 'diff' && item.text && <pre className="agent-card-text">{item.text}</pre>}
              {item.kind === 'permission' && item.planMarkdown && (
                <MarkdownMessage text={item.planMarkdown} onCopyCode={copyCodeBlock} />
              )}
              {item.kind === 'permission' && !item.planMarkdown && item.diff && (
                <DiffPreview
                  diff={item.diff}
                  alwaysExpanded={item.diff.additions + item.diff.deletions <= 40}
                />
              )}
              {item.inputPreview && !(item.kind === 'permission' && (item.diff || item.planMarkdown)) && (
                <InputPreview text={item.inputPreview} />
              )}
              {item.attachments && item.attachments.length > 0 && (
                <div className="agent-attachments sent" aria-label="전송된 첨부">
                  {item.attachments.map((attachment, index) => {
                    const content = (
                      <>
                        <span className="agent-attachment-kind">{attachmentKindLabel(attachment.kind)}</span>
                        <span className="agent-attachment-label">
                          {attachment.label}
                        </span>
                      </>
                    )
                    return canOpenAttachmentSource(attachment) ? (
                      <button
                        key={`${attachment.path ?? attachment.label}-${index}`}
                        type="button"
                        className="agent-attachment-chip"
                        title={`${attachmentTitle(attachment)}\n\n클릭하면 원문 위치로 이동합니다`}
                        onClick={() => onOpenAttachmentSource?.(attachment)}
                      >
                        {content}
                      </button>
                    ) : (
                      <span
                        key={`${attachment.path ?? attachment.label}-${index}`}
                        className="agent-attachment-chip"
                        title={attachmentTitle(attachment)}
                      >
                        {content}
                      </span>
                    )
                  })}
                </div>
              )}
              {item.kind === 'auth' && item.urls && item.urls.length > 0 && (
                <div className="agent-card-actions">
                  {item.urls.map((url) => (
                    <button key={url} onClick={() => void window.lt.app.openExternal(url)}>
                      인증 창 열기
                    </button>
                  ))}
                </div>
              )}
              {item.kind === 'auth' && item.codes && item.codes.length > 0 && (
                <div className="agent-auth-codes">
                  {item.codes.map((code) => (
                    <button key={code} onClick={() => void copyAuthCode(code)}>
                      코드 복사 · {code}
                    </button>
                  ))}
                </div>
              )}
              {item.kind === 'permission' && item.requestId && item.status !== 'resolved' && (
                <div className="agent-card-actions agent-permission-actions">
                  <button
                    disabled={item.status !== 'waiting'}
                    onClick={() => void resolvePermission(item.requestId!, 'allow')}
                  >
                    허용 <kbd>1</kbd>
                  </button>
                  <button
                    disabled={item.status !== 'waiting'}
                    title={
                      item.toolName
                        ? `이 세션에서 ${toolDisplayName(item.toolName)}(${item.toolName}) 도구를 다시 묻지 않고 허용합니다`
                        : '이 세션에서 같은 요청을 다시 묻지 않습니다'
                    }
                    onClick={() => void resolvePermission(item.requestId!, 'allow', true)}
                  >
                    {item.toolName ? `${toolDisplayName(item.toolName)} 항상 허용` : '항상 허용'} <kbd>2</kbd>
                  </button>
                  <button
                    disabled={item.status !== 'waiting'}
                    className="danger"
                    onClick={() => void resolvePermission(item.requestId!, 'reject')}
                  >
                    거절 <kbd>3</kbd>
                  </button>
                </div>
              )}
              {item.decision && <div className="agent-decision">{item.decision === 'allow' ? '허용됨' : '거절됨'}</div>}
            </section>
          )
        })}
        </div>
        {showNewOutputNotice && (
          <button
            type="button"
            className="agent-new-output-button"
            title="맨 아래로 이동"
            aria-label={latestOutputPreview ? `새 응답: ${latestOutputPreview}. 맨 아래로 이동` : '새 응답으로 이동'}
            onClick={scrollTimelineToBottom}
          >
            <span className="agent-new-output-arrow" aria-hidden="true">↓</span>
            <span className="agent-new-output-text">
              {latestOutputPreview ? `새 응답 · ${latestOutputPreview}` : '새 응답'}
            </span>
          </button>
        )}
      </div>

      {authCliUnavailable && (
        <div className="agent-auth-banner unavailable">
          <span>
            {usesClaudeRemoteAuth
              ? '원격 서버에서 Claude Code CLI를 찾을 수 없습니다. 원격 터미널에서 설치한 뒤 Agent를 다시 여세요.'
              : 'Codex CLI를 찾을 수 없습니다. Codex CLI를 설치한 뒤 Agent를 다시 여세요.'}
          </span>
          {onOpenTerminal && (
            <button onClick={onOpenTerminal}>
              터미널 열기
            </button>
          )}
        </div>
      )}
      {!authCliUnavailable && (needsAuth || needsLogin || authChecking) && authStatus !== 'authenticated' && (
        <div className="agent-auth-banner">
          <span>
            {authChecking ? `${agentLabel} 상태를 확인하고 있습니다.` : `${agentLabel} 로그인이 필요합니다.`}
          </span>
          <button disabled={authButtonDisabled} onClick={() => void startAuthLogin()}>
            {authButtonLabel === '로그인' ? '로그인 시작' : authButtonLabel}
          </button>
        </div>
      )}
      {modelPickerOpen && (
        <div className="agent-model-picker">
          <div className="agent-model-picker-head">
            <span>{agentLabel} 모델</span>
            <button type="button" onClick={() => setModelPickerOpen(false)}>닫기</button>
          </div>
          <div className="agent-model-current">
            현재 {currentModel.modelLabel}
            {currentModel.effort ? ` · 추론 정도 ${currentModel.effort}` : ''}
          </div>
          {modelLoading ? (
            <div className="agent-model-loading">모델 목록 로드 중</div>
          ) : (
            <div className="agent-model-list">
              <button
                type="button"
                className={`agent-model-default ${!selectedModel ? 'selected' : ''}`}
                onClick={() => void chooseModel(undefined, undefined)}
              >
                <span>기본값</span>
                <small>{agentLabel} 설정과 계정에 맞는 기본 모델</small>
              </button>
              {modelOptions.map((model) => {
                const efforts = model.supportedReasoningEfforts ?? []
                return (
                  <div
                    key={model.id}
                    className={`agent-model-item ${selectedModel === model.model ? 'selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="agent-model-main"
                      onClick={() => void chooseModel(model.model, model.defaultReasoningEffort)}
                    >
                      <span>{model.displayName}</span>
                      <small>{model.description || model.model}</small>
                    </button>
                    {efforts.length > 0 && (
                      <div className="agent-model-efforts" aria-label={`${model.displayName} 추론 정도`}>
                        {efforts.map((effort) => (
                          <button
                            key={effort.reasoningEffort}
                            type="button"
                            className={
                              selectedModel === model.model &&
                              selectedReasoningEffort === effort.reasoningEffort
                                ? 'selected'
                                : ''
                            }
                            title={effort.description || `${model.displayName} ${effort.reasoningEffort}`}
                            onClick={() => void chooseModel(model.model, effort.reasoningEffort)}
                          >
                            {effort.reasoningEffort}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {modelOptions.length === 0 && <span className="muted small">선택 가능한 모델이 없습니다.</span>}
            </div>
          )}
        </div>
      )}
      {error && <div className="agent-error">{error}</div>}
      {copyFeedback && <div className="agent-copy-feedback">{copyFeedback}</div>}
      {selectionMenu && (
        <div
          className="tab-context-menu"
          role="menu"
          aria-label="선택 영역 복사"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="tab-context-menu-item"
            role="menuitem"
            title="Markdown 원문으로 복사"
            onClick={() => void copySelectionFromMenu('markdown')}
          >
            <span>원문 복사 (Markdown)</span>
          </button>
          <button
            className="tab-context-menu-item"
            role="menuitem"
            title="서식을 유지한 채 복사 — 한글·워드에 붙여넣기"
            onClick={() => void copySelectionFromMenu('rich')}
          >
            <span>서식 문서로 복사</span>
          </button>
          <button
            className="tab-context-menu-item"
            role="menuitem"
            title="서식 없는 일반 텍스트로 복사"
            onClick={() => void copySelectionFromMenu('text')}
          >
            <span>텍스트로 복사 (txt)</span>
          </button>
        </div>
      )}

      <footer className="agent-prompt">
        {showSlashMenu && (
          <div ref={slashMenuRef} className="agent-slash-menu" role="listbox" aria-label="Slash commands">
            {slashMenuRows.map((row) => {
              if (row.kind === 'heading') {
                return (
                  <div key={row.label} className="agent-slash-heading">
                    {row.label}
                  </div>
                )
              }
              const command = row.command
              const terminalOnly = isTerminalOnlySlashCommand(command, provider)
              return (
                <button
                  key={command.name}
                  type="button"
                  id={`agent-slash-${id}-${row.index}`}
                  className={`agent-slash-item ${terminalOnly ? 'terminal-only' : ''} ${row.index === slashIndex ? 'active' : ''}`}
                  data-active={row.index === slashIndex ? 'true' : undefined}
                  role="option"
                  aria-selected={row.index === slashIndex}
                  title={`${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySlashCommand(command)
                  }}
                >
                  <span className="agent-slash-command">{command.name}</span>
                  <span className="agent-slash-detail">
                    <span className="agent-slash-label-row">
                      <span className="agent-slash-label">{command.label}</span>
                      <span className={`agent-slash-surface ${terminalOnly ? 'terminal-only' : 'panel'}`}>
                        {slashCommandSurfaceLabel(command, provider)}
                      </span>
                    </span>
                    <span className="agent-slash-desc">{runtimeSlashCommandDescription(command)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {showMentionMenu && mentionState && (
          <div ref={mentionMenuRef} className="agent-mention-menu" role="listbox" aria-label="파일 멘션">
            <div className="agent-slash-heading">파일 첨부 · @{mentionState.query}</div>
            {mentionEntries.map((entry, index) => (
              <button
                key={entry.absPath}
                type="button"
                className={`agent-mention-item ${index === mentionIndex ? 'active' : ''}`}
                data-active={index === mentionIndex ? 'true' : undefined}
                role="option"
                aria-selected={index === mentionIndex}
                title={entry.relPath}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyMentionEntry(entry)
                }}
              >
                <span className="agent-mention-kind">{entry.isDir ? '폴더' : '파일'}</span>
                <span className="agent-mention-name">{entry.name}</span>
                <span className="agent-mention-path">{entry.relPath}</span>
              </button>
            ))}
          </div>
        )}
        {authActive && (
          <div className="agent-auth-input">
            <input
              value={authInput}
              placeholder="인증 화면이 요구한 입력"
              onChange={(e) => setAuthInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void sendAuthInput()
              }}
            />
            <button onClick={() => void sendAuthInput()}>입력 전송</button>
          </div>
        )}
        {(queuesNewInput || authActive) && (
          <div
            className={`agent-status-line ${status}${escInterruptArmed ? ' esc-armed' : ''}`}
            aria-live="polite"
            aria-label={statusAccessibleLabel}
          >
            <span className="agent-status-spinner" aria-hidden="true" />
            <span className="agent-status-text">
              {authActive ? `${agentLabel} 로그인 진행 중` : baseStatusLabel}
              {queuesNewInput && elapsedSeconds > 0 && ` · ${formatElapsedSeconds(elapsedSeconds)}`}
            </span>
            {!authActive && runningToolLabel && (
              <span className="agent-status-tool" title={runningToolLabel}>
                {runningToolLabel}
              </span>
            )}
            {queuedCount > 0 && <span className="agent-status-queue">대기 {queuedCount}</span>}
            <span className="agent-status-hint">
              {escInterruptArmed ? 'Esc 한 번 더 누르면 중지' : 'Esc 두 번으로 중지'}
            </span>
          </div>
        )}
        {pendingHandoff && (
          <div className="agent-handoff-notice" role="status">
            <span>
              이전 대화 {pendingHandoff.count}개 메시지를 이어받았습니다 — 첫 지시와 함께 전달됩니다
            </span>
            <button
              type="button"
              title="이어받은 맥락을 버리고 빈 세션으로 시작"
              aria-label="이어받은 맥락 버리기"
              onClick={() => {
                setPendingHandoff(null)
                onHandoffConsumed?.()
              }}
            >
              ×
            </button>
          </div>
        )}
        <div className="agent-composer">
          {quotedMessage && (
            <QuoteReference
              quote={quotedMessage}
              onOpen={() => revealQuotedMessage(quotedMessage.messageId)}
              onRemove={() => setQuotedMessage(null)}
            />
          )}
          <textarea
          ref={textareaRef}
          value={input}
          disabled={authActive}
          placeholder={authActive ? `${agentLabel} 로그인 진행 중` : `${agentLabel}에게 요청 · @로 파일 첨부, /로 명령`}
          onChange={(e) => {
            setInput(e.target.value)
            updateMentionFromTextarea(e.currentTarget)
          }}
          onSelect={(e) => updateMentionFromTextarea(e.currentTarget)}
          onPaste={onAttachmentPaste}
          onKeyDown={(e) => {
            if (authActive) return
            if (e.nativeEvent.isComposing) return
            const noModifiers = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
            if (showMentionMenu && noModifiers && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const direction = e.key === 'ArrowDown' ? 1 : -1
              setMentionIndex((current) => (current + direction + mentionEntries.length) % mentionEntries.length)
              return
            }
            if (showMentionMenu && (e.key === 'Tab' || e.key === 'Enter')) {
              e.preventDefault()
              const entry = mentionEntries[mentionIndex]
              if (entry) applyMentionEntry(entry)
              return
            }
            if (showMentionMenu && e.key === 'Escape') {
              e.preventDefault()
              setMentionState(null)
              return
            }
            if (showSlashMenu && noModifiers && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const direction = e.key === 'ArrowDown' ? 1 : -1
              setSlashIndex((current) => (current + direction + slashMatches.length) % slashMatches.length)
              return
            }
            if (showSlashMenu && (e.key === 'Tab' || (e.key === 'Enter' && slashToken !== slashMatches[slashIndex]?.name))) {
              e.preventDefault()
              const command = slashMatches[slashIndex]
              if (command) applySlashCommand(command)
              return
            }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && noModifiers) {
              const textarea = e.currentTarget
              const direction = e.key === 'ArrowUp' ? -1 : 1
              if (
                (direction === -1 && textarea.selectionStart === 0 && textarea.selectionEnd === 0) ||
                (direction === 1 && promptHistoryIndexRef.current !== null && caretOnLastVisualLine(textarea))
              ) {
                if (recallPromptHistory(direction)) e.preventDefault()
              }
              return
            }
            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            void send()
          }}
        />
        {attachments.length > 0 && (
          <div className="agent-attachments pending" aria-label="첨부 파일">
            {attachments.map((attachment, index) => (
              <span
                key={`${attachment.path ?? attachment.label}-${index}`}
                className="agent-attachment-pending"
              >
                <button
                  type="button"
                  className="agent-attachment-chip insertable"
                  title={`${attachmentTitle(attachment)}\n\n${
                    canOpenAttachmentSource(attachment)
                      ? '클릭하면 원문 위치로 이동합니다'
                      : '클릭하면 프롬프트에 넣습니다'
                  }`}
                  onClick={() => {
                    if (canOpenAttachmentSource(attachment)) {
                      onOpenAttachmentSource?.(attachment)
                      return
                    }
                    insertAttachmentReference(attachment)
                  }}
                >
                  <span className="agent-attachment-kind">{attachmentKindLabel(attachment.kind)}</span>
                  <span className="agent-attachment-label">{attachment.label}</span>
                </button>
                <button
                  type="button"
                  className="agent-attachment-remove-button"
                  title="첨부 제거"
                  aria-label={`${attachment.label} 첨부 제거`}
                  onClick={() => removeAttachment(index)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="agent-composer-bar">
          <div className="agent-composer-left">
            <button
              type="button"
              className="agent-icon-btn agent-mention-btn"
              title="@로 파일·폴더 첨부"
              aria-label="파일 멘션"
              disabled={authActive}
              onClick={insertMentionTrigger}
            >
              <IconMention size={14} />
            </button>
            <div className="agent-mode-menu" ref={modeMenuRef}>
              <button
                type="button"
                className={`agent-mode-trigger ${modeMenuOpen ? 'active' : ''}`}
                title={currentMode.title}
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                onClick={() => setModeMenuOpen((open) => !open)}
              >
                {currentMode.label}
                <span className="agent-mode-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {modeMenuOpen && (
                <div className="agent-mode-popover" role="menu">
                  {modeLabels.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={mode === option.value ? 'active' : ''}
                      title={option.title}
                      role="menuitemradio"
                      aria-checked={mode === option.value}
                      onClick={() => {
                        selectPermissionMode(option.value)
                        setModeMenuOpen(false)
                      }}
                    >
                      <span>{option.label}</span>
                      <small>{option.title}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <select
              className="agent-provider-select"
              value={provider}
              disabled={queuesNewInput || authActive}
              title="이 탭에서 사용할 AI"
              onChange={(e) =>
                onProviderChange?.(
                  e.currentTarget.value as AgentProvider,
                  providerHandoffFromTimeline(items)
                )
              }
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <button
              type="button"
              className="agent-auth-btn agent-model-btn"
              disabled={authActive || queuesNewInput || (usesAgentAuth && authStatus !== 'authenticated')}
              title={`현재 모델: ${currentModel.modelLabel}${currentModel.effort ? ` / 추론 정도: ${currentModel.effort}` : ''}`}
              onClick={() => void openModelPicker()}
            >
              {modelButtonLabel}
            </button>
            {usesAgentAuth && (
              <button
                className="agent-auth-btn"
                disabled={authButtonDisabled}
                title={authButtonTitle}
                onClick={() => void startAuthLogin()}
              >
                {authButtonLabel}
              </button>
            )}
          </div>
          <div className="agent-composer-right">
            {queuesNewInput ? (
              <>
                <button
                  disabled={!canSubmit}
                  title="작업을 멈추지 않고 즉시 방향을 바꿉니다"
                  onClick={() => void send('steer')}
                >
                  바로 지시
                </button>
                <button
                  className="agent-send-btn"
                  disabled={!canSubmit}
                  title="Enter로도 대기열에 넣습니다"
                  onClick={() => void send('queue')}
                >
                  대기열 <IconSend size={13} />
                </button>
                <button
                  className={stopButtonClassName}
                  title={stopButtonTitle}
                  aria-label="작업 중지"
                  onClick={() => void interrupt()}
                >
                  <IconStop size={13} /> 중지
                </button>
              </>
            ) : authActive ? (
              <button
                className={stopButtonClassName}
                title={stopButtonTitle}
                aria-label="로그인 중지"
                onClick={() => void interrupt()}
              >
                <IconStop size={13} /> 중지
              </button>
            ) : (
              <button
                className="agent-send-btn"
                disabled={!canSubmit}
                title="전송 (Enter)"
                onClick={() => void send()}
              >
                전송 <IconSend size={13} />
              </button>
            )}
          </div>
        </div>
        </div>
        <div
          className="agent-usage-bar"
          title={usageTitle(usage, provider)}
          aria-live="polite"
        >
          <span>
            토큰 <strong>{tokenCount(tokensKnown ? usage.tokens.totalTokens : undefined)}</strong>
            {tokensKnown && usage.tokens.lastTurnTokens !== undefined && (
              <span className="agent-usage-muted"> 마지막 {tokenCount(usage.tokens.lastTurnTokens)}</span>
            )}
          </span>
          <span>입력 {tokenCount(tokensKnown ? usage.tokens.inputTokens : undefined)}</span>
          <span>출력 {tokenCount(tokensKnown ? usage.tokens.outputTokens : undefined)}</span>
          {tokensKnown && cacheTokens > 0 && <span>캐시 {tokenCount(cacheTokens)}</span>}
          <span>{contextLabel}</span>
          {limitLabels.length > 0 &&
            limitLabels.map(({ label, tone }) => <span key={label} className={tone}>{label}</span>)}
          {provider === 'codex' && usage.tokens.totalCostUsd !== undefined && (
            <span>{costFormatter.format(usage.tokens.totalCostUsd)}</span>
          )}
        </div>
      </footer>
    </div>
  )
}
