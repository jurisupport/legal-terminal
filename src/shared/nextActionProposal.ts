export interface NextActionEvent { type: string; sessionId?: string; [key: string]: unknown }
export interface NextActionSuggestion { phase: 'waiting' | 'receiving' | 'done' | 'unavailable'; title: string }

/** One explicitly submitted turn, one assistant message, and at most one short proposal. */
export function nextActionCollector(requestId: string, sessionId: string): (event: NextActionEvent) => NextActionSuggestion {
  const marker = `[next-action:${requestId}]`
  let result: NextActionSuggestion = { phase: 'waiting', title: '' }
  let messageId: string | null = null
  let text = ''
  const oldMessages = new Set<string>()
  const hasMarker = (value: unknown): boolean => typeof value === 'string' && value.includes(marker)
  return (event) => {
    if (event.sessionId !== sessionId || result.phase === 'done' || result.phase === 'unavailable') return result
    if (event.type === 'message:user') {
      if (result.phase === 'receiving') return (result = { phase: 'unavailable', title: '' })
      const attachments = Array.isArray(event.attachments) ? event.attachments : []
      if (hasMarker(event.text) || attachments.some(item => item && typeof item === 'object' &&
        [item.text, item.content, item.source?.text].some(hasMarker))) result = { phase: 'receiving', title: '' }
      return result
    }
    if (result.phase === 'waiting') {
      if (typeof event.messageId === 'string') {
        if (oldMessages.size >= 256 && !oldMessages.has(event.messageId)) return (result = { phase: 'unavailable', title: '' })
        oldMessages.add(event.messageId)
      }
      return result
    }
    if (event.type === 'error' || event.type === 'session:interrupted' || (event.type === 'status' && event.status === 'error')) {
      return (result = { phase: 'unavailable', title: '' })
    }
    if (event.type === 'message:assistant_start' && !messageId && typeof event.messageId === 'string' && !oldMessages.has(event.messageId)) messageId = event.messageId
    if (!messageId || event.messageId !== messageId) return result
    if (event.type === 'message:assistant_delta' && typeof event.text === 'string') text = (text + event.text).slice(0, 8_000)
    if (event.type === 'message:assistant_replace' && typeof event.text === 'string') text = event.text.slice(0, 8_000)
    if (event.type === 'message:assistant_done') {
      const firstLine = text.trim().split(/\r?\n/, 1)[0]
      const title = firstLine.match(/^다음 행동\s*[:：]\s*(.+)$/)?.[1]?.trim().slice(0, 200) ?? ''
      result = { phase: title ? 'done' : 'unavailable', title }
    }
    return result
  }
}
