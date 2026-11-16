import type { SidebarCase, SidebarTask } from './CaseSidebar'

export const CASE_ORDER_KEY = 'lt:case-tab-order'
export const SESSION_VISITS_KEY = 'lt:session-visits'

export interface SessionVisit {
  scope: string
  task: SidebarTask
  openedAt: number
  hidden?: true
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
  return readSaved(SESSION_VISITS_KEY).flatMap<SessionVisit>((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const { scope, task, openedAt, hidden } = raw as Partial<SessionVisit>
    if (typeof scope !== 'string' || typeof openedAt !== 'number' || !Number.isFinite(openedAt) ||
      !task || typeof task !== 'object' || typeof task.id !== 'string' || typeof task.title !== 'string') return []
    return [{ scope, openedAt, hidden: hidden === true || undefined, task: {
      id: task.id, title: task.title, mtime: openedAt,
      sessionId: typeof task.sessionId === 'string' ? task.sessionId : undefined,
      originDevice: task.originDevice === 'android' || task.originDevice === 'desktop' ? task.originDevice : undefined
    } }]
  })
}

function sameTask(a: SidebarTask, b: SidebarTask): boolean {
  return a.id === b.id || !!a.sessionId && a.sessionId === b.sessionId
}

export function removeSessionVisit(visits: readonly SessionVisit[], item: SidebarCase, task: SidebarTask): SessionVisit[] {
  const scope = item.historyKey ?? item.id
  const remaining = visits.filter((visit) => visit.scope !== scope || !sameTask(visit.task, task))
  // Open tabs also appear in recents without a visit. Suppress that fallback until the next visit.
  if (item.tasks.some((open) => sameTask(open, task))) {
    remaining.push({ scope, task: { id: task.id, sessionId: task.sessionId, title: '', mtime: 0 }, openedAt: 0, hidden: true })
  }
  return remaining
}

export function recordSessionVisit(visits: SessionVisit[], scope: string, task: SidebarTask, openedAt: number, revisit = true): SessionVisit[] {
  const matches = (visit: SessionVisit): boolean => visit.scope === scope && sameTask(visit.task, task)
  if (!revisit && visits.some((visit) => visit.hidden && matches(visit))) return visits
  const remaining = visits.filter((visit) => !matches(visit))
  return [{ scope, task: { ...task, active: undefined, status: undefined }, openedAt },
    ...remaining.filter((visit) => !visit.hidden).slice(0, 99), ...remaining.filter((visit) => visit.hidden)]
}

export function recentSidebarTasks(cases: readonly SidebarCase[], visits: readonly SessionVisit[]): { item: SidebarCase; task: SidebarTask; openedAt: number }[] {
  return cases.flatMap((item) => {
    const history = visits.filter((visit) => visit.scope === (item.historyKey ?? item.id))
    return [
      ...item.tasks.flatMap((task) => {
        const visit = history.find((entry) => sameTask(entry.task, task))
        return visit?.hidden ? [] : [{ item, task, openedAt: visit?.openedAt ?? 0 }]
      }),
      ...history.filter((visit) => !visit.hidden && visit.task.sessionId && !item.tasks.some((task) => sameTask(visit.task, task)))
        .map((visit) => ({ item, task: visit.task, openedAt: visit.openedAt }))
    ]
  }).sort((a, b) => b.openedAt - a.openedAt)
}
