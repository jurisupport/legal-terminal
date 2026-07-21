import assert from 'node:assert/strict'
import { rateLimitLabel, rateLimitTone, resetTimeText } from '../src/renderer/src/agent/rateLimitDisplay.ts'

const resetsAt = new Date(2026, 5, 30, 21, 5).getTime()
const reset = resetTimeText(resetsAt)

assert.ok(reset, 'reset text should be present when resetsAt is valid')
assert.match(reset, /^갱신 /, 'reset text should identify the time as the renewal point')
assert.match(reset, /6\.\s*30\./, 'reset text should include the renewal date')
assert.match(reset, /21:05/, 'reset text should include the renewal time')
assert.equal(
  rateLimitLabel({
    rateLimitType: 'five_hour',
    remainingPercent: 42,
    resetsAt,
    updatedAt: resetsAt
  }),
  `5시간 한도 잔여 42% · ${reset}`
)
assert.equal(resetTimeText(undefined), undefined)
assert.equal(rateLimitTone({ status: 'allowed', remainingPercent: 93, updatedAt: resetsAt }), '')
assert.equal(rateLimitTone({ status: 'allowed_warning', updatedAt: resetsAt }), 'warn')
assert.equal(rateLimitTone({ status: 'rejected', updatedAt: resetsAt }), 'error')

console.log('agent rate limit labels ok')
