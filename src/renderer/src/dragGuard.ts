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

  const clear = (): void => {
    activePointerId = null
    document.documentElement.removeAttribute(TERMINAL_POINTER_DRAG_ATTR)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return
    activePointerId = event.pointerId
    document.documentElement.setAttribute(TERMINAL_POINTER_DRAG_ATTR, 'true')
  }

  const onPointerDone = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    clear()
  }

  const onDragStart = (event: DragEvent): void => {
    if (!isTerminalPointerDragActive()) return
    event.preventDefault()
    event.stopPropagation()
  }

  source.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerDone, true)
  window.addEventListener('pointercancel', onPointerDone, true)
  window.addEventListener('blur', clear)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', clear, true)

  return () => {
    source.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerDone, true)
    window.removeEventListener('pointercancel', onPointerDone, true)
    window.removeEventListener('blur', clear)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', clear, true)
    clear()
  }
}
