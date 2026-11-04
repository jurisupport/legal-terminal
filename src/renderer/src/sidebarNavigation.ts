import type { SidebarCase, SidebarTask } from './CaseSidebar'

export const CASE_ORDER_KEY = 'lt:case-tab-order'
export const SESSION_VISITS_KEY = 'lt:session-visits'

export interface SessionVisit {
  scope: string
  task: SidebarTask
  openedAt: number
}

function readSaved(key: string): unknown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export function readCaseOrder(): string[] {
  return [...new Set(readSaved(CASE_ORDER_KEY).filter((id): id is string => typeof id === 'string'))]
}

export function orderCaseTabs<T extends { id: string }>(tabs: readonly T[], order: readonly string[]): T[] {
  const ranks = new Map(order.map((id, index) => [id, index]))
  return [...tabs].sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length))
}

export function moveCaseTab(order: readonly string[], from: string, to: string): string[] {
  const next = [...order]
  const fromIndex = next.indexOf(from), toIndex = next.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return next
  next.splice(toIndex, 0, ...next.splice(fromIndex, 1))
  return next
}

export function readSessionVisits(): SessionVisit[] {
  return readSaved(SESSION_VISITS_KEY).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const { scope, task, openedAt } = raw as Partial<SessionVisit>
    if (typeof scope !== 'string' || typeof openedAt !== 'number' || !Number.isFinite(openedAt) ||
      !task || typeof task !== 'object' || typeof task.id !== 'string' || typeof task.title !== 'string') return []
    return [{ scope, openedAt, task: {
      id: task.id, title: task.title, mtime: openedAt,
      sessionId: typeof task.sessionId === 'string' ? task.sessionId : undefined,
      originDevice: task.originDevice === 'android' || task.originDevice === 'desktop' ? task.originDevice : undefined
    } }]
  }).slice(0, 100)
}

export function recordSessionVisit(visits: readonly SessionVisit[], scope: string, task: SidebarTask, openedAt: number): SessionVisit[] {
  return [{ scope, task: { ...task, active: undefined, status: undefined }, openedAt },
    ...visits.filter((visit) => visit.scope !== scope || (visit.task.id !== task.id &&
      (!task.sessionId || visit.task.sessionId !== task.sessionId)))].slice(0, 100)
}

export function recentSidebarTasks(cases: readonly SidebarCase[], visits: readonly SessionVisit[]): { item: SidebarCase; task: SidebarTask; openedAt: number }[] {
  return cases.flatMap((item) => {
    const history = visits.filter((visit) => visit.scope === (item.historyKey ?? item.id))
    const matches = (a: SidebarTask, b: SidebarTask): boolean => a.id === b.id || !!a.sessionId && a.sessionId === b.sessionId
    return [
      ...item.tasks.map((task) => ({ item, task, openedAt: history.find((visit) => matches(visit.task, task))?.openedAt ?? 0 })),
      ...history.filter((visit) => visit.task.sessionId && !item.tasks.some((task) => matches(visit.task, task)))
        .map((visit) => ({ item, task: visit.task, openedAt: visit.openedAt }))
    ]
  }).sort((a, b) => b.openedAt - a.openedAt)
}
