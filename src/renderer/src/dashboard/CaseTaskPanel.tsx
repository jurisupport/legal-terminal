import { useRef, useState } from 'react'
import type { JsCase, JsTodo, TodoCapabilities } from '../env'
import { kstDateKey, setTodoDate } from '../../../shared/todoSummary'
import { taskReasons } from '../../../shared/caseManagement'
import TodoDetails, { TodoResolution } from './TodoDetails'
import CaseTaskReview from './CaseTaskReview'
import type { CaseManagementUiController } from './useCaseManagementUi'

export interface TaskActionProps {
  onStartTask?: (todo: JsTodo) => void | Promise<void>
  onAskNextAction?: (todo: JsTodo) => void
}

export default function CaseTaskPanel({ c, todos, caseUi, capabilities, onChanged, onStartTask, onAskNextAction }: TaskActionProps & {
  c: JsCase
  todos: JsTodo[]
  caseUi?: CaseManagementUiController
  capabilities: TodoCapabilities | null
  onChanged: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState('')
  const [resolution, setResolution] = useState<JsTodo | null>(null)
  const [review, setReview] = useState(false)
  const create = async (): Promise<void> => {
    if (!title.trim() || saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await window.lt.todo.create({ caseId: c.id, title: title.trim(), ...(due ? { dueDate: setTodoDate(null, due) } : {}) })
      if (!result.ok || !result.todo) throw new Error(result.error || '할일 추가 결과를 확인하지 못했습니다. 새로 조회한 뒤 확인하세요.')
      setTitle(''); setDue(''); onChanged()
    } catch (e) { setError(String(e)) }
    finally { saving.current = false; setBusy(false) }
  }
  return <div className="case-task-panel">
    <fieldset className="todo-create" disabled={busy}><legend>이 사건의 새 할일</legend><label>할일 <input value={title} placeholder="다음에 할 구체적인 일" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void create() } }} /></label><label>기한 <input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label><button className="todo-primary" disabled={!title.trim()} onClick={() => void create()}>이 사건에 추가</button>{!due && <span className="muted small">기한 없이 추가됩니다.</span>}</fieldset>
    {error && <p className="dash-err" role="alert">{error}</p>}
    {todos.length === 0 && <p className="muted">조회 가능한 다음 할일 없음</p>}
    {todos.map((todo) => <section className="case-task-item" key={todo.id}>
      <strong>{todo.title}</strong><div className="todo-tags">{taskReasons(todo).map((reason) => <span key={reason}>{reason}</span>)}</div>
      <p className="muted small">{todo.dueDate ? `기한 ${kstDateKey(todo.dueDate) || '날짜 확인 필요'}` : '계획 미정'}{todo.assigneeName ? ` · 담당 ${todo.assigneeName}` : ''}</p>
      <div className="todo-actions">
        {onStartTask && <button className="todo-primary" onClick={() => { setError(''); void Promise.resolve().then(() => onStartTask(todo)).catch((e) => setError(String(e))) }}>지금 시작</button>}
        {caseUi && <button className="todo-small" aria-pressed={caseUi.state?.ui.selectedTaskByCase[c.id] === todo.id} disabled={caseUi.busy || !caseUi.state} onClick={() => { const selectedTaskByCase = { ...caseUi.state!.ui.selectedTaskByCase }; if (selectedTaskByCase[c.id] === todo.id) delete selectedTaskByCase[c.id]; else selectedTaskByCase[c.id] = todo.id; void caseUi.update({ selectedTaskByCase }) }}>{caseUi.state?.ui.selectedTaskByCase[c.id] === todo.id ? '대표 선택 해제' : '다음 할일로 선택'}</button>}
        <button className="todo-small" onClick={() => setResolution(todo)}>이미 처리함·완료 확인</button>
        {onAskNextAction && <button className="todo-small" onClick={() => onAskNextAction(todo)}>AI에게 다음 행동 제안받기</button>}
      </div>
      <TodoDetails todo={todo} capabilities={capabilities} onChanged={onChanged} onComplete={() => setResolution(todo)} />
    </section>)}
    {(capabilities?.caseClosure || capabilities?.createFields.includes('type')) && <button className="todo-small" onClick={() => setReview(true)}>사건 관리·메모</button>}
    {resolution && <TodoResolution todo={resolution} action="complete" onClose={() => setResolution(null)} onSaved={() => { setResolution(null); onChanged() }} />}
    {review && <CaseTaskReview caseId={c.id} title={c.caseName || c.caseNumber || '사건'} closureSupported={capabilities?.caseClosure ?? false} onClose={() => setReview(false)} onChanged={onChanged} />}
  </div>
}
