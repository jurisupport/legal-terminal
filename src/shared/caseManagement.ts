import { filterTodos, kstDateKey, type SummaryTodo } from './todoSummary'

export interface CaseManagementFocus { date: string; taskIds: string[] }
export interface CaseManagementUi {
  selectedTaskByCase: Record<string, string>
  focus: CaseManagementFocus | null
  previousFocus: CaseManagementFocus | null
  recovery: { caseId: string | null; seenCaseIds: string[] }
}
export interface CaseManagementState { generation: string; revision: number; ui: CaseManagementUi }
export interface CaseManagementPatch { generation: string; revision: number; patch: Partial<CaseManagementUi> }
export interface ManagementTodo extends SummaryTodo { caseId?: string | null; waitingFor?: string | null }
export interface ManagementHearing { caseId: string; dateTime: string; status?: string }
export interface CaseManagementRow<C, T> {
  case: C
  openTasks: T[]
  waitingTasks: T[]
  nextTask: T | null
  selectionKind: 'selected' | 'recommended' | 'waiting' | 'none'
  reasons: string[]
}
export function emptyCaseManagementUi(): CaseManagementUi {
  return { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } }
}
export function isWaiting(todo: ManagementTodo): boolean { return !!todo.waitingFor?.trim() }

export function taskReasons(todo: ManagementTodo, now: Date | string | number = new Date()): string[] {
  const today = kstDateKey(now)
  if (!today) throw new Error('기준 날짜를 확인해 주세요.')
  const due = kstDateKey(todo.dueDate)
  const review = kstDateKey(todo.reviewAt)
  const reasons: string[] = []
  if (due && due < today) reasons.push('기한 도과')
  if (due === today) reasons.push('오늘 마감')
  if (review && review <= today) reasons.push(review === today ? '오늘 재확인' : '재확인 필요')
  if ([todo.dueDate, todo.reviewAt, todo.createdAt, todo.updatedAt].some(value => value && !kstDateKey(value))) reasons.push('날짜 확인 필요')
  if (isWaiting(todo)) {
    reasons.push('대기중')
    if (!todo.reviewAt) reasons.push('재확인일 확인 필요')
  }
  if (!todo.dueDate) reasons.push('계획 미정')
  return reasons
}

function creationTime(value: string | undefined): number {
  if (!value || !kstDateKey(value)) return Infinity
  return Date.parse(value.length === 10 ? `${value}T00:00:00+09:00` : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`)
}
function compareActions(a: ManagementTodo, b: ManagementTodo): number {
  return (kstDateKey(a.dueDate) ?? '9999').localeCompare(kstDateKey(b.dueDate) ?? '9999')
    || Number(b.status === 'in_progress') - Number(a.status === 'in_progress')
    || (creationTime(a.createdAt) - creationTime(b.createdAt)) || a.id.localeCompare(b.id)
}
const attention = new Set(['기한 도과', '오늘 마감', '오늘 재확인', '재확인 필요', '날짜 확인 필요', '재확인일 확인 필요'])

/** Input snapshots must be complete before persisting the returned pruned UI references. */
export function buildCaseManagement<C extends { id: string; status: string }, T extends ManagementTodo>(
  cases: C[], todos: T[], ui: CaseManagementUi = emptyCaseManagementUi(),
  now: Date | string | number = new Date(), hearings: ManagementHearing[] = []
) {
  const today = kstDateKey(now)
  if (!today) throw new Error('기준 날짜를 확인해 주세요.')
  const end = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)
  const inWeek = (date: string | null) => !!date && date > today && date < end
  const openTasks = filterTodos(todos, 'open', now).sort(compareActions)
  const byId = new Map(openTasks.map(task => [task.id, task]))
  const byCase = new Map<string, T[]>()
  const datesByCase = new Map<string, string[]>()
  const reasonsById = new Map(openTasks.map(task => [task.id, taskReasons(task, now)]))
  for (const task of openTasks) {
    if (!task.caseId) continue
    const group = byCase.get(task.caseId) ?? []
    group.push(task)
    byCase.set(task.caseId, group)
  }
  for (const hearing of hearings) {
    if (['postponed', 'cancelled'].includes(hearing.status ?? '')) continue
    const day = kstDateKey(hearing.dateTime)
    if (!day || day < today || day >= end) continue
    const dates = datesByCase.get(hearing.caseId) ?? []
    dates.push(day)
    datesByCase.set(hearing.caseId, dates)
  }
  const selectedTaskByCase: Record<string, string> = {}
  const rows: CaseManagementRow<C, T>[] = [...new Map(cases.map(item => [item.id, item])).values()]
    .filter(item => item.status === 'active' || byCase.has(item.id))
    .map(item => {
      const tasks = byCase.get(item.id) ?? []
      const selected = byId.get(ui.selectedTaskByCase[item.id])
      const validSelection = selected?.caseId === item.id ? selected : null
      if (validSelection) selectedTaskByCase[item.id] = validSelection.id
      const waitingTasks = tasks.filter(isWaiting).sort((a, b) =>
        (kstDateKey(a.reviewAt) ?? '9999').localeCompare(kstDateKey(b.reviewAt) ?? '9999') || compareActions(a, b))
      const recommended = tasks.find(task => !isWaiting(task))
      const nextTask = validSelection ?? recommended ?? waitingTasks[0] ?? null
      const reasons = new Set(tasks.flatMap(task => reasonsById.get(task.id)!))
      const hearingDates = datesByCase.get(item.id) ?? []
      if (hearingDates.includes(today)) reasons.add('오늘 기일')
      if (hearingDates.some(inWeek) || tasks.some(task => inWeek(kstDateKey(task.dueDate)))) reasons.add('7일 내 일정')
      if (!nextTask) reasons.add('다음 할일 확인')
      return { case: item, openTasks: tasks, waitingTasks, nextTask,
        selectionKind: validSelection ? 'selected' : recommended ? 'recommended' : nextTask ? 'waiting' : 'none', reasons: [...reasons] }
    })
  const pruneFocus = (focus: CaseManagementFocus | null): CaseManagementFocus | null => focus && kstDateKey(focus.date) === focus.date
    ? { date: focus.date, taskIds: [...new Set(focus.taskIds)].filter(id => byId.has(id)) } : null
  const storedFocus = pruneFocus(ui.focus)
  const previousFocus = [storedFocus, pruneFocus(ui.previousFocus)].filter((focus): focus is CaseManagementFocus => !!focus && focus.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
  const focus = storedFocus?.date === today ? storedFocus : null
  const recoveryOrder = (row: CaseManagementRow<C, T>): [number, string] => {
    const dueDates = row.openTasks.map(task => kstDateKey(task.dueDate)).filter((day): day is string => !!day).sort()
    const reviews = row.openTasks.map(task => kstDateKey(task.reviewAt)).filter((day): day is string => !!day && day <= today).sort()
    if (dueDates[0] < today) return [0, dueDates[0]]
    if (row.reasons.includes('오늘 마감') || row.reasons.includes('오늘 기일')) return [1, today]
    if (reviews.length) return [2, reviews[0]]
    if (row.reasons.some(reason => reason === '날짜 확인 필요' || reason === '재확인일 확인 필요')) return [2, today]
    const upcoming = [...dueDates, ...(datesByCase.get(row.case.id) ?? [])].filter(inWeek).sort()
    if (upcoming.length) return [3, upcoming[0]]
    return [row.nextTask ? 5 : 4, '9999']
  }
  const recoveryOrders = new Map(rows.map(row => [row.case.id, recoveryOrder(row)]))
  const recovery = [...rows].sort((a, b) => {
    const [aGroup, aDate] = recoveryOrders.get(a.case.id)!, [bGroup, bDate] = recoveryOrders.get(b.case.id)!
    return aGroup - bGroup || aDate.localeCompare(bDate) || a.case.id.localeCompare(b.case.id)
  })
  const caseIds = new Set(rows.map(row => row.case.id))
  const seenCaseIds = [...new Set(ui.recovery.seenCaseIds)].filter(id => caseIds.has(id))
  const seen = new Set(seenCaseIds)
  const recoveryCaseId = ui.recovery.caseId && caseIds.has(ui.recovery.caseId) && !seen.has(ui.recovery.caseId)
    ? ui.recovery.caseId : recovery.find(row => !seen.has(row.case.id))?.case.id ?? null
  const tasksFor = (value: CaseManagementFocus | null) => value?.taskIds.map(id => byId.get(id)!) ?? []
  return {
    today, cases: rows, openTasks,
    attentionTasks: openTasks.filter(task => reasonsById.get(task.id)!.some(reason => attention.has(reason))),
    upcomingTasks: openTasks.filter(task => inWeek(kstDateKey(task.dueDate))),
    focusTasks: tasksFor(focus), previousFocusTasks: tasksFor(previousFocus), recovery, recoveryCaseId,
    ui: { selectedTaskByCase, focus, previousFocus, recovery: { caseId: recoveryCaseId, seenCaseIds } } satisfies CaseManagementUi
  }
}
