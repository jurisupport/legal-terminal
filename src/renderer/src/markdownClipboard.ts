import DOMPurify from 'dompurify'
import { marked } from 'marked'

export type MarkdownCopyMode = 'rich' | 'markdown' | 'text'

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
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

export function richMarkdownHtml(markdown: string): string {
  return `<meta charset="utf-8"><div>${renderMarkdown(markdown)}</div>`
}

export function writeMarkdownDataTransfer(
  clipboardData: DataTransfer,
  markdown: string,
  mode: MarkdownCopyMode = 'rich'
): boolean {
  if (!markdown.trim()) return false

  if (mode === 'markdown') {
    clipboardData.setData('text/plain', markdown)
    clipboardData.setData('text/markdown', markdown)
    return true
  }

  const plain = markdownToPlainText(markdown)
  clipboardData.setData('text/plain', plain)

  if (mode === 'rich') {
    clipboardData.setData('text/html', richMarkdownHtml(markdown))
    clipboardData.setData('text/markdown', markdown)
  }

  return true
}

export async function writeMarkdownClipboard(
  markdown: string,
  mode: MarkdownCopyMode = 'rich'
): Promise<void> {
  if (mode === 'markdown') {
    await navigator.clipboard.writeText(markdown)
    return
  }

  const plain = markdownToPlainText(markdown)
  if (mode === 'text') {
    await navigator.clipboard.writeText(plain)
    return
  }

  if (navigator.clipboard?.write && 'ClipboardItem' in window) {
    try {
      const ClipboardItemCtor = window.ClipboardItem
      await navigator.clipboard.write([
        new ClipboardItemCtor({
          'text/html': new Blob([richMarkdownHtml(markdown)], { type: 'text/html' }),
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
  host.innerHTML = richMarkdownHtml(markdown)
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
