import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { closeTab } from '../src/renderer/src/tabSelection.ts'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
assert.match(
  app,
  /caseTabIdOverride \?\? currentCaseTabIdForNewTab\(\) \?\? inferCaseTabIdForPath\(path, caseTabs\)/,
  'opening a file must stay in the current case before considering a nested case path'
)

const caseTabSubtitle = app.match(/const caseTabSubtitle[\s\S]*?\n    \]\)/)?.[0] ?? ''
assert.match(caseTabSubtitle, /tab\.remotePath \?\? tab\.drafts/, 'case tabs must expose the full case path')
assert.doesNotMatch(caseTabSubtitle, /pathLeaf\(/, 'case tabs must not reduce the case path to its last folder')

const oldCaseAgent = { id: 'old-case-agent' }
const newCaseAgent = { id: 'new-case-agent' }
let active = newCaseAgent.id

const remaining = closeTab(
  [oldCaseAgent, newCaseAgent],
  newCaseAgent.id,
  active,
  (id) => {
    active = id
  },
  [newCaseAgent]
)

assert.deepEqual(remaining, [oldCaseAgent])
assert.equal(active, '', 'closing the last agent must not activate an agent from another case')

const first = { id: 'first' }
const middle = { id: 'middle' }
const last = { id: 'last' }
active = middle.id
closeTab(
  [first, middle, last],
  middle.id,
  active,
  (id) => {
    active = id
  },
  [first, middle, last]
)
assert.equal(active, last.id, 'closing an agent must still activate its same-case neighbor')

console.log('case tab selection ok')
