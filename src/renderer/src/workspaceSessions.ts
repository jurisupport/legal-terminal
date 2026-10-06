import type { WorkspaceSnapshot } from './env'

type Terminal = WorkspaceSnapshot['terminals'][number]

const terminalScope = (term: Terminal): string =>
  [
    term.ssh ? `${term.ssh.user}@${term.ssh.host}:${term.ssh.port ?? 22}` : 'local',
    term.cwd.normalize('NFC').replace(/[\\/]+$/, ''),
    term.kind ?? 'terminal',
    term.agentProvider ?? term.autoAgent ?? (term.kind === 'agent' || term.autoClaude ? 'claude' : 'terminal')
  ].join('\0')

const terminalKey = (term: Terminal): string =>
  `${terminalScope(term)}\0${term.resumeSessionId || `tab:${term.id}`}`

export function workspaceSessionKeys(snapshot: WorkspaceSnapshot): string[] {
  return (snapshot.terminals ?? []).map(terminalKey).sort()
}

export function sameWorkspaceSessions(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return JSON.stringify(workspaceSessionKeys(a)) === JSON.stringify(workspaceSessionKeys(b))
}

const uniqueId = (id: string, used: Set<string>): string => {
  if (!used.has(id)) return id
  let suffix = 2
  while (used.has(`${id}-${suffix}`)) suffix += 1
  return `${id}-${suffix}`
}

// "둘 다"는 세션 ID와 문서 경로 기준 합집합이다. 같은 탭 ID가 다른 내용을 가리키면
// 뒤에 번호만 붙여 둘 다 보존한다.
export function mergeWorkspaceSessions(
  local: WorkspaceSnapshot,
  remote: WorkspaceSnapshot
): WorkspaceSnapshot {
  const terminals = [...(local.terminals ?? [])]
  const terminalKeys = new Map(terminals.map((term, index) => [terminalKey(term), index]))
  const stableIds = new Map(terminals.map((term, index) => [`${terminalScope(term)}\0${term.id}`, index]))
  const terminalIds = new Set(terminals.map((term) => term.id))
  const remoteIds = new Map<string, string>()
  for (const term of remote.terminals ?? []) {
    const stableIndex = stableIds.get(`${terminalScope(term)}\0${term.id}`)
    const index = terminalKeys.get(terminalKey(term)) ??
      (stableIndex !== undefined && (!term.resumeSessionId || !terminals[stableIndex].resumeSessionId)
        ? stableIndex : undefined)
    if (index !== undefined) {
      const existing = terminals[index]
      if (!existing.resumeSessionId && term.resumeSessionId) {
        terminals[index] = { ...existing, resumeSessionId: term.resumeSessionId,
          sessionTitle: term.sessionTitle ?? existing.sessionTitle }
        terminalKeys.set(terminalKey(terminals[index]), index)
      }
      remoteIds.set(term.id, existing.id)
      continue
    }
    const id = uniqueId(term.id, terminalIds)
    terminals.push({ ...term, id })
    terminalIds.add(id)
    terminalKeys.set(terminalKey(term), terminals.length - 1)
    stableIds.set(`${terminalScope(term)}\0${id}`, terminals.length - 1)
    remoteIds.set(term.id, id)
  }

  const docs = [...(local.docs ?? [])]
  const docKeys = new Set(docs.map((doc) => doc.path ?? `tab:${doc.id}`))
  const docIds = new Set(docs.map((doc) => doc.id))
  for (const doc of remote.docs ?? []) {
    const key = doc.path ?? `tab:${doc.id}`
    if (docKeys.has(key)) continue
    const id = uniqueId(doc.id, docIds)
    docs.push({ ...doc, id })
    docIds.add(id)
    docKeys.add(key)
  }

  return {
    ...remote,
    ...local,
    savedAt: local.savedAt >= remote.savedAt ? local.savedAt : remote.savedAt,
    docs,
    terminals,
    activeTerm: local.activeTerm ?? remoteIds.get(remote.activeTerm ?? '')
  }
}
