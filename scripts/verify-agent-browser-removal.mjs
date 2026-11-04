import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as project from '../src/main/agent/projectMcpConfig.ts'

// Migration coverage: persisted threads and detached workers can outlive the removed feature.
const require = createRequire(import.meta.url), module = { exports: {} }
const events = [], restores = []
let remoteInfo
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8') + `
refreshAgentAuthStatus = () => {}; prefetchClaudeSlashCommands = () => {};
finishClaudeTasks = () => {}; startNextQueuedMessage = () => {};
runRemoteAgentMessage = async (session, _prompt, controller, info) => recordRestore(session, controller, info);
restoreRemoteCodexMessage = async (session, controller, info) => recordRestore(session, controller, info);
export const check = { sessions, claudeSessionServers, codexSessionConfig, cleanEnv, restoreRemoteSession };
`
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: module.exports, process, Buffer, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  recordRestore: (session, controller, info) => restores.push({ id: session.id, aborted: controller.signal.aborted, runId: info.runId }),
  require(name) {
    if (name === './agentMcp') return managed
    if (name === './projectMcpConfig') return project
    if (name === '../jurisupport') return { onAgentMcpAccountChange() {}, agentMcpAccountEpoch: () => 1 }
    if (name === './remoteAgentTransport') return { probeRemoteAgentRun: async () => remoteInfo }
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name.startsWith('.') || name === '@anthropic-ai/claude-agent-sdk') return {}
    return require(name)
  }
})
const { check } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const fresh = { permissionMode: 'ask' }
assert.deepEqual(plain(check.claudeSessionServers(fresh)), {})
assert.equal(check.codexSessionConfig(fresh), undefined)
const resumed = { ...fresh, codexThreadId: 'old-thread' }
const config = check.codexSessionConfig(resumed)
assert.equal(config['mcp_servers.legal_terminal_browser'].enabled, false)
assert.equal(config['shell_environment_policy.set'].LEGAL_TERMINAL_BROWSER_TOKEN, '')
const connected = {
  ...resumed,
  projectMcp: { url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer synthetic-project-token' } },
  managedMcp: { token: 'synthetic-managed-token', epoch: 1, tools: ['list_tasks', 'get_task'] }
}
assert.deepEqual(Object.keys(check.claudeSessionServers(connected)).sort(), [project.PROJECT_MCP, managed.MANAGED_MCP].sort())
const combined = check.codexSessionConfig(connected)
assert.equal(combined['mcp_servers.legal_terminal_browser'].enabled, false)
assert.ok(combined[`mcp_servers.${project.PROJECT_MCP}`])
assert.ok(combined[`mcp_servers.${managed.MANAGED_MCP}`])
assert.equal(JSON.stringify(combined).includes('synthetic-'), false)
const oldToken = process.env.LEGAL_TERMINAL_BROWSER_TOKEN
try {
  process.env.LEGAL_TERMINAL_BROWSER_TOKEN = 'synthetic-retired-token'
  assert.equal(check.cleanEnv().LEGAL_TERMINAL_BROWSER_TOKEN, undefined)
} finally {
  if (oldToken === undefined) delete process.env.LEGAL_TERMINAL_BROWSER_TOKEN
  else process.env.LEGAL_TERMINAL_BROWSER_TOKEN = oldToken
}
const tick = () => new Promise(resolve => setImmediate(resolve))
for (const provider of ['claude', 'codex']) {
  for (const legacyBrowser of [false, true]) {
    for (const running of [false, true]) {
      const id = `${provider}-${legacyBrowser}-${running}`
      const session = {
        id, provider, source: 'ssh', cwd: '/tmp', ssh: { host: 'fake.invalid', user: 'test' },
        permissionMode: 'ask', queue: [], pendingPermissions: new Map(), pendingDialogs: new Map(),
        dialogs: new Map(), viewers: new Map([[1, { isDestroyed: () => false, send: (_channel, event) => events.push(event) }]])
      }
      check.sessions.set(id, session)
      remoteInfo = { runId: id, provider, running, sessionId: 'old-session', hasTurnInput: true, startedAt: 1,
        metadata: { cwd: '/tmp', ...(legacyBrowser ? { browserFingerprint: 'legacy-fingerprint' } : {}) } }
      check.restoreRemoteSession(session)
      for (let i = 0; (session.remoteRestoring || session.running) && i < 100; i++) await tick()
      assert.equal(session.remoteRestoreTimer, undefined, JSON.stringify(events.filter(event => event.sessionId === id)))
      assert.equal(session.running, undefined, 'new turns must become available after restoration')
      assert.deepEqual(restores.at(-1), { id, runId: id, aborted: legacyBrowser && running })
      assert.equal(events.some(event => event.sessionId === id && event.type === 'error'), legacyBrowser && running)
      assert.ok(events.some(event => event.sessionId === id && event.type === 'session:restored'), 'restore the prior session identity')
    }
  }
}
console.log('Browser removal: fresh/resumed MCP configs, token isolation, and legacy running/completed Claude/Codex restoration pass')
