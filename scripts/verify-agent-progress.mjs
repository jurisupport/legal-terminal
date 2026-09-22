import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { codexTurnRunStatus, codexWorkStepStatus } from '../src/main/agent/agentProgress.ts'
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
runInNewContext(ts.transpileModule(`${serviceSource}\nexport const progressCheck = { sessions, handleSdkMessage, handleRemoteJsonLine, currentSessionStatus, startAgentTurn, runRemoteAgentMessage };`, {
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
      return {
        close: () => {},
        getContextUsage: async () => ({}),
        async *[Symbol.asyncIterator]() {
          await input.next()
          void input.next().then(() => { ended = true })
          for (const message of queryMessages) {
            yield message
            await new Promise((resolve) => setImmediate(resolve))
            inputStates.push({ subtype: message.subtype, ended })
          }
        }
      }
    } }
    if (name === './agentPrompt') return { prependAgentContext: (_context, prompt) => prompt }
    if (name === '../jurisupport') return { onAgentMcpAccountChange: () => {} }
    if (name === './agentMcp') return { managedToolName: () => undefined }
    if (name === '../sshOptions') return { buildSshArgs: () => [] }
    if (name.startsWith('.')) return {}
    return require(name)
  }
})
const { sessions, handleSdkMessage, handleRemoteJsonLine, currentSessionStatus, startAgentTurn, runRemoteAgentMessage } = serviceModule.exports.progressCheck

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

console.log('agent progress: local/SSH lifecycle, heartbeat, background launch, child output, and cross-turn completion ok')
