import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { JsCase, JsParty, JsTodo, SshProfile } from '../env'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'

const STATUS_OPTIONS = [
  { value: 'pending', label: '예정' },
  { value: 'in_progress', label: '진행중' },
  { value: 'completed', label: '완료' },
  { value: 'all', label: '전체' }
]

const PATCH_STATUSES = new Set(['pending', 'in_progress', 'completed', 'closed'])
const PATCH_PRIORITIES = new Set(['low', 'medium', 'high'])

interface RelatedTodoDraft {
  id: string
  text: string
  createdAt: string
}

interface TodoSnapshot {
  id: string
  title: string
  status: string
  priority?: string | null
  dueDate?: string | null
  court?: string | null
  caseNumber?: string | null
  caseName?: string | null
  client?: string | null
  opponent?: string | null
  partyNames?: string | null
  recentProgress?: string | null
}

interface TodoChangeEntry {
  snapshot: TodoSnapshot
  progressTexts: string[]
  status?: string
  created?: boolean
  relatedDrafts: RelatedTodoDraft[]
  updatedAt: string
}

interface TodoPatch {
  changeSetId?: string
  operations: TodoPatchOperation[]
}

type TodoPatchOperation =
  | { type: 'append_progress'; todoId: string; text: string }
  | { type: 'set_status'; todoId: string; status: string }
  | {
      type: 'create_related_todo'
      sourceTodoId: string
      title: string
      dueDate?: string | null
      priority?: string
      notes?: string
    }
  | {
      type: 'update_todo'
      todoId: string
      title?: string
      dueDate?: string | null
      priority?: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null
  return stringValue(value)
}

function isImeComposing(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}

function shouldSubmitInput(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.key === 'Enter' && !isImeComposing(e)
}

function statusKo(status: string): string {
  return (
    {
      open: '예정',
      pending: '예정',
      in_progress: '진행중',
      done: '완료',
      completed: '완료',
      archived: '종료',
      closed: '종료'
    }[status] ?? status
  )
}

function priorityKo(priority?: string | null): string {
  if (!priority) return ''
  return { low: '낮음', normal: '보통', medium: '보통', high: '높음' }[priority] ?? priority
}

function fmtDate(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
}

function todoSort(a: JsTodo, b: JsTodo): number {
  if (a.status !== b.status) {
    const rank = { pending: 0, open: 0, in_progress: 1, completed: 2, done: 2, closed: 3, archived: 3 }
    return (rank[a.status as keyof typeof rank] ?? 9) - (rank[b.status as keyof typeof rank] ?? 9)
  }
  const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY
  const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY
  if (dueA !== dueB) return dueA - dueB
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

function namesFrom(value?: string | null): string[] {
  return (value ?? '')
    .split(/[,/]/)
    .map((name) => name.trim())
    .filter(Boolean)
}

function todoParties(todo: JsTodo): JsParty[] {
  const parties: JsParty[] = []
  for (const name of namesFrom(todo.client)) {
    parties.push({ role: 'client', position: null, party: { name, type: 'person' } })
  }
  for (const name of namesFrom(todo.opponent)) {
    parties.push({ role: 'opponent', position: null, party: { name, type: 'person' } })
  }
  if (parties.length === 0) {
    for (const name of namesFrom(todo.partyNames)) {
      parties.push({ role: 'client', position: null, party: { name, type: 'person' } })
    }
  }
  return parties
}

function todoToCase(todo: JsTodo): JsCase | null {
  const hasCase =
    !!todo.caseId ||
    !!todo.court ||
    !!todo.caseNumber ||
    !!todo.caseName ||
    !!todo.client ||
    !!todo.opponent ||
    !!todo.partyNames
  if (!hasCase) return null
  return {
    id: todo.caseId ?? '',
    court: todo.court ?? null,
    caseNumber: todo.caseNumber ?? null,
    caseName: todo.caseName ?? null,
    division: null,
    caseType: null,
    status: 'active',
    parties: todoParties(todo),
    hearings: []
  }
}

function todoCaseTitle(todo: JsTodo): string {
  return [todo.court, todo.caseNumber, todo.caseName, todo.partyNames ?? todo.client]
    .filter(Boolean)
    .join(' · ')
}

function snapshotTodo(todo: JsTodo): TodoSnapshot {
  const recent = todo.progress?.[todo.progress.length - 1]
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    dueDate: todo.dueDate,
    court: todo.court,
    caseNumber: todo.caseNumber,
    caseName: todo.caseName,
    client: todo.client,
    opponent: todo.opponent,
    partyNames: todo.partyNames,
    recentProgress: recent?.text ?? null
  }
}

function buildClaudeTodoPrompt(changeSetId: string, changes: TodoChangeEntry[]): string {
  const promptTodos = changes.map((entry) => {
    const { relatedDrafts, ...rest } = entry
    return {
      ...rest,
      relatedTodos: relatedDrafts.map((draft) => ({
        text: draft.text,
        createdAt: draft.createdAt
      }))
    }
  })
  const payload = {
    changeSetId,
    generatedAt: new Date().toISOString(),
    scope: 'changed_todos_only',
    todos: promptTodos
  }
  return [
    'JuriSupport 할일 갱신 요청입니다.',
    '',
    '중요:',
    '- 전체 할일을 조회하지 말고 아래 changeSet에 포함된 할일만 기준으로 판단해줘.',
    '- progressTexts는 이미 JuriSupport 할일 본문에 저장된 오늘 진행 기록이므로 같은 내용을 다시 append_progress 하지 마.',
    '- relatedTodos는 아직 저장되지 않은 관련 추가할일이야. 필요하면 create_related_todo 작업으로 만들어줘.',
    '- 사건 식별은 법원, 사건번호, 사건명, 당사자 이름만 사용해. UUID나 내부 사건 id를 새 할일 제목/본문에 넣지 마.',
    '',
    '반환 형식:',
    '- 설명 없이 JSON fenced block 하나만 반환해.',
    '- 허용 작업은 append_progress, set_status, create_related_todo, update_todo 뿐이야.',
    '- replace_content 같은 본문 전체 교체 작업은 사용하지 마.',
    '',
    '예시:',
    '```json',
    JSON.stringify(
      {
        changeSetId,
        operations: [
          { type: 'set_status', todoId: 'todo-id', status: 'in_progress' },
          {
            type: 'create_related_todo',
            sourceTodoId: 'todo-id',
            title: '추가 확인사항 정리',
            dueDate: '2026-06-09',
            priority: 'medium',
            notes: '필요한 보충 메모'
          }
        ]
      },
      null,
      2
    ),
    '```',
    '',
    'changeSet:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```'
  ].join('\n')
}

function parsePatchOperation(value: unknown): TodoPatchOperation | null {
  if (!isRecord(value)) return null
  const type = stringValue(value.type)
  if (type === 'append_progress') {
    const todoId = stringValue(value.todoId)
    const text = stringValue(value.text)
    return todoId && text ? { type, todoId, text } : null
  }
  if (type === 'set_status') {
    const todoId = stringValue(value.todoId)
    const nextStatus = stringValue(value.status)
    return todoId && nextStatus && PATCH_STATUSES.has(nextStatus)
      ? { type, todoId, status: nextStatus }
      : null
  }
  if (type === 'create_related_todo') {
    const sourceTodoId = stringValue(value.sourceTodoId)
    const title = stringValue(value.title)
    if (!sourceTodoId || !title) return null
    const priority = stringValue(value.priority)
    return {
      type,
      sourceTodoId,
      title,
      dueDate: nullableStringValue(value.dueDate),
      priority: priority && PATCH_PRIORITIES.has(priority) ? priority : undefined,
      notes: stringValue(value.notes)
    }
  }
  if (type === 'update_todo') {
    const todoId = stringValue(value.todoId)
    if (!todoId) return null
    const priority = stringValue(value.priority)
    const op: TodoPatchOperation = {
      type,
      todoId,
      title: stringValue(value.title),
      dueDate: nullableStringValue(value.dueDate),
      priority: priority && PATCH_PRIORITIES.has(priority) ? priority : undefined
    }
    return op.title !== undefined || op.dueDate !== undefined || op.priority !== undefined ? op : null
  }
  return null
}

function parseClaudePatch(raw: string): TodoPatch {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = (fenced?.[1] ?? raw).trim()
  const parsed = JSON.parse(text) as unknown
  const root = Array.isArray(parsed) ? { operations: parsed } : parsed
  if (!isRecord(root) || !Array.isArray(root.operations)) throw new Error('operations 배열이 없습니다.')
  const operations = root.operations.map(parsePatchOperation)
  if (operations.some((op) => !op)) throw new Error('지원하지 않는 패치 작업이 있습니다.')
  return {
    changeSetId: stringValue(root.changeSetId),
    operations: operations as TodoPatchOperation[]
  }
}

function caseNotesForRelated(source: TodoSnapshot, notes?: string): string {
  return [
    '[관련 할일]',
    `원 할일: ${source.title || '(제목 없음)'}`,
    notes?.trim() ? '' : undefined,
    notes?.trim()
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

export default function TodosDashboard({
  nonce = 0,
  onChanged,
  onOpenWorkspace,
  onOpenDefault,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft,
  onAskClaudeTodoUpdate
}: {
  nonce?: number
  onChanged?: () => void
  onOpenWorkspace?: (c: JsCase) => void
  onOpenDefault?: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief?: (c: JsCase) => void
  onDraft?: (c: JsCase) => void
  onAskClaudeTodoUpdate?: (prompt: string) => void
}): JSX.Element {
  const [tokenReady, setTokenReady] = useState<boolean | null>(null)
  const [todos, setTodos] = useState<JsTodo[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('pending')
  const [newTitle, setNewTitle] = useState('')
  const [progressDrafts, setProgressDrafts] = useState<Record<string, string>>({})
  const [relatedInputs, setRelatedInputs] = useState<Record<string, string>>({})
  const [todoChanges, setTodoChanges] = useState<Record<string, TodoChangeEntry>>({})
  const [changeSetId, setChangeSetId] = useState(() => randomId('todo-cs'))
  const [patchOpen, setPatchOpen] = useState(false)
  const [patchText, setPatchText] = useState('')
  const [patchStatus, setPatchStatus] = useState('')
  const [applyingPatch, setApplyingPatch] = useState(false)
  const [menu, setMenu] = useState<CaseContextMenuState | null>(null)
  const defaultOpenProfile = defaultOpenProfileId
    ? sshProfiles.find((p) => p.id === defaultOpenProfileId)
    : undefined

  const filteredTodos = useMemo(() => (todos ?? []).slice().sort(todoSort), [todos])
  const changeEntries = useMemo(() => Object.values(todoChanges), [todoChanges])
  const changeCount = changeEntries.length

  const openDefault = (todo: JsTodo): void => {
    const c = todoToCase(todo)
    if (!c) return
    if (onOpenDefault) {
      onOpenDefault(c)
      return
    }
    if (!onOpenWorkspace) return
    if (defaultOpenProfile && onOpenRemote) onOpenRemote(c, defaultOpenProfile)
    else onOpenWorkspace(c)
  }

  const load = (opts?: { nextSearch?: string; nextStatus?: string }): void => {
    const q = opts?.nextSearch ?? search
    const s = opts?.nextStatus ?? status
    setLoading(true)
    setErr('')
    window.lt.todo
      .list({
        search: q.trim() || undefined,
        status: s === 'all' ? undefined : s
      })
      .then((r) => {
        if (r.ok) {
          setTodos(r.todos ?? [])
        } else {
          setErr(r.error ?? '불러오기 실패')
        }
      })
      .catch((error) => setErr(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    window.lt.js
      .hasToken()
      .then((has) => {
        setTokenReady(has)
        if (has) load()
        else {
          setErr('JuriSupport 토큰이 설정되지 않았습니다.')
          setTodos([])
        }
      })
      .catch((error) => {
        setTokenReady(false)
        setErr(error instanceof Error ? error.message : String(error))
        setTodos([])
      })
  }, [])

  useEffect(() => {
    if (tokenReady) load()
  }, [nonce])

  useEffect(() => {
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  const changed = (): void => {
    onChanged?.()
    load()
  }

  const recordTodoChange = (
    todo: JsTodo,
    patch: Partial<Pick<TodoChangeEntry, 'status' | 'created'>> & {
      progressText?: string
      relatedDraft?: RelatedTodoDraft
    }
  ): void => {
    const snapshot = snapshotTodo(todo)
    setTodoChanges((prev) => {
      const current: TodoChangeEntry =
        prev[todo.id] ?? {
          snapshot,
          progressTexts: [],
          relatedDrafts: [],
          updatedAt: new Date().toISOString()
        }
      return {
        ...prev,
        [todo.id]: {
          ...current,
          snapshot: { ...current.snapshot, ...snapshot, status: patch.status ?? snapshot.status },
          progressTexts: patch.progressText
            ? [...current.progressTexts, patch.progressText]
            : current.progressTexts,
          relatedDrafts: patch.relatedDraft
            ? [...current.relatedDrafts, patch.relatedDraft]
            : current.relatedDrafts,
          status: patch.status ?? current.status,
          created: patch.created ?? current.created,
          updatedAt: new Date().toISOString()
        }
      }
    })
  }

  const addTodo = (): void => {
    const title = newTitle.trim()
    if (!title) return
    setErr('')
    window.lt.todo.create({ title }).then((r) => {
      if (!r.ok) {
        setErr(r.error ?? '추가 실패')
        return
      }
      if (r.todo) recordTodoChange(r.todo, { created: true })
      setNewTitle('')
      changed()
    })
  }

  const completeTodo = (todo: JsTodo): void => {
    const progressText = progressDrafts[todo.id]?.trim() || undefined
    window.lt.todo.complete(todo.id, progressText).then((r) => {
      if (!r.ok) setErr(r.error ?? '완료 처리 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'completed' }, {
          status: 'completed',
          progressText
        })
        setProgressDrafts((drafts) => ({ ...drafts, [todo.id]: '' }))
        changed()
      }
    })
  }

  const reopenTodo = (todo: JsTodo): void => {
    window.lt.todo.update(todo.id, { status: 'pending' }).then((r) => {
      if (!r.ok) setErr(r.error ?? '예정 변경 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'pending' }, { status: 'pending' })
        changed()
      }
    })
  }

  const startTodo = (todo: JsTodo): void => {
    window.lt.todo.update(todo.id, { status: 'in_progress' }).then((r) => {
      if (!r.ok) setErr(r.error ?? '진행중 변경 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'in_progress' }, { status: 'in_progress' })
        changed()
      }
    })
  }

  const archiveTodo = (todo: JsTodo): void => {
    window.lt.todo.archive(todo.id).then((r) => {
      if (!r.ok) setErr(r.error ?? '종료 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'closed' }, { status: 'closed' })
        changed()
      }
    })
  }

  const appendProgress = (todo: JsTodo): void => {
    const text = progressDrafts[todo.id]?.trim()
    if (!text) return
    window.lt.todo.appendProgress(todo.id, text).then((r) => {
      if (!r.ok) {
        setErr(r.error ?? '진행 기록 실패')
        return
      }
      recordTodoChange(r.todo ?? todo, { progressText: text })
      setProgressDrafts((drafts) => ({ ...drafts, [todo.id]: '' }))
      changed()
    })
  }

  const addRelatedDraft = (todo: JsTodo): void => {
    const text = relatedInputs[todo.id]?.trim()
    if (!text) return
    const currentDrafts = todoChanges[todo.id]?.relatedDrafts ?? []
    if (currentDrafts.some((draft) => draft.text === text)) return
    recordTodoChange(todo, {
      relatedDraft: { id: randomId('draft'), text, createdAt: new Date().toISOString() }
    })
    setRelatedInputs((drafts) => ({ ...drafts, [todo.id]: '' }))
  }

  const removeRelatedDraft = (todo: JsTodo, draftId: string): void => {
    setTodoChanges((prev) => {
      const current = prev[todo.id]
      if (!current) return prev
      const nextDrafts = current.relatedDrafts.filter((draft) => draft.id !== draftId)
      if (
        nextDrafts.length === 0 &&
        current.progressTexts.length === 0 &&
        !current.status &&
        !current.created
      ) {
        const { [todo.id]: _removed, ...rest } = prev
        return rest
      }
      return {
        ...prev,
        [todo.id]: { ...current, relatedDrafts: nextDrafts, updatedAt: new Date().toISOString() }
      }
    })
  }

  const askClaudeTodoUpdate = (): void => {
    if (!changeEntries.length) return
    setPatchOpen(true)
    setPatchStatus('클코 응답 JSON을 붙여넣으면 적용할 수 있습니다.')
    onAskClaudeTodoUpdate?.(buildClaudeTodoPrompt(changeSetId, changeEntries))
  }

  const applyPatchOperation = async (op: TodoPatchOperation): Promise<void> => {
    if (op.type === 'append_progress') {
      const r = await window.lt.todo.appendProgress(op.todoId, op.text)
      if (!r.ok) throw new Error(r.error ?? '진행 기록 실패')
      return
    }
    if (op.type === 'set_status') {
      const r = await window.lt.todo.update(op.todoId, { status: op.status })
      if (!r.ok) throw new Error(r.error ?? '상태 변경 실패')
      return
    }
    if (op.type === 'update_todo') {
      const patch = {
        title: op.title,
        dueDate: op.dueDate,
        priority: op.priority
      }
      const r = await window.lt.todo.update(op.todoId, patch)
      if (!r.ok) throw new Error(r.error ?? '할일 수정 실패')
      return
    }
    const source =
      (todos ?? []).find((todo) => todo.id === op.sourceTodoId) ??
      (todoChanges[op.sourceTodoId]
        ? ({ ...todoChanges[op.sourceTodoId].snapshot } as JsTodo)
        : null)
    if (!source) throw new Error(`원 할일을 찾을 수 없습니다: ${op.sourceTodoId}`)
    const sourceSnapshot = snapshotTodo(source)
    const r = await window.lt.todo.create({
      title: op.title,
      dueDate: op.dueDate ?? undefined,
      priority: op.priority,
      court: sourceSnapshot.court ?? undefined,
      caseNumber: sourceSnapshot.caseNumber ?? undefined,
      caseName: sourceSnapshot.caseName ?? undefined,
      client: sourceSnapshot.client ?? undefined,
      opponent: sourceSnapshot.opponent ?? undefined,
      partyNames: sourceSnapshot.partyNames ?? undefined,
      notes: caseNotesForRelated(sourceSnapshot, op.notes)
    })
    if (!r.ok) throw new Error(r.error ?? '관련 할일 생성 실패')
  }

  const applyClaudePatch = (): void => {
    setErr('')
    setPatchStatus('')
    let patch: TodoPatch
    try {
      patch = parseClaudePatch(patchText)
      if (patch.changeSetId && patch.changeSetId !== changeSetId) {
        setPatchStatus('changeSetId가 현재 변경분과 다릅니다.')
        return
      }
    } catch (error) {
      setPatchStatus(error instanceof Error ? error.message : String(error))
      return
    }
    if (!patch.operations.length) {
      setPatchStatus('적용할 작업이 없습니다.')
      return
    }
    setApplyingPatch(true)
    void (async () => {
      try {
        for (const op of patch.operations) await applyPatchOperation(op)
        setTodoChanges({})
        setChangeSetId(randomId('todo-cs'))
        setPatchText('')
        setPatchOpen(false)
        setPatchStatus(`${patch.operations.length}개 작업을 적용했습니다.`)
        changed()
      } catch (error) {
        setPatchStatus(error instanceof Error ? error.message : String(error))
      } finally {
        setApplyingPatch(false)
      }
    })()
  }

  return (
    <div className="dash todo-dash">
      <div className="dash-bar todo-bar">
        <input
          className="dash-search"
          placeholder="할일·사건·의뢰인 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitInput(e)) load()
          }}
        />
        <button className="dash-btn todo-refresh" title="검색" onClick={() => load()}>
          검색
        </button>
        <button
          className="dash-btn todo-rebuild"
          title="할일 다시 만들기"
          onClick={askClaudeTodoUpdate}
          disabled={!changeCount}
        >
          할일 다시 만들기{changeCount ? ` ${changeCount}` : ''}
        </button>
        <button className="dash-btn todo-patch-toggle" title="패치 적용" onClick={() => setPatchOpen(true)}>
          패치 적용
        </button>
      </div>

      <div className="todo-create">
        <input
          className="todo-create-input"
          placeholder="새 할일"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitInput(e)) addTodo()
          }}
        />
        <button className="todo-primary" onClick={addTodo} disabled={!newTitle.trim()}>
          추가
        </button>
      </div>

      <div className="todo-tabs" role="tablist">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`todo-tab ${status === option.value ? 'on' : ''}`}
            onClick={() => {
              setStatus(option.value)
              load({ nextStatus: option.value })
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {(patchOpen || patchStatus) && (
        <div className="todo-patch-panel">
          <textarea
            className="todo-patch-input"
            placeholder="클코 JSON 패치"
            value={patchText}
            onChange={(e) => setPatchText(e.target.value)}
          />
          <div className="todo-patch-actions">
            <span className="todo-patch-status">{patchStatus}</span>
            <button className="todo-small" onClick={() => setPatchOpen(false)}>
              닫기
            </button>
            <button
              className="todo-primary"
              onClick={applyClaudePatch}
              disabled={!patchText.trim() || applyingPatch}
            >
              패치 적용
            </button>
          </div>
        </div>
      )}

      {tokenReady === false && (
        <p className="dash-err pad">오류: {err || 'JuriSupport 연결이 필요합니다.'}</p>
      )}
      {loading && !todos && <p className="muted pad">불러오는 중...</p>}
      {err && tokenReady !== false && <p className="dash-err pad">오류: {err}</p>}
      {todos && filteredTodos.length === 0 && !loading && (
        <p className="muted pad">표시할 할일이 없습니다.</p>
      )}

      <div className="dash-list todo-list">
        {filteredTodos.map((todo) => {
          const recent = todo.progress?.[todo.progress.length - 1]
          const progressDraft = progressDrafts[todo.id] ?? ''
          const relatedInput = relatedInputs[todo.id] ?? ''
          const relatedDrafts = todoChanges[todo.id]?.relatedDrafts ?? []
          const caseContext = todoToCase(todo)
          const caseTitle = todoCaseTitle(todo)
          return (
            <div
              key={todo.id}
              className={`todo-card todo-${todo.status} ${caseContext ? 'has-case' : ''}`}
              onClick={() => openDefault(todo)}
              onContextMenu={(e) => {
                if (!caseContext) return
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, c: caseContext })
              }}
              title={caseContext ? '클릭 → 작업환경 열기 · 우클릭 → 메뉴' : todo.title}
            >
              <div className="todo-top">
                <span className={`todo-status st-${todo.status}`}>{statusKo(todo.status)}</span>
                {caseTitle && <span className="todo-case-context">{caseTitle}</span>}
              </div>
              <div className="todo-title">{todo.title || '(제목 없음)'}</div>
              <div className="todo-meta">
                {todo.dueDate && <span>기한 {fmtDate(todo.dueDate)}</span>}
                {todo.priority && <span>중요도 {priorityKo(todo.priority)}</span>}
                {todo.court && <span>{todo.court}</span>}
                {todo.caseNumber && <span>{todo.caseNumber}</span>}
                {todo.caseName && <span>{todo.caseName}</span>}
                {todo.client && <span>의뢰인 {todo.client}</span>}
                {todo.opponent && <span>상대 {todo.opponent}</span>}
                {!todo.client && !todo.opponent && todo.partyNames && <span>당사자 {todo.partyNames}</span>}
              </div>
              {recent && <div className="todo-recent">{recent.text}</div>}
              <div className="todo-progress-row" onClick={(e) => e.stopPropagation()}>
                <input
                  className="todo-progress-input"
                  placeholder="오늘 진행 내용"
                  value={progressDraft}
                  onChange={(e) =>
                    setProgressDrafts((drafts) => ({ ...drafts, [todo.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (shouldSubmitInput(e)) appendProgress(todo)
                  }}
                />
                <button className="todo-small" onClick={() => appendProgress(todo)} disabled={!progressDraft.trim()}>
                  기록
                </button>
              </div>
              <div className="todo-progress-row" onClick={(e) => e.stopPropagation()}>
                <input
                  className="todo-progress-input"
                  placeholder="관련 추가할일"
                  value={relatedInput}
                  onChange={(e) =>
                    setRelatedInputs((drafts) => ({ ...drafts, [todo.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (shouldSubmitInput(e)) addRelatedDraft(todo)
                  }}
                />
                <button className="todo-small" onClick={() => addRelatedDraft(todo)} disabled={!relatedInput.trim()}>
                  담기
                </button>
              </div>
              {relatedDrafts.length > 0 && (
                <div className="todo-related-list" onClick={(e) => e.stopPropagation()}>
                  {relatedDrafts.map((draft) => (
                    <span key={draft.id} className="todo-related-pill">
                      {draft.text}
                      <button onClick={() => removeRelatedDraft(todo, draft.id)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="todo-actions" onClick={(e) => e.stopPropagation()}>
                {todo.status === 'completed' || todo.status === 'done' ? (
                  <button className="todo-small" onClick={() => reopenTodo(todo)}>
                    예정으로
                  </button>
                ) : (
                  <>
                    {(todo.status === 'pending' || todo.status === 'open') && (
                      <button className="todo-small" onClick={() => startTodo(todo)}>
                        진행중
                      </button>
                    )}
                    <button className="todo-small good" onClick={() => completeTodo(todo)}>
                      완료
                    </button>
                  </>
                )}
                {todo.status !== 'archived' && todo.status !== 'closed' && (
                  <button className="todo-small" onClick={() => archiveTodo(todo)}>
                    종료
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {menu && onOpenWorkspace && (
        <CaseContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenWorkspace={onOpenWorkspace}
          onOpenRemote={onOpenRemote}
          sshProfiles={sshProfiles}
          defaultOpenProfileId={defaultOpenProfileId}
          onBrief={onBrief ?? (() => {})}
          onDraft={onDraft ?? (() => {})}
        />
      )}
    </div>
  )
}
