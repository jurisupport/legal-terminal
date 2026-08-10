export interface FolderMatchSuggestion {
  path: string
  name: string
  reason: string
  score: number
}

export interface CaseFolderInfo {
  caseNumber?: string | null
  caseName?: string | null
  partyNames: readonly string[]
}

const norm = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFC')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.,()[\]{}·]+/g, '')

const caseNameKeys = (value?: string | null): string[] =>
  [...new Set([value ?? '', (value ?? '').replace(/^\s*\[[^\]]+\]\s*/, '')].map(norm))]
    .filter((key) => key.length >= 2)

const partyKeys = (names: readonly string[]): string[] =>
  names.map(norm).filter((key) => key.length >= 2)

export function rankCaseFolders(
  folders: readonly Pick<FolderMatchSuggestion, 'path' | 'name'>[],
  info: CaseFolderInfo
): FolderMatchSuggestion[] {
  const candidates = new Map<string, FolderMatchSuggestion>()
  const put = (
    folder: Pick<FolderMatchSuggestion, 'path' | 'name'>,
    reason: '사건번호 일치' | '사건명 일치' | '당사자명 일치',
    score: number
  ): void => {
    const previous = candidates.get(folder.path)
    if (!previous || score > previous.score) candidates.set(folder.path, { ...folder, reason, score })
  }

  const caseNumber = norm(info.caseNumber)
  const names = caseNameKeys(info.caseName)
  const parties = partyKeys(info.partyNames)
  for (const folder of folders) {
    const name = norm(folder.name)
    if (caseNumber && name.includes(caseNumber)) {
      put(folder, '사건번호 일치', name === caseNumber ? 120 : 100)
    }
    if (names.some((key) => name.includes(key))) put(folder, '사건명 일치', 80)
    if (parties.some((key) => name.includes(key))) put(folder, '당사자명 일치', 60)
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

export function trustedCaseFolder(
  suggestions: readonly FolderMatchSuggestion[],
  info: CaseFolderInfo
): string | undefined {
  const top = suggestions[0]
  if (!top || top.score <= (suggestions[1]?.score ?? -1)) return undefined
  if (top.reason === '사건번호 일치') return top.path
  const name = norm(top.name)
  return caseNameKeys(info.caseName).some((key) => name.includes(key)) &&
    partyKeys(info.partyNames).some((key) => name.includes(key))
    ? top.path
    : undefined
}

export function rebaseCaseFolderToRoot(folder: string, root: string): string {
  const rootLeaf = root.replace(/[\\/]+$/, '').split(/[\\/]+/).pop()
  if (!rootLeaf) return folder
  const parts = folder.split(/[\\/]+/).filter(Boolean)
  let rootIndex = -1
  for (let i = 0; i < parts.length; i += 1) {
    if (norm(parts[i]) === norm(rootLeaf)) rootIndex = i
  }
  if (rootIndex < 0) return folder
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const suffix = parts.slice(rootIndex + 1).join(separator)
  return root.replace(/[\\/]+$/, '') + (suffix ? separator + suffix : '')
}

export function pathBelongsToCaseFolder(path: string, folder: string): boolean {
  const comparable = (value: string): string =>
    value.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '')
  const root = comparable(folder)
  const candidate = comparable(rebaseCaseFolderToRoot(path, folder))
  return candidate === root || candidate.startsWith(root + '/')
}
