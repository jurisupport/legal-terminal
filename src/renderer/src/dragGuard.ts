const TERMINAL_POINTER_DRAG_ATTR = 'data-lt-terminal-pointer-drag'

interface CancellableEvent {
  preventDefault: () => void
  stopPropagation: () => void
}

export const isTerminalPointerDragActive = (): boolean =>
  document.documentElement.hasAttribute(TERMINAL_POINTER_DRAG_ATTR)

export const cancelIfTerminalPointerDrag = (event: CancellableEvent): boolean => {
  if (!isTerminalPointerDragActive()) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

export const installTerminalPointerDragGuard = (source: HTMLElement): (() => void) => {
  let activePointerId: number | null = null
  let fallbackClearTimer: number | null = null

  const clearFallbackTimer = (): void => {
    if (fallbackClearTimer === null) return
    window.clearTimeout(fallbackClearTimer)
    fallbackClearTimer = null
  }

  const clear = (): void => {
    activePointerId = null
    clearFallbackTimer()
    document.documentElement.removeAttribute(TERMINAL_POINTER_DRAG_ATTR)
  }

  const scheduleFallbackClear = (): void => {
    clearFallbackTimer()
    fallbackClearTimer = window.setTimeout(clear, 8000)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return
    activePointerId = event.pointerId
    document.documentElement.setAttribute(TERMINAL_POINTER_DRAG_ATTR, 'true')
    scheduleFallbackClear()
  }

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!isTerminalPointerDragActive()) return
    if (activePointerId === null || event.pointerId !== activePointerId) clear()
  }

  const onPointerDone = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    clear()
  }

  const onDragStart = (event: DragEvent): void => {
    if (!isTerminalPointerDragActive()) return
    event.preventDefault()
    event.stopPropagation()
    clear()
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') clear()
  }

  source.addEventListener('pointerdown', onPointerDown, true)
  source.addEventListener('lostpointercapture', onPointerDone, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('pointerup', onPointerDone, true)
  document.addEventListener('pointercancel', onPointerDone, true)
  window.addEventListener('pointerup', onPointerDone, true)
  window.addEventListener('pointercancel', onPointerDone, true)
  window.addEventListener('mouseup', clear, true)
  window.addEventListener('blur', clear)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', clear, true)
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    source.removeEventListener('pointerdown', onPointerDown, true)
    source.removeEventListener('lostpointercapture', onPointerDone, true)
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('pointerup', onPointerDone, true)
    document.removeEventListener('pointercancel', onPointerDone, true)
    window.removeEventListener('pointerup', onPointerDone, true)
    window.removeEventListener('pointercancel', onPointerDone, true)
    window.removeEventListener('mouseup', clear, true)
    window.removeEventListener('blur', clear)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', clear, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    clear()
  }
}
