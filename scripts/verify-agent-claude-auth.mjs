// No account access: exercise the actual auth handlers with synthetic CLI processes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const service = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
function handler(name) {
  const source = service.match(new RegExp(`(?:export )?function ${name}\\([^]*?\\n}`))?.[0]
  assert.ok(source, `Missing handler: ${name}`)
  return source.replace(/^export /, '')
}
const events = [], launches = [], turns = []
const sessions = new Map()
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = new EventEmitter()
  kill() { this.emit('close', null) }
}
const processInfo = { platform: 'win32', env: {} }
const bundled = 'C:\\Program Files\\Legal Terminal\\claude.exe'
const context = vm.createContext({
  process: processInfo, Buffer, queueMicrotask, sessions,
  spawn: (...args) => { const child = new FakeProcess(); launches.push({ args, child }); return child },
  localClaudeAuthExecutable: () => bundled,
  cleanEnv: () => ({}), cleanProcessText: text => text,
  emit: (_session, event) => events.push(event),
  sshErrorMessage: error => error.message,
  asRecord: value => value && typeof value === 'object' ? value : undefined,
  stringValue: value => typeof value === 'string' ? value : undefined,
  sshBin: 'ssh', sshArgs: () => [], remoteClaudeAuthStatusCommand: () => 'remote auth status',
  remoteClaudeAuthCommand: () => 'remote auth login', stopClaudeAuthCallbackForward() {},
  emitAuthOutput() {}, emitCurrentSessionStatus() {},
  handleAssistantMessage() {}, handleResultMessage() {}, emitProcessEvent() {},
  rememberClaudeUsageSummary() {}, accumulateResultUsage() {}, hasRunningClaudeTasks: () => false,
  maybeGenerateSessionTitle() {}, scheduleWorkSummary() {},
  projectSessionError() {}, isEmptyAgentInput: input => !input.text,
  startAgentTurn: (session, input) => turns.push({ session, input })
})
const names = ['isAuthFailureOutput', 'loggedInFromAuthStatusOutput', 'emitAuthStatus',
  'refreshAgentAuthStatus', 'startAgentAuthLogin', 'startNextQueuedMessage', 'handleSdkMessage',
  'handleResultMessage', 'sendAgentMessage']
vm.runInContext(ts.transpileModule(names.map(handler).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, context)
const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed'
assert.equal(context.isAuthFailureOutput(expired), true, 'recognize the screenshot error')
assert.equal(context.isAuthFailureOutput('authentication_failed'), true)
assert.equal(context.isAuthFailureOutput('API Error: 429 rate limit exceeded'), false)

for (const platform of ['win32', 'darwin']) {
  processInfo.platform = platform
  const session = { id: platform, provider: 'claude', source: 'local', cwd: '/project workspace', queue: [] }
  sessions.set(session.id, session)
  context.refreshAgentAuthStatus(session)
  assert.equal(session.authStatus, 'checking')
  let launch = launches.at(-1)
  assert.equal(launch.args[0], bundled)
  assert.deepEqual(Array.from(launch.args[1]), ['auth', 'status'])
  assert.equal(launch.args[2].cwd, session.cwd)
  assert.equal(launch.args[2].shell, undefined, 'native binary paths must not be shell-interpreted')
  launch.child.stdout.emit('data', Buffer.from('{"loggedIn":true}'))
  launch.child.emit('close', 0)
  assert.equal(session.authStatus, 'authenticated')

  context.handleSdkMessage(session, { type: 'assistant', error: 'authentication_failed', message: { content: [] } })
  assert.equal(session.authStatus, 'unauthenticated', 'an expired live session must invalidate the old auth status')
  session.authStatus = 'authenticated'
  context.handleSdkMessage(session, { type: 'result', subtype: 'success', is_error: true, result: expired })
  assert.equal(session.authStatus, 'unauthenticated')
  assert.equal(events.at(-1).message, expired, 'show the failure rather than a misleading success subtype')
  assert.equal(session.turnCount, undefined, 'failed results must not count as a completed turn')
  session.authStatus = 'authenticated'
  context.handleSdkMessage(session, { type: 'result', subtype: 'error_during_execution', errors: [expired] })
  assert.equal(session.authStatus, 'unauthenticated')
  session.authStatus = 'authenticated'
  context.handleSdkMessage(session, { type: 'assistant', message: { content: [{ type: 'text', text: expired }] } })
  assert.equal(session.authStatus, 'authenticated', 'ordinary answers about auth must not invalidate login')

  session.authStatus = 'unauthenticated'
  assert.equal(context.sendAgentMessage(session.id, { text: 'retry' }).ok, false, 'reject new requests until re-login')
  session.queue.push({ queueId: 'queued', input: { text: 'next request' } })
  const before = turns.length
  context.startNextQueuedMessage(session)
  assert.equal(session.queue.length, 1, 'keep queued requests until login succeeds')
  assert.equal(turns.length, before)
  assert.equal(context.startAgentAuthLogin(session.id).ok, true)
  launch = launches.at(-1)
  assert.equal(launch.args[0], bundled)
  assert.deepEqual(Array.from(launch.args[1]), ['auth', 'login', '--claudeai'])
  assert.equal(launch.args[2].cwd, session.cwd)
  assert.equal(launch.args[2].shell, undefined)
  assert.equal(context.startAgentAuthLogin(session.id).ok, false, 'do not start a second login')
  launch.child.emit('close', 0)
  const status = launches.at(-1)
  status.child.stdout.emit('data', Buffer.from('{"loggedIn":true}'))
  status.child.emit('close', 0)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(session.authStatus, 'authenticated')
  assert.equal(session.authProcess, undefined)
  assert.equal(session.queue.length, 0)
  assert.equal(turns.length, before + 1, 'resume the queued request exactly once')

  context.refreshAgentAuthStatus(session)
  launches.at(-1).child.stdout.emit('data', Buffer.from('{"loggedIn":false}'))
  launches.at(-1).child.emit('close', 1)
  assert.equal(session.authStatus, 'unauthenticated')
  context.refreshAgentAuthStatus(session)
  launches.at(-1).child.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' }))
  launches.at(-1).child.emit('close', -1)
  assert.equal(session.authStatus, 'unavailable')
}

const remote = { id: 'remote', provider: 'claude', source: 'ssh', ssh: {}, queue: [] }
sessions.set(remote.id, remote)
context.refreshAgentAuthStatus(remote)
assert.equal(launches.at(-1).args[0], 'ssh')
assert.equal(context.startAgentAuthLogin(remote.id).ok, true)
assert.equal(launches.at(-1).args[0], 'ssh', 'remote sessions still authenticate on their own host')
assert.match(panel, /const usesAgentAuth = provider === 'claude' \|\| provider === 'codex'/)

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
const resolver = vm.createContext({ process, createRequire, require, dirname, join,
  CLAUDE_AGENT_SDK_BINARY_BY_PLATFORM: { [process.platform]: binaryName },
  packagedClaudeAgentSdkExecutable: () => undefined })
vm.runInContext(ts.transpileModule(handler('localClaudeAuthExecutable'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, resolver)
assert.equal(resolver.localClaudeAuthExecutable(), join(dirname(sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), binaryName), 'development uses the installed SDK binary')
resolver.packagedClaudeAgentSdkExecutable = () => bundled
assert.equal(resolver.localClaudeAuthExecutable(), bundled, 'installed apps prefer their unpacked SDK binary')
console.log('Claude auth: local Windows/macOS login, expiry events, queue preservation/resume, missing CLI, and SSH routing passed (no account access)')
