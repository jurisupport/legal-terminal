import { app } from 'electron'
import { createHash } from 'crypto'
import { execFile, spawn } from 'child_process'
import { homedir, hostname } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from 'fs/promises'
import { buildSshArgs, type SshProfileLike } from './sshOptions'
import { agentTabsOnly, mergeSharedAgentTabs } from '../shared/workspaceAgentTabs'

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
  caseId?: string
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

export interface AutomaticWorkspaceListResult {
  ok: boolean
  snapshots?: WorkspaceSnapshot[]
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
const knownSharedWorkspaces = new Map<string, WorkspaceSnapshot>()
let sharedSaveChain: Promise<unknown> = Promise.resolve()

function sharedLocationKey(location: AutomaticWorkspaceLocation, observerId: number): string {
  const ssh = location.ssh
  return `${observerId}\0${ssh ? `${ssh.user}@${ssh.host}:${ssh.port ?? 22}` : 'local'}\0${location.cwd}\0${location.caseId ?? ''}`
}

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

export function workspaceIdForLocation(cwd: string, profileId?: string, caseId?: string): string {
  const key = caseId
    ? JSON.stringify(['case-workspace', profileId ?? null, cwd, caseId])
    : profileId ? `auto-workspace:${profileId}:${cwd}` : `auto-workspace:${cwd}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function sharedWorkspacePath(cwd: string, caseId?: string): string {
  return join(homedir(), '.claude', 'legal-terminal-workspaces', sharedRemoteFile(cwd, caseId))
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

/** A folder match alone is never evidence that a legacy snapshot belongs to this case. */
export function snapshotMatchesCase(snapshot: WorkspaceSnapshot, caseId: string): boolean {
  const currentCase = asRecord(snapshot.currentCase)
  const tabs = Array.isArray(snapshot.caseTabs) ? snapshot.caseTabs : []
  const terminals = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
  const ids = [
    asString(asRecord(currentCase?.meta)?.jsId),
    ...tabs.map((tab) => asString(asRecord(asRecord(tab)?.meta)?.jsId)),
    ...terminals.map((term) => asString(asRecord(term)?.jsId))
  ].filter((id): id is string => id !== undefined)
  return ids.length > 0 && ids.every((id) => id === caseId)
}

async function loadCaseWorkspace(
  load: (caseId?: string) => Promise<WorkspaceLoadResult>,
  caseId?: string
): Promise<WorkspaceLoadResult> {
  const exact = await load(caseId)
  if (!caseId || !exact.ok) return exact
  if (exact.snapshot) {
    return snapshotMatchesCase(exact.snapshot, caseId)
      ? exact
      : { ok: false, path: exact.path, error: '저장된 작업환경의 사건 정보가 일치하지 않아 복원하지 않았습니다.' }
  }
  const legacy = await load()
  if (!legacy.ok || !legacy.snapshot || snapshotMatchesCase(legacy.snapshot, caseId)) return legacy
  return { ok: true, path: legacy.path, snapshot: null, error: '이전 작업환경의 사건 정보를 확인할 수 없어 복원하지 않았습니다.' }
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

async function saveSharedLocal(snapshot: WorkspaceSnapshot, cwd: string, caseId?: string): Promise<void> {
  const path = sharedWorkspacePath(cwd, caseId)
  const tmp = `${path}.${process.pid}.${++sharedWriteSeq}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
  await rename(tmp, path)
}

function sharedRemoteFile(cwd: string, caseId?: string): string {
  const key = caseId ? JSON.stringify(['case-workspace', cwd, caseId]) : cwd
  return `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`
}

function workspaceSshCommand(ssh: SshProfileLike, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), command],
      { timeout: SHARED_WORKSPACE_TIMEOUT_MS, windowsHide: true },
      (error) => error ? reject(error) : resolve())
  })
}

// The Android SFTP writer uses the same empty-directory lock. Atomic rename alone
// cannot prevent two devices from reading the same old snapshot and losing a new tab.
async function withSharedWorkspaceLock(location: AutomaticWorkspaceLocation, save: () => Promise<void>): Promise<void> {
  const lock = `${sharedWorkspacePath(location.cwd, location.caseId)}.lock`
  const remoteLock = `"$HOME/.claude/legal-terminal-workspaces/${sharedRemoteFile(location.cwd, location.caseId)}.lock"`
  if (location.ssh) {
    await workspaceSshCommand(location.ssh, [
      'mkdir -p "$HOME/.claude/legal-terminal-workspaces" || exit 1',
      `lock=${remoteLock}`,
      'attempt=0',
      'until mkdir "$lock" 2>/dev/null; do',
      '  [ -d "$lock" ] || exit 1',
      '  find "$lock" -prune -type d -mmin +2 -exec rmdir {} \\; 2>/dev/null',
      '  attempt=$((attempt + 1))',
      '  [ "$attempt" -lt 80 ] || exit 1',
      '  sleep 0.1',
      'done'
    ].join('\n'))
  } else {
    await mkdir(dirname(lock), { recursive: true })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mkdir(lock)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt >= 80) throw new Error('다른 기기가 에이전트 탭을 저장 중입니다. 다시 시도하세요.')
        const info = await stat(lock).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > 120_000) await rmdir(lock).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  try {
    await save()
  } finally {
    if (location.ssh) await workspaceSshCommand(location.ssh, `rmdir ${remoteLock}`).catch(() => {})
    else await rmdir(lock).catch(() => {})
  }
}

function loadSharedRemote(ssh: SshProfileLike, cwd: string, caseId?: string): Promise<WorkspaceLoadResult> {
  const name = sharedRemoteFile(cwd, caseId)
  const command = `file="$HOME/.claude/legal-terminal-workspaces/${name}"; if [ -e "$file" ]; then cat "$file"; else exit 3; fi`
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...buildSshArgs(ssh, { usage: 'oneshot' }), command],
      { timeout: SHARED_WORKSPACE_TIMEOUT_MS, windowsHide: true, maxBuffer: SHARED_WORKSPACE_MAX_BYTES },
      (error, stdout) => {
        if (error) {
          resolve(error.code === 3 ? { ok: true, snapshot: null } : { ok: false, error: String(error) })
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
  snapshot: WorkspaceSnapshot,
  caseId?: string
): Promise<void> {
  const name = sharedRemoteFile(cwd, caseId)
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
  location: AutomaticWorkspaceLocation,
  observerId = 0
): Promise<WorkspaceSaveResult & { remoteError?: string }> {
  if (location.caseId && !snapshotMatchesCase(snapshot, location.caseId)) {
    return { ok: false, error: '작업환경의 사건 정보가 일치하지 않아 저장하지 않았습니다.' }
  }
  const savedSnapshot: WorkspaceSnapshot = {
    ...snapshot,
    workspaceId: workspaceIdForLocation(location.cwd, location.profileId, location.caseId),
    workspaceLabel: snapshot.workspaceLabel || displayNameFromPath(location.cwd) || '사건 작업환경',
    workspaceDevice: hostname(),
    workspaceOpen: snapshot.workspaceOpen !== false
  }
  delete savedSnapshot.workspaceReopen
  delete savedSnapshot.reopenAgentTabs
  delete savedSnapshot.workspaceIntentId
  const local = await saveWorkspaceSnapshot(savedSnapshot)
  if (!local.ok) return local
  try {
    const shared = agentTabsOnly(savedSnapshot)
    const sourceCase = asRecord(savedSnapshot.currentCase)
    const records = asString(sourceCase?.records)
    const remotePrefix = `ssh://${location.profileId}`
    shared.currentCase = {
      drafts: location.cwd,
      name: savedSnapshot.workspaceLabel,
      meta: location.caseId ? { ...asRecord(sourceCase?.meta), jsId: location.caseId } : sourceCase?.meta,
      records: !location.ssh ? records
        : records?.startsWith(`${remotePrefix}/`) ? records.slice(remotePrefix.length) : undefined
    }
    shared.terminals = (shared.terminals as Record<string, unknown>[]).map((term) => ({
      ...term,
      caseTabId: undefined,
      ssh: undefined,
      sshLabel: undefined,
      profileId: undefined,
      recordsFolder: undefined,
      suggestedRecords: undefined,
      suggestedRecordOptions: undefined
    }))
    const save = async (): Promise<void> => {
      const current = await loadCaseWorkspace((caseId) => location.ssh
        ? loadSharedRemote(location.ssh, location.cwd, caseId)
        : loadSnapshotFile(sharedWorkspacePath(location.cwd, caseId)), location.caseId)
      if (!current.ok) throw new Error(current.error)
      const key = sharedLocationKey(location, observerId)
      const applied = Array.isArray(current.snapshot?.appliedWorkspaceIntents)
        ? current.snapshot.appliedWorkspaceIntents.filter((id): id is string => typeof id === 'string') : []
      const intentId = asString(snapshot.workspaceIntentId)
      const replay = !!intentId && applied.includes(intentId)
      const reopened = agentTabsOnly({ version: 1, savedAt: shared.savedAt, terminals: replay ? [] : snapshot.reopenAgentTabs }).terminals as
        { id: string; cwd: string; agentProvider?: string; resumeSessionId?: string }[]
      const merged = mergeSharedAgentTabs(current.snapshot ?? undefined, shared,
        shared.workspaceOpen === false ? undefined : knownSharedWorkspaces.get(key), reopened)
      if (replay) merged.workspaceOpen = current.snapshot?.workspaceOpen
      else if (current.snapshot?.workspaceOpen === false && snapshot.workspaceReopen !== true) merged.workspaceOpen = false
      merged.appliedWorkspaceIntents = intentId && !replay ? [...applied, intentId] : applied
      if (location.ssh) await saveSharedRemote(location.ssh, location.cwd, merged, location.caseId)
      else await saveSharedLocal(merged, location.cwd, location.caseId)
      // Track only this device's tabs; preserved unseen tabs must survive its next save too.
      knownSharedWorkspaces.set(key, shared)
    }
    // ponytail: serialize workspace writes in this process; use per-host queues if saves become slow.
    const lockedSave = (): Promise<void> => withSharedWorkspaceLock(location, save)
    const pending = sharedSaveChain.then(lockedSave, lockedSave)
    sharedSaveChain = pending.catch(() => undefined)
    await pending
    return local
  } catch (e) {
    // 로컬 자동 저장은 성공했으므로 복원 가능하다. 원격 실패만 별도로 알려 다음 변경 때 재시도한다.
    return { ...local, remoteError: String(e) }
  }
}

// Discovery is read-only. Background reads are acknowledged only after applying
// their exact snapshot in the renderer. Old manual backups are not open cases.
export async function listAutomaticWorkspaces(ssh?: SshProfileLike, includeClosed = false): Promise<AutomaticWorkspaceListResult> {
  try {
    let contents: string[]
    if (ssh) {
      const command = [
        'for file in "$HOME/.claude/legal-terminal-workspaces/"*.json; do',
        '  [ -f "$file" ] || continue',
        "  printf '\\036'",
        '  cat "$file" || exit 1',
        'done'
      ].join('\n')
      const output = await new Promise<string>((resolve, reject) => {
        execFile(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), command],
          { timeout: SHARED_WORKSPACE_TIMEOUT_MS, windowsHide: true, maxBuffer: SHARED_WORKSPACE_MAX_BYTES },
          (error, stdout) => error ? reject(error) : resolve(stdout))
      })
      contents = output.split('\x1e').filter((part) => part.trim())
    } else {
      const dir = dirname(sharedWorkspacePath(''))
      const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      contents = await Promise.all(names.filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
        .map((name) => readFile(join(dir, name), 'utf8')))
    }
    const snapshots: WorkspaceSnapshot[] = []
    for (const content of contents) {
      try {
        const snapshot: unknown = JSON.parse(content)
        // Android and older desktop snapshots lack workspaceOpen but still belong in history.
        if (!isSnapshot(snapshot) || (!includeClosed && snapshot.workspaceOpen !== true)) continue
        const source = asRecord(snapshot.currentCase)
        if (!asString(source?.drafts)?.startsWith('/') || !asString(source?.name)) continue
        const caseId = asString(asRecord(source?.meta)?.jsId)
        if (caseId && !snapshotMatchesCase(snapshot, caseId)) continue
        snapshots.push(agentTabsOnly(snapshot))
      } catch {
        // A damaged backup must not prevent other cases from being discovered.
      }
    }
    return { ok: true, snapshots: snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function loadAutomaticWorkspace(
  location: AutomaticWorkspaceLocation,
  observerId = 0,
  observe = true
): Promise<AutomaticWorkspaceLoadResult> {
  const local = await loadCaseWorkspace(
    (caseId) => loadWorkspaceSnapshot(workspaceIdForLocation(location.cwd, location.profileId, caseId)),
    location.caseId
  )
  if (!location.ssh) {
    const shared = await loadCaseWorkspace(
      (caseId) => loadSnapshotFile(sharedWorkspacePath(location.cwd, caseId)), location.caseId
    )
    if (observe && shared.ok && shared.snapshot) knownSharedWorkspaces.set(sharedLocationKey(location, observerId), shared.snapshot)
    return {
      ok: local.ok && shared.ok,
      local,
      remote: shared,
      error: local.error || shared.error
    }
  }
  const remote = await loadCaseWorkspace(
    (caseId) => loadSharedRemote(location.ssh!, location.cwd, caseId), location.caseId
  )
  if (observe && remote.ok && remote.snapshot) knownSharedWorkspaces.set(sharedLocationKey(location, observerId), remote.snapshot)
  return {
    ok: local.ok && remote.ok,
    local,
    remote,
    error: local.error || remote.error
  }
}

export function observeAutomaticWorkspace(
  location: AutomaticWorkspaceLocation,
  snapshot: WorkspaceSnapshot,
  observerId = 0
): void {
  if (!isSnapshot(snapshot)) throw new Error('작업환경 파일 형식이 올바르지 않습니다.')
  if (location.caseId && !snapshotMatchesCase(snapshot, location.caseId)) {
    throw new Error('작업환경의 사건 정보가 일치하지 않아 적용하지 않았습니다.')
  }
  knownSharedWorkspaces.set(sharedLocationKey(location, observerId), agentTabsOnly(snapshot))
}
