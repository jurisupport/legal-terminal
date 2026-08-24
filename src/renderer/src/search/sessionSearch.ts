export const SESSION_SEARCH_RECENT_LIMIT = 40
export const SESSION_SEARCH_MAX_LIMIT = 1000

const searchNorm = (value?: string): string =>
  (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')

export const matchesSearch = (
  parts: (string | number | undefined)[],
  query: string
): boolean => {
  const tokens = query.split(/\s+/).map(searchNorm).filter(Boolean)
  if (!tokens.length) return true
  const haystack = searchNorm(
    parts
      .filter((part): part is string | number => part !== undefined && String(part).trim().length > 0)
      .join(' ')
  )
  return tokens.every((token) => haystack.includes(token))
}

export const expandSessionSearchLimit = (limit: number): number =>
  Math.min(limit * 5, SESSION_SEARCH_MAX_LIMIT)
