// Real service flow with synthetic SSH processes; no model calls or external servers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as browserBridge from '../src/main/browserAgentBridge.ts'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as projectMcp from '../src/main/agent/projectMcpConfig.ts'
import * as executionLock from '../src/main/agent/agentExecutionLock.ts'
import * as media from '../src/shared/media.ts'

const localCwd = await mkdtemp(join(tmpdir(), 'lt-project-remote-runtime-'))
const profile = { id: 'office', host: 'office.test', user: 'lawyer', port: 2222, identityFile: '/keys/office', remoteControl: true }
const nativeCwd = '/projects/case-a'
const events = [], launches = [], tunnels = [], released = [], persisted = [], tokens = [], remotePaths = []
const acquired = new Map()
let forwardFails = false, bootstrapFails = false, healthFails = false, holdTurns = false, missingSession = false, breakAtStatus = false
let exitAtMethod, ignoreCodexEnd = false
let delayedForward, acquireCount = 0
let pausedStage
function suspendNext(stage) {
  let entered, resume
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { resume = resolve })
  pausedStage = { stage, entered, pending }
  return { started, resume }
}
async function pause(stage) {
  if (pausedStage?.stage !== stage) return
  const pending = pausedStage; pausedStage = undefined
  pending.entered()
  await pending.pending
}
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); packets = []; exitCode = null; signalCode = null; killed = false
  constructor(args) { super(); this.args = args; this.provider = args[1].at(-1).includes('codex_bin') ? 'codex' : 'claude'; this.ignoreEnd = this.provider === 'codex' && ignoreCodexEnd }
  stdin = { destroyed: false, writableEnded: false, write: text => {
    let message
    try { message = JSON.parse(text) } catch { this.packets.push({ secretInput: text.trim() }); return true }
    this.packets.push(message)
    queueMicrotask(() => {
      if (this.exitCode !== null) return
      if (message.method && message.method === exitAtMethod) { this.close(255); return }
      if (message.type === 'control_request') {
        const stage = message.request.subtype
        if (stage === 'mcp_status' && breakAtStatus) tunnels.at(-1).alive = false
        const body = stage === 'mcp_status' ? { mcpServers: [{ name: projectMcp.PROJECT_MCP, status: bootstrapFails ? 'failed' : 'connected' }] }
          : stage === 'mcp_set_servers' ? { errors: {} } : {}
        this.reply({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: body } })
      } else if (message.type === 'user') {
        this.reply({ type: 'system', subtype: 'init', session_id: 'native-claude', tools: [], mcp_servers: [] })
        if (!holdTurns) this.reply({ type: 'result', subtype: missingSession ? 'error_during_execution' : 'success', is_error: missingSession,
          result: missingSession ? 'No conversation found with session ID: missing-native' : 'done', session_id: 'native-claude' })
      } else if (message.id !== undefined && message.method) {
        const result = message.method === 'thread/start' || message.method === 'thread/resume' ? { thread: { id: 'native-codex' } }
          : message.method === 'turn/start' ? { turn: { id: 'turn-1' } }
            : message.method === 'mcpServer/tool/call' ? { isError: healthFails, content: [{ type: 'text', text: '{}' }] } : {}
        this.reply({ id: message.id, result })
        if (message.method === 'turn/start' && !holdTurns) setTimeout(() => this.reply({ method: 'turn/completed', params: { threadId: 'native-codex', turn: { id: 'turn-1', status: 'completed' } } }), 0)
      }
    })
    return true
  }, end: () => { this.stdin.writableEnded = true; if (!this.ignoreEnd) this.close(0) } }
  reply(message) { this.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n')) }
  close(code) { queueMicrotask(() => { if (this.exitCode !== null) return; this.exitCode = code; this.emit('close', code, null) }) }
  kill() { this.killed = true; this.close(0); return true }
}
const newTunnel = () => {
  const tunnel = { port: 55000 + tunnels.length, alive: true, closed: false, isAlive() { return this.alive && !this.closed }, close() { this.closed = true; this.alive = false } }
  tunnels.push(tunnel)
  return tunnel
}
const projectAgent = {
  getProjectWorkspace: async id => ({ cwd: id === 'local-project' ? localCwd : `ssh://${profile.id}${nativeCwd}` }),
  getProjectAgentContext: async () => { await pause('context'); return `<project-context>${JSON.stringify({ outputDirectory: nativeCwd })}</project-context>` },
  acquireProjectMcp: async (id, _projectId, options) => {
    await pause('acquire')
    if (options.isActive && !options.isActive()) throw new Error('프로젝트 대화가 닫혔습니다.')
    const token = `synthetic-project-${++acquireCount}`; tokens.push(token); acquired.set(id, options)
    return { url: `http://127.0.0.1:4567/mcp/${id}`, headers: { Authorization: `Bearer ${token}` } }
  },
  releaseProjectMcp: id => { released.push(id); acquired.delete(id) }, disposeProjectMcp() {}
}
const require = createRequire(import.meta.url), module = { exports: {} }
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8') + `
refreshAgentAuthStatus = () => {}; prefetchClaudeSlashCommands = () => {};
maybeGenerateSessionTitle = () => {}; scheduleWorkSummary = () => {}; flushWorkSummary = () => {};
export const check = { sessions, startAgentTurn, prepareProjectContext, handleRemotePermissionRequest };
`
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: module.exports, console, process, Buffer, AbortController, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
  require(name) {
    if (name === '@anthropic-ai/claude-agent-sdk') return { query: () => { throw new Error('Remote project must not launch local Claude') } }
    if (name === '../projectAgent') return projectAgent
    if (name === '../settings') return { getSettings: async () => ({ sshProfiles: [profile] }) }
    if (name === '../remoteFs') return {
      rfsRealpath: async path => { remotePaths.push(path); await pause('validation'); return path.replace('/alias-project', nativeCwd) },
      rfsForwardLocalPort: async (id, port) => {
        assert.equal(id, profile.id); assert.equal(port, 4567)
        if (forwardFails) throw new Error('synthetic tunnel failure')
        if (delayedForward) return delayedForward()
        const tunnel = newTunnel()
        await pause('tunnel')
        return tunnel
      }
    }
    if (name === './projectMcpConfig') return projectMcp
    if (name === '../browserAgentBridge') return browserBridge
    if (name === './agentMcp') return managed
    if (name === './agentExecutionLock') return executionLock
    if (name === './remoteAgentTransport') return { RemoteAgentTransport: class { constructor() { throw new Error('Project must not create durable remote transport') } }, probeRemoteAgentRun: () => { throw new Error('Project must not restore or replay durable runs') } }
    if (name === '../../shared/media') return media
    if (name === './agentPrompt') return { currentAgentContext: async () => 'base-context', prependAgentContext: (context, text) => context + '\n' + text }
    if (name === '../jurisupport') return { onAgentMcpAccountChange() {}, agentMcpAccountEpoch: () => 1, getAgentMcpConnection: () => { throw new Error('Project must not request account auth') } }
    if (name === '../sessions') return { rememberSessionMeta: async (...args) => { persisted.push(args) }, readSessionTokenUsage: async () => null }
    if (name === './agentProgress') return { codexTurnRunStatus: () => 'idle', codexWorkStepStatus: () => 'completed' }
    if (name === '../sshOptions') return { buildSshArgs: () => ['synthetic-ssh-target'] }
    if (name === 'child_process') return { spawn: (...args) => { const child = new FakeProcess(args); launches.push(child); return child } }
    return require(name)
  }
})
const api = module.exports, internals = api.check
const viewer = { id: 1, isDestroyed: () => false, once() {}, send: (_channel, event) => events.push(event) }
function session(id, provider = 'claude', overrides = {}) {
  const options = { id, cwd: nativeCwd, source: 'ssh', ssh: { ...profile }, provider, workspaceContext: { kind: 'project', projectId: 'remote-project', cwd: nativeCwd }, ...overrides }
  assert.equal(api.createAgentSession(options, viewer).ok, true)
  const value = internals.sessions.get(id); value.authStatus = 'authenticated'; return value
}
const wait = async check => { for (let i = 0; i < 1000 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), JSON.stringify(events.filter(e => e.type === 'error'))) }
const run = async s => { assert.equal(api.sendAgentMessage(s.id, { text: 'review project' }).ok, true); await wait(() => !s.running) }
const userPackets = proc => proc.packets.filter(packet => packet.type === 'user' || packet.method === 'turn/start')
try {
  const claude = session('remote-claude')
  await run(claude)
  let child = launches.at(-1)
  assert.deepEqual(child.packets.filter(packet => packet.type === 'control_request' || packet.type === 'user').map(packet => packet.request?.subtype ?? packet.type), ['initialize', 'mcp_set_servers', 'mcp_status', 'user', 'get_context_usage'])
  let server = child.packets.find(packet => packet.request?.subtype === 'mcp_set_servers').request.servers[projectMcp.PROJECT_MCP]
  assert.equal(new URL(server.url).port, String(tunnels.at(-1).port))
  assert.equal(new URL(server.url).pathname, '/mcp/remote-claude')
  assert.ok(server.headers.Authorization.endsWith(tokens.at(-1)))
  assert.ok(JSON.stringify(userPackets(child)[0].message.content).includes(nativeCwd))
  assert.equal(JSON.stringify(userPackets(child)[0].message.content).includes('ssh://'), false)
  assert.ok(child.args[1].at(-1).includes(nativeCwd))
  assert.equal(child.args[1].at(-1).includes('http://'), false)
  assert.equal(claude.remoteRunMetadata, undefined)
  assert.equal(remotePaths.at(-1), `ssh://${profile.id}${nativeCwd}`)
  assert.equal(claude.resumeSessionId, 'native-claude')
  assert.equal(child.args[1].at(-1).includes('--strict-mcp-config'), false, 'project preserves ordinary research MCP servers')
  const oldTunnel = tunnels.at(-1), countBeforeReconnect = acquireCount
  oldTunnel.alive = false
  await run(claude)
  assert.ok(oldTunnel.closed)
  assert.equal(acquireCount, countBeforeReconnect + 1)
  assert.equal(userPackets(launches.at(-1)).length, 1, 'reconnect occurs only for a newly requested turn')
  assert.ok(launches.at(-1).args[1].at(-1).includes('native-claude'), 'remote native conversation resumes')

  for (const [id, overrides] of [
    ['wrong-host', { ssh: { ...profile, host: 'other.test' } }],
    ['wrong-user', { ssh: { ...profile, user: 'other' } }],
    ['wrong-port', { ssh: { ...profile, port: 22 } }],
    ['wrong-key', { ssh: { ...profile, identityFile: '/other-key' } }],
    ['wrong-path', { cwd: '/unrelated' }],
    ['wrong-local', { source: 'local', cwd: localCwd, ssh: undefined }],
    ['remote-for-local', { workspaceContext: { kind: 'project', projectId: 'local-project', cwd: nativeCwd } }]
  ]) {
    const invalid = session(id, 'claude', overrides), before = launches.length
    await run(invalid)
    assert.equal(launches.length, before, `${id} must fail before a remote process starts`)
    assert.equal(acquired.has(invalid.id), false)
    api.closeAgentSession(invalid.id)
  }
  const canonical = session('remote-alias', 'claude', { cwd: '/alias-project' })
  await run(canonical)
  assert.equal(userPackets(launches.at(-1)).length, 1, 'same remote canonical cwd is accepted')
  api.closeAgentSession(canonical.id)

  forwardFails = true
  const noTunnel = session('failed-tunnel'), beforeFailure = launches.length
  await run(noTunnel)
  assert.equal(launches.length, beforeFailure)
  assert.equal(acquired.has(noTunnel.id), false)
  forwardFails = false
  for (const failure of ['bootstrap', 'lost-before-prompt']) {
    bootstrapFails = failure === 'bootstrap'; breakAtStatus = failure === 'lost-before-prompt'
    const broken = session(failure)
    await run(broken)
    assert.equal(userPackets(launches.at(-1)).length, 0)
    assert.ok(tunnels.at(-1).closed)
    assert.equal(acquired.has(broken.id), false)
  }
  bootstrapFails = false; breakAtStatus = false

  const codex = session('remote-codex', 'codex')
  await run(codex)
  child = launches.at(-1)
  assert.equal(child.packets[0].secretInput, tokens.at(-1), 'Codex bearer travels on stdin before JSON-RPC')
  assert.ok(child.args[1].at(-1).includes(`IFS= read -r ${projectMcp.PROJECT_MCP_ENV}`))
  assert.equal(child.args[1].at(-1).includes('daemon bootstrap'), false)
  const started = child.packets.find(packet => packet.method === 'thread/start')
  assert.equal(started.params.cwd, nativeCwd)
  assert.equal(new URL(started.params.config[`mcp_servers.${projectMcp.PROJECT_MCP}`].url).port, String(tunnels.at(-1).port))
  assert.equal(started.params.config['shell_environment_policy.set'][projectMcp.PROJECT_MCP_ENV], '')
  assert.equal(child.packets.find(packet => packet.method === 'turn/start').params.cwd, nativeCwd)
  assert.ok(child.packets.findIndex(packet => packet.method === 'mcpServer/tool/call') < child.packets.findIndex(packet => packet.method === 'turn/start'))
  assert.equal(codex.remoteRunMetadata, undefined)
  assert.equal(codex.resumeSessionId, 'native-codex')
  healthFails = true
  const unhealthy = session('unhealthy-codex', 'codex')
  await run(unhealthy)
  assert.equal(userPackets(launches.at(-1)).length, 0)
  assert.ok(tunnels.at(-1).closed)
  healthFails = false
  for (const method of ['thread/start', 'mcpServer/tool/call', 'turn/start']) {
    exitAtMethod = method
    const disconnected = session(`disconnect-${method}`, 'codex')
    await run(disconnected)
    assert.equal(disconnected.codexPending.size, 0, 'SSH exit rejects pending protocol requests')
    assert.equal(disconnected.codexTurnWaiter, undefined, 'SSH exit releases the pending turn')
    assert.ok(tunnels.at(-1).closed)
  }
  exitAtMethod = undefined
  healthFails = true; ignoreCodexEnd = true
  const stalled = session('stalled-codex', 'codex')
  await run(stalled)
  assert.ok(launches.at(-1).killed, 'failed health check terminates SSH if app-server ignores EOF')
  assert.equal(stalled.codexPending.size, 0)
  assert.ok(tunnels.at(-1).closed)
  healthFails = false; ignoreCodexEnd = false

  holdTurns = true
  const closingCodex = session('close-active-codex', 'codex')
  api.sendAgentMessage(closingCodex.id, { text: 'active remote project' })
  await wait(() => launches.at(-1)?.packets.some(packet => packet.method === 'turn/start'))
  const closingCodexTunnel = tunnels.at(-1)
  api.closeAgentSession(closingCodex.id)
  await wait(() => !closingCodex.running)
  assert.ok(closingCodexTunnel.closed)
  assert.equal(closingCodex.codexTurnWaiter, undefined)
  assert.notEqual(closingCodex.detached, true, 'remote project close never takes the durable detach path')
  const writing = session('remote-writing')
  assert.equal(api.sendAgentMessage(writing.id, { text: 'record approved conclusion' }).ok, true)
  await wait(() => launches.at(-1)?.packets.some(packet => packet.type === 'user'))
  const writeOptions = acquired.get(writing.id), writingChild = launches.at(-1), writingTunnel = tunnels.at(-1)
  assert.equal(writeOptions.canWrite(), true)
  const approving = writeOptions.approveWrite({ note: 'verified' })
  assert.equal(writing.pendingPermissions.size, 1)
  await assert.rejects(api.withProjectWorkspaceChange('remote-project', async () => {}), /AI 작업이 진행 중/)
  writing.pendingPermissions.values().next().value.finish({ behavior: 'allow' }, 'allow')
  assert.equal(await approving, true)
  writing.permissionMode = 'plan'
  internals.handleRemotePermissionRequest(writing, 'write-denied', { tool_name: `mcp__${projectMcp.PROJECT_MCP}__project_record_note`, input: {} })
  assert.equal(writingChild.packets.at(-1).response.response.behavior, 'deny')
  assert.equal(writeOptions.canWrite(), false)
  api.closeAgentSession(writing.id)
  await wait(() => !writing.running)
  assert.ok(writingChild.killed, 'closing project cancels direct remote work instead of detaching')
  assert.ok(writingTunnel.closed)
  assert.equal(writeOptions.canWrite(), false)
  holdTurns = false

  let finishForward
  delayedForward = () => new Promise(resolve => { finishForward = resolve })
  const closing = session('closing-during-tunnel'), beforeClosing = launches.length
  api.sendAgentMessage(closing.id, { text: 'never sent' })
  await wait(() => Boolean(finishForward))
  api.closeAgentSession(closing.id)
  const lateTunnel = newTunnel(); finishForward(lateTunnel)
  await wait(() => !closing.running)
  assert.ok(lateTunnel.closed)
  assert.equal(launches.length, beforeClosing)
  delayedForward = undefined

  // A late preparation from a closed session must not revoke or rebind its replacement's endpoint.
  for (const stage of ['validation', 'context', 'acquire', 'tunnel']) {
    const old = session(`replace-${stage}`)
    const paused = suspendNext(stage)
    const preparation = internals.prepareProjectContext(old).then(() => undefined, error => error)
    await paused.started
    const oldTunnel = stage === 'tunnel' ? tunnels.at(-1) : undefined
    api.closeAgentSession(old.id)
    const replacement = session(old.id)
    await internals.prepareProjectContext(replacement)
    const replacementOptions = acquired.get(old.id), replacementConnection = replacement.projectMcp, replacementTunnel = replacement.projectTunnel
    const releasesBeforeResume = released.filter(id => id === old.id).length
    assert.equal(replacementOptions.isActive(), true, 'dry preparation remains active without a running turn')
    paused.resume()
    assert.match(String(await preparation), /대화가 닫혔습니다/)
    assert.equal(internals.sessions.get(old.id), replacement)
    assert.equal(acquired.get(old.id), replacementOptions, `${stage}: old acquire must not overwrite replacement callbacks`)
    assert.equal(released.filter(id => id === old.id).length, releasesBeforeResume, `${stage}: old cleanup must not revoke replacement endpoint`)
    assert.equal(replacement.projectMcp, replacementConnection)
    assert.equal(replacement.projectTunnel, replacementTunnel)
    assert.equal(replacementTunnel.isAlive(), true)
    assert.equal(old.projectMcp, undefined)
    assert.equal(old.projectTunnel, undefined)
    if (oldTunnel) assert.equal(oldTunnel.closed, true, 'late old tunnel closes without closing the replacement tunnel')
    api.closeAgentSession(replacement.id)
  }

  missingSession = true
  const missing = session('missing-native', 'claude', { resumeSessionId: 'missing-native' }), beforeMissing = launches.length
  await run(missing)
  assert.equal(launches.length, beforeMissing + 1, 'a missing native conversation never silently replays project prompts')
  missingSession = false
  assert.equal(tokens.some(token => JSON.stringify(launches.map(proc => proc.args)).includes(token)), false, 'no credentials in argv or process environment')
  assert.equal(tokens.some(token => JSON.stringify(persisted).includes(token)), false, 'no credentials in persisted session metadata')
  assert.equal(tokens.some(token => JSON.stringify(events).includes(token)), false, 'events redact credentials')
  api.disposeAgentSessions()
  assert.ok(tunnels.every(tunnel => tunnel.closed), 'dispose tears down every project tunnel')
  assert.equal(acquired.size, 0)
  console.log('Remote project runtime: SSH identity/canonical cwd, private tunnel, Claude connected gate/policies, Codex stdin token/health gate, no durable replay, tunnel loss/reacquisition/cleanup, approval and credential redaction passed; no model calls')
} finally { api.disposeAgentSessions(); await rm(localCwd, { recursive: true, force: true }) }
