import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * 전자소송기록 PDF의 북마크(목차)를 파싱해 문서/서증/첨부서류로 분류한다.
 * 북마크 제목 규칙: 법원명_사건번호_순번_날짜_문서종류_(제목)_..._서증_(갑N_문서명) 등.
 * viewer-windows의 pdf_evidence.py 파싱 로직을 포팅.
 */
export type Category = 'document' | 'evidence' | 'attachment'

export interface OutlineItem {
  page: number // 1-based, 0이면 미해결 (단일 PDF 목차용)
  path?: string // 폴더 내 개별 PDF 파일 경로 (폴더 기반 기록용)
  rawTitle: string
  label: string // 사건번호 제거된 표시용 레이블
  category: Category
  evidencePrefix?: string // 갑1, 을3-1
  party?: 'plaintiff' | 'defendant' // 원고(빨강) / 피고(파랑)
  dateNum: number // YYYYMMDD (정렬용, 없으면 0)
  sortKey: number
}

export interface ParsedRecord {
  court?: string
  caseNo?: string
  documents: OutlineItem[]
  evidences: OutlineItem[]
  attachments: OutlineItem[]
}

const DATE_RE = /\d{4}\.\d{2}\.\d{2}/
const DATE_LENIENT = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/ // 2024.03.01 / 2024. 3. 1
const CASE_RE = /\d{4}[가-힣]{1,5}\d{1,6}/ // 2025느합1050, 2024가단5369527
const EVID_RE = /(?:^|[\s_\-–—(（])([갑을])\s*제?\s*(\d+(?:-\d+)?)\s*호?증?(?=$|[\s_\-–—()（）.])/
const RECORD_SEQUENCE_RE = /^\s*(\d{1,6})\s*$/
const FALLBACK_SORT_KEY_OFFSET = 1_000_000_000
const FALLBACK_SORT_KEY_BUCKET = 1_000_000

function nfc(v: string): string {
  return v.normalize('NFC')
}

function dateNum(s: string): number {
  const m = s.match(DATE_LENIENT)
  if (!m) return 0
  return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10)
}
function byDate(a: OutlineItem, b: OutlineItem): number {
  const da = a.dateNum || Infinity
  const db = b.dateNum || Infinity
  return da - db || a.sortKey - b.sortKey
}
const COURT_RE = /([가-힣]+법원)/

function recordSequence(tokens: string[], dateIdx: number): number {
  const candidates = [dateIdx > 0 ? tokens[dateIdx - 1] : undefined, tokens[2]]
  for (const candidate of candidates) {
    const m = candidate?.match(RECORD_SEQUENCE_RE)
    if (m) return parseInt(m[1], 10)
  }
  return 0
}

function documentPriority(item: OutlineItem): number {
  if (item.category !== 'document') return 1
  return /(?:^|[_\s|(（-])소장(?:$|[_\s|)）-])/.test(item.rawTitle) ? 0 : 1
}

function ensureSortKey(item: OutlineItem, index: number): void {
  if (item.sortKey !== 0) return
  item.sortKey = FALLBACK_SORT_KEY_OFFSET + documentPriority(item) * FALLBACK_SORT_KEY_BUCKET + index
}

interface FlatNode {
  title: string
  page: number
}

// dest(명시적 배열 또는 명명된 목적지) → 1-based 페이지 번호
async function destToPage(doc: PDFDocumentProxy, dest: unknown): Promise<number> {
  try {
    let explicit = dest
    if (typeof dest === 'string') explicit = await doc.getDestination(dest)
    if (!Array.isArray(explicit) || explicit.length === 0) return 0
    const idx = await doc.getPageIndex(explicit[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    return idx + 1
  } catch {
    return 0
  }
}

interface RawOutlineNode {
  title?: string
  dest?: unknown
  items?: RawOutlineNode[]
}

async function flatten(
  doc: PDFDocumentProxy,
  nodes: RawOutlineNode[],
  out: FlatNode[]
): Promise<void> {
  for (const n of nodes) {
    const page = n.dest != null ? await destToPage(doc, n.dest) : 0
    const title = (n.title ?? '').trim()
    if (title) out.push({ title, page })
    if (n.items && n.items.length) await flatten(doc, n.items, out)
  }
}

// 괄호(중첩 포함) 최상위 내용 추출
function topBrackets(text: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '(') {
      let depth = 1
      const start = i + 1
      i++
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') depth--
        i++
      }
      if (depth === 0) result.push(text.slice(start, i - 1))
    } else i++
  }
  return result
}

function evidenceName(title: string, prefix: string): string | undefined {
  const numM = prefix.match(/(\d+(?:-\d+)?)/)
  const num = numM ? numM[1] : ''
  const type = prefix.includes('갑') ? '갑' : prefix.includes('을') ? '을' : ''
  const brackets = topBrackets(title)

  for (const b of brackets) {
    // "갑 제1호증(문서명)"
    const p1 = new RegExp(`${type}\\s*제?\\s*${num}\\s*호?증?\\s*\\(([^)]+)\\)`)
    const m1 = b.match(p1)
    if (m1 && m1[1].trim().length >= 2) return m1[1].trim()
    // "갑1_문서명"
    const p2 = new RegExp(`${type}\\s*제?\\s*${num}[_\\s]+(.+)`)
    const m2 = b.match(p2)
    if (m2) {
      const name = m2[1].replace(/\s*\([^)]*\)\s*$/, '').trim()
      if (name.length >= 2 && !name.endsWith(')')) return name
    }
  }
  const fallback = new RegExp(`${type}\\s*제?\\s*${num}\\s*호?증?\\s*[_\\s\\-–—]+(.+)`)
  const fm = title.match(fallback)
  if (fm) {
    const name = fm[1]
      .replace(/\.[^.]+$/, '')
      .replace(/^[\s_\-–—]+/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
    if (name.length >= 2) return name
  }
  // 두 번째 괄호가 문서명인 경우
  if (brackets.length >= 2) {
    const second = brackets[1].trim()
    if (second.length >= 2 && !/[갑을]/.test(second)) return second
  }
  return undefined
}

function classify(title: string): OutlineItem {
  title = nfc(title)
  const tokens = title.split('_')
  const dateM = title.match(DATE_RE)
  const date = dateM ? dateM[0] : ''
  const dateIdx = dateM ? tokens.findIndex((t) => DATE_RE.test(t)) : -1
  const docType = dateIdx >= 0 && tokens[dateIdx + 1] ? tokens[dateIdx + 1] : tokens[2] ?? '문서'
  const sequence = recordSequence(tokens, dateIdx)

  const em = title.match(EVID_RE)
  const isEvidence = tokens.some((t) => t === '서증' || t === '서증서류') || /_서증_/.test(title) || !!em
  const isAttachment = !isEvidence && tokens.some((t) => t.includes('첨부'))

  const brackets = topBrackets(title)
  const firstDetail = brackets[0]?.trim()

  let category: Category = 'document'
  let label = ''
  let evidencePrefix: string | undefined
  let sortKey = sequence

  if (isEvidence) {
    category = 'evidence'
    if (em) {
      evidencePrefix = `${em[1]}${em[2]}`
      const major = em[1] === '갑' ? 0 : 1
      const n = parseInt(em[2], 10) || 0
      sortKey = major * 100000 + n * 100
      const sub = em[2].includes('-') ? parseInt(em[2].split('-')[1], 10) || 0 : 0
      sortKey += sub
    }
    const name = em ? evidenceName(title, evidencePrefix as string) : undefined
    label = `${evidencePrefix ?? '서증'}${name ? '  ' + name : ''}`
  } else if (isAttachment) {
    category = 'attachment'
    const name = firstDetail && !firstDetail.includes('첨부') ? firstDetail : undefined
    label = `${date ? date + ' | ' : ''}${name ?? docType}`
  } else {
    category = 'document'
    const detail =
      firstDetail && normalize(firstDetail) !== normalize(docType) ? firstDetail : undefined
    label = `${date ? date + ' | ' : ''}${docType}${detail ? ' - ' + detail : ''}`
  }

  // 원고계/피고계 판정: 갑호증=원고계, 을호증=피고계, 그 외 작성자명으로 판정
  let party: 'plaintiff' | 'defendant' | undefined
  if (evidencePrefix?.startsWith('갑')) party = 'plaintiff'
  else if (evidencePrefix?.startsWith('을')) party = 'defendant'
  if (!party) {
    if (/원고|채권자|신청인|항고인/.test(title)) party = 'plaintiff'
    else if (/피고|채무자|피신청인|상대방/.test(title)) party = 'defendant'
  }

  return { page: 0, rawTitle: title, label, category, evidencePrefix, party, dateNum: dateNum(title), sortKey }
}

function normalize(v: string): string {
  return nfc(v).replace(/[\s_\-()]+/g, '')
}

/**
 * 폴더 안 개별 PDF들의 **파일명**을 파싱해 문서/서증/첨부로 분류한다.
 * 전자소송기록이 한 폴더의 여러 PDF(파일명 인코딩)로 전달되는 경우.
 */
export function parseRecordFiles(files: { name: string; path: string }[]): ParsedRecord {
  let court: string | undefined
  let caseNo: string | undefined
  const documents: OutlineItem[] = []
  const evidences: OutlineItem[] = []
  const attachments: OutlineItem[] = []

  const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
  pdfs.forEach((f, i) => {
    const nameNoExt = nfc(f.name.replace(/\.[^.]+$/, ''))
    if (!court) court = nameNoExt.match(COURT_RE)?.[1]
    if (!caseNo) caseNo = nameNoExt.match(CASE_RE)?.[0]
    const item = classify(nameNoExt)
    item.path = f.path
    item.page = 0
    ensureSortKey(item, i)
    if (item.category === 'evidence') evidences.push(item)
    else if (item.category === 'attachment') attachments.push(item)
    else documents.push(item)
  })

  documents.sort(byDate)
  attachments.sort(byDate)
  evidences.sort((a, b) => a.sortKey - b.sortKey)
  return { court, caseNo, documents, evidences, attachments }
}

export async function parseRecordOutline(doc: PDFDocumentProxy): Promise<ParsedRecord> {
  const outline = (await doc.getOutline()) as RawOutlineNode[] | null
  const flat: FlatNode[] = []
  if (outline && outline.length) await flatten(doc, outline, flat)

  let court: string | undefined
  let caseNo: string | undefined
  const documents: OutlineItem[] = []
  const evidences: OutlineItem[] = []
  const attachments: OutlineItem[] = []

  flat.forEach((n, i) => {
    const title = nfc(n.title)
    if (!court) court = title.match(COURT_RE)?.[1]
    if (!caseNo) caseNo = title.match(CASE_RE)?.[0]
    const item = classify(title)
    item.page = n.page
    ensureSortKey(item, i)
    if (item.category === 'evidence') evidences.push(item)
    else if (item.category === 'attachment') attachments.push(item)
    else documents.push(item)
  })

  documents.sort(byDate)
  attachments.sort(byDate)
  evidences.sort((a, b) => a.sortKey - b.sortKey)

  return { court, caseNo, documents, evidences, attachments }
}
