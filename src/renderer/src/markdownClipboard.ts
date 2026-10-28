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
  return htmlToPlainText(renderMarkdown(markdown))
}

export function orderedListNumbers(root: Element): Map<Element, number> {
  const numbers = new Map<Element, number>()
  const lists = [...(root.matches('ol') ? [root] : []), ...root.querySelectorAll('ol')]
  for (const list of lists) {
    const items = Array.from(list.children).filter((child) => child.tagName === 'LI')
    const step = list.hasAttribute('reversed') ? -1 : 1
    let number = list.hasAttribute('start') ? (list as HTMLOListElement).start : step === -1 ? items.length : 1
    for (const item of items) {
      if (item.hasAttribute('value')) number = (item as HTMLLIElement).value
      numbers.set(item, number)
      number += step
    }
  }
  return numbers
}

export function htmlToPlainText(html: string): string {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  const numbers = orderedListNumbers(host)
  // innerText omits browser-generated list markers; materialize them only in the copy.
  for (const item of host.querySelectorAll('li')) {
    if (!item.textContent?.trim()) continue
    const first = Array.from(item.childNodes).find((node) => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim())
    if (first instanceof Element && first.matches('ol, ul')) continue
    let depth = 0
    for (let parent = item.parentElement?.closest('li'); parent; parent = parent.parentElement?.closest('li')) depth += 1
    const marker = document.createElement('span')
    marker.style.whiteSpace = 'pre'
    marker.textContent = `${'  '.repeat(depth)}${numbers.has(item) ? `${numbers.get(item)}.` : '•'} `
    const target = first instanceof HTMLElement && first.tagName === 'P' ? first : item
    target.prepend(marker)
  }
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
