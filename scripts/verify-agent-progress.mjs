import assert from 'node:assert/strict'
import { codexTurnRunStatus, codexWorkStepStatus } from '../src/main/agent/agentProgress.ts'

for (const status of ['pendingInit', 'running', 'inProgress']) {
  assert.equal(codexWorkStepStatus(status), 'running', `${status} work must keep the progress indicator visible`)
}
for (const status of ['errored', 'notFound', 'failed', 'declined']) {
  assert.equal(codexWorkStepStatus(status), 'error')
}
assert.equal(codexWorkStepStatus('interrupted'), 'cancelled')
assert.equal(codexWorkStepStatus('completed'), 'done')
assert.equal(codexTurnRunStatus('completed', 1), 'working', 'a finished parent turn must not hide active child work')
assert.equal(codexTurnRunStatus('completed', 0), 'done')
assert.equal(codexTurnRunStatus('failed', 1), 'error')

console.log('agent progress status ok')
