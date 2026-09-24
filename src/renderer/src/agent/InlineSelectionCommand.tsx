import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isImeComposing } from '../ime'

interface Props {
  x: number
  y: number
  domRange?: Range
  sourceElement?: HTMLElement
  caseName: string
  sourceLabel: string
  text: string
  targetId: string
  targets: { id: string; label: string }[]
  ready: boolean
  onTargetChange: (id: string) => void
  suggest: (prefix: string) => string | undefined
  onSubmit: (text: string) => Promise<{ ok: boolean; error?: string }>
  onClose: () => void
}

const DEFAULT_INSTRUCTIONS = [
  '반박 논점과 필요한 증거를 정리해줘',
  '요약해서 쟁점과 사실을 나눠줘',
  '인용할 수 있게 서면 문장으로 다듬어줘'
]

export default function InlineSelectionCommand(props: Props): JSX.Element {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [composing, setComposing] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8, width: 600 })
  const popup = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const targetExists = props.targets.some((target) => target.id === props.targetId)
  const completion = composing || !input.trim() || input.includes('\n') ? undefined
    : props.suggest(input) ?? DEFAULT_INSTRUCTIONS.find((text) => text !== input && text.startsWith(input))
  const hint = completion && completion.length > input.length ? completion.slice(input.length) : ''

  useEffect(() => {
    if (sending) return
    const frame = window.requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [props.targetId, sending])
  useLayoutEffect(() => {
    if (!props.domRange) return
    CSS.highlights.set('inline-command-source', new Highlight(props.domRange))
    return () => { CSS.highlights.delete('inline-command-source') }
  }, [props.domRange])
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.max(54, element.scrollHeight)}px`
  }, [input, position.width])
  useLayoutEffect(() => {
    const element = popup.current
    if (!element) return
    const pane = props.sourceElement?.closest('.work-pane')
    let anchorRange = props.domRange
    const place = (): void => {
      const rect = element.getBoundingClientRect()
      const sourceVisible = props.sourceElement?.checkVisibility()
      const bounds = (sourceVisible ? props.sourceElement : pane)?.getBoundingClientRect()
      const minLeft = Math.max(8, (bounds?.left ?? 0) + 16)
      const maxRight = Math.min(window.innerWidth - 8, (bounds?.right ?? window.innerWidth) - 16)
      const minTop = Math.max(8, (bounds?.top ?? 0) + 8)
      const maxBottom = Math.min(window.innerHeight - 8, (bounds?.bottom ?? window.innerHeight) - 8)
      const anchor = sourceVisible && anchorRange?.startContainer.isConnected && !anchorRange.collapsed
        ? anchorRange.getBoundingClientRect() : undefined
      const width = Math.max(0, Math.min(600, maxRight - minLeft))
      const left = Math.max(minLeft, Math.min(anchor?.left ?? props.x - width / 2, maxRight - width))
      const below = (anchor?.bottom ?? props.y) + 10
      const above = (anchor?.top ?? props.y) - rect.height - 10
      const top = Math.max(minTop, Math.min(below + rect.height > maxBottom && above >= minTop ? above : below, maxBottom - rect.height))
      setPosition((current) => current.left === left && current.top === top && current.width === width ? current : { left, top, width })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    if (pane) observer.observe(pane)
    const node = anchorRange?.commonAncestorContainer
    const pdfLayer = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.textLayer')
    let sourceObserver: MutationObserver | undefined
    if (pdfLayer && anchorRange && !anchorRange.collapsed) {
      const page = pdfLayer.dataset.pdfPage, path = pdfLayer.dataset.pdfPath, pageText = pdfLayer.textContent
      const prefix = anchorRange.cloneRange()
      prefix.selectNodeContents(pdfLayer)
      prefix.setEnd(anchorRange.startContainer, anchorRange.startOffset)
      const start = prefix.toString().length, end = start + anchorRange.toString().length
      // PDF zoom rebuilds text nodes. Restore only the same page with identical text.
      sourceObserver = new MutationObserver(() => {
        anchorRange = undefined
        CSS.highlights.delete('inline-command-source')
        if (pdfLayer.dataset.pdfPage === page && pdfLayer.dataset.pdfPath === path && pdfLayer.textContent === pageText) {
          const range = document.createRange(), walker = document.createTreeWalker(pdfLayer, NodeFilter.SHOW_TEXT)
          let offset = 0, started = false, current: Node | null
          while ((current = walker.nextNode())) {
            const length = current.textContent?.length ?? 0
            if (!started && start <= offset + length) { range.setStart(current, start - offset); started = true }
            if (started && end <= offset + length) {
              range.setEnd(current, end - offset)
              anchorRange = range
              CSS.highlights.set('inline-command-source', new Highlight(range))
              break
            }
            offset += length
          }
        }
        place()
      })
      sourceObserver.observe(pdfLayer, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-pdf-page', 'data-pdf-path'] })
    }
    document.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      sourceObserver?.disconnect()
      document.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [props.x, props.y, props.domRange, props.sourceElement])

  const acceptCompletion = (): void => {
    if (!completion) return
    setInput(completion)
    textarea.current?.focus({ preventScroll: true })
  }
  const submit = async (): Promise<void> => {
    if (submitting.current || composing || !input.trim() || !targetExists || !props.ready) return
    submitting.current = true
    setSending(true)
    setError('')
    try {
      const result = await props.onSubmit(input.trim())
      if (result.ok) props.onClose()
      else setError(result.error ?? '지시를 보내지 못했습니다. 다시 시도해 주세요.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  return (
    <div ref={popup} className="inline-selection-command" style={position} role="dialog" aria-label="선택한 부분에 지시"
      onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeComposing(event)) return
        event.preventDefault()
        event.stopPropagation()
        if (!submitting.current) props.onClose()
      }}>
      <div className="inline-selection-head">
        <strong>이 부분에 지시</strong>
        <span className="inline-selection-source" title={`${props.caseName} · ${props.sourceLabel}\n${props.text}`}>{props.sourceLabel} · {Array.from(props.text).length.toLocaleString()}자 선택</span>
        <select className="inline-selection-target" aria-label="보낼 Agent 세션" title={`${props.caseName} · 보낼 Agent 세션`} value={props.targetId} disabled={sending} onChange={(event) => {
          setError('')
          props.onTargetChange(event.target.value)
        }}>
          {!targetExists && <option value={props.targetId} disabled>대상 세션이 닫혔습니다</option>}
          {props.targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
          <option value="__new__">이 사건에 새 Agent 세션</option>
        </select>
        <button type="button" className="inline-selection-close" aria-label="지시창 닫기" disabled={sending} onClick={props.onClose}>×</button>
      </div>
      <div className="inline-selection-entry">
        <div className="inline-selection-ghost" aria-hidden="true"><span>{input}</span>{hint}</div>
        <textarea ref={textarea} aria-label="선택 부분에 대한 지시" value={input} rows={2} disabled={sending}
          placeholder="이 부분을 어떻게 할까요?" onChange={(event) => { setInput(event.target.value); setError('') }}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (isImeComposing(event) || composing) return
            if (event.key === 'Tab' && !event.shiftKey && hint) { event.preventDefault(); acceptCompletion() }
            else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
          }} />
      </div>
      <div className="inline-selection-actions">
        <div className="inline-selection-hints">
          {hint && <button type="button" className="inline-selection-complete" onClick={acceptCompletion}><kbd>Tab</kbd> 완성</button>}
          <span title="Shift+Enter 줄바꿈"><kbd>Enter</kbd> 전송</span><span><kbd>Esc</kbd> 닫기</span>
        </div>
        <button type="button" className="inline-selection-send" aria-label="선택한 원문과 지시 보내기" disabled={sending || !input.trim() || !targetExists || !props.ready} onClick={() => void submit()}>
          {sending ? '…' : '↵'}
        </button>
      </div>
      {(error || !targetExists || !props.ready) && <div className="inline-selection-error" role={error ? 'alert' : 'status'}>
        {error || (!targetExists ? '이 사건의 다른 세션을 선택하거나 새로 만들어 주세요.' : 'Agent 세션을 준비하고 있습니다.')}
      </div>}
    </div>
  )
}
