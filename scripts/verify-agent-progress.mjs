import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { codexTurnRunStatus, codexWorkStepStatus } from '../src/main/agent/agentProgress.ts'
import * as executionLock from '../src/main/agent/agentExecutionLock.ts'
import { activeSubAgentCount, isSubAgentStep } from '../src/renderer/src/agent/subAgentStatus.ts'
import * as values from '../src/renderer/src/agent/values.ts'

for (const status of ['pendingInit', 'running', 'inProgress']) {
  assert.equal(codexWorkStepStatus(status), 'running', `${status} work must keep the progress indicator visible`)
}
for (const status of ['errored', 'notFound', 'failed', 'declined']) {
  assert.equal(codexWorkStepStatus(status), 'error')
}
assert.equal(codexWorkStepStatus('interrupted'), 'cancelled')
assert.equal(codexWorkStepStatus('completed'), 'done')
assert.equal(codexTurnRunStatus('completed', 1), 'working', 'a finished parent turn must not hide active child work')
assert.equal(codexTurnRunStatus('completed', 0), 'done')
assert.equal(codexTurnRunStatus('failed', 1), 'error')
assert.equal(isSubAgentStep({ id: 'codex-agent:agent-1' }), true)
assert.equal(isSubAgentStep({ id: 'claude-tool-1', toolName: 'Task' }), true)
assert.equal(isSubAgentStep({ id: 'shell-1' }), false)
assert.equal(
  activeSubAgentCount([
    {
      processSteps: [
        { id: 'codex-agent:agent-1', status: 'running' },
        { id: 'claude-tool-1', toolName: 'Task', status: 'running' },
        { id: 'codex-agent:agent-2', status: 'done' },
        { id: 'shell-1', status: 'running' }
      ]
    },
    { processSteps: [{ id: 'codex-agent:agent-1', status: 'running' }] }
  ]),
  2,
  'only unique running subagents should appear in the live count'
)

// Run the actual provider handlers and timeline reducer without Electron or network calls.
const require = createRequire(import.meta.url)
const serviceSource = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const serviceModule = { exports: {} }
let queryMessages = []
let inputStates = []
let remoteProcess
let queryFailure
let onQueryMessage
const queryPrompts = []
runInNewContext(ts.transpileModule(`${serviceSource}\nexport const progressCheck = { sessions, handleSdkMessage, handleRemoteJsonLine, currentSessionStatus, startAgentTurn, runRemoteAgentMessage, handleCodexNotification, handleCodexJsonLine, runCodexAgentMessage, startCodexProcess, ensureCodexInitialized, ensureCodexThread };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: serviceModule.exports, process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  require: (name) => {
    if (name === 'child_process') return { spawn: () => {
      if (!remoteProcess) throw new Error('Unexpected subprocess')
      return remoteProcess
    } }
    if (name === '@anthropic-ai/claude-agent-sdk') return { query: ({ prompt }) => {
      assert.notEqual(typeof prompt, 'string', 'single-turn SDK input closes before background results arrive')
      const input = prompt[Symbol.asyncIterator]()
      let ended = false
      const failure = queryFailure
      return {
        close: () => {},
        getContextUsage: async () => ({}),
        async *[Symbol.asyncIterator]() {
          queryPrompts.push((await input.next()).value.message.content)
          void input.next().then(() => { ended = true })
          for (const message of queryMessages) {
            onQueryMessage?.(message)
            yield message
            await new Promise((resolve) => setImmediate(resolve))
            inputStates.push({ subtype: message.subtype, ended })
          }
          if (failure) throw failure
        }
      }
    } }
    if (name === './agentPrompt') return { prependAgentContext: (_context, prompt) => prompt }
    if (name === '../jurisupport') return { onAgentMcpAccountChange: () => {} }
    if (name === './agentMcp') return { managedToolName: () => undefined }
    if (name === './agentProgress') return { codexTurnRunStatus, codexWorkStepStatus }
    if (name === './agentExecutionLock') return executionLock
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name.startsWith('.')) return {}
    return require(name)
  }
})
const { sessions, handleSdkMessage, handleRemoteJsonLine, currentSessionStatus, startAgentTurn, runRemoteAgentMessage, handleCodexNotification, handleCodexJsonLine, runCodexAgentMessage } = serviceModule.exports.progressCheck

const panelSource = readFileSync(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const panelAst = ts.createSourceFile('AgentPanel.tsx', panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const reducerNames = new Set(['upsertItem', 'stepSummary', 'processGroupId', 'mergeProcessStep', 'upsertProcessStep', 'reduceTimeline'])
const reducerSource = panelAst.statements.filter((node) =>
  reducerNames.has(node.name?.text) || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => reducerNames.has(declaration.name.getText(panelAst))))
).map((node) => node.getText(panelAst)).join('\n')
const reduceTimeline = runInNewContext(ts.transpileModule(`${reducerSource}\nreduceTimeline`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, values)

for (const remote of [false, true]) {
  let items = [{ id: 'question-1', kind: 'user' }]
  const events = []
  const session = {
    id: 'test', provider: 'claude', pendingPermissions: new Map(), pendingDialogs: new Map(),
    startedTools: new Set(), assistantMessages: new Set(), assistantText: new Map(), assistantStreamed: new Set(),
    viewers: new Map([[1, {
      isDestroyed: () => false,
      send: (_channel, event) => {
        events.push(event)
        if (!event.type.startsWith('diff:')) items = reduceTimeline(items, event, 'Claude')
      }
    }]])
  }
  const send = (message) => remote ? handleRemoteJsonLine(session, JSON.stringify(message)) : handleSdkMessage(session, message)
  const taskEvent = (subtype, extra = {}) => send({ type: 'system', subtype, task_id: 'agent-1', ...extra })
  const step = (id = 'agent-tool') => items.flatMap((item) => item.processSteps ?? []).find((item) => item.id === id)
  const toolResult = (result = {}) => send({
    type: 'user', parent_tool_use_id: null, tool_use_result: result,
    message: { content: [{ type: 'tool_result', tool_use_id: 'agent-tool', content: 'launched' }] }
  })

  send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'agent-tool', name: 'Agent', input: {} } } })
  send({ type: 'tool_progress', tool_use_id: 'agent-tool', tool_name: 'Agent', elapsed_time_seconds: 12 })
  assert.equal(activeSubAgentCount(items), 1, 'heartbeat must not replace running status with elapsed seconds')
  assert.equal(step().elapsedMs, 12000)
  taskEvent('task_started', { tool_use_id: 'agent-tool', task_type: 'local_agent', description: '판례 확인' })
  toolResult({ status: 'async_launched', agentId: 'agent-1', isAsync: true })
  assert.equal(step().status, 'running', 'a returned launch tool is still a running agent')
  assert.equal(currentSessionStatus(session), 'working')
  send({ type: 'result', subtype: 'success' })
  assert.equal(events.filter((event) => event.type === 'status').at(-1).status, 'working', 'parent result must not finish child work')

  send({ type: 'assistant', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'text', text: '일 시작하겠습니다' }] } })
  assert.equal(step().text, '일 시작하겠습니다')
  assert.equal(items.some((item) => item.kind === 'assistant'), false, 'child acknowledgment must not become the parent answer')
  send({ type: 'assistant', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'tool_use', id: 'child-edit', name: 'Edit', input: { file_path: '/tmp/check.md', old_string: 'old', new_string: 'new' } }] } })
  assert.equal(step('child-edit').status, 'running', 'nested tool activity must remain visible')
  assert.equal(events.some((event) => event.type === 'diff:proposed'), true, 'nested edits must still produce a diff')
  send({ type: 'user', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'child-edit', content: 'ok' }] } })
  assert.equal(step('child-edit').status, 'done')
  items.push({ id: 'question-2', kind: 'user' })
  taskEvent('task_progress', { description: '자료 검토 중', usage: { duration_ms: 24000 } })
  assert.equal(step().elapsedMs, 24000)
  taskEvent('task_notification', { status: 'completed', summary: '판례 확인 완료' })
  assert.equal(activeSubAgentCount(items), 0, 'completion after another question must update the original agent row')
  assert.equal(items.filter((item) => item.processSteps?.some((entry) => entry.id === 'agent-tool')).length, 1)
  assert.equal(step().text, '판례 확인 완료')
  assert.equal(currentSessionStatus(session), 'idle')
  toolResult({ status: 'async_launched', agentId: 'agent-1' })
  assert.equal(step().status, 'done', 'a late launch result must not reopen a completed task')

  for (const [sdkStatus, expected] of [['failed', 'error'], ['stopped', 'cancelled']]) {
    taskEvent('task_started', { tool_use_id: 'agent-tool', task_type: 'local_agent' })
    taskEvent('task_notification', { status: sdkStatus, summary: sdkStatus })
    assert.equal(step().status, expected)
    assert.equal(activeSubAgentCount(items), 0)
  }
  taskEvent('task_started', { tool_use_id: 'agent-tool', task_type: 'local_agent', is_backgrounded: false })
  taskEvent('task_updated', { patch: { is_backgrounded: true } })
  toolResult()
  assert.equal(step().status, 'running', 'backgrounding a foreground task must preserve tracking')
  taskEvent('task_updated', { patch: { status: 'killed' } })
  assert.equal(step().status, 'cancelled')
  taskEvent('task_started', { tool_use_id: 'agent-tool', task_type: 'local_agent', is_backgrounded: false })
  toolResult({ status: 'completed' })
  assert.equal(step().status, 'done', 'foreground tool results must complete normally')

  send({ type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash' })
  assert.equal(activeSubAgentCount(items), 0, 'background shell work must not be counted as an agent')
  send({ type: 'system', subtype: 'task_notification', task_id: 'bash-1', status: 'completed' })
  send({ type: 'system', subtype: 'task_started', task_id: 'no-tool-id', task_type: 'remote_agent' })
  assert.equal(activeSubAgentCount(items), 1, 'task events without tool IDs must still be tracked')
  send({ type: 'system', subtype: 'task_notification', task_id: 'no-tool-id', status: 'completed' })
  assert.equal(activeSubAgentCount(items), 0)
}

const endedEvents = []
const endedSession = {
  id: 'ended', provider: 'claude', source: 'local', cwd: '/tmp', permissionMode: 'dontAsk', queue: [], tokenUsage: {},
  pendingPermissions: new Map(), pendingDialogs: new Map(),
  assistantMessages: new Set(), assistantText: new Map(), assistantStreamed: new Set(), startedTools: new Set(),
  viewers: new Map([[1, { isDestroyed: () => false, send: (_channel, event) => endedEvents.push(event) }]])
}
sessions.set(endedSession.id, endedSession)
queryMessages = [{ type: 'system', subtype: 'task_started', task_id: 'unfinished', task_type: 'local_agent' }]
startAgentTurn(endedSession, { text: 'Track unfinished child' })
for (let i = 0; i < 10 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(endedSession.running, undefined)
assert.equal(endedEvents.some((event) => event.type === 'process:event' && event.status === 'error'), true,
  'a closed event stream must mark unfinished work as unverified instead of leaving it running')
assert.equal(endedEvents.filter((event) => event.type === 'status').at(-1).status, 'error')

endedEvents.length = 0
queryMessages = [{ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'unreported', description: '실행 중' }] }]
startAgentTurn(endedSession, { text: 'Track a snapshot without a start event' })
for (let i = 0; i < 10 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(endedEvents.filter((event) => event.type === 'process:event').at(-1).status, 'error')
assert.equal(endedEvents.filter((event) => event.type === 'status').at(-1).status, 'error')

for (const snapshotsOnly of [false, true]) {
  endedEvents.length = 0
  inputStates = []
  endedSession.titleGenRunning = true
  queryMessages = [
    ...(!snapshotsOnly ? [{ type: 'system', subtype: 'task_started', task_id: 'live', task_type: 'local_agent', is_backgrounded: true }] : []),
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'live', task_type: 'local_agent', description: '검토 중' }] },
    { type: 'result', subtype: 'success' },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ...(!snapshotsOnly ? [{ type: 'system', subtype: 'task_notification', task_id: 'live', status: 'completed' }] : [])
  ]
  startAgentTurn(endedSession, { text: 'Keep child results connected' })
  for (let i = 0; i < 20 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
  clearTimeout(endedSession.workSummaryTimer)
  assert.equal(endedSession.running, undefined)
  assert.equal(inputStates.find((state) => state.subtype === 'success').ended, false, 'parent result must keep SDK input open for background work')
  assert.equal(inputStates.filter((state) => state.subtype === 'background_tasks_changed').at(-1).ended, true,
    'empty replacement snapshot releases SDK input even when a lifecycle bookend was missed')
  assert.equal(endedEvents.some((event) => event.type === 'process:event' && event.status === 'error'), false)
}

const writes = []
let inputEnded = false
remoteProcess = Object.assign(new EventEmitter(), {
  stdout: new EventEmitter(), stderr: new EventEmitter(),
  stdin: Object.assign(new EventEmitter(), {
    write: (line) => { writes.push(JSON.parse(line)); return true },
    end: () => { inputEnded = true }
  })
})
endedSession.ssh = { host: 'test.invalid', user: 'test' }
endedSession.firstUserText = undefined
endedSession.running = new AbortController()
endedSession.claudeTasks = new Map()
const remoteRun = runRemoteAgentMessage(endedSession, 'Track remote work', endedSession.running)
const remoteSend = (message) => remoteProcess.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
remoteSend({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
remoteSend({ type: 'system', subtype: 'task_started', task_id: 'remote', task_type: 'local_agent', is_backgrounded: true })
remoteSend({ type: 'result', subtype: 'success' })
assert.equal(writes.length, 1, 'SSH input must remain open after the parent result while a child runs')
assert.equal(inputEnded, false)
remoteSend({ type: 'system', subtype: 'task_notification', task_id: 'remote', status: 'completed' })
assert.equal(writes.at(-1).request.subtype, 'get_context_usage', 'terminal notification must finalize SSH without requiring another result')
remoteSend({ type: 'control_response', response: { request_id: writes.at(-1).request_id, subtype: 'success', response: {} } })
assert.equal(inputEnded, true)
remoteProcess.emit('close', 0)
await remoteRun

// An empty snapshot must not hide newer task starts, progress, or terminal events.
for (const remote of [false, true]) {
  endedEvents.length = 0
  endedSession.running = undefined
  endedSession.claudeTasks = new Map()
  const send = (message) => remote ? handleRemoteJsonLine(endedSession, JSON.stringify(message)) : handleSdkMessage(endedSession, message)
  const task = (subtype, extra = {}) => send({ type: 'system', subtype, task_id: 'after-empty', ...extra })
  const snapshot = () => send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  snapshot()
  task('task_started', { tool_use_id: 'after-empty-tool', task_type: 'local_agent', is_backgrounded: true })
  assert.equal(currentSessionStatus(endedSession), 'working', 'a new task supersedes the old empty snapshot')
  send({ type: 'result', subtype: 'success' })
  assert.equal(endedEvents.filter((event) => event.type === 'status').at(-1).status, 'working')
  snapshot()
  task('task_progress', { status: 'running' })
  assert.equal(currentSessionStatus(endedSession), 'working', 'latest progress must refresh snapshot membership')
  task('task_notification', { status: 'completed' })
  assert.equal(currentSessionStatus(endedSession), 'idle')
  assert.equal(endedSession.claudeBackgroundTasks.size, 0, 'completion removes snapshot membership')
  task('task_started', { is_backgrounded: false })
  send({ type: 'user', tool_use_result: { status: 'async_launched', agentId: 'after-empty' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'after-empty-tool', content: 'launched' }] } })
  assert.equal(currentSessionStatus(endedSession), 'working', 'a launch result also refreshes snapshot membership')
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'after-empty-tool', is_error: true, content: 'failed' }] } })
  assert.equal(currentSessionStatus(endedSession), 'idle', 'failed tool work removes snapshot membership')
}

// Exercise SDK input lifetime across the exact reported event order.
endedSession.ssh = undefined
endedEvents.length = 0
inputStates = []
queryMessages = [
  { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  { type: 'system', subtype: 'task_started', task_id: 'late', task_type: 'local_agent', is_backgrounded: true },
  { type: 'result', subtype: 'success' },
  { type: 'system', subtype: 'task_notification', task_id: 'late', status: 'completed' }
]
startAgentTurn(endedSession, { text: 'Snapshot followed by a child' })
for (let i = 0; i < 30 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
clearTimeout(endedSession.workSummaryTimer)
assert.equal(endedSession.running, undefined)
assert.equal(inputStates.find((state) => state.subtype === 'success').ended, false)
assert.equal(inputStates.at(-1).ended, true)
assert.equal(endedEvents.some((event) => event.type === 'process:event' && event.status === 'error'), false)

// Each PC process has one user input. Steer cancels it and starts a new process;
// a late result must not consume or report completion of the queued instruction.
queryMessages = [{ type: 'result', subtype: 'success' }]
queryPrompts.length = 0
endedEvents.length = 0
onQueryMessage = () => {
  onQueryMessage = undefined
  assert.equal(serviceModule.exports.sendAgentMessage(endedSession.id, { text: 'Follow-up steer', delivery: 'steer' }).ok, true)
}
startAgentTurn(endedSession, { text: 'Original request' })
for (let i = 0; i < 30 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
clearTimeout(endedSession.workSummaryTimer)
assert.equal(endedSession.running, undefined)
assert.equal(endedSession.queue.length, 0)
assert.equal(queryPrompts.length, 2, 'steer must run once, without replaying the original input')
assert.equal(queryPrompts[0], 'Original request')
assert.match(queryPrompts[1], /Follow-up steer/)
assert.equal(endedEvents.filter((event) => event.type === 'status' && event.status === 'done').length, 1,
  'the cancelled request result must not complete the queued steer')

endedEvents.length = 0
endedSession.source = 'ssh'
endedSession.ssh = { host: 'test.invalid', user: 'test' }
const steerProcesses = Array.from({ length: 2 }, () => {
  const sent = []
  return Object.assign(new EventEmitter(), {
    sent, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: (line) => { sent.push(JSON.parse(line)); return true }, end: () => {} }),
    kill() { this.killed = true }
  })
})
remoteProcess = steerProcesses[0]
startAgentTurn(endedSession, { text: 'Original remote request' })
for (let i = 0; i < 10 && !endedSession.remoteProcess; i++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(serviceModule.exports.sendAgentMessage(endedSession.id, { text: 'Remote follow-up steer', delivery: 'steer' }).ok, true)
remoteSend({ type: 'result', subtype: 'success' })
assert.equal(endedEvents.some((event) => event.type === 'status' && event.status === 'done'), false)
remoteProcess = steerProcesses[1]
steerProcesses[0].emit('close', null, 'SIGTERM')
for (let i = 0; i < 10 && endedSession.remoteProcess !== remoteProcess; i++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(endedSession.queue.length, 0)
assert.equal(steerProcesses[0].sent.filter((message) => message.type === 'user').length, 1)
assert.equal(steerProcesses[1].sent.filter((message) => message.type === 'user').length, 1)
assert.match(steerProcesses[1].sent[0].message.content[0].text, /Remote follow-up steer/)
remoteSend({ type: 'result', subtype: 'success' })
remoteProcess.emit('close', 0)
for (let i = 0; i < 10 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
clearTimeout(endedSession.workSummaryTimer)
assert.equal(endedSession.running, undefined)
assert.equal(endedEvents.filter((event) => event.type === 'status' && event.status === 'done').length, 1)
endedSession.source = 'local'
endedSession.ssh = undefined

// Explicit SDK and CLI transport failures override a previously successful result.
endedEvents.length = 0
queryFailure = new Error('SDK process exited with code 1')
startAgentTurn(endedSession, { text: 'Result followed by SDK failure' })
for (let i = 0; i < 30 && endedSession.running; i++) await new Promise((resolve) => setImmediate(resolve))
clearTimeout(endedSession.workSummaryTimer)
queryFailure = undefined
assert.equal(endedEvents.filter((event) => event.type === 'status').at(-1).status, 'error')
assert.equal(endedSession.running, undefined)

for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) {
  endedEvents.length = 0
  remoteProcess = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => {} })
  })
  endedSession.ssh = { host: 'test.invalid', user: 'test' }
  endedSession.running = new AbortController()
  endedSession.claudeTasks = new Map()
  const failedRun = runRemoteAgentMessage(endedSession, 'Result followed by CLI failure', endedSession.running)
  remoteSend({ type: 'result', subtype: 'success' })
  remoteProcess.emit('close', code, signal)
  await failedRun
  clearTimeout(endedSession.workSummaryTimer)
  assert.equal(endedEvents.filter((event) => event.type === 'status').at(-1).status, 'error',
    'abnormal CLI termination must override a previous result')
}
endedSession.running = undefined
endedSession.ssh = undefined

// Codex notifications can share a transport with child threads. Only the matching
// parent turn may complete its waiter, and interruption must wait for that turn.
const codexEvents = []
const requests = []
const codexSession = {
  ...endedSession, id: 'codex-check', provider: 'codex', source: 'local', ssh: undefined,
  codexThreadId: 'parent', codexActiveWork: new Set(), claudeTasks: new Map(),
  codexExecutionProtected: true, codexThreadReady: true,
  codexProcess: { stdin: { write: (line) => requests.push(JSON.parse(line)) } },
  viewers: new Map([[1, { isDestroyed: () => false, send: (_channel, event) => codexEvents.push(event) }]])
}
const notify = (method, params) => handleCodexNotification(codexSession, { method, params })
notify('thread/started', { thread: { id: 'child' } })
assert.equal(codexSession.codexThreadId, 'parent', 'a child thread notification must not replace the parent identity')
codexSession.running = new AbortController()
const codexRun = runCodexAgentMessage(codexSession, 'test', codexSession.running)
await new Promise((resolve) => setImmediate(resolve))
notify('turn/started', { threadId: 'parent', turn: { id: 'turn-1' } })
const startRequest = requests.find((request) => request.method === 'turn/start')
handleCodexJsonLine(codexSession, JSON.stringify({ id: startRequest.id, result: { turn: { id: 'turn-1' } } }))
await new Promise((resolve) => setImmediate(resolve))
notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } })
assert.equal(codexSession.codexTurnWaiter?.turnId, 'turn-1')
codexSession.running.abort()
const interruptRequest = requests.find((request) => request.method === 'turn/interrupt')
assert.deepEqual(interruptRequest.params, { threadId: 'parent', turnId: 'turn-1' })
assert.ok(codexSession.codexTurnWaiter, 'do not start the next turn before the interrupted turn ends')
notify('turn/completed', { threadId: 'parent', turn: { id: 'turn-1', status: 'interrupted' } })
await codexRun
for (const command of ['/compact', '/review']) {
  codexSession.running = new AbortController()
  const run = runCodexAgentMessage(codexSession, command, codexSession.running, command)
  await new Promise((resolve) => setImmediate(resolve))
  const request = requests.at(-1)
  assert.equal(request.method, command === '/compact' ? 'thread/compact/start' : 'review/start')
  const turnId = `slash-${command}`
  notify('turn/started', { threadId: 'parent', turn: { id: turnId } })
  handleCodexJsonLine(codexSession, JSON.stringify({ id: request.id, result: command === '/compact' ? {} : { turn: { id: turnId } } }))
  notify('turn/completed', { threadId: 'parent', turn: { id: turnId, status: 'completed' } })
  await run
}
let nextResolved = false
codexSession.codexTurnWaiter = { turnId: 'turn-2', resolve: () => { nextResolved = true; codexSession.codexTurnWaiter = undefined } }
notify('turn/completed', { threadId: 'parent', turn: { id: 'turn-1', status: 'completed' } })
assert.equal(nextResolved, false, 'a delayed completion must not end the next turn')
assert.equal(codexSession.codexTurnWaiter.turnId, 'turn-2')
notify('item/started', { threadId: 'parent', turnId: 'turn-1', item: { id: 'stale', type: 'commandExecution' } })
assert.equal(codexSession.codexActiveWork.size, 0, 'late tool starts must not reopen the old turn')
notify('item/started', { threadId: 'parent', turnId: 'turn-2', item: { id: 'unfinished-call', type: 'dynamicToolCall', tool: 'lookup' } })
codexSession.codexActiveWork.add('agent:live-child')
notify('turn/completed', { threadId: 'parent', turn: { id: 'turn-2', status: 'completed', items: [] } })
assert.equal(nextResolved, false, 'running children keep the execution lock after the parent turn completes')
assert.deepEqual([...codexSession.codexActiveWork], ['agent:live-child'], 'only independently running children survive turn completion')
assert.equal(codexEvents.filter((event) => event.type === 'status').at(-1).status, 'working')
notify('item/completed', { threadId: 'parent', turnId: 'turn-2', item: {
  id: 'child-completion', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
  agentsStates: { 'live-child': { status: 'completed' } }
} })
assert.equal(codexEvents.filter((event) => event.type === 'status').at(-1).status, 'done', 'child completion before wrapper cleanup must end the spinner')
assert.equal(nextResolved, true, 'last child completion releases the turn waiter')
codexSession.running = undefined
for (const kind of ['completed', 'interrupted']) {
  notify('item/completed', { threadId: 'parent', turnId: 'turn-2', item: {
    id: `activity-${kind}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: 'activity-child'
  } })
  assert.equal(currentSessionStatus(codexSession), 'working')
  notify('item/completed', { threadId: 'parent', turnId: 'turn-2', item: {
    id: `activity-${kind}-end`, type: 'subAgentActivity', kind, agentThreadId: 'activity-child'
  } })
  assert.equal(currentSessionStatus(codexSession), 'idle', `${kind} child activity must release the running flag`)
}

// Each replacement transport must initialize anew; callbacks from the disposed
// process cannot clear the new transport or its pending turn.
const freshProcess = () => Object.assign(new EventEmitter(), {
  stdout: new EventEmitter(), stderr: new EventEmitter(),
  stdin: { write: (line) => requests.push(JSON.parse(line)) }
})
codexSession.codexProcess = undefined
codexSession.codexInitialized = true
remoteProcess = freshProcess()
serviceModule.exports.progressCheck.startCodexProcess(codexSession)
const previousProcess = remoteProcess
assert.equal(codexSession.codexInitialized, false)
codexSession.codexProcess = undefined
remoteProcess = freshProcess()
serviceModule.exports.progressCheck.startCodexProcess(codexSession)
const initialized = serviceModule.exports.progressCheck.ensureCodexInitialized(codexSession)
const initializeRequest = requests.at(-1)
assert.equal(initializeRequest.method, 'initialize')
handleCodexJsonLine(codexSession, JSON.stringify({ id: initializeRequest.id, result: {} }))
await initialized
assert.equal(requests.at(-1).method, 'initialized')
previousProcess.emit('close', 0)
assert.equal(codexSession.codexInitialized, true, 'old close events must not reset the new connection')
assert.equal(codexSession.codexProcess, remoteProcess)
codexSession.codexActiveWork.add('agent:orphaned')
remoteProcess.emit('close', 1)
assert.equal(currentSessionStatus(codexSession), 'idle', 'lost transports must not leave orphaned work running')
assert.equal(codexEvents.filter((event) => event.type === 'status').at(-1).status, 'error')

// A completed/aborted turn may finish cleanup after another transport appears.
// Its finally block must close only the process captured by that turn.
const raceProcess = (autoClose = false) => {
  const proc = freshProcess()
  proc.endCalls = 0
  proc.stdin.end = () => {
    proc.endCalls++
    proc.stdin.writableEnded = true
    if (autoClose) queueMicrotask(() => { proc.exitCode = 0; proc.emit('close', 0) })
  }
  return proc
}
const owned = raceProcess(true)
const newer = raceProcess(true)
const racingSession = {
  ...codexSession, id: 'execution-owner-race', running: undefined, codexProcess: owned,
  codexThreadReady: true, codexExecutionProtected: true, codexActiveWork: new Set(), codexPending: new Map(), queue: []
}
sessions.set(racingSession.id, racingSession)
startAgentTurn(racingSession, { text: 'finish old turn' })
for (let i = 0; i < 10 && !racingSession.codexTurnWaiter; i++) await new Promise((resolve) => setImmediate(resolve))
const ownRequest = requests.at(-1)
assert.equal(ownRequest.method, 'turn/start')
handleCodexJsonLine(racingSession, JSON.stringify({ id: ownRequest.id, result: { turn: { id: 'old-owned-turn' } } }))
handleCodexNotification(racingSession, { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'old-owned-turn' } } })
handleCodexNotification(racingSession, { method: 'turn/completed', params: { threadId: 'parent', turn: { id: 'old-owned-turn', status: 'completed' } } })
racingSession.codexProcess = newer
const newerTurn = new AbortController()
racingSession.running = newerTurn
await new Promise((resolve) => setImmediate(resolve))
assert.equal(owned.endCalls, 1, 'the previous turn must close its own process')
assert.equal(newer.endCalls, 0, 'old finally must never close the replacement process')
assert.equal(racingSession.running, newerTurn, 'old finally must not clear the replacement turn')

// A model lookup can replace an unprotected process while its close is awaited.
// Re-check after every await and acquire a protected process before resuming.
const firstUnprotected = raceProcess()
const secondUnprotected = raceProcess()
const protectedProcess = raceProcess(true)
racingSession.codexProcess = firstUnprotected
racingSession.codexExecutionProtected = false
racingSession.codexThreadReady = false
racingSession.running = undefined
const execution = {}
const protectedThread = serviceModule.exports.progressCheck.ensureCodexThread(racingSession, true, execution)
assert.equal(firstUnprotected.endCalls, 1)
racingSession.codexProcess = secondUnprotected
firstUnprotected.emit('close', 0)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(secondUnprotected.endCalls, 1, 'replacement unprotected process must also be stopped')
racingSession.codexProcess = undefined
remoteProcess = protectedProcess
secondUnprotected.emit('close', 0)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(racingSession.codexExecutionProtected, true)
assert.equal(execution.process, protectedProcess)
const protectedInitialize = requests.at(-1)
assert.equal(protectedInitialize.method, 'initialize')
handleCodexJsonLine(racingSession, JSON.stringify({ id: protectedInitialize.id, result: {} }))
await new Promise((resolve) => setImmediate(resolve))
const protectedResume = requests.at(-1)
assert.equal(protectedResume.method, 'thread/resume')
handleCodexJsonLine(racingSession, JSON.stringify({ id: protectedResume.id, result: { thread: { id: 'parent' } } }))
assert.equal(await protectedThread, 'parent')
protectedProcess.stdin.end()
await new Promise((resolve) => setImmediate(resolve))
clearTimeout(racingSession.workSummaryTimer)
console.log('Codex process ownership: late turn cleanup preserves new execution, model lookup replacement cannot bypass protection')

console.log('agent progress: local/SSH lifecycle, snapshot/steer/failure completion, Codex turn isolation/interruption, and execution process ownership ok')
