// Exercise real service control flow without model calls or account access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as projectMcp from '../src/main/agent/projectMcpConfig.ts'
import * as executionLock from '../src/main/agent/agentExecutionLock.ts'
import * as media from '../src/shared/media.ts'

const cwd = await mkdtemp(join(tmpdir(), 'lt-project-runtime-'))
const token = 'synthetic-local-project-token'
const connection = { url: 'http://127.0.0.1:34567/mcp/project-session', headers: { Authorization: `Bearer ${token}` } }
const full = name => `mcp__${projectMcp.PROJECT_MCP}__${name}`
const events = [], calls = [], launches = [], released = [], acquired = new Map()
let revision = 1, deleted = false, failedSetup = false, disposed = false
const remoteSsh = { host: 'project-host', user: 'lawyer', port: 22, identityFile: '/test/key' }
const remoteCwd = '/home/lawyer/.legal-terminal/project-workspaces/project-remote'
const tunnels = []
let failTunnel = false
let remoteRunInfo = null
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter()
  stdin = { destroyed: false, writableEnded: false, write: text => {
    let message
    try { message = JSON.parse(text) } catch { calls.push(['token', text]); return true }
    calls.push(['rpc', message])
    if (message.type === 'control_request') queueMicrotask(() => {
      const response = message.request.subtype === 'mcp_set_servers' ? { errors: failedSetup ? { connection: token } : {} }
        : message.request.subtype === 'mcp_status' ? { mcpServers: [{ name: projectMcp.PROJECT_MCP, status: 'connected' }] } : {}
      this.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response } }) + '\n'))
    })
    if (message.type === 'user') queueMicrotask(() => this.stdin.end())
    if (message.id !== undefined) queueMicrotask(() => {
      const result = message.method === 'config/read' ? { config: { mcp_servers: { unrelated: {} } } }
        : message.method === 'thread/start' || message.method === 'thread/resume' ? { thread: { id: 'native-thread' } } : {}
      this.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result }) + '\n'))
    })
    return true
  }, end: () => { this.stdin.writableEnded = true; queueMicrotask(() => this.emit('close', 0)) } }
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', 0)); return true }
}
class FakeRemoteProcess extends FakeProcess {
  constructor(options) { super(); this.options = options; this.ready = Promise.resolve({}); launches.push({ remote: true, args: [options.command], child: this }) }
  detach() { this.detached = true }
}
const query = ({ prompt, options }) => {
  calls.push(['query', options])
  return {
    initializationResult: async () => (calls.push(['initialize']), {}),
    setMcpServers: async servers => { calls.push(['configure', servers]); return { errors: failedSetup ? { connection: token } : {} } },
    mcpServerStatus: async () => [{ name: projectMcp.PROJECT_MCP, status: 'connected' }],
    getContextUsage: async () => ({}), close() {},
    async *[Symbol.asyncIterator]() {
      const value = await prompt.next()
      if (!value.done) calls.push(['prompt', value.value.message.content])
    }
  }
}
const projectAgent = {
  getProjectWorkspace: async id => {
    if (deleted) throw new Error('프로젝트가 삭제되었습니다.')
    if (id === 'project-remote') return { cwd: remoteCwd, ssh: remoteSsh, profileId: 'remote-profile' }
    assert.equal(id, 'project-1'); return { cwd }
  },
  getProjectAgentContext: async () => `<project-context>revision-${revision}</project-context>`,
  acquireProjectMcp: async (id, projectId, options) => { acquired.set(id, options); return connection },
  releaseProjectMcp: id => { released.push(id); acquired.delete(id) },
  disposeProjectMcp: () => { disposed = true },
  forwardProjectMcp: async (profileId, url, onDisconnect) => {
    assert.equal(profileId, 'remote-profile'); assert.equal(url, connection.url)
    if (failTunnel) throw Error('tunnel rejected')
    const tunnel = { url: url.replace('34567', '45678'), onDisconnect, close() { this.closed = true } }
    tunnels.push(tunnel); return tunnel
  }
}
const require = createRequire(import.meta.url), module = { exports: {} }
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8') + `
refreshAgentAuthStatus = () => {}; prefetchClaudeSlashCommands = () => {};
const restoreProjectCheck = restoreRemoteSession;
restoreRemoteSession = () => {};
maybeGenerateSessionTitle = () => {}; scheduleWorkSummary = () => {}; flushWorkSummary = () => {};
export const check = { sessions, startAgentTurn, prepareProjectContext, startCodexProcess, ensureCodexThread, requestPermission, emit, remoteCodexCommand, runRemoteAgentMessage, startNextQueuedMessage, restoreProjectCheck };
`
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: module.exports, console, process, Buffer, AbortController, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  require(name) {
    if (name === '@anthropic-ai/claude-agent-sdk') return { query }
    if (name === '../projectAgent') return projectAgent
    if (name === './projectMcpConfig') return projectMcp
    if (name === './agentMcp') return managed
    if (name === './agentExecutionLock') return executionLock
    if (name === './remoteAgentTransport') return { RemoteAgentTransport: FakeRemoteProcess, probeRemoteAgentRun: async () => remoteRunInfo }
    if (name === '../../shared/media') return media
    if (name === './agentPrompt') return { currentAgentContext: async () => 'base-context', prependAgentContext: (context, text) => context + '\n' + text }
    if (name === '../jurisupport') return { onAgentMcpAccountChange() {}, agentMcpAccountEpoch: () => 1, getAgentMcpConnection: () => { throw new Error('Project must not request account auth') } }
    if (name === '../sessions') return { rememberSessionMeta: async () => {}, readSessionTokenUsage: async () => null }
    if (name === './agentProgress') return { codexTurnRunStatus: () => 'idle', codexWorkStepStatus: () => 'completed' }
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name === 'child_process') return { spawn: (...args) => { const child = new FakeProcess(); launches.push({ args, child }); return child } }
    return require(name)
  }
})
const api = module.exports, internals = api.check
const viewer = { id: 1, isDestroyed: () => false, once() {}, send: (_channel, event) => events.push(event) }
function session(id, provider = 'claude') {
  assert.equal(api.createAgentSession({ id, cwd, provider, workspaceContext: { kind: 'project', projectId: 'project-1', cwd } }, viewer).ok, true)
  return internals.sessions.get(id)
}
function remoteSession(id, provider = 'claude') {
  assert.equal(api.createAgentSession({ id, cwd: remoteCwd, provider, source: 'ssh', ssh: remoteSsh,
    workspaceContext: { kind: 'project', projectId: 'project-remote', cwd: remoteCwd } }, viewer).ok, true)
  return internals.sessions.get(id)
}
const wait = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), JSON.stringify(events.filter(e => e.type === 'error'))) }
try {
  for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
    assert.equal(projectMcp.projectToolDecision(full('project_context'), mode), 'allow')
    assert.equal(projectMcp.projectToolDecision(full('unknown'), mode), 'deny')
    assert.equal(projectMcp.projectToolDecision(full('project_record_note'), mode), mode === 'bypassPermissions' ? 'allow' : ['plan', 'dontAsk'].includes(mode) ? 'deny' : 'ask')
    const config = projectMcp.codexProjectConfig(connection, mode)
    assert.equal(JSON.stringify(config).includes(token), false)
    assert.equal(config['shell_environment_policy.set'][projectMcp.PROJECT_MCP_ENV], '')
    assert.equal(config[`mcp_servers.${projectMcp.PROJECT_MCP}`].enabled_tools.includes('project_record_note'), !['plan', 'dontAsk'].includes(mode))
  }
  assert.throws(() => projectMcp.projectMcpToken({ ...connection, url: connection.url + '?token=secret' }))
  const s = session('claude-project')
  internals.startAgentTurn(s, { text: 'compare sources' }); await wait(() => !s.running)
  assert.ok(calls.find(c => c[0] === 'prompt')[1].includes('revision-1'))
  assert.ok(calls.find(c => c[0] === 'prompt')[1].includes('base-context'))
  assert.ok(calls.findIndex(c => c[0] === 'configure') < calls.findIndex(c => c[0] === 'prompt'))
  assert.equal(JSON.stringify(calls.find(c => c[0] === 'query')).includes(token), false)
  assert.equal(calls.find(c => c[0] === 'query')[1].strictMcpConfig, undefined, 'project tools coexist with user research MCP configuration')
  revision = 2
  internals.startAgentTurn(s, { text: 'continue' }); await wait(() => !s.running)
  assert.ok(calls.filter(c => c[0] === 'prompt').at(-1)[1].includes('revision-2'), 'fresh context must be injected every turn')
  assert.equal(api.sendAgentMessage(s.id, { text: 'switch', workspaceContext: { kind: 'project', projectId: 'other', cwd } }).ok, false)
  assert.equal(api.sendAgentMessage(s.id, { text: 'switch', workspaceContext: { kind: 'folder', cwd } }).ok, false)
  assert.equal(api.createAgentSession({ id: s.id, cwd, workspaceContext: { kind: 'folder', cwd } }, viewer).ok, false)
  const wrongHost = remoteSession('wrong-host'); wrongHost.ssh = { ...remoteSsh, host: 'unselected-host' }
  await assert.rejects(internals.prepareProjectContext(wrongHost), /원격 실행 위치/)
  const wrongRemoteCwd = remoteSession('wrong-remote-cwd'); wrongRemoteCwd.cwd = '/unrelated'
  await assert.rejects(internals.prepareProjectContext(wrongRemoteCwd), /원격 실행 위치/)
  const unrelated = session('bad-cwd'); unrelated.cwd = tmpdir()
  internals.startAgentTurn(unrelated, { text: 'fail' }); await wait(() => !unrelated.running)
  assert.ok(events.some(e => e.sessionId === unrelated.id && e.type === 'error' && /작업 폴더/.test(e.message)))
  failedSetup = true
  const failed = session('failed-project'), before = calls.filter(c => c[0] === 'prompt').length
  internals.startAgentTurn(failed, { text: 'never sent' }); await wait(() => !failed.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, before)
  assert.equal(JSON.stringify(events).includes(token), false)
  failedSetup = false

  // Approval is checked at mutation time and uses one shared UI for either provider.
  for (const provider of ['claude', 'codex']) {
    const writing = session('writes-' + provider, provider); writing.running = new AbortController()
    await internals.prepareProjectContext(writing)
    const options = acquired.get(writing.id)
    for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
      writing.permissionMode = mode
      assert.equal(options.canWrite(), !['plan', 'dontAsk'].includes(mode))
      const pending = options.approveWrite({ note: 'saved conclusion' })
      if (['ask', 'acceptEdits'].includes(mode)) {
        assert.equal(writing.pendingPermissions.size, 1)
        writing.pendingPermissions.values().next().value.finish({ behavior: 'allow' }, 'allow')
      }
      assert.equal(await pending, !['plan', 'dontAsk'].includes(mode))
      assert.equal(writing.pendingPermissions.size, 0)
    }
    writing.permissionMode = 'ask'
    const pending = options.approveWrite({ note: 'stale' })
    const approval = writing.pendingPermissions.values().next().value
    writing.permissionMode = 'plan'; approval.finish({ behavior: 'allow' }, 'allow')
    assert.equal(await pending, false, 'mode change after approval must revoke the write')
    writing.permissionMode = 'ask'
    const closing = options.approveWrite({ note: 'closed' })
    api.closeAgentSession(writing.id)
    assert.equal(await closing, false)
    assert.equal(options.canWrite(), false)
  }

  const codex = session('codex-project', 'codex'); codex.running = new AbortController()
  await internals.prepareProjectContext(codex)
  await internals.ensureCodexThread(codex)
  assert.equal(launches.at(-1).args[2].env[projectMcp.PROJECT_MCP_ENV], token)
  let started = calls.filter(c => c[0] === 'rpc' && c[1].method === 'thread/start').at(-1)[1]
  assert.equal(JSON.stringify(started).includes(token), false)
  assert.equal(started.params.config['mcp_servers.unrelated.enabled'], undefined, 'project config must preserve unrelated user MCP servers')
  codex.permissionMode = 'plan'
  await internals.ensureCodexThread(codex)
  const resumed = calls.filter(c => c[0] === 'rpc' && c[1].method === 'thread/resume').at(-1)[1]
  assert.equal(resumed.params.config[`mcp_servers.${projectMcp.PROJECT_MCP}`].enabled_tools.includes('project_record_note'), false)
  internals.emit(codex, { type: 'raw', sessionId: codex.id, message: { error: token } })
  assert.equal(JSON.stringify(events).includes(token), false)
  // Remote Claude must finish project MCP bootstrap before any user prompt.
  const remoteClaude = remoteSession('remote-claude')
  let begin = calls.length
  internals.startAgentTurn(remoteClaude, { text: 'read remote project' }); await wait(() => !remoteClaude.running)
  const stages = calls.slice(begin).filter(call => call[0] === 'rpc').map(call => call[1].request?.subtype ?? call[1].type).filter(Boolean)
  assert.deepEqual(stages, ['initialize', 'mcp_set_servers', 'mcp_status', 'user'])
  const remoteLaunch = launches.at(-1)
  assert.equal(remoteLaunch.remote, true)
  assert.equal(remoteLaunch.child.options.metadata.projectId, 'project-remote')
  assert.equal(remoteLaunch.child.options.metadata.clientRequired, true)
  assert.equal(remoteLaunch.args[0].includes('--strict-mcp-config'), false)
  assert.equal(JSON.stringify(remoteLaunch.child.options).includes(token), false)
  assert.equal(remoteClaude.projectMcp.url.includes(':45678/'), true)

  failedSetup = true
  const remoteFailure = remoteSession('remote-failure'); begin = calls.length
  internals.startAgentTurn(remoteFailure, { text: 'must not send' }); await wait(() => !remoteFailure.running)
  assert.equal(calls.slice(begin).some(call => call[0] === 'rpc' && call[1].type === 'user'), false)
  failedSetup = false
  failTunnel = true
  const tunnelFailure = remoteSession('tunnel-failure'); begin = launches.length
  internals.startAgentTurn(tunnelFailure, { text: 'must not launch' }); await wait(() => !tunnelFailure.running)
  assert.equal(launches.length, begin)
  failTunnel = false

  const remoteCodex = remoteSession('remote-codex', 'codex'); remoteCodex.running = new AbortController()
  await internals.prepareProjectContext(remoteCodex)
  assert.ok(internals.remoteCodexCommand(remoteCodex).includes(`read -r ${projectMcp.PROJECT_MCP_ENV}`))
  assert.equal(internals.remoteCodexCommand(remoteCodex).includes(token), false)
  begin = calls.length
  await internals.ensureCodexThread(remoteCodex)
  assert.ok(calls.slice(begin).some(call => call[0] === 'token' && call[1] === token + '\n'))
  const remoteStart = calls.slice(begin).find(call => call[0] === 'rpc' && call[1].method === 'thread/start')[1]
  assert.equal(remoteStart.params.config[`mcp_servers.${projectMcp.PROJECT_MCP}`].url.includes(':45678/'), true)
  assert.equal(JSON.stringify(remoteStart).includes(token), false)
  const proc = remoteCodex.codexProcess
  const tunnel = remoteCodex.projectTunnel
  api.closeAgentSession(remoteCodex.id)
  assert.equal(remoteCodex.running.signal.aborted, true)
  assert.equal(proc.killed, true, 'project close stops the CLI before revoking its tools')
  assert.notEqual(proc.detached, true, 'do not discard a pending remote Stop')
  assert.equal(tunnel.closed, true)

  const disconnected = remoteSession('disconnected'); disconnected.running = new AbortController()
  await internals.prepareProjectContext(disconnected)
  const disconnectedTunnel = tunnels.at(-1)
  disconnected.queue.push({ queueId: 'preserved', input: { text: 'queued work' } })
  disconnectedTunnel.onDisconnect()
  assert.equal(disconnected.running.signal.aborted, true)
  assert.equal(disconnected.projectMcp, undefined)
  disconnected.running = undefined
  internals.startNextQueuedMessage(disconnected)
  assert.equal(disconnected.queue.length, 1, 'do not retry automatically after losing project tools')
  assert.equal(JSON.stringify(events).includes(token), false)
  const recovering = remoteSession('project-reopen', 'codex')
  remoteRunInfo = { sessionId: 'saved-project-thread', running: false, metadata: { cwd: remoteCwd, projectId: 'project-remote', clientRequired: true } }
  begin = launches.length
  internals.restoreProjectCheck(recovering)
  await wait(() => !recovering.remoteRestoring)
  assert.equal(recovering.codexThreadId, 'saved-project-thread', 'resume native history with fresh project tools')
  assert.equal(launches.length, begin, 'never attach an old process using expired project credentials')
  remoteRunInfo.running = true
  internals.restoreProjectCheck(recovering)
  await wait(() => !!recovering.remoteRestoreTimer)
  assert.equal(recovering.remoteRestoring, true, 'do not steal another live project run or start a duplicate')
  api.closeAgentSession(recovering.id)
  remoteRunInfo = null
  deleted = true
  const promptsBeforeDelete = calls.filter(c => c[0] === 'prompt').length
  internals.startAgentTurn(s, { text: 'deleted project' }); await wait(() => !s.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeDelete)
  assert.ok(events.some(e => e.sessionId === s.id && e.type === 'error' && /삭제/.test(e.message)))
  assert.ok(released.includes(s.id))
  api.disposeAgentSessions()
  assert.equal(disposed, true)
  assert.equal(acquired.size, 0)
  console.log('Project runtime: local/remote scope, host/cwd checks, tunnel and bootstrap gates, private Codex token, remote-close/disconnect lifecycle, approvals and deletion passed; no model calls')
} finally { api.disposeAgentSessions(); await rm(cwd, { recursive: true, force: true }) }
