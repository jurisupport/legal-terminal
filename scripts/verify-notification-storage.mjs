import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/sharedUiState.ts'

const module = { exports: {} }
const source = fs.readFileSync(new URL('../src/renderer/src/notificationHistoryStore.ts', import.meta.url), 'utf8')
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, require: () => shared })
const store = module.exports
const storage = () => {
  const data = new Map()
  return { data, get length() { return data.size }, key: index => [...data.keys()].sort().reverse()[index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
}
const entry = (id, createdAt = 1, host = 'office') => ({ id, host, termId: 'agent', title: id, status: 'done', createdAt })
const ids = entries => Array.from(entries, entry => entry.id)
const disk = storage()
const firstWindow = store.readNotificationHistory(disk), secondWindow = store.readNotificationHistory(disk)
store.writeNotificationHistory(disk, [entry('a', 1)], firstWindow)
store.writeNotificationHistory(disk, [entry('b', 2)], secondWindow)
assert.deepEqual(ids(store.readNotificationHistory(disk)), ['b', 'a'], 'stale windows preserve each other’s additions')
const observed = store.readNotificationHistory(disk)
store.writeNotificationHistory(disk, [entry('c', 3), ...observed], observed)
store.writeNotificationHistory(disk, [], observed)
assert.deepEqual(ids(store.readNotificationHistory(disk)), ['c'], 'clear only removes observed records')
store.writeNotificationHistory(disk, [entry('d', 4), ...observed], observed)
assert.deepEqual(ids(store.readNotificationHistory(disk)), ['d', 'c'], 'stale unchanged entries do not resurrect cleared records')
const restarted = storage()
for (const [key, value] of disk.data) restarted.setItem(key, value)
assert.deepEqual(ids(store.readNotificationHistory(restarted)), ['d', 'c'], 'fresh renderer restores disk records')
const bounded = storage()
for (let index = 0; index < 105; index++) store.writeNotificationHistory(bounded, [entry(String(index), index)], [])
assert.equal(store.readNotificationHistory(bounded).length, 100)
assert.equal(bounded.length, 100, 'retention prunes persisted records too')
assert.equal(store.readNotificationHistory(bounded).at(-1).createdAt, 5)
for (const raw of ['{broken', '{}', JSON.stringify(entry('wrong-id'))]) {
  const malformed = storage()
  malformed.setItem(`${store.NOTIFICATION_HISTORY_KEY}:["office","expected-id"]`, raw)
  assert.throws(() => store.readNotificationHistory(malformed))
  assert.throws(() => store.writeNotificationHistory(malformed, [entry('safe')], []))
  assert.equal(malformed.length, 1, 'corrupt data is retained for recovery')
}
const pending = storage()
const notice = id => { const { host, ...item } = entry(id); return { id, type: 'notification', entry: item } }
store.saveNotificationOperation(pending, 'office', notice('a'))
store.saveNotificationOperation(pending, 'office', notice('b'))
store.saveNotificationOperation(pending, 'office', { id: 'clear-observed', type: 'notification-clear', entryIds: ['a'] })
store.saveNotificationOperation(pending, 'second-host', notice('a'))
assert.equal(store.readNotificationOutbox(pending).length, 4, 'offline windows retain independent operations and host scopes')
const server = shared.emptySharedUiState()
for (const item of store.readNotificationOutbox(pending)) {
  if (item.host === 'office') shared.applySharedUiOperation(server, item.operation)
}
assert.deepEqual(server.notifications.map(item => item.id), ['b'], 'restart replay appends before clearing despite arbitrary key ordering')
store.removeNotificationOperation(pending, 'office', 'a')
assert.equal(store.readNotificationOutbox(pending).length, 3, 'acknowledging one host does not erase another host’s same ID')
assert.ok(store.readNotificationOutbox(pending).some(item => item.host === 'second-host' && item.operation.id === 'a'))
assert.throws(() => store.saveNotificationOperation(pending, 'office', { id: 'bad', type: 'selection', caseKey: null, tab: null }))
const invalidPending = storage()
invalidPending.setItem(`${store.NOTIFICATION_OUTBOX_KEY}:["office","bad"]`, '{}')
assert.throws(() => store.readNotificationOutbox(invalidPending))
console.log('notification storage: stale windows, clear races, restart, retention, corruption, offline outbox and host isolation OK')
