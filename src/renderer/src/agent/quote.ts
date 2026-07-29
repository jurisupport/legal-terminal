export function quoteAgentRequest(quote: string, request: string): string {
  return [
    '다음은 사용자가 인용한 이전 에이전트 답변입니다.',
    '<quoted-agent-response>',
    quote,
    '</quoted-agent-response>',
    '',
    request
  ].join('\n')
}

export function selectionTextOffsets(
  selection: Selection,
  root: HTMLElement
): { start: number; end: number } | undefined {
  if (selection.isCollapsed || selection.rangeCount !== 1) return undefined
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return { start, end: start + range.toString().length }
}

export function restoreTextSelection(
  root: HTMLElement,
  start: number,
  end: number
): HTMLElement | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return undefined
  const walker = root.ownerDocument.createTreeWalker(
    root,
    root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  )
  let offset = 0
  let startNode: Text | undefined
  let startOffset = 0
  let endNode: Text | undefined
  let endOffset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (text.length === 0) continue
    const nextOffset = offset + text.length
    if (!startNode && (start < nextOffset || (start === 0 && offset === 0))) {
      startNode = text
      startOffset = start - offset
    }
    if (end <= nextOffset) {
      endNode = text
      endOffset = end - offset
      break
    }
    offset = nextOffset
  }
  const selection = root.ownerDocument.defaultView?.getSelection()
  if (!startNode || !endNode || !selection) return undefined
  const range = root.ownerDocument.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  selection.removeAllRanges()
  selection.addRange(range)
  return startNode.parentElement ?? root
}
