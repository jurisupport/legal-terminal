import assert from 'node:assert/strict'

class FakeNode {
  constructor(parent = null) {
    this.parent = parent
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener)
    )
  }

  contains(node) {
    for (let item = node; item; item = item.parent) {
      if (item === this) return true
    }
    return false
  }

  fire(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const attrs = new Set()
const documentTarget = new FakeNode()
const windowTarget = new FakeNode()

globalThis.Node = FakeNode
globalThis.document = Object.assign(documentTarget, {
  documentElement: {
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name) => attrs.add(name),
    removeAttribute: (name) => attrs.delete(name)
  },
  visibilityState: 'visible'
})
globalThis.window = Object.assign(windowTarget, { setTimeout, clearTimeout })

const {
  cancelIfPanelPointerDrag,
  installPanelPointerDragGuard,
  isPanelPointerDragActive
} = await import('../src/renderer/src/dragGuard.ts')

const pointer = (pointerId, clientX, clientY, buttons = 1) => ({
  isPrimary: true,
  button: 0,
  pointerId,
  clientX,
  clientY,
  buttons
})

const source = new FakeNode()
const child = new FakeNode(source)
const uninstall = installPanelPointerDragGuard(source)

source.fire('pointerdown', pointer(1, 10, 10))
assert.equal(isPanelPointerDragActive(), false, 'plain terminal clicks must not lock panel input')

source.fire('pointermove', pointer(1, 12, 10))
assert.equal(isPanelPointerDragActive(), false, 'tiny pointer jitter is still a click')

source.fire('pointermove', pointer(1, 15, 10))
assert.equal(isPanelPointerDragActive(), true, 'real pointer drags arm the native drag guard')

let canceled = false
let stopped = false
assert.equal(
  cancelIfPanelPointerDrag({
    preventDefault: () => {
      canceled = true
    },
    stopPropagation: () => {
      stopped = true
    }
  }),
  true
)
assert.equal(canceled, true)
assert.equal(stopped, true)
assert.equal(isPanelPointerDragActive(), false, 'cancelled stale guards must release immediately')
document.fire('pointerup', { pointerId: 1 })

source.fire('pointerdown', pointer(2, 0, 0))
canceled = false
stopped = false
document.fire('dragstart', {
  target: child,
  preventDefault: () => {
    canceled = true
  },
  stopPropagation: () => {
    stopped = true
  }
})
assert.equal(canceled, true, 'native drags from guarded panels are still suppressed')
assert.equal(stopped, true)

canceled = false
document.fire('dragstart', {
  target: new FakeNode(),
  preventDefault: () => {
    canceled = true
  },
  stopPropagation: () => {}
})
assert.equal(canceled, false, 'inactive guards must not block unrelated drags')

uninstall()
