import type { JsTodo } from '../env'

const statuses = [
  ['pending', '예정'],
  ['in_progress', '진행중'],
  ['completed', '완료']
] as const
export type TodoButtonStatus = typeof statuses[number][0]

export async function changeTodoStatus(todo: JsTodo, status: TodoButtonStatus, onReview: () => void, progressText?: string): Promise<boolean> {
  if (status === 'completed') {
    const { ok, todo: detail, error } = await window.lt.todo.get(todo.id)
    if (!ok || !detail || detail.id !== todo.id) throw new Error(error || '할일 조회 실패')
    if (!['open', 'pending', 'in_progress'].includes(detail.status)) throw new Error('할일 상태가 변경되었습니다. 목록을 새로고침하세요.')
    if (detail.children?.some(child => ['open', 'pending', 'in_progress'].includes(child.status))) {
      onReview()
      return false
    }
    const result = await window.lt.todo.complete(todo.id, progressText, undefined, { version: detail.version })
    if (!result.ok) throw new Error(result.error || '완료 처리 실패')
  } else {
    const result = await window.lt.todo.update(todo.id, { status, version: todo.version })
    if (!result.ok) throw new Error(result.error || '상태 변경 실패')
  }
  return true
}

export default function TodoStatusButtons({ todo, disabled, onChange }: {
  todo: JsTodo
  disabled: boolean
  onChange: (status: TodoButtonStatus) => void
}): JSX.Element {
  const current = todo.status === 'open' ? 'pending' : todo.status === 'done' ? 'completed' : todo.status
  return <span className="todo-status-buttons" role="group" aria-label={`${todo.title} 상태`} onClick={e => e.stopPropagation()}>
    {statuses.map(([status, label]) => <button type="button" key={status} className={`todo-tab${current === status ? ' on' : ''}`}
      aria-pressed={current === status} disabled={disabled || current === status} onClick={() => onChange(status)}>{label}</button>)}
  </span>
}
