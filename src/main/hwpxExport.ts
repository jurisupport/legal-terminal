import { marked, type Token, type Tokens } from 'marked'
import {
  COURT_BODY_PARA,
  COURT_BODY_TEXT,
  COURT_CONTAINER_RDF,
  COURT_CONTAINER_XML,
  COURT_CONTENT_HPF,
  COURT_COURT_PARA,
  COURT_COURT_TEXT,
  COURT_HEADER_XML,
  COURT_IMAGE1_ITEM,
  COURT_MANIFEST_XML,
  COURT_OUTLINE_PARAS,
  COURT_PIC_XML,
  COURT_SECTION_PROLOG,
  COURT_SEC_OPEN,
  COURT_SETTINGS_XML,
  COURT_TITLE_PARA,
  COURT_VERSION_XML
} from './hwpxCourtTemplate.ts'

const MIME_TYPE = 'application/hwp+zip'
const APP_XML_TYPE = 'application/xml'
const APP_TEXT_TYPE = 'text/xml'
const APP_RDF_TYPE = 'application/rdf+xml'

interface ZipEntryInput {
  name: string
  data: Buffer
  mediaType?: string
}

interface MarkdownParagraph {
  kind: 'paragraph'
  text: string
  /** 첫 블록의 번호 없는 H1 — 샘플서면의 "준 비 서 면" 자리(제목 원형)에 들어간다 */
  title?: boolean
  /** 개요 1~6수준 (1. / 가. / 1) / 가) / (1) / (가)) — 샘플 개요 원형에 들어간다 */
  outlineLevel?: number
  /** lt-align 주석에 의한 본문 정렬 */
  align?: 'center' | 'right'
}

/** hwpx 푸터에 넣을 사무실 정보(JuriSupport 프로필 등에서 공급) */
export interface HwpxOfficeInfo {
  officeName?: string
  phone?: string
  fax?: string
  email?: string
  address?: string
  /** 별도 푸터 텍스트 — 지정 시 사무실 정보 표 대신 이 텍스트를 쓴다 */
  footerText?: string
  logo?: {
    data: Buffer
    mime: 'image/png' | 'image/jpeg'
    width: number
    height: number
  }
}

type CellAlign = 'left' | 'center' | 'right'

interface MarkdownTable {
  kind: 'table'
  rows: string[][]
  widths?: ColWidthSlot[]
  aligns?: (CellAlign | null)[]
  cellAligns?: Record<string, CellAlign>
}

type MarkdownBlock = MarkdownParagraph | MarkdownTable

type ColWidth = { value: number; unit: '%' | 'cm' }
type ColWidthSlot = ColWidth | null

interface HwpxXmlContext {
  nextParagraphId: number
  nextShapeId: number
}

// ── 샘플서면.hwpx(법원제출문서 표준 서식) 스타일 ID ──
// 문단 XML은 hwpxCourtTemplate.ts 의 원형을 그대로 쓰고 텍스트만 바꿔 넣는다.
// 아래 ID는 내장 header.xml 안의 정의를 가리킨다.
/** 바탕글 글자 모양(휴먼명조 12pt) — 표 셀·푸터 텍스트에 사용 */
const BODY_CHAR_PR = 1
/** 들여쓰기 없는 본문 문단(샘플의 사건/원고/피고 블록) — 줄바꿈 있는 문단에 사용.
 *  바탕글의 첫 줄 들여쓰기가 첫 줄에만 붙어 어긋나 보이는 것을 막는다. */
const BODY_MULTILINE_PARA_PR = 6
/** lt-align용 — generate-hwpx-court-template.mjs 가 표준 header에 덧붙인 문단 모양 */
const CENTER_PARA_PR_ID = 20
const RIGHT_PARA_PR_ID = 21
const CELL_CENTER_PARA_PR_ID = 22
const CELL_RIGHT_PARA_PR_ID = 23
/** 들여쓰기·앞뒤여백 없는 문단 — 표 앵커용 */
const PLAIN_PARA_PR = 18
/** 표: 실선 테두리 borderFill(1번은 테두리 없음), 머리글행 굵게 */
const TABLE_BORDER_FILL_ID = 4
const TABLE_HEADER_CHAR_PR = 2
const TABLE_CELL_PARA_PR = 0
/** 푸터 별도 텍스트용 글자 모양(휴먼고딕 12pt) */
const FOOTER_TEXT_CHAR_PR = 16
const OUTLINE_MARKER_RE =
  /^(?:(?:\d{1,3}|[가-힣])\.(?:\s+|(?=[^\d\s]))|(?:\d{1,3}|[가-힣])\)(?:\s+|(?=[^\d\s]))|\((?:\d{1,3}|[가-힣])\)(?:\s+|(?=\S)))/
const HWP_UNIT_PER_CM = 2835

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC_TABLE.length; i += 1) {
  let c = i
  for (let j = 0; j < 8; j += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[i] = c >>> 0
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear())
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  return { date: dosDate, time: dosTime }
}

function writeUInt16(value: number): Buffer {
  const buf = Buffer.allocUnsafe(2)
  buf.writeUInt16LE(value)
  return buf
}

function writeUInt32(value: number): Buffer {
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32LE(value >>> 0)
  return buf
}

function createZip(entries: ZipEntryInput[]): Buffer {
  const fileParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const { date, time } = dosDateTime()

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)
    const flags = 0x0800
    const method = 0
    const localOffset = offset
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(flags),
      writeUInt16(method),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(crc),
      writeUInt32(data.length),
      writeUInt32(data.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name
    ])

    fileParts.push(localHeader, data)
    offset += localHeader.length + data.length

    centralParts.push(
      Buffer.concat([
        writeUInt32(0x02014b50),
        writeUInt16(20),
        writeUInt16(20),
        writeUInt16(flags),
        writeUInt16(method),
        writeUInt16(time),
        writeUInt16(date),
        writeUInt32(crc),
        writeUInt32(data.length),
        writeUInt32(data.length),
        writeUInt16(name.length),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(0),
        writeUInt32(localOffset),
        name
      ])
    )
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(offset),
    writeUInt16(0)
  ])

  return Buffer.concat([...fileParts, centralDirectory, end])
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n')
}

function inlineText(tokens?: Token[], fallback = ''): string {
  if (!tokens || tokens.length === 0) return normalizeText(fallback)
  return normalizeText(tokens.map(tokenText).join(''))
}

function tokenText(token: Token): string {
  switch (token.type) {
    case 'strong':
    case 'em':
    case 'link':
      return inlineText(token.tokens)
    case 'del': {
      const raw = String(token.raw ?? '')
      return raw.startsWith('~') && !raw.startsWith('~~') ? raw : inlineText(token.tokens)
    }
    case 'codespan':
    case 'text':
    case 'escape':
    case 'html':
      return token.text
    case 'br':
      return '\n'
    case 'image':
      return token.text || token.href
    case 'paragraph':
    case 'heading':
      return inlineText(token.tokens, token.text)
    case 'code':
      return token.text
    default:
      return 'tokens' in token && Array.isArray(token.tokens) ? inlineText(token.tokens) : ''
  }
}

function blockText(tokens?: Token[]): string {
  return normalizeText(
    (tokens ?? [])
      .map((token) => {
        switch (token.type) {
          case 'paragraph':
          case 'heading':
            return inlineText(token.tokens, token.text)
          case 'code':
            return token.text
          case 'list':
            return (token as Tokens.List).items.map((item) => listItemText(item)).join('\n')
          case 'text':
            return token.text
          default:
            return tokenText(token)
        }
      })
      .filter(Boolean)
      .join('\n')
  )
}

function listItemText(item: Tokens.ListItem): string {
  const text = blockText(item.tokens)
  if (item.task) return `${item.checked ? '[x]' : '[ ]'} ${text}`
  return text
}

function stripLeadingOutlineMarkers(value: string): string {
  const original = normalizeText(value)
  let text = original
  while (OUTLINE_MARKER_RE.test(text)) {
    text = text.replace(OUTLINE_MARKER_RE, '').trimStart()
  }
  return text || original
}

/** 서면 제목 자동 자간 — "준비서면" → "준 비 서 면" (짧은 순한글 제목만) */
function spacedTitle(value: string): string {
  return /^[가-힣]{2,5}$/.test(value) ? value.split('').join(' ') : value
}

// 개요 수준 결정 — 제목에 이미 붙은 번호 형식(1. 가. 1) 가) (1) (가))이 우선이고,
// 없으면 마크다운 heading 깊이를 쓴다(문서 제목 문단이 있으면 ##부터 1수준).
function outlineLevelFor(raw: string, depth: number, hasTitle: boolean): number {
  if (/^\(\d{1,3}\)/.test(raw)) return 5
  if (/^\([가-힣]\)/.test(raw)) return 6
  if (/^\d{1,3}\.(?:\s|[^\d\s])/.test(raw)) return 1
  if (/^[가-힣]\.(?:\s|[^\d\s])/.test(raw)) return 2
  if (/^\d{1,3}\)(?:\s|[^\d\s])/.test(raw)) return 3
  if (/^[가-힣]\)(?:\s|[^\d\s])/.test(raw)) return 4
  return Math.min(Math.max(depth - (hasTitle ? 1 : 0), 1), 6)
}

function parseColw(value: string, defaultUnit: ColWidth['unit'] = '%'): ColWidthSlot[] {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return null
      const match = trimmed.match(/^(\d+(?:\.\d+)?)(cm|%)?$/i)
      if (!match) return null
      const value = parseFloat(match[1])
      if (!(value > 0)) return null
      return {
        value,
        unit: (match[2]?.toLowerCase() === 'cm' ? 'cm' : defaultUnit) as ColWidth['unit']
      }
    })
}

function normalizeColw(widths: ColWidthSlot[], colCount: number): ColWidthSlot[] | null {
  const normalized = Array.from({ length: colCount }, (_v, index) => widths[index] ?? null)
  return normalized.some(Boolean) ? normalized : null
}

const CELL_ALIGN_CODE: Record<string, CellAlign> = { l: 'left', c: 'center', r: 'right' }

function parseCellAligns(value: string): Record<string, CellAlign> | undefined {
  const out: Record<string, CellAlign> = {}
  for (const part of value.split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)=([lcr])$/)
    if (m) out[`${m[1]}:${m[2]}`] = CELL_ALIGN_CODE[m[3]]
  }
  return Object.keys(out).length ? out : undefined
}

// "2026. 7. 8." 같은 날짜 줄을 marked가 순서 목록(시작번호 2026)으로 파싱해
// 뒤 내용이 사라지거나 다음 줄(서명 등)과 합쳐진다 → 연도 뒤 마침표를 이스케이프.
function escapeDateLines(markdown: string): string {
  return markdown.replace(/^(\s*)(\d{4})\.(?=\s)/gm, '$1$2\\.')
}

function markdownBlocks(markdown: string): MarkdownBlock[] {
  const tokens = marked.lexer(escapeDateLines(markdown), { gfm: true, breaks: true })
  const blocks: MarkdownBlock[] = []
  let align: 'none' | 'center' | 'right' = 'none'
  let hasTitle = false
  const paragraph = (text: string): MarkdownParagraph => ({
    kind: 'paragraph',
    text,
    align: align === 'center' || align === 'right' ? align : undefined
  })

  for (const token of tokens) {
    switch (token.type) {
      case 'html': {
        const comment = token.text.trim()
        const open = comment.match(/^<!--\s*lt-align:(left|center|right)\s*-->\s*$/)
        if (open) align = open[1] === 'center' || open[1] === 'right' ? open[1] : 'none'
        else if (/^<!--\s*\/lt-align\s*-->\s*$/.test(comment)) align = 'none'
        else {
          const last = blocks[blocks.length - 1]
          const colw = comment.match(/^<!--\s*colw:\s*(.*?)\s*-->\s*$/)
          const cellalign = comment.match(/^<!--\s*cellalign:\s*(.*?)\s*-->\s*$/)
          if (colw && last?.kind === 'table')
            last.widths = normalizeColw(parseColw(colw[1]), last.rows[0]?.length ?? 0) ?? undefined
          else if (cellalign && last?.kind === 'table')
            last.cellAligns = parseCellAligns(cellalign[1])
        }
        break
      }
      case 'heading': {
        const raw = inlineText(token.tokens, token.text)
        const text = stripLeadingOutlineMarkers(raw)
        if (!text) break
        // 첫 블록이 번호 없는 H1이면 문서 제목(샘플의 "준 비 서 면" 자리)으로 본다.
        if (blocks.length === 0 && token.depth === 1 && !OUTLINE_MARKER_RE.test(raw)) {
          hasTitle = true
          blocks.push({ kind: 'paragraph', text: spacedTitle(text), title: true })
          break
        }
        blocks.push({
          kind: 'paragraph',
          text,
          outlineLevel: outlineLevelFor(raw, token.depth, hasTitle)
        })
        break
      }
      case 'paragraph': {
        const text = inlineText(token.tokens, token.text)
        if (text) blocks.push(paragraph(text))
        break
      }
      case 'code': {
        const text = normalizeText(token.text)
        if (text) blocks.push(paragraph(text))
        break
      }
      case 'blockquote': {
        const text = blockText(token.tokens)
        if (text) blocks.push(paragraph(text))
        break
      }
      case 'list': {
        const list = token as Tokens.List
        // "2026. 7. 8." 같은 날짜 한 줄을 marked가 중첩 순서목록으로 읽어 본문이 사라진다
        // → 한 줄짜리 목록 토큰은 원문 그대로 문단으로 살린다.
        const rawLine = normalizeText(list.raw ?? '').trim()
        if (rawLine && !rawLine.includes('\n')) {
          blocks.push(paragraph(rawLine))
          break
        }
        list.items.forEach((item: Tokens.ListItem, index: number) => {
          const text = listItemText(item)
          if (!text) return
          const marker = list.ordered ? `${Number(list.start || 1) + index}.` : '-'
          blocks.push(paragraph(`${marker} ${text}`))
        })
        break
      }
      case 'table': {
        const table = token as Tokens.Table
        const rows = [
          table.header.map((cell: Tokens.TableCell) => inlineText(cell.tokens, cell.text)),
          ...table.rows.map((row: Tokens.TableCell[]) =>
            row.map((cell: Tokens.TableCell) => inlineText(cell.tokens, cell.text))
          )
        ]
        const columnCount = Math.max(0, ...rows.map((row) => row.length))
        if (columnCount > 0) {
          blocks.push({
            kind: 'table',
            rows: rows.map((row) => Array.from({ length: columnCount }, (_v, index) => row[index] ?? '')),
            aligns: table.align?.map((value) => (value === 'center' || value === 'right' || value === 'left' ? value : null))
          })
        }
        break
      }
      case 'hr':
        blocks.push(paragraph('---'))
        break
      default:
        break
    }
  }

  return blocks.length > 0 ? blocks : [{ kind: 'paragraph', text: '' }]
}

// 한/글이 쓰는 형식 그대로: 줄바꿈·탭을 <hp:t> "안"에 넣는다 (밖에 두면 뷰어가 무시/오해석).
function tXml(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  if (!normalized) return '<hp:t/>'
  const inner = escapeXml(normalized).replace(/\n/g, '<hp:lineBreak/>').replace(/\t/g, '<hp:tab/>')
  return `<hp:t>${inner}</hp:t>`
}

function cellParagraphXml(text: string, charPrIDRef: number, paraPrIDRef: number): string {
  return [
    `<hp:p id="0" paraPrIDRef="${paraPrIDRef}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`,
    `<hp:run charPrIDRef="${charPrIDRef}">`,
    tXml(text),
    '</hp:run>',
    '</hp:p>'
  ].join('')
}

// ── 샘플 원형 치환 ──
// 원형 문자열에서 알려진 자리를 찾아 바꾼다. 자리가 없으면(샘플 교체 후 재생성 누락 등)
// 문서를 깨뜨리는 대신 경고만 남긴다.
function replaceSlot(proto: string, find: string, replacement: string): string {
  if (!proto.includes(find)) {
    console.warn(`[hwpx] 표준 서식 원형에서 "${find.slice(0, 30)}" 자리를 찾지 못했습니다.`)
    return proto
  }
  return proto.replace(find, replacement)
}

/** 본문/개요 원형에 텍스트를 넣는다. alignParaPr가 있으면 문단 모양만 바꾼다(lt-align). */
function protoParagraphXml(
  proto: string,
  findT: string,
  text: string,
  alignParaPr?: number
): string {
  let out = replaceSlot(proto, findT, tXml(text))
  if (alignParaPr !== undefined) {
    out = out.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${alignParaPr}"`)
  }
  return out
}

function tableColumnWidths(colCount: number, widths?: ColWidthSlot[]): number[] {
  if (widths?.length === colCount && widths.some(Boolean) && widths.every((width) => !width || width.unit === 'cm')) {
    const fixed = widths.reduce((sum, width) => sum + (width ? Math.round(width.value * HWP_UNIT_PER_CM) : 0), 0)
    const autoCount = widths.filter((width) => !width).length
    const autoWidth = autoCount > 0 ? Math.max(1, Math.floor(Math.max(0, 42520 - fixed) / autoCount)) : 0
    return widths.map((width) => (width ? Math.max(1, Math.round(width.value * HWP_UNIT_PER_CM)) : autoWidth))
  }
  if (widths?.length === colCount && widths.some(Boolean) && widths.every((width) => !width || width.unit === '%')) {
    const fixed = widths.reduce((sum, width) => sum + (width?.value ?? 0), 0)
    const autoCount = widths.filter((width) => !width).length
    const auto = autoCount > 0 ? Math.max(0, 100 - fixed) / autoCount : 0
    const values = widths.map((width) => width?.value ?? auto)
    const total = values.reduce((sum, value) => sum + value, 0) || 100
    return values.map((value) => Math.max(1, Math.round((42520 * value) / total)))
  }
  return Array.from({ length: colCount }, () => Math.floor(42520 / colCount))
}

function tableXml(
  ctx: HwpxXmlContext,
  rows: string[][],
  widths?: ColWidthSlot[],
  aligns?: (CellAlign | null)[],
  cellAligns?: Record<string, CellAlign>,
  prefixRuns = ''
): string {
  const rowCount = rows.length
  const colCount = Math.max(1, ...rows.map((row) => row.length))
  const cellWidths = tableColumnWidths(colCount, widths)
  const cellParaPr = (rowIndex: number, colIndex: number): number => {
    const align =
      (rowIndex > 0 ? cellAligns?.[`${rowIndex - 1}:${colIndex}`] : undefined) ??
      aligns?.[colIndex] ??
      null
    return align === 'center'
      ? CELL_CENTER_PARA_PR_ID
      : align === 'right'
        ? CELL_RIGHT_PARA_PR_ID
        : TABLE_CELL_PARA_PR
  }
  const width = cellWidths.reduce((sum, cellWidth) => sum + cellWidth, 0)
  const height = Math.max(5000, rowCount * 1400)
  const shapeId = ctx.nextShapeId
  ctx.nextShapeId += 1
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: colCount }, (_v, colIndex) => row[colIndex] ?? '')
      return [
        '<hp:tr>',
        cells
          .map((cell, colIndex) =>
            // 셀 자식 순서는 샘플과 동일하게 subList가 먼저 온다.
            [
              `<hp:tc name="" header="${rowIndex === 0 ? '1' : '0'}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${TABLE_BORDER_FILL_ID}">`,
              '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">',
              cellParagraphXml(
                cell,
                rowIndex === 0 ? TABLE_HEADER_CHAR_PR : BODY_CHAR_PR,
                cellParaPr(rowIndex, colIndex)
              ),
              '</hp:subList>',
              `<hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}"/>`,
              '<hp:cellSpan colSpan="1" rowSpan="1"/>',
              `<hp:cellSz width="${cellWidths[colIndex]}" height="1400"/>`,
              '<hp:cellMargin left="283" right="283" top="141" bottom="141"/>',
              '</hp:tc>'
            ].join('')
          )
          .join(''),
        '</hp:tr>'
      ].join('')
    })
    .join('')

  const tbl = [
    `<hp:tbl id="${shapeId}" zOrder="${shapeId}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="${TABLE_BORDER_FILL_ID}" noAdjust="0">`,
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>`,
    '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>',
    '<hp:outMargin left="283" right="283" top="283" bottom="283"/>',
    '<hp:inMargin left="510" right="510" top="141" bottom="141"/>',
    rowXml,
    '</hp:tbl>'
  ].join('')

  const pid = ctx.nextParagraphId
  ctx.nextParagraphId += 1
  return [
    `<hp:p id="${pid}" paraPrIDRef="${PLAIN_PARA_PR}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`,
    prefixRuns,
    `<hp:run charPrIDRef="${BODY_CHAR_PR}">`,
    tbl,
    '<hp:t/>',
    '</hp:run>',
    '</hp:p>'
  ].join('')
}

/** 푸터 왼쪽 칸에 넣는 로고 그림 — 샘플의 hp:pic 원형에서 크기·참조만 바꾼다(셀 안 글자취급) */
function footerLogoPicXml(ctx: HwpxXmlContext, logo: NonNullable<HwpxOfficeInfo['logo']>): string {
  // 1px(96dpi) = 75 HWPUNIT. 칸(약 6.7cm×1.7cm)에 맞게 축소만 한다.
  const orgW = Math.max(75, Math.round(logo.width * 75))
  const orgH = Math.max(75, Math.round(logo.height * 75))
  const scale = Math.min(17000 / orgW, 3400 / orgH, 1)
  const w = Math.max(1, Math.round(orgW * scale))
  const h = Math.max(1, Math.round(orgH * scale))
  const id = ctx.nextShapeId
  ctx.nextShapeId += 1
  return COURT_PIC_XML.replace(/<hp:pic [^>]*>/, (tag) =>
    tag
      .replace(/ id="\d+"/, ` id="${id}"`)
      .replace(/instid="\d+"/, `instid="${624900000 + id}"`)
  )
    .replace(/<hp:orgSz width="\d+" height="\d+"\/>/, `<hp:orgSz width="${orgW}" height="${orgH}"/>`)
    .replace(/<hp:curSz width="\d+" height="\d+"\/>/, `<hp:curSz width="${w}" height="${h}"/>`)
    .replace(
      /<hp:rotationInfo angle="0" centerX="\d+" centerY="\d+"/,
      `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}"`
    )
    .replace(
      /<hc:scaMatrix e1="[\d.]+" e2="0" e3="0" e4="0" e5="[\d.]+"/,
      `<hc:scaMatrix e1="${scale.toFixed(6)}" e2="0" e3="0" e4="0" e5="${scale.toFixed(6)}"`
    )
    .replace(/binaryItemIDRef="[^"]*"/, 'binaryItemIDRef="logo"')
    .replace(
      /<hp:imgRect>[\s\S]*?<\/hp:imgRect>/,
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${orgW}" y="0"/><hc:pt2 x="${orgW}" y="${orgH}"/><hc:pt3 x="0" y="${orgH}"/></hp:imgRect>`
    )
    .replace(
      /<hp:imgClip left="\d+" right="\d+" top="\d+" bottom="\d+"\/>/,
      `<hp:imgClip left="0" right="${orgW}" top="0" bottom="${orgH}"/>`
    )
    .replace(
      /<hp:imgDim dimwidth="\d+" dimheight="\d+"\/>/,
      `<hp:imgDim dimwidth="${orgW}" dimheight="${orgH}"/>`
    )
    .replace(
      /<hp:sz width="\d+" widthRelTo="ABSOLUTE" height="\d+"/,
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}"`
    )
    .replace(
      /<hp:pos [^>]*\/>/,
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
    )
    .replace(/<hp:shapeComment>[\s\S]*?<\/hp:shapeComment>/, '')
}

// 제목 문단 원형(용지 설정·푸터 포함)에 제목과 사무실 정보를 채운다.
// 원형은 샘플서면.hwpx의 첫 문단 그대로라서 한/글 뷰어가 그리는 모양이 보장된다.
function titleParaXml(ctx: HwpxXmlContext, title: string, office?: HwpxOfficeInfo): string {
  let out = replaceSlot(COURT_TITLE_PARA, '<hp:t>준 비 서 면</hp:t>', tXml(title))

  const footerText = office?.footerText?.trim()
  const telFax = [office?.phone && `전화: ${office.phone}`, office?.fax && `팩스: ${office.fax}`]
    .filter(Boolean)
    .join('  ')
  const hasInfo = !!(
    office &&
    (office.officeName || telFax || office.email || office.address || office.logo)
  )

  if (footerText || !hasInfo) {
    // 별도 푸터를 쓰거나 사무실 정보가 없으면 정보 표를 뺀다 (쪽번호는 유지).
    out = out.replace(/<hp:tbl [\s\S]*?<\/hp:tbl>/, '')
    if (footerText) {
      const paras = footerText
        .split(/\r?\n/)
        .map((line) =>
          [
            `<hp:p id="0" paraPrIDRef="${CELL_CENTER_PARA_PR_ID}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`,
            `<hp:run charPrIDRef="${FOOTER_TEXT_CHAR_PR}">`,
            tXml(line),
            '</hp:run>',
            '</hp:p>'
          ].join('')
        )
        .join('')
      // 쪽번호 문단(paraPr 19) 앞에 푸터 텍스트를 넣는다.
      out = out.replace(/<hp:p [^>]*paraPrIDRef="19"/, `${paras}$&`)
    }
    return out
  }

  // 사무실 정보 표의 자리(placeholder) 치환 — 상호/로고 칸
  const officeInfo = office as HwpxOfficeInfo
  const nameT = officeInfo.officeName ? tXml(officeInfo.officeName) : '<hp:t/>'
  out = officeInfo.logo
    ? replaceSlot(
        out,
        '<hp:t>[법무법인/법률사무소 상호/로고]</hp:t>',
        `${footerLogoPicXml(ctx, officeInfo.logo)}${nameT}`
      )
    : replaceSlot(out, '<hp:t>[법무법인/법률사무소 상호/로고]</hp:t>', nameT)
  out = replaceSlot(out, '<hp:t>전화: [전화번호]  팩스: [팩스번호]</hp:t>', tXml(telFax))
  out = replaceSlot(
    out,
    '<hp:t>이메일: [이메일]</hp:t>',
    tXml(officeInfo.email ? `이메일: ${officeInfo.email}` : '')
  )
  out = replaceSlot(out, '<hp:t>[주소]</hp:t>', tXml(officeInfo.address ?? ''))
  return out
}

function sectionXml(blocks: MarkdownBlock[], office?: HwpxOfficeInfo): string {
  const ctx: HwpxXmlContext = { nextParagraphId: 1000, nextShapeId: 100 }
  // 첫 문단은 항상 샘플의 제목 문단 원형 — 용지 설정(secPr)과 푸터를 그대로 담는다.
  let title = ''
  let bodyBlocks = blocks
  if (blocks[0]?.kind === 'paragraph' && blocks[0].title) {
    title = blocks[0].text
    bodyBlocks = blocks.slice(1)
  }
  const paras = [titleParaXml(ctx, title, office)]
  for (const block of bodyBlocks) {
    if (block.kind === 'table') {
      paras.push(tableXml(ctx, block.rows, block.widths, block.aligns, block.cellAligns))
      continue
    }
    if (block.title || block.outlineLevel) {
      const level = Math.min(Math.max(block.outlineLevel ?? 1, 1), 6)
      paras.push(
        protoParagraphXml(COURT_OUTLINE_PARAS[level - 1], `<hp:t>제${level}수준</hp:t>`, block.text)
      )
      continue
    }
    // "…법원 귀중" 한 줄은 샘플의 수신 법원 원형(왼쪽 정렬, 휴먼고딕 15pt 굵게)으로.
    if (/귀중\s*$/.test(block.text) && !block.text.includes('\n')) {
      paras.push(
        protoParagraphXml(
          COURT_COURT_PARA,
          `<hp:t>${COURT_COURT_TEXT}</hp:t>`,
          block.text,
          block.align === 'center'
            ? CENTER_PARA_PR_ID
            : block.align === 'right'
              ? RIGHT_PARA_PR_ID
              : undefined
        )
      )
      continue
    }
    paras.push(
      protoParagraphXml(
        COURT_BODY_PARA,
        `<hp:t>${COURT_BODY_TEXT}</hp:t>`,
        block.text,
        block.align === 'center'
          ? CENTER_PARA_PR_ID
          : block.align === 'right'
            ? RIGHT_PARA_PR_ID
            : block.text.includes('\n')
              ? BODY_MULTILINE_PARA_PR
              : undefined
      )
    )
  }

  // 샘플과 동일한 프롤로그·네임스페이스, 문단 사이 공백 없이 이어 붙인다.
  return `${COURT_SECTION_PROLOG}${COURT_SEC_OPEN}${paras.join('')}</hs:sec>`
}

// 글꼴·문단·개요 스타일은 샘플서면.hwpx의 header.xml을 그대로 쓴다 (hwpxCourtTemplate.ts).
function headerXml(): string {
  return COURT_HEADER_XML
}

// 패키징 메타(version/settings/container/manifest/rdf/content.hpf)는 샘플 그대로 쓴다.
// 윈도 정품 한글은 이 파일들(특히 version.xml의 xmlVersion, content.hpf 구조)을 까다롭게 본다.
function contentHpfXml(title: string, logoEntry?: ZipEntryInput): string {
  const logoItem = logoEntry
    ? `<opf:item id="logo" href="${escapeXml(logoEntry.name)}" media-type="${escapeXml(logoEntry.mediaType ?? 'image/png')}" isEmbeded="1"/>`
    : ''
  return replaceSlot(COURT_CONTENT_HPF, COURT_IMAGE1_ITEM, logoItem).replace(
    '<opf:title/>',
    `<opf:title>${escapeXml(title || '문서')}</opf:title>`
  )
}

function previewText(markdown: string): string {
  return markdownBlocks(markdown)
    .map((block) => (block.kind === 'table' ? block.rows.map((row) => row.join('\t')).join('\n') : block.text))
    .join('\n')
    .slice(0, 4000)
}

function textEntry(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

export function createHwpxFromMarkdown(
  markdown: string,
  title = '문서',
  office?: HwpxOfficeInfo
): Buffer {
  const blocks = markdownBlocks(markdown)
  const logoEntry: ZipEntryInput | undefined = office?.logo
    ? {
        name: `BinData/logo.${office.logo.mime === 'image/jpeg' ? 'jpg' : 'png'}`,
        data: office.logo.data,
        mediaType: office.logo.mime
      }
    : undefined
  const entries: ZipEntryInput[] = [
    { name: 'mimetype', data: textEntry(MIME_TYPE), mediaType: MIME_TYPE },
    { name: 'version.xml', data: textEntry(COURT_VERSION_XML), mediaType: APP_TEXT_TYPE },
    { name: 'settings.xml', data: textEntry(COURT_SETTINGS_XML), mediaType: APP_TEXT_TYPE },
    {
      name: 'Contents/content.hpf',
      data: textEntry(contentHpfXml(title, logoEntry)),
      mediaType: APP_TEXT_TYPE
    },
    { name: 'Contents/header.xml', data: textEntry(headerXml()), mediaType: APP_XML_TYPE },
    {
      name: 'Contents/section0.xml',
      data: textEntry(sectionXml(blocks, office)),
      mediaType: APP_XML_TYPE
    },
    ...(logoEntry ? [logoEntry] : []),
    { name: 'META-INF/container.xml', data: textEntry(COURT_CONTAINER_XML), mediaType: APP_TEXT_TYPE },
    { name: 'META-INF/manifest.xml', data: textEntry(COURT_MANIFEST_XML), mediaType: APP_TEXT_TYPE },
    { name: 'META-INF/container.rdf', data: textEntry(COURT_CONTAINER_RDF), mediaType: APP_RDF_TYPE },
    { name: 'Preview/PrvText.txt', data: textEntry(previewText(markdown)), mediaType: APP_TEXT_TYPE }
  ]
  return createZip(entries)
}
