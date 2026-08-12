export const remoteStartPointKey = (path: string): string =>
  path.trim().replace(/\/+$/, '') || '/'

export const normalizeRemoteQuickStartPaths = (
  paths: Array<string | undefined> = []
): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const trimmed = path?.trim()
    if (!trimmed) continue
    const key = remoteStartPointKey(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

export const remoteQuickStartInputValue = (paths?: string[]): string =>
  normalizeRemoteQuickStartPaths(paths).join('\n')

export const remoteQuickStartInputToPaths = (value: string): string[] =>
  normalizeRemoteQuickStartPaths(value.split(/\r?\n/))

export const toggleRemoteQuickStartPath = (paths: string[], path: string): string[] => {
  const normalized = normalizeRemoteQuickStartPaths(paths)
  const key = remoteStartPointKey(path)
  return normalized.some((item) => remoteStartPointKey(item) === key)
    ? normalized.filter((item) => remoteStartPointKey(item) !== key)
    : normalizeRemoteQuickStartPaths([...normalized, path])
}
