import type { BoardTodoScope } from '../shared/workBoard'
import { allJsPairings } from './caseStore'
import { normalizeProjectWorkspacePath } from './projectStore'

type CaseFolders = Record<string, { drafts: string }>

function folderKey(path: string): string {
  const normalized = normalizeProjectWorkspacePath(path)
  if (normalized.startsWith('ssh://')) return normalized
  if (process.platform === 'win32') return normalized.toLowerCase()
  return process.platform === 'darwin' ? normalized.normalize('NFC') : normalized
}

export function matchingBoardCases(workspace: string, aliases: string[], pairings: CaseFolders): string[] {
  const folders = new Set([workspace, ...aliases].map(folderKey))
  const profileId = /^ssh:\/\/([^/]+)\//.exec(workspace)?.[1]
  const prefix = profileId ? `remote:${profileId}:` : ''
  const cases = new Set<string>()
  for (const [key, { drafts }] of Object.entries(pairings)) {
    if (prefix ? !key.startsWith(prefix) : key.startsWith('remote:')) continue
    const id = key.slice(prefix.length)
    if (!id || !drafts) continue
    const path = profileId && drafts.startsWith('/') ? `ssh://${profileId}${drafts}` : drafts
    if (folders.has(folderKey(path))) cases.add(id)
  }
  return [...cases].sort()
}

export async function boardTodoCaseIds(workspace: string, aliases: string[] = []): Promise<string[]> {
  return matchingBoardCases(workspace, aliases, await allJsPairings(true))
}

export async function verifyBoardTodoScope(workspace: string, scope: BoardTodoScope, aliases: string[] = [], requireMapped = false): Promise<boolean> {
  const valid = scope?.kind === 'all' ? !('caseId' in scope) :
    scope?.kind === 'case' && typeof scope.caseId === 'string' && !!scope.caseId && scope.caseId === scope.caseId.trim()
  if (!valid) throw Error('할일 조회 범위를 선택해 주세요.')
  const cases = await boardTodoCaseIds(workspace, aliases)
  if ((requireMapped || cases.length > 0) && (scope.kind !== 'case' || !cases.includes(scope.caseId))) {
    throw Error('작업 폴더에 연결된 사건이 변경되었습니다. 조회할 사건을 다시 확인해 주세요.')
  }
  return cases.length > 0
}
