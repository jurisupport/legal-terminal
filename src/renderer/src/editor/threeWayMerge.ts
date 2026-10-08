export type ThreeWayTextMergeResult =
  | { status: 'unchanged' }
  | { status: 'merged'; text: string; remoteHunkCount: number }
  | { status: 'conflict'; reason: string }

interface TextChange {
  from: number
  to: number
  insert: string
}

interface TextHunk extends TextChange {
  conflictFrom: number
  conflictTo: number
}

interface LineMap {
  lines: string[]
  offsets: number[]
}

const MAX_LINE_DIFF_CELLS = 1_500_000

// Keep unchanged paragraphs outside replacement ranges so editor positions can be mapped.
export function findTextChanges(base: string, modified: string): TextChange[] {
  if (base === modified) return []
  const baseMap = buildLineMap(base)
  const modifiedMap = buildLineMap(modified)
  if (baseMap.lines.length * modifiedMap.lines.length > MAX_LINE_DIFF_CELLS) {
    // Split large comparisons at an unchanged line instead of replacing the whole middle.
    const uniqueLines = new Map<string, number>()
    modifiedMap.lines.forEach((line, index) => {
      uniqueLines.set(line, uniqueLines.has(line) ? -1 : index)
    })
    const middle = Math.floor(baseMap.lines.length / 2)
    for (let distance = 0; distance < baseMap.lines.length; distance++) {
      const index = distance % 2 === 0 ? middle + distance / 2 : middle - (distance + 1) / 2
      const line = baseMap.lines[index]
      const match = uniqueLines.get(line)
      if (!line?.trim() || match === undefined || match < 0) continue
      const before = findTextChanges(
        base.slice(0, baseMap.offsets[index]), modified.slice(0, modifiedMap.offsets[match])
      )
      const offset = baseMap.offsets[index + 1]
      const after = findTextChanges(base.slice(offset), modified.slice(modifiedMap.offsets[match + 1]))
      return [...before, ...after.map((change) => ({ ...change, from: change.from + offset, to: change.to + offset }))]
    }
  }
  return buildTextHunks(base, modified, baseMap).map((hunk) => {
    const change = minimalTextChange(base.slice(hunk.from, hunk.to), hunk.insert)
    return { from: hunk.from + change.from, to: hunk.from + change.to, insert: change.insert }
  })
}

export function mergeTextAgainstBase(base: string, local: string, remote: string): ThreeWayTextMergeResult {
  if (remote === base) return { status: 'unchanged' }
  if (local === remote) return { status: 'merged', text: local, remoteHunkCount: 0 }
  if (local === base) return { status: 'merged', text: remote, remoteHunkCount: 1 }

  const lineMap = buildLineMap(base)
  const localHunks = buildTextHunks(base, local, lineMap)
  const remoteHunks = buildTextHunks(base, remote, lineMap)
  if (remoteHunks.length === 0) return { status: 'unchanged' }
  if (localHunks.length === 0) return { status: 'merged', text: remote, remoteHunkCount: remoteHunks.length }

  const hunks = [...localHunks]
  for (const remoteHunk of remoteHunks) {
    const duplicate = localHunks.some((localHunk) => sameHunk(localHunk, remoteHunk))
    if (duplicate) continue
    const conflict = localHunks.some((localHunk) => hunksConflict(localHunk, remoteHunk))
    if (conflict) {
      return {
        status: 'conflict',
        reason: 'local and external changes touch the same paragraph'
      }
    }
    hunks.push(remoteHunk)
  }

  const text = applyHunks(base, hunks)
  return { status: 'merged', text, remoteHunkCount: remoteHunks.length }
}

function buildTextHunks(base: string, modified: string, lineMap: LineMap): TextHunk[] {
  if (base === modified) return []
  const modifiedLines = splitTextLines(modified)
  const cellCount = lineMap.lines.length * modifiedLines.length
  const lineHunks =
    cellCount <= MAX_LINE_DIFF_CELLS ? buildLineHunks(lineMap, modifiedLines) : null
  if (lineHunks) return lineHunks
  return [buildSingleHunk(base, modified, lineMap)]
}

function buildSingleHunk(base: string, modified: string, lineMap: LineMap): TextHunk {
  const { from, to, insert } = minimalTextChange(base, modified)
  return makeHunk(from, to, insert, lineMap)
}

function minimalTextChange(base: string, modified: string): TextChange {
  let prefix = 0
  const limit = Math.min(base.length, modified.length)
  while (prefix < limit && base.charCodeAt(prefix) === modified.charCodeAt(prefix)) prefix++

  let baseSuffix = base.length
  let modifiedSuffix = modified.length
  while (
    baseSuffix > prefix &&
    modifiedSuffix > prefix &&
    base.charCodeAt(baseSuffix - 1) === modified.charCodeAt(modifiedSuffix - 1)
  ) {
    baseSuffix--
    modifiedSuffix--
  }

  return { from: prefix, to: baseSuffix, insert: modified.slice(prefix, modifiedSuffix) }
}

function buildLineHunks(lineMap: LineMap, modifiedLines: string[]): TextHunk[] | null {
  const baseLines = lineMap.lines
  const baseCount = baseLines.length
  const modifiedCount = modifiedLines.length
  const stride = modifiedCount + 1
  const cells = (baseCount + 1) * stride
  const lcs = new Uint32Array(cells)

  for (let i = baseCount - 1; i >= 0; i--) {
    for (let j = modifiedCount - 1; j >= 0; j--) {
      const index = i * stride + j
      lcs[index] =
        baseLines[i] === modifiedLines[j]
          ? lcs[(i + 1) * stride + j + 1] + 1
          : Math.max(lcs[(i + 1) * stride + j], lcs[i * stride + j + 1])
    }
  }

  const hunks: TextHunk[] = []
  let i = 0
  let j = 0
  let baseStart = -1
  let baseEnd = -1
  let insert = ''

  const flush = (): void => {
    if (baseStart < 0) return
    hunks.push(makeHunk(lineMap.offsets[baseStart], lineMap.offsets[baseEnd], insert, lineMap))
    baseStart = -1
    baseEnd = -1
    insert = ''
  }

  const open = (): void => {
    if (baseStart >= 0) return
    baseStart = i
    baseEnd = i
  }

  while (i < baseCount || j < modifiedCount) {
    if (i < baseCount && j < modifiedCount && baseLines[i] === modifiedLines[j]) {
      flush()
      i++
      j++
      continue
    }

    open()
    if (j < modifiedCount && (i >= baseCount || lcs[i * stride + j + 1] >= lcs[(i + 1) * stride + j])) {
      insert += modifiedLines[j]
      j++
    } else if (i < baseCount) {
      i++
      baseEnd = i
    } else {
      return null
    }
  }
  flush()
  return hunks
}

function makeHunk(from: number, to: number, insert: string, lineMap: LineMap): TextHunk {
  const range = expandToParagraphRange(from, to, lineMap)
  return {
    from,
    to,
    insert,
    conflictFrom: range.from,
    conflictTo: range.to
  }
}

function applyHunks(base: string, hunks: TextHunk[]): string {
  const ordered = [...hunks].sort((a, b) => a.from - b.from || b.to - a.to)
  let out = ''
  let position = 0
  for (const hunk of ordered) {
    if (hunk.from < position) {
      throw new Error('Cannot apply overlapping text hunks')
    }
    out += base.slice(position, hunk.from)
    out += hunk.insert
    position = hunk.to
  }
  return out + base.slice(position)
}

function hunksConflict(a: TextHunk, b: TextHunk): boolean {
  if (a.from === a.to && b.from === b.to && a.from === b.from) return a.insert !== b.insert
  return rangesOverlap(a.conflictFrom, a.conflictTo, b.conflictFrom, b.conflictTo)
}

function sameHunk(a: TextHunk, b: TextHunk): boolean {
  return a.from === b.from && a.to === b.to && a.insert === b.insert
}

function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  if (aFrom === aTo || bFrom === bTo) return aFrom === bFrom
  return aFrom < bTo && bFrom < aTo
}

function buildLineMap(text: string): LineMap {
  const lines = splitTextLines(text)
  const offsets = [0]
  let offset = 0
  for (const line of lines) {
    offset += line.length
    offsets.push(offset)
  }
  return { lines, offsets }
}

function splitTextLines(text: string): string[] {
  if (!text) return []
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue
    lines.push(text.slice(start, index + 1))
    start = index + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

function expandToParagraphRange(from: number, to: number, lineMap: LineMap): { from: number; to: number } {
  const { lines, offsets } = lineMap
  if (lines.length === 0) return { from, to }

  let startLine = lineIndexAtOffset(offsets, from)
  let endLine = lineIndexAtOffset(offsets, to > from ? to - 1 : from)

  while (startLine > 0 && !isBlankLine(lines[startLine - 1])) startLine--
  while (endLine + 1 < lines.length && !isBlankLine(lines[endLine + 1])) endLine++

  return {
    from: offsets[startLine],
    to: offsets[endLine + 1]
  }
}

function lineIndexAtOffset(offsets: number[], offset: number): number {
  if (offsets.length <= 1) return 0
  const maxLine = offsets.length - 2
  const clamped = Math.max(0, Math.min(offset, offsets[offsets.length - 1]))
  let low = 0
  let high = offsets.length - 1
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (offsets[mid] <= clamped) low = mid
    else high = mid
  }
  return Math.min(low, maxLine)
}

function isBlankLine(line: string): boolean {
  return line.replace(/\r?\n$/, '').trim() === ''
}
