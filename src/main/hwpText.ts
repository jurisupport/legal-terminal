import { inflateRawSync } from 'zlib'
import { find as findCfbEntry, read as readCfb } from 'cfb'
import { parse as parseHwp } from 'hwp.js'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP_STORED = 0
const ZIP_DEFLATED = 8

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

interface HwpCharLike {
  type: number
  value: number | string
}

interface HwpParagraphLike {
  content?: HwpCharLike[]
  controls?: unknown[]
}

interface HwpParagraphListLike {
  items?: HwpParagraphLike[]
}

interface XmlBlock {
  start: number
  end: number
  inner: string
  outer: string
}

function assertRange(buf: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || offset + length > buf.length) {
    throw new Error(`손상된 HWPX ZIP: ${label} 범위를 읽을 수 없습니다.`)
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const min = Math.max(0, zip.length - 0xffff - 22)
  for (let i = zip.length - 22; i >= min; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  throw new Error('HWPX ZIP 중앙 디렉터리를 찾을 수 없습니다.')
}

function listZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip)
  assertRange(zip, eocd, 22, 'EOCD')

  const entryCount = zip.readUInt16LE(eocd + 10)
  const centralDirectorySize = zip.readUInt32LE(eocd + 12)
  const centralDirectoryOffset = zip.readUInt32LE(eocd + 16)
  if (
    centralDirectoryOffset === 0xffffffff ||
    centralDirectorySize === 0xffffffff ||
    entryCount === 0xffff
  ) {
    throw new Error('Zip64 HWPX 파일은 아직 지원하지 않습니다.')
  }
  assertRange(zip, centralDirectoryOffset, centralDirectorySize, 'central directory')

  const entries: ZipEntry[] = []
  let offset = centralDirectoryOffset
  const end = centralDirectoryOffset + centralDirectorySize
  while (offset < end) {
    assertRange(zip, offset, 46, 'central directory entry')
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('손상된 HWPX ZIP: 중앙 디렉터리 항목 서명이 올바르지 않습니다.')
    }

    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localHeaderOffset = zip.readUInt32LE(offset + 42)
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('Zip64 HWPX 파일은 아직 지원하지 않습니다.')
    }

    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    assertRange(zip, nameStart, nameLength, 'entry name')
    entries.push({
      name: zip.toString('utf8', nameStart, nameEnd),
      method,
      compressedSize,
      localHeaderOffset
    })
    offset = nameEnd + extraLength + commentLength
  }

  return entries
}

function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset
  assertRange(zip, offset, 30, `local header ${entry.name}`)
  if (zip.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`손상된 HWPX ZIP: ${entry.name} 로컬 헤더 서명이 올바르지 않습니다.`)
  }

  const nameLength = zip.readUInt16LE(offset + 26)
  const extraLength = zip.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  assertRange(zip, dataStart, entry.compressedSize, `entry data ${entry.name}`)
  const compressed = zip.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === ZIP_STORED) return Buffer.from(compressed)
  if (entry.method === ZIP_DEFLATED) return inflateRawSync(compressed)
  throw new Error(`지원하지 않는 HWPX 압축 방식입니다: ${entry.method}`)
}

function decodePreviewText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff && buf.length % 2 === 0)
    return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')

  const utf8 = buf.toString('utf8')
  return utf8.includes('\u0000') && buf.length % 2 === 0 ? buf.toString('utf16le') : utf8
}

function normalizePreviewText(buf: Buffer): string {
  return decodePreviewText(buf).replace(/^\ufeff/, '').replace(/\u0000+$/g, '').replace(/\r\n?/g, '\n')
}

function decodeXmlEntity(entity: string): string {
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const codePoint = Number.parseInt(entity.slice(2), 16)
    return Number.isFinite(codePoint) ? safeCodePoint(codePoint) : `&${entity};`
  }
  if (entity.startsWith('#')) {
    const codePoint = Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(codePoint) ? safeCodePoint(codePoint) : `&${entity};`
  }

  switch (entity) {
    case 'amp':
      return '&'
    case 'lt':
      return '<'
    case 'gt':
      return '>'
    case 'quot':
      return '"'
    case 'apos':
      return "'"
    case 'nbsp':
      return '\u00a0'
    default:
      return `&${entity};`
  }
}

function safeCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ''
  }
}

function decodeXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&([A-Za-z]+|#[0-9]+|#x[0-9A-Fa-f]+);/g, (_m, entity: string) =>
      decodeXmlEntity(entity)
    )
}

function extractHwpxTextTokens(xml: string): string {
  const tokenRe =
    /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>|<(?:[A-Za-z_][\w.-]*:)?(lineBreak|br|tab|nbSpace|fwSpace)\b[^>]*(?:\/>|><\/(?:[A-Za-z_][\w.-]*:)?(?:lineBreak|br|tab|nbSpace|fwSpace)\s*>)/gi
  let text = ''
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      // 한/글은 줄바꿈·탭을 <hp:t> 안에 넣는다 — 태그 제거 전에 문자로 바꿔 보존
      text += decodeXmlText(
        match[1]
          .replace(/<(?:[A-Za-z_][\w.-]*:)?lineBreak\b[^>]*\/?>/gi, '\n')
          .replace(/<(?:[A-Za-z_][\w.-]*:)?tab\b[^>]*\/?>/gi, '\t')
      )
      continue
    }

    const tag = match[2]?.toLowerCase()
    if (tag === 'linebreak' || tag === 'br') text += '\n'
    else if (tag === 'tab') text += '\t'
    else if (tag === 'nbsp' || tag === 'fwspace') text += ' '
  }
  return text
}

// 머리말/꼬리말 subList는 본문이 아니고, 본문 문단 안에 중첩되면 문단 경계도 깨뜨린다 → 먼저 제거.
function stripHeaderFooterBlocks(xml: string): string {
  return removeBlocks(xml, [...findXmlBlocks(xml, 'header'), ...findXmlBlocks(xml, 'footer')])
}

function extractHwpxSectionLines(xml: string): string[] {
  const body = stripHeaderFooterBlocks(xml)
  const paragraphRe =
    /<(?:[A-Za-z_][\w.-]*:)?p\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?p\s*>/gi
  const lines: string[] = []
  let match: RegExpExecArray | null
  while ((match = paragraphRe.exec(body)) !== null) {
    lines.push(extractHwpxTextTokens(match[1] ?? ''))
  }

  if (lines.length > 0) return lines
  const fallback = extractHwpxTextTokens(body)
  return fallback ? [fallback] : []
}

function normalizeExtractedText(lines: string[]): string {
  return lines.join('\n').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
}

function normalizeMarkdown(blocks: string[]): string {
  return blocks
    .map((block) => block.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeCellText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, '<br>')
    .replace(/\s+/g, ' ')
    .replace(/ ?<br> ?/g, '<br>')
    .trim()
}

function escapeMarkdownTableCell(value: string): string {
  return normalizeCellText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function markdownTable(rows: string[][]): string {
  const visibleRows = rows
    .map((row) => row.map(escapeMarkdownTableCell))
    .filter((row) => row.some(Boolean))
  const columnCount = Math.max(0, ...visibleRows.map((row) => row.length))
  if (columnCount === 0) return ''

  const padded = visibleRows.map((row) =>
    Array.from({ length: columnCount }, (_v, index) => row[index] ?? '')
  )
  const [header, ...body] = padded
  const separator = Array.from({ length: columnCount }, () => '---')
  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n')
}

function isParagraphList(value: unknown): value is HwpParagraphListLike {
  return typeof value === 'object' && value !== null && Array.isArray((value as HwpParagraphListLike).items)
}

function extractLegacyParagraphListText(list: HwpParagraphListLike): string {
  return (list.items ?? []).map(extractLegacyParagraphText).filter(Boolean).join('\n')
}

function extractLegacyParagraphListMarkdown(list: HwpParagraphListLike): string {
  return normalizeMarkdown((list.items ?? []).map(extractLegacyParagraphMarkdown))
}

function isLegacyTableRows(content: unknown[]): content is HwpParagraphListLike[][] {
  return content.length > 0 && content.every((row) => Array.isArray(row))
}

function extractLegacyTableRows(rows: HwpParagraphListLike[][]): string[][] {
  return rows.map((row) =>
    row.map((cell) => extractLegacyParagraphListText(cell).replace(/\n+/g, ' ').trim())
  )
}

function extractLegacyTableText(rows: HwpParagraphListLike[][]): string {
  return extractLegacyTableRows(rows)
    .map((row) =>
      row
        .join('\t')
        .trimEnd()
    )
    .filter(Boolean)
    .join('\n')
}

function extractLegacyControlText(control?: unknown): string {
  const content =
    typeof control === 'object' && control !== null
      ? (control as { content?: unknown }).content
      : undefined
  if (!Array.isArray(content)) return ''

  if (isLegacyTableRows(content)) {
    return extractLegacyTableText(content as HwpParagraphListLike[][])
  }

  return content
    .filter(isParagraphList)
    .map(extractLegacyParagraphListText)
    .filter(Boolean)
    .join('\n')
}

function extractLegacyControlMarkdown(control?: unknown): string {
  const content =
    typeof control === 'object' && control !== null
      ? (control as { content?: unknown }).content
      : undefined
  if (!Array.isArray(content)) return ''

  if (isLegacyTableRows(content)) {
    return markdownTable(extractLegacyTableRows(content))
  }

  return normalizeMarkdown(content.filter(isParagraphList).map(extractLegacyParagraphListMarkdown))
}

function appendBlockText(text: string, block: string): string {
  if (!block) return text
  if (!text) return block
  return text.endsWith('\n') ? text + block : `${text}\n${block}`
}

function appendMarkdownBlock(text: string, block: string): string {
  if (!block) return text
  if (!text.trim()) return block
  return `${text.trimEnd()}\n\n${block}`
}

function legacyCharText(ch: HwpCharLike): string {
  if (typeof ch.value === 'string') return ch.value

  if (ch.type === 0) {
    if (ch.value === 10 || ch.value === 13) return '\n'
    return ''
  }

  if (ch.type === 1 && ch.value === 9) return '\t'
  return ''
}

function extractLegacyParagraphText(para: HwpParagraphLike): string {
  let text = ''
  let controlIndex = 0
  let needsSeparatorBeforeText = false
  const controls = para.controls ?? []

  for (const ch of para.content ?? []) {
    if (ch.type === 0 || ch.type === 1) {
      const charText = legacyCharText(ch)
      if (!charText) continue
      if (needsSeparatorBeforeText && text && !text.endsWith('\n')) text += '\n'
      needsSeparatorBeforeText = false
      text += charText
      continue
    }

    if (ch.type === 2) {
      text = appendBlockText(text, extractLegacyControlText(controls[controlIndex]))
      needsSeparatorBeforeText = true
      controlIndex += 1
    }
  }

  for (; controlIndex < controls.length; controlIndex += 1) {
    text = appendBlockText(text, extractLegacyControlText(controls[controlIndex]))
  }

  return text
}

function extractLegacyParagraphMarkdown(para: HwpParagraphLike): string {
  let text = ''
  let controlIndex = 0
  let needsSeparatorBeforeText = false
  const controls = para.controls ?? []

  for (const ch of para.content ?? []) {
    if (ch.type === 0 || ch.type === 1) {
      const charText = legacyCharText(ch)
      if (!charText) continue
      if (needsSeparatorBeforeText && text.trim()) text += '\n\n'
      needsSeparatorBeforeText = false
      text += charText
      continue
    }

    if (ch.type === 2) {
      text = appendMarkdownBlock(text, extractLegacyControlMarkdown(controls[controlIndex]))
      needsSeparatorBeforeText = true
      controlIndex += 1
    }
  }

  for (; controlIndex < controls.length; controlIndex += 1) {
    text = appendMarkdownBlock(text, extractLegacyControlMarkdown(controls[controlIndex]))
  }

  return text
}

function sectionNumber(name: string): number {
  const match = /(?:^|\/)section([0-9]+)\.xml$/i.exec(name)
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER
}

function extractHwpxText(buf: Buffer): string {
  const entries = listZipEntries(buf)
  const sectionEntries = entries
    .filter((entry) => /(?:^|\/)section[0-9]+\.xml$/i.test(entry.name))
    .sort((a, b) => sectionNumber(a.name) - sectionNumber(b.name) || a.name.localeCompare(b.name))

  if (sectionEntries.length === 0) {
    const preview = extractHwpxPreviewText(buf, entries)
    if (preview) return preview
    throw new Error('HWPX 본문 section XML을 찾을 수 없습니다.')
  }

  const lines: string[] = []
  for (const entry of sectionEntries) {
    const xml = readZipEntry(buf, entry).toString('utf8')
    lines.push(...extractHwpxSectionLines(xml))
  }

  return normalizeExtractedText(lines)
}

function findXmlBlocks(xml: string, localName: string): XmlBlock[] {
  const tagRe = new RegExp(
    `<(/?)(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*(/?)>`,
    'gi'
  )
  const blocks: XmlBlock[] = []
  let depth = 0
  let start = -1
  let innerStart = -1
  let match: RegExpExecArray | null

  while ((match = tagRe.exec(xml)) !== null) {
    const closing = match[1] === '/'
    const selfClosing = match[2] === '/' || /\/\s*>$/.test(match[0])
    if (!closing && !selfClosing) {
      if (depth === 0) {
        start = match.index
        innerStart = tagRe.lastIndex
      }
      depth += 1
      continue
    }

    if (closing && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0 && innerStart >= 0) {
        blocks.push({
          start,
          end: tagRe.lastIndex,
          inner: xml.slice(innerStart, match.index),
          outer: xml.slice(start, tagRe.lastIndex)
        })
        start = -1
        innerStart = -1
      }
    }
  }

  return blocks
}

function blockInside(block: XmlBlock, containers: XmlBlock[]): boolean {
  return containers.some((container) => block.start > container.start && block.end < container.end)
}

function removeBlocks(xml: string, blocks: XmlBlock[]): string {
  return blocks.reduce((out, block) => out.replace(block.outer, ''), xml)
}

function extractHwpxTableMarkdown(table: XmlBlock): string {
  const rows = findXmlBlocks(table.inner, 'tr').map((row) =>
    findXmlBlocks(row.inner, 'tc').map((cell) => {
      const nestedTables = findXmlBlocks(cell.inner, 'tbl')
      const cellXml = removeBlocks(cell.inner, nestedTables)
      const paragraphs = findXmlBlocks(cellXml, 'p')
      const text =
        paragraphs.length > 0
          ? paragraphs.map((para) => extractHwpxTextTokens(para.inner)).filter(Boolean).join('\n')
          : extractHwpxTextTokens(cellXml)
      return text
    })
  )
  return markdownTable(rows)
}

function extractHwpxSectionMarkdownBlocks(rawXml: string): string[] {
  const xml = stripHeaderFooterBlocks(rawXml)
  const tables = findXmlBlocks(xml, 'tbl')
  const paragraphs = findXmlBlocks(xml, 'p').filter((para) => !blockInside(para, tables))
  const blocks = [
    ...paragraphs.map((block) => ({ kind: 'paragraph' as const, block })),
    ...tables.map((block) => ({ kind: 'table' as const, block }))
  ].sort((a, b) => a.block.start - b.block.start)

  return blocks
    .map(({ kind, block }) => {
      if (kind === 'table') return extractHwpxTableMarkdown(block)
      const nestedTables = tables.filter((table) => table.start > block.start && table.end < block.end)
      return extractHwpxTextTokens(removeBlocks(block.inner, nestedTables))
    })
    .filter(Boolean)
}

function extractHwpxMarkdown(buf: Buffer): string {
  const entries = listZipEntries(buf)
  const sectionEntries = entries
    .filter((entry) => /(?:^|\/)section[0-9]+\.xml$/i.test(entry.name))
    .sort((a, b) => sectionNumber(a.name) - sectionNumber(b.name) || a.name.localeCompare(b.name))

  if (sectionEntries.length === 0) {
    const preview = extractHwpxPreviewText(buf, entries)
    if (preview) return preview
    throw new Error('HWPX 본문 section XML을 찾을 수 없습니다.')
  }

  const blocks: string[] = []
  for (const entry of sectionEntries) {
    const xml = readZipEntry(buf, entry).toString('utf8')
    blocks.push(...extractHwpxSectionMarkdownBlocks(xml))
  }

  return normalizeMarkdown(blocks)
}

function extractHwpxPreviewText(buf: Buffer, entries: ZipEntry[]): string {
  const preview = entries.find((entry) => /(?:^|\/)Preview\/PrvText\.txt$/i.test(entry.name))
  return preview ? normalizePreviewText(readZipEntry(buf, preview)) : ''
}

export function extractHwpDocumentText(doc: { sections: { content: HwpParagraphLike[] }[] }): string {
  const lines: string[] = []
  for (const section of doc.sections) {
    for (const para of section.content) {
      lines.push(extractLegacyParagraphText(para))
    }
  }
  return normalizeExtractedText(lines)
}

export function extractHwpDocumentMarkdown(doc: { sections: { content: HwpParagraphLike[] }[] }): string {
  const blocks: string[] = []
  for (const section of doc.sections) {
    for (const para of section.content) {
      blocks.push(extractLegacyParagraphMarkdown(para))
    }
  }
  return normalizeMarkdown(blocks)
}

function extractLegacyHwpText(buf: Buffer): string {
  try {
    const doc = parseHwp(buf as unknown as Parameters<typeof parseHwp>[0])
    return extractHwpDocumentText(doc)
  } catch (e) {
    const preview = extractLegacyHwpPreviewText(buf)
    if (preview) return preview
    throw e
  }
}

function extractLegacyHwpMarkdown(buf: Buffer): string {
  try {
    const doc = parseHwp(buf as unknown as Parameters<typeof parseHwp>[0])
    return extractHwpDocumentMarkdown(doc)
  } catch (e) {
    const preview = extractLegacyHwpPreviewText(buf)
    if (preview) return preview
    throw e
  }
}

function extractLegacyHwpPreviewText(buf: Buffer): string {
  try {
    const container = readCfb(buf)
    const preview = findCfbEntry(container, 'PrvText')
    return preview ? normalizePreviewText(Buffer.from(preview.content)) : ''
  } catch {
    return ''
  }
}

export function extractHwpText(buf: Buffer, ext: string): string {
  return ext.toLowerCase() === '.hwpx' ? extractHwpxText(buf) : extractLegacyHwpText(buf)
}

export function extractHwpMarkdown(buf: Buffer, ext: string): string {
  return ext.toLowerCase() === '.hwpx' ? extractHwpxMarkdown(buf) : extractLegacyHwpMarkdown(buf)
}
