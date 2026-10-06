import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Run the real adapter with an isolated MCP transport and settings; no production credentials or requests.
const require = createRequire(import.meta.url)
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const modules = {}
for (const [name, path] of [['./agentToken', '../src/main/agentToken.ts'], ['./jurisupportNormalize', '../src/main/jurisupportNormalize.ts'], ['./mcpResponse', '../src/main/mcpResponse.ts'], ['../shared/todoSummary', '../src/shared/todoSummary.ts']]) {
  const exported = {}
  new Function('require', 'exports', compile(path))(require, exported)
  modules[name] = exported
}
let now = Date.parse('2026-09-30T23:50:00+09:00')
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { now += 1000; return now } }
const written = [], calls = []
let fields = ['reviewAt', 'waitingFor', 'assigneeId', 'visibility', 'teamId', 'version'], handler, persist
let settings = { jurisupportTokenEnc: 'plain:account-A' }
const mockRequire = (name) => modules[name] ?? ({
  electron: { app: { getPath: () => '/nonexistent-case-adapter-test' }, safeStorage: { isEncryptionAvailable: () => false } },
  'fs/promises': { rm: async () => {} },
  './settings': { getSettings: async () => settings, setSettings: async (patch) => { if (persist) await persist; settings = { ...settings, ...patch } } },
  './imageSize': {}
}[name] ?? require(name))
const fetch = async (_url, options) => {
  const request = JSON.parse(options.body)
  let result = {}
  if (request.method === 'tools/list') result = { tools: ['create_task', 'update_task', 'list_task_assignees'].map(name => ({ name, inputSchema: { properties: Object.fromEntries(fields.map(field => [field, {}])) } })) }
  if (request.method === 'tools/call') {
    calls.push({ ...request.params, authorization: options.headers.Authorization })
    const data = await handler(request.params.name, request.params.arguments)
    result = { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
  return { status: 200, headers: { get: (key) => key === 'mcp-session-id' ? 'mock-session' : null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }
}
const api = {}
new Function('require', 'exports', 'fetch', 'Date', compile('../src/main/jurisupport.ts'))(mockRequire, api, fetch, TestDate)
const hearing = (id, patch = {}) => ({ id, type: 'trial', dateTime: '2026-10-01T01:00:00Z', status: 'scheduled', case: { id: 'case-a', caseNumber: null, caseName: 'name', parties: [] }, ...patch })
const first = Array.from({ length: 100 }, (_, i) => hearing(`h-${String(i).padStart(3, '0')}`))
handler = async (name, args) => {
  assert.equal(name, 'list_upcoming_hearings')
  assert.equal(args.take, 100)
  assert.equal(args.dateTo, '2026-10-06T15:00:00.000Z')
  assert.equal(args.dateFrom, undefined)
  return { items: args.skip === 0 ? first : [hearing('h-100')], hasMore: args.skip === 0 }
}
const [a, b] = await Promise.all([api.upcomingHearings(), api.upcomingHearings()])
assert.equal(a, b)
assert.equal(a.hearings.length, 101)
assert.equal(a.complete, true)
assert.deepEqual(calls.map(call => call.arguments.skip), [0, 100])
assert.equal(a.hearings[100].case.id, 'case-a')
handler = async (_name, args) => ({ data: { items: args.skip === 0 ? first : [first[0]], hasMore: args.skip === 0 } })
await assert.rejects(api.upcomingHearings(), /중복|반복/)
handler = async (_name, args) => ({ items: args.skip === 0 ? first : [], hasMore: args.skip === 0 })
await assert.rejects(api.upcomingHearings(), /누락/)
handler = async (_name, args) => { if (args.skip) throw new Error('page failed'); return { items: first, hasMore: true } }
await assert.rejects(api.upcomingHearings(), /page failed/)
for (const payload of [{ items: [hearing('bad', { dateTime: 'not-a-date' })], hasMore: false }, { items: [hearing('bad', { dateTime: '2026-02-30T01:00:00Z' })], hasMore: false }, { items: [hearing('bad', { dateTime: '2026-10-01T01:00:00' })], hasMore: false }, { items: [hearing('bad', { id: '' })], hasMore: false }, { items: [], hasMore: true }, { items: [] }, { success: false, data: { items: [], hasMore: false } }]) {
  handler = async () => payload
  await assert.rejects(api.upcomingHearings())
}
handler = async (_name, args) => ({ items: first.map((item, i) => ({ ...item, id: String(args.skip + i + 1) })), hasMore: true })
await assert.rejects(api.upcomingHearings(), /상한/)
// The API computes its lower bound anew per request: never continue pagination across KST midnight.
for (const hasMore of [true, false]) {
  now = Date.parse('2026-09-30T23:59:50+09:00')
  const priorCalls = calls.length
  handler = async () => {
    now = Date.parse('2026-10-01T00:00:01+09:00')
    return { items: hasMore ? first : [hearing('midnight')], hasMore }
  }
  await assert.rejects(api.upcomingHearings(), /날짜가 변경/)
  assert.equal(calls.length, priorCalls + 1, 'cross-midnight traversal must not fetch another page')
}
handler = async (_name, args) => {
  assert.equal(args.skip, 0)
  assert.equal(args.dateTo, '2026-10-07T15:00:00.000Z')
  return { items: [hearing('new-day')], hasMore: false }
}
assert.equal((await api.upcomingHearings()).hearings[0].id, 'new-day')
handler = async () => ({ items: [hearing(123)], hasMore: false })
assert.equal((await api.upcomingHearings()).hearings[0].id, '123')
handler = async () => ({ items: [], hasMore: false })
assert.equal((await api.upcomingHearings()).hearings.length, 0)
handler = async (name, args) => {
  if (name === 'list_task_assignees') return { success: true, data: [{ id: 'person-a', name: '담당' }, { id: 'person-b', name: null }] }
  written.push(args)
  return { data: { id: 'task-a', title: 'task', ...args, assignee: { id: args.assigneeId, name: '담당' } } }
}
assert.deepEqual(await api.todoAssignees({ taskId: 'task-a' }), [{ id: 'person-a', name: '담당' }, { id: 'person-b', name: '이름 미등록' }])
const todo = await api.updateTodo('task-a', { waitingFor: ' 회신 ', reviewAt: '2026-10-02', assigneeId: 'person-a', visibility: 'team', teamId: 3, version: 2 })
assert.equal(todo.waitingFor, '회신')
assert.equal(todo.assigneeName, '담당')
assert.equal(todo.teamId, 3)
assert.equal(written.at(-1).dueDate, undefined)
await api.updateTodo('task-a', { waitingFor: null, reviewAt: null, version: 3 })
assert.equal(written.at(-1).waitingFor, null)
assert.equal(written.at(-1).reviewAt, null)
assert.equal(written.at(-1).dueDate, undefined)
await assert.rejects(api.updateTodo('task-a', { teamId: '3' }), /팀 식별자/)
await assert.rejects(api.updateTodo('task-a', { assigneeId: '' }), /담당자 식별자/)
await api.setToken('account-legacy')
fields = ['reviewAt']
const before = written.length
await assert.rejects(api.updateTodo('task-a', { waitingFor: '회신', title: 'do not partially write' }), /waitingFor 저장/)
await assert.rejects(api.updateTodo('task-a', { assigneeId: 'person-a' }), /assigneeId 저장/)
assert.equal(written.length, before)
let release, started
const began = new Promise(resolve => { started = resolve })
handler = async () => { started(); return await new Promise(resolve => { release = resolve }) }
const old = api.upcomingHearings()
await began
await api.setToken('account-B')
release({ items: [hearing('old-account')], hasMore: false })
await assert.rejects(old, /계정이 변경/)
handler = async () => ({ items: [hearing('new-account')], hasMore: false })
assert.equal((await api.upcomingHearings()).hearings[0].id, 'new-account')
assert.equal(calls.at(-1).authorization, 'Bearer account-B')
let finishPersist
persist = new Promise(resolve => { finishPersist = resolve })
const changing = api.setToken('account-C')
await assert.rejects(api.upcomingHearings(), /계정이 변경/)
finishPersist(); await changing
persist = undefined
assert.equal((await api.upcomingHearings()).complete, true)
console.log('case adapter: complete 101-row paging, midnight restart, errors/duplicates/dates, assignment/wait capability gates, due-date preservation, account epoch and persistence races passed')

// Exercise main's account bridge and two real preload API instances without Electron or secrets.
const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const bridgeSource = mainSource.slice(mainSource.indexOf('function broadcastJuriSupportTokenChange'), mainSource.indexOf("ipcMain.handle('js:hasToken'"))
const rendererEvents = [new Map(), new Map()]
const rendererApis = rendererEvents.map(events => {
  const win = {}
  const ipcRenderer = {
    on: (channel, listener) => events.set(channel, listener),
    removeListener: (channel, listener) => { if (events.get(channel) === listener) events.delete(channel) }
  }
  new Function('require', 'exports', 'window', 'process', compile('../src/preload/index.ts'))(() => ({ ipcRenderer }), {}, win, { contextIsolated: false })
  return win.lt
})
let beginAccountChange, setTokenIpc, settleAccountChange
const broadcasts = [0, 0]
const mockWindows = rendererEvents.map((events, i) => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: channel => { broadcasts[i]++; events.get(channel)?.() } }
}))
mockWindows.push({ isDestroyed: () => true, webContents: { send: () => assert.fail('destroyed window must be skipped') } })
new Function('BrowserWindow', 'js', 'ipcMain', ts.transpileModule(bridgeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
  { getAllWindows: () => mockWindows },
  { onAgentMcpAccountChange: listener => { beginAccountChange = listener }, setToken: () => { beginAccountChange(); return new Promise((resolve, reject) => { settleAccountChange = { resolve, reject } }) } },
  { handle: (channel, listener) => { assert.equal(channel, 'js:setToken'); setTokenIpc = listener } }
)
const observed = [0, 0]
const unsubscribe = rendererApis.map((renderer, i) => renderer.js.onTokenChanged(() => { observed[i]++ }))
const tokenChange = setTokenIpc(null, 'synthetic')
assert.deepEqual(observed, [1, 1], 'all windows invalidate as persistence begins')
settleAccountChange.resolve(); await tokenChange
assert.deepEqual(observed, [2, 2], 'all windows refresh after successful persistence')
const failedTokenChange = setTokenIpc(null, 'synthetic-failure')
const rejection = assert.rejects(failedTokenChange, /save failed/)
settleAccountChange.reject(new Error('save failed')); await rejection
assert.deepEqual(observed, [4, 4], 'failure still refreshes the currently persisted account')
unsubscribe[0]()
const lastChange = setTokenIpc(null, 'synthetic')
settleAccountChange.resolve(); await lastChange
assert.deepEqual(observed, [4, 6], 'unsubscribed renderer receives no callback')
assert.deepEqual(broadcasts, [6, 6])
console.log('account IPC bridge: begin/settled broadcasts reach every live window; failure refresh and preload unsubscribe passed')
