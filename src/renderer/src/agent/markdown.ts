// Agent 응답 마크다운 렌더링·복사 파이프라인. highlight.js는 core+주요 언어만 등록해 번들을 줄인다.
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diffLang from 'highlight.js/lib/languages/diff'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdownLang from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diffLang)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['md'], { languageName: 'markdown' })

export type AgentCopyMode = 'rich' | 'markdown' | 'text'

const HIGHLIGHT_CODE_LIMIT = 20_000

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
}

function codeLanguageLabel(pre: HTMLPreElement): string | undefined {
  const code = pre.querySelector('code')
  const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
  return language ? language.replace(/^plaintext$/i, 'text') : undefined
}

function highlightCodeElement(code: HTMLElement, language: string | undefined): void {
  const source = code.textContent ?? ''
  if (!source || source.length > HIGHLIGHT_CODE_LIMIT) return
  try {
    const result =
      language && hljs.getLanguage(language)
        ? hljs.highlight(source, { language, ignoreIllegals: true })
        : hljs.highlightAuto(source)
    if (!result.value) return
    code.innerHTML = result.value
    code.classList.add('hljs')
  } catch {
    /* 하이라이팅 실패 시 원문 그대로 둔다. */
  }
}

export function renderMarkdownForDisplay(text: string): string {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(text)
  const codeBlocks = Array.from(host.querySelectorAll('pre'))
  codeBlocks.forEach((pre, index) => {
    if (!(pre instanceof HTMLPreElement) || pre.closest('.agent-code-block')) return
    const wrap = document.createElement('div')
    wrap.className = 'agent-code-block'
    wrap.dataset.codeBlockId = String(index)

    const toolbar = document.createElement('div')
    toolbar.className = 'agent-code-toolbar'
    const language = codeLanguageLabel(pre)
    if (language) {
      const label = document.createElement('span')
      label.className = 'agent-code-language'
      label.textContent = language
      toolbar.appendChild(label)
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'agent-code-copy-btn'
    button.title = '코드 복사'
    button.setAttribute('aria-label', '코드 복사')
    button.textContent = '복사'
    toolbar.appendChild(button)

    const code = pre.querySelector('code')
    if (code instanceof HTMLElement) highlightCodeElement(code, language)

    pre.replaceWith(wrap)
    wrap.appendChild(toolbar)
    wrap.appendChild(pre)
  })
  return host.innerHTML
}

export function markdownToPlainText(markdown: string): string {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.innerHTML = renderMarkdown(markdown)
  document.body.appendChild(host)
  const text = host.innerText.trim()
  host.remove()
  return text
}

export function markdownPreviewText(markdown: string): string {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(markdown)
  return (host.textContent ?? '').trim()
}

export function richClipboardHtml(markdown: string): string {
  return `<meta charset="utf-8"><div>${renderMarkdown(markdown)}</div>`
}

export function selectedHtml(selection: Selection): string {
  const wrap = document.createElement('div')
  for (let index = 0; index < selection.rangeCount; index += 1) {
    wrap.appendChild(selection.getRangeAt(index).cloneContents())
  }
  // 복사 버튼 툴바 등 UI 요소는 붙여넣기 결과에 섞이면 안 된다.
  wrap.querySelectorAll('.agent-msg-tools, .agent-code-toolbar, button').forEach((el) => el.remove())
  return DOMPurify.sanitize(wrap.innerHTML, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
}

export function selectionIntersectsElement(selection: Selection, element: HTMLElement): boolean {
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    if (range.collapsed) continue
    const start =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
    if ((start && element.contains(start)) || (end && element.contains(end))) return true
    if (range.intersectsNode(element)) return true
  }
  return false
}

export function writeSelectionToClipboard(clipboardData: DataTransfer, selection: Selection): boolean {
  const text = selection.toString()
  if (!text.trim()) return false
  const html = selectedHtml(selection)
  clipboardData.setData('text/plain', text)
  if (html.trim()) clipboardData.setData('text/html', `<meta charset="utf-8">${html}`)
  return true
}

export async function writeHtmlPlainClipboard(html: string, plain: string): Promise<void> {
  if (navigator.clipboard?.write && 'ClipboardItem' in window) {
    try {
      const ClipboardItemCtor = window.ClipboardItem
      await navigator.clipboard.write([
        new ClipboardItemCtor({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })
      ])
      return
    } catch {
      /* fall back to selection-based rich copy */
    }
  }
  const host = document.createElement('div')
  host.contentEditable = 'true'
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.innerHTML = html
  document.body.appendChild(host)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(host)
  selection?.removeAllRanges()
  selection?.addRange(range)
  const ok = document.execCommand('copy')
  selection?.removeAllRanges()
  host.remove()
  if (!ok) await navigator.clipboard.writeText(plain)
}

export async function copyAgentOutput(markdown: string, mode: AgentCopyMode): Promise<void> {
  if (mode === 'rich') {
    await writeHtmlPlainClipboard(richClipboardHtml(markdown), markdownToPlainText(markdown))
    return
  }
  await navigator.clipboard.writeText(mode === 'markdown' ? markdown : markdownToPlainText(markdown))
}

// ── 선택 영역 HTML → Markdown 역변환 ──
// marked가 만든 예측 가능한 구조(문단·제목·강조·목록·코드·표)만 다루면 충분하다.

function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th, td')).map((cell) =>
      childMarkdown(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()
    )
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map((cells) => cells.length))
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const hasHeader = Boolean(table.tHead?.rows.length) || Boolean(rows.length > 1 && table.querySelector('tr:first-child th'))
  const header = hasHeader ? rows[0] : Array.from({ length: width }, () => '')
  const body = hasHeader ? rows.slice(1) : rows
  return [line(header), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n')
}

function childMarkdown(node: Node): string {
  return Array.from(node.childNodes).map(nodeToMarkdown).join('')
}

function blockMarkdown(node: Node): string {
  // 공백만 있는 줄을 먼저 지워야 빈 줄 병합이 제대로 된다.
  return childMarkdown(node).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/[ \t\r\n]+/g, ' ')
  if (!(node instanceof HTMLElement)) return ''
  if (node.classList.contains('agent-code-toolbar')) return ''
  const tag = node.tagName.toLowerCase()
  switch (tag) {
    case 'br':
      return '\n'
    case 'hr':
      return '\n\n---\n\n'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${childMarkdown(node).trim()}\n\n`
    case 'p':
      return `\n\n${childMarkdown(node).trim()}\n\n`
    case 'strong':
    case 'b': {
      const inner = childMarkdown(node).trim()
      return inner ? `**${inner}**` : ''
    }
    case 'em':
    case 'i': {
      const inner = childMarkdown(node).trim()
      return inner ? `*${inner}*` : ''
    }
    case 'del':
    case 's': {
      const inner = childMarkdown(node).trim()
      return inner ? `~~${inner}~~` : ''
    }
    case 'code': {
      const raw = node.textContent ?? ''
      return raw ? `\`${raw}\`` : ''
    }
    case 'pre': {
      const code = node.querySelector('code')
      const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? ''
      const raw = ((code ?? node).textContent ?? '').replace(/\n$/, '')
      return `\n\n\`\`\`${language}\n${raw}\n\`\`\`\n\n`
    }
    case 'a': {
      const href = node.getAttribute('href') ?? ''
      const label = childMarkdown(node).trim() || href
      return href ? `[${label}](${href})` : label
    }
    case 'img': {
      const src = node.getAttribute('src') ?? ''
      return src ? `![${node.getAttribute('alt') ?? ''}](${src})` : ''
    }
    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol'
      const start = ordered ? Number(node.getAttribute('start') ?? '1') || 1 : 1
      const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === 'li')
      const lines = items.map((li, index) => {
        const marker = ordered ? `${start + index}. ` : '- '
        const pad = ' '.repeat(marker.length)
        const [first = '', ...rest] = blockMarkdown(li).split('\n')
        const continuation = rest.map((line) => (line ? pad + line : line)).join('\n')
        return marker + first + (rest.length ? `\n${continuation}` : '')
      })
      return `\n\n${lines.join('\n')}\n\n`
    }
    case 'blockquote': {
      const inner = blockMarkdown(node)
      return `\n\n${inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`
    }
    case 'table':
      return node instanceof HTMLTableElement ? `\n\n${tableToMarkdown(node)}\n\n` : childMarkdown(node)
    case 'button':
    case 'style':
    case 'script':
      return ''
    case 'div':
    case 'section':
    case 'article':
      return `\n\n${blockMarkdown(node)}\n\n`
    default:
      return childMarkdown(node)
  }
}

export function htmlToMarkdown(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] })
  return blockMarkdown(host)
}
