// Board classification and case-folder scope, independent of an installed app or actual cases.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { isBoardTodoReview, requestsCurrentBoardCase } from '../src/shared/workBoard.ts'
import { normalizeProjectWorkspacePath } from '../src/main/projectStore.ts'
import { parseCasePairingFileText } from '../src/main/caseSyncData.ts'

for (const request of ['할일 검토', '미완료 할 일 점검', '할일 점검', '전체 미완료 할일', '이 사건 할 일을 확인해 주세요.', '남은 할일 목록 보여줘']) {
  assert.equal(isBoardTodoReview(request), true, request)
}
for (const request of ['할일 검토하고 메일 발송', '할일 검토를 위한 안내문 작성', '할일 완료 처리', '검토', '할일 검토\n기한을 내일로 변경']) {
  assert.equal(isBoardTodoReview(request), false, request)
}
assert.equal(requestsCurrentBoardCase('이 사건 미완료 할 일 조회해줘'), true)
assert.equal(requestsCurrentBoardCase('미완료 할일 점검'), false)

const entries = {
  localA: {drafts:'/cases/a'}, otherLocal: {drafts:'/cases/ab'},
  'remote:office:caseA': {drafts:'ssh://office/cases/a'},
  'remote:office:second': {drafts:'/alias/a'},
  'remote:elsewhere:other': {drafts:'ssh://elsewhere/cases/a'}
}
const strictStore = {allJsPairings: async strict => { assert.equal(strict, true); return entries }}
const module = {exports:{}}
const compiled = transformSync(readFileSync(new URL('../src/main/workBoardScope.ts', import.meta.url), 'utf8'), {loader:'ts',format:'cjs'})
const require = createRequire(import.meta.url)
Function('require', 'module', 'exports', compiled.code)(
  id => id === './caseStore' ? strictStore : id === './projectStore' ? {normalizeProjectWorkspacePath} : require(id),
  module, module.exports
)
const {boardTodoCaseIds, verifyBoardTodoScope} = module.exports
assert.deepEqual(await boardTodoCaseIds('/cases/a/'), ['localA'])
assert.deepEqual(await boardTodoCaseIds('ssh://office/cases/a', ['ssh://office/alias/a']), ['caseA','second'])
assert.deepEqual(await boardTodoCaseIds('/cases/a/child'), [])
await verifyBoardTodoScope('/cases/a', {kind:'case',caseId:'localA'})
await assert.rejects(verifyBoardTodoScope('/cases/a', {kind:'all'}))
await assert.rejects(verifyBoardTodoScope('ssh://office/cases/a', {kind:'case',caseId:'localA'}))
await assert.rejects(verifyBoardTodoScope('/unbound', {kind:'case',caseId:' '}))
await assert.rejects(verifyBoardTodoScope('/unbound', {kind:'all',caseId:'localA'}))
assert.equal(await verifyBoardTodoScope('/unbound', {kind:'all'}), false)
await assert.rejects(verifyBoardTodoScope('/unbound', {kind:'case',caseId:'localA'}, [], true))
assert.throws(() => parseCasePairingFileText('{"entries":[{}]}', true))
assert.throws(() => parseCasePairingFileText('broken', true))
assert.deepEqual(parseCasePairingFileText('{"entries":[]}', true), [])
console.log('업무 보드 · 할일 검토 문구, 사건/전체 범위, SSH 별칭, 손상된 연결 정보 확인')
