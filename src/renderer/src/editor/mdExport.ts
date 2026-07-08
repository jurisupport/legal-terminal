import { parseMarkdown } from './markdownCompat.ts'

type ColWidth = { value: number; unit: '%' | 'cm' }
type ColWidthSlot = ColWidth | null

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

function formatWidth(width: ColWidth): string {
  return `${width.value}${width.unit}`
}

function columnCount(row: string): number {
  let value = row.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return Math.max(1, value.split('|').length)
}

function normalizeColw(widths: ColWidthSlot[], colCount: number): ColWidthSlot[] | null {
  const normalized = Array.from({ length: colCount }, (_v, index) => widths[index] ?? null)
  return normalized.some(Boolean) ? normalized : null
}

type CellAligns = Record<string, 'left' | 'center' | 'right'>
const CELL_ALIGN_CODE: Record<string, 'left' | 'center' | 'right'> = {
  l: 'left',
  c: 'center',
  r: 'right'
}

function parseCellAligns(value: string): CellAligns | null {
  const out: CellAligns = {}
  for (const part of value.split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)=([lcr])$/)
    if (m) out[`${m[1]}:${m[2]}`] = CELL_ALIGN_CODE[m[3]]
  }
  return Object.keys(out).length ? out : null
}

interface TableMeta {
  widths: ColWidthSlot[] | null
  cellAligns: CellAligns | null
}

// 표 뒤 colw(열너비)/cellalign(셀 정렬) 주석을 표별로 추출하고 주석 줄은 제거
function extractTableMeta(md: string): { md: string; metas: TableMeta[] } {
  const lines = md.split('\n')
  const out: string[] = []
  const metas: TableMeta[] = []
  const isSep = (l: string): boolean => /-/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(l)
  let i = 0
  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      out.push(lines[i], lines[i + 1])
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim().length) {
        out.push(lines[j])
        j++
      }
      const meta: TableMeta = { widths: null, cellAligns: null }
      while (j < lines.length) {
        const mw = lines[j].match(/^<!--\s*colw:\s*(.*?)\s*-->\s*$/)
        if (mw) {
          meta.widths = normalizeColw(parseColw(mw[1]), columnCount(lines[i]))
          j++
          continue
        }
        const mc = lines[j].match(/^<!--\s*cellalign:\s*(.*?)\s*-->\s*$/)
        if (mc) {
          meta.cellAligns = parseCellAligns(mc[1])
          j++
          continue
        }
        break
      }
      metas.push(meta)
      i = j
      continue
    }
    out.push(lines[i])
    i++
  }
  return { md: out.join('\n'), metas }
}

export type PrintLayoutProfile = 'default' | 'proof-of-content'

interface PrintLayout {
  fontSizePt: number
  pageMargin: string
}

const PRINT_LAYOUTS: Record<PrintLayoutProfile, PrintLayout> = {
  default: {
    fontSizePt: 12,
    pageMargin: '18mm 16mm'
  },
  'proof-of-content': {
    fontSizePt: 12,
    pageMargin: '20mm 15mm 40mm 15mm'
  }
}

function printCss(profile: PrintLayoutProfile): string {
  const layout = PRINT_LAYOUTS[profile]
  return `
@page { size: A4; margin: ${layout.pageMargin}; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; font-family: 'Malgun Gothic','Segoe UI',system-ui,sans-serif; font-size: ${layout.fontSizePt}pt; line-height: 1.7; }
h1,h2,h3,h4 { font-weight: 700; line-height: 1.3; margin: 1.2em 0 .5em; }
h1 { font-size: 1.8em; border-bottom: 1px solid #ccc; padding-bottom: .2em; }
h2 { font-size: 1.45em; border-bottom: 1px solid #ddd; padding-bottom: .15em; }
h3 { font-size: 1.22em; }
p { margin: .6em 0; }
p,li,th,td { white-space: break-spaces; }
ul,ol { margin: .5em 0; padding-left: 1.6em; }
li { margin: .2em 0; }
a { color: #1456b8; text-decoration: none; }
code { font-family: 'D2Coding',Consolas,monospace; background: #f2f2f2; padding: 1px 5px; border-radius: 3px; font-size: .9em; }
pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 5px; padding: 10px 12px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: .8em 0; padding: 2px 14px; border-left: 3px solid #888; color: #555; }
hr { border: none; border-top: 1px solid #ccc; margin: 1.4em 0; }
img { max-width: 100%; }
table { border-collapse: collapse; width: 100%; margin: .8em 0; break-inside: auto; page-break-inside: auto; }
table.fixed { table-layout: fixed; }
th,td { border: 1px solid #999; padding: 5px 9px; text-align: left; word-break: break-word; }
th[align="center"],td[align="center"] { text-align: center; }
th[align="right"],td[align="right"] { text-align: right; }
th { background: #f0f0f0; }
.lt-align-left { text-align: left; }
.lt-align-center { text-align: center; }
.lt-align-right { text-align: right; }
`
}

function applyAlignBlocks(html: string): string {
  return html.replace(
    /<!--\s*lt-align:(left|center|right)\s*-->([\s\S]*?)<!--\s*\/lt-align\s*-->/g,
    '<div class="lt-align-$1">$2</div>'
  )
}

// cellalign 주석의 셀별 정렬을 표 본문 셀에 인라인 스타일로 반영
function applyCellAligns(html: string, metas: TableMeta[]): string {
  if (!metas.some((meta) => meta.cellAligns)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tables = Array.from(doc.querySelectorAll('table'))
  metas.forEach((meta, index) => {
    const table = tables[index]
    if (!table || !meta.cellAligns) return
    const rows = Array.from(table.tBodies[0]?.rows ?? [])
    for (const [key, align] of Object.entries(meta.cellAligns)) {
      const [r, c] = key.split(':').map(Number)
      const cell = rows[r]?.cells[c]
      if (cell) cell.style.textAlign = align
    }
  })
  return doc.body.innerHTML
}

/** 마크다운 → 인쇄용 전체 HTML 문서. 표 colw 주석은 colgroup 너비로, cellalign 주석은 셀 정렬로 반영. */
export function mdToPrintHtml(md: string, title = '문서', profile: PrintLayoutProfile = 'default'): string {
  const { md: clean, metas } = extractTableMeta(md)
  let body = applyAlignBlocks(parseMarkdown(clean))
  const queue = metas.map((meta) => meta.widths)
  body = body.replace(/<table>/g, () => {
    const w = queue.shift()
    if (w && w.length) {
      const cg =
        '<colgroup>' +
        w.map((x) => (x ? `<col style="width:${formatWidth(x)}">` : '<col>')).join('') +
        '</colgroup>'
      const tableWidth = w.every((x): x is ColWidth => !!x && x.unit === 'cm')
        ? ` style="width:${w.reduce((sum, x) => sum + x.value, 0)}cm"`
        : ''
      return `<table class="fixed"${tableWidth}>` + cg
    }
    return '<table>'
  })
  body = applyCellAligns(body, metas)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>${printCss(profile)}</style></head><body>${body}</body></html>`
}
