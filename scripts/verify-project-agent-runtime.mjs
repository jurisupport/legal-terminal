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
import * as browserBridge from '../src/main/browserAgentBridge.ts'
import * as managed from '../src/main/agent/agentMcp.ts'
import * as projectMcp from '../src/main/agent/projectMcpConfig.ts'
import * as executionLock from '../src/main/agent/agentExecutionLock.ts'
import * as media from '../src/shared/media.ts'

const cwd = await mkdtemp(join(tmpdir(), 'lt-project-runtime-'))
const workspaces = new Map([['project-1', cwd], ['project-2', cwd]])
const token = 'synthetic-local-project-token'
const connection = { url: 'http://127.0.0.1:34567/mcp/project-session', headers: { Authorization: `Bearer ${token}` } }
const full = name => `mcp__${projectMcp.PROJECT_MCP}__${name}`
const events = [], calls = [], launches = [], released = [], acquired = new Map()
let revision = 1, deleted = false, failedSetup = false, disposed = false
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter()
  stdin = { destroyed: false, writableEnded: false, write: text => {
    const message = JSON.parse(text)
    calls.push(['rpc', message])
    if (message.id !== undefined) queueMicrotask(() => {
      const result = message.method === 'config/read' ? { config: { mcp_servers: { unrelated: {} } } }
        : message.method === 'thread/start' || message.method === 'thread/resume' ? { thread: { id: 'native-thread' } } : {}
      this.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result }) + '\n'))
    })
    return true
  }, end: () => { this.stdin.writableEnded = true; queueMicrotask(() => this.emit('close', 0)) } }
  kill() { queueMicrotask(() => this.emit('close', 0)); return true }
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
  getProjectWorkspace: async id => { assert.ok(workspaces.has(id)); if (deleted) throw new Error('프로젝트가 삭제되었습니다.'); return { cwd: workspaces.get(id) } },
  getProjectAgentContext: async () => `<project-context>revision-${revision}</project-context>`,
  acquireProjectMcp: async (id, projectId, options) => { acquired.set(id, options); return connection },
  releaseProjectMcp: id => { released.push(id); acquired.delete(id) },
  disposeProjectMcp: () => { disposed = true }
}
const require = createRequire(import.meta.url), module = { exports: {} }
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8') + `
refreshAgentAuthStatus = () => {}; prefetchClaudeSlashCommands = () => {};
maybeGenerateSessionTitle = () => {}; scheduleWorkSummary = () => {}; flushWorkSummary = () => {};
export const check = { sessions, startAgentTurn, prepareProjectContext, startCodexProcess, ensureCodexThread, requestPermission, emit };
`
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: module.exports, console, process, Buffer, AbortController, URL, URLSearchParams, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
  require(name) {
    if (name === '@anthropic-ai/claude-agent-sdk') return { query }
    if (name === '../projectAgent') return projectAgent
    if (name === '../settings') return { getSettings: async () => ({ sshProfiles: [] }) }
    if (name === '../remoteFs') return { rfsForwardLocalPort: async () => { throw new Error('Local project must not open SSH tunnel') }, rfsRealpath: async () => { throw new Error('Local project must not read remote paths') } }
    if (name === './projectMcpConfig') return projectMcp
    if (name === '../browserAgentBridge') return browserBridge
    if (name === './agentMcp') return managed
    if (name === './agentExecutionLock') return executionLock
    if (name === './remoteAgentTransport') return {}
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
function session(id, provider = 'claude', projectId = 'project-1') {
  const projectCwd = workspaces.get(projectId)
  assert.equal(api.createAgentSession({ id, cwd: projectCwd, provider, workspaceContext: { kind: 'project', projectId, cwd: projectCwd } }, viewer).ok, true)
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
  assert.equal(api.createAgentSession({ id: 'ssh-project', cwd, source: 'ssh', ssh: {}, workspaceContext: { kind: 'project', projectId: 'project-1', cwd } }, viewer).ok, true)
  await assert.rejects(internals.prepareProjectContext(internals.sessions.get('ssh-project')), /작업 폴더가 변경/)
  api.closeAgentSession('ssh-project')
  const unrelated = session('bad-cwd'); unrelated.cwd = tmpdir()
  internals.startAgentTurn(unrelated, { text: 'fail' }); await wait(() => !unrelated.running)
  assert.ok(events.some(e => e.sessionId === unrelated.id && e.type === 'error' && /작업 폴더/.test(e.message)))
  failedSetup = true
  const failed = session('failed-project'), before = calls.filter(c => c[0] === 'prompt').length
  internals.startAgentTurn(failed, { text: 'never sent' }); await wait(() => !failed.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, before)
  assert.equal(JSON.stringify(events).includes(token), false)
  failedSetup = false

  // Folder changes and turn starts exclude one another before either can await.
  let changed = false
  internals.startAgentTurn(s, { text: 'active turn' })
  await assert.rejects(api.withProjectWorkspaceChange('project-1', async () => { changed = true }), /AI 작업이 진행 중/)
  assert.equal(changed, false, 'an active turn must prevent the mutation callback')
  await wait(() => !s.running)
  let finishChange
  const changing = api.withProjectWorkspaceChange('project-1', () => new Promise(resolve => { finishChange = resolve }))
  const promptsBeforeChange = calls.filter(c => c[0] === 'prompt').length
  const userEventsBeforeChange = events.filter(e => e.type === 'message:user').length
  s.authStatus = 'authenticated'
  assert.equal(api.sendAgentMessage(s.id, { text: 'blocked while changing' }).ok, false)
  assert.equal(api.sendAgentMessage(s.id, { text: 'blocked steer', delivery: 'steer' }).ok, false)
  assert.equal(s.queue.length, 0)
  internals.startAgentTurn(s, { text: 'blocked internal start' })
  await assert.rejects(internals.prepareProjectContext(s), /작업 폴더를 변경 중/)
  assert.equal(api.createAgentSession({ id: 'during-change', cwd, workspaceContext: { kind: 'project', projectId: 'project-1', cwd } }, viewer).ok, false)
  await assert.rejects(api.withProjectWorkspaceChange('project-1', async () => { changed = true }), /작업 폴더를 변경 중/)
  assert.equal(changed, false, 'overlapping folder changes must not invoke their callback')
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeChange)
  assert.equal(events.filter(e => e.type === 'message:user').length, userEventsBeforeChange)
  const other = session('other-project', 'claude', 'project-2'); other.authStatus = 'authenticated'
  assert.equal(api.sendAgentMessage(other.id, { text: 'other project continues' }).ok, true)
  await wait(() => !other.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeChange + 1)
  finishChange('saved')
  assert.equal(await changing, 'saved')
  assert.equal(api.sendAgentMessage(s.id, { text: 'after change' }).ok, true)
  await wait(() => !s.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeChange + 2)
  await assert.rejects(api.withProjectWorkspaceChange('project-1', async () => { throw new Error('save failed') }), /save failed/)
  assert.equal(await api.withProjectWorkspaceChange('project-1', async () => 'retried'), 'retried', 'failed saves must release the guard')

  const newCwd = await mkdtemp(join(cwd, 'changed-'))
  await api.withProjectWorkspaceChange('project-1', async () => workspaces.set('project-1', newCwd))
  const promptsBeforeStale = calls.filter(c => c[0] === 'prompt').length
  assert.equal(api.sendAgentMessage(s.id, { text: 'old conversation' }).ok, true)
  await wait(() => !s.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeStale, 'old cwd must never reach the model after a folder change')
  assert.ok(events.some(e => e.sessionId === s.id && e.type === 'error' && /AI 작업을 다시 열어/.test(e.message)))
  assert.equal(internals.sessions.get(s.id), s, 'changing folders preserves existing conversations')
  assert.equal(s.cwd, cwd)
  const reopened = session('changed-workspace'); reopened.authStatus = 'authenticated'
  assert.equal(api.sendAgentMessage(reopened.id, { text: 'new work folder' }).ok, true)
  await wait(() => !reopened.running)
  assert.equal(calls.filter(c => c[0] === 'query').at(-1)[1].cwd, newCwd)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeStale + 1)
  await api.withProjectWorkspaceChange('project-1', async () => workspaces.set('project-1', cwd))

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
        await assert.rejects(api.withProjectWorkspaceChange('project-1', async () => { changed = true }), /AI 작업이 진행 중/)
        assert.equal(changed, false, 'waiting for approval is still an active project turn')
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
  deleted = true
  const promptsBeforeDelete = calls.filter(c => c[0] === 'prompt').length
  internals.startAgentTurn(s, { text: 'deleted project' }); await wait(() => !s.running)
  assert.equal(calls.filter(c => c[0] === 'prompt').length, promptsBeforeDelete)
  assert.ok(events.some(e => e.sessionId === s.id && e.type === 'error' && /삭제/.test(e.message)))
  assert.ok(released.includes(s.id))
  api.disposeAgentSessions()
  assert.equal(disposed, true)
  assert.equal(acquired.size, 0)
  console.log('Project runtime: fresh context, local/cwd/scope guards, folder-change/turn exclusion and stale-session protection, native bootstrap gate, env-only Codex token/mode refresh, approval/abort guards, deletion failure and release passed; no model calls')
} finally { api.disposeAgentSessions(); await rm(cwd, { recursive: true, force: true }) }
