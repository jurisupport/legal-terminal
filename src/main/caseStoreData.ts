export interface CaseEntry {
  drafts: string
  records?: string
  name: string
  ts: number
}

export interface CaseStore {
  pairings: Record<string, string>
  recent: CaseEntry[]
  jsPairings: Record<string, { drafts: string; records?: string }>
}

export function emptyCaseStore(): CaseStore {
  return { pairings: {}, recent: [], jsPairings: {} }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function cleanStore(value: unknown): CaseStore {
  const raw = asRecord(value)
  if (!raw) return emptyCaseStore()
  const store = emptyCaseStore()
  const pairings = asRecord(raw.pairings)
  if (pairings) {
    for (const [drafts, records] of Object.entries(pairings)) {
      if (typeof records === 'string') store.pairings[drafts] = records
    }
  }
  if (Array.isArray(raw.recent)) {
    store.recent = raw.recent.flatMap((item) => {
      const entry = asRecord(item)
      const drafts = asString(entry?.drafts)
      const name = asString(entry?.name)
      if (!drafts || !name) return []
      return [{ drafts, records: asString(entry?.records), name, ts: Number(entry?.ts) || 0 }]
    })
  }
  const jsPairings = asRecord(raw.jsPairings)
  if (jsPairings) mergeJsPairings(store, jsPairings)
  return store
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
  }
  return undefined
}

function jsonString(raw: string): string {
  return JSON.parse(`"${raw}"`) as string
}

function mergeJsPairings(store: CaseStore, raw: Record<string, unknown>): void {
  for (const [id, value] of Object.entries(raw)) {
    const item = asRecord(value)
    const drafts = asString(item?.drafts)
    if (!drafts) continue
    store.jsPairings[id] = { drafts, records: asString(item?.records) }
  }
}

function mergeLooseJsPairings(store: CaseStore, text: string): void {
  const stringPart = String.raw`[^"\\]*(?:\\.[^"\\]*)*`
  const re = new RegExp(
    `"(${stringPart})"\\s*:\\s*\\{\\s*"drafts"\\s*:\\s*"(${stringPart})"(?:\\s*,\\s*"records"\\s*:\\s*"(${stringPart})")?\\s*\\}`,
    'g'
  )
  for (const match of text.matchAll(re)) {
    const [, rawId, rawDrafts, rawRecords] = match
    if (!rawId || !rawDrafts) continue
    store.jsPairings[jsonString(rawId)] = {
      drafts: jsonString(rawDrafts),
      records: rawRecords ? jsonString(rawRecords) : undefined
    }
  }
}

export function parseCaseStoreText(text: string): CaseStore {
  try {
    return cleanStore(JSON.parse(text))
  } catch {
    const store = cleanStore(firstJsonObject(text))
    mergeLooseJsPairings(store, text)
    return store
  }
}
