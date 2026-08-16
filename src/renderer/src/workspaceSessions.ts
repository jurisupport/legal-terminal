import type { WorkspaceSnapshot } from './env'

type Terminal = WorkspaceSnapshot['terminals'][number]

const terminalKey = (term: Terminal): string =>
  [
    term.cwd,
    term.agentProvider ?? term.autoAgent ?? (term.autoClaude ? 'claude' : term.kind ?? 'terminal'),
    term.resumeSessionId ?? `tab:${term.id}`
  ].join('\0')

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
  const terminalKeys = new Set(terminals.map(terminalKey))
  const terminalIds = new Set(terminals.map((term) => term.id))
  for (const term of remote.terminals ?? []) {
    if (terminalKeys.has(terminalKey(term))) continue
    const id = uniqueId(term.id, terminalIds)
    terminals.push({ ...term, id })
    terminalIds.add(id)
    terminalKeys.add(terminalKey(term))
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
    terminals
  }
}
