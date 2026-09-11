import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JsCase, JsParty, JsTodo, SshProfile, TodoCapabilities } from '../env'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'

import { compareTodos, filterTodos, kstDateKey, setTodoDate, todoTags, type TodoFilter } from '../../../shared/todoSummary'
import type { TodoSnapshot as SharedTodoSnapshot } from './useTodoSnapshot'
import { TodoSnapshotState } from './TodoSummary'
import TodoDetails, { TodoResolution } from './TodoDetails'
import CaseTaskReview from './CaseTaskReview'

const FILTERS: { value: TodoFilter; label: string }[] = [
  { value: 'open', label: '전체 열린 할일' }, { value: 'overdue', label: '기한 도과' },
  { value: 'overdue30', label: '30일 이상 도과' }, { value: 'undated', label: '기한 없음' },
  { value: 'undated60', label: '기한 없음·60일 이상' }, { value: 'stale30', label: '진행중·30일 이상 미갱신' },
  { value: 'review', label: '재확인 필요' }
]

const STATUS_OPTIONS = [
  { value: 'open', label: '열린 할일' },
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
  createdTodoId?: string
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
  if (!value.includes('T')) return kstDateKey(value) || value
  return `${kstDateKey(value)} ${d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}`
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
      relatedTodos: relatedDrafts
        .filter((draft) => !draft.createdTodoId)
        .map((draft) => ({
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

function TodosDashboardContent({
  nonce = 0,
  onChanged,
  onOpenWorkspace,
  onOpenDefault,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onPickRecords,
  onBrief,
  onAskClaudeTodoUpdate,
  onOpenEvidenceFile,
  snapshot, initialFilter = 'open', filterNonce = 0, onGlobalWork
}: {
  snapshot: SharedTodoSnapshot
  initialFilter?: TodoFilter
  filterNonce?: number
  onGlobalWork?: () => void
  nonce?: number
  onChanged?: () => void
  onOpenWorkspace?: (c: JsCase) => void
  onOpenDefault?: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onPickRecords?: (c: JsCase) => void | Promise<void>
  onBrief?: (c: JsCase) => void
  onAskClaudeTodoUpdate?: (prompt: string) => void
  onOpenEvidenceFile?: (path: string, label?: string) => void | Promise<void>
}): JSX.Element {
  const tokenReady = snapshot.hasToken
  const [history, setHistory] = useState<JsTodo[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('open')
  const [filter, setFilter] = useState<TodoFilter>(initialFilter)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [capabilities, setCapabilities] = useState<TodoCapabilities | null>(null)
  const [newDue, setNewDue] = useState('')
  const [newReview, setNewReview] = useState('')
  const [newPriority, setNewPriority] = useState('medium')
  const [resolution, setResolution] = useState<{ todo: JsTodo; action: 'complete' | 'close' } | null>(null)
  const [caseReview, setCaseReview] = useState<{ id: string; title: string } | null>(null)
  const [busyId, setBusyId] = useState('')
  const busyRef = useRef(false)
  const requestId = useRef(0)
  const todos = status === 'open' || status === 'pending' || status === 'in_progress' ? snapshot.todos : history
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

  const filteredTodos = useMemo(() => {
    const source = ['open', 'pending', 'in_progress'].includes(status) ? filterTodos(todos ?? [], filter).filter((todo) => status === 'open' || todo.status === status) : todos ?? []
    const q = search.trim().toLocaleLowerCase()
    return source.filter((todo) => !q || [todo.title, todo.caseNumber, todo.caseName, todo.client, todo.opponent, todo.partyNames].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)).slice().sort(compareTodos)
  }, [todos, filter, status, search])
  const groups = useMemo(() => {
    const result = new Map<string, JsTodo[]>()
    for (const todo of filteredTodos) { const key = todo.caseId || ''; result.set(key, [...(result.get(key) ?? []), todo]) }
    return [...result.entries()]
  }, [filteredTodos])
  const changeEntries = useMemo(() => Object.values(todoChanges), [todoChanges])
  const actionableChangeEntries = useMemo(
    () =>
      changeEntries.filter(
        (entry) =>
          entry.progressTexts.length > 0 ||
          !!entry.status ||
          !!entry.created ||
          entry.relatedDrafts.some((draft) => !draft.createdTodoId)
      ),
    [changeEntries]
  )
  const changeCount = actionableChangeEntries.length

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
    const s = opts?.nextStatus ?? status
    if (['open', 'pending', 'in_progress'].includes(s)) { snapshot.refresh(); return }
    const id = ++requestId.current
    setLoading(true); setErr('')
    void window.lt.todo.list({ status: s === 'all' ? undefined : s, includeArchived: s === 'all' }).then((r) => {
      if (id !== requestId.current) return
      if (!r.ok) throw new Error(r.error || '불러오기 실패')
      setHistory(r.todos ?? [])
    }).catch((e) => { if (id === requestId.current) setErr(String(e)) }).finally(() => { if (id === requestId.current) setLoading(false) })
  }
  useEffect(() => { setStatus('open'); setFilter(initialFilter) }, [initialFilter, filterNonce])
  useEffect(() => { if (!['open', 'pending', 'in_progress'].includes(status) && tokenReady) load() }, [status, nonce, tokenReady])
  useEffect(() => { if (tokenReady === false) { requestId.current++; setHistory(null); setCapabilities(null) } else if (tokenReady) void window.lt.todo.capabilities().then((r) => setCapabilities(r.ok ? r.capabilities ?? null : null)).catch(() => setCapabilities(null)) }, [tokenReady])
  const runMutation = async (id: string, fn: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusyId(id); setErr('')
    try { await fn() } catch (e) { setErr(String(e)) } finally { busyRef.current = false; setBusyId('') }
  }

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
    snapshot.refresh()
    if (!['open', 'pending', 'in_progress'].includes(status)) load()
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
    void runMutation('create', async () => { const r = await window.lt.todo.create({ title, dueDate: newDue ? setTodoDate(null, newDue) : undefined, ...(capabilities?.createFields.includes('reviewAt') && newReview ? { reviewAt: setTodoDate(null, newReview) } : {}), ...(capabilities?.createFields.includes('priority') ? { priority: newPriority } : {}) })
      if (!r.ok) {
        setErr(r.error ?? '추가 실패')
        return
      }
      if (r.todo) recordTodoChange(r.todo, { created: true })
      setNewTitle(''); setNewDue(''); setNewReview('')
      changed()
    })
  }

  const completeTodo = (todo: JsTodo): void => setResolution({ todo, action: 'complete' })

  const reopenTodo = (todo: JsTodo): void => {
    void runMutation(todo.id, async () => { const r = await window.lt.todo.update(todo.id, { status: 'pending' })
      if (!r.ok) setErr(r.error ?? '예정 변경 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'pending' }, { status: 'pending' })
        changed()
      }
    })
  }

  const startTodo = (todo: JsTodo): void => {
    void runMutation(todo.id, async () => { const r = await window.lt.todo.update(todo.id, { status: 'in_progress' })
      if (!r.ok) setErr(r.error ?? '진행중 변경 실패')
      else {
        recordTodoChange(r.todo ?? { ...todo, status: 'in_progress' }, { status: 'in_progress' })
        changed()
      }
    })
  }

  const archiveTodo = (todo: JsTodo): void => setResolution({ todo, action: 'close' })

  const appendProgress = (todo: JsTodo): void => {
    const text = progressDrafts[todo.id]?.trim()
    if (!text) return
    void runMutation(todo.id, async () => { const r = await window.lt.todo.appendProgress(todo.id, text)
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
    const source = snapshotTodo(todo)
    void runMutation(todo.id, async () => { const r = await window.lt.todo.create({
      title: text,
      caseId: todo.caseId || undefined,
      ...(capabilities?.createFields.includes('parentId') ? { parentId: todo.id } : {}),
      court: source.court ?? undefined,
      caseNumber: source.caseNumber ?? undefined,
      caseName: source.caseName ?? undefined,
      client: source.client ?? undefined,
      opponent: source.opponent ?? undefined,
      partyNames: source.partyNames ?? undefined,
      notes: caseNotesForRelated(source)
    })
      if (!r.ok || !r.todo) {
        setErr(r.error ?? '관련 할일 생성 실패')
        return
      }
      recordTodoChange(todo, {
        relatedDraft: { id: randomId('draft'), text, createdAt: new Date().toISOString(), createdTodoId: r.todo.id }
      })
      setRelatedInputs((drafts) => ({ ...drafts, [todo.id]: '' }))
      changed()
    })
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
    if (!actionableChangeEntries.length) return
    setPatchOpen(true)
    setPatchStatus('클코 응답 JSON을 붙여넣으면 적용할 수 있습니다.')
    onAskClaudeTodoUpdate?.(buildClaudeTodoPrompt(changeSetId, actionableChangeEntries))
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
      caseId: source.caseId || undefined,
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

      <fieldset className="todo-create" disabled={!!busyId}>
        <input
          className="todo-create-input"
          placeholder="새 할일"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitInput(e)) addTodo()
          }}
        />
        <button className="todo-primary" onClick={addTodo} disabled={!newTitle.trim() || !!busyId}>
          추가
        </button>
        <label>기한 <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} /></label>
        {capabilities?.createFields.includes('reviewAt') && <label>재확인 <input type="date" value={newReview} onChange={(e) => setNewReview(e.target.value)} /></label>}
        {capabilities?.createFields.includes('priority') && <label>중요도 <select value={newPriority} onChange={(e) => setNewPriority(e.target.value)}><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select></label>}
        {!newDue && !newReview && <span className="todo-warning">기한·재확인일 없이 추가됩니다.</span>}
      </fieldset>

      <div className="todo-tabs" aria-label="할일 상태">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            aria-pressed={status === option.value}
            className={`todo-tab ${status === option.value ? 'on' : ''}`}
            onClick={() => {
              setStatus(option.value)
              setErr('')
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {['open', 'pending', 'in_progress'].includes(status) && <div className="todo-filters" aria-label="열린 할일 필터">{FILTERS.map((option) => <button key={option.value} className={`todo-tab ${filter === option.value ? 'on' : ''}`} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}</div>}
      <div className="todo-filter-count">표시 {filteredTodos.length}건 {onGlobalWork && <button className="todo-small" onClick={onGlobalWork}>전체 할일 정리 시작</button>}</div>
      <TodoSnapshotState snapshot={snapshot} />
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
      {todos && filteredTodos.length === 0 && !loading && !snapshot.loading && !snapshot.error && !err && (
        <p className="muted pad">표시할 할일이 없습니다.</p>
      )}

      <div className="dash-list todo-list">
        {groups.map(([caseId, groupTodos]) => <section className="todo-group" key={caseId || 'unlinked'}>
          <div className="todo-group-heading"><button className="todo-group-toggle" aria-expanded={!collapsed[caseId]} onClick={() => setCollapsed({ ...collapsed, [caseId]: !collapsed[caseId] })}>{collapsed[caseId] ? '▸' : '▾'} {caseId ? todoCaseTitle(groupTodos[0]) || '사건' : '사건 미연결'} · {groupTodos.length}건</button>{caseId && (capabilities?.caseClosure || capabilities?.createFields.includes('type')) && <button className="todo-small" onClick={() => setCaseReview({ id: caseId, title: todoCaseTitle(groupTodos[0]) || '사건' })}>사건 관리·메모</button>}</div>
          {!collapsed[caseId] && <div className="todo-group-cards">{groupTodos.map((todo) => {
          const recent = todo.progress?.[todo.progress.length - 1]
          const progressDraft = progressDrafts[todo.id] ?? ''
          const relatedInput = relatedInputs[todo.id] ?? ''
          const relatedDrafts = todoChanges[todo.id]?.relatedDrafts ?? []
          const caseContext = todoToCase(todo)
          const caseTitle = todoCaseTitle(todo)
          return (
            <fieldset
              key={todo.id}
              disabled={!!busyId}
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
              <div className="todo-tags">{todoTags(todo).map((tag) => <span key={tag}>{tag}</span>)}</div>
              {caseContext && <button className="todo-small" onClick={(e) => { e.stopPropagation(); openDefault(todo) }}>사건 작업환경 열기</button>}
              <div className="todo-meta">
                {todo.dueDate && <span>기한 {fmtDate(todo.dueDate)}</span>}
                {todo.reviewAt && <span>재확인 {fmtDate(todo.reviewAt)}</span>}
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
                  placeholder={capabilities?.createFields.includes('parentId') ? '같은 산출물의 자식 할일' : '관련 추가할일'}
                  value={relatedInput}
                  onChange={(e) =>
                    setRelatedInputs((drafts) => ({ ...drafts, [todo.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (shouldSubmitInput(e)) addRelatedDraft(todo)
                  }}
                />
                <button className="todo-small" onClick={() => addRelatedDraft(todo)} disabled={!relatedInput.trim()}>
                  {capabilities?.createFields.includes('parentId') ? '자식 추가' : '추가'}
                </button>
              </div>
              {relatedInput && <p className="todo-warning">추가할 할일에는 기한이 없습니다. 다른 기한·산출물은 별도 할일로 추가하세요.</p>}
              <TodoDetails todo={todo} parentTitle={snapshot.todos?.find((parent) => parent.id === todo.parentId)?.title} capabilities={capabilities} onOpenEvidenceFile={onOpenEvidenceFile} onChanged={changed} onComplete={() => completeTodo(todo)} />
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
            </fieldset>
          )
        })}</div>}</section>)}
      </div>

      {resolution && <TodoResolution todo={resolution.todo} action={resolution.action} progressText={progressDrafts[resolution.todo.id]?.trim() || undefined} onClose={() => setResolution(null)} onSaved={(saved) => {
        const nextStatus = resolution.action === 'complete' ? 'completed' : 'closed'
        recordTodoChange(saved ?? { ...resolution.todo, status: nextStatus }, { status: nextStatus, progressText: progressDrafts[resolution.todo.id]?.trim() })
        setProgressDrafts((drafts) => ({ ...drafts, [resolution.todo.id]: '' })); setResolution(null); changed()
      }} />}
      {caseReview && <CaseTaskReview closureSupported={capabilities?.caseClosure ?? false} caseId={caseReview.id} title={caseReview.title} onClose={() => setCaseReview(null)} onChanged={changed} />}
      {menu && onOpenWorkspace && (
        <CaseContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenWorkspace={onOpenWorkspace}
          onOpenRemote={onOpenRemote}
          sshProfiles={sshProfiles}
          defaultOpenProfileId={defaultOpenProfileId}
          onPickRecords={onPickRecords}
          onBrief={onBrief ?? (() => {})}
        />
      )}
    </div>
  )
}

// Remount account-owned history, drafts and dialogs together when credentials change.
export default function TodosDashboard(props: Parameters<typeof TodosDashboardContent>[0]): JSX.Element {
  const [account, setAccount] = useState(0)
  useEffect(() => {
    const reset = (): void => setAccount((value) => value + 1)
    window.addEventListener('lt-js-token-updated', reset)
    return () => window.removeEventListener('lt-js-token-updated', reset)
  }, [])
  return <TodosDashboardContent key={account} {...props} />
}
