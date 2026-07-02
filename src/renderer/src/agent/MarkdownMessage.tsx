import { useMemo, type MouseEvent } from 'react'
import { renderMarkdownForDisplay } from './markdown'

export function MarkdownMessage({
  text,
  streaming,
  onCopyCode
}: {
  text: string
  streaming?: boolean
  onCopyCode: (code: string) => Promise<boolean>
}): JSX.Element {
  const html = useMemo(() => renderMarkdownForDisplay(text), [text])

  const copyCode = async (button: HTMLButtonElement): Promise<void> => {
    const block = button.closest('.agent-code-block')
    const code = block?.querySelector('pre code')?.textContent ?? block?.querySelector('pre')?.textContent
    if (!code) return
    const previous = button.textContent ?? '복사'
    const copied = await onCopyCode(code)
    if (!copied) return
    button.textContent = '복사됨'
    button.disabled = true
    window.setTimeout(() => {
      button.textContent = previous
      button.disabled = false
    }, 1200)
  }

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null
    const copyButton = target?.closest('button.agent-code-copy-btn')
    if (copyButton instanceof HTMLButtonElement) {
      event.preventDefault()
      event.stopPropagation()
      void copyCode(copyButton)
      return
    }
    const link = target?.closest('a')
    if (!(link instanceof HTMLAnchorElement)) return
    const href = link.href
    if (!href) return
    event.preventDefault()
    void window.lt.app.openExternal(href)
  }

  return (
    <div className={`agent-md-wrap${streaming ? ' streaming' : ''}`}>
      <div
        className="md-body agent-md-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {streaming && <span className="agent-stream-caret" aria-hidden="true" />}
    </div>
  )
}
