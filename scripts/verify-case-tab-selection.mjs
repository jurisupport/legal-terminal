import assert from 'node:assert/strict'
import { closeTab } from '../src/renderer/src/tabSelection.ts'

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
