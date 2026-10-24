import { useMemo, useRef, type MouseEvent } from 'react'
import { Renderer } from 'marked'
import { renderMarkdownForDisplay } from './markdown'
import { AgentMediaPreview } from './AgentMediaPreview'
import { agentMediaReference, type AgentMediaContext, type AgentMediaReference } from './mediaReferences'

export function MarkdownMessage({
  text,
  streaming,
  onCopyCode,
  mediaContext,
  active = true,
  onOpenFile
}: {
  text: string
  streaming?: boolean
  onCopyCode: (code: string) => Promise<boolean>
  mediaContext?: AgentMediaContext
  active?: boolean
  onOpenFile?: (path: string, title?: string) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const { html, references } = useMemo(() => {
    const references: AgentMediaReference[] = []
    if (!mediaContext) return { html: renderMarkdownForDisplay(text), references }
    const renderer = new Renderer()
    const referenceLink = (href: string, label: string, decodeUrl = true): string | undefined => {
      const reference = agentMediaReference(href, label, mediaContext, decodeUrl)
      if (!reference) return undefined
      let index = references.findIndex((item) => item.path === reference.path)
      if (index < 0) index = references.push(reference) - 1
      const link = document.createElement('a')
      link.href = `#agent-media-${index}`
      link.textContent = reference.label
      link.dataset.agentMedia = String(index)
      return link.outerHTML
    }
    renderer.link = function (token) { return referenceLink(token.href, token.text) ?? Renderer.prototype.link.call(this, token) }
    renderer.image = function (token) { return referenceLink(token.href, token.text) ?? Renderer.prototype.image.call(this, token) }
    renderer.codespan = function (token) {
      const decoded = document.createElement('textarea')
      decoded.innerHTML = token.text
      const path = decoded.value
      // Bare names can describe suffixes or groups, not actual files in cwd.
      if (!/[\\/]/.test(path)) return Renderer.prototype.codespan.call(this, token)
      return referenceLink(path, path, false) ?? Renderer.prototype.codespan.call(this, token)
    }
    return { html: renderMarkdownForDisplay(text, renderer), references }
  }, [text, mediaContext?.cwd, mediaContext?.remote, mediaContext?.profileId])

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
    if (link.dataset.agentMedia !== undefined) {
      event.preventDefault()
      hostRef.current?.querySelector(`[data-agent-media-card="${Number(link.dataset.agentMedia)}"]`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    const href = link.href
    if (!href) return
    event.preventDefault()
    void window.lt.app.openExternal(href)
  }

  return (
    <div ref={hostRef} className={`agent-md-wrap${streaming ? ' streaming' : ''}`}>
      <div
        className="md-body agent-md-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {streaming && <span className="agent-stream-caret" aria-hidden="true" />}
      {!streaming && references.length > 0 && <div className="agent-media-list">{references.map((reference, index) =>
        <div key={reference.path} data-agent-media-card={index}><AgentMediaPreview reference={reference} active={active}
          onOpen={onOpenFile ? () => onOpenFile(reference.path, reference.label) : undefined} /></div>
      )}</div>}
    </div>
  )
}
