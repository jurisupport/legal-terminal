// Automatic handover opens agents only. Manual workspace backups keep their full layout.
export function agentTabsOnly<T extends {
  version: number
  savedAt: string
  terminals?: unknown
  activeTerm?: unknown
}>(snapshot: T): T {
  const terminals = (Array.isArray(snapshot.terminals) ? snapshot.terminals : []).filter(
    (tab) => tab && typeof tab === 'object' && tab.kind === 'agent' &&
      typeof tab.id === 'string' && !!tab.id && typeof tab.cwd === 'string' && !!tab.cwd &&
      (tab.agentProvider === undefined || ['claude', 'codex'].includes(tab.agentProvider))
  )
  return {
    ...snapshot,
    docs: [],
    terminals,
    activeTerm: terminals.some((tab) => tab.id === snapshot.activeTerm)
      ? snapshot.activeTerm : terminals[0]?.id,
    activeDoc: undefined,
    activeWork: undefined,
    caseTabs: undefined,
    activeCaseTabId: undefined,
    pdfStatus: undefined,
    crop: undefined
  }
}

type SharedCaseSnapshot = {
  savedAt: string
  workspaceOpen?: unknown
  workspaceOpenedAt?: unknown
  currentCase?: unknown
}

const caseRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// A phone may know only the folder name; absent fields must not erase desktop metadata.
const populatedFields = (value: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(caseRecord(value)).filter(([, field]) =>
    field !== undefined && field !== null && (typeof field !== 'string' || !!field.trim())))

export function mergeSharedCaseState<T extends SharedCaseSnapshot>(
  current: T | undefined, incoming: T, reopen = false, replay = false
): T {
  const previousCase = caseRecord(current?.currentCase)
  const nextCase = populatedFields(incoming.currentCase)
  const workspaceOpen = replay ? current?.workspaceOpen
    : current?.workspaceOpen === false && !reopen ? false : incoming.workspaceOpen
  return {
    ...incoming,
    workspaceOpen,
    workspaceOpenedAt: current?.workspaceOpen === false && workspaceOpen === true && reopen && !replay
      ? incoming.savedAt : current?.workspaceOpenedAt ?? current?.savedAt ?? incoming.savedAt,
    currentCase: {
      ...previousCase, ...nextCase,
      meta: { ...caseRecord(previousCase.meta), ...populatedFields(nextCase.meta) }
    }
  }
}

export function compareSharedCaseOrder(a: SharedCaseSnapshot, b: SharedCaseSnapshot): number {
  const key = (snapshot: SharedCaseSnapshot): number =>
    Date.parse(typeof snapshot.workspaceOpenedAt === 'string' ? snapshot.workspaceOpenedAt : snapshot.savedAt) || 0
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  return key(a) - key(b) || compare(
    String(caseRecord(a.currentCase).drafts ?? '').normalize('NFC'),
    String(caseRecord(b.currentCase).drafts ?? '').normalize('NFC')
  ) || compare(String(caseRecord(caseRecord(a.currentCase).meta).jsId ?? ''),
    String(caseRecord(caseRecord(b.currentCase).meta).jsId ?? ''))
}

export interface SharedAgentTabIdentity {
  id: string
  cwd: string
  agentProvider?: string
  resumeSessionId?: string
  originDevice?: 'android' | 'desktop'
}

const sameAgent = (a: SharedAgentTabIdentity, b: SharedAgentTabIdentity): boolean =>
  a.cwd.normalize('NFC').replace(/[\\/]+$/, '') === b.cwd.normalize('NFC').replace(/[\\/]+$/, '') &&
  (a.agentProvider ?? 'claude') === (b.agentProvider ?? 'claude') &&
  (a.resumeSessionId && b.resumeSessionId
    ? a.resumeSessionId === b.resumeSessionId
    : a.id === b.id)

const closedTabs = (snapshot: { closedAgentTabs?: unknown } | undefined): SharedAgentTabIdentity[] =>
  (Array.isArray(snapshot?.closedAgentTabs) ? snapshot.closedAgentTabs : []).filter(
    (tab) => tab && typeof tab.id === 'string' && typeof tab.cwd === 'string' &&
      (tab.agentProvider === undefined || ['claude', 'codex'].includes(tab.agentProvider)) &&
      (tab.resumeSessionId === undefined || typeof tab.resumeSessionId === 'string')
  )

export const isAgentTabClosed = (
  snapshot: { closedAgentTabs?: unknown }, tab: SharedAgentTabIdentity
): boolean => closedTabs(snapshot).some((closed) => sameAgent(closed, tab))

// Keep tabs opened on another device since our last load/save, while honoring local closes.
export function mergeSharedAgentTabs<T extends { version: number; savedAt: string; terminals?: unknown; activeTerm?: unknown; closedAgentTabs?: unknown }>(
  current: T | undefined,
  incoming: T,
  previous: T | undefined,
  reopened: SharedAgentTabIdentity[] = []
): T {
  const tabs = (snapshot: T | undefined): SharedAgentTabIdentity[] =>
    snapshot ? agentTabsOnly(snapshot).terminals as SharedAgentTabIdentity[] : []
  const incomingTabs = tabs(incoming)
  reopened = reopened.filter((open) => incomingTabs.some((tab) => sameAgent(open, tab)))
  const known = tabs(previous)
  // Keep close records on the server: a sleeping/offline computer may still hold
  // the old tab. Only an explicit reopen can remove its close record.
  const closed = closedTabs(current).map((tab) => {
    const started = [...tabs(current), ...incomingTabs].find((candidate) => candidate.resumeSessionId && sameAgent(tab, candidate))
    return tab.resumeSessionId || !started ? tab : { ...tab, resumeSessionId: started.resumeSessionId }
  }).filter((tab) => !reopened.some((open) => sameAgent(tab, open)))
  for (const tab of known) {
    if (incomingTabs.some((next) => sameAgent(tab, next)) ||
      reopened.some((open) => sameAgent(tab, open)) || closed.some((item) => sameAgent(tab, item))) continue
    const latest = tabs(current).find((currentTab) => sameAgent(tab, currentTab))
    closed.push({ id: tab.id, cwd: tab.cwd, agentProvider: tab.agentProvider,
      resumeSessionId: tab.resumeSessionId || latest?.resumeSessionId })
  }
  const isClosed = (tab: SharedAgentTabIdentity): boolean => closed.some((item) => sameAgent(item, tab))
  const next = incomingTabs.filter((tab) => !isClosed(tab))
  // ponytail: small tab lists use a linear scan per tab; index identities if hundreds of tabs matter.
  for (const remote of tabs(current)) {
    if (isClosed(remote)) continue
    const index = next.findIndex((tab) => sameAgent(tab, remote))
    if (index !== -1) {
      if (remote.originDevice === 'android' || remote.originDevice === 'desktop') {
        next[index] = { ...next[index], originDevice: remote.originDevice }
      }
      if (!next[index].resumeSessionId && remote.resumeSessionId) {
        next[index] = { ...next[index], resumeSessionId: remote.resumeSessionId }
      }
      continue
    }
    if (known.some((tab) => sameAgent(tab, remote))) continue
    const ids = new Set(next.map((tab) => tab.id))
    let id = remote.id
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${remote.id}-${suffix}`
    next.push({ ...remote, id })
  }
  return { ...agentTabsOnly(incoming), terminals: next, closedAgentTabs: closed,
    activeTerm: next.some((tab) => tab.id === incoming.activeTerm) ? incoming.activeTerm : next[0]?.id }
}
