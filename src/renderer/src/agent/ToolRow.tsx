// 도구 실행을 한 줄 행으로 렌더링한다.
// `⏺ 문서 읽기 (소장.pdf)` 형태 — 클릭하면 도구 원어 이름과 입력/출력 미리보기를 펼친다.
import { asRecord, numberValue, recordArray, stringValue } from './values'
import { isSubAgentStep } from './subAgentStatus'

export interface ProcessStep {
  id: string
  title: string
  text?: string
  status?: string
  toolName?: string
  description?: string
  input?: string
  output?: string
  elapsedMs?: number
}

export interface TodoChecklistItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

const TOOL_ARG_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'skill'
]

const TOOL_ARG_LIMIT = 72

const toolNameLabels: Record<string, string> = {
  Read: '문서 읽기',
  Write: '문서 작성',
  Edit: '문서 수정',
  MultiEdit: '문서 수정',
  NotebookEdit: '문서 수정',
  Bash: '명령 실행',
  Shell: '명령 실행',
  Grep: '내용 검색',
  Glob: '파일 찾기',
  WebSearch: '웹 검색',
  WebFetch: '웹 문서 확인',
  Task: '서브에이전트',
  Agent: '서브에이전트',
  TodoWrite: '할 일 정리',
  AskUserQuestion: '질문',
  Skill: '기능 실행',
  ExitPlanMode: '계획 완료'
}

const MANAGED_MCP_PREFIX = 'mcp__legal_terminal_jurisupport__'
const managedToolLabels: Record<string, string> = {
  list_tasks: '할일 목록 확인',
  get_task: '할일 상세 확인',
  create_task: '할일 추가',
  create_task_from_source: '원문에서 할일 추가',
  update_task: '할일 수정',
  update_task_from_source: '원문에서 할일 수정',
  update_task_status: '할일 상태 변경',
  delete_task: '할일 삭제',
  get_task_evidence_suggestions: '완료 근거 확인',
  list_cases: '사건 목록 확인',
  get_case: '사건 상세 확인',
  get_case_closure_preview: '사건 종결 전 할일 검토',
  update_case_status: '사건 상태 변경',
  update_case_engagement_status: '수임 상태 변경',
  update_case_engagement: '수임 상태 변경',
  get_today_hearings: '오늘 기일 확인',
  get_upcoming_hearings: '다가오는 기일 확인',
  list_case_progress: '사건 진행내역 확인'
}

function shortenPathLike(value: string): string {
  if (!/[\\/]/.test(value) || /\s/.test(value.trim())) return value
  const name = value.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
  return name || value
}

function clipArg(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > TOOL_ARG_LIMIT ? `${flat.slice(0, TOOL_ARG_LIMIT)}…` : flat
}

function parsePreviewJson(preview: string | undefined): Record<string, unknown> | null {
  if (!preview || !preview.trimStart().startsWith('{')) return null
  try {
    return asRecord(JSON.parse(preview))
  } catch {
    return null
  }
}

export function toolDisplayName(rawName: string): string {
  if (rawName.startsWith(MANAGED_MCP_PREFIX)) return managedToolLabels[rawName.slice(MANAGED_MCP_PREFIX.length)] ?? 'JuriSupport 작업'
  const mcp = rawName.match(/^mcp__(.+?)__(.+)$/)
  return toolNameLabels[rawName] ?? (mcp ? `${mcp[1]} · ${mcp[2]}` : rawName)
}

const isHookStep = (step: ProcessStep): boolean => !step.toolName && step.title.startsWith('Hook · ')

export function processStepStatus(step: ProcessStep): string {
  if (!step.toolName && step.title === 'Rate limit') {
    const status = step.status ?? step.text
    if (status === 'allowed') return 'done'
    if (status === 'allowed_warning') return 'warning'
    if (status === 'rejected') return 'error'
  }
  const status = step.status ?? 'running'
  if (isHookStep(step)) {
    if (status === 'success' || status === 'completed') return 'done'
    if (['failed', 'blocked', 'denied'].includes(status)) return 'error'
    if (!['running', 'done', 'error', 'cancelled', 'canceled', 'paused'].includes(status)) return 'warning'
  }
  return status
}

export function isDiagnosticStep(step: ProcessStep): boolean {
  if (isHookStep(step)) return ['running', 'done'].includes(processStepStatus(step))
  return !step.toolName && step.title === 'Rate limit' && (step.status ?? step.text) === 'allowed'
}

export function toolStepDisplay(step: ProcessStep): { name: string; arg?: string; rawName: string } {
  const rawName = step.toolName ?? step.title.replace(/^도구 · /, '')
  if (isHookStep(step)) {
    const status = processStepStatus(step)
    const name = status === 'error' ? '자동 처리 오류'
      : status === 'cancelled' || status === 'canceled' ? '자동 처리 중지됨'
        : status === 'running' ? '자동 처리 중'
          : status === 'done' ? '자동 처리 완료' : '자동 처리 확인 필요'
    return { name, rawName }
  }
  if (!step.toolName && rawName === 'Rate limit') {
    const status = step.status ?? step.text
    const name = status === 'allowed' ? '사용량 정상'
      : status === 'allowed_warning' ? '사용 한도에 가까워졌습니다'
        : status === 'rejected' ? '사용 한도에 도달했습니다' : '사용량 상태 확인'
    return { name, rawName }
  }
  const name = isSubAgentStep(step) ? '하위 작업'
    : rawName.startsWith(MANAGED_MCP_PREFIX) ? toolDisplayName(rawName)
      : toolNameLabels[rawName] ?? (step.toolName || step.title.startsWith('도구 · ')
        ? '도구 실행' : /[가-힣]/.test(rawName) ? rawName : '작업')
  const input = parsePreviewJson(step.input)
  if (rawName.startsWith(MANAGED_MCP_PREFIX)) {
    const title = input && (stringValue(input.title) || stringValue(input.search))
    const status = input && stringValue(input.status)
    const statusLabel = status && ({ pending: '예정', in_progress: '진행중', completed: '완료', closed: '종료' }[status])
    return { name, ...(title || statusLabel ? { arg: clipArg(title || statusLabel!) } : {}), rawName }
  }
  if (input) {
    for (const key of TOOL_ARG_KEYS) {
      const value = stringValue(input[key])
      if (value) return { name, arg: clipArg(shortenPathLike(value)), rawName }
    }
    const todos = recordArray(input.todos)
    if (todos.length > 0) return { name, arg: `${todos.length}개 항목`, rawName }
  }
  return { name, rawName }
}

export function todoChecklistFromStep(step: ProcessStep): TodoChecklistItem[] | null {
  if ((step.toolName ?? '') !== 'TodoWrite') return null
  const input = parsePreviewJson(step.input)
  if (!input) return null
  const todos = recordArray(input.todos)
  if (todos.length === 0) return null
  const items = todos
    .map((todo): TodoChecklistItem | null => {
      const content = stringValue(todo.content)
      const status = stringValue(todo.status)
      if (!content) return null
      return {
        content,
        status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
        activeForm: stringValue(todo.activeForm)
      }
    })
    .filter((item): item is TodoChecklistItem => Boolean(item))
  return items.length > 0 ? items : null
}

export function stepElapsedLabel(step: ProcessStep): string | undefined {
  const elapsed = numberValue(step.elapsedMs)
  if (elapsed === undefined || elapsed < 1000) return undefined
  return `${(elapsed / 1000).toFixed(elapsed >= 10_000 ? 0 : 1)}s`
}

export function TodoChecklist({ items }: { items: TodoChecklistItem[] }): JSX.Element {
  const done = items.filter((item) => item.status === 'completed').length
  return (
    <div className="agent-todo-list" role="list" aria-label="작업 계획">
      <div className="agent-todo-head">
        <span>할 일</span>
        <span className="agent-todo-progress">
          {done}/{items.length}
        </span>
      </div>
      {items.map((item, index) => (
        <div key={`${index}-${item.content}`} className={`agent-todo-item ${item.status}`} role="listitem">
          <span className="agent-todo-mark" aria-hidden="true">
            {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}
          </span>
          <span className="agent-todo-text">
            {item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ToolRow({
  step,
  expanded,
  onToggle
}: {
  step: ProcessStep
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const todos = todoChecklistFromStep(step)
  if (todos) {
    return (
      <div className="agent-tool-row todo">
        <TodoChecklist items={todos} />
      </div>
    )
  }

  const { name, arg, rawName } = toolStepDisplay(step)
  const status = processStepStatus(step)
  const elapsed = stepElapsedLabel(step)
  const hasDetails = Boolean(step.description || step.input || step.output || step.text || name !== rawName)
  return (
    <div className={`agent-tool-row ${status}`}>
      <button
        type="button"
        className="agent-tool-line"
        aria-expanded={expanded}
        disabled={!hasDetails}
        title={arg ? `${name} · ${arg}` : name}
        onClick={onToggle}
      >
        <span className={`agent-tool-dot ${status}`} aria-hidden="true" />
        <span className="agent-tool-label">
          <span className="agent-tool-name">{name}</span>
          {arg && <span className="agent-tool-arg"> · {arg}</span>}
        </span>
        <span className="agent-tool-meta">
          {status === 'running' && <span className="agent-tool-flag">실행 중</span>}
          {['done', 'completed', 'success'].includes(status) && <span className="agent-tool-flag">완료</span>}
          {status === 'paused' && <span className="agent-tool-flag">일시 중지</span>}
          {status === 'error' && <span className="agent-tool-flag error">실패</span>}
          {status === 'warning' && <span className="agent-tool-flag">주의</span>}
          {(status === 'cancelled' || status === 'canceled') && (
            <span className="agent-tool-flag">중지됨</span>
          )}
          {elapsed && <span className="agent-tool-elapsed">{elapsed}</span>}
          {hasDetails && (
            <span className={`agent-process-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
              ›
            </span>
          )}
        </span>
      </button>
      {expanded && hasDetails && (
        <div className="agent-tool-details">
          {step.description && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">작업 설명</span>
              <pre className="agent-process-step-text">{step.description}</pre>
            </div>
          )}
          {name !== rawName && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">{step.toolName ? '도구' : '항목'}</span>
              <pre className="agent-process-step-text">{rawName}</pre>
            </div>
          )}
          {step.input && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">입력</span>
              <pre className="agent-process-step-text">{step.input}</pre>
            </div>
          )}
          {step.output && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">출력</span>
              <pre className="agent-process-step-text">{step.output}</pre>
            </div>
          )}
          {step.text && step.text !== step.output && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">원문 내용</span>
              <pre className="agent-process-step-text">{step.text}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
