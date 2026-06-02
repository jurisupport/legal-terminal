import { app } from 'electron'
import { createHash } from 'crypto'
import { basename, dirname, isAbsolute, join } from 'path'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'

export interface WorkspaceSnapshot {
  version: number
  savedAt: string
  workspaceId?: string
  workspaceLabel?: string
  [key: string]: unknown
}

export interface WorkspaceEntry {
  id: string
  label: string
  savedAt: string
  path: string
  docs: number
  terminals: number
}

export interface WorkspaceSaveResult {
  ok: boolean
  path?: string
  savedAt?: string
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

export interface WorkspaceLoadResult {
  ok: boolean
  path?: string
  snapshot?: WorkspaceSnapshot | null
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

export interface WorkspaceListResult {
  ok: boolean
  entries?: WorkspaceEntry[]
  error?: string
}

interface WorkspaceIndex {
  version: number
  entries: WorkspaceEntry[]
}

const LEGACY_WORKSPACE_ID = 'legacy-default'
const WORKSPACE_INDEX_VERSION = 1

export function defaultWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace-state.json')
}

function workspaceStoreDir(): string {
  return join(app.getPath('userData'), 'workspaces')
}

function workspaceIndexPath(): string {
  return join(workspaceStoreDir(), 'workspace-index.json')
}

function workspaceSnapshotPath(id: string): string {
  return join(workspaceStoreDir(), `${id}.json`)
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as { version?: unknown; savedAt?: unknown }
  return typeof v.version === 'number' && typeof v.savedAt === 'string'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function displayNameFromPath(path?: string): string | undefined {
  if (!path) return undefined
  const clean = path.replace(/\/+$/, '')
  return basename(clean) || clean
}

function workspaceIdentity(snapshot: WorkspaceSnapshot): { id: string; label: string } {
  const terminals = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
  const activeTerm = asString(snapshot.activeTerm)
  const term =
    (activeTerm
      ? terminals.find((value) => asRecord(value)?.id === activeTerm)
      : undefined) ?? terminals[0]
  const termRecord = asRecord(term)
  const cwd = asString(termRecord?.cwd)
  if (cwd) {
    const profileId = asString(termRecord?.profileId)
    const label = asString(termRecord?.title) || displayNameFromPath(cwd) || '터미널 작업환경'
    const key = profileId ? `terminal:${profileId}:${cwd}` : `terminal:${cwd}`
    const id = createHash('sha256').update(key).digest('hex').slice(0, 16)
    return { id, label }
  }

  const currentCase = asRecord(snapshot.currentCase)
  const caseDrafts = asString(currentCase?.drafts)
  if (caseDrafts) {
    const label =
      asString(currentCase?.name) ||
      asString(currentCase?.caseName) ||
      displayNameFromPath(caseDrafts) ||
      '사건 작업환경'
    const id = createHash('sha256').update(`case:${caseDrafts}`).digest('hex').slice(0, 16)
    return { id, label }
  }

  const docs = Array.isArray(snapshot.docs) ? snapshot.docs : []
  const docRecord = asRecord(docs[0])
  const docPath = asString(docRecord?.path)
  if (docPath) {
    const label = asString(docRecord?.title) || displayNameFromPath(docPath) || '문서 작업환경'
    const id = createHash('sha256').update(`doc:${docPath}`).digest('hex').slice(0, 16)
    return { id, label }
  }

  return { id: 'default', label: '기본 작업환경' }
}

function entryFromSnapshot(
  snapshot: WorkspaceSnapshot,
  path: string,
  fallback?: Pick<WorkspaceEntry, 'id' | 'label'>
): WorkspaceEntry {
  const metadataId = asString(snapshot.workspaceId)
  const metadataLabel = asString(snapshot.workspaceLabel)
  const identity =
    fallback ??
    (metadataId && metadataLabel ? { id: metadataId, label: metadataLabel } : undefined) ??
    workspaceIdentity(snapshot)
  return {
    id: identity.id,
    label: identity.label,
    savedAt: snapshot.savedAt,
    path,
    docs: arrayLength(snapshot.docs),
    terminals: arrayLength(snapshot.terminals)
  }
}

function isEntry(value: unknown): value is WorkspaceEntry {
  const entry = asRecord(value)
  return (
    !!entry &&
    typeof entry.id === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.savedAt === 'string' &&
    typeof entry.path === 'string' &&
    typeof entry.docs === 'number' &&
    typeof entry.terminals === 'number'
  )
}

async function readWorkspaceIndex(): Promise<WorkspaceEntry[]> {
  try {
    const raw = await readFile(workspaceIndexPath(), 'utf8')
    const parsed = JSON.parse(raw) as WorkspaceIndex
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : []
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw e
  }
}

async function writeWorkspaceIndex(entries: WorkspaceEntry[]): Promise<void> {
  await mkdir(workspaceStoreDir(), { recursive: true })
  const sorted = [...entries].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  await writeFile(
    workspaceIndexPath(),
    JSON.stringify({ version: WORKSPACE_INDEX_VERSION, entries: sorted }, null, 2),
    'utf8'
  )
}

async function saveEntry(entry: WorkspaceEntry): Promise<void> {
  const entries = await readWorkspaceIndex()
  const next = [entry, ...entries.filter((existing) => existing.id !== entry.id)]
  await writeWorkspaceIndex(next)
}

async function listStoredWorkspaceEntries(): Promise<WorkspaceEntry[]> {
  try {
    const names = await readdir(workspaceStoreDir())
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.json') && name !== 'workspace-index.json')
        .map(async (name) => {
          const result = await loadWorkspaceSnapshot(join(workspaceStoreDir(), name))
          return result.ok && result.snapshot && result.entry ? result.entry : null
        })
    )
    return entries.filter((entry): entry is WorkspaceEntry => !!entry)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw e
  }
}

export async function saveWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  filePath?: string
): Promise<WorkspaceSaveResult> {
  try {
    if (filePath) {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
      return { ok: true, path: filePath, savedAt: snapshot.savedAt }
    }

    const identity = workspaceIdentity(snapshot)
    const path = workspaceSnapshotPath(identity.id)
    const savedSnapshot = {
      ...snapshot,
      workspaceId: identity.id,
      workspaceLabel: identity.label
    }
    const entry = entryFromSnapshot(savedSnapshot, path, identity)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(savedSnapshot, null, 2), 'utf8')
    await saveEntry(entry)
    return { ok: true, path, savedAt: savedSnapshot.savedAt, entry }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function loadWorkspaceSnapshot(
  source?: string
): Promise<WorkspaceLoadResult> {
  const filePath =
    !source || source === LEGACY_WORKSPACE_ID
      ? defaultWorkspacePath()
      : isAbsolute(source)
        ? source
        : workspaceSnapshotPath(source)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isSnapshot(parsed)) return { ok: false, path: filePath, error: '작업환경 파일 형식이 올바르지 않습니다.' }
    const identity =
      source === LEGACY_WORKSPACE_ID
        ? { id: LEGACY_WORKSPACE_ID, label: parsed.workspaceLabel ?? '이전 기본 작업환경' }
        : undefined
    return {
      ok: true,
      path: filePath,
      snapshot: parsed,
      entry: entryFromSnapshot(parsed, filePath, identity)
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, path: filePath, snapshot: null }
    return { ok: false, path: filePath, error: String(e) }
  }
}

export async function listWorkspaceSnapshots(): Promise<WorkspaceListResult> {
  try {
    const entries = [...(await readWorkspaceIndex()), ...(await listStoredWorkspaceEntries())]
    const byId = new Map<string, WorkspaceEntry>()
    for (const entry of entries) {
      const previous = byId.get(entry.id)
      if (!previous || entry.savedAt > previous.savedAt) byId.set(entry.id, entry)
    }

    const legacy = await loadWorkspaceSnapshot(LEGACY_WORKSPACE_ID)
    if (legacy.ok && legacy.snapshot && legacy.entry && !byId.has(legacy.entry.id)) {
      byId.set(legacy.entry.id, legacy.entry)
    }

    return {
      ok: true,
      entries: [...byId.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
