import { marked, type Token, type Tokens } from 'marked'

const XML_VERSION = '1.31'
const MIME_TYPE = 'application/hwp+zip'
const APP_XML_TYPE = 'application/xml'
const APP_TEXT_TYPE = 'text/xml'
const APP_RDF_TYPE = 'application/rdf+xml'
const PACKAGE_TYPE = 'application/hwpml-package+xml'

const NS = {
  hv: 'http://www.hancom.co.kr/hwpml/2011/version',
  ha: 'http://www.hancom.co.kr/hwpml/2011/app',
  hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  hs: 'http://www.hancom.co.kr/hwpml/2011/section',
  hc: 'http://www.hancom.co.kr/hwpml/2011/core',
  hh: 'http://www.hancom.co.kr/hwpml/2011/head',
  hpf: 'http://www.hancom.co.kr/schema/2011/hpf',
  opf: 'http://www.idpf.org/2007/opf/',
  dc: 'http://purl.org/dc/elements/1.1/',
  ocf: 'urn:oasis:names:tc:opendocument:xmlns:container',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
}

interface ZipEntryInput {
  name: string
  data: Buffer
  mediaType?: string
}

interface MarkdownParagraph {
  kind: 'paragraph'
  text: string
  charPrIDRef?: number
  paraPrIDRef?: number
}

interface MarkdownTable {
  kind: 'table'
  rows: string[][]
  widths?: ColWidthSlot[]
}

type MarkdownBlock = MarkdownParagraph | MarkdownTable

type ColWidth = { value: number; unit: '%' | 'cm' }
type ColWidthSlot = ColWidth | null

interface HwpxXmlContext {
  nextParagraphId: number
  nextShapeId: number
}

const BASE_FONT_FACE = '휴먼명조'
const BASE_FONT_HEIGHT = 1200
const BODY_FIRST_LINE_INDENT = 1200
const CENTER_PARA_PR_ID = 7
const FONT_FACE_LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']
const OUTLINE_HEADS = [
  { numFormat: 'DIGIT', text: '^1.' },
  { numFormat: 'HANGUL_SYLLABLE', text: '^2.' },
  { numFormat: 'DIGIT', text: '^3)' },
  { numFormat: 'HANGUL_SYLLABLE', text: '^4)' },
  { numFormat: 'DIGIT', text: '(^5)' },
  { numFormat: 'HANGUL_SYLLABLE', text: '(^6)' }
]
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

function markdownBlocks(markdown: string): MarkdownBlock[] {
  const tokens = marked.lexer(markdown, { gfm: true, breaks: true })
  const blocks: MarkdownBlock[] = []
  let center = false
  const paragraph = (
    text: string,
    opts: Omit<MarkdownParagraph, 'kind' | 'text'> = {}
  ): MarkdownParagraph => ({
    kind: 'paragraph',
    text,
    ...opts,
    paraPrIDRef: center ? CENTER_PARA_PR_ID : opts.paraPrIDRef
  })

  for (const token of tokens) {
    switch (token.type) {
      case 'html':
        if (/^<!--\s*lt-align:center\s*-->\s*$/.test(token.text.trim())) center = true
        else if (/^<!--\s*\/lt-align\s*-->\s*$/.test(token.text.trim())) center = false
        else {
          const colw = token.text.trim().match(/^<!--\s*colw:\s*(.*?)\s*-->\s*$/)
          const last = blocks[blocks.length - 1]
          if (colw && last?.kind === 'table')
            last.widths = normalizeColw(parseColw(colw[1]), last.rows[0]?.length ?? 0) ?? undefined
        }
        break
      case 'heading': {
        const text = stripLeadingOutlineMarkers(inlineText(token.tokens, token.text))
        if (text) {
          const level = Math.min(token.depth, 6)
          blocks.push(paragraph(text, { charPrIDRef: level, paraPrIDRef: level }))
        }
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
            rows: rows.map((row) => Array.from({ length: columnCount }, (_v, index) => row[index] ?? ''))
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

function textXml(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  if (!normalized) return '<hp:t />'
  const parts: string[] = []
  const lines = normalized.split('\n')
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) parts.push('<hp:lineBreak />')
    const segments = line.split('\t')
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) parts.push('<hp:tab />')
      if (segment) parts.push(`<hp:t xml:space="preserve">${escapeXml(segment)}</hp:t>`)
    })
  })
  return parts.length > 0 ? parts.join('') : '<hp:t />'
}

function paragraphXml(ctx: HwpxXmlContext, text: string, charPrIDRef = 0, paraPrIDRef = 0): string {
  const id = ctx.nextParagraphId
  ctx.nextParagraphId += 1
  return [
    `<hp:p id="${id}" paraPrIDRef="${paraPrIDRef}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`,
    `<hp:run charPrIDRef="${charPrIDRef}">`,
    textXml(text),
    '</hp:run>',
    '</hp:p>'
  ].join('')
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

function tableXml(ctx: HwpxXmlContext, rows: string[][], widths?: ColWidthSlot[]): string {
  const rowCount = rows.length
  const colCount = Math.max(1, ...rows.map((row) => row.length))
  const cellWidths = tableColumnWidths(colCount, widths)
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
            [
              `<hp:tc name="" header="${rowIndex === 0 ? '1' : '0'}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">`,
              `<hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}" />`,
              '<hp:cellSpan colSpan="1" rowSpan="1" />',
              `<hp:cellSz width="${cellWidths[colIndex]}" height="1400" />`,
              '<hp:cellMargin left="283" right="283" top="141" bottom="141" />',
              '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">',
              paragraphXml(ctx, cell, rowIndex === 0 ? 1 : 0),
              '</hp:subList>',
              '</hp:tc>'
            ].join('')
          )
          .join(''),
        '</hp:tr>'
      ].join('')
    })
    .join('')

  return paragraphXml(
    ctx,
    ''
  ).replace(
    '<hp:t />',
    [
      `<hp:tbl id="${shapeId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">`,
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0" />`,
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0" />',
      '<hp:outMargin left="0" right="0" top="0" bottom="0" />',
      '<hp:inMargin left="0" right="0" top="0" bottom="0" />',
      rowXml,
      '</hp:tbl>'
    ].join('')
  )
}

function sectionXml(blocks: MarkdownBlock[]): string {
  const ctx: HwpxXmlContext = { nextParagraphId: 0, nextShapeId: 1 }
  const body = blocks
    .map((block) =>
      block.kind === 'table'
        ? tableXml(ctx, block.rows, block.widths)
        : paragraphXml(ctx, block.text, block.charPrIDRef ?? 0, block.paraPrIDRef ?? 0)
    )
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<hs:sec xmlns:hs="${NS.hs}" xmlns:hp="${NS.hp}" xmlns:hc="${NS.hc}">`,
    body,
    '</hs:sec>'
  ].join('\n')
}

function headerXml(): string {
  const headingParaPrs = Array.from({ length: CENTER_PARA_PR_ID + 1 }, (_v, id) => {
    const heading =
      id > 0 && id < CENTER_PARA_PR_ID
        ? `<hh:heading type="OUTLINE" idRef="0" level="${id - 1}" />`
        : ''
    const firstLineIndent = id === 0 ? BODY_FIRST_LINE_INDENT : 0
    const horizontal = id === CENTER_PARA_PR_ID ? 'CENTER' : 'JUSTIFY'
    return [
      `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">`,
      heading,
      `<hh:align horizontal="${horizontal}" vertical="BASELINE" />`,
      '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" pageBreakBefore="0" lineWrap="BREAK" />',
      '<hh:margin>',
      `<hc:intent value="${firstLineIndent}" unit="HWPUNIT" />`,
      '<hc:left value="0" unit="HWPUNIT" />',
      '<hc:right value="0" unit="HWPUNIT" />',
      '<hc:prev value="0" unit="HWPUNIT" />',
      '<hc:next value="0" unit="HWPUNIT" />',
      '</hh:margin>',
      '<hh:lineSpacing type="PERCENT" value="160" />',
      '</hh:paraPr>'
    ].join('')
  })
  const outlineHeads = OUTLINE_HEADS.map(
    (head, level) =>
      `<hh:paraHead start="1" level="${level}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${head.numFormat}" charPrIDRef="0" checkable="0">${head.text}</hh:paraHead>`
  )
  const fontFaces = FONT_FACE_LANGS.map(
    (lang) =>
      `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="${BASE_FONT_FACE}" type="TTF" isEmbedded="0" /></hh:fontface>`
  )

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<hh:head xmlns:hh="${NS.hh}" xmlns:hp="${NS.hp}" xmlns:hc="${NS.hc}" version="${XML_VERSION}" secCnt="1">`,
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1" />',
    '<hh:refList>',
    `<hh:fontfaces itemCnt="${FONT_FACE_LANGS.length}">`,
    ...fontFaces,
    '</hh:fontfaces>',
    '<hh:borderFills itemCnt="2">',
    '<hh:borderFill id="0" threeD="0" shadow="0" breakCellSeparateLine="0" slash="NONE" backSlash="NONE" />',
    '<hh:borderFill id="1" threeD="0" shadow="0" breakCellSeparateLine="0" slash="NONE" backSlash="NONE">',
    '<hh:leftBorder type="SOLID" width="0.1 mm" color="#000000" />',
    '<hh:rightBorder type="SOLID" width="0.1 mm" color="#000000" />',
    '<hh:topBorder type="SOLID" width="0.1 mm" color="#000000" />',
    '<hh:bottomBorder type="SOLID" width="0.1 mm" color="#000000" />',
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000" />',
    '</hh:borderFill>',
    '</hh:borderFills>',
    '<hh:charProperties itemCnt="7">',
    ...Array.from({ length: 7 }, (_v, id) =>
      `<hh:charPr id="${id}" height="${BASE_FONT_HEIGHT}" textColor="#000000" shadeColor="#FFFFFF" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0" /><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100" /><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0" /><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100" /><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0" /></hh:charPr>`
    ),
    '</hh:charProperties>',
    '<hh:numberings itemCnt="1">',
    '<hh:numbering id="0" start="1">',
    ...outlineHeads,
    '</hh:numbering>',
    '</hh:numberings>',
    `<hh:paraProperties itemCnt="${headingParaPrs.length}">`,
    ...headingParaPrs,
    '</hh:paraProperties>',
    '<hh:styles itemCnt="1">',
    '<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0" />',
    '</hh:styles>',
    '</hh:refList>',
    '</hh:head>'
  ].join('\n')
}

function versionXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<hv:HCFVersion xmlns:hv="${NS.hv}" targetApplication="HWP" major="5" minor="1" micro="0" buildNumber="0" os="1" xmlVersion="${XML_VERSION}" application="legal-terminal" appVersion="0.1" />`
  ].join('\n')
}

function settingsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<ha:HWPApplicationSetting xmlns:ha="${NS.ha}">`,
    '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0" />',
    '</ha:HWPApplicationSetting>'
  ].join('\n')
}

function contentXml(title: string): string {
  const safeTitle = escapeXml(title || '문서')
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<opf:package xmlns:opf="${NS.opf}" xmlns:dc="${NS.dc}" xmlns:hpf="${NS.hpf}" version="1.0" unique-identifier="uid" id="legal-terminal">`,
    '<opf:metadata>',
    `<dc:title>${safeTitle}</dc:title>`,
    '<dc:language>ko-KR</dc:language>',
    '<dc:identifier id="uid">legal-terminal-md-to-hwpx</dc:identifier>',
    '</opf:metadata>',
    '<opf:manifest>',
    `<opf:item id="header" href="Contents/header.xml" media-type="${APP_XML_TYPE}" />`,
    `<opf:item id="section0" href="Contents/section0.xml" media-type="${APP_XML_TYPE}" />`,
    `<opf:item id="settings" href="settings.xml" media-type="${APP_TEXT_TYPE}" />`,
    '</opf:manifest>',
    '<opf:spine>',
    '<opf:itemref idref="section0" linear="yes" />',
    '</opf:spine>',
    '</opf:package>'
  ].join('\n')
}

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<ocf:container xmlns:ocf="${NS.ocf}">`,
    '<ocf:rootfiles>',
    `<ocf:rootfile full-path="Contents/content.hpf" media-type="${PACKAGE_TYPE}" />`,
    `<ocf:rootfile full-path="Preview/PrvText.txt" media-type="${APP_TEXT_TYPE}" />`,
    `<ocf:rootfile full-path="META-INF/container.rdf" media-type="${APP_RDF_TYPE}" />`,
    '</ocf:rootfiles>',
    '</ocf:container>'
  ].join('\n')
}

function manifestXml(entries: ZipEntryInput[]): string {
  const fileEntries = entries
    .filter((entry) => entry.name !== 'META-INF/manifest.xml' && entry.mediaType)
    .map(
      (entry) =>
        `<odf:file-entry odf:full-path="${escapeXml(entry.name)}" odf:media-type="${escapeXml(entry.mediaType ?? '')}" />`
    )

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<odf:manifest xmlns:odf="${NS.manifest}">`,
    ...fileEntries,
    '</odf:manifest>'
  ].join('\n')
}

function rdfXml(title: string): string {
  const safeTitle = escapeXml(title || '문서')
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dc="${NS.dc}">`,
    '<rdf:Description rdf:about="Contents/content.hpf">',
    `<dc:title>${safeTitle}</dc:title>`,
    '</rdf:Description>',
    '</rdf:RDF>'
  ].join('\n')
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

export function createHwpxFromMarkdown(markdown: string, title = '문서'): Buffer {
  const blocks = markdownBlocks(markdown)
  const entriesWithoutManifest: ZipEntryInput[] = [
    { name: 'mimetype', data: textEntry(MIME_TYPE), mediaType: MIME_TYPE },
    { name: 'version.xml', data: textEntry(versionXml()), mediaType: APP_TEXT_TYPE },
    { name: 'settings.xml', data: textEntry(settingsXml()), mediaType: APP_TEXT_TYPE },
    { name: 'Contents/content.hpf', data: textEntry(contentXml(title)), mediaType: APP_TEXT_TYPE },
    { name: 'Contents/header.xml', data: textEntry(headerXml()), mediaType: APP_XML_TYPE },
    { name: 'Contents/section0.xml', data: textEntry(sectionXml(blocks)), mediaType: APP_XML_TYPE },
    { name: 'META-INF/container.xml', data: textEntry(containerXml()), mediaType: APP_TEXT_TYPE },
    { name: 'META-INF/container.rdf', data: textEntry(rdfXml(title)), mediaType: APP_RDF_TYPE },
    { name: 'Preview/PrvText.txt', data: textEntry(previewText(markdown)), mediaType: APP_TEXT_TYPE }
  ]
  const entries: ZipEntryInput[] = [
    ...entriesWithoutManifest,
    {
      name: 'META-INF/manifest.xml',
      data: textEntry(manifestXml(entriesWithoutManifest)),
      mediaType: APP_TEXT_TYPE
    }
  ]
  return createZip(entries)
}
