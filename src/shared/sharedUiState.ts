export interface SharedUiActivity {
  runId: string
  sequence: number
  status: 'working' | 'done' | 'question' | 'idle'
  attention: boolean
}

export type SharedUiTab = { kind: 'document' | 'agent'; id: string } | { kind: 'view'; id: 'files' | 'records' | 'hearing' }
export interface SharedUiState {
  version: 1
  revision: number
  selection: { caseKey: string | null; tab: SharedUiTab | null }
  cases: Record<string, { documents: Record<string, boolean>; activity: Record<string, SharedUiActivity> }>
  appliedOperationIds: string[]
}
export type SharedUiOperation =
  | { id: string; type: 'document'; caseKey: string; path: string; open: boolean; onlyIfMissing?: boolean }
  | { id: string; type: 'selection'; caseKey: string | null; tab: SharedUiTab | null; onlyIfUnset?: boolean }
  | ({ id: string; type: 'activity'; caseKey: string; agentId: string } & SharedUiActivity &
      ({ start: true; expectedRunId: string | null } | { start: false }))
  | { id: string; type: 'ack'; caseKey: string; agentId: string; runId: string; sequence: number }
export interface SharedUiResult { ok: boolean; state?: SharedUiState; error?: string }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
const key = (v: unknown): v is string => text(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
const sequence = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const tab = (v: unknown): v is SharedUiTab => object(v) &&
  (((v.kind === 'document' || v.kind === 'agent') && text(v.id)) ||
    (v.kind === 'view' && (v.id === 'files' || v.id === 'records' || v.id === 'hearing')))
const activity = (v: unknown): v is unknown & SharedUiActivity => object(v) && text(v.runId) && sequence(v.sequence) &&
  (v.status === 'working' || v.status === 'done' || v.status === 'question' || v.status === 'idle') && typeof v.attention === 'boolean'

export function emptySharedUiState(): SharedUiState {
  return { version: 1, revision: 0, selection: { caseKey: null, tab: null }, cases: {}, appliedOperationIds: [] }
}

export function isSharedUiState(v: unknown): v is SharedUiState {
  return object(v) && v.version === 1 && sequence(v.revision) && object(v.selection) &&
    (v.selection.caseKey === null || key(v.selection.caseKey)) && (v.selection.tab === null || tab(v.selection.tab)) &&
    object(v.cases) && Object.entries(v.cases).every(([k, c]) => key(k) && object(c) && object(c.documents) &&
      Object.entries(c.documents).every(([p, open]) => text(p) && p.startsWith('/') && typeof open === 'boolean') &&
      object(c.activity) && Object.entries(c.activity).every(([id, a]) => key(id) && activity(a))) &&
    Array.isArray(v.appliedOperationIds) && v.appliedOperationIds.every(text)
}

export function isSharedUiOperation(v: unknown): v is SharedUiOperation {
  if (!object(v) || !text(v.id)) return false
  if (v.type === 'selection') return (v.caseKey === null || key(v.caseKey)) && (v.tab === null || tab(v.tab)) &&
    (v.caseKey !== null || v.tab === null) && (v.onlyIfUnset === undefined || typeof v.onlyIfUnset === 'boolean')
  if (!key(v.caseKey)) return false
  if (v.type === 'document') return text(v.path) && v.path.startsWith('/') && typeof v.open === 'boolean' &&
    (v.onlyIfMissing === undefined || typeof v.onlyIfMissing === 'boolean')
  if (!key(v.agentId)) return false
  if (v.type === 'ack') return text(v.runId) && sequence(v.sequence)
  return v.type === 'activity' && activity(v) && typeof v.start === 'boolean' &&
    (!v.start || (v.status === 'working' && (v.expectedRunId === null || text(v.expectedRunId))))
}

export function applySharedUiOperation(state: SharedUiState, operation: SharedUiOperation): SharedUiState {
  if (state.appliedOperationIds.includes(operation.id)) return state
  if (!Number.isSafeInteger(state.revision + 1)) throw new Error('공유 상태의 변경 번호가 너무 큽니다.')
  if (operation.type === 'selection') {
    if (!operation.onlyIfUnset || state.selection.caseKey === null) {
      state.selection = { caseKey: operation.caseKey, tab: operation.tab }
    }
  } else {
    const c = state.cases[operation.caseKey] ??= { documents: {}, activity: {} }
    if (operation.type === 'document') {
      if (!operation.onlyIfMissing || !Object.hasOwn(c.documents, operation.path)) c.documents[operation.path] = operation.open
    }
    else if (operation.type === 'activity') {
      const previous = c.activity[operation.agentId]
      if ((operation.start && (previous?.runId ?? null) === operation.expectedRunId) ||
          (!operation.start && previous?.runId === operation.runId && operation.sequence > previous.sequence)) {
        c.activity[operation.agentId] = { runId: operation.runId, sequence: operation.sequence,
          status: operation.status, attention: operation.attention }
      }
    } else {
      const previous = c.activity[operation.agentId]
      if (previous?.runId === operation.runId && previous.sequence === operation.sequence) previous.attention = false
    }
  }
  state.appliedOperationIds.push(operation.id)
  state.revision += 1
  return state
}
