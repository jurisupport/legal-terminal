import assert from 'node:assert/strict'

const { isCommittedEnter, isImeComposing } = await import('../src/renderer/src/ime.ts')

const keyEvent = (key, keyCode, isComposing = false) => ({
  key,
  keyCode,
  nativeEvent: { isComposing }
})

assert.equal(isCommittedEnter(keyEvent('Enter', 13)), true)
assert.equal(isCommittedEnter(keyEvent('Enter', 229)), false)
assert.equal(isCommittedEnter(keyEvent('Enter', 13, true)), false)
assert.equal(isCommittedEnter(keyEvent('Process', 13)), false)
assert.equal(isImeComposing(keyEvent('Process', 13)), true)
assert.equal(isCommittedEnter(keyEvent('a', 65)), false)
