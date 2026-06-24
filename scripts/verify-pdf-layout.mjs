import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

assert.match(
  app,
  /display:\s*doc\.id === activeDocForPane\?\.id \? 'flex' : 'none'/,
  'active mounted document tabs must keep doc-content as a flex container'
)

const blockFor = (selector) => {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))
  assert.ok(match, `${selector} rule must exist`)
  return match[1]
}

const viewer = blockFor('.pdf-viewer')
assert.match(viewer, /height:\s*100%/, 'pdf viewer must fill the document pane height')
assert.match(viewer, /min-height:\s*0/, 'pdf viewer must be shrinkable inside flex panes')
assert.match(viewer, /min-width:\s*0/, 'pdf viewer must not force horizontal overflow')
assert.match(viewer, /display:\s*flex/, 'pdf viewer must lay out toolbar and canvas as flex children')
assert.match(viewer, /flex-direction:\s*column/, 'pdf viewer must reserve the remaining height for the canvas')

const wrap = blockFor('.pdf-canvas-wrap')
assert.match(wrap, /flex:\s*1/, 'pdf canvas wrapper must take the remaining viewer height')
assert.match(wrap, /min-height:\s*0/, 'pdf canvas wrapper must report the actual available height')

console.log('pdf layout ok')
