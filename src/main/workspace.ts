import { app } from 'electron'
import { dirname, join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

export interface WorkspaceSnapshot {
  version: number
  savedAt: string
  [key: string]: unknown
}

export interface WorkspaceSaveResult {
  ok: boolean
  path?: string
  savedAt?: string
  error?: string
  canceled?: boolean
}

export interface WorkspaceLoadResult {
  ok: boolean
  path?: string
  snapshot?: WorkspaceSnapshot | null
  error?: string
  canceled?: boolean
}

export function defaultWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace-state.json')
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as { version?: unknown; savedAt?: unknown }
  return typeof v.version === 'number' && typeof v.savedAt === 'string'
}

export async function saveWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  filePath = defaultWorkspacePath()
): Promise<WorkspaceSaveResult> {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
    return { ok: true, path: filePath, savedAt: snapshot.savedAt }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function loadWorkspaceSnapshot(
  filePath = defaultWorkspacePath()
): Promise<WorkspaceLoadResult> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isSnapshot(parsed)) return { ok: false, path: filePath, error: '작업환경 파일 형식이 올바르지 않습니다.' }
    return { ok: true, path: filePath, snapshot: parsed }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, path: filePath, snapshot: null }
    return { ok: false, path: filePath, error: String(e) }
  }
}
