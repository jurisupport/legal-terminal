export interface KeyboardLikeEvent {
  key: string
  keyCode?: number
  nativeEvent: {
    isComposing?: boolean
  }
}

export function isImeComposing(event: KeyboardLikeEvent): boolean {
  return Boolean(event.nativeEvent.isComposing) || event.key === 'Process' || event.keyCode === 229
}

export function isCommittedEnter(event: KeyboardLikeEvent): boolean {
  return event.key === 'Enter' && !isImeComposing(event)
}
