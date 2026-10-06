export type TodoFilter = 'open' | 'overdue' | 'overdue30' | 'undated' | 'undated60' | 'stale30' | 'review'
export interface SummaryTodo {
  id: string
  title: string
  status: string
  type?: string
  dueDate?: string | null
  reviewAt?: string | null
  createdAt?: string
  updatedAt?: string
}
const DAY = 86_400_000
const KST = 9 * 3_600_000

/** Calendar dates are KST even on computers configured for another timezone. */
export function kstDateKey(value: string | Date | number | null | undefined): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const datePart = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1]
    if (!datePart) return null
    const midnight = new Date(`${datePart}T00:00:00Z`)
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== datePart) return null
    if (value.length === 10) return datePart
    // Offsetless API datetimes are interpreted in KST rather than the host timezone.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) value += '+09:00'
  }
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time + KST).toISOString().slice(0, 10) : null
}

export function setTodoDate(original: string | null | undefined, dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || kstDateKey(dateKey) !== dateKey) throw new Error('날짜를 확인해 주세요.')
  let clock = '23:59:00.000'
  if (original && original.length > 10 && kstDateKey(original)) {
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(original) ? original : `${original}+09:00`
    clock = new Date(new Date(zoned).getTime() + KST).toISOString().slice(11, 23)
  }
  return new Date(`${dateKey}T${clock}+09:00`).toISOString()
}

function age(value: string | null | undefined, today: string): number | null {
  const key = kstDateKey(value)
  return key ? (Date.parse(today) - Date.parse(key)) / DAY : null
}
export function compareTodos(a: SummaryTodo, b: SummaryTodo): number {
  const aDue = kstDateKey(a.dueDate)
  const bDue = kstDateKey(b.dueDate)
  if (!!aDue !== !!bDue) return aDue ? -1 : 1
  return (aDue ?? kstDateKey(a.createdAt) ?? '9999').localeCompare(bDue ?? kstDateKey(b.createdAt) ?? '9999') || a.id.localeCompare(b.id)
}
export function filterTodos<T extends SummaryTodo>(todos: T[], filter: TodoFilter, now: Date | string | number = new Date()): T[] {
  const today = kstDateKey(now)
  if (!today) throw new Error('기준 날짜를 확인해 주세요.')
  return [...new Map(todos.filter((t) => (!t.type || t.type === 'todo') && ['pending', 'in_progress', 'open'].includes(t.status)).map((t) => [t.id, t])).values()]
    .filter((todo) => {
      const dueAge = age(todo.dueDate, today)
      switch (filter) {
        case 'overdue': return dueAge !== null && dueAge > 0
        case 'overdue30': return dueAge !== null && dueAge >= 30
        case 'undated': return !todo.dueDate
        case 'undated60': return !todo.dueDate && (age(todo.createdAt, today) ?? -1) >= 60
        case 'stale30': return todo.status === 'in_progress' && (age(todo.updatedAt, today) ?? -1) >= 30
        case 'review': return (age(todo.reviewAt, today) ?? -1) >= 0
        default: return true
      }
    }).sort(compareTodos)
}
export function summarizeTodos(todos: SummaryTodo[], now: Date | string | number = new Date()): { openCount: number; overdueCount: number; undatedCount: number; staleCount: number; reviewCount: number } {
  return {
    openCount: filterTodos(todos, 'open', now).length,
    overdueCount: filterTodos(todos, 'overdue', now).length,
    undatedCount: filterTodos(todos, 'undated', now).length,
    staleCount: filterTodos(todos, 'stale30', now).length,
    reviewCount: filterTodos(todos, 'review', now).length
  }
}
export function todoTags(todo: SummaryTodo, now: Date | string | number = new Date()): string[] {
  const labels: [TodoFilter, string][] = [['overdue', '기한 도과'], ['overdue30', '30일 이상 도과'], ['undated', '기한 없음'], ['undated60', '기한 없음·60일 이상'], ['stale30', '30일 이상 미갱신'], ['review', '재확인 필요']]
  const tags = labels.filter(([filter]) => filterTodos([todo], filter, now).length).map(([, label]) => label)
  if ([todo.dueDate, todo.reviewAt, todo.createdAt, todo.updatedAt].some((date) => date && !kstDateKey(date))) tags.push('날짜 확인 필요')
  return tags
}
