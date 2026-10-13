import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { cleanUserInstruction } from '../src/main/workLogData.ts'
import * as values from '../src/renderer/src/agent/values.ts'

const readAst = (path) => ts.createSourceFile(path,
  readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const sessions = readAst('../src/main/sessions.ts')
const panel = readAst('../src/renderer/src/agent/AgentPanel.tsx')
const functions = (ast, names) => ast.statements
  .filter((node) => names.includes(node.name?.text) ||
    node.declarationList?.declarations.some((declaration) => names.includes(declaration.name?.text)))
  .map((node) => node.getText(ast.getSourceFile())).join('\n')
const compile = (source, context, result = '') => Function(...Object.keys(context),
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
  (result ? `\nreturn ${result}` : '')
)(...Object.values(context))

const parse = compile(functions(sessions, [
  'parseTranscriptMessages', 'extractTranscriptText', 'clipTranscriptText', 'recordValue'
]), { cleanUserInstruction, MAX_SESSION_HISTORY_MESSAGES: 100, MAX_SESSION_MESSAGE_CHARS: 20000 }, 'parseTranscriptMessages')
const startedAt = Date.parse('2026-10-02T03:00:00.000Z')
const transcript = { sessionId: 'test-session', ...parse([
  { role: 'user', timestamp: startedAt - 10, text: '이전 요청' },
  { role: 'assistant', timestamp: new Date(startedAt - 1).toISOString(), text: '이전 답변' },
  { role: 'user', timestamp: startedAt, text: '현재 요청' },
  { role: 'assistant', timestamp: new Date(startedAt + 1).toISOString(), text: '현재 답변' },
  { role: 'assistant', timestamp: 'invalid', text: '시간 없는 이전 기록' }
].map(({ role, timestamp, text }) => JSON.stringify({
  type: role, timestamp, message: { role, content: text }
})).join('\n'), 'test-session') }
assert.deepEqual(transcript.messages.map((message) => message.timestamp), [
  startedAt - 10, startedAt - 1, startedAt, startedAt + 1, undefined
])
assert.equal(Object.hasOwn(transcript.messages.at(-1), 'timestamp'), false)

const helpers = compile(functions(panel, [
  'transcriptToTimeline', 'historyBeforeRestoredTurn', 'reduceTimeline', 'upsertItem'
]), { ...values, messageQuote: () => undefined, normalizeAgentAttachments: () => [] },
  '({ transcriptToTimeline, historyBeforeRestoredTurn, reduceTimeline })')
const component = panel.statements.find((node) => node.name?.text === 'AgentPanel')
const effect = (marker) => component.body.statements.find((node) =>
  ts.isExpressionStatement(node) && node.getText(panel).startsWith('useEffect(') &&
  node.getText(panel).includes(marker)
).getText(panel)

for (const loadOrder of ['history-first', 'restore-first', 'late-session-id']) {
  const permission = { id: 'permission-1', kind: 'permission', status: 'pending' }
  const process = { id: 'process-1', kind: 'process', processSteps: [{ id: 'step-1', status: 'running' }] }
  let items = [permission, process]
  let emit
  let resolveHistory
  const history = new Promise((resolve) => { resolveHistory = resolve })
  const context = {
    ...values, ...helpers,
    useEffect: (callback) => callback(), window: { lt: { agent: { onEvent: (callback) => { emit = callback } } } },
    eventSessionId: (event) => event.sessionId, id: 'panel-id', agentLabel: 'Claude', provider: 'claude',
    cwd: '/tmp', profileId: undefined, ssh: undefined, onStatus: undefined, workspaceContext: undefined,
    resumeSessionId: loadOrder === 'late-session-id' ? undefined : 'test-session',
    loadedHistoryKeyRef: { current: null },
    historyLoadRef: { current: undefined },
    pendingHistorySendRef: { current: undefined },
    restoredTurnStartedAtRef: { current: undefined }, hasLiveMessagesRef: { current: false },
    transcriptSourceKey: () => 'remote', loadSessionTranscript: () => history,
    invalidateSessionTranscript: () => {}, rememberPrompts: () => {}, setResumedModel: () => {},
    setItems: (update) => { items = update(items) }
  }
  compile(effect('window.lt.agent.onEvent'), context)
  compile(effect('const historyKey ='), context)
  const restore = () => {
    emit({ type: 'session:restored', sessionId: 'panel-id', startedAt })
    const user = { type: 'message:user', sessionId: 'panel-id', messageId: 'remote-user-1', text: '현재 요청' }
    emit(user)
    emit(user)
  }
  if (loadOrder !== 'history-first') restore()
  if (loadOrder === 'late-session-id') {
    context.resumeSessionId = 'test-session'
    compile(effect('const historyKey ='), context)
  }
  resolveHistory(transcript)
  await history
  await Promise.resolve()
  if (loadOrder === 'history-first') restore()
  assert.deepEqual(items.filter((item) => item.id.startsWith('history-')).map((item) => item.text), [
    '이전 요청', '이전 답변', '시간 없는 이전 기록'
  ], `native history must omit the replayed turn: ${loadOrder}`)
  assert.equal(items.filter((item) => item.id === 'remote-user-1').length, 1)
  assert.equal(items.find((item) => item.id === permission.id), permission)
  assert.equal(items.find((item) => item.id === process.id), process)
}

// Persisting a fresh conversation's ID must not reload the turn already on screen.
for (const ssh of [undefined, { host: 'example.invalid', user: 'test' }]) {
  let items = []
  let emit
  let historyLoads = 0
  const firstTurn = { sessionId: 'new-session', messages: [
    { id: 'native-user', role: 'user', text: '첫 질문' },
    { id: 'native-assistant', role: 'assistant', text: '첫 답변' }
  ] }
  const context = {
    ...values, ...helpers,
    useEffect: (callback) => callback(), window: { lt: { agent: { onEvent: (callback) => { emit = callback } } } },
    eventSessionId: (event) => event.sessionId, id: 'new-panel', agentLabel: 'Claude', provider: 'claude',
    cwd: '/tmp', profileId: undefined, ssh, onStatus: undefined, workspaceContext: undefined,
    resumeSessionId: undefined, loadedHistoryKeyRef: { current: null },
    historyLoadRef: { current: undefined },
    pendingHistorySendRef: { current: undefined },
    restoredTurnStartedAtRef: { current: undefined }, hasLiveMessagesRef: { current: false },
    transcriptSourceKey: () => ssh ? 'remote' : 'local',
    loadSessionTranscript: async () => { historyLoads++; return firstTurn },
    invalidateSessionTranscript: () => {}, rememberPrompts: () => {}, setResumedModel: () => {},
    setItems: (update) => { items = update(items) }
  }
  compile(effect('window.lt.agent.onEvent'), context)
  compile(effect('const historyKey ='), context)
  emit({ type: 'message:user', sessionId: 'new-panel', messageId: 'live-user', text: '첫 질문' })
  // App stores the ID from session:init/status:done back into the panel props.
  context.resumeSessionId = firstTurn.sessionId
  compile(effect('const historyKey ='), context)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(items.filter((item) => item.kind === 'user').length, 1,
    `persisting a fresh ${ssh ? 'remote' : 'local'} session must not duplicate its first question`)
  assert.equal(historyLoads, 0, 'live conversations must not fetch their own transcript')
  assert.equal(items.some((item) => item.id.startsWith('history-')), false)
  emit({ type: 'message:user', sessionId: 'new-panel', messageId: 'live-user-2', text: '첫 질문' })
  assert.equal(items.filter((item) => item.kind === 'user').length, 2,
    'a deliberately repeated question is a separate turn')
}

// New turns must wait for the initial snapshot, regardless of the remote server's clock.
for (const [ssh, clockOffset, failHistory, cancelHistory] of [
  [undefined, 0, false],
  [{ host: 'example.invalid', user: 'test' }, -3600000, false],
  [{ host: 'example.invalid', user: 'test' }, 3600000, false],
  [undefined, 0, true],
  [undefined, 0, false, true]
]) {
  let items = []
  let emit
  let resolveHistory
  let rejectHistory
  let cleanupHistory
  let nextHistory
  let resolveNextHistory
  let nextPendingSend
  let sends = 0
  const history = new Promise((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject })
  const context = {
    ...values, ...helpers, startTransition: (callback) => callback(),
    useEffect: (callback) => { cleanupHistory = callback() }, window: { lt: { agent: {
      onEvent: (callback) => { emit = callback },
      send: async () => {
        sends++
        emit({ type: 'message:user', sessionId: 'resumed-panel', messageId: `live-user-${sends}`, text: '반복 질문' })
        emit({ type: 'message:assistant_delta', sessionId: 'resumed-panel', messageId: `live-assistant-${sends}`, text: '반복 답변' })
        return { ok: true }
      }
    } } },
    eventSessionId: (event) => event.sessionId, id: 'resumed-panel', agentLabel: 'Claude', provider: 'claude',
    cwd: '/tmp', profileId: undefined, ssh, onStatus: undefined, workspaceContext: undefined,
    resumeSessionId: 'existing-session', loadedHistoryKeyRef: { current: null },
    restoredTurnStartedAtRef: { current: undefined }, hasLiveMessagesRef: { current: false },
    historyLoadRef: { current: undefined },
    pendingHistorySendRef: { current: undefined },
    transcriptSourceKey: () => ssh ? 'remote' : 'local', loadSessionTranscript: () => history,
    invalidateSessionTranscript: () => {}, rememberPrompts: () => {}, setResumedModel: () => {},
    setItems: (update) => { items = update(items) },
    input: '반복 질문', attachments: [], slashCommandName: () => undefined, sendBlockedReason: '',
    expandSlashInput: (text) => ({ text }), allSlashCommands: [], scrollTimelineToBottom: () => {},
    mode: 'default', setInput: () => {}, setAttachments: () => {}, setMentionState: () => {}, setError: () => {},
    queuesNewInput: false, pendingHandoff: null, quotedMessage: null, onPrepareAttachment: undefined
  }
  compile(effect('window.lt.agent.onEvent'), context)
  compile(effect('const historyKey ='), context)
  const send = compile(functions(component.body, ['send']), context, 'send')
  const pendingSend = send()
  const repeatedClick = send()
  await Promise.resolve()
  assert.equal(sends, 0, 'sending must wait until the initial history snapshot is settled')
  if (cancelHistory) {
    cleanupHistory()
    const sendNextProvider = compile(functions(component.body, ['send']), { ...context, provider: 'codex' }, 'send')
    await sendNextProvider()
    assert.equal(sends, 1, 'leaving a pending history load must immediately allow the next provider to send')
    nextHistory = new Promise((resolve) => { resolveNextHistory = resolve })
    context.historyLoadRef.current = nextHistory
    nextPendingSend = sendNextProvider()
  }
  if (failHistory) {
    rejectHistory(new Error('transcript unavailable'))
  } else {
    resolveHistory({ sessionId: 'existing-session', messages: [
      { id: 'old-user', role: 'user', text: '반복 질문', timestamp: startedAt + clockOffset - 10 },
      { id: 'old-assistant', role: 'assistant', text: '반복 답변', timestamp: startedAt + clockOffset - 9 }
    ] })
  }
  await Promise.all([pendingSend, repeatedClick])
  if (cancelHistory) {
    assert.equal(sends, 1, 'leaving the session while history loads must cancel its old pending send')
    assert.equal(context.pendingHistorySendRef.current, nextHistory, 'old completion must preserve the next pending send guard')
    resolveNextHistory()
    await nextPendingSend
    assert.equal(sends, 2, 'the next session sends after its own history completes')
    assert.equal(items.filter((item) => item.id.startsWith('history-')).length, 0)
    continue
  }
  assert.equal(sends, 1, 'repeated clicks while history loads must not send the same input twice')
  await send()
  assert.equal(sends, 2, 'a completed or failed history load must not block later sends')
  assert.deepEqual(items.filter((item) => item.id.startsWith('history-')).map((item) => item.id), failHistory ? [] : [
    'history-old-user', 'history-old-assistant'
  ], 'history is preserved even when the remote clock differs')
  const expectedTurns = failHistory ? 2 : 3
  assert.equal(items.filter((item) => item.kind === 'user').length, expectedTurns, 'all deliberate repeated questions survive')
  assert.equal(items.filter((item) => item.kind === 'assistant').length, expectedTurns, 'all deliberate repeated replies survive')
}

console.log('restored remote history: timestamps, all load orders, late session IDs, stable user IDs, and live work preserved')
console.log('fresh local/remote sessions: one first question, no self-history reload, repeated questions preserved')
console.log('resumed local/remote sessions: sends wait for history, tolerate failures/clock skew, and preserve repeats')
