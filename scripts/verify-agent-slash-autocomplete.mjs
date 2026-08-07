import assert from 'node:assert/strict'
import { replaceSlashToken, slashTokenAt } from '../src/renderer/src/agent/slashAutocomplete.ts'

assert.deepEqual(slashTokenAt('/rev', 4), { token: '/rev', start: 0, end: 4 })
assert.deepEqual(slashTokenAt('검토 /rev', 7), { token: '/rev', start: 3, end: 7 })
assert.deepEqual(slashTokenAt('검토/', 3), { token: '/', start: 2, end: 3 })
assert.deepEqual(slashTokenAt('검토 /review 계속', 6), { token: '/re', start: 3, end: 10 })
assert.deepEqual(slashTokenAt('경로/foo', 6), { token: '/foo', start: 2, end: 6 })

assert.deepEqual(
  replaceSlashToken('검토 /rev 계속', { token: '/rev', start: 3, end: 7 }, '/review'),
  { text: '검토 /review 계속', caret: 10 }
)
assert.deepEqual(
  replaceSlashToken('검토 /rev', { token: '/rev', start: 3, end: 7 }, '/review'),
  { text: '검토 /review ', caret: 11 }
)

console.log('agent slash autocomplete works at the caret without replacing surrounding text')
