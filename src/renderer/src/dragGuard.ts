const PANEL_POINTER_DRAG_ATTR = 'data-lt-panel-pointer-drag'
const POINTER_DRAG_THRESHOLD_PX = 4

interface CancellableEvent {
  preventDefault: () => void
  stopPropagation: () => void
}

interface PointerDragGuardOptions {
  cancelNativeDragStart?: boolean
}

export const isPanelPointerDragActive = (): boolean =>
  document.documentElement.hasAttribute(PANEL_POINTER_DRAG_ATTR)

const clearPanelPointerDrag = (): void => {
  document.documentElement.removeAttribute(PANEL_POINTER_DRAG_ATTR)
}

export const cancelIfPanelPointerDrag = (event: CancellableEvent): boolean => {
  if (!isPanelPointerDragActive()) return false
  event.preventDefault()
  event.stopPropagation()
  clearPanelPointerDrag()
  return true
}

export const installPanelPointerDragGuard = (
  source: HTMLElement,
  options: PointerDragGuardOptions = {}
): (() => void) => {
  const cancelNativeDragStart = options.cancelNativeDragStart ?? true
  let activePointerId: number | null = null
  let startX = 0
  let startY = 0
  let fallbackClearTimer: number | null = null

  const clearFallbackTimer = (): void => {
    if (fallbackClearTimer === null) return
    window.clearTimeout(fallbackClearTimer)
    fallbackClearTimer = null
  }

  const clear = (): void => {
    activePointerId = null
    clearFallbackTimer()
    clearPanelPointerDrag()
  }

  const scheduleFallbackClear = (): void => {
    clearFallbackTimer()
    fallbackClearTimer = window.setTimeout(clear, 8000)
  }

  const markDragActive = (): void => {
    if (isPanelPointerDragActive()) return
    document.documentElement.setAttribute(PANEL_POINTER_DRAG_ATTR, 'true')
    scheduleFallbackClear()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return
    activePointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      clear()
      return
    }
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX) return
    markDragActive()
  }

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!isPanelPointerDragActive()) return
    if (activePointerId === null || event.pointerId !== activePointerId) clear()
  }

  const onPointerDone = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    clear()
  }

  const onDragStart = (event: DragEvent): void => {
    const fromSource = event.target instanceof Node && source.contains(event.target)
    if (!isPanelPointerDragActive() && !fromSource) return
    if (!cancelNativeDragStart) {
      clear()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    clear()
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') clear()
  }

  source.addEventListener('pointerdown', onPointerDown, true)
  source.addEventListener('pointermove', onPointerMove, true)
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
    source.removeEventListener('pointermove', onPointerMove, true)
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

export const isTerminalPointerDragActive = isPanelPointerDragActive
export const cancelIfTerminalPointerDrag = cancelIfPanelPointerDrag
export const installTerminalPointerDragGuard = installPanelPointerDragGuard
