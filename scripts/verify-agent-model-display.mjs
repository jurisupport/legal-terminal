import assert from 'node:assert/strict'
import { currentAgentModel } from '../src/renderer/src/agent/modelDisplay.ts'

const options = [
  {
    model: 'default',
    displayName: 'Default',
    resolvedModel: 'claude-opus-4-8',
    isDefault: true,
    defaultReasoningEffort: 'high'
  },
  { model: 'sonnet', displayName: 'Sonnet' }
]

assert.deepEqual(currentAgentModel(options), {
  model: 'default',
  modelLabel: 'claude-opus-4-8',
  effort: 'high',
  buttonLabel: 'claude-opus-4-8 · high'
})
assert.equal(currentAgentModel(options, 'sonnet', 'medium').buttonLabel, 'Sonnet · medium')
assert.equal(currentAgentModel(options, 'custom-model').buttonLabel, 'custom-model')
assert.equal(
  currentAgentModel(
    [{ model: 'sonnet', displayName: 'Sonnet', supportedReasoningEfforts: ['low', 'high'] }],
    'sonnet'
  ).buttonLabel,
  'Sonnet · 기본값'
)

console.log('agent model display verification passed')
