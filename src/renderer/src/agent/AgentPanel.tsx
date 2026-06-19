import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type MouseEvent
} from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { LT_PATH, LT_PATHS, readLtPaths } from '../filetree/FileTree'
import type {
  AgentAttachment,
  AgentEvent,
  AgentPermissionMode,
  AppSettings,
  SessionTranscript,
  SshConn
} from '../env'

type AgentRunStatus = 'working' | 'done' | 'question'
type AgentSendDelivery = 'normal' | 'queue' | 'steer'
type AgentCopyMode = 'rich' | 'markdown' | 'text'
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
const DIFF_FALLBACK_LINE_LIMIT = 10
const DIFF_FALLBACK_TEXT_LIMIT = 6000
const REMOTE_FILE_CHANGED_EVENT = 'lt:remote-file-changed'
const ESC_INTERRUPT_ARM_MS = 2000

const clampAgentFontSize = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AGENT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)))
}

const isTimelineNearBottom = (timeline: HTMLDivElement): boolean =>
  timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= TIMELINE_BOTTOM_THRESHOLD

interface AgentPanelProps {
  id: string
  cwd: string
  title: string
  resumeSessionId?: string
  ssh?: SshConn
  profileId?: string
  caseTabId?: string
  visible: boolean
  focusNonce?: number
  attachmentRequests?: AgentAttachmentRequest[]
  onAttachmentRequestsHandled?: (requestIds: string[]) => void
  onStatus?: (status: AgentRunStatus) => void
  onFork?: () => void
  onWorktreeFork?: () => void
  onOpenTerminal?: () => void
  onOpenDiff?: (request: AgentDiffOpenRequest) => void
  onOpenFile?: (path: string, title?: string) => void
}

export interface AgentAttachmentRequest {
  id: string
  attachment: AgentAttachment
  focusPrompt?: boolean
  inputText?: string
}

interface TimelineItem {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'permission' | 'diff' | 'error' | 'auth' | 'process' | 'queue' | 'dialog'
  title?: string
  text?: string
  diff?: DiffView
  attachments?: AgentAttachment[]
  status?: string
  filePath?: string
  requestId?: string
  dialogId?: string
  questions?: AgentDialogQuestion[]
  answers?: Record<string, string>
  queueId?: string
  inputPreview?: string
  decision?: 'allow' | 'reject'
  urls?: string[]
  codes?: string[]
  processSteps?: ProcessStep[]
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

interface ProcessStep {
  id: string
  title: string
  text?: string
  status?: string
}

interface DiffEdit {
  oldString?: string
  newString?: string
}

interface DiffPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface DiffRow {
  kind: 'context' | 'change' | 'remove' | 'add'
  beforeNo?: number
  afterNo?: number
  before?: string
  after?: string
}

interface DiffHunkView {
  label?: string
  oldStart?: number
  newStart?: number
  rows: DiffRow[]
}

export interface DiffView {
  filePath?: string
  hunks: DiffHunkView[]
  additions: number
  deletions: number
  revertEdits?: DiffEdit[]
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

interface AgentRateLimitUsageView {
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  utilization?: number
  remainingPercent?: number
  resetsAt?: number
  isUsingOverage?: boolean
  updatedAt: number
}

interface AgentUsageView {
  tokens: AgentTokenUsageView
  context?: AgentContextUsageView
  rateLimit?: AgentRateLimitUsageView
}

interface SlashCommand {
  name: string
  label: string
  description: string
  mode?: AgentPermissionMode
  argumentHint?: string
  aliases?: string[]
  source?: 'app' | 'claude'
  expand?: (rest: string) => string
}

const modeLabels: { value: AgentPermissionMode; label: string; title: string }[] = [
  { value: 'ask', label: '확인', title: '편집과 명령 실행을 확인합니다' },
  { value: 'plan', label: '계획', title: '실행 전 계획을 먼저 봅니다' },
  { value: 'acceptEdits', label: '편집 자동', title: '파일 편집은 자동 허용합니다' },
  { value: 'bypassPermissions', label: '자동 허용', title: '모든 권한 요청을 자동 허용합니다' },
  { value: 'dontAsk', label: '거절', title: '승인되지 않은 작업을 거절합니다' }
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
    description: '사용 가능한 도구와 연결 상태를 점검합니다',
    expand: (rest) =>
      withSlashRest('현재 사용 가능한 MCP, 도구, 연결 상태를 확인하고 작업에 쓸 수 있는 항목을 정리하세요.', rest)
  },
  {
    name: '/plugins',
    label: '플러그인',
    description: 'Claude Code 플러그인 상태를 확인합니다',
    expand: (rest) =>
      withSlashRest('현재 Claude Code 플러그인과 스킬 상태를 확인하고 필요한 활성화 또는 설치 후보를 정리하세요.', rest)
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

const agentStatusLabels: Record<AgentPanelStatus, string> = {
  idle: '대기',
  working: '작업 중',
  waiting_permission: '권한 확인 대기',
  waiting_user: '응답 대기',
  done: '완료',
  error: '오류'
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

function expandSlashInput(text: string): { text: string; mode?: AgentPermissionMode } {
  const match = text.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return { text }
  const command = slashCommands.find((item) => item.name === match[1].toLowerCase())
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
  return description || 'Claude Code 명령'
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
    if (!merged.has(key)) merged.set(key, command)
  }
  return [...merged.values()]
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const recordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : []

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

const resetTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit'
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

function percentText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

function rateLimitTypeLabel(value: string | undefined): string {
  if (value === 'five_hour') return '5시간 한도'
  if (value === 'seven_day') return '7일 한도'
  if (value === 'seven_day_opus') return '7일 Opus'
  if (value === 'seven_day_sonnet') return '7일 Sonnet'
  if (value === 'overage') return '초과 사용'
  return '한도'
}

function resetTimeText(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return resetTimeFormatter.format(new Date(value))
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

function usageTitle(usage: AgentUsageView): string {
  const tokens = usage.tokens
  const lines = [
    `세션 토큰: ${exactTokenCount(tokens.totalTokens)} (${tokens.turns}턴)`,
    `입력: ${exactTokenCount(tokens.inputTokens)}, 출력: ${exactTokenCount(tokens.outputTokens)}`,
    `캐시 생성: ${exactTokenCount(tokens.cacheCreationInputTokens)}, 캐시 읽기: ${exactTokenCount(tokens.cacheReadInputTokens)}`
  ]
  if (tokens.lastTurnTokens !== undefined) lines.push(`마지막 턴: ${exactTokenCount(tokens.lastTurnTokens)}`)
  if (tokens.totalCostUsd !== undefined) lines.push(`비용: ${costFormatter.format(tokens.totalCostUsd)}`)
  if (usage.context) {
    lines.push(
      `컨텍스트: ${percentText(usage.context.percentage)} 사용, 잔여 ${exactTokenCount(usage.context.remainingTokens)} / ${exactTokenCount(usage.context.maxTokens)}`
    )
  }
  if (usage.rateLimit) {
    const reset = resetTimeText(usage.rateLimit.resetsAt)
    lines.push(
      `${rateLimitTypeLabel(usage.rateLimit.rateLimitType)}: 잔여 ${percentText(usage.rateLimit.remainingPercent)}${reset ? `, ${reset} 리셋` : ''}`
    )
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
  /failed to authenticate|invalid authentication credentials|api error:\s*401/i.test(text ?? '')

const attachmentOrigin = (value: unknown): AgentAttachment['origin'] | undefined =>
  value === 'local' || value === 'remote' ? value : undefined

const attachmentAccess = (value: unknown): AgentAttachment['access'] | undefined =>
  value === 'workspace-path' || value === 'context-only' ? value : undefined

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

function caretOnFirstLine(textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  return !textarea.value.slice(0, textarea.selectionStart).includes('\n')
}

function caretOnLastLine(textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  return !textarea.value.slice(textarea.selectionStart).includes('\n')
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  )
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
  const detail = attachment.text
    ? attachment.text.length > 500
      ? `${attachment.text.slice(0, 500)}...`
      : attachment.text
    : undefined
  return [attachment.path, access, detail].filter(Boolean).join('\n\n') || attachment.label
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
      return [
        {
          kind,
          label,
          path: stringValue(attachment.path),
          origin: attachmentOrigin(attachment.origin),
          access: attachmentAccess(attachment.access),
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

const preview = (value: unknown, max = 260): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const splitDiffText = (value: string | undefined): string[] => {
  if (value === undefined) return []
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function diffLineStats(hunks: DiffHunkView[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'add' || row.kind === 'change') additions += row.after === undefined ? 0 : 1
      if (row.kind === 'remove' || row.kind === 'change') deletions += row.before === undefined ? 0 : 1
    }
  }
  return { additions, deletions }
}

function visibleDiffFallbackText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const lineLimited =
    lines.length > DIFF_FALLBACK_LINE_LIMIT
      ? lines.slice(0, DIFF_FALLBACK_LINE_LIMIT).join('\n')
      : normalized
  const charLimited =
    lineLimited.length > DIFF_FALLBACK_TEXT_LIMIT
      ? lineLimited.slice(0, DIFF_FALLBACK_TEXT_LIMIT)
      : lineLimited
  const truncated = lineLimited.length !== normalized.length || charLimited.length !== lineLimited.length
  return {
    text: truncated ? `${charLimited.trimEnd()}\n...` : charLimited,
    truncated
  }
}

function normalizePatchHunks(value: unknown): DiffPatchHunk[] {
  return recordArray(value)
    .map((hunk) => {
      const oldStart = numberValue(hunk.oldStart)
      const oldLines = numberValue(hunk.oldLines)
      const newStart = numberValue(hunk.newStart)
      const newLines = numberValue(hunk.newLines)
      const lines = stringArray(hunk.lines)
      if (
        oldStart === undefined ||
        oldLines === undefined ||
        newStart === undefined ||
        newLines === undefined ||
        lines.length === 0
      ) {
        return null
      }
      return { oldStart, oldLines, newStart, newLines, lines }
    })
    .filter((hunk): hunk is DiffPatchHunk => Boolean(hunk))
}

function normalizeDiffEdits(value: unknown): DiffEdit[] {
  const edits: DiffEdit[] = []
  for (const edit of recordArray(value)) {
    const oldString = stringValue(edit.oldString)
    const newString = stringValue(edit.newString)
    if (oldString !== undefined || newString !== undefined) edits.push({ oldString, newString })
  }
  return edits
}

function rowsFromPatchHunk(hunk: DiffPatchHunk): DiffRow[] {
  const rows: DiffRow[] = []
  const removals: { lineNo: number; text: string }[] = []
  let beforeNo = hunk.oldStart
  let afterNo = hunk.newStart

  const flushRemovals = (): void => {
    while (removals.length > 0) {
      const removed = removals.shift()!
      rows.push({ kind: 'remove', beforeNo: removed.lineNo, before: removed.text })
    }
  }

  for (const rawLine of hunk.lines) {
    if (rawLine.startsWith('\\')) continue
    const marker = rawLine[0]
    const text = marker === '+' || marker === '-' || marker === ' ' ? rawLine.slice(1) : rawLine
    if (marker === '-') {
      removals.push({ lineNo: beforeNo, text })
      beforeNo += 1
      continue
    }
    if (marker === '+') {
      const removed = removals.shift()
      rows.push(
        removed
          ? { kind: 'change', beforeNo: removed.lineNo, afterNo, before: removed.text, after: text }
          : { kind: 'add', afterNo, after: text }
      )
      afterNo += 1
      continue
    }
    flushRemovals()
    rows.push({ kind: 'context', beforeNo, afterNo, before: text, after: text })
    beforeNo += 1
    afterNo += 1
  }

  flushRemovals()
  return rows
}

function rowsFromStrings(oldString: string | undefined, newString: string | undefined): DiffRow[] {
  const beforeLines = splitDiffText(oldString)
  const afterLines = splitDiffText(newString)
  const max = Math.max(beforeLines.length, afterLines.length)
  const rows: DiffRow[] = []
  for (let index = 0; index < max; index += 1) {
    const before = beforeLines[index]
    const after = afterLines[index]
    if (before === after) {
      rows.push({ kind: 'context', beforeNo: index + 1, afterNo: index + 1, before, after })
    } else if (before === undefined) {
      rows.push({ kind: 'add', afterNo: index + 1, after })
    } else if (after === undefined) {
      rows.push({ kind: 'remove', beforeNo: index + 1, before })
    } else {
      rows.push({ kind: 'change', beforeNo: index + 1, afterNo: index + 1, before, after })
    }
  }
  return rows
}

function diffViewFromParts(args: {
  filePath?: string
  structuredPatch?: unknown
  oldString?: string
  newString?: string
  edits?: DiffEdit[]
}): DiffView | undefined {
  const reversibleEdits = (args.edits?.length ? args.edits : [{ oldString: args.oldString, newString: args.newString }])
    .filter((edit) => edit.oldString !== undefined && edit.newString !== undefined && edit.newString.length > 0)
  const patchHunks = normalizePatchHunks(args.structuredPatch)
  if (patchHunks.length > 0) {
    const hunks = patchHunks.map((hunk, index) => ({
      label: `Hunk ${index + 1}`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows: rowsFromPatchHunk(hunk)
    }))
    const stats = diffLineStats(hunks)
    return {
      filePath: args.filePath,
      hunks,
      ...stats,
      ...(reversibleEdits.length > 0 ? { revertEdits: reversibleEdits } : {})
    }
  }

  const edits = args.edits?.length ? args.edits : [{ oldString: args.oldString, newString: args.newString }]
  const hunks = edits
    .map((edit, index) => ({
      label: edits.length > 1 ? `Edit ${index + 1}` : undefined,
      rows: rowsFromStrings(edit.oldString, edit.newString)
    }))
    .filter((hunk) => hunk.rows.length > 0)
  if (hunks.length === 0) return undefined
  const stats = diffLineStats(hunks)
  return {
    filePath: args.filePath,
    hunks,
    ...stats,
    ...(reversibleEdits.length > 0 ? { revertEdits: reversibleEdits } : {})
  }
}

function diffViewFromRecord(record: Record<string, unknown> | null): DiffView | undefined {
  if (!record) return undefined
  return diffViewFromParts({
    filePath: stringValue(record.filePath),
    structuredPatch: record.structuredPatch,
    oldString: stringValue(record.oldString),
    newString: stringValue(record.newString),
    edits: normalizeDiffEdits(record.edits)
  })
}

function diffTitle(prefix: string, filePath?: string): string {
  return filePath ? `${prefix} · ${filePath.split(/[\\/]/).pop()}` : prefix
}

function diffFallbackText(oldString?: string, newString?: string): string | undefined {
  const text = [
    oldString !== undefined ? `- ${oldString}` : undefined,
    newString !== undefined ? `+ ${newString}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  return text || undefined
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

function upsertProcessStep(items: TimelineItem[], step: ProcessStep): TimelineItem[] {
  const id = processGroupId(items)
  const makeItem = (): TimelineItem => ({
    id,
    kind: 'process',
    title: '작업 과정',
    text: stepSummary(step),
    status: step.status ?? 'running',
    processSteps: [step]
  })
  const updateItem = (item: TimelineItem): TimelineItem => {
    const steps = item.processSteps ?? []
    const exists = steps.some((existing) => existing.id === step.id)
    const nextSteps = exists
      ? steps.map((existing) =>
          existing.id === step.id
            ? {
                ...existing,
                ...step,
                title:
                  step.title === '도구' && existing.title.startsWith('도구 ·')
                    ? existing.title
                    : step.title
              }
            : existing
        )
      : [...steps, step]
    const latest = nextSteps[nextSteps.length - 1] ?? step
    const hasError = nextSteps.some((existing) => existing.status === 'error')
    const running = nextSteps.some((existing) => existing.status === 'running')
    return {
      ...item,
      title: '작업 과정',
      text: stepSummary(latest),
      status: hasError ? 'error' : running ? 'running' : latest.status ?? 'done',
      processSteps: nextSteps
    }
  }
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) return items.map((item, i) => (i === index ? updateItem(item) : item))

  const insertAfter = [...items].map((item) => item.kind).lastIndexOf('user')
  if (insertAfter < 0) return [...items, makeItem()]
  return [...items.slice(0, insertAfter + 1), makeItem(), ...items.slice(insertAfter + 1)]
}

function reduceTimeline(items: TimelineItem[], event: AgentEvent): TimelineItem[] {
  if (event.type === 'message:user') {
    return [
      ...items,
      {
        id: stringValue(event.messageId) ?? `user-${Date.now()}`,
        kind: 'user',
        title: '나',
        text: stringValue(event.text) ?? '',
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
      () => ({ id, kind: 'assistant', title: 'Claude', text: '', status: 'streaming' }),
      (item) => ({ ...item, status: item.status === 'done' ? 'done' : 'streaming' })
    )
  }
  if (event.type === 'message:assistant_delta') {
    const id = stringValue(event.messageId) ?? `assistant-${Date.now()}`
    const text = stringValue(event.text) ?? ''
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'assistant', title: 'Claude', text, status: 'streaming' }),
      (item) => ({ ...item, text: `${item.text ?? ''}${text}`, status: 'streaming' })
    )
  }
  if (event.type === 'message:assistant_replace') {
    const id = stringValue(event.messageId) ?? `assistant-${Date.now()}`
    const text = stringValue(event.text) ?? ''
    return upsertItem(
      items,
      id,
      () => ({ id, kind: 'assistant', title: 'Claude', text, status: 'streaming' }),
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
    return upsertProcessStep(items, {
      id,
      title: `도구 · ${stringValue(event.name) ?? 'tool'}`,
      text: stringValue(event.inputPreview),
      status: 'running'
    })
  }
  if (event.type === 'tool:done') {
    const id = stringValue(event.toolId) ?? `tool-${Date.now()}`
    return upsertProcessStep(items, {
      id,
      title: '도구',
      text: stringValue(event.outputPreview),
      status: event.isError ? 'error' : 'done'
    })
  }
  if (event.type === 'permission:request') {
    const request = asRecord(event.request)
    const requestId = stringValue(request?.requestId) ?? `permission-${Date.now()}`
    return [
      ...items,
      {
        id: requestId,
        kind: 'permission',
        title: stringValue(request?.title) ?? stringValue(request?.toolName) ?? '권한 요청',
        text: stringValue(request?.description) ?? stringValue(request?.decisionReason),
        requestId,
        inputPreview: stringValue(request?.inputPreview),
        status: 'waiting'
      }
    ]
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
        title: stringValue(dialog?.title) ?? 'Claude 질문',
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
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'diff',
        title: diffTitle('변경 적용', filePath),
        status: 'applied',
        filePath,
        text: diff ? undefined : fallbackText,
        diff
      }),
      (item) => ({
        ...item,
        title: filePath ? diffTitle('변경 적용', filePath) : item.title,
        status: 'applied',
        filePath: filePath ?? item.filePath,
        text: diff ? undefined : fallbackText ?? item.text,
        diff: diff ?? item.diff
      })
    )
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
        title: 'Claude 로그인',
        text: '원격 Claude 로그인 절차를 시작했습니다.',
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
        title: 'Claude 로그인',
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
    const message = stringValue(event.message) ?? (ok ? 'Claude 로그인이 완료되었습니다.' : 'Claude 로그인이 실패했습니다.')
    return upsertItem(
      items,
      id,
      () => ({
        id,
        kind: 'auth',
        title: 'Claude 로그인',
        text: message,
        status: ok ? 'done' : 'error'
      }),
      (item) => ({ ...item, text: `${item.text ?? ''}\n${message}`, status: ok ? 'done' : 'error' })
    )
  }
  return items
}

function transcriptToTimeline(transcript: SessionTranscript): TimelineItem[] {
  return transcript.messages.map((message, index) => ({
    id: `history-${message.id || `${transcript.sessionId}-${index}`}`,
    kind: message.role === 'assistant' ? 'assistant' : 'user',
    title: message.role === 'assistant' ? 'Claude' : '나',
    text: message.text
  }))
}

export function DiffPreview({ diff, fallbackText }: { diff?: DiffView; fallbackText?: string }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  if (!diff || diff.hunks.length === 0) {
    if (!fallbackText) return null
    const fallbackPreview = visibleDiffFallbackText(fallbackText)
    const isLongFallback = fallbackPreview.truncated
    const visibleText = isLongFallback && !expanded ? fallbackPreview.text : fallbackText

    return (
      <div className="agent-diff-fallback">
        <pre className="agent-card-text">{visibleText}</pre>
        {isLongFallback && (
          <button
            type="button"
            className="agent-diff-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '접기' : '전체 펼쳐보기'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="agent-diff-view">
      <div className="agent-diff-summary">
        <span className="agent-diff-count add">+{diff.additions}</span>
        <span className="agent-diff-count remove">-{diff.deletions}</span>
        <button
          type="button"
          className="agent-diff-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '접기' : '펼쳐보기'}
        </button>
      </div>
      {expanded && (
        <>
          <div className="agent-diff-labels" aria-hidden="true">
            <span>변경 전</span>
            <span>변경 후</span>
          </div>
          {diff.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.label ?? 'hunk'}-${hunkIndex}`} className="agent-diff-hunk">
              {(hunk.label || diff.hunks.length > 1) && (
                <div className="agent-diff-hunk-title">{hunk.label ?? `Hunk ${hunkIndex + 1}`}</div>
              )}
              <div className="agent-diff-grid">
                {hunk.rows.map((row, rowIndex) => (
                  <Fragment key={`${hunkIndex}-${rowIndex}`}>
                    <div className={`agent-diff-line before ${row.kind}`}>
                      <span className="agent-diff-line-no">{row.beforeNo ?? ''}</span>
                      <span className="agent-diff-line-text">{row.before ?? ''}</span>
                    </div>
                    <div className={`agent-diff-line after ${row.kind}`}>
                      <span className="agent-diff-line-no">{row.afterNo ?? ''}</span>
                      <span className="agent-diff-line-text">{row.after ?? ''}</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
}

function codeLanguageLabel(pre: HTMLPreElement): string | undefined {
  const code = pre.querySelector('code')
  const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
  return language ? language.replace(/^plaintext$/i, 'text') : undefined
}

function renderMarkdownForDisplay(text: string): string {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(text)
  const codeBlocks = Array.from(host.querySelectorAll('pre'))
  codeBlocks.forEach((pre, index) => {
    if (!(pre instanceof HTMLPreElement) || pre.closest('.agent-code-block')) return
    const wrap = document.createElement('div')
    wrap.className = 'agent-code-block'
    wrap.dataset.codeBlockId = String(index)

    const toolbar = document.createElement('div')
    toolbar.className = 'agent-code-toolbar'
    const language = codeLanguageLabel(pre)
    if (language) {
      const label = document.createElement('span')
      label.className = 'agent-code-language'
      label.textContent = language
      toolbar.appendChild(label)
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'agent-code-copy-btn'
    button.title = '코드 복사'
    button.setAttribute('aria-label', '코드 복사')
    button.textContent = '복사'
    toolbar.appendChild(button)

    pre.replaceWith(wrap)
    wrap.appendChild(toolbar)
    wrap.appendChild(pre)
  })
  return host.innerHTML
}

function markdownToPlainText(markdown: string): string {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.innerHTML = renderMarkdown(markdown)
  document.body.appendChild(host)
  const text = host.innerText.trim()
  host.remove()
  return text
}

function markdownPreviewText(markdown: string): string {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(markdown)
  return (host.textContent ?? '').trim()
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

function richClipboardHtml(markdown: string): string {
  return `<meta charset="utf-8"><div>${renderMarkdown(markdown)}</div>`
}

function selectedHtml(selection: Selection): string {
  const wrap = document.createElement('div')
  for (let index = 0; index < selection.rangeCount; index += 1) {
    wrap.appendChild(selection.getRangeAt(index).cloneContents())
  }
  return DOMPurify.sanitize(wrap.innerHTML, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
}

function selectionIntersectsElement(selection: Selection, element: HTMLElement): boolean {
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    if (range.collapsed) continue
    const start =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
    if ((start && element.contains(start)) || (end && element.contains(end))) return true
    if (range.intersectsNode(element)) return true
  }
  return false
}

function writeSelectionToClipboard(clipboardData: DataTransfer, selection: Selection): boolean {
  const text = selection.toString()
  if (!text.trim()) return false
  const html = selectedHtml(selection)
  clipboardData.setData('text/plain', text)
  if (html.trim()) clipboardData.setData('text/html', `<meta charset="utf-8">${html}`)
  return true
}

async function writeRichClipboard(markdown: string): Promise<void> {
  const html = richClipboardHtml(markdown)
  const plain = markdownToPlainText(markdown)
  if (navigator.clipboard?.write && 'ClipboardItem' in window) {
    try {
      const ClipboardItemCtor = window.ClipboardItem
      await navigator.clipboard.write([
        new ClipboardItemCtor({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })
      ])
      return
    } catch {
      /* fall back to selection-based rich copy */
    }
  }
  const host = document.createElement('div')
  host.contentEditable = 'true'
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.innerHTML = html
  document.body.appendChild(host)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(host)
  selection?.removeAllRanges()
  selection?.addRange(range)
  const ok = document.execCommand('copy')
  selection?.removeAllRanges()
  host.remove()
  if (!ok) await navigator.clipboard.writeText(plain)
}

async function copyAgentOutput(markdown: string, mode: AgentCopyMode): Promise<void> {
  if (mode === 'rich') {
    await writeRichClipboard(markdown)
    return
  }
  await navigator.clipboard.writeText(mode === 'markdown' ? markdown : markdownToPlainText(markdown))
}

function MarkdownMessage({
  text,
  streaming,
  onCopyCode
}: {
  text: string
  streaming?: boolean
  onCopyCode: (code: string) => Promise<boolean>
}): JSX.Element {
  const html = useMemo(() => renderMarkdownForDisplay(text), [text])

  const copyCode = async (button: HTMLButtonElement): Promise<void> => {
    const block = button.closest('.agent-code-block')
    const code = block?.querySelector('pre code')?.textContent ?? block?.querySelector('pre')?.textContent
    if (!code) return
    const previous = button.textContent ?? '복사'
    const copied = await onCopyCode(code)
    if (!copied) return
    button.textContent = '복사됨'
    button.disabled = true
    window.setTimeout(() => {
      button.textContent = previous
      button.disabled = false
    }, 1200)
  }

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null
    const copyButton = target?.closest('button.agent-code-copy-btn')
    if (copyButton instanceof HTMLButtonElement) {
      event.preventDefault()
      event.stopPropagation()
      void copyCode(copyButton)
      return
    }
    const link = target?.closest('a')
    if (!(link instanceof HTMLAnchorElement)) return
    const href = link.href
    if (!href) return
    event.preventDefault()
    void window.lt.app.openExternal(href)
  }

  return (
    <div className="agent-md-wrap">
      <div
        className="md-body agent-md-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {streaming && <span className="agent-stream-caret" aria-hidden="true" />}
    </div>
  )
}

export default function AgentPanel({
  id,
  cwd,
  title,
  resumeSessionId,
  ssh,
  profileId,
  caseTabId,
  visible,
  focusNonce = 0,
  attachmentRequests = [],
  onAttachmentRequestsHandled,
  onStatus,
  onFork,
  onWorktreeFork,
  onOpenTerminal,
  onOpenDiff,
  onOpenFile
}: AgentPanelProps): JSX.Element {
  const [items, setItems] = useState<TimelineItem[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentPermissionMode>(DEFAULT_AGENT_PERMISSION_MODE)
  const [status, setStatus] = useState<AgentPanelStatus>('idle')
  const [error, setError] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [runtimeSlashCommands, setRuntimeSlashCommands] = useState<SlashCommand[]>([])
  const [authActive, setAuthActive] = useState(false)
  const [authStatus, setAuthStatus] = useState<AgentAuthStatus>(ssh ? 'checking' : 'unavailable')
  const [authStatusMessage, setAuthStatusMessage] = useState('')
  const [authInput, setAuthInput] = useState('')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [expandedProcessIds, setExpandedProcessIds] = useState<Set<string>>(new Set())
  const [agentFontSize, setAgentFontSize] = useState(DEFAULT_AGENT_FONT_SIZE)
  const [copyFeedback, setCopyFeedback] = useState('')
  const [dialogChoices, setDialogChoices] = useState<Record<string, Record<string, string[]>>>({})
  const [dialogResponses, setDialogResponses] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<AgentAttachment[]>([])
  const [attachmentDropOver, setAttachmentDropOver] = useState(false)
  const [showNewOutputNotice, setShowNewOutputNotice] = useState(false)
  const [revertingDiffIds, setRevertingDiffIds] = useState<Set<string>>(new Set())
  const [usage, setUsage] = useState<AgentUsageView>(() => emptyAgentUsageView())
  const [escInterruptArmed, setEscInterruptArmed] = useState(false)
  const createdRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowTimelineRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const openedAuthUrlsRef = useRef<Set<string>>(new Set())
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedHistoryKeyRef = useRef<string | null>(null)
  const handledAttachmentRequestIdsRef = useRef<Set<string>>(new Set())
  const promptHistoryRef = useRef<string[]>([])
  const promptHistoryIndexRef = useRef<number | null>(null)
  const promptHistoryDraftRef = useRef('')
  const escInterruptArmedRef = useRef(false)
  const escInterruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const focusPrompt = useCallback((position?: number): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const caret = Math.max(0, Math.min(position ?? textarea.value.length, textarea.value.length))
      textarea.focus()
      textarea.setSelectionRange(caret, caret)
    })
  }, [])

  useEffect(() => {
    if (!visible || authActive) return
    focusPrompt()
  }, [authActive, focusNonce, focusPrompt, visible])

  const resetPromptHistoryCursor = useCallback((): void => {
    promptHistoryIndexRef.current = null
    promptHistoryDraftRef.current = ''
  }, [])

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

      let nextIndex: number | null
      if (direction === -1) {
        if (currentIndex === null) {
          promptHistoryDraftRef.current = input
          nextIndex = history.length - 1
        } else {
          nextIndex = Math.max(0, currentIndex - 1)
        }
      } else if (currentIndex !== null && currentIndex >= history.length - 1) {
        nextIndex = null
      } else {
        nextIndex = (currentIndex ?? history.length - 1) + 1
      }

      promptHistoryIndexRef.current = nextIndex
      const nextInput = nextIndex === null ? promptHistoryDraftRef.current : history[nextIndex]
      if (nextIndex === null) promptHistoryDraftRef.current = ''
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
    const timeline = scrollRef.current
    if (!timeline) return
    shouldFollowTimelineRef.current = true
    timeline.scrollTo({ top: timeline.scrollHeight })
    setShowNewOutputNotice(false)
  }, [])

  const updateTimelineFollowState = useCallback((): void => {
    const timeline = scrollRef.current
    if (!timeline) return
    const atBottom = isTimelineNearBottom(timeline)
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
        setUsage((current) => ({
          tokens: tokens ?? current.tokens,
          context: context ?? current.context,
          rateLimit: rateLimit ?? current.rateLimit
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
      if (event.type !== 'raw') setItems((prev) => reduceTimeline(prev, event))
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
  }, [cwd, id, onStatus, profileId, ssh])

  useEffect(() => {
    if (!settingsLoaded) return
    if (createdRef.current) return
    createdRef.current = true
    void window.lt.agent
      .create({
        id,
        cwd,
        title,
        resumeSessionId,
        permissionMode: mode,
        source: ssh ? 'ssh' : 'local',
        ssh
      })
      .then((result) => {
        if (!result.ok) setError(result.error ?? 'Agent 세션을 만들 수 없습니다.')
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }, [cwd, id, mode, resumeSessionId, settingsLoaded, ssh, title])

  useEffect(() => {
    if (!resumeSessionId) return
    const sourceKey = ssh ? `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.identityFile ?? ''}` : 'local'
    const historyKey = `${sourceKey}:${resumeSessionId}`
    if (loadedHistoryKeyRef.current === historyKey) return
    loadedHistoryKeyRef.current = historyKey
    let alive = true
    void window.lt.sessions
      .transcript(resumeSessionId, ssh)
      .then((transcript) => {
        if (!alive || !transcript || transcript.messages.length === 0) return
        const historyItems = transcriptToTimeline(transcript)
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
  }, [rememberPrompts, resumeSessionId, ssh])

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
  const escInterruptHint = `Esc ${Math.round(ESC_INTERRUPT_ARM_MS / 1000)}초 안에 한 번 더 누르면 중지`
  const statusLabel = escInterruptArmed ? `${baseStatusLabel}, ${escInterruptHint}` : baseStatusLabel
  const statusAccessibleLabel = queuedCount > 0 ? `${statusLabel}, 대기 ${queuedCount}` : statusLabel
  const needsAuth = useMemo(
    () => Boolean(ssh) && items.some((item) => isAuthFailureText(item.text)),
    [items, ssh]
  )
  const remoteCliUnavailable = Boolean(ssh) && authStatus === 'unavailable'
  const remoteAuthChecking = Boolean(ssh) && authStatus === 'checking'
  const remoteNeedsLogin =
    Boolean(ssh) &&
    authStatus !== 'authenticated' &&
    (authStatus === 'unauthenticated' || needsAuth)
  const sendBlockedReason =
    !settingsLoaded
      ? 'Agent 설정 로드 중'
      : authActive
        ? 'Claude 로그인 진행 중'
        : remoteAuthChecking
          ? '원격 Claude Code 상태 확인 중'
          : remoteCliUnavailable
            ? '원격 Claude Code CLI 없음'
            : remoteNeedsLogin
              ? '원격 Claude 로그인 필요'
              : ''
  const canSubmit = useMemo(
    () => hasPrompt && !sendBlockedReason,
    [hasPrompt, sendBlockedReason]
  )
  const queuesNewInput =
    status === 'working' || status === 'waiting_permission' || status === 'waiting_user'
  const interruptible = queuesNewInput || authActive
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
    () => mergeSlashCommands(slashCommands, runtimeSlashCommands),
    [runtimeSlashCommands]
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
    })
  }, [allSlashCommands, slashToken])
  const showSlashMenu = slashMatches.length > 0 && !authActive

  useEffect(() => {
    setSlashIndex(0)
  }, [slashToken])

  useEffect(() => {
    setSlashIndex((current) => (slashMatches.length === 0 ? 0 : Math.min(current, slashMatches.length - 1)))
  }, [slashMatches.length])

  useLayoutEffect(() => {
    if (!showSlashMenu) return
    const active = slashMenuRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [showSlashMenu, slashIndex, slashMatches])

  const applySlashCommand = (command: SlashCommand): void => {
    resetPromptHistoryCursor()
    if (command.mode) setMode(command.mode)
    const nextInput = `${command.name} `
    setInput(nextInput)
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

  const addPathAttachments = useCallback(
    (paths: string[], source: 'drop' | 'paste'): void => {
      const unique = uniqueStrings(paths)
      if (unique.length === 0 || authActive) return
      focusPrompt()
      void (async () => {
        const nextAttachments: AgentAttachment[] = []
        for (const path of unique) {
          nextAttachments.push(await attachmentForPath(path))
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
    [attachmentForPath, authActive, focusPrompt, showTransientFeedback]
  )

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
    if (rawText && slashCommandName(rawText) === '/mcp') {
      if (sendAttachments.length > 0) {
        setError('MCP 상태 확인에는 첨부를 사용할 수 없습니다.')
        return
      }
      if (sendBlockedReason) {
        setError(sendBlockedReason)
        return
      }
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

    const expanded = rawText ? expandSlashInput(rawText) : { text: '' }
    const text = expanded.text
    if ((!text && sendAttachments.length === 0) || sendBlockedReason) {
      if (sendBlockedReason) setError(sendBlockedReason)
      return
    }
    const nextMode = expanded.mode ?? mode
    if (expanded.mode) selectPermissionMode(expanded.mode, false)
    if (rawText) rememberPrompts([rawText])
    setInput('')
    setAttachments([])
    setError('')
    const nextDelivery = delivery ?? (queuesNewInput ? 'queue' : 'normal')
    const result = await window.lt.agent.send(id, {
      text,
      attachments: sendAttachments,
      permissionMode: nextMode,
      delivery: nextDelivery
    })
    if (!result.ok) {
      setError(result.error ?? 'Agent 요청을 보낼 수 없습니다.')
      setStatus('error')
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

  const resolvePermission = async (
    requestId: string,
    decision: 'allow' | 'reject',
    remember = false
  ): Promise<void> => {
    setError('')
    const result = await window.lt.agent.approve({ sessionId: id, requestId, decision, remember })
    if (!result.ok) setError(result.error ?? '권한 응답을 보낼 수 없습니다.')
  }

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
        isEditableKeyboardTarget(event.target)
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
    if (!result.ok) setError(result.error ?? 'Claude 로그인을 시작할 수 없습니다.')
  }

  const sendAuthInput = async (): Promise<void> => {
    const text = authInput
    setAuthInput('')
    const result = await window.lt.agent.authInput(id, text)
    if (!result.ok) setError(result.error ?? 'Claude 로그인 입력을 보낼 수 없습니다.')
  }

  const copyAuthCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      setError('인증 코드를 클립보드에 복사할 수 없습니다.')
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

  const onAttachmentPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (authActive) return
    const clipboard = event.clipboardData
    const directPaths = dataTransferPaths(clipboard)
    if (directPaths.length > 0) {
      event.preventDefault()
      addPathAttachments(directPaths, 'paste')
      return
    }
    const types = Array.from(clipboard.types)
    const text = clipboard.getData('text/plain')
    if (pathLikeText(text)) {
      event.preventDefault()
      addPathAttachments(pathsFromPathLikeText(text), 'paste')
      return
    }
    if (!types.some(fileLikeClipboardType)) return
    event.preventDefault()
    void window.lt.fs
      .clipboardFiles()
      .then((clip) => {
        if (clip.paths.length === 0) {
          setError('클립보드에서 파일 경로를 찾을 수 없습니다.')
          return
        }
        addPathAttachments(clip.paths, 'paste')
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
          ? '로그인됨'
          : authStatus === 'unavailable'
            ? 'CLI 없음'
            : '로그인'
  const authButtonTitle =
    authStatusMessage ||
    (authStatus === 'authenticated'
      ? '원격 Claude Code 로그인이 확인되었습니다'
      : authStatus === 'checking'
        ? '원격 Claude Code 로그인 상태를 확인하고 있습니다'
        : authStatus === 'unavailable'
          ? '원격에서 Claude Code CLI를 찾을 수 없습니다'
          : '원격 Claude Code 로그인')
  const authButtonDisabled =
    authActive ||
    status === 'working' ||
    authStatus === 'checking' ||
    authStatus === 'authenticated' ||
    authStatus === 'unavailable'
  const rateLimitState =
    usage.rateLimit?.status === 'rejected'
      ? 'error'
      : usage.rateLimit?.status === 'allowed_warning'
        ? 'warn'
        : ''
  const contextLabel = usage.context
    ? `컨텍스트 ${percentText(usage.context.percentage)} · 잔여 ${tokenCount(usage.context.remainingTokens)}`
    : '컨텍스트 대기'
  const limitReset = resetTimeText(usage.rateLimit?.resetsAt)
  const limitLabel = usage.rateLimit
    ? `${rateLimitTypeLabel(usage.rateLimit.rateLimitType)} ${
        usage.rateLimit.remainingPercent === undefined ? '확인됨' : `잔여 ${percentText(usage.rateLimit.remainingPercent)}`
      }${limitReset ? ` · ${limitReset}` : ''}`
    : '한도 대기'
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
          <div className="agent-mode-menu" ref={modeMenuRef}>
            <button
              type="button"
              className={`agent-mode-trigger ${modeMenuOpen ? 'active' : ''}`}
              title={currentMode.title}
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              onClick={() => setModeMenuOpen((open) => !open)}
            >
              권한 · {currentMode.label}
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
          {ssh && (
            <button
              className="agent-auth-btn"
              disabled={authButtonDisabled}
              title={authButtonTitle}
              onClick={() => void startAuthLogin()}
            >
              {authButtonLabel}
            </button>
          )}
          {onFork && (
            <button
              className="agent-icon-btn"
              title="현재 Agent 세션 맥락을 같은 폴더의 새 탭으로 열기"
              aria-label="Fork"
              onClick={onFork}
            >
              F
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
              WT
            </button>
          )}
          {onOpenTerminal && (
            <button className="agent-icon-btn" title="터미널로 열기" onClick={onOpenTerminal}>
              ›_
            </button>
          )}
        </div>
      </header>

      <div className="agent-timeline-wrap">
        <div className="agent-timeline" ref={scrollRef} onScroll={updateTimelineFollowState} onCopy={copySelection}>
          {items.length === 0 && <div className="agent-empty">Claude Agent</div>}
          {items.map((item) => {
            if (item.kind === 'process') {
              const expanded = expandedProcessIds.has(item.id)
              const steps = item.processSteps ?? []
              return (
                <section key={item.id} className={`agent-card process ${item.status ?? ''}`}>
                  <button
                    type="button"
                    className="agent-process-row"
                    aria-expanded={expanded}
                    onClick={() => toggleProcess(item.id)}
                  >
                    <span className={`agent-process-chevron ${expanded ? 'expanded' : ''}`}>›</span>
                    <span className="agent-process-title">{item.title ?? '작업 과정'}</span>
                    <span className="agent-process-summary">{item.text ?? '진행 중'}</span>
                    <span className="agent-process-count">{steps.length}</span>
                  </button>
                  {expanded && (
                    <div className="agent-process-details">
                      {steps.map((step) => (
                        <div key={step.id} className={`agent-process-step ${step.status ?? ''}`}>
                          <div className="agent-process-step-head">
                            <span>{step.title}</span>
                            {step.status && <span>{step.status}</span>}
                          </div>
                          {step.text && <pre className="agent-process-step-text">{step.text}</pre>}
                        </div>
                      ))}
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
                  <span>{item.title ?? 'Claude 질문'}</span>
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
          return (
            <section key={item.id} className={`agent-card ${item.kind} ${item.status ?? ''}`}>
              <div className="agent-card-head">
                <span>{item.title}</span>
                <span className="agent-card-head-right">
                  {item.kind === 'assistant' && item.text && (
                    <span className="agent-copy-actions" aria-label="출력 복사">
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
              {item.kind === 'diff' && item.diff && <DiffPreview diff={item.diff} />}
              {item.kind === 'diff' && !item.diff && item.text && (
                <pre className="agent-card-text">{item.text}</pre>
              )}
              {item.kind !== 'diff' &&
                item.text &&
                (item.kind === 'assistant' ? (
                  <MarkdownMessage
                    text={item.text}
                    streaming={item.status === 'streaming'}
                    onCopyCode={copyCodeBlock}
                  />
                ) : (
                  <pre className="agent-card-text">{item.text}</pre>
                ))}
              {item.inputPreview && <pre className="agent-card-input">{item.inputPreview}</pre>}
              {item.attachments && item.attachments.length > 0 && (
                <div className="agent-attachments sent" aria-label="전송된 첨부">
                  {item.attachments.map((attachment, index) => (
                    <span
                      key={`${attachment.path ?? attachment.label}-${index}`}
                      className="agent-attachment-chip"
                      title={attachmentTitle(attachment)}
                    >
                      <span className="agent-attachment-kind">{attachmentKindLabel(attachment.kind)}</span>
                      <span className="agent-attachment-label">
                        {attachment.label}
                      </span>
                    </span>
                  ))}
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
                <div className="agent-card-actions">
                  <button onClick={() => void resolvePermission(item.requestId!, 'allow')}>허용</button>
                  <button onClick={() => void resolvePermission(item.requestId!, 'allow', true)}>
                    항상 허용
                  </button>
                  <button onClick={() => void resolvePermission(item.requestId!, 'reject')}>거절</button>
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

      {remoteCliUnavailable && (
        <div className="agent-auth-banner unavailable">
          <span>
            원격 서버에서 Claude Code CLI를 찾을 수 없습니다. 원격 터미널에서 설치한 뒤 Agent를 다시 여세요.
          </span>
          {onOpenTerminal && (
            <button onClick={onOpenTerminal}>
              터미널 열기
            </button>
          )}
        </div>
      )}
      {!remoteCliUnavailable && (needsAuth || remoteNeedsLogin || remoteAuthChecking) && authStatus !== 'authenticated' && (
        <div className="agent-auth-banner">
          <span>
            {remoteAuthChecking ? '원격 Claude 상태를 확인하고 있습니다.' : '원격 Claude 로그인이 필요합니다.'}
          </span>
          <button disabled={authButtonDisabled} onClick={() => void startAuthLogin()}>
            {authButtonLabel === '로그인' ? '로그인 시작' : authButtonLabel}
          </button>
        </div>
      )}
      {error && <div className="agent-error">{error}</div>}
      {copyFeedback && <div className="agent-copy-feedback">{copyFeedback}</div>}

      <footer className="agent-prompt">
        {showSlashMenu && (
          <div ref={slashMenuRef} className="agent-slash-menu" role="listbox" aria-label="Slash commands">
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                id={`agent-slash-${id}-${index}`}
                className={`agent-slash-item ${index === slashIndex ? 'active' : ''}`}
                data-active={index === slashIndex ? 'true' : undefined}
                role="option"
                aria-selected={index === slashIndex}
                title={`${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applySlashCommand(command)
                }}
              >
                <span className="agent-slash-command">{command.name}</span>
                <span className="agent-slash-detail">
                  <span className="agent-slash-label">{command.label}</span>
                  <span className="agent-slash-desc">{runtimeSlashCommandDescription(command)}</span>
                </span>
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
        <textarea
          ref={textareaRef}
          value={input}
          disabled={authActive}
          placeholder={authActive ? 'Claude 로그인 진행 중' : 'Claude에게 요청'}
          onChange={(e) => {
            resetPromptHistoryCursor()
            setInput(e.target.value)
          }}
          onPaste={onAttachmentPaste}
          onKeyDown={(e) => {
            if (authActive) return
            if (e.nativeEvent.isComposing) return
            if (showSlashMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
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
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
              const textarea = e.currentTarget
              const direction = e.key === 'ArrowUp' ? -1 : 1
              if (
                (direction === -1 && caretOnFirstLine(textarea)) ||
                (direction === 1 && promptHistoryIndexRef.current !== null && caretOnLastLine(textarea))
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
                  title={`${attachmentTitle(attachment)}\n\n클릭하면 프롬프트에 넣습니다`}
                  onClick={() => insertAttachmentReference(attachment)}
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
        <div
          className={`agent-usage-bar ${rateLimitState}`}
          title={usageTitle(usage)}
          aria-live="polite"
        >
          <span>
            토큰 <strong>{tokenCount(usage.tokens.totalTokens)}</strong>
            {usage.tokens.lastTurnTokens !== undefined && (
              <span className="agent-usage-muted"> 마지막 {tokenCount(usage.tokens.lastTurnTokens)}</span>
            )}
          </span>
          <span>입력 {tokenCount(usage.tokens.inputTokens)}</span>
          <span>출력 {tokenCount(usage.tokens.outputTokens)}</span>
          <span>{contextLabel}</span>
          <span>{limitLabel}</span>
          {usage.tokens.totalCostUsd !== undefined && <span>{costFormatter.format(usage.tokens.totalCostUsd)}</span>}
        </div>
        <div className="agent-prompt-actions">
          <span
            className={`agent-status ${status}${escInterruptArmed ? ' esc-armed' : ''}`}
            title={statusAccessibleLabel}
            aria-label={statusAccessibleLabel}
            aria-live="polite"
          >
            {status === 'working' ? (
              <>
                <span className="agent-status-spinner" aria-hidden="true" />
                <span className="sr-only">{statusLabel}</span>
              </>
            ) : (
              <span>{baseStatusLabel}</span>
            )}
            {escInterruptArmed && (
              <span className="agent-status-esc-arm" aria-hidden="true">
                Esc 한 번 더 누르면 중지
              </span>
            )}
            {queuedCount > 0 && <span className="agent-status-queue">대기 {queuedCount}</span>}
          </span>
          {queuesNewInput ? (
            <div className="agent-working-actions">
              <button
                disabled={!canSubmit}
                title="Enter로도 대기열에 넣습니다"
                onClick={() => void send('queue')}
              >
                대기열에 넣기
              </button>
              <button disabled={!canSubmit} onClick={() => void send('steer')}>
                바로 지시하기
              </button>
              <button className={stopButtonClassName} title={stopButtonTitle} onClick={() => void interrupt()}>
                중지
              </button>
            </div>
          ) : authActive ? (
            <button className={stopButtonClassName} title={stopButtonTitle} onClick={() => void interrupt()}>
              중지
            </button>
          ) : (
            <button disabled={!canSubmit} onClick={() => void send()}>
              전송
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
