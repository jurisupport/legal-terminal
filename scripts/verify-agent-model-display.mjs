import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const settings = await readFile(new URL('../src/main/settings.ts', import.meta.url), 'utf8')
const sessions = await readFile(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
assert.match(service, /function claudeModel\(session: AgentSession\): string \| undefined \{\s*return session\.model\?\.trim\(\) \|\| \(session\.resumeSessionId \? undefined : 'default'\)\s*\}/)
assert.equal(service.match(/shellArgFlag\('--model', claudeModel\(session\)\)/g)?.length, 2)
assert.equal(service.match(/model: claudeModel\(session\)/g)?.length, 2)
assert.match(service, /description\?\.split\(\/\\s\+\(\?:with\\b\|·\)\/, 1\)\[0\]/)
assert.match(settings, /agentDefaultModels\?: Partial<Record<AgentProvider, string>>/)
assert.match(panel, /const defaultModel = defaultModels\[provider\]/)
assert.match(panel, /\.create\(\{[\s\S]*?model: resumeSessionId \? undefined : defaultModel,/)
assert.match(panel, /agentDefaultModels: nextDefaultModels/)
assert.match(panel, /\uc0c8 \uc138\uc158 \uae30\ubcf8\uac12:/)
assert.match(panel, /const sessionModel = !model && resumeSessionId/)
assert.match(sessions, /model = typeof message\.model === 'string' \? message\.model : model/)
assert.match(panel, /setResumedModel\(transcript\?\.model \?\? null\)/)
assert.match(panel, /resumedModelDisplay\?\.modelLabel/)
assert.match(panel, /resumedModel === null \? '\ubaa8\ub378 \uc815\ubcf4 \uc5c6\uc74c'/)
assert.match(panel, /<label htmlFor=\{`agent-model-custom-\$\{id\}`\}>\ubaa9\ub85d\uc5d0 \uc5c6\ub294 \ubaa8\ub378 ID<\/label>/)
assert.match(panel, /new FormData\(event\.currentTarget\)\.get\('model'\)/)
assert.match(panel, /void chooseModel\(model\.trim\(\)\)/)

console.log('agent model display verification passed')
