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
  'command',
  'pattern',
  'query',
  'url',
  'skill',
  'description',
  'prompt'
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
  const mcp = rawName.match(/^mcp__([^_]+)__(.+)$/)
  return toolNameLabels[rawName] ?? (mcp ? `${mcp[1]} · ${mcp[2]}` : rawName)
}

export function toolStepDisplay(step: ProcessStep): { name: string; arg?: string; rawName: string } {
  const rawName = step.toolName ?? step.title.replace(/^도구 · /, '')
  const name = toolDisplayName(rawName)
  const input = parsePreviewJson(step.input)
  if (input) {
    for (const key of TOOL_ARG_KEYS) {
      const value = stringValue(input[key])
      if (value) return { name, arg: clipArg(key === 'command' ? value : shortenPathLike(value)), rawName }
    }
    const todos = recordArray(input.todos)
    if (todos.length > 0) return { name, arg: `${todos.length}개 항목`, rawName }
  } else if (step.input && (rawName === 'Bash' || rawName === 'Shell')) {
    // Codex 계열은 inputPreview가 JSON이 아니라 `명령\n작업폴더` 평문으로 온다
    const command = step.input.split('\n', 1)[0]
    if (command.trim()) return { name, arg: clipArg(command), rawName }
  }
  if (!step.toolName && step.text) return { name, arg: clipArg(step.text), rawName }
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
  const status = step.status ?? 'running'
  const elapsed = stepElapsedLabel(step)
  const hasDetails = Boolean(step.input || step.output || step.text)
  const subAgent = isSubAgentStep(step)
  return (
    <div className={`agent-tool-row ${status}`}>
      <button
        type="button"
        className="agent-tool-line"
        aria-expanded={expanded}
        disabled={!hasDetails}
        title={name === rawName ? name : `${name} · ${rawName}`}
        onClick={onToggle}
      >
        <span className={`agent-tool-dot ${status}`} aria-hidden="true" />
        <span className="agent-tool-name">{name}</span>
        {arg && <span className="agent-tool-arg">({arg})</span>}
        <span className="agent-tool-meta">
          {subAgent && status === 'running' && <span className="agent-tool-flag">실행 중</span>}
          {subAgent && status === 'done' && <span className="agent-tool-flag">완료</span>}
          {status === 'error' && <span className="agent-tool-flag error">실패</span>}
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
          {name !== rawName && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">도구</span>
              <pre className="agent-process-step-text">{rawName}</pre>
            </div>
          )}
          {step.input && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">입력</span>
              <pre className="agent-process-step-text">{step.input}</pre>
            </div>
          )}
          {(step.output ?? step.text) && (
            <div className="agent-tool-detail">
              <span className="agent-tool-detail-label">{step.output ? '출력' : '내용'}</span>
              <pre className="agent-process-step-text">{step.output ?? step.text}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
