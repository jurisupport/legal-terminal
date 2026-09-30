import { useState } from 'react'
import { buildCaseManagement, emptyCaseManagementUi, taskReasons } from '../../../shared/caseManagement'
import { kstDateKey } from '../../../shared/todoSummary'
import type { JsTodo } from '../env'
import type { TodoSnapshot } from './useTodoSnapshot'
import type { CaseManagementUiController } from './useCaseManagementUi'
import type { TaskActionProps } from './CaseTaskPanel'
import { TodoSnapshotState } from './TodoSummary'
import { TodoResolution } from './TodoDetails'

export default function TodayTodos({ snapshot, caseUi, onChanged, onStartTask, onAskNextAction, onOpenTodos }: TaskActionProps & { snapshot: TodoSnapshot; caseUi?: CaseManagementUiController; onChanged?: () => void; onOpenTodos?: () => void }): JSX.Element {
  const [completing, setCompleting] = useState<JsTodo | null>(null)
  const [error, setError] = useState('')
  const model = buildCaseManagement([], snapshot.todos ?? [], caseUi?.state?.ui ?? emptyCaseManagementUi())
  const focusIds = model.ui.focus?.taskIds ?? []
  const toggleFocus = (id: string): void => {
    if (!caseUi?.state) return
    void caseUi.update({ focus: { date: model.today, taskIds: focusIds.includes(id) ? focusIds.filter((value) => value !== id) : [...focusIds, id] }, previousFocus: model.ui.previousFocus })
  }
  const rows = (todos: JsTodo[]): JSX.Element => <ul className="agenda todo-agenda">{todos.map((todo) => <li key={todo.id} className="agenda-row todo-agenda-row">
    <button className="todo-check" aria-label={`${todo.title} 완료`} onClick={() => setCompleting(todo)}>✓</button>
    <span className="agenda-body"><span className="agenda-note">{todo.title}</span><span className="agenda-case">{[todo.caseNumber, todo.caseName].filter(Boolean).join(' · ') || '사건 미연결'}</span><span className="agenda-court">{taskReasons(todo).join(' · ')}{todo.dueDate ? ` · 기한 ${kstDateKey(todo.dueDate) || '날짜 확인 필요'}` : ''}{todo.waitingFor ? ` · ${todo.waitingFor}` : ''}</span>
      <span className="todo-actions">{onStartTask && <button className="todo-small" onClick={() => { setError(''); void Promise.resolve().then(() => onStartTask(todo)).catch((e) => setError(String(e))) }}>지금 시작</button>}{caseUi && <button className="todo-small" aria-pressed={focusIds.includes(todo.id)} disabled={caseUi.busy || !caseUi.state} onClick={() => toggleFocus(todo.id)}>{focusIds.includes(todo.id) ? '오늘 선택 해제' : '오늘 선택'}</button>}{onAskNextAction && <button className="todo-small" onClick={() => onAskNextAction(todo)}>AI 다음 행동</button>}</span>
    </span>
  </li>)}</ul>
  const undated = model.openTasks.filter((todo) => !todo.dueDate)
  return <div className="today-management">
    <TodoSnapshotState snapshot={snapshot} />
    {(error || caseUi?.error) && <p className="dash-err" role="alert">{error || caseUi?.error}{caseUi?.error && <button className="todo-small" onClick={() => void caseUi.refresh()}>선택 다시 불러오기</button>}</p>}
    <section aria-label="먼저 확인"><h3>먼저 확인 · {snapshot.todos ? model.attentionTasks.length : '—'}건</h3><p className="muted small">선택 여부와 관계없이 모든 마감·재확인을 표시합니다. 기한 경고는 한국 날짜 기준입니다.</p>{rows(model.attentionTasks)}{snapshot.todos && !model.attentionTasks.length && !snapshot.error && <p className="muted small">먼저 확인할 기한·재확인이 없습니다.</p>}</section>
    <section aria-label="오늘 선택"><h3>오늘 선택 · {model.focusTasks.length}건</h3><p className="muted small">3개 정도를 권장합니다. 더 선택해도 됩니다.</p>{caseUi && <label className="case-focus-add">오늘 할 일 추가 <select aria-label="오늘 할 일 추가" value="" disabled={caseUi.busy || !caseUi.state || !!snapshot.error} onChange={(e) => { if (e.target.value) toggleFocus(e.target.value) }}><option value="">열린 할일에서 선택</option>{model.openTasks.filter((todo) => !focusIds.includes(todo.id)).map((todo) => <option key={todo.id} value={todo.id}>{todo.title} · {todo.caseNumber || todo.caseName || '사건 미연결'}</option>)}</select></label>}{rows(model.focusTasks)}{!model.focusTasks.length && <p className="muted small">아직 선택한 할일이 없습니다.</p>}</section>
    {!!model.previousFocusTasks.length && <details><summary>직전 선택일 {model.ui.previousFocus?.date} · 미완료 {model.previousFocusTasks.length}건</summary>{rows(model.previousFocusTasks)}</details>}
    <details><summary>앞으로 7일 마감 · {model.upcomingTasks.length}건</summary>{rows(model.upcomingTasks)}</details>
    <details><summary>계획 미정 · {undated.length}건</summary>{rows(undated)}</details>
    {onOpenTodos && <button className="todo-small" onClick={onOpenTodos}>전체 할일 보기</button>}
    {completing && <TodoResolution todo={completing} action="complete" onClose={() => setCompleting(null)} onSaved={() => { setCompleting(null); snapshot.refresh(); onChanged?.() }} />}
  </div>
}
