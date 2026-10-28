import { useState } from 'react'
import { compareTodos, filterTodos, kstDateKey } from '../../../shared/todoSummary'
import type { JsTodo } from '../env'
import type { TodoSnapshot } from './useTodoSnapshot'
import { TodoSnapshotState } from './TodoSummary'
import { TodoResolution } from './TodoDetails'

export default function TodayTodos({ snapshot, onChanged }: { snapshot: TodoSnapshot; onChanged?: () => void }): JSX.Element {
  const [completing, setCompleting] = useState<JsTodo | null>(null)
  const today = kstDateKey(new Date().toISOString())!
  const rows = filterTodos(snapshot.todos ?? [], 'open').filter((todo) => !todo.dueDate || (kstDateKey(todo.dueDate) ?? '9999') <= today).sort(compareTodos)
  return <>
    <TodoSnapshotState snapshot={snapshot} />
    {snapshot.todos && !rows.length && !snapshot.error && !snapshot.loading && <p className="muted pad small">오늘 처리할 할일이 없습니다.</p>}
    <ul className="agenda todo-agenda">{rows.slice(0, 24).map((todo) => <li key={todo.id} className="agenda-row todo-agenda-row">
      <button className="todo-check" aria-label={`${todo.title} 완료`} onClick={() => setCompleting(todo)}>✓</button>
      <span className="agenda-body"><span className="agenda-note">{todo.title}</span><span className="agenda-case">{[todo.caseNumber, todo.caseName].filter(Boolean).join(' · ') || '사건 미연결'}</span><span className="agenda-court">{todo.dueDate ? `기한 ${kstDateKey(todo.dueDate) || '날짜 확인 필요'}` : '기한 없음'}</span></span>
    </li>)}</ul>
    {rows.length > 24 && <p className="muted pad small">전체 {rows.length}건 중 24건 표시</p>}
    {completing && <TodoResolution todo={completing} action="complete" onClose={() => setCompleting(null)} onSaved={() => { setCompleting(null); snapshot.refresh(); onChanged?.() }} />}
  </>
}
