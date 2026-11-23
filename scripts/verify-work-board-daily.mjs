import assert from 'node:assert/strict'
import { buildBoardDaily, boardReportDue } from '../src/main/workBoardDaily.ts'
import { isBoardDueSoon } from '../src/shared/workBoardSummary.ts'

const at = new Date('2026-12-31T15:00:00Z')
const task = (title, status, due) => ({ title, agent: '검토', status, due })
assert.equal(boardReportDue('00:00', '2026-12-31', at), true)
assert.equal(boardReportDue('00:00', '2027-01-01', at), false)
assert.equal(boardReportDue('00:01', null, at), false)
assert.equal(boardReportDue('24:00', null, at), false)
assert.equal(boardReportDue('00:01', null, new Date(+at + 3600000)), true)
for (const [due, expected] of [['2026-12-31', false], ['2027-01-01', true], ['2027-01-04', true], ['2027-01-05', false], ['2027-02-30', false]]) {
  assert.equal(isBoardDueSoon(task('문서', 'blocked', due), at), expected)
}
const { markdown, html, date } = buildBoardDaily([
  task('<script> & ![x](foo)', 'in_review', '2027-01-04'), task('서류', 'awaiting_approval', '2027-01-05'),
  task('완료', 'done', '2027-01-01'), task('검토', 'failed', '2027-01-01')
], at)
assert.equal(date, '2027-01-01')
for (const label of ['수행 중', '결재 대기', '실패', '기한 임박 (3일 이내)']) {
  for (const output of [markdown, html]) assert.ok(output.includes(label + ' (1건)'))
}
assert.ok(html.includes('&lt;script&gt; &amp;'))
assert.ok(!html.includes('<script>'))
assert.ok(!markdown.includes('![x]'))
assert.ok(buildBoardDaily([], at).html.includes('해당 없음'))
console.log('일일 보고 집계 · KST 예약 · 안전한 내보내기 검증 통과')
