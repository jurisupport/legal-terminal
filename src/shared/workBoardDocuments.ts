import { Lexer } from 'marked'

export function isBoardDocumentPath(path: string): boolean {
  return /\.(?:md|markdown|mdx|txt|csv|json|pdf|hwp|hwpx|docx|html?|png|jpe?g|gif|webp|bmp|tiff?)$/iu.test(path)
}

// Only paths explicitly listed as outputs or approval documents can become file-open actions.
export function boardDocumentPaths(report: string, workspace: string): string[] {
  const paths = new Set<string>()
  const base = workspace.replaceAll('\\', '/').replace(/\/+$/, '')
  const remote = /^ssh:\/\/[^/]+(\/.*)?$/u.exec(base)
  const localWindows = /^([a-z]:|\/\/)/iu.test(base)
  const key = (path: string) => localWindows ? path.toLowerCase() : path
  function add(raw: string, markdownLink = false) {
    let name = raw.trim().replace(/^<(.*)>$/u, '$1')
    if (markdownLink) {
      try { name = decodeURIComponent(name) } catch { return }
    }
    if (!isBoardDocumentPath(name) || /[\u0000-\u001f]/u.test(name)) return
    name = name.replaceAll('\\', '/')
    // Older SSH reports sometimes contain the server's absolute path instead of its URI.
    const root = remote && name.startsWith('/') ? remote[1] || '' : base
    if (key(name).startsWith(key(root + '/'))) name = name.slice(root.length + 1)
    name = name.replace(/^(?:\.\/)+/u, '')
    if (name.startsWith('/') || name.includes(':') || name.split('/').some(part => !part || part === '..' || part === '.')) return
    paths.add(base + '/' + name)
  }

  let section = 0
  let fence = ''
  for (const line of report.split(/\r?\n/u)) {
    const text = line.trim()
    const delimiter = /^(`{3,}|~{3,})/u.exec(text)?.[1]
    if (delimiter && (!fence || delimiter.startsWith(fence))) {
      fence = fence ? '' : delimiter
      continue
    }
    if (fence) continue
    const heading = /^(#{1,6})\s+(.*)$/u.exec(text)
    if (heading) {
      if (heading[1].length <= section) section = 0
      const title = heading[2].replace(/^[\d.)\s*]+/u, '')
      if (/^(?:산출물|(?:결재|승인|반려)\s*대상(?:\s*(?:문서|파일))?|결재\s*(?:문서|요청\s*사항)|첨부\s*(?:문서|파일))(?:\s|[:(·*]|$)/u.test(title)) section = heading[1].length
      continue
    }
    if (text.startsWith('산출물 · ')) { add(text.slice('산출물 · '.length)); continue }
    const labelled = /^(?:[-*+]\s+)?(?:\*\*)?(?:결재 대상 문서|승인 대상 문서|산출물 경로|첨부 파일)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/u.exec(text)
    if ((!section && !labelled) || !text) continue
    const item = labelled?.[1] ?? text.replace(/^(?:[-*+] |\d+[.)] )/u, '')
    const cells = item.startsWith('|') ? item.split('|') : [item]
    for (const cell of cells) {
      const tokens = /[\[`]/u.test(cell) ? Lexer.lexInline(cell) : []
      if (tokens.some(t => t.type === 'link' || t.type === 'image' || t.type === 'codespan')) {
        for (const t of tokens) {
          if (t.type === 'link' || t.type === 'image') add(t.href, true)
          if (t.type === 'codespan') add(t.text)
        }
      } else add(cell)
    }
  }
  return [...paths]
}
