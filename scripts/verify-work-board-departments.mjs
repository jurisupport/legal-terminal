// Department delegation: a head splits one instruction into member sub-cards and combines their reports.
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { boardInstructionCost, boardMutationIssue, boardRevision, isBoardReport } from '../src/shared/workBoard.ts'

const dir = await mkdtemp(join(tmpdir(), 'work-board-departments-'))
const office = join(dir, 'office-departments')
process.env.LEGAL_TERMINAL_DEPARTMENTS_DIR = office
const require = createRequire(import.meta.url)
const { outputFiles } = await build({
  entryPoints: ['src/main/workBoard.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{
    name: 'provider-fixture', setup(build) {
      build.onResolve({ filter: /^\.\/workBoardRunner$/ }, () => ({ path: 'runner', namespace: 'mock' }))
      build.onResolve({ filter: /^\.\/remoteFs$/ }, () => ({ path: 'remote', namespace: 'mock' }))
      build.onResolve({ filter: /^\.\/workBoard(?:Todos|Scope)$/ }, ({ path }) => ({ path, namespace: 'mock' }))
      build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
        contents: path === 'remote' ? 'export {}'
          : path === 'runner' ? 'export const listBoardAgents=async()=>globalThis.boardAgentsFixture;export const boardRunCost=e=>e?.costUsd;export const runBoardAgent=(input)=>globalThis.boardRunFixture(input)'
          : 'const fail=async()=>{throw Error("unexpected todo access")};export const readBoardTodos=fail,readBoardMcpTodos=fail,getBoardTodoAccount=fail,verifyBoardTodoScope=fail'
      }))
    }
  }]
})
globalThis.boardAgentsFixture = [
  { name: 'lead', description: '부서장' },
  { name: 'fact', description: '사실관계 정리' },
  { name: 'law', description: '법리 검토' }
]
const runs = []
let lawBlockedOnce = false
globalThis.boardRunFixture = async i => {
  runs.push({ title: i.task.title, phase: i.phase, agent: i.agentName ?? i.task.agent, delegation: i.delegation, department: i.department, prompt: i.prompt, delegatedBy: i.task.delegatedBy })
  if (i.delegation?.team === '송무팀') {
    return { text: '2건 배분', costUsd: 0.4, assignments: [
      { member: 'fact', title: '사실관계 정리', instruction: '기록에서 사실관계를 시간순으로 정리', after: [] },
      { member: 'law', title: '법리 검토', instruction: '정리된 사실관계로 법리 검토', after: [1] }
    ] }
  }
  if (i.delegation) return { text: '## 결론\n부서장이 직접 처리 DIRECT_REPORT' }
  if (i.task.title === '사실관계 정리') return { text: '## 결론\n사실관계 보고 FACT_REPORT', costUsd: 0.7 }
  if (i.task.title === '법리 검토') {
    if (!lawBlockedOnce) {
      lawBlockedOnce = true
      return { blocked: true, text: '## 결재 필요\n\nBash(ls)' }
    }
    return { text: '## 결론\n법리 보고 LAW_REPORT' }
  }
  if (i.task.team === '송무팀') return { text: '## 결론\n최종 취합 보고 FINAL_REPORT', costUsd: 0.2 }
  if (i.task.title === '점유') {
    await globalThis.boardHoldFixture
    return { text: '## 결론\n점유 완료' }
  }
  throw Error('unexpected run ' + i.task.title)
}
const mod = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(mod, mod.exports, require)
const { WorkBoard } = mod.exports
const folder = join(dir, 'tasks'), privateDir = join(dir, 'profile')
const notes = []
let board
async function until(check) {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const snapshot = await board.snapshot()
    if (check(snapshot.tasks)) return snapshot.tasks
    await new Promise(r => setTimeout(r, 10))
  }
  throw Error('지시 상태 대기 시간 초과 ' + JSON.stringify((await board.snapshot()).tasks.map(t => [t.title, t.status])) + JSON.stringify(notes))
}
try {
  board = new WorkBoard(dir, folder, privateDir, m => { if (m) notes.push(m) })
  await board.start()

  // The office starts without departments; the proposal is only offered, never saved on its own.
  let snapshot = await board.snapshot()
  assert.deepEqual(snapshot.teams, [])
  assert.equal(snapshot.departments.home, office)
  assert.equal(await readFile(join(folder, 'teams.yaml'), 'utf8').catch(() => null), null, 'a board no longer keeps its own departments')
  const suggestion = await board.suggestedTeams()
  assert.deepEqual(suggestion.teams.map(t => t.name), ['법률지원', '콘텐츠', '마케팅', '영업', '플랫폼운영'])
  assert.ok(suggestion.teams.every(t => t.agents.length === 0) && suggestion.missing.includes('lawpid-contract-review'), 'members without a specialist file are left out')
  assert.equal(await readFile(join(office, 'teams.yaml'), 'utf8').catch(() => null), null)

  await assert.rejects(board.saveTeams([{ name: '송무팀', color: '#376ac6', agents: [] }, { name: '송무팀', color: '#148369', agents: [] }]), /서로 달라야/)
  await assert.rejects(board.saveTeams([{ name: '송무팀', color: 'blue', agents: [] }]), /색상/)
  await assert.rejects(board.saveTeams([{ name: '송무팀', color: '#376ac6', agents: [], tools: { bash: 'allow' } }]), /읽기 전용 도구뿐/)
  await board.saveTeams([
    { name: '송무팀', color: '#376ac6', lead: 'lead', description: '서면 작성과 법리 검토', rules: '부서 규칙 RULES_MARKER', leadGuide: '부서장 지침 GUIDE_MARKER',
      tools: { 'korean-law': 'allow', bash: 'ask', mcp: 'off' }, warnInstructionUsd: 1, warnMonthlyUsd: 1.2, agents: ['fact', 'law', 'fact'] },
    { name: '리서치팀', color: '#148369', description: '판결 조사', agents: [] }
  ])
  // Office-wide files: teams.yaml points at rule files beside it.
  const yaml = await readFile(join(office, 'teams.yaml'), 'utf8')
  assert.match(yaml, /rules: rules\/송무팀\.md/)
  assert.match(yaml, /lead_guide: rules\/송무팀-부서장\.md/)
  assert.doesNotMatch(yaml, /lead:/)
  assert.equal(await readFile(join(office, 'rules', '송무팀.md'), 'utf8'), '부서 규칙 RULES_MARKER')
  snapshot = await board.snapshot()
  assert.deepEqual(snapshot.teams[0], { name: '송무팀', color: '#376ac6', agents: ['fact', 'law'], description: '서면 작성과 법리 검토',
    rules: '부서 규칙 RULES_MARKER', leadGuide: '부서장 지침 GUIDE_MARKER', tools: { 'korean-law': 'allow', bash: 'ask' }, warnInstructionUsd: 1, warnMonthlyUsd: 1.2 })
  assert.equal(snapshot.departments.history.length, 0, 'the first save has no earlier version')
  // A second case board on the same computer sees the same departments.
  const other = new WorkBoard(join(dir, 'other-case'), join(dir, 'other-case', '_업무지시'), privateDir, () => {})
  await other.start()
  assert.deepEqual((await other.snapshot()).teams.map(t => t.name), ['송무팀', '리서치팀'])
  other.stop()
  await assert.rejects(board.add([{ title: 'x', body: 'x', team: '없는팀' }]), /등록되지 않은 부서/)
  await assert.rejects(board.add([{ title: 'x', body: 'x', team: '송무팀', agent: 'fact' }]), /하나만/)

  // The head assigns two members; the second waits for the first.
  await board.add([{ title: '준비서면 초안', body: '원고 주장을 반박하는 준비서면 초안', team: '송무팀', approval: 'required' }])
  let tasks = await until(ts => ts.some(t => t.title === '법리 검토' && t.status === 'blocked'))
  const head = tasks.find(t => t.title === '준비서면 초안')
  const fact = tasks.find(t => t.title === '사실관계 정리')
  let law = tasks.find(t => t.title === '법리 검토')
  assert.equal(head.status, 'delegated')
  assert.ok(head.log.some(e => e.text === '부서 배분 · 송무팀 · 2건'))
  assert.deepEqual(runs[0].delegation.members.map(m => m.name), ['fact', 'law'])
  assert.equal(runs[0].agent, undefined, 'the app head splits the work, not a specialist')
  assert.deepEqual(runs[0].department, { team: '송무팀', role: 'head', rules: '부서 규칙 RULES_MARKER', leadGuide: '부서장 지침 GUIDE_MARKER', tools: { 'korean-law': 'allow', bash: 'ask' } })
  assert.equal((await board.detail(head.id)).report, '', 'a plan is not a report')
  assert.equal(fact.delegatedBy, head.id)
  assert.equal(fact.agent, 'fact')
  assert.equal(fact.status, 'done')
  assert.equal(fact.reportReceipt, undefined)
  assert.deepEqual(law.depends_on, [fact.id])
  const lawRun = runs.find(r => r.title === '법리 검토')
  assert.deepEqual(lawRun.department, { team: '송무팀', role: 'member', rules: '부서 규칙 RULES_MARKER', tools: { 'korean-law': 'allow', bash: 'ask' } })
  assert.match(lawRun.prompt, /원고 주장을 반박하는 준비서면 초안/)
  assert.match(lawRun.prompt, /FACT_REPORT/)
  assert.match(lawRun.prompt, /정리된 사실관계로 법리 검토$/m)
  // Member results stay out of the lawyer's inboxes; the head waits for the blocked member.
  assert.equal(isBoardReport(fact), false)
  assert.equal(board.unreadReportCount(), 0)
  assert.equal(board.approvalCount(), 0)
  assert.match(boardMutationIssue(head, tasks, 'remove'), /하위 업무를 먼저/)
  assert.match(boardMutationIssue(head, tasks, 'update'), /수정할 수 없습니다/)
  assert.equal(runs.filter(r => r.department?.role === 'head').length, 1)

  // After the lawyer resolves the member card, the head combines both reports.
  await board.decide(law.id, 'retry', '권한 없이 진행')
  tasks = await until(ts => ts.some(t => t.id === head.id && t.status === 'awaiting_approval'))
  law = tasks.find(t => t.id === law.id)
  assert.equal(law.status, 'done')
  const synthesis = runs.at(-1)
  assert.equal(synthesis.title, '준비서면 초안')
  assert.equal(synthesis.agent, undefined)
  assert.equal(synthesis.department.role, 'head')
  assert.equal(synthesis.delegation, undefined)
  assert.match(synthesis.prompt, /FACT_REPORT[\s\S]*LAW_REPORT/)
  assert.match((await board.detail(head.id)).report, /FINAL_REPORT/)
  // Spend: the head 0.4 + 0.2 and the fact member 0.7 cross both warning lines once each.
  const costed = tasks.find(t => t.id === head.id)
  assert.equal(costed.cost, 0.6)
  assert.equal(tasks.find(t => t.id === fact.id).cost, 0.7)
  assert.equal(boardInstructionCost(costed, tasks), 1.3)
  assert.equal(costed.log.filter(e => e.text.startsWith('비용 경고 · 지시')).length, 1)
  assert.ok(notes.some(n => n.startsWith('비용 경고 · 송무팀 부서 이번 달 $1.30')))
  assert.equal(JSON.parse(await readFile(join(office, 'usage', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7) + '.json'), 'utf8'))['송무팀'], 1.3)
  assert.equal((await board.snapshot()).departments.usage['송무팀'], 1.3)
  assert.equal(board.approvalCount(), 1)
  const done = tasks.find(t => t.id === head.id)
  await board.decide(head.id, 'approve', '', boardRevision(done, await board.detail(head.id)))
  await until(ts => ts.find(t => t.id === head.id).status === 'done')

  // A department without members: the head handles the instruction alone and reports directly.
  await board.add([{ title: '판결 조사', body: '유사 판결 조사', team: '리서치팀', approval: 'none' }])
  tasks = await until(ts => ts.some(t => t.title === '판결 조사' && t.status === 'done'))
  const direct = tasks.find(t => t.title === '판결 조사')
  assert.deepEqual(runs.at(-1).delegation, { team: '리서치팀', members: [] })
  assert.deepEqual(runs.at(-1).department, { team: '리서치팀', role: 'head', rules: undefined, leadGuide: undefined, tools: undefined })
  assert.equal(runs.at(-1).agent, undefined)
  assert.ok(isBoardReport(direct))
  assert.equal(board.unreadReportCount(), 1)
  assert.equal(tasks.filter(t => t.delegatedBy === direct.id).length, 0)

  // A department removed while its instruction waits stops it with a clear reason instead of running anyone.
  let release
  const occupied = new Promise(resolve => { release = resolve })
  globalThis.boardHoldFixture = occupied
  await board.add([{ title: '점유', body: '점유', agent: 'fact', approval: 'none' }])
  await until(ts => ts.some(t => t.title === '점유' && t.status === 'running'))
  await board.add([{ title: '부서 삭제 후 지시', body: '조사', team: '송무팀' }])
  await board.saveTeams([])
  // Every save keeps the earlier version, which can be restored.
  const history = (await board.snapshot()).departments.history
  assert.equal(history.length, 1)
  assert.equal(history[0].teams, 2)
  const before = runs.length
  release()
  tasks = await until(ts => ts.some(t => t.title === '부서 삭제 후 지시' && t.status === 'blocked'))
  assert.match(tasks.find(t => t.title === '부서 삭제 후 지시').log.at(-1).text, /부서를 찾을 수 없습니다: 송무팀/)
  assert.equal(runs.length, before, 'no session starts for a missing department')
  await board.restoreTeams(history[0].id)
  snapshot = await board.snapshot()
  assert.deepEqual(snapshot.teams.map(t => t.name), ['송무팀', '리서치팀'])
  assert.equal(snapshot.teams[0].rules, '부서 규칙 RULES_MARKER')
  assert.equal(snapshot.departments.history.length, 2)

  // Overlapping descriptions are pointed out.
  await board.saveTeams([{ name: 'A', color: '#376ac6', description: '계약 검토', agents: [] }, { name: 'B', color: '#148369', description: '계약 검토와 자문', agents: [] }])
  assert.deepEqual((await board.snapshot()).departments.overlaps, ['부서 설명이 겹칩니다: A · B'])

  // A board that kept departments before they moved office-wide offers them once.
  const legacyOffice = join(dir, 'legacy-office')
  process.env.LEGAL_TERMINAL_DEPARTMENTS_DIR = legacyOffice
  const legacyFolder = join(dir, 'legacy-case', '_업무지시')
  await mkdir(legacyFolder, { recursive: true })
  await writeFile(join(legacyFolder, 'teams.yaml'), 'teams:\n  - {name: 송무팀, color: "#376ac6", lead: lead, agents: [fact]}\n')
  const legacy = new WorkBoard(join(dir, 'legacy-case'), legacyFolder, join(dir, 'legacy-profile'), () => {})
  await legacy.start()
  assert.deepEqual((await legacy.snapshot()).departments.legacy, [{ name: '송무팀', color: '#376ac6', agents: ['fact'] }])
  await legacy.importLegacyTeams()
  snapshot = await legacy.snapshot()
  assert.deepEqual(snapshot.teams, [{ name: '송무팀', color: '#376ac6', agents: ['fact'] }])
  assert.deepEqual(snapshot.departments.legacy, [])
  await assert.rejects(legacy.importLegacyTeams(), /이미 있습니다/)
  legacy.stop()
  await legacy.snapshot()
  console.log('부서 위임 · 사무소 부서 저장·규칙·도구 권한·앱 부서장·부서원 배분·비용 경고·변경 이력·되돌리기·기존 보드 가져오기 확인')
} finally {
  board?.stop()
  await board?.snapshot()
  delete globalThis.boardRunFixture
  delete globalThis.boardAgentsFixture
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
}
