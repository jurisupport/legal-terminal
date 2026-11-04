import assert from 'node:assert/strict'
import { CASE_ORDER_KEY, SESSION_VISITS_KEY, readCaseOrder, orderCaseTabs, moveCaseTab,
  readSessionVisits, recordSessionVisit, recentSidebarTasks } from '../src/renderer/src/sidebarNavigation.ts'

const storage = new Map()
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null }
const tabs = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 2 }, { id: 'c', updatedAt: 3 }]
const order = moveCaseTab(tabs.map((tab) => tab.id), 'c', 'a')
assert.deepEqual(order, ['c', 'a', 'b'])
assert.deepEqual(moveCaseTab(order, 'c', 'b'), ['a', 'b', 'c'])
assert.deepEqual(moveCaseTab(order, 'missing', 'b'), order)
assert.deepEqual(moveCaseTab(order, 'a', 'a'), order)
assert.deepEqual(orderCaseTabs([...tabs].reverse().map((tab) => ({ ...tab, updatedAt: Date.now() })), order).map((tab) => tab.id), order,
  'clicks and background updates cannot change saved order')
assert.deepEqual(orderCaseTabs([...tabs, { id: 'new' }], order).map((tab) => tab.id), [...order, 'new'])
storage.set(CASE_ORDER_KEY, JSON.stringify(order))
assert.deepEqual(readCaseOrder(), order, 'saved order survives a fresh read')
assert.deepEqual(orderCaseTabs([tabs[0], tabs[1]], readCaseOrder()).map((tab) => tab.id), ['a', 'b'], 'closed tabs do not disrupt survivors')

const task = (id, extra = {}) => ({ id, title: id, mtime: 1, sessionId: `session-${id}`, ...extra })
const item = (id, tasks) => ({ id, historyKey: id, title: id, subtitle: '', open: true, noticeCount: 0, active: false, updatedAt: 1, tasks })
const local = item('local', [task('a'), task('b')])
const remote = item('remote', [task('a')])
let visits = recordSessionVisit([], 'local', task('b'), 10)
visits = recordSessionVisit(visits, 'remote', task('a'), 20)
const rowKeys = (cases, history) => recentSidebarTasks(cases, history).map(({ item, task }) => `${item.id}:${task.id}`)
assert.deepEqual(rowKeys([local, remote], visits), ['remote:a', 'local:b', 'local:a'], 'same session ID in different workspaces stays separate')
visits = recordSessionVisit(visits, 'local', task('b'), 30)
assert.deepEqual(rowKeys([local, remote], visits), ['local:b', 'remote:a', 'local:a'], 'only viewing a session promotes it')
assert.equal(visits.length, 2, 'repeated visits are deduplicated')
assert.deepEqual(rowKeys([{ ...local, tasks: [task('a', { mtime: Date.now(), status: '작업 중' }), task('b')] }, remote], visits),
  ['local:b', 'remote:a', 'local:a'], 'background status and transcript timestamps never promote a session')
assert.deepEqual(rowKeys([{ ...local, tasks: [] }, remote], visits), ['local:b', 'remote:a'], 'viewed saved sessions remain available after closing tabs')
const restored = { ...local, tasks: [task('restored', { sessionId: 'session-b', title: '새 제목' })] }
assert.equal(recentSidebarTasks([restored], visits).length, 1, 'restoring under a new tab ID does not duplicate a saved session')
assert.equal(recentSidebarTasks([restored], visits)[0].task.title, '새 제목')
visits = recordSessionVisit(visits, 'local', restored.tasks[0], 40)
assert.equal(visits.length, 2)
const pending = recordSessionVisit([], 'local', task('pending', { sessionId: undefined }), 10)
assert.equal(recordSessionVisit(pending, 'local', task('pending'), 10).length, 1, 'late session IDs replace pending entries')
assert.equal(recentSidebarTasks([item('local', [])], pending).length, 0, 'closed tabs without resumable sessions are not dead links')
storage.set(SESSION_VISITS_KEY, JSON.stringify(visits))
assert.deepEqual(rowKeys([restored, remote], readSessionVisits()), rowKeys([restored, remote], visits))
assert.deepEqual(recentSidebarTasks([item('changed-host', [])], visits), [], 'SSH host changes cannot expose stale session links')

for (const malformed of ['{', '{}', 'null', '[null, 12, {}]']) {
  storage.set(CASE_ORDER_KEY, malformed)
  storage.set(SESSION_VISITS_KEY, malformed)
  assert.deepEqual(readCaseOrder(), [])
  assert.deepEqual(readSessionVisits(), [])
}
globalThis.localStorage.getItem = () => { throw Error('Storage unavailable') }
assert.deepEqual(readCaseOrder(), [])
assert.deepEqual(readSessionVisits(), [])
console.log('sidebar navigation: fixed/reordered tabs, persisted visits, scope isolation and background stability OK')
