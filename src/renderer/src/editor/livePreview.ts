import { syntaxTree } from '@codemirror/language'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import DOMPurify from 'dompurify'
import { LOOSE_STRONG_RE, parseInlineMarkdown } from './markdownCompat'

const strong = Decoration.mark({ class: 'cm-md-strong' })
const emphasis = Decoration.mark({ class: 'cm-md-em' })
const strike = Decoration.mark({ class: 'cm-md-strike' })
const code = Decoration.mark({ class: 'cm-md-code' })
const link = Decoration.mark({ class: 'cm-md-link' })
const hidden = Decoration.replace({})
const HTML_BREAK_RE = /^<br\s*\/?>$/i
const HTML_BREAK_TOKEN_RE = /<br\s*\/?>/gi
const ENTITY_RE = /&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi
const ALIGN_CENTER_OPEN_RE = /^<!--\s*lt-align:center\s*-->\s*$/
const ALIGN_CENTER_CLOSE_RE = /^<!--\s*\/lt-align\s*-->\s*$/

const ENTITY_TEXT: Record<string, string> = {
  amp: '&',
  apos: "'",
  emsp: '\u2003',
  ensp: '\u2002',
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  thinsp: '\u2009',
  quot: '"'
}

// 비활성 행에서 숨길 서식 기호
const MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'QuoteMark',
  'StrikethroughMark',
  'CodeInfo'
])

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-md-bullet'
    s.textContent = '•'
    return s
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }
  eq(o: CheckboxWidget): boolean {
    return o.checked === this.checked && o.from === this.from
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-checkbox'
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('change', () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' }
      })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class TextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(o: TextWidget): boolean {
    return o.text === this.text
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.textContent = this.text
    return span
  }
}

class HtmlBreakWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    return document.createElement('br')
  }
}

function decorateInactiveLinkMark(
  token: string,
  from: number,
  to: number,
  deco: Range<Decoration>[]
): boolean {
  if (token === '(') {
    deco.push(Decoration.replace({ widget: new TextWidget(' (') }).range(from, to))
    return true
  }
  if (token === '[' || token === ']' || token === '<' || token === '>') {
    deco.push(hidden.range(from, to))
    return true
  }
  return token === ')'
}

function decodeEntity(src: string): string | null {
  const body = src.match(/^&(#x[\da-f]+|#\d+|[a-z][\da-z]+);$/i)?.[1]
  if (!body) return null
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16)
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10)
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null
  }
  return ENTITY_TEXT[body.toLowerCase()] ?? null
}

function addInactiveHtmlPreviewDecorations(
  state: EditorState,
  from: number,
  to: number,
  active: Set<number>,
  deco: Range<Decoration>[]
): void {
  const src = state.doc.sliceString(from, to)
  HTML_BREAK_TOKEN_RE.lastIndex = 0
  for (const match of src.matchAll(HTML_BREAK_TOKEN_RE)) {
    const start = from + match.index
    if (active.has(state.doc.lineAt(start).number)) continue
    deco.push(
      Decoration.replace({ widget: new HtmlBreakWidget() }).range(start, start + match[0].length)
    )
  }

  ENTITY_RE.lastIndex = 0
  for (const match of src.matchAll(ENTITY_RE)) {
    const text = decodeEntity(match[0])
    if (!text) continue
    const start = from + match.index
    if (active.has(state.doc.lineAt(start).number)) continue
    deco.push(
      Decoration.replace({ widget: new TextWidget(text) }).range(start, start + match[0].length)
    )
  }
}

type Align = 'none' | 'left' | 'center' | 'right'
type ColWidth = { value: number; unit: '%' | 'cm' }
type ColWidthSlot = ColWidth | null
interface TableModel {
  headers: string[]
  aligns: Align[]
  rows: string[][]
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

function formatWidth(width: ColWidth): string {
  return `${width.value}${width.unit}`
}

function normalizeColw(widths: ColWidthSlot[], colCount: number): ColWidthSlot[] | null {
  const normalized = Array.from({ length: colCount }, (_v, index) => widths[index] ?? null)
  return normalized.some(Boolean) ? normalized : null
}

function formatColw(widths: ColWidthSlot[]): string {
  return widths.map((width) => (width ? formatWidth(width) : '')).join(',')
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim().replace(/\\\|/g, '|'))
}

function parseTable(src: string): TableModel {
  const lines = src.split('\n').filter((l) => l.trim().length)
  const headers = splitRow(lines[0] ?? '')
  const aligns: Align[] = (lines[1] ? splitRow(lines[1]) : []).map((c) => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : 'none'
  })
  const rows = lines.slice(2).map(splitRow)
  const cols = Math.max(headers.length, aligns.length, ...rows.map((r) => r.length), 1)
  while (headers.length < cols) headers.push('')
  while (aligns.length < cols) aligns.push('none')
  for (const r of rows) while (r.length < cols) r.push('')
  return { headers, aligns, rows }
}

function toMarkdown(m: TableModel): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
  const delim = (a: Align): string =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
  const head = '| ' + m.headers.map(esc).join(' | ') + ' |'
  const sep = '| ' + m.aligns.map(delim).join(' | ') + ' |'
  const body = m.rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |').join('\n')
  return [head, sep, body].filter((l) => l.length).join('\n')
}

function renderInlineMarkdown(src: string): string {
  const html = parseInlineMarkdown(src)
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'br', 'code', 'del', 'em', 'kbd', 'mark', 's', 'span', 'strong', 'sub', 'sup'],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'title']
  })
}

function renderCellContent(el: HTMLElement): void {
  el.innerHTML = renderInlineMarkdown(el.dataset.markdown ?? '')
}

function caretRangeFromPoint(x: number, y: number): globalThis.Range | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null
  }
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) {
    const range = document.createRange()
    range.setStart(pos.offsetNode, pos.offset)
    range.collapse(true)
    return range
  }
  return doc.caretRangeFromPoint?.(x, y) ?? null
}

function placeCaretFromPoint(el: HTMLElement, x: number, y: number): void {
  const range = caretRangeFromPoint(x, y)
  if (!range || !el.contains(range.startContainer)) return
  const selection = window.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

function makeCellContent(markdown: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'cm-md-cell-content'
  el.contentEditable = 'true'
  el.dataset.markdown = markdown
  renderCellContent(el)
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    if (document.activeElement === el) return
    e.preventDefault()
    el.focus()
    placeCaretFromPoint(el, e.clientX, e.clientY)
  })
  el.addEventListener('mouseup', (e) => e.stopPropagation())
  el.addEventListener('click', (e) => e.stopPropagation())
  el.addEventListener('focus', () => {
    el.textContent = el.dataset.markdown ?? ''
  })
  el.addEventListener('input', () => {
    el.dataset.markdown = el.innerText
  })
  el.addEventListener('blur', () => {
    el.dataset.markdown = el.innerText
    renderCellContent(el)
  })
  return el
}

function cellMarkdown(el: Element): string {
  const content = el.querySelector<HTMLElement>('.cm-md-cell-content')
  return content?.dataset.markdown ?? (el as HTMLElement).innerText
}

class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly from: number,
    readonly to: number,
    readonly widths?: ColWidthSlot[]
  ) {
    super()
  }
  eq(o: TableWidget): boolean {
    return (
      o.src === this.src &&
      o.from === this.from &&
      JSON.stringify(o.widths) === JSON.stringify(this.widths)
    )
  }
  ignoreEvent(): boolean {
    return true
  }
  toDOM(view: EditorView): HTMLElement {
    const model = parseTable(this.src)
    const ncol = model.headers.length
    let widths = this.widths ? normalizeColw(this.widths, ncol) : null

    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table'
    const table = document.createElement('table')
    if (widths?.every((width): width is ColWidth => !!width && width.unit === 'cm')) {
      table.style.width = `${widths.reduce((sum, width) => sum + width.value, 0)}cm`
    }

    const colgroup = document.createElement('colgroup')
    for (let c = 0; c < ncol; c++) {
      const col = document.createElement('col')
      const width = widths?.[c]
      if (width) col.style.width = formatWidth(width)
      colgroup.appendChild(col)
    }
    table.appendChild(colgroup)
    const thead = table.createTHead()
    const htr = thead.insertRow()
    const tbody = table.createTBody()

    const readModel = (): TableModel => ({
      headers: Array.from(htr.children).map(cellMarkdown),
      aligns: model.aligns,
      rows: Array.from(tbody.rows).map((tr) => Array.from(tr.cells).map(cellMarkdown))
    })
    const applyAll = (m: TableModel, w: ColWidthSlot[] | null): void => {
      let md = toMarkdown(m)
      if (w && w.length === m.headers.length && w.some(Boolean))
        md += '\n<!-- colw: ' + formatColw(w) + ' -->'
      view.dispatch({ changes: { from: this.from, to: this.to, insert: md } })
    }

    let resizing = false
    const startResize = (col: number, e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      resizing = true
      const tableW = table.offsetWidth || 1
      const ths = Array.from(htr.children) as HTMLElement[]
      const startCur = ths.map((th) => (th.offsetWidth / tableW) * 100)
      const base = [...startCur]
      const startX = e.clientX
      const cols = Array.from(colgroup.children) as HTMLElement[]
      const onMove = (me: MouseEvent): void => {
        const d = ((me.clientX - startX) / tableW) * 100
        const next = [...base]
        next[col] = Math.max(5, base[col] + d)
        next[col + 1] = Math.max(5, base[col + 1] - d)
        widths = next.map((value) => ({ value: Math.round(value), unit: '%' }))
        table.style.removeProperty('width')
        cols.forEach((cl, i) => {
          const width = widths?.[i]
          if (width) (cl as HTMLElement).style.width = formatWidth(width)
        })
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        resizing = false
        applyAll(readModel(), widths)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    model.headers.forEach((h, c) => {
      const th = document.createElement('th')
      th.contentEditable = 'false'
      th.appendChild(makeCellContent(h))
      if (model.aligns[c] !== 'none') th.style.textAlign = model.aligns[c]
      if (c < ncol - 1) {
        const handle = document.createElement('div')
        handle.className = 'cm-md-colresize'
        handle.contentEditable = 'false'
        handle.addEventListener('mousedown', (e) => startResize(c, e))
        th.appendChild(handle)
      }
      htr.appendChild(th)
    })
    model.rows.forEach((row) => {
      const tr = tbody.insertRow()
      row.forEach((cell, c) => {
        const td = tr.insertCell()
        td.contentEditable = 'false'
        td.appendChild(makeCellContent(cell))
        if (model.aligns[c] !== 'none') td.style.textAlign = model.aligns[c]
      })
    })

    wrap.addEventListener('focusout', (ev) => {
      if (resizing) return
      if (wrap.contains(ev.relatedTarget as Node)) return
      applyAll(readModel(), widths)
    })

    const bar = document.createElement('div')
    bar.className = 'cm-md-table-bar'
    const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'cm-md-tbtn'
      b.textContent = label
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.preventDefault()
        fn()
      })
      return b
    }
    bar.appendChild(
      mkBtn('+행', () => {
        const m = readModel()
        m.rows.push(new Array(m.headers.length).fill(''))
        applyAll(m, widths)
      })
    )
    bar.appendChild(
      mkBtn('+열', () => {
        const m = readModel()
        m.headers.push('')
        m.aligns.push('none')
        m.rows.forEach((r) => r.push(''))
        applyAll(m, null) // 열 수 변경 → 너비 초기화
      })
    )
    bar.appendChild(
      mkBtn('폭(cm)', () => {
        const current = widths
          ? widths.map((width) => (width?.unit === 'cm' ? String(width.value) : '')).join(',')
          : ''
        const answer = window.prompt(
          '열 너비(cm)를 쉼표로 입력하세요. 빈 칸은 남은 폭을 자동 배분합니다.\n예: 2,,3',
          current
        )
        if (answer === null) return
        widths = normalizeColw(parseColw(answer, 'cm'), readModel().headers.length)
        applyAll(readModel(), widths)
      })
    )
    bar.appendChild(
      mkBtn('소스 편집', () => {
        view.dispatch({ selection: { anchor: this.from } })
        view.focus()
      })
    )

    wrap.appendChild(bar)
    wrap.appendChild(table)
    return wrap
  }
}

function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) set.add(n)
  }
  return set
}

function addAlignDecorations(
  state: EditorState,
  active: Set<number>,
  deco: Range<Decoration>[]
): void {
  let center = false
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo)
    if (ALIGN_CENTER_OPEN_RE.test(line.text)) {
      if (!active.has(lineNo)) {
        deco.push(Decoration.line({ class: 'cm-md-hidden-line' }).range(line.from))
        deco.push(Decoration.replace({}).range(line.from, line.to))
      }
      center = true
      continue
    }
    if (ALIGN_CENTER_CLOSE_RE.test(line.text)) {
      if (!active.has(lineNo)) {
        deco.push(Decoration.line({ class: 'cm-md-hidden-line' }).range(line.from))
        deco.push(Decoration.replace({}).range(line.from, line.to))
      }
      center = false
      continue
    }
    if (center) deco.push(Decoration.line({ class: 'cm-md-align-center' }).range(line.from))
  }
}

function addLooseStrongDecorations(
  state: EditorState,
  active: Set<number>,
  tableRanges: Array<[number, number]>,
  strongRanges: Array<[number, number]>,
  deco: Range<Decoration>[]
): void {
  if (state.doc.length >= 300000) return
  LOOSE_STRONG_RE.lastIndex = 0
  for (const match of state.doc.toString().matchAll(LOOSE_STRONG_RE)) {
    const from = (match.index ?? 0) + match[1].length
    const to = from + match[2].length
    if (tableRanges.some(([a, b]) => from >= a && from < b)) continue
    if (strongRanges.some(([a, b]) => from === a && to === b)) continue
    deco.push(strong.range(from, to))
    if (!active.has(state.doc.lineAt(from).number)) {
      deco.push(hidden.range(from, from + 2))
      deco.push(hidden.range(to - 2, to))
    }
  }
}

function build(state: EditorState): DecorationSet {
  const active = activeLines(state)
  const deco: Range<Decoration>[] = []
  const tableRanges: Array<[number, number]> = []
  const strongRanges: Array<[number, number]> = []

  try {
    addAlignDecorations(state, active, deco)

    syntaxTree(state).iterate({
      enter: (node) => {
        const name = node.name
        const lineNo = state.doc.lineAt(node.from).number
        const lineActive = active.has(lineNo)

        // 표: 커서가 표 안이 아니면 그리드 위젯(블록)으로 치환
        if (name === 'Table') {
          const sLine = state.doc.lineAt(node.from)
          let eLine = state.doc.lineAt(node.to)
          const tableTo = eLine.to
          // 표 바로 뒤 colw 주석에서 열너비 읽기
          let widths: ColWidthSlot[] | undefined
          if (eLine.number < state.doc.lines) {
            const nx = state.doc.line(eLine.number + 1)
            const m = nx.text.match(/^<!--\s*colw:\s*(.*?)\s*-->\s*$/)
            if (m) {
              widths = parseColw(m[1])
              eLine = nx
            }
          }
          let inside = false
          for (let l = sLine.number; l <= eLine.number; l++)
            if (active.has(l)) {
              inside = true
              break
            }
          if (!inside) {
            const from = sLine.from
            const blockTo = eLine.to
            deco.push(
              Decoration.replace({
                widget: new TableWidget(state.doc.sliceString(from, tableTo), from, blockTo, widths),
                block: true
              }).range(from, blockTo)
            )
            tableRanges.push([from, blockTo])
            return false
          }
          return undefined
        }

        // 이스케이프(\.): 백슬래시는 커서가 그 행에 있을 때만
        if (name === 'Escape') {
          if (!lineActive) deco.push(hidden.range(node.from, node.from + 1))
          return undefined
        }

        if (!lineActive && name === 'Entity') {
          const text = decodeEntity(state.doc.sliceString(node.from, node.to))
          if (text) {
            deco.push(Decoration.replace({ widget: new TextWidget(text) }).range(node.from, node.to))
          }
          return undefined
        }

        if (!lineActive && name === 'HTMLTag') {
          if (HTML_BREAK_RE.test(state.doc.sliceString(node.from, node.to).trim())) {
            deco.push(Decoration.replace({ widget: new HtmlBreakWidget() }).range(node.from, node.to))
          }
          return undefined
        }

        if (name === 'HTMLBlock') {
          addInactiveHtmlPreviewDecorations(state, node.from, node.to, active, deco)
          return undefined
        }

        // 수평선: 비활성 행에서는 Markdown 기호 대신 구분선으로 표시
        if (name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from)
          if (!active.has(line.number)) {
            deco.push(Decoration.line({ class: 'cm-md-hr-line' }).range(line.from))
            deco.push(hidden.range(line.from, line.to))
          }
          return false
        }

        // 인용블록: 줄마다 좌측 바
        if (name === 'Blockquote') {
          const s = state.doc.lineAt(node.from).number
          const en = state.doc.lineAt(node.to).number
          for (let l = s; l <= en; l++)
            deco.push(Decoration.line({ class: 'cm-md-quote' }).range(state.doc.line(l).from))
          return undefined
        }

        // 목록 마커: 순서없음 → 불릿(•), 순서있음 → 유지
        if (name === 'ListMark') {
          if (!lineActive && /^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) {
            deco.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
          }
          return undefined
        }

        // 체크박스
        if (name === 'TaskMarker') {
          if (!lineActive) {
            const txt = state.doc.sliceString(node.from, node.to)
            deco.push(
              Decoration.replace({
                widget: new CheckboxWidget(/x/i.test(txt), node.from, node.to)
              }).range(node.from, node.to)
            )
          }
          return undefined
        }

        const heading = name.match(/^ATXHeading(\d)$/)
        if (heading) {
          deco.push(
            Decoration.line({ class: `cm-md-heading cm-md-h${heading[1]}` }).range(
              state.doc.lineAt(node.from).from
            )
          )
          return undefined
        }
        if (name === 'StrongEmphasis') {
          strongRanges.push([node.from, node.to])
          deco.push(strong.range(node.from, node.to))
        }
        else if (name === 'Emphasis') deco.push(emphasis.range(node.from, node.to))
        else if (name === 'Strikethrough') deco.push(strike.range(node.from, node.to))
        else if (name === 'InlineCode') deco.push(code.range(node.from, node.to))
        else if (name === 'Link') deco.push(link.range(node.from, node.to))
        else if (name === 'URL') deco.push(link.range(node.from, node.to))

        if (name === 'LinkMark' && !lineActive) {
          const token = state.doc.sliceString(node.from, node.to)
          if (decorateInactiveLinkMark(token, node.from, node.to, deco)) return undefined
        }

        if (MARKS.has(name) && !lineActive && node.to > node.from) {
          deco.push(hidden.range(node.from, node.to))
        }
        return undefined
      }
    })

    addLooseStrongDecorations(state, active, tableRanges, strongRanges, deco)

    // 탭 문자 숨김 (표 블록 내부는 제외 — 겹치는 replace 방지)
    if (state.doc.length < 300000) {
      const text = state.doc.toString()
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\t') continue
        let inTable = false
        for (const [a, b] of tableRanges)
          if (i >= a && i < b) {
            inTable = true
            break
          }
        if (!inTable) deco.push(hidden.range(i, i + 1))
      }
    }

    return Decoration.set(deco, true)
  } catch {
    return Decoration.none
  }
}

/**
 * 옵시디언식 라이브 프리뷰 (StateField — 블록 데코레이션 허용).
 * 서식 적용 + 표/체크박스/불릿 위젯 + 커서 있는 행만 서식 기호/이스케이프 노출.
 */
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f)
})
