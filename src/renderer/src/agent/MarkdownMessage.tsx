import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { Renderer } from 'marked'
import { renderMarkdownForDisplay } from './markdown'
import { AgentMediaPreview } from './AgentMediaPreview'
import { agentMediaReference, resolveAgentMediaPath, type AgentMediaContext, type AgentMediaReference } from './mediaReferences'

function fileLinkPath(href: string, context: AgentMediaContext): string | undefined {
  const value = href.trim()
  if (!value || value.startsWith('#')) return undefined
  // Strip link locations before decoding; literal %, # and : may belong to filenames.
  const path = value.split(/[?#]/)[0].replace(/:\d+(?::\d+)?$/, '').replace(/%(?![\da-f]{2})/gi, '%25')
  return resolveAgentMediaPath(path, context, true)
}

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
  const [linkError, setLinkError] = useState('')
  const { html, references, files } = useMemo(() => {
    const references: AgentMediaReference[] = []
    const files: string[] = []
    const context = mediaContext ?? { cwd: '' }
    const renderer = new Renderer()
    const referenceLink = (href: string, label: string, decodeUrl = true): string | undefined => {
      const reference = agentMediaReference(href, label, context, decodeUrl)
      if (!reference) return undefined
      let index = references.findIndex((item) => item.path === reference.path)
      if (index < 0) index = references.push(reference) - 1
      const link = document.createElement('a')
      link.href = `#agent-media-${index}`
      link.textContent = reference.label
      link.dataset.agentMedia = String(index)
      return link.outerHTML
    }
    renderer.link = function (token) {
      const path = fileLinkPath(token.href, context)
      if (!path) return Renderer.prototype.link.call(this, token)
      const media = referenceLink(path, token.text, false)
      if (media) return media
      const index = files.push(path) - 1
      return Renderer.prototype.link.call(this, { ...token, href: `#agent-file-${index}` })
        .replace('<a ', `<a data-agent-file="${index}" `)
    }
    renderer.image = function (token) { return referenceLink(token.href, token.text) ?? Renderer.prototype.image.call(this, token) }
    renderer.codespan = function (token) {
      const decoded = document.createElement('textarea')
      decoded.innerHTML = token.text
      const path = decoded.value
      // Bare names can describe suffixes or groups, not actual files in cwd.
      if (!/[\\/]/.test(path)) return Renderer.prototype.codespan.call(this, token)
      return referenceLink(path, path, false) ?? Renderer.prototype.codespan.call(this, token)
    }
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownForDisplay(text, renderer)
    for (const code of host.querySelectorAll('code')) {
      if (code.closest('pre, a')) continue
      const value = code.textContent ?? ''
      if (!/^(?:\/|\.{1,2}[\\/]|[a-z]:[\\/]|file:|ssh:\/\/|[^\s:]+[\\/])/i.test(value) || !/\.[a-z\d]{1,16}$/i.test(value)) continue
      // Inline code is a literal filesystem path, not a URL to decode or strip fragments from.
      const path = resolveAgentMediaPath(value, context)
      if (!path) continue
      const index = files.push(path) - 1
      const link = document.createElement('a')
      link.href = `#agent-file-${index}`
      link.dataset.agentFile = String(index)
      link.title = '문서 열기'
      code.replaceWith(link)
      link.appendChild(code)
    }
    return { html: host.innerHTML, references, files }
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
    event.preventDefault()
    setLinkError('')
    const href = link.getAttribute('href') ?? ''
    const path = link.dataset.agentFile === undefined
      ? fileLinkPath(href, mediaContext ?? { cwd: '' })
      : files[Number(link.dataset.agentFile)]
    if (path) {
      if (!onOpenFile) { setLinkError('이 화면에서는 문서를 열 수 없습니다.'); return }
      try { onOpenFile(path, path.split('/').pop()) }
      catch (error) { setLinkError(`문서를 열지 못했습니다: ${String(error)}`) }
      return
    }
    if (link.dataset.agentMedia !== undefined) {
      const index = Number(link.dataset.agentMedia)
      const card = hostRef.current?.querySelector(`[data-agent-media-card="${index}"]`)
      if (card) card.scrollIntoView({ block: 'nearest' })
      else if (references[index] && onOpenFile) onOpenFile(references[index].path)
      return
    }
    if (!href) return
    if (href.startsWith('#')) {
      let id: string
      try { id = decodeURIComponent(href.slice(1)) } catch { return }
      const anchor = Array.from(hostRef.current?.querySelectorAll('[id]') ?? []).find(element => element.id === id)
      if (anchor) anchor.scrollIntoView({ block: 'nearest' })
      else setLinkError('연결된 위치를 찾을 수 없습니다.')
      return
    }
    const url = href.startsWith('//') ? `https:${href}` : href
    if (!/^(https?:|ftps?:|mailto:|tel:|sms:)/i.test(url)) {
      setLinkError('지원하지 않는 링크 형식입니다.')
      return
    }
    void window.lt.app.openExternal(url).catch(error => setLinkError(`링크를 열지 못했습니다: ${String(error)}`))
  }

  return (
    <div ref={hostRef} className={`agent-md-wrap${streaming ? ' streaming' : ''}`}>
      <div
        className="md-body agent-md-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {linkError && <div role="alert">{linkError}</div>}
      {streaming && <span className="agent-stream-caret" aria-hidden="true" />}
      {!streaming && references.length > 0 && <div className="agent-media-list">{references.map((reference, index) =>
        <div key={reference.path} data-agent-media-card={index}><AgentMediaPreview reference={reference} active={active}
          onOpen={onOpenFile ? () => onOpenFile(reference.path, reference.label) : undefined} /></div>
      )}</div>}
    </div>
  )
}
