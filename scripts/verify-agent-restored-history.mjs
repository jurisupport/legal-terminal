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
  .filter((node) => names.includes(node.name?.text)).map((node) => node.getText(ast)).join('\n')
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
  'transcriptToTimeline', 'historyBeforeRestoredTurn', 'reduceTimeline'
]), { ...values, messageQuote: () => undefined, normalizeAgentAttachments: () => [] },
  '({ transcriptToTimeline, historyBeforeRestoredTurn, reduceTimeline })')
const component = panel.statements.find((node) => node.name?.text === 'AgentPanel')
const effect = (marker) => component.body.statements.find((node) =>
  ts.isExpressionStatement(node) && node.getText(panel).startsWith('useEffect(') &&
  node.getText(panel).includes(marker)
).getText(panel)

for (const restoreBeforeHistory of [false, true]) {
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
    resumeSessionId: 'test-session', loadedHistoryKeyRef: { current: null },
    restoredTurnStartedAtRef: { current: undefined },
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
  if (restoreBeforeHistory) restore()
  resolveHistory(transcript)
  await history
  await Promise.resolve()
  if (!restoreBeforeHistory) restore()
  assert.deepEqual(items.filter((item) => item.id.startsWith('history-')).map((item) => item.text), [
    '이전 요청', '이전 답변', '시간 없는 이전 기록'
  ], `native history must omit the replayed turn when restore arrives ${restoreBeforeHistory ? 'before' : 'after'} history`)
  assert.equal(items.filter((item) => item.id === 'remote-user-1').length, 1)
  assert.equal(items.find((item) => item.id === permission.id), permission)
  assert.equal(items.find((item) => item.id === process.id), process)
}

console.log('restored remote history: timestamps, both load orders, stable user IDs, and live work preserved')
