import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as browser from '../src/main/browserAgentBridge.ts'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as project from '../src/main/agent/projectMcpConfig.ts'
import * as execution from '../src/main/agent/agentExecutionLock.ts'

// Exercise the real dialog handlers and transport setup without SSH or a model call.
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const require = createRequire(import.meta.url), service = { exports: {} }
const launches = [], queries = [], events = []
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); packets = []
  stdin = {
    destroyed: false, writableEnded: false,
    write: text => {
      const message = JSON.parse(text)
      this.packets.push(message)
      queueMicrotask(() => {
        if (message.type === 'control_request') {
          const response = message.request.subtype === 'mcp_status'
            ? { mcpServers: [{ name: browser.BROWSER_MCP, status: 'connected' }] } : { errors: {} }
          this.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_response', response: {
            subtype: 'success', request_id: message.request_id, response
          } }) + '\n'))
        } else if (message.type === 'user') this.emit('close', 0, null)
      })
      return true
    },
    end: () => { this.stdin.writableEnded = true; this.emit('close', 0, null) }
  }
  constructor() { super(); launches.push(this) }
  kill() { this.emit('close', 0, null) }
}
runInNewContext(ts.transpileModule(`${source}
refreshAgentAuthStatus = (session) => { session.authStatus = 'authenticated' };
prefetchClaudeSlashCommands = () => {}; restoreRemoteSession = () => {};
maybeGenerateSessionTitle = () => {}; scheduleWorkSummary = () => {}; flushWorkSummary = () => {};
export const check = { sessions, requestUserDialog, requestPermission, handleRemoteControlRequest, runRemoteAgentMessage };
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: service.exports, process, Buffer, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  require: name => {
    if (name === '@anthropic-ai/claude-agent-sdk') return { query: args => {
      queries.push(args)
      return { getContextUsage: async () => undefined, close() {}, async *[Symbol.asyncIterator]() {} }
    } }
    if (name === '../jurisupport') return { onAgentMcpAccountChange() {}, agentMcpAccountEpoch: () => 1 }
    if (name === '../sessions') return { readSessionTokenUsage: async () => undefined, rememberSessionMeta: async () => {} }
    if (name === '../browserAgentBridge') return { ...browser, getBrowserAgentConnection: async () => undefined }
    if (name === './agentMcp') return managed
    if (name === './projectMcpConfig') return project
    if (name === './agentExecutionLock') return execution
    if (name === './agentPrompt') return { prependAgentContext: (_context, text) => text }
    if (name === './remoteAgentTransport') return { RemoteAgentTransport: FakeProcess }
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name.startsWith('.')) return {}
    return require(name)
  }
})
const api = service.exports, check = api.check
const plain = value => JSON.parse(JSON.stringify(value))
const viewer = { id: 1, isDestroyed: () => false, once() {}, send: (_channel, event) => events.push(event) }
function session(id, source = 'local') {
  assert.equal(api.createAgentSession({ id, provider: 'claude', source, cwd: '/test/workspace',
    permissionMode: 'ask', ...(source === 'ssh' ? { ssh: { host: 'fake.invalid', user: 'test' } } : {}) }, viewer).ok, true)
  return check.sessions.get(id)
}
const questions = [
  { question: '어떤 형식으로 작성할까요?', header: '형식', options: [{ label: '서면', description: '서면 작성' }, { label: '메모', description: '메모 정리' }], multiSelect: false },
  { question: '포함할 내용을 선택하세요.', header: '내용', options: [{ label: '판례', description: '판례 포함' }, { label: '법령', description: '법령 포함' }], multiSelect: true }
]
function request(id, selected = questions) {
  return { dialogKind: 'permission_ask_user_question', toolUseID: id, payload: {
    requestId: id, toolName: 'AskUserQuestion', permissionResult: { behavior: 'ask' },
    input: { questions: selected, metadata: { source: 'dialog-test' } }, questions: selected
  } }
}
function answer(s, id, value) {
  assert.equal(api.answerAgentDialog({ sessionId: s.id, dialogId: id, ...value }).ok, true)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const local = session('local-dialog')
assert.equal(api.sendAgentMessage(local.id, { text: '질문을 확인해 주세요.' }).ok, true)
for (let i = 0; local.running && i < 100; i++) await tick()
assert.equal(local.running, undefined)
assert.equal(queries.length, 1)
assert.deepEqual(plain(queries[0].options.supportedDialogKinds), ['permission_ask_user_question'])
assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events))

for (const transport of ['local', 'ssh']) {
  const s = transport === 'local' ? local : session('ssh-dialog', 'ssh')
  const controller = new AbortController()
  s.running = controller
  const packets = []
  if (transport === 'ssh') s.remoteProcess = { stdin: { write: text => packets.push(JSON.parse(text)) } }
  function ask(value) {
    if (transport === 'local') return queries[0].options.onUserDialog(value, { signal: controller.signal })
    const count = packets.length, id = `control-${value.toolUseID}`
    assert.equal(check.handleRemoteControlRequest(s, { type: 'control_request', request_id: id,
      request: { subtype: 'request_user_dialog', dialog_kind: value.dialogKind, payload: value.payload, tool_use_id: value.toolUseID }
    }), true)
    return (async () => {
      for (let i = 0; packets.length === count && i < 100; i++) await tick()
      assert.equal(packets.length, count + 1)
      assert.equal(packets.at(-1).response.request_id, id)
      return packets.at(-1).response.response
    })()
  }
  const selected = ask(request(`${transport}-choice`))
  assert.equal(s.pendingDialogs.size, 1, 'a question must wait for a user answer')
  assert.equal(s.lastStatus, 'waiting_user')
  assert.equal(s.dialogs.get(`${transport}-choice`).questions.length, 2)
  answer(s, `${transport}-choice`, { answers: { [questions[0].question]: '서면', [questions[1].question]: '판례, 법령' } })
  const result = await selected
  assert.equal(result.behavior, 'completed')
  assert.equal(result.result.behavior, 'allow')
  assert.deepEqual(plain(result.result.updatedInput), { questions, metadata: { source: 'dialog-test' },
    answers: { [questions[0].question]: '서면', [questions[1].question]: '판례, 법령' } })
  assert.equal(s.pendingDialogs.size, 0)

  const freeform = ask(request(`${transport}-freeform`, [questions[0]]))
  answer(s, `${transport}-freeform`, { response: '  요약문으로 작성해 주세요.  ' })
  const typed = (await freeform).result.updatedInput
  assert.equal(typed.answers[questions[0].question], '요약문으로 작성해 주세요.')
  assert.equal(typed.response, '요약문으로 작성해 주세요.')

  const annotated = ask(request(`${transport}-extra`, [questions[0]]))
  answer(s, `${transport}-extra`, { answers: { [questions[0].question]: '서면' }, response: '  간결하게 써 주세요.  ' })
  const extra = (await annotated).result.updatedInput
  assert.equal(extra.answers[questions[0].question], '서면', 'supplemental input must not replace a selection')
  assert.equal(extra.response, '간결하게 써 주세요.')

  const cancelled = ask(request(`${transport}-cancel`))
  answer(s, `${transport}-cancel`, { cancelled: true })
  assert.deepEqual(plain(await cancelled), { behavior: 'cancelled' })
  for (const invalid of [
    { ...request(`${transport}-unknown`), dialogKind: 'permission_bash' },
    { ...request(`${transport}-future`), dialogKind: 'future_question' },
    { ...request(`${transport}-malformed`), payload: { questions } },
    request(`${transport}-empty`, []),
    { ...request(`${transport}-wrong-tool`), payload: { ...request('unused').payload, toolName: 'Bash' } }
  ]) {
    const before = events.filter(event => event.type === 'dialog:request').length
    assert.deepEqual(plain(await ask(invalid)), { behavior: 'cancelled' })
    assert.equal(events.filter(event => event.type === 'dialog:request').length, before, 'unsupported payloads must not become approval cards')
  }
  const aborted = ask(request(`${transport}-abort`))
  controller.abort()
  assert.deepEqual(plain(await aborted), { behavior: 'cancelled' })
  assert.equal(s.pendingDialogs.size, 0)
  assert.deepEqual(plain(await ask(request(`${transport}-already-aborted`))), { behavior: 'cancelled' })
}

// Old Claude versions still ask through canUseTool.
const legacy = session('legacy-dialog')
const legacyResult = check.requestPermission(legacy, 'AskUserQuestion', { questions }, {
  signal: new AbortController().signal, toolUseID: 'legacy-question'
})
answer(legacy, 'legacy-question', { answers: { [questions[0].question]: '메모' } })
assert.equal((await legacyResult).behavior, 'allow')
const legacyRemote = session('legacy-remote', 'ssh'), legacyPackets = []
legacyRemote.remoteProcess = { stdin: { write: text => legacyPackets.push(JSON.parse(text)) } }
check.handleRemoteControlRequest(legacyRemote, { type: 'control_request', request_id: 'legacy-control',
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'legacy-remote-question', input: { questions } }
})
answer(legacyRemote, 'legacy-remote-question', { answers: { [questions[0].question]: '메모' } })
assert.equal(legacyPackets[0].response.request_id, 'legacy-control')
assert.equal(legacyPackets[0].response.response.behavior, 'allow')

for (const withMcp of [false, true]) {
  const s = session(`remote-init-${withMcp}`, 'ssh'), controller = new AbortController()
  s.running = controller
  if (withMcp) s.browserMcp = { url: 'http://127.0.0.1:1234/mcp', token: 'synthetic', location: 'remote' }
  await check.runRemoteAgentMessage(s, '검토해 주세요.', controller)
  const packets = launches.at(-1).packets
  assert.equal(packets[0].request.subtype, 'initialize')
  assert.deepEqual(plain(packets[0].request.supportedDialogKinds), ['permission_ask_user_question'])
  assert.deepEqual(packets.map(packet => packet.request?.subtype ?? packet.type),
    withMcp ? ['initialize', 'mcp_set_servers', 'mcp_status', 'user'] : ['initialize', 'user'])
  assert.equal(packets.filter(packet => packet.type === 'user').length, 1)
}
console.log('Claude dialogs: local/SSH capabilities, selections, freeform, cancellation, abort, unknown kinds and legacy questions pass')
