import assert from 'node:assert/strict'
import { codexTurnRunStatus, codexWorkStepStatus } from '../src/main/agent/agentProgress.ts'
import { activeSubAgentCount, isSubAgentStep } from '../src/renderer/src/agent/subAgentStatus.ts'

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
assert.equal(isSubAgentStep({ id: 'codex-agent:agent-1' }), true)
assert.equal(isSubAgentStep({ id: 'claude-tool-1', toolName: 'Task' }), true)
assert.equal(isSubAgentStep({ id: 'shell-1' }), false)
assert.equal(
  activeSubAgentCount([
    {
      processSteps: [
        { id: 'codex-agent:agent-1', status: 'running' },
        { id: 'claude-tool-1', toolName: 'Task', status: 'running' },
        { id: 'codex-agent:agent-2', status: 'done' },
        { id: 'shell-1', status: 'running' }
      ]
    },
    { processSteps: [{ id: 'codex-agent:agent-1', status: 'running' }] }
  ]),
  2,
  'only unique running subagents should appear in the live count'
)

console.log('agent progress status ok')
