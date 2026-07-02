// Agent 변경 제안(diff) 데이터 모델과 파서. 렌더링은 DiffPreview.tsx가 담당한다.
import { asRecord, numberValue, recordArray, stringArray, stringValue } from './values'

export const DIFF_FALLBACK_LINE_LIMIT = 10
export const DIFF_FALLBACK_TEXT_LIMIT = 6000

export interface DiffEdit {
  oldString?: string
  newString?: string
}

interface DiffPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DiffRow {
  kind: 'context' | 'change' | 'remove' | 'add'
  beforeNo?: number
  afterNo?: number
  before?: string
  after?: string
}

export interface DiffHunkView {
  label?: string
  oldStart?: number
  newStart?: number
  rows: DiffRow[]
}

export interface DiffView {
  filePath?: string
  hunks: DiffHunkView[]
  additions: number
  deletions: number
  revertEdits?: DiffEdit[]
}

export const splitDiffText = (value: string | undefined): string[] => {
  if (value === undefined) return []
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

export function diffLineStats(hunks: DiffHunkView[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'add' || row.kind === 'change') additions += row.after === undefined ? 0 : 1
      if (row.kind === 'remove' || row.kind === 'change') deletions += row.before === undefined ? 0 : 1
    }
  }
  return { additions, deletions }
}

export function visibleDiffFallbackText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const lineLimited =
    lines.length > DIFF_FALLBACK_LINE_LIMIT
      ? lines.slice(0, DIFF_FALLBACK_LINE_LIMIT).join('\n')
      : normalized
  const charLimited =
    lineLimited.length > DIFF_FALLBACK_TEXT_LIMIT
      ? lineLimited.slice(0, DIFF_FALLBACK_TEXT_LIMIT)
      : lineLimited
  const truncated = lineLimited.length !== normalized.length || charLimited.length !== lineLimited.length
  return {
    text: truncated ? `${charLimited.trimEnd()}\n...` : charLimited,
    truncated
  }
}

function normalizePatchHunks(value: unknown): DiffPatchHunk[] {
  return recordArray(value)
    .map((hunk) => {
      const oldStart = numberValue(hunk.oldStart)
      const oldLines = numberValue(hunk.oldLines)
      const newStart = numberValue(hunk.newStart)
      const newLines = numberValue(hunk.newLines)
      const lines = stringArray(hunk.lines)
      if (
        oldStart === undefined ||
        oldLines === undefined ||
        newStart === undefined ||
        newLines === undefined ||
        lines.length === 0
      ) {
        return null
      }
      return { oldStart, oldLines, newStart, newLines, lines }
    })
    .filter((hunk): hunk is DiffPatchHunk => Boolean(hunk))
}

export function normalizeDiffEdits(value: unknown): DiffEdit[] {
  const edits: DiffEdit[] = []
  for (const edit of recordArray(value)) {
    const oldString = stringValue(edit.oldString)
    const newString = stringValue(edit.newString)
    if (oldString !== undefined || newString !== undefined) edits.push({ oldString, newString })
  }
  return edits
}

function rowsFromPatchHunk(hunk: DiffPatchHunk): DiffRow[] {
  const rows: DiffRow[] = []
  const removals: { lineNo: number; text: string }[] = []
  let beforeNo = hunk.oldStart
  let afterNo = hunk.newStart

  const flushRemovals = (): void => {
    while (removals.length > 0) {
      const removed = removals.shift()!
      rows.push({ kind: 'remove', beforeNo: removed.lineNo, before: removed.text })
    }
  }

  for (const rawLine of hunk.lines) {
    if (rawLine.startsWith('\\')) continue
    const marker = rawLine[0]
    const text = marker === '+' || marker === '-' || marker === ' ' ? rawLine.slice(1) : rawLine
    if (marker === '-') {
      removals.push({ lineNo: beforeNo, text })
      beforeNo += 1
      continue
    }
    if (marker === '+') {
      const removed = removals.shift()
      rows.push(
        removed
          ? { kind: 'change', beforeNo: removed.lineNo, afterNo, before: removed.text, after: text }
          : { kind: 'add', afterNo, after: text }
      )
      afterNo += 1
      continue
    }
    flushRemovals()
    rows.push({ kind: 'context', beforeNo, afterNo, before: text, after: text })
    beforeNo += 1
    afterNo += 1
  }

  flushRemovals()
  return rows
}

function rowsFromStrings(oldString: string | undefined, newString: string | undefined): DiffRow[] {
  const beforeLines = splitDiffText(oldString)
  const afterLines = splitDiffText(newString)
  const max = Math.max(beforeLines.length, afterLines.length)
  const rows: DiffRow[] = []
  for (let index = 0; index < max; index += 1) {
    const before = beforeLines[index]
    const after = afterLines[index]
    if (before === after) {
      rows.push({ kind: 'context', beforeNo: index + 1, afterNo: index + 1, before, after })
    } else if (before === undefined) {
      rows.push({ kind: 'add', afterNo: index + 1, after })
    } else if (after === undefined) {
      rows.push({ kind: 'remove', beforeNo: index + 1, before })
    } else {
      rows.push({ kind: 'change', beforeNo: index + 1, afterNo: index + 1, before, after })
    }
  }
  return rows
}

export function diffViewFromParts(args: {
  filePath?: string
  structuredPatch?: unknown
  oldString?: string
  newString?: string
  edits?: DiffEdit[]
}): DiffView | undefined {
  const reversibleEdits = (args.edits?.length ? args.edits : [{ oldString: args.oldString, newString: args.newString }])
    .filter((edit) => edit.oldString !== undefined && edit.newString !== undefined && edit.newString.length > 0)
  const patchHunks = normalizePatchHunks(args.structuredPatch)
  if (patchHunks.length > 0) {
    const hunks = patchHunks.map((hunk, index) => ({
      label: `Hunk ${index + 1}`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows: rowsFromPatchHunk(hunk)
    }))
    const stats = diffLineStats(hunks)
    return {
      filePath: args.filePath,
      hunks,
      ...stats,
      ...(reversibleEdits.length > 0 ? { revertEdits: reversibleEdits } : {})
    }
  }

  const edits = args.edits?.length ? args.edits : [{ oldString: args.oldString, newString: args.newString }]
  const hunks = edits
    .map((edit, index) => ({
      label: edits.length > 1 ? `Edit ${index + 1}` : undefined,
      rows: rowsFromStrings(edit.oldString, edit.newString)
    }))
    .filter((hunk) => hunk.rows.length > 0)
  if (hunks.length === 0) return undefined
  const stats = diffLineStats(hunks)
  return {
    filePath: args.filePath,
    hunks,
    ...stats,
    ...(reversibleEdits.length > 0 ? { revertEdits: reversibleEdits } : {})
  }
}

export function diffViewFromRecord(record: Record<string, unknown> | null): DiffView | undefined {
  if (!record) return undefined
  return diffViewFromParts({
    filePath: stringValue(record.filePath),
    structuredPatch: record.structuredPatch,
    oldString: stringValue(record.oldString),
    newString: stringValue(record.newString),
    edits: normalizeDiffEdits(record.edits)
  })
}

export function diffTitle(prefix: string, filePath?: string): string {
  return filePath ? `${prefix} · ${filePath.split(/[\\/]/).pop()}` : prefix
}

export function diffFallbackText(oldString?: string, newString?: string): string | undefined {
  const text = [
    oldString !== undefined ? `- ${oldString}` : undefined,
    newString !== undefined ? `+ ${newString}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

export function appendDiffFallbackText(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  return `${current}\n\n${next}`
}

export function mergeDiffViews(current: DiffView | undefined, next: DiffView | undefined, filePath?: string): DiffView | undefined {
  if (!current) return next
  if (!next) return current
  const hunks = [...current.hunks, ...next.hunks].map((hunk, index, all) => ({
    ...hunk,
    label: all.length > 1 ? `Hunk ${index + 1}` : hunk.label
  }))
  const stats = diffLineStats(hunks)
  const revertEdits = [...(next.revertEdits ?? []), ...(current.revertEdits ?? [])]
  return {
    filePath: filePath ?? next.filePath ?? current.filePath,
    hunks,
    ...stats,
    ...(revertEdits.length > 0 ? { revertEdits } : {})
  }
}
