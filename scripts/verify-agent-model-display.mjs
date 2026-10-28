import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
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
assert.match(sessions, /model = typeof message\.model === 'string' \? message\.model : model/)
assert.match(panel, /setResumedModel\(transcript\?\.model \?\? null\)/)
assert.match(panel, /resumedModelDisplay\?\.modelLabel/)
assert.match(panel, /resumedModel === null \? '\ubaa8\ub378 \uc815\ubcf4 \uc5c6\uc74c'/)
assert.match(panel, /<label htmlFor=\{`agent-model-custom-\$\{id\}`\}>\ubaa9\ub85d\uc5d0 \uc5c6\ub294 \ubaa8\ub378 ID<\/label>/)
assert.match(panel, /new FormData\(event\.currentTarget\)\.get\('model'\)/)
assert.match(panel, /void chooseModel\(model\.trim\(\)\)/)

const compile = (source, context, name) => Function('context',
  `const { ${Object.keys(context).join(', ')} } = context;\n` +
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
  `\nreturn ${name}`
)(context)
const selected = []
const chooseSource = panel.match(/const chooseModel = async[\s\S]*?\n  }\n/)?.[0]
assert.ok(chooseSource)
const chooseModel = compile(chooseSource, {
  resumeSessionId: undefined, provider: 'codex', id: 'gpt-check', agentLabel: 'Codex',
  accountDefaultOption: { model: 'gpt-6-astra', defaultReasoningEffort: 'xhigh' },
  defaultModels: { codex: 'gpt-5.6-sol' }, SETTINGS_UPDATED_EVENT: 'settings', CustomEvent,
  window: {
    lt: {
      agent: { setModel: async (...args) => { selected.push(args); return { ok: true } } },
      settings: { set: async (value) => value }
    },
    dispatchEvent: () => {}
  },
  setError: () => {}, setSelectedModel: () => {}, setSelectedReasoningEffort: () => {},
  setModelPickerOpen: () => {}, showTransientFeedback: () => {}
}, 'chooseModel')
await chooseModel('gpt-5.6-sol', 'low')
await chooseModel()
assert.deepEqual(selected, [
  ['gpt-check', 'gpt-5.6-sol', 'low'],
  ['gpt-check', 'gpt-6-astra', 'xhigh']
], 'returning to the default must send its model and effort instead of retaining Sol')
assert.match(panel, /modelOptions\.filter\(\(model\) => provider === 'codex' \|\| !model\.isDefault\)/,
  'the default GPT model must also have a named row and effort buttons')

const listSource = service.match(/export async function listAgentModels[\s\S]*?\n}\n/)?.[0]
assert.ok(listSource)
const listModels = compile(listSource.replace('export ', ''), {
  sessions: new Map([['gpt-check', { provider: 'codex', cwd: '/tmp', model: 'gpt-6-astra', reasoningEffort: 'low' }]]),
  ensureCodexInitialized: async () => {},
  codexRequest: async (_session, method) => method === 'config/read'
    ? { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'high' } }
    : { data: [
      { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', isDefault: true, defaultReasoningEffort: 'medium' },
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'Sol', isDefault: false, defaultReasoningEffort: 'low' }
    ] },
  asRecord: (value) => value && typeof value === 'object' ? value : undefined,
  unknownArray: (value) => Array.isArray(value) ? value : [],
  stringValue: (value) => typeof value === 'string' ? value : undefined,
  codexModelOption: (value) => value
}, 'listAgentModels')
const listed = await listModels('gpt-check')
assert.equal(listed.ok, true)
assert.equal(listed.models.find((model) => model.isDefault)?.model, 'gpt-5.6-sol')
assert.equal(listed.models.find((model) => model.isDefault)?.defaultReasoningEffort, 'high')
assert.equal(listed.selectedModel, 'gpt-6-astra', 'reading defaults must preserve the explicit session selection')
assert.equal(listed.selectedReasoningEffort, 'low')

console.log('agent model display: GPT rows, configured defaults, and default switching verified')
