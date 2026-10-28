import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { cleanUserInstruction } from '../src/main/workLogData.ts'

const ast = path => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const panel = ast('../src/renderer/src/agent/AgentPanel.tsx')
const sessions = ast('../src/main/sessions.ts')
const compile = (source, context, result) => Function(...Object.keys(context),
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + `\nreturn ${result}`)(...Object.values(context))
const helpers = (source, names) => source.statements.filter(node => names.includes(node.name?.text)).map(node => node.getText(source)).join('\n')
const parse = compile(helpers(sessions, ['parseTranscriptMessages', 'extractTranscriptText', 'clipTranscriptText', 'recordValue']),
  { cleanUserInstruction, MAX_SESSION_HISTORY_MESSAGES: 100, MAX_SESSION_MESSAGE_CHARS: 20000 }, 'parseTranscriptMessages')
const { mergeTranscriptTimeline, transcriptToTimeline } = compile(helpers(panel, ['mergeTranscriptTimeline', 'transcriptToTimeline']), {}, '({ mergeTranscriptTimeline, transcriptToTimeline })')
const history = messages => transcriptToTimeline({ sessionId: 'shared-session', messages }, 'Claude')
const user = (id, text = '반복 질문') => ({ id, role: 'user', text })
const assistant = (id, text = '답변') => ({ id, role: 'assistant', text })
const first = history([user('phone-1'), assistant('phone-answer-1')])
let items = mergeTranscriptTimeline([], first)
assert.equal(mergeTranscriptTimeline(items, first), items, 'unchanged polls must not rerender')
const tool = { id: 'tool', kind: 'process', processSteps: [{ id: 'edit', status: 'done' }] }
const quote = { preview: '인용', messageId: 'phone-answer-1' }
const local = { id: 'pc-2', kind: 'user', text: '반복 질문', quote, attachments: [{ label: '첨부' }] }
const localAnswer = { id: 'pc-answer', kind: 'assistant', text: '여러\n답변', status: 'done' }
items = [...items, local, tool, localAnswer]
const alternating = history([user('phone-1'), assistant('phone-answer-1'), user('pc-2'),
  assistant('native-pc-a', '여러'), assistant('native-pc-b', '답변'), user('phone-3'), assistant('phone-answer-3', '새 답변')])
items = mergeTranscriptTimeline(items, alternating)
assert.deepEqual(items.filter(x => x.kind === 'user').map(x => x.text), ['반복 질문', '반복 질문', '반복 질문'])
assert.equal(items.filter(x => x.kind === 'assistant').length, 3, 'local response chunks must not duplicate the live answer')
assert.equal(items.find(x => x.id === local.id).quote, quote)
assert.equal(items.find(x => x.id === tool.id), tool)
assert.equal(items.find(x => x.id === localAnswer.id), localAnswer)
assert.equal(mergeTranscriptTimeline(items, alternating), items)
const continued = alternating.map(x => x.id === 'history-phone-answer-3' ? { ...x, text: '새 답변 완성' } : x)
items = mergeTranscriptTimeline(items, continued)
assert.equal(items.at(-1).text, '새 답변 완성', 'remote partial answers update in place')
assert.equal(mergeTranscriptTimeline(items, []), items, 'empty/disconnected snapshots preserve history')
assert.equal(mergeTranscriptTimeline(items, continued.slice(-2)), items, 'bounded transcript tails preserve older turns')
assert.equal(mergeTranscriptTimeline(items, continued.slice(3)), items, 'a tail starting inside a local response must not duplicate its native chunks')
assert.deepEqual(mergeTranscriptTimeline(first, history([user('after-offline'), assistant('after-offline-answer')])).map(x => x.id),
  [...first, ...history([user('after-offline'), assistant('after-offline-answer')])].map(x => x.id), 'a newer tail without overlap appends after the displayed conversation')
const longLocal = [{ id: 'long-user', kind: 'user', text: '긴 작업' }, {
  id: 'long-answer', kind: 'assistant', text: '첫 블록\n다음 블록', transcriptIds: ['history-chunk1', 'history-chunk2']
}]
assert.equal(mergeTranscriptTimeline(longLocal, history([assistant('chunk1', '첫 블록'), assistant('chunk2', '다음 블록')])), longLocal,
  'native response identities cover a first poll whose 100-message tail omits the local user')

// Replayed legacy runs identify their turn by the native response UUID.
const legacy = [{ id: 'live-old', kind: 'user', text: '반복 질문' }, {
  id: 'live-answer', kind: 'assistant', text: '답변', transcriptIds: ['history-phone-answer-1']
}]
const bound = mergeTranscriptTimeline(legacy, first)
const repeated = mergeTranscriptTimeline(bound, [...first, ...history([user('phone-2'), assistant('phone-answer-2')])])
assert.equal(repeated.filter(x => x.kind === 'user').length, 2)
assert.equal(repeated.filter(x => x.kind === 'assistant').length, 2)
const failed = [{ id: 'failed-pc-user', kind: 'user', text: '반복 질문' }, { id: 'failure', kind: 'error', text: '실행 실패' }]
const retry = mergeTranscriptTimeline(failed, first)
assert.equal(retry.filter(x => x.kind === 'user').length, 2, 'a failed PC request and a phone retry are different turns')
assert.equal(retry.at(-1).text, '답변', 'a retry answer cannot be hidden by a same-text failed request')

const lines = [
  { type: 'user', uuid: 'u-1', message: { role: 'user', content: '원격 질문' } },
  { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', id: 'same-model-message', content: [{ type: 'text', text: '첫 블록' }] } },
  { type: 'assistant', uuid: 'a-2', message: { role: 'assistant', id: 'same-model-message', content: [{ type: 'text', text: '다음 블록' }] } }
].map(JSON.stringify)
const full = parse(lines.join('\n'), 'shared-session').messages
assert.deepEqual(full.map(x => x.id), ['u-1', 'a-1', 'a-2'])
assert.deepEqual(parse(lines.slice(1).join('\n'), 'shared-session').messages, full.slice(1), 'native IDs survive tail truncation')
assert.equal(parse([...lines, '{"type":"assistant",'].join('\n'), 'shared-session').messages.length, 3, 'incomplete writes are retried next poll')
assert.deepEqual(parse(JSON.stringify({ type: 'user', uuid: 'attachment-only', message: { role: 'user', content: '[legal-terminal attachments]\n첨부 파일' } }), 'shared-session').messages,
  [{ id: 'attachment-only', role: 'user', text: '[첨부 자료]' }], 'attachment-only turns retain their identity')

// Claude stores API request blobs after real turns; their embedded messages are copies, not new turns.
const requestBlobs = [
  { role: 'user', content: '원격 질문' },
  { role: 'assistant', content: [{ type: 'text', text: '첫 블록' }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'loaded-tool', content: 'ok' }, { type: 'text', text: 'Tool loaded.' }] },
  { role: 'user', content: [{ type: 'text', text: '[Image: original 3750x1667, displayed at 2000x889. Multiply coordinates by 1.88 to map to original image.]' }] }
].map((message, index) => JSON.stringify({ type: 'api-request-blob', sessionId: 'shared-session', hash: `blob-${index}`, message }))
const withRequestBlobs = parse([...lines, ...requestBlobs].join('\n'), 'shared-session').messages
assert.deepEqual(withRequestBlobs, full, 'API request caches must not replay old questions, answers or tool metadata')
const displayed = history(full)
assert.equal(mergeTranscriptTimeline(displayed, history(withRequestBlobs)), displayed,
  'polling a transcript with newly written API cache records must leave the displayed conversation unchanged')
assert.deepEqual(parse([...lines, ...Array(101).fill(requestBlobs[0])].join('\n'), 'shared-session').messages, full,
  'request caches must not consume the 100-message history window')
assert.deepEqual(parse([...requestBlobs, ...lines].join('\n'), 'shared-session').messages, full,
  'real messages after request cache records retain their native IDs and order')

const service = ast('../src/main/agent/agent-service.ts')
const remotePromptLine = compile(helpers(service, ['remotePromptLine']), {}, 'remotePromptLine')
assert.equal(JSON.parse(remotePromptLine('첨부와 인용이 있는 요청', 'stable-user-id')).uuid, 'stable-user-id')
assert.equal(Object.hasOwn(JSON.parse(remotePromptLine('probe')), 'uuid'), false)

const component = panel.statements.find(node => node.name?.text === 'AgentPanel')
const pollEffect = component.body.statements.find(node => ts.isExpressionStatement(node) &&
  node.getText(panel).startsWith('useEffect(') && node.getText(panel).includes('liveHistoryPendingRef.current')).getText(panel)
const tick = () => new Promise(resolve => setImmediate(resolve))
let cleanup, event, interval, loads = 0, remembered = 0, resolveLoad, rejectLoad
const listeners = new Map()
let polled = []
const context = {
  useEffect: callback => { cleanup = callback() },
  provider: 'claude', resumeSessionId: 'shared-session', visible: true, status: 'idle',
  id: 'panel-id', ssh: undefined, agentLabel: 'Claude', historyLoadRef: { current: Promise.resolve() },
  liveHistoryPendingRef: { current: false },
  isActiveAgentStatus: status => ['working', 'waiting_permission', 'waiting_user'].includes(status),
  eventSessionId: event => event.sessionId,
  window: {
    lt: { agent: { onEvent: callback => { event = callback; return () => { event = undefined } } } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name)
  },
  document: {
    hidden: false,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name)
  },
  setInterval: (callback, delay) => { assert.equal(delay, 2500); interval = callback; return 1 },
  clearInterval: () => { interval = undefined },
  loadSessionTranscript: (_id, _ssh, options) => {
    assert.equal(options.refresh, true)
    loads++
    return new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject })
  },
  setResumedModel: () => {}, rememberPrompts: () => { remembered++ },
  transcriptToTimeline, mergeTranscriptTimeline,
  setItems: update => { polled = update(polled) }
}
compile(pollEffect, context, 'undefined')
await tick()
assert.equal(loads, 1)
interval(); listeners.get('focus')(); listeners.get('online')()
await tick()
assert.equal(loads, 1, 'focus and interval must not overlap reads')
resolveLoad({ sessionId: 'shared-session', messages: [user('first')] })
await tick()
assert.equal(polled.length, 1)
context.document.hidden = true
interval()
assert.equal(loads, 1, 'background windows do not poll')
context.document.hidden = false
listeners.get('visibilitychange')()
await tick()
assert.equal(loads, 2, 'returning to the foreground refreshes immediately')
event({ type: 'message:user', sessionId: 'panel-id' })
resolveLoad({ sessionId: 'shared-session', messages: [user('first'), user('stale')] })
await tick()
assert.equal(polled.length, 1, 'an old snapshot must not cross a new local turn')
interval()
assert.equal(loads, 2, 'active local turns suspend polling')
event({ type: 'status', sessionId: 'panel-id', status: 'done' })
interval()
await tick()
assert.equal(loads, 3)
rejectLoad(new Error('offline'))
await tick()
assert.equal(polled.length, 1)
interval()
await tick()
assert.equal(loads, 4, 'connection failure is retried')
cleanup()
const oldResolve = resolveLoad
context.resumeSessionId = 'other-session'
compile(pollEffect, context, 'undefined')
await tick()
assert.equal(loads, 4, 'remounting while a request is pending does not reuse the stale response')
oldResolve({ sessionId: 'shared-session', messages: [user('late')] })
await tick()
assert.equal(polled.length, 1, 'unmounted session cannot add stale messages')
interval()
await tick()
assert.equal(loads, 5)
resolveLoad(null)
await tick()
cleanup()
assert.equal(listeners.size, 0)
assert.equal(interval, undefined)
assert.equal(remembered, 0, 'polling must not reset prompt recall or its saved draft')
for (const inactive of [{ visible: false }, { visible: true, status: 'working' }, { status: 'idle', provider: 'codex' }]) {
  Object.assign(context, inactive)
  compile(pollEffect, context, 'undefined')
  await tick()
  assert.equal(loads, 5, 'only visible idle Claude chats poll')
  assert.equal(interval, undefined)
}

console.log('Live history: alternating PC/mobile turns, repeated prompts, stable IDs, response updates and rich local data preserved')
console.log('Polling: focus/resume, hidden windows, active turns, single-flight, disconnect retries and stale completion guards pass')
