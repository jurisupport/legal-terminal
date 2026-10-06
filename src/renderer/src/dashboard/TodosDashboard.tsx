import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JsCase, JsParty, JsTodo, SshProfile, TodoCapabilities } from '../env'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'

import { compareTodos, filterTodos, kstDateKey, setTodoDate, todoTags, type TodoFilter } from '../../../shared/todoSummary'
import type { TodoSnapshot as SharedTodoSnapshot } from './useTodoSnapshot'
import { TodoSnapshotState } from './TodoSummary'
import TodoDetails, { TodoResolution } from './TodoDetails'
import CaseTaskReview from './CaseTaskReview'
import BulkTodoClosure from './BulkTodoClosure'

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
  { value: 'closed', label: '종료' },
  { value: 'all', label: '전체' }
]

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
  onManageTodos,
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
  onManageTodos?: (todos: JsTodo[]) => void
  onOpenEvidenceFile?: (path: string, label?: string) => void | Promise<void>
}): JSX.Element {
  const tokenReady = snapshot.hasToken
  const [history, setHistory] = useState<{ status: string; todos: JsTodo[] } | null>(null)
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
  const [bulkTodos, setBulkTodos] = useState<JsTodo[] | null>(null)
  const [caseReview, setCaseReview] = useState<{ id: string; title: string } | null>(null)
  const [busyId, setBusyId] = useState('')
  const busyRef = useRef(false)
  const requestId = useRef(0)
  const todos = status === 'open' || status === 'pending' || status === 'in_progress' ? snapshot.todos : history?.status === status ? history.todos : null
  const [newTitle, setNewTitle] = useState('')
  const [progressDrafts, setProgressDrafts] = useState<Record<string, string>>({})
  const [relatedInputs, setRelatedInputs] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<CaseContextMenuState | null>(null)
  const defaultOpenProfile = defaultOpenProfileId
    ? sshProfiles.find((p) => p.id === defaultOpenProfileId)
    : undefined

  const filteredTodos = useMemo(() => {
    const source = ['open', 'pending', 'in_progress'].includes(status) ? filterTodos(todos ?? [], filter).filter((todo) => status === 'open' || todo.status === status) : todos ?? []
    const q = search.trim().toLocaleLowerCase()
    return source.filter((todo) => (!todo.type || todo.type === 'todo') &&
      (status !== 'completed' || ['completed', 'done'].includes(todo.status)) &&
      (status !== 'closed' || ['closed', 'archived'].includes(todo.status)) &&
      (!q || [todo.title, todo.caseNumber, todo.caseName, todo.client, todo.opponent, todo.partyNames].filter(Boolean).join(' ').toLocaleLowerCase().includes(q))).slice().sort(compareTodos)
  }, [todos, filter, status, search])
  const groups = useMemo(() => {
    const result = new Map<string, JsTodo[]>()
    for (const todo of filteredTodos) { const key = todo.caseId || ''; result.set(key, [...(result.get(key) ?? []), todo]) }
    return [...result.entries()]
  }, [filteredTodos])
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
    void window.lt.todo.list({ status: s === 'all' ? undefined : s, includeArchived: s === 'all' || s === 'closed' }).then((r) => {
      if (id !== requestId.current) return
      if (!r.ok) throw new Error(r.error || '불러오기 실패')
      setHistory({ status: s, todos: r.todos ?? [] })
    }).catch((e) => { if (id === requestId.current) setErr(String(e)) }).finally(() => { if (id === requestId.current) setLoading(false) })
  }
  useEffect(() => { requestId.current++; setHistory(null); setLoading(false); setStatus('open'); setFilter(initialFilter) }, [initialFilter, filterNonce])
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

  const addTodo = (): void => {
    const title = newTitle.trim()
    if (!title) return
    setErr('')
    void runMutation('create', async () => { const r = await window.lt.todo.create({ title, dueDate: newDue ? setTodoDate(null, newDue) : undefined, ...(capabilities?.createFields.includes('reviewAt') && newReview ? { reviewAt: setTodoDate(null, newReview) } : {}), ...(capabilities?.createFields.includes('priority') ? { priority: newPriority } : {}) })
      if (!r.ok) {
        setErr(r.error ?? '추가 실패')
        return
      }
      setNewTitle(''); setNewDue(''); setNewReview('')
      changed()
    })
  }

  const completeTodo = (todo: JsTodo): void => setResolution({ todo, action: 'complete' })

  const reopenTodo = (todo: JsTodo): void => {
    void runMutation(todo.id, async () => { const r = await window.lt.todo.update(todo.id, { status: 'pending' })
      if (!r.ok) setErr(r.error ?? '예정 변경 실패')
      else {
        changed()
      }
    })
  }

  const startTodo = (todo: JsTodo): void => {
    void runMutation(todo.id, async () => { const r = await window.lt.todo.update(todo.id, { status: 'in_progress' })
      if (!r.ok) setErr(r.error ?? '진행중 변경 실패')
      else {
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
      setProgressDrafts((drafts) => ({ ...drafts, [todo.id]: '' }))
      changed()
    })
  }

  const addRelatedTodo = (todo: JsTodo): void => {
    const text = relatedInputs[todo.id]?.trim()
    if (!text) return
    void runMutation(todo.id, async () => { const r = await window.lt.todo.create({
      title: text,
      caseId: todo.caseId || undefined,
      ...(capabilities?.createFields.includes('parentId') ? { parentId: todo.id } : {}),
      court: todo.court ?? undefined,
      caseNumber: todo.caseNumber ?? undefined,
      caseName: todo.caseName ?? undefined,
      client: todo.client ?? undefined,
      opponent: todo.opponent ?? undefined,
      partyNames: todo.partyNames ?? undefined,
      notes: `[관련 할일]\n원 할일: ${todo.title || '(제목 없음)'}`
    })
      if (!r.ok || !r.todo) {
        setErr(r.error ?? '관련 할일 생성 실패')
        return
      }
      setRelatedInputs((drafts) => ({ ...drafts, [todo.id]: '' }))
      changed()
    })
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
        {onManageTodos && <button className="todo-primary" title={`표시된 ${filteredTodos.length}개 할일을 오른쪽 에이전트로 전달`} onClick={() => onManageTodos(filteredTodos)} disabled={!filteredTodos.length || !!busyId}>
          오른쪽 에이전트로 정리
        </button>}
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
              if (option.value === status) return
              requestId.current++
              setHistory(null)
              setLoading(false)
              setStatus(option.value)
              setErr('')
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {status === 'completed' && <div className="todo-filters">
        <button className="todo-primary" disabled={!tokenReady || !todos || loading || !!err || !!busyId || !filteredTodos.length} onClick={() => setBulkTodos(filteredTodos)}>완료된 할일 일괄 종료</button>
        <span className="muted small">현재 표시된 완료 할일 {filteredTodos.length}건</span>
      </div>}

      {['open', 'pending', 'in_progress'].includes(status) && <div className="todo-filters" aria-label="열린 할일 필터">{FILTERS.map((option) => <button key={option.value} className={`todo-tab ${filter === option.value ? 'on' : ''}`} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}</div>}
      <div className="todo-filter-count">표시 {filteredTodos.length}건 {onGlobalWork && <button className="todo-small" onClick={onGlobalWork}>전체 할일 정리 시작</button>}</div>
      <TodoSnapshotState snapshot={snapshot} />
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
                    if (shouldSubmitInput(e)) addRelatedTodo(todo)
                  }}
                />
                <button className="todo-small" onClick={() => addRelatedTodo(todo)} disabled={!relatedInput.trim()}>
                  {capabilities?.createFields.includes('parentId') ? '자식 추가' : '추가'}
                </button>
              </div>
              {relatedInput && <p className="todo-warning">추가할 할일에는 기한이 없습니다. 다른 기한·산출물은 별도 할일로 추가하세요.</p>}
              <TodoDetails todo={todo} parentTitle={snapshot.todos?.find((parent) => parent.id === todo.parentId)?.title} capabilities={capabilities} onOpenEvidenceFile={onOpenEvidenceFile} onChanged={changed} onComplete={() => completeTodo(todo)} />
              <div className="todo-actions" onClick={(e) => e.stopPropagation()}>
                {onManageTodos && <button className="todo-small" onClick={() => onManageTodos([todo])}>에이전트로 정리</button>}
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

      {resolution && <TodoResolution todo={resolution.todo} action={resolution.action} progressText={progressDrafts[resolution.todo.id]?.trim() || undefined} onClose={() => setResolution(null)} onSaved={() => {
        setProgressDrafts((drafts) => ({ ...drafts, [resolution.todo.id]: '' })); setResolution(null); changed()
      }} />}
      {caseReview && <CaseTaskReview closureSupported={capabilities?.caseClosure ?? false} caseId={caseReview.id} title={caseReview.title} onClose={() => setCaseReview(null)} onChanged={changed} />}
      {bulkTodos && <BulkTodoClosure todos={bulkTodos} onClose={() => setBulkTodos(null)} onChanged={changed} />}
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
