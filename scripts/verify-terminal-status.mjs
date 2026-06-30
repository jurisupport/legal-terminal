import assert from 'node:assert/strict'
import {
  getClaudeIdleStatus,
  isClaudeInputPromptLine,
  stripAnsi
} from '../src/renderer/src/terminal/statusTracker.ts'

assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello')
assert.equal(isClaudeInputPromptLine('› '), true)
assert.equal(isClaudeInputPromptLine('│ › '), true)
assert.equal(isClaudeInputPromptLine('building chunk 42/90'), false)

assert.equal(
  getClaudeIdleStatus('running tests\nchunk 42/90', 'building chunk 42/90'),
  'working',
  'quiet long output without a returned Claude prompt must stay working'
)
assert.equal(getClaudeIdleStatus('done\n', '› '), 'done')
assert.equal(getClaudeIdleStatus('Do you want to continue? (y/n)', 'Do you want to continue?'), 'question')

console.log('terminal status ok')
