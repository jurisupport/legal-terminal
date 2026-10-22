import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as browserBridge from '../src/main/browserAgentBridge.ts'
import * as execution from '../src/main/agent/agentExecutionLock.ts'
import * as progress from '../src/main/agent/agentProgress.ts'
import * as mcp from '../src/main/agent/agentMcp.ts'
import * as projectMcp from '../src/main/agent/projectMcpConfig.ts'

// Run the real session lifecycle and protocol handlers without SSH or a model.
const source = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${source}
refreshAgentAuthStatus = (session) => emitAuthStatus(session, 'authenticated');
prefetchClaudeSlashCommands = () => {};
maybeGenerateSessionTitle = () => {};
scheduleWorkSummary = () => {};
flushWorkSummary = () => {};
export const missingCheck = { sessions, handleSdkMessage };
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
const missingId = '11111111-1111-4111-8111-111111111111'
const freshId = '22222222-2222-4222-8222-222222222222'
const missingMessage = `No conversation found with session ID: ${missingId}`
const cwd = '/test/legal-workspace'
let nextId = 0

async function until(check, label) {
  for (let n = 0; n < 100; n++) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(label)
}

function freshApp(scenarios, restoreInfo) {
  let api
  const attempts = []
  class TestTransport extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.inputs = []
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      this.stdin = {
        destroyed: false, writableEnded: false,
        write: (text) => { this.inputs.push(JSON.parse(text)); return true },
        end: () => {
          this.stdin.writableEnded = true
          queueMicrotask(() => this.finish())
        }
      }
      const scenario = scenarios[attempts.length]
      attempts.push(this)
      queueMicrotask(() => {
        if (!scenario) {
          this.stderr.emit('data', Buffer.from('Unexpected additional retry'))
          this.finish(1)
        } else scenario(this, api)
      })
    }
    json(message, newline = true) {
      this.stdout.emit('data', Buffer.from(JSON.stringify(message) + (newline ? '\n' : '')))
    }
    finish(code = 0, signal = null) {
      if (this.closed) return
      this.closed = true
      this.emit('close', code, signal)
    }
    kill() {
      this.killed = true
      queueMicrotask(() => this.finish(1, 'SIGTERM'))
    }
  }
  const module = { exports: {} }
  runInNewContext(compiled, {
    exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => {
      if (name === './remoteAgentTransport') return { RemoteAgentTransport: TestTransport, probeRemoteAgentRun: async () => restoreInfo }
      if (name === './agentExecutionLock') return execution
      if (name === './agentProgress') return progress
      if (name === '../browserAgentBridge') return browserBridge
      if (name === './agentMcp') return mcp
      if (name === './projectMcpConfig') return projectMcp
      if (name === '../projectAgent') return { releaseProjectMcp: () => {}, disposeProjectMcp: () => {} }
      if (name === '../sessions') return { rememberSessionMeta: async () => {}, readSessionTokenUsage: async () => undefined }
      if (name === '../sshOptions') return { buildSshArgs: () => [] }
      if (name === '../jurisupport') return { getAgentMcpConnection: async () => undefined, agentMcpAccountEpoch: () => 1, onAgentMcpAccountChange: () => {} }
      if (name === './agentPrompt') return { prependAgentContext: (_context, text) => text }
      if (name === '../../shared/media') return {}
      if (name === '@anthropic-ai/claude-agent-sdk') return { query: () => { throw new Error('Unexpected real model query') } }
      if (name === 'child_process') return { spawn: () => { throw new Error('Unexpected subprocess') } }
      if (name === '../settings') return { getSettings: () => ({ sshProfiles: [] }) }
      if (name === '../remoteFs') return {}
      if (name.startsWith('.')) throw new Error(`Unexpected dependency ${name}`)
      return require(name)
    }
  })
  api = module.exports
  api.events = []
  api.attempts = attempts
  api.id = `missing-session-${++nextId}`
  const viewer = Object.assign(new EventEmitter(), {
    id: nextId, isDestroyed: () => false, send: (_channel, event) => api.events.push(event)
  })
  api.create = async (resumeSessionId, provider = 'claude') => {
    assert.equal(api.createAgentSession({ id: api.id, provider, source: 'ssh', resumeSessionId, cwd,
      ssh: { host: 'fake.invalid', user: 'test' }, permissionMode: 'ask' }, viewer).ok, true)
    api.session = api.missingCheck.sessions.get(api.id)
    await until(() => !api.session.remoteRestoring, 'remote restoration must finish')
    return api.session
  }
  api.turn = async (text = '검토를 시작해 주세요') => {
    assert.equal(api.sendAgentMessage(api.id, { text }).ok, true)
    await until(() => !api.session.running, `turn must finish: ${JSON.stringify(api.events.slice(-5))}`)
  }
  api.errors = () => api.events.filter((event) => event.type === 'error')
  return api
}

function missing(proc) {
  proc.stderr.emit('data', Buffer.from(missingMessage))
  proc.finish(1)
}
function structuredMissing(proc, newline = false, duplicateStderr = true) {
  proc.json({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [missingMessage] }, newline)
  if (duplicateStderr) proc.stderr.emit('data', Buffer.from(missingMessage))
  proc.finish(1)
}
function success(proc) {
  proc.json({ type: 'system', subtype: 'init', session_id: freshId })
  proc.json({ type: 'assistant', uuid: 'answer', message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: '검토했습니다.' }] } })
  proc.json({ type: 'result', subtype: 'success', result: '검토했습니다.', usage: {} })
  proc.finish()
}
function assertRecovered(api, start = 0) {
  const attempts = api.attempts.slice(start)
  assert.equal(attempts.length, 2, 'missing fresh conversation retries exactly once')
  assert.equal(attempts[1].options.identity.resumeSessionId, undefined)
  assert.equal(attempts[1].options.identity.freshSession, true, 'retry must bypass the saved tab mapping')
  assert.equal(attempts[1].options.metadata, attempts[0].options.metadata, 'retry retains original turn identity and metadata')
  const prompts = attempts.map((attempt) => attempt.inputs.filter((input) => input.type === 'user'))
  assert.equal(prompts[0].length, 1)
  assert.equal(prompts[1].length, 1)
  assert.deepEqual(prompts[1], prompts[0], 'retry sends the same prompt exactly once')
  assert.equal(api.session.resumeSessionId, freshId)
  assert.equal(api.errors().length, 0, 'recovered initialization error never reaches the user')
  assert.equal(api.session.lastStatus, 'idle')
}

const blank = freshApp([missing, success])
await blank.create()
assert.equal(blank.session.claudeFreshConversation, true, 'creation records fresh-session provenance')
await blank.turn()
assert.equal(blank.attempts[0].options.identity.resumeSessionId, undefined, 'saved wrapper identity is implicit')
assertRecovered(blank)
assert.equal(blank.events.filter((event) => event.type === 'message:user').length, 1, 'recovery does not duplicate the visible user message')

const interrupted = freshApp([
  (proc, api) => {
    proc.json({ type: 'system', subtype: 'init', session_id: missingId })
    api.interruptAgentSession(api.id)
  }, missing, success
])
await interrupted.create()
await interrupted.turn('첫 시작을 중단합니다')
assert.equal(interrupted.session.claudeFreshConversation, true, 'init alone cannot establish a durable conversation')
assert.equal(interrupted.session.resumeSessionId, missingId)
await interrupted.turn('다시 시작합니다')
assertRecovered(interrupted, 1)

const resumed = freshApp([missing])
await resumed.create(missingId)
await resumed.session.usageHydration
assert.equal(resumed.session.tokenUsage.turns, 0, 'fixture has no readable transcript usage')
assert.equal(resumed.session.claudeFreshConversation, false, 'explicit history stays protected without usage data')
await resumed.turn()
assert.equal(resumed.attempts.length, 1)
assert.equal(resumed.session.resumeSessionId, missingId)
assert.equal(resumed.session.lastStatus, 'error')
assert.equal(resumed.errors().length, 1)

for (const message of [
  { type: 'assistant', message: { id: 'prior', role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } },
  { type: 'user', message: { role: 'user', content: [] } },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed', role: 'assistant', content: [] } } },
  { type: 'result', subtype: 'success', result: 'Earlier completed turn', usage: {} }
]) {
  const prior = freshApp([missing])
  await prior.create()
  prior.missingCheck.handleSdkMessage(prior.session, message)
  assert.equal(prior.session.claudeFreshConversation, false, `${message.type} protects existing conversation activity`)
  await prior.turn()
  assert.equal(prior.attempts.length, 1)
  assert.equal(prior.errors().length, 1)
}

const unrelated = freshApp([(proc) => {
  proc.stderr.emit('data', Buffer.from('Network connection failed'))
  proc.finish(1)
}])
await unrelated.create()
await unrelated.turn()
assert.equal(unrelated.attempts.length, 1, 'unrelated errors must not start new conversations')
assert.equal(unrelated.errors().length, 1)

for (const message of [
  { type: 'system', subtype: 'init', session_id: missingId },
  { type: 'assistant', message: { id: 'partial', role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] } }
]) {
  const output = freshApp([(proc) => { proc.json(message); missing(proc) }])
  await output.create()
  await output.turn()
  assert.equal(output.attempts.length, 1, 'output during the failing invocation prevents replaying its prompt')
  assert.equal(output.errors().length, 1)
}

for (const failure of ['process-error', 'signal']) {
  const failed = freshApp([(proc) => {
    proc.stderr.emit('data', Buffer.from(missingMessage))
    if (failure === 'process-error') proc.emit('error', new Error('SSH disconnected'))
    proc.finish(1, failure === 'signal' ? 'SIGTERM' : null)
  }])
  await failed.create()
  await failed.turn()
  assert.equal(failed.attempts.length, 1, `${failure} prevents automatic recovery`)
  assert.equal(failed.errors().length, 1)
}

const failedRetry = freshApp([missing, missing])
await failedRetry.create()
await failedRetry.turn()
assert.equal(failedRetry.attempts.length, 2, 'persistent failure cannot loop')
assert.equal(failedRetry.errors().length, 1)
assert.equal(failedRetry.session.lastStatus, 'error')

for (const action of ['abort', 'detach']) {
  const stopped = freshApp([(proc, api) => {
    proc.stderr.emit('data', Buffer.from(missingMessage))
    if (action === 'abort') api.interruptAgentSession(api.id)
    else {
      api.session.detached = true
      proc.emit('detached')
      proc.finish(1)
    }
  }])
  await stopped.create()
  await stopped.turn()
  assert.equal(stopped.attempts.length, 1, `${action} prevents recovery from sending another prompt`)
}

const restored = freshApp([missing], {
  runId: 'stored-run', sessionId: missingId, running: false, hasTurnInput: true, startedAt: 123,
  metadata: { cwd, userText: 'Earlier remote instruction', permissionMode: 'ask' }
})
await restored.create()
await until(() => !restored.session.running, 'restored failed process must finish')
assert.equal(restored.session.claudeFreshConversation, false, 'restored runs never discard their existing identity')
assert.equal(restored.attempts.length, 1)
assert.equal(restored.attempts[0].options.runId, 'stored-run')
assert.equal(restored.attempts[0].inputs.filter((input) => input.type === 'user').length, 0, 'restoration does not resend historical prompts')
assert.equal(restored.errors().length, 1)

for (const newline of [false, true]) {
  const structured = freshApp([(proc) => structuredMissing(proc, newline, false), success])
  await structured.create()
  await structured.turn()
  assertRecovered(structured)

  const protectedHistory = freshApp([(proc) => structuredMissing(proc, newline)])
  await protectedHistory.create(missingId)
  await protectedHistory.turn()
  assert.equal(protectedHistory.attempts.length, 1)
  assert.equal(protectedHistory.errors().length, 1, 'structured error plus stderr/exit produces one visible error')
  assert.equal(protectedHistory.session.lastStatus, 'error')
}

console.log('Claude missing session: fresh recovery, preserved prompt/history, cancellation, restoration, bounded retry and structured error deduplication passed')
