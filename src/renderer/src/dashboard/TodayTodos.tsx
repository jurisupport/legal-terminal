import { useEffect, useMemo, useState } from 'react'
import type { JsTodo } from '../env'

function dueTime(todo: JsTodo): number {
  if (!todo.dueDate) return Number.POSITIVE_INFINITY
  const time = new Date(todo.dueDate).getTime()
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

function isActionable(todo: JsTodo): boolean {
  return !['completed', 'done', 'closed', 'archived'].includes(todo.status)
}

function formatDue(todo: JsTodo): string {
  if (!todo.dueDate) return ''
  const d = new Date(todo.dueDate)
  if (Number.isNaN(d.getTime())) return todo.dueDate
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function TodayTodos({
  nonce = 0,
  onChanged
}: {
  nonce?: number
  onChanged?: () => void
}): JSX.Element {
  const [todos, setTodos] = useState<JsTodo[] | null>(null)
  const [hasToken, setHasToken] = useState(true)

  const rows = useMemo(() => {
    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)
    return (todos ?? [])
      .filter(isActionable)
      .filter((todo) => !todo.dueDate || dueTime(todo) <= todayEnd.getTime())
      .sort((a, b) => dueTime(a) - dueTime(b))
      .slice(0, 24)
  }, [todos])

  const load = (): void => {
    window.lt.js.hasToken().then((has) => {
      setHasToken(has)
      if (!has) {
        setTodos([])
        return
      }
      window.lt.todo.list({ includeArchived: false }).then((r) => setTodos(r.ok ? (r.todos ?? []) : []))
    })
  }

  useEffect(load, [nonce])

  const complete = (todo: JsTodo): void => {
    window.lt.todo.complete(todo.id).then((r) => {
      if (r.ok) {
        onChanged?.()
        load()
      }
    })
  }

  if (!hasToken) return <p className="muted pad small">JuriSupport 연결 후 할일이 표시됩니다.</p>
  if (!todos) return <p className="muted pad small">불러오는 중...</p>
  if (rows.length === 0) return <p className="muted pad small">오늘 처리할 할일이 없습니다.</p>

  return (
    <ul className="agenda todo-agenda">
      {rows.map((todo) => (
        <li key={todo.id} className="agenda-row todo-agenda-row" title={todo.title}>
          <button className="todo-check" title="완료" onClick={() => complete(todo)}>
            ✓
          </button>
          <span className="agenda-body">
            <span className="agenda-note">{todo.title}</span>
            {(todo.caseNumber || todo.caseName || todo.court) && (
              <span className="agenda-case">
                {[todo.court, todo.caseNumber, todo.caseName].filter(Boolean).join(' · ')}
              </span>
            )}
            {(todo.partyNames || todo.client || todo.opponent) && (
              <span className="agenda-court">
                {[todo.client && `의뢰인 ${todo.client}`, todo.opponent && `상대 ${todo.opponent}`, !todo.client && !todo.opponent && todo.partyNames]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {todo.dueDate && <span className="agenda-court">기한 {formatDue(todo)}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
