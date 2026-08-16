import { app } from 'electron'
import { createHash } from 'crypto'
import { execFile, spawn } from 'child_process'
import { homedir, hostname } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import { buildSshArgs, type SshProfileLike } from './sshOptions'

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
  cwd?: string
  folderName?: string
  caseNumber?: string
  caseName?: string
  court?: string
  client?: string
  recordsFolder?: string
  profileId?: string
  sshLabel?: string
  searchText?: string
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

export interface AutomaticWorkspaceLocation {
  cwd: string
  profileId?: string
  ssh?: SshProfileLike
}

export interface AutomaticWorkspaceLoadResult {
  ok: boolean
  local?: WorkspaceLoadResult
  remote?: WorkspaceLoadResult
  error?: string
}

interface WorkspaceIndex {
  version: number
  entries: WorkspaceEntry[]
}

const LEGACY_WORKSPACE_ID = 'legacy-default'
const WORKSPACE_INDEX_VERSION = 1
const SHARED_WORKSPACE_MAX_BYTES = 16 * 1024 * 1024
const SHARED_WORKSPACE_TIMEOUT_MS = 12_000
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
let sharedWriteSeq = 0
let workspaceIndexChain: Promise<unknown> = Promise.resolve()

function withWorkspaceIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = workspaceIndexChain.then(fn, fn)
  workspaceIndexChain = run.catch(() => undefined)
  return run
}

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

export function workspaceIdForLocation(cwd: string, profileId?: string): string {
  const key = profileId ? `auto-workspace:${profileId}:${cwd}` : `auto-workspace:${cwd}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function sharedWorkspacePath(cwd: string): string {
  const id = createHash('sha256').update(cwd).digest('hex').slice(0, 24)
  return join(homedir(), '.claude', 'legal-terminal-workspaces', `${id}.json`)
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

function compactSearchText(parts: (string | number | undefined)[]): string {
  return parts
    .filter((part): part is string | number => part !== undefined && String(part).trim().length > 0)
    .map((part) => String(part).normalize('NFKC').toLowerCase())
    .join(' ')
}

function activeTermRecord(snapshot: WorkspaceSnapshot): Record<string, unknown> | null {
  const terminals = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
  const activeTerm = asString(snapshot.activeTerm)
  const term =
    (activeTerm
      ? terminals.find((value) => asRecord(value)?.id === activeTerm)
      : undefined) ?? terminals[0]
  return asRecord(term)
}

function workspaceEntryMetadata(snapshot: WorkspaceSnapshot): Partial<WorkspaceEntry> {
  const termRecord = activeTermRecord(snapshot)
  const currentCase = asRecord(snapshot.currentCase)
  const currentMeta = asRecord(currentCase?.meta)
  const cwd =
    asString(termRecord?.cwd) ||
    asString(currentCase?.remotePath) ||
    asString(currentCase?.drafts)
  const folderName = displayNameFromPath(asString(currentCase?.remotePath) || cwd)
  return {
    cwd,
    folderName,
    caseNumber: asString(termRecord?.caseNumber) || asString(currentMeta?.caseNumber),
    caseName:
      asString(termRecord?.caseName) || asString(currentMeta?.caseName) || asString(currentCase?.caseName),
    court: asString(termRecord?.court) || asString(currentMeta?.court),
    client: asString(termRecord?.client) || asString(currentMeta?.client),
    recordsFolder: asString(termRecord?.recordsFolder) || asString(currentCase?.records),
    profileId: asString(termRecord?.profileId) || asString(currentCase?.profileId),
    sshLabel: asString(termRecord?.sshLabel) || asString(currentCase?.sshLabel)
  }
}

function workspaceIdentity(snapshot: WorkspaceSnapshot): { id: string; label: string } {
  const explicitId = asString(snapshot.workspaceId)
  const explicitLabel = asString(snapshot.workspaceLabel)
  if (explicitId && explicitLabel) return { id: explicitId, label: explicitLabel }
  const termRecord = activeTermRecord(snapshot)
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

async function loadSnapshotFile(filePath: string): Promise<WorkspaceLoadResult> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    if (!isSnapshot(parsed)) {
      return { ok: false, path: filePath, error: '작업환경 파일 형식이 올바르지 않습니다.' }
    }
    return { ok: true, path: filePath, snapshot: parsed, entry: entryFromSnapshot(parsed, filePath) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path: filePath, snapshot: null }
    return { ok: false, path: filePath, error: String(e) }
  }
}

async function saveSharedLocal(snapshot: WorkspaceSnapshot, cwd: string): Promise<void> {
  const path = sharedWorkspacePath(cwd)
  const tmp = `${path}.${process.pid}.${++sharedWriteSeq}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
  await rename(tmp, path)
}

function sharedRemoteFile(cwd: string): string {
  return `${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}.json`
}

function loadSharedRemote(ssh: SshProfileLike, cwd: string): Promise<WorkspaceLoadResult> {
  const name = sharedRemoteFile(cwd)
  const command = `file="$HOME/.claude/legal-terminal-workspaces/${name}"; [ -f "$file" ] && cat "$file"`
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...buildSshArgs(ssh, { usage: 'oneshot' }), command],
      { timeout: SHARED_WORKSPACE_TIMEOUT_MS, windowsHide: true, maxBuffer: SHARED_WORKSPACE_MAX_BYTES },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ ok: true, snapshot: null })
          return
        }
        try {
          const parsed = JSON.parse(stdout) as unknown
          resolve(
            isSnapshot(parsed)
              ? { ok: true, snapshot: parsed }
              : { ok: false, error: '원격 작업환경 파일 형식이 올바르지 않습니다.' }
          )
        } catch (e) {
          resolve({ ok: false, error: String(e) })
        }
      }
    )
  })
}

function saveSharedRemote(
  ssh: SshProfileLike,
  cwd: string,
  snapshot: WorkspaceSnapshot
): Promise<void> {
  const name = sharedRemoteFile(cwd)
  const command = [
    'dir="$HOME/.claude/legal-terminal-workspaces"',
    `file="$dir/${name}"`,
    'mkdir -p "$dir" || exit 1',
    'tmp="$file.$$.tmp"',
    'cat > "$tmp" && mv "$tmp" "$file"'
  ].join('\n')
  return new Promise((resolve, reject) => {
    const proc = spawn(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), command], {
      windowsHide: true
    })
    let stderr = ''
    const timer = setTimeout(() => proc.kill(), SHARED_WORKSPACE_TIMEOUT_MS)
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `원격 작업환경 저장 실패 (${code ?? 'unknown'})`))
    })
    proc.stdin?.on('error', () => {})
    proc.stdin?.end(JSON.stringify(snapshot, null, 2))
  })
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
  const metadata = workspaceEntryMetadata(snapshot)
  return {
    id: identity.id,
    label: identity.label,
    savedAt: snapshot.savedAt,
    path,
    docs: arrayLength(snapshot.docs),
    terminals: arrayLength(snapshot.terminals),
    ...metadata,
    searchText: compactSearchText([
      identity.label,
      metadata.caseNumber,
      metadata.caseName,
      metadata.court,
      metadata.client,
      metadata.folderName,
      metadata.cwd,
      metadata.recordsFolder,
      metadata.profileId,
      metadata.sshLabel
    ])
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
  await withWorkspaceIndexLock(async () => {
    const entries = await readWorkspaceIndex()
    const next = [entry, ...entries.filter((existing) => existing.id !== entry.id)]
    await writeWorkspaceIndex(next)
  })
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

export async function saveAutomaticWorkspace(
  snapshot: WorkspaceSnapshot,
  location: AutomaticWorkspaceLocation
): Promise<WorkspaceSaveResult & { remoteError?: string }> {
  const savedSnapshot: WorkspaceSnapshot = {
    ...snapshot,
    workspaceId: workspaceIdForLocation(location.cwd, location.profileId),
    workspaceLabel: snapshot.workspaceLabel || displayNameFromPath(location.cwd) || '사건 작업환경',
    workspaceDevice: hostname()
  }
  const local = await saveWorkspaceSnapshot(savedSnapshot)
  if (!local.ok) return local
  try {
    if (location.ssh) await saveSharedRemote(location.ssh, location.cwd, savedSnapshot)
    else await saveSharedLocal(savedSnapshot, location.cwd)
    return local
  } catch (e) {
    // 로컬 자동 저장은 성공했으므로 복원 가능하다. 원격 실패만 별도로 알려 다음 변경 때 재시도한다.
    return { ...local, remoteError: String(e) }
  }
}

export async function loadAutomaticWorkspace(
  location: AutomaticWorkspaceLocation
): Promise<AutomaticWorkspaceLoadResult> {
  const local = await loadWorkspaceSnapshot(workspaceIdForLocation(location.cwd, location.profileId))
  if (!location.ssh) {
    const shared = await loadSnapshotFile(sharedWorkspacePath(location.cwd))
    return {
      ok: local.ok && shared.ok,
      local,
      remote: shared,
      error: local.error || shared.error
    }
  }
  const remote = await loadSharedRemote(location.ssh, location.cwd)
  return {
    ok: local.ok && remote.ok,
    local,
    remote,
    error: local.error || remote.error
  }
}
