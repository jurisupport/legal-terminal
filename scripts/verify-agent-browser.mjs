// Provider integration with a browser selected, without real model requests or SSH.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as project from '../src/main/agent/projectMcpConfig.ts'
import * as bridge from '../src/main/browserAgentBridge.ts'
import * as execution from '../src/main/agent/agentExecutionLock.ts'
import * as media from '../src/shared/media.ts'

const browserToken = 'synthetic-browser-token-no-real-secrets'
const browser = { url: 'http://127.0.0.1:34567/mcp', token: browserToken, location: 'local' }
const projectConnection = { url: 'http://127.0.0.1:34568/mcp', headers: { Authorization: 'Bearer synthetic-project-token' } }
const managedConnection = { token: 'synthetic-managed-token', epoch: 1, tools: ['list_tasks', 'get_task', 'update_task'] }
let selected, failBrowser = false
bridge.configureBrowserAgentBridge(async () => selected)
const calls = [], events = [], launches = []
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter()
  stdin = { destroyed: false, writableEnded: false, write: text => {
    calls.push(['stdin', text])
    let message
    try { message = JSON.parse(text) } catch { return true }
    if (message.type === 'control_request') {
      if (message.request.subtype === 'mcp_set_servers') this.servers = message.request.servers
      const response = message.request.subtype === 'mcp_status'
        ? { mcpServers: Object.keys(this.servers).map(name => ({ name, status: name === bridge.BROWSER_MCP && failBrowser ? 'failed' : 'connected' })) }
        : { errors: {} }
      queueMicrotask(() => this.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }) + '\n')))
    } else if (message.type === 'user') {
      calls.push(['remote-prompt', message.message.content])
      queueMicrotask(() => this.emit('close', 0))
    } else if (message.method && message.id !== undefined) {
      const result = message.method === 'config/read' ? { config: { mcp_servers: { research: {}, [bridge.BROWSER_MCP]: {} } } }
        : message.method === 'thread/start' || message.method === 'thread/resume' ? { thread: { id: 'browser-thread' } }
        : message.method === 'mcpServer/tool/call' ? { content: [{ type: 'text', text: 'ready' }] } : {}
      queueMicrotask(() => this.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result }) + '\n')))
    }
    return true
  }, end: () => { this.stdin.writableEnded = true; queueMicrotask(() => this.emit('close', 0)) } }
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', 0)); return true }
}
const query = ({ prompt, options }) => {
  calls.push(['query', options]); let servers
  return {
    initializationResult: async () => ({}),
    setMcpServers: async value => { servers = value; calls.push(['servers', value]); return { errors: {} } },
    mcpServerStatus: async () => Object.keys(servers).map(name => ({ name, status: name === bridge.BROWSER_MCP && failBrowser ? 'failed' : 'connected' })),
    getContextUsage: async () => ({}), close() {},
    async *[Symbol.asyncIterator]() { const value = await prompt.next(); if (!value.done) calls.push(['prompt', value.value.message.content]) }
  }
}
const require = createRequire(import.meta.url), module = { exports: {} }
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8') + `
refreshAgentAuthStatus = () => {}; prefetchClaudeSlashCommands = () => {};
maybeGenerateSessionTitle = () => {}; scheduleWorkSummary = () => {}; flushWorkSummary = () => {};
export const check = { sessions, startAgentTurn, prepareBrowserContext, browserToolDecision, claudeSessionServers,
  codexSessionConfig, ensureCodexThread, stopCodexProcess, startCodexProcess, remoteCodexCommand, remoteClaudeCommand,
  runRemoteAgentMessage, requestPermission, handleRemotePermissionRequest, handleCodexServerRequest, emit, cleanEnv };
`
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: module.exports, console, process, Buffer, AbortController, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
  require(name) {
    if (name === '@anthropic-ai/claude-agent-sdk') return { query }
    if (name === '../browserAgentBridge') return bridge
    if (name === './agentMcp') return managed
    if (name === './projectMcpConfig') return project
    if (name === './agentExecutionLock') return execution
    if (name === '../../shared/media') return media
    if (name === './remoteAgentTransport') return { RemoteAgentTransport: class { constructor(options) { launches.push(options); return new FakeProcess() } } }
    if (name === '../projectAgent') return { releaseProjectMcp() {}, disposeProjectMcp() {} }
    if (name === '../settings') return { getSettings: async () => ({ sshProfiles: [] }) }
    if (name === '../remoteFs') return {}
    if (name === './agentPrompt') return { currentAgentContext: async () => '', prependAgentContext: (context, prompt) => `${context}\n${prompt}` }
    if (name === '../jurisupport') return { onAgentMcpAccountChange() {}, agentMcpAccountEpoch: () => 1, getAgentMcpConnection: async () => managedConnection }
    if (name === '../sessions') return { rememberSessionMeta: async () => {}, readSessionTokenUsage: async () => null }
    if (name === './agentProgress') return { codexTurnRunStatus: () => 'idle', codexWorkStepStatus: () => 'completed' }
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name === 'child_process') return { spawn: (...args) => { launches.push(args); return new FakeProcess() } }
    return require(name)
  }
})
const api = module.exports, check = api.check
const viewer = { id: 1, isDestroyed: () => false, once() {}, send: (_channel, value) => events.push(value) }
function session(id, provider = 'claude') {
  assert.equal(api.createAgentSession({ id, cwd: '/tmp', provider }, viewer).ok, true)
  return check.sessions.get(id)
}
const full = name => `mcp__${bridge.BROWSER_MCP}__${name}`
const wait = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), JSON.stringify(events.filter(e => e.type === 'error'))) }
try {
  const owner = session('owner')
  assert.throws(() => api.getAgentBrowserContext(owner.id, 99), /접근/)
  assert.equal(api.getAgentBrowserContext(owner.id, 1).busy, false)
  assert.equal(api.getAgentBrowserContext(owner.id).cwd, '/tmp')
  owner.running = new AbortController()
  assert.equal(api.getAgentBrowserContext(owner.id, 1).busy, true)
  owner.running = undefined

  for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
    for (const name of ['browser_state', 'browser_navigate', 'browser_read', 'browser_scroll']) assert.equal(check.browserToolDecision(full(name), mode), 'allow')
    for (const name of ['browser_click', 'browser_type', 'browser_key', 'browser_tabs']) assert.equal(check.browserToolDecision(full(name), mode), ['plan', 'dontAsk'].includes(mode) ? 'deny' : mode === 'bypassPermissions' ? 'allow' : 'ask')
    assert.equal(check.browserToolDecision(full('unknown'), mode), 'deny')
  }
  assert.equal(check.browserToolDecision('Read', 'ask'), null)
  selected = browser
  for (const location of ['local', 'remote']) {
    selected = { ...browser, location }
    const s = session(`local-claude-${location}`)
    s.managedMcp = managedConnection
    s.projectMcp = projectConnection
    check.startAgentTurn(s, { text: '사이트 읽어줘' }); await wait(() => !s.running)
    const servers = calls.filter(call => call[0] === 'servers').at(-1)[1]
    assert.deepEqual(Object.keys(servers).sort(), [project.PROJECT_MCP, managed.MANAGED_MCP, bridge.BROWSER_MCP].sort())
    assert.equal(servers[bridge.BROWSER_MCP].headers.Authorization, `Bearer ${browserToken}`)
    assert.equal(servers[bridge.BROWSER_MCP].tools.find(t => t.name === 'browser_click').permission_policy, 'always_ask')
    assert.ok(calls.filter(call => call[0] === 'prompt').at(-1)[1].includes(location === 'local' ? '사용자의 PC' : '원격 서버'))
    assert.equal(JSON.stringify(calls.filter(call => call[0] === 'query').at(-1)).includes(browserToken), false)
    check.emit(s, { type: 'raw', sessionId: s.id, message: { error: browserToken } })
  }
  const general = session('general-browser')
  check.startAgentTurn(general, { text: 'read site' }); await wait(() => !general.running)
  assert.equal(calls.filter(call => call[0] === 'query').at(-1)[1].strictMcpConfig, undefined)
  failBrowser = true
  const before = calls.filter(call => call[0] === 'prompt').length
  check.startAgentTurn(general, { text: 'not delivered' }); await wait(() => !general.running)
  assert.equal(calls.filter(call => call[0] === 'prompt').length, before, 'failed browser bootstrap must block the prompt')
  failBrowser = false
  assert.equal(JSON.stringify(events).includes(browserToken), false)

  const remote = session('remote-claude')
  remote.source = 'ssh'; remote.ssh = { host: 'test', user: 'test' }; remote.browserMcp = browser; remote.managedMcp = managedConnection; remote.running = new AbortController()
  await check.runRemoteAgentMessage(remote, 'remote browser request', remote.running)
  const configured = calls.filter(call => call[0] === 'stdin').map(call => { try { return JSON.parse(call[1]) } catch { return {} } }).findLast(m => m.request?.subtype === 'mcp_set_servers')
  assert.deepEqual(Object.keys(configured.request.servers).sort(), [managed.MANAGED_MCP, bridge.BROWSER_MCP].sort())
  assert.equal(check.remoteClaudeCommand(remote).includes(browserToken), false)
  remote.managedMcp = undefined
  assert.equal(check.remoteClaudeCommand(remote).includes('--strict-mcp-config'), false)
  remote.permissionMode = 'plan'; remote.remoteProcess = new FakeProcess()
  check.handleRemotePermissionRequest(remote, 'write-denied', { tool_name: full('browser_click'), input: { x: 1, y: 2 } })
  assert.equal(JSON.parse(calls.at(-1)[1]).response.response.behavior, 'deny')

  const codex = session('codex-browser', 'codex')
  selected = browser; await check.prepareBrowserContext(codex)
  codex.projectMcp = projectConnection; codex.managedMcp = managedConnection
  const config = check.codexSessionConfig(codex)
  assert.ok(config[`mcp_servers.${project.PROJECT_MCP}`]); assert.ok(config[`mcp_servers.${managed.MANAGED_MCP}`]); assert.ok(config[`mcp_servers.${bridge.BROWSER_MCP}`])
  assert.deepEqual(Object.keys(config['shell_environment_policy.set']).sort(), [project.PROJECT_MCP_ENV, managed.MANAGED_MCP_ENV, bridge.BROWSER_MCP_ENV].sort())
  assert.equal(JSON.stringify(config).includes(browserToken), false)
  assert.equal(config[`mcp_servers.${bridge.BROWSER_MCP}`].tools.browser_click.approval_mode, 'prompt')
  await check.ensureCodexThread(codex)
  const first = codex.codexProcess
  assert.equal(launches.at(-1)[2].env[bridge.BROWSER_MCP_ENV], browserToken)
  selected = { ...browser, url: 'http://127.0.0.1:34569/mcp', token: browserToken + '-new' }
  await check.prepareBrowserContext(codex)
  assert.equal(first.stdin.writableEnded, true); assert.equal(codex.codexThreadReady, false)
  await check.ensureCodexThread(codex)
  assert.equal(launches.at(-1)[2].env[bridge.BROWSER_MCP_ENV], selected.token)
  selected = undefined; await check.prepareBrowserContext(codex)
  assert.equal(check.codexSessionConfig(codex)[`mcp_servers.${bridge.BROWSER_MCP}`].enabled, false)
  const resumed = session('cold-resume', 'codex'); resumed.codexThreadId = 'persisted-thread'
  assert.equal(check.codexSessionConfig(resumed)[`mcp_servers.${bridge.BROWSER_MCP}`].enabled, false)

  codex.source = 'ssh'; codex.ssh = { host: 'test', user: 'test', remoteControl: true }; codex.browserMcp = browser
  const command = check.remoteCodexCommand(codex)
  assert.equal(command.includes(browserToken), false)
  for (const name of [project.PROJECT_MCP_ENV, managed.MANAGED_MCP_ENV, bridge.BROWSER_MCP_ENV]) assert.ok(command.includes(`read -r ${name}`))
  const beforeTokens = calls.length
  check.startCodexProcess(codex)
  assert.deepEqual(calls.slice(beforeTokens).map(call => call[1]), ['synthetic-project-token\n', 'synthetic-managed-token\n', browserToken + '\n'])
  await check.stopCodexProcess(codex)

  const elicitation = { serverName: bridge.BROWSER_MCP, threadId: 'browser-thread', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'browser_click', tool_params: { x: 1, y: 2 } } }
  for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
    const s = session('approval-' + mode, 'codex')
    s.browserMcp = browser; s.permissionMode = mode; s.running = new AbortController(); s.codexThreadId = 'browser-thread'; s.codexProcess = new FakeProcess()
    check.handleCodexServerRequest(s, { id: mode, method: 'mcpServer/elicitation/request', params: elicitation })
    if (['ask', 'acceptEdits'].includes(mode)) {
      assert.equal(s.pendingPermissions.size, 1)
      s.pendingPermissions.get(mode).finish({ behavior: 'allow', updatedInput: { x: 1, y: 2 } }, 'allow')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(JSON.parse(calls.at(-1)[1]).result.action, ['plan', 'dontAsk'].includes(mode) ? 'decline' : 'accept')
    s.browserMcp = undefined
    assert.equal((await check.requestPermission(s, full('browser_read'), {}, { signal: s.running.signal, toolUseID: 'gone' })).behavior, 'deny')
  }
  selected = { ...browser, url: 'https://example.com/mcp' }
  await assert.rejects(check.prepareBrowserContext(owner), /로컬 연결/)
  console.log('browser agent: local/remote Claude merge and setup gate, Codex config/env refresh, SSH token safety, ownership, policy and native approvals passed')
} finally {
  bridge.configureBrowserAgentBridge(undefined)
  for (const s of check.sessions.values()) { s.running = undefined; s.codexProcess = undefined; s.remoteProcess = undefined }
  api.disposeAgentSessions()
}
