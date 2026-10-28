import { extname } from 'node:path'
import { decodeTextBuffer } from './textEncoding.ts'

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.html', '.htm', '.xml', '.js', '.ts', '.tsx', '.jsx', '.css', '.py', '.sh', '.ini', '.toml', '.sql'])
const MAX_TEXT = 200_000

export async function projectDocumentText(
  path: string,
  bytes: Buffer,
  officeText: (path: string, bytes: Buffer) => string | Promise<string>
): Promise<{ text: string; truncated: boolean }> {
  const ext = extname(path).toLowerCase()
  let text: string
  let truncated = false
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false })
    try {
      const document = await task.promise
      const pages: string[] = []
      let length = 0
      for (let page = 1; page <= Math.min(document.numPages, 100); page++) {
        const content = await (await document.getPage(page)).getTextContent()
        const body = content.items.map((item) => 'str' in item ? item.str : '').join(' ').trim()
        pages.push(`[page ${page}]\n${body}`)
        length += body.length
        if (length >= MAX_TEXT) { truncated = true; break }
      }
      truncated ||= document.numPages > pages.length
      if (!pages.some((page) => page.replace(/^\[page \d+\]\s*/, '').trim())) {
        throw new Error('이 PDF에는 추출 가능한 본문이 없습니다. 이미지 문서는 OCR 후 텍스트 자료로 연결해 주세요.')
      }
      text = pages.join('\n\n')
    } finally {
      await task.destroy()
    }
  } else if (['.hwp', '.hwpx', '.docx'].includes(ext)) {
    text = await officeText(path, bytes)
    if (!text.trim()) throw new Error('문서에서 추출 가능한 본문을 찾지 못했습니다.')
  } else if (TEXT_EXTENSIONS.has(ext) || !ext) {
    text = decodeTextBuffer(bytes).text
    if (text.includes('\0')) throw new Error('일반 텍스트로 읽을 수 없는 파일입니다.')
  } else {
    throw new Error(`${ext || '이'} 형식의 본문 추출은 지원하지 않습니다. PDF, HWP/HWPX, DOCX 또는 텍스트 자료를 연결해 주세요.`)
  }
  return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT }
}
