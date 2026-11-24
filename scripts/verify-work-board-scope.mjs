// Board classification and case-folder scope, independent of an installed app or actual cases.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { boardDocumentPaths, boardReferencePaths, boardReportAvailable, isBoardTodoReview, requestsCurrentBoardCase } from '../src/shared/workBoard.ts'
import { normalizeProjectWorkspacePath } from '../src/main/projectStore.ts'
import { parseCasePairingFileText } from '../src/main/caseSyncData.ts'

for (const request of ['할일 정리부터 하자.', '일단 할 일부터 정리하자', '쥬리서포트 할일 정리부터 먼저 해 줘', '할일 좀 정리해 보자', '할일 검토', '미완료 할 일 점검', '할일 점검', '전체 미완료 할일', '이 사건 할 일을 확인해 주세요.', '남은 할일 목록 보여줘', '쥬리서포트 할일 점검하기', '주리서포트의 미완료 할 일 검토해 줘', 'JuriSupport에서 전체 미완료 할일 조회', 'JuriSupport 전체 미완료 할일']) {
  assert.equal(isBoardTodoReview(request), true, request)
}
for (const request of ['할일 정리부터 하자. 끝나면 발송해', '할일 정리부터 하고 담당자를 변경해', '할일 검토하고 메일 발송', '할일 검토를 위한 안내문 작성', '할일 완료 처리', '쥬리서포트 할일 점검하고 완료 처리', '쥬리서포트 할일 점검 후 메일 발송', '검토', '할일 검토\n기한을 내일로 변경']) {
  assert.equal(isBoardTodoReview(request), false, request)
}
assert.equal(requestsCurrentBoardCase('이 사건 미완료 할 일 조회해줘'), true)
assert.equal(requestsCurrentBoardCase('미완료 할일 점검'), false)

for (const report of ['', '  ', '## 결재 필요\n\nmcp__jurisupport__list_todos', '## 할 일 조회 확인 필요\r\n권한 부족', '## 결재 필요\n\nBash(python3 -c "\n## 표처럼 보이는 줄\n내용\n")']) {
  assert.equal(boardReportAvailable(report), false)
}
for (const report of ['미완료 할일 0건', '## 결론\n업무 점검 완료\n\n## 결재 필요\n발송 권한',
  '## 결재 필요\n승인 요청\n\n## 산출물\n초안.md']) assert.equal(boardReportAvailable(report), true)

const documents = [
  '## 결론', '[관련 자료](참고.pdf)', '## 결재 대상 문서',
  '- [원본](<서면/의견서 (최종).pdf>)', '- `서면/답변서.docx`',
  '| [한글 문서](서면/답변%20초안.hwpx) |', '## 검토 결과', '첨부 파일: 초안.html',
  '산출물 · _업무산출물/원문.md', '산출물 · /case/서면/의견서 (최종).pdf',
  '산출물 · /other/외부.pdf', '산출물 · ssh://other/case/private.pdf',
  '### 첨부 문서', '[외부](https://example.invalid/외부.pdf)', '[상위](%2e%2e/외부.txt)',
  '```', '산출물 · 가짜.txt', '```'
].join('\n')
assert.deepEqual(boardDocumentPaths(documents, 'ssh://office/case'), [
  '서면/의견서 (최종).pdf', '서면/답변서.docx', '서면/답변 초안.hwpx', '초안.html', '_업무산출물/원문.md'
].map(name => 'ssh://office/case/' + name))
assert.deepEqual(boardDocumentPaths('산출물 · c:\\Cases\\A\\의견서.pdf', 'C:\\Cases\\A'), ['C:/Cases/A/의견서.pdf'])

const at = '2026-11-24T12:30:00Z'
const reads = ['_업무산출물/안내.html','참고 자료/원본.md','ssh://office/case/참고 자료/원본.md',
  '/case/_업무산출물/안내.html', 'ssh://other/case/기밀.md', '상위/../기밀.md', '.claude/secret.md',
  '_업무지시/기밀.md', '_보관/기록.md', 'settings.json', 'tool-policy.json', 'AGENTS.md',
  'private-board/다른 지시.md', 'sample.report.md', 'sample.md', 'a.md\n파일 읽음 · 기밀.md',
  'cat 참고.md', 'Bash(cat 기밀.md)', '$(echo 기밀.md)', 'echo ok; cat 기밀.md', 'file\u2028line.md']
const log = reads.map(path => ({at,text:'파일 읽음 · ' + path})).concat([
  {at,text:'승인된 실행 · Bash(cat 기밀.md)'}, {at,text:'도구 결과\n파일 읽음 · 가짜.md'},
  {at,text:'파일 작성 · 작성.md'}, {at:'invalid',text:'파일 읽음 · 잘못된 행.md'}
])
assert.deepEqual(boardReferencePaths(log, 'ssh://office/case', 'sample', 'ssh://office/case/private-board'),
  ['ssh://office/case/_업무산출물/안내.html','ssh://office/case/참고 자료/원본.md'])
assert.deepEqual(boardReferencePaths([{at,text:'파일 읽음 · HTML/tWo.html'}, {at,text:'파일 읽음 · c:/Cases/A/html/two.html'}], 'C:/Cases/A', 'sample'),
  ['C:/Cases/A/HTML/tWo.html'])

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
