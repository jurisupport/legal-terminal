import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as summary from '../src/shared/todoSummary.ts'
const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/shared/caseManagement.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports, require: () => summary })
const { buildCaseManagement: build, emptyCaseManagementUi, isWaiting, taskReasons } = exports
const now = '2026-09-30T10:00:00+09:00'
const todo = (id, caseId, extra = {}) => ({ id, caseId, title: 'same title', type: 'todo', status: 'pending', ...extra })
const cases = ['A', 'B', 'C', 'D'].map(id => ({ id, status: 'active' })).concat([{ id: 'E', status: 'closed' }, { id: 'F', status: 'closed' }])
const tasks = [
  todo('chosen', 'A'), todo('urgent', 'A', { dueDate: '2026-09-29' }),
  todo('done', 'A', { status: 'completed' }), todo('memo', 'A', { type: 'memo' }),
  todo('waiting-due', 'B', { waitingFor: '의뢰인 회신', dueDate: '2026-09-30T00:00:00+09:00', reviewAt: '2026-10-01' }),
  todo('waiting-review', 'C', { waitingFor: '은행 회신', dueDate: '2026-10-05', reviewAt: '2026-09-29' }),
  todo('review-only', 'C', { dueDate: '2026-10-05', reviewAt: '2026-09-29' }),
  todo('followup', 'E', { dueDate: '2026-09-30' }), todo('unlinked', null),
  todo('invalid', null, { dueDate: '2026-02-30' }), todo('missing-review', null, { waitingFor: '자료' })
]
const ui = { ...emptyCaseManagementUi(), selectedTaskByCase: { A: 'chosen', C: 'chosen', F: 'done' },
  focus: { date: '2026-09-30', taskIds: ['chosen', 'waiting-due', 'followup', 'unlinked', 'done', 'missing'] } }
let result = build(cases, [...tasks, tasks[0]], ui, now)
assert.equal(result.cases.length, 5)
assert.equal(result.openTasks.length, 9)
assert.equal(result.cases.find(row => row.case.id === 'D').nextTask, null)
assert.equal(result.cases.find(row => row.case.id === 'A').selectionKind, 'selected')
assert.equal(result.cases.find(row => row.case.id === 'A').nextTask.id, 'chosen')
assert.equal(result.cases.find(row => row.case.id === 'C').selectionKind, 'recommended')
assert.equal(result.cases.find(row => row.case.id === 'C').nextTask.id, 'review-only')
assert.equal(result.cases.find(row => row.case.id === 'B').selectionKind, 'waiting')
assert.equal(isWaiting(tasks[6]), false)
assert.equal(result.attentionTasks.some(task => task.id === 'waiting-due'), true)
assert.equal(result.attentionTasks.some(task => task.id === 'invalid'), true)
assert.equal(result.attentionTasks.some(task => task.id === 'missing-review'), true)
assert.equal(result.attentionTasks.some(task => task.id === 'unlinked'), false)
assert.equal(result.focusTasks.length, 4, 'focus is not capped at three')
assert.equal(result.ui.selectedTaskByCase.C, undefined, 'same title from another case cannot replace an invalid selection')
assert.equal(taskReasons(tasks[4], now).includes('기한 도과'), false, 'stored morning times are still today, not overdue')
assert.equal(tasks[4].dueDate, '2026-09-30T00:00:00+09:00')
assert.equal(result.recovery[0].case.id, 'A')
result = build(cases, tasks.filter(task => task.id !== 'chosen'), ui, now)
assert.equal(result.cases[0].selectionKind, 'recommended')
assert.equal(result.ui.selectedTaskByCase.A, undefined)
result = build(cases, tasks, ui, '2026-09-30T15:00:00Z')
assert.equal(result.today, '2026-10-01')
assert.equal(result.focusTasks.length, 0)
assert.equal(result.previousFocusTasks.length, 4)
assert.equal(result.ui.previousFocus.date, '2026-09-30')
assert.equal(result.attentionTasks.some(task => task.id === 'waiting-review'), true)
result = build(cases, tasks, { ...result.ui, focus: { date: '2026-10-01', taskIds: ['urgent'] } }, '2026-10-03')
assert.equal(result.ui.previousFocus.date, '2026-10-01', 'only latest previous selection day survives')
const recoveryUi = { ...emptyCaseManagementUi(), recovery: { caseId: 'C', seenCaseIds: ['A', 'B', 'E', 'deleted'] } }
result = build(cases, tasks, recoveryUi, now)
assert.equal(result.recoveryCaseId, 'C')
assert.equal(result.ui.recovery.seenCaseIds.includes('deleted'), false)
assert.equal(result.attentionTasks.some(task => task.id === 'urgent'), true, 'skipping never hides risk')
const priorityTasks = [todo('a', 'D'), todo('b', 'D', { dueDate: '2026-10-01' }), todo('c', 'D', { dueDate: '2026-10-01', status: 'in_progress' })]
assert.equal(build(cases, priorityTasks, emptyCaseManagementUi(), now).cases.find(row => row.case.id === 'D').nextTask.id, 'c')
const ordered = build(cases, [], emptyCaseManagementUi(), now, [
  { caseId: 'D', dateTime: '2026-09-30' }, { caseId: 'C', dateTime: '2026-10-01' },
  { caseId: 'A', dateTime: '2026-09-30', status: 'cancelled' }
])
assert.equal(ordered.recovery[0].case.id, 'D')
assert.equal(ordered.recovery[1].case.id, 'C')
assert.equal(ordered.cases.find(row => row.case.id === 'A').reasons.includes('오늘 기일'), false)
for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Seoul']) {
  process.env.TZ = tz
  assert.equal(build(cases, tasks, ui, '2026-09-30T15:00:00Z').today, '2026-10-01')
}
console.log('case management: selection, waiting/risk overlap, closed followups, KST focus rollover, ID pruning and recovery verified')
