import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const pdfViewer = readFileSync(join(root, 'src/renderer/src/viewer/PdfViewer.tsx'), 'utf8')
const activateDocTab = app.slice(
  app.indexOf('const activateDocTab ='),
  app.indexOf('const openAgentDiff =')
)

assert.doesNotMatch(
  activateDocTab,
  /setActiveCaseTabId/,
  'clicking an already visible PDF must not switch its case workspace'
)

assert.match(
  app,
  /display:\s*doc\.id === activeDocForPane\?\.id \? 'flex' : 'none'/,
  'active mounted document tabs must keep doc-content as a flex container'
)

const blockFor = (selector) => {
  const match = css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`, 'm'))
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
assert.match(wrap, /cursor:\s*text/, 'selection mode must show a text cursor')

const textLayer = blockFor('.textLayer')
assert.match(textLayer, /user-select:\s*text/, 'the PDF text layer must allow native text selection')

assert.match(
  pdfViewer,
  /disabled=\{page <= 1 && !onPrevDoc\}/,
  'the previous button must stay enabled at page one when a previous record exists'
)
assert.match(
  pdfViewer,
  /disabled=\{numPages === 0 \|\| \(page >= numPages && !onNextDoc\)\}/,
  'the next button must stay enabled at the last page when a next record exists'
)
assert.match(
  pdfViewer,
  /if \(!wrap \|\| !panMode\) return/,
  'selection mode must skip pan-only drag handlers entirely'
)

const lockedWheel = pdfViewer.slice(
  pdfViewer.indexOf('if (pageTurnLocked) {'),
  pdfViewer.indexOf('if (Math.abs(delta.y) <= 0.5) return')
)
assert.doesNotMatch(
  lockedWheel,
  /lockPageTurn\(\)/,
  'trackpad momentum must not keep extending the wheel page-turn lock'
)

console.log('pdf layout ok')
