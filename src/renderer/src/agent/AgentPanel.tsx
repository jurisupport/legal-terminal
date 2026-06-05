import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type MouseEvent
} from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AgentEvent, AgentPermissionMode, AppSettings, SessionTranscript, SshConn } from '../env'

type AgentRunStatus = 'working' | 'done' | 'question'
type AgentSendDelivery = 'normal' | 'queue' | 'steer'
type AgentCopyMode = 'rich' | 'markdown' | 'text'
type AgentAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable' | 'error'

const SETTINGS_UPDATED_EVENT = 'lt:settings-updated'
const DEFAULT_AGENT_FONT_SIZE = 13
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32

const clampAgentFontSize = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AGENT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)))
}

interface AgentPanelProps {
  id: string
  cwd: string
  title: string
  resumeSessionId?: string
  ssh?: SshConn
  visible: boolean
  onStatus?: (status: AgentRunStatus) => void
  onOpenTerminal?: () => void
}

interface TimelineItem {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'permission' | 'diff' | 'error' | 'auth' | 'process' | 'queue' | 'dialog'
  title?: string
  text?: string
  status?: string
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

interface SlashCommand {
  name: string
  label: string
  description: string
  mode?: AgentPermissionMode
  expand: (rest: string) => string
}

const modeLabels: { value: AgentPermissionMode; label: string; title: string }[] = [
  { value: 'ask', label: '확인', title: '편집과 명령 실행을 확인합니다' },
  { value: 'plan', label: '계획', title: '실행 전 계획을 먼저 봅니다' },
  { value: 'acceptEdits', label: '편집 자동', title: '파일 편집은 자동 허용합니다' },
  { value: 'bypassPermissions', label: '자동 허용', title: '모든 권한 요청을 자동 허용합니다' },
  { value: 'dontAsk', label: '거절', title: '승인되지 않은 작업을 거절합니다' }
]

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

function expandSlashInput(text: string): { text: string; mode?: AgentPermissionMode } {
  const match = text.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return { text }
  const command = slashCommands.find((item) => item.name === match[1].toLowerCase())
  if (!command) return { text }
  return { text: command.expand((match[2] ?? '').trim()), mode: command.mode }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const recordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : []

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
        text: stringValue(event.text) ?? ''
      }
    ]
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
    const title = delivery === 'steer' ? '스티어링 대기' : '대기열'
    return [
      ...items,
      {
        id: queueId,
        kind: 'queue',
        title,
        queueId,
        text: stringValue(event.text) ?? '',
        status: delivery === 'steer' ? 'priority' : 'queued'
      }
    ]
  }
  if (event.type === 'queue:started') {
    const queueId = stringValue(event.queueId)
    if (!queueId) return items
    return items.map((item) =>
      item.queueId === queueId ? { ...item, title: '대기열 실행', status: 'started' } : item
    )
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
    return [
      ...items,
      {
        id,
        kind: 'diff',
        title: filePath ? `변경 제안 · ${filePath.split(/[\\/]/).pop()}` : '변경 제안',
        text: [oldString && `- ${oldString}`, newString && `+ ${newString}`].filter(Boolean).join('\n')
      }
    ]
  }
  if (event.type === 'diff:applied') {
    const id = stringValue(event.proposalId)
    if (!id) return items
    return items.map((item) => (item.id === id ? { ...item, status: 'applied' } : item))
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

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
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

function MarkdownMessage({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])

  const openLink = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target.closest('a') : null
    if (!(target instanceof HTMLAnchorElement)) return
    const href = target.href
    if (!href) return
    event.preventDefault()
    void window.lt.app.openExternal(href)
  }

  return (
    <div className="agent-md-wrap">
      <div
        className="md-body agent-md-body"
        onClick={openLink}
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
  visible,
  onStatus,
  onOpenTerminal
}: AgentPanelProps): JSX.Element {
  const [items, setItems] = useState<TimelineItem[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentPermissionMode>('ask')
  const [status, setStatus] = useState<'idle' | 'working' | 'waiting_permission' | 'waiting_user' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [authActive, setAuthActive] = useState(false)
  const [authStatus, setAuthStatus] = useState<AgentAuthStatus>(ssh ? 'checking' : 'unavailable')
  const [authStatusMessage, setAuthStatusMessage] = useState('')
  const [authInput, setAuthInput] = useState('')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [expandedProcessIds, setExpandedProcessIds] = useState<Set<string>>(new Set())
  const [agentFontSize, setAgentFontSize] = useState(DEFAULT_AGENT_FONT_SIZE)
  const [copyFeedback, setCopyFeedback] = useState('')
  const [dialogChoices, setDialogChoices] = useState<Record<string, Record<string, string[]>>>({})
  const [dialogResponses, setDialogResponses] = useState<Record<string, string>>({})
  const createdRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const openedAuthUrlsRef = useRef<Set<string>>(new Set())
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedHistoryKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.lt.agent.onEvent((event) => {
      if (eventSessionId(event) !== id) return
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
  }, [id, onStatus])

  useEffect(() => {
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
  }, [cwd, id, mode, resumeSessionId, ssh, title])

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
  }, [resumeSessionId, ssh])

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
    const applySettings = (settings: AppSettings): void => {
      setAgentFontSize(clampAgentFontSize(settings.agentFontSize))
    }
    window.lt.settings.get().then(applySettings).catch(() => {})
    const onSettingsUpdated = (event: Event): void => {
      applySettings((event as CustomEvent<AppSettings>).detail)
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  useEffect(() => {
    if (!visible) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items, visible])

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

  const hasPrompt = useMemo(() => input.trim().length > 0, [input])
  const queuedCount = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === 'queue' &&
          (item.status === 'queued' || item.status === 'priority')
      ).length,
    [items]
  )
  const statusText = queuedCount > 0 ? `${status} · 대기 ${queuedCount}` : status
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
    authActive
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
  const slashToken = useMemo(() => {
    const trimmed = input.trimStart()
    if (!/^\/[^\s]*$/.test(trimmed)) return ''
    return trimmed.toLowerCase()
  }, [input])
  const slashMatches = useMemo(() => {
    if (!slashToken) return []
    const query = slashToken.slice(1)
    return slashCommands
      .filter(
        (command) =>
          command.name.slice(1).startsWith(query) ||
          command.label.toLowerCase().includes(query) ||
          command.description.toLowerCase().includes(query)
      )
      .slice(0, 7)
  }, [slashToken])
  const showSlashMenu = slashMatches.length > 0 && !authActive

  useEffect(() => {
    setSlashIndex(0)
  }, [slashToken])

  const applySlashCommand = (command: SlashCommand): void => {
    if (command.mode) setMode(command.mode)
    setInput(`${command.name} `)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const send = async (delivery?: AgentSendDelivery): Promise<void> => {
    const rawText = input.trim()
    const expanded = expandSlashInput(rawText)
    const text = expanded.text
    if (!text || sendBlockedReason) {
      if (sendBlockedReason) setError(sendBlockedReason)
      return
    }
    const nextMode = expanded.mode ?? mode
    if (expanded.mode) setMode(expanded.mode)
    setInput('')
    setError('')
    const nextDelivery = delivery ?? (status === 'working' ? 'queue' : 'normal')
    const result = await window.lt.agent.send(id, {
      text,
      permissionMode: nextMode,
      delivery: nextDelivery
    })
    if (!result.ok) {
      setError(result.error ?? 'Agent 요청을 보낼 수 없습니다.')
      setStatus('error')
    }
  }

  const resolvePermission = async (
    requestId: string,
    decision: 'allow' | 'reject',
    remember = false
  ): Promise<void> => {
    const result = await window.lt.agent.approve({ requestId, decision, remember })
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

  const interrupt = async (): Promise<void> => {
    await window.lt.agent.interrupt(id)
    setAuthActive(false)
    setStatus('idle')
  }

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
  const panelStyle = {
    '--agent-font-size': `${agentFontSize}px`
  } as CSSProperties

  return (
    <div className="agent-panel" data-visible={visible ? 'true' : 'false'} style={panelStyle}>
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
                      setMode(option.value)
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
          {onOpenTerminal && (
            <button className="agent-icon-btn" title="터미널로 열기" onClick={onOpenTerminal}>
              ›_
            </button>
          )}
        </div>
      </header>

      <div className="agent-timeline" ref={scrollRef} onCopy={copySelection}>
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
                  {item.status && <span className="agent-card-status">{item.status}</span>}
                </span>
              </div>
              {item.text &&
                (item.kind === 'assistant' ? (
                  <MarkdownMessage text={item.text} streaming={item.status === 'streaming'} />
                ) : (
                  <pre className="agent-card-text">{item.text}</pre>
                ))}
              {item.inputPreview && <pre className="agent-card-input">{item.inputPreview}</pre>}
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
          <div className="agent-slash-menu" role="listbox" aria-label="Slash commands">
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                className={`agent-slash-item ${index === slashIndex ? 'active' : ''}`}
                role="option"
                aria-selected={index === slashIndex}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applySlashCommand(command)
                }}
              >
                <span className="agent-slash-command">{command.name}</span>
                <span className="agent-slash-detail">
                  <span className="agent-slash-label">{command.label}</span>
                  <span className="agent-slash-desc">{command.description}</span>
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
          onChange={(e) => setInput(e.target.value)}
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
            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            void send()
          }}
        />
        <div className="agent-prompt-actions">
          <span className={`agent-status ${status}`}>{statusText}</span>
          {status === 'working' ? (
            <div className="agent-working-actions">
              <button disabled={!canSubmit} onClick={() => void send('queue')}>
                큐 추가
              </button>
              <button disabled={!canSubmit} onClick={() => void send('steer')}>
                스티어
              </button>
              <button onClick={() => void interrupt()}>중지</button>
            </div>
          ) : authActive ? (
            <button onClick={() => void interrupt()}>중지</button>
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
