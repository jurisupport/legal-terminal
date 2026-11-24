import { Lexer } from 'marked'

export function isBoardDocumentPath(path: string): boolean {
  return /\.(?:md|markdown|mdx|txt|csv|json|pdf|hwp|hwpx|docx|html?|png|jpe?g|gif|webp|bmp|tiff?)$/iu.test(path)
}

const boardDirectories = new Set(['_업무지시', '_보관', '_일일보고'])
const controlFiles = new Set([
  '_보고서양식.md', 'agents.md', 'claude.md', 'tool-policy.json', 'settings.json', 'settings.local.json',
  'config.json', 'mcp.json', 'credentials.json', 'auth.json', 'package.json', 'package-lock.json', 'tsconfig.json'
])

// Reject control files even when their extensions are otherwise previewable.
export function workspaceDocumentPath(name: string, workspace: string, boardFolder?: string, taskId?: string): string | undefined {
  if (!isBoardDocumentPath(name) || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) return
  const base = workspace.replaceAll('\\', '/').replace(/\/+$/, '')
  const remote = /^ssh:\/\/[^/]+(\/.*)?$/u.exec(base)
  const windows = /^([a-z]:|\/\/)/iu.test(base)
  const key = (path: string) => windows ? path.toLowerCase() : path
  name = name.replaceAll('\\', '/')
  const root = remote && name.startsWith('/') ? remote[1] || '' : base
  if (key(name).startsWith(key(root + '/'))) name = name.slice(root.length + 1)
  name = name.replace(/^(?:\.\/)+/u, '')
  if (name.includes(':') || /%(?:2e|2f|5c|00|0a|0d)/iu.test(name)) return
  const parts = name.normalize('NFC').split('/')
  if (parts.some(p => !p || p.startsWith('.') || boardDirectories.has(p))) return
  const leaf = parts.at(-1)!.toLowerCase()
  if (controlFiles.has(leaf) ||
      (taskId && [taskId + '.md', taskId + '.report.md', taskId + '.review.md'].some(x => leaf === x.toLowerCase()))) return
  const full = base + '/' + name
  if (boardFolder) {
    const fold = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').normalize('NFC').toLowerCase()
    const controlRoot = fold(boardFolder)
    if (controlRoot.startsWith(fold(base) + '/') && fold(full).startsWith(controlRoot + '/')) return
  }
  return full
}

function addPath(paths: Map<string, string>, path: string | undefined, workspace: string) {
  if (path) {
    const key = /^(?:[a-z]:|[\\/]{2})/iu.test(workspace) ? path.toLowerCase() : path
    if (!paths.has(key)) paths.set(key, path)
  }
}

export function boardReferencePaths(log: readonly { at: string; text: string }[], workspace: string, taskId: string, boardFolder?: string): string[] {
  const paths = new Map<string, string>()
  const prefix = '파일 읽음 · '
  for (const entry of log) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.startsWith(prefix) ||
        typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue
    // File-read records are plain paths; never interpret Markdown or shell output in a log.
    const raw = entry.text.slice(prefix.length)
    if (raw !== raw.trim() ||
        /^(?:(?:bash|sh|zsh|powershell|cmd|cat|ls|rm|curl|echo|printf|grep|rg|find|sed|head|tail|python3?|node|git)\s+|Bash\(|\$[({])/iu.test(raw)) continue
    addPath(paths, workspaceDocumentPath(raw, workspace, boardFolder, taskId), workspace)
  }
  return [...paths.values()]
}

export function boardDocumentPaths(report: string, workspace: string, boardFolder?: string, taskId?: string): string[] {
  const paths = new Map<string, string>()
  function add(raw: string, markdownLink = false) {
    let name = raw.trim().replace(/^<(.*)>$/u, '$1')
    if (markdownLink) {
      try { name = decodeURIComponent(name) } catch { return }
    }
    addPath(paths, workspaceDocumentPath(name, workspace, boardFolder, taskId), workspace)
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
  return [...paths.values()]
}
