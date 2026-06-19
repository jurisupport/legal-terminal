import { marked } from 'marked'

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

// 표 뒤 colw 주석을 추출하고(표별 너비, 순서대로) 주석 줄은 제거
function extractColw(md: string): { md: string; widths: (ColWidthSlot[] | null)[] } {
  const lines = md.split('\n')
  const out: string[] = []
  const widths: (ColWidthSlot[] | null)[] = []
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
      let w: ColWidthSlot[] | null = null
      const m = j < lines.length ? lines[j].match(/^<!--\s*colw:\s*(.*?)\s*-->\s*$/) : null
      if (m) {
        w = normalizeColw(parseColw(m[1]), columnCount(lines[i]))
        j++
      }
      widths.push(w)
      i = j
      continue
    }
    out.push(lines[i])
    i++
  }
  return { md: out.join('\n'), widths }
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
th { background: #f0f0f0; }
.lt-align-center { text-align: center; }
`
}

function applyAlignBlocks(html: string): string {
  return html.replace(
    /<!--\s*lt-align:center\s*-->([\s\S]*?)<!--\s*\/lt-align\s*-->/g,
    '<div class="lt-align-center">$1</div>'
  )
}

/** 마크다운 → 인쇄용 전체 HTML 문서. 표 colw 주석은 colgroup 너비로 반영. */
export function mdToPrintHtml(md: string, title = '문서', profile: PrintLayoutProfile = 'default'): string {
  const { md: clean, widths } = extractColw(md)
  let body = applyAlignBlocks(marked.parse(clean, { gfm: true, breaks: true }) as string)
  const queue = [...widths]
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
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>${printCss(profile)}</style></head><body>${body}</body></html>`
}
