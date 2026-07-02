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

async function writeRichClipboard(markdown: string): Promise<void> {
  const html = richClipboardHtml(markdown)
  const plain = markdownToPlainText(markdown)
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
    await writeRichClipboard(markdown)
    return
  }
  await navigator.clipboard.writeText(mode === 'markdown' ? markdown : markdownToPlainText(markdown))
}
