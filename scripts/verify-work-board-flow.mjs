import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { WorkBoardStore } from '../src/main/workBoardStore.ts'
import { boardFollowUpRevision, boardRevision } from '../src/shared/workBoard.ts'

// Bundle the real dispatcher and store, replacing only the external Claude service.
const dir = await mkdtemp(join(tmpdir(), 'work-board-flow-'))
const require = createRequire(import.meta.url)
const { outputFiles } = await build({
  entryPoints: ['src/main/workBoard.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{
    name: 'provider-fixture', setup(build) {
      build.onResolve({ filter: /^\.\/workBoardRunner$/ }, () => ({ path: 'runner', namespace: 'mock' }))
      build.onResolve({ filter: /^\.\/remoteFs$/ }, () => ({ path: 'remote', namespace: 'mock' }))
      build.onResolve({ filter: /^\.\/workBoard(?:Todos|Scope)$/ }, ({path}) => ({path,namespace:'todo'}))
      build.onLoad({filter:/.*/,namespace:'todo'}, () => ({
        contents:'export const {readBoardTodos,readBoardMcpTodos,getBoardTodoAccount,verifyBoardTodoScope}=globalThis.boardTodoFixture'
      }))
      build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
        contents: path === 'remote' ? 'export {}' : 'export const listBoardAgents=async()=>[];export const runBoardAgent=(input)=>globalThis.boardRunFixture(input)'
      }))
    }
  }]
})
let account = 'account-one'
let paired = true
const reads = []
const checkedScopes = [], mcpReads = []
globalThis.boardTodoFixture = {
  async getBoardTodoAccount() { if (!account) throw Error('JuriSupport 로그인 필요'); return account },
  async verifyBoardTodoScope(workspace,scope,aliases,requireMapped) {
    checkedScopes.push({workspace,scope,aliases,requireMapped})
    if ((requireMapped && !paired) || (paired && (scope.kind !== 'case' || scope.caseId !== 'case-one'))) throw Error('연결 사건을 다시 확인하세요.')
    return paired
  },
  async readBoardMcpTodos(scope,expectedAccount) {
    if (account !== expectedAccount) throw Error('JuriSupport 로그인 계정이 변경되었습니다.')
    mcpReads.push({scope,account})
    return 'MCP 조회 결과'
  },
  async readBoardTodos(scope,expectedAccount) {
    if (account !== expectedAccount) throw Error('JuriSupport 로그인 계정이 변경되었습니다.')
    reads.push({scope,account})
    return '기한 임박 · 미완료 2건'
  }
}
const mod = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(mod, mod.exports, require)
const { WorkBoard } = mod.exports
const folder = join(dir, 'tasks'), privateDir = join(dir, 'profile')
const notes = [], runs = [], mcpPageErrors = []
let board
let gate = null
let afterNativeRead, afterMcpRead
globalThis.boardRunFixture = async i => {
  runs.push({ id: i.task.id, title: i.task.title, phase: i.phase, agent: i.task.agent, todoAccess:!!i.readTodos, mcpAccess:!!i.readMcpTodos, resume: i.resume, tools: i.approvedTools, prompt:i.prompt })
  i.onProgress('파일 읽음 · source.md', 'session-' + i.task.id)
  if (i.task.body === 'diagnostic-only') return {text:'결재 필요'}
  if (i.readTodos) {
    try {
      const text = await i.readTodos()
      afterNativeRead?.()
      return {text}
    }
    catch (e) { return {blocked:true, text:e.message} }
  }
  if (i.phase === 'work' && i.task.body.startsWith('쥬리서포트 할일을 정리한다')) {
    if (!i.readMcpTodos) {
      i.onProgress('결재 필요 · mcp__jurisupport__list_todos')
      return {blocked:true,text:'## 결재 필요\n\nmcp__jurisupport__list_todos'}
    }
    try {
      const text = await i.readMcpTodos()
      const blocked = afterMcpRead?.()
      const nextPageSnapshot = await i.readMcpTodos()
      assert.equal(nextPageSnapshot,text)
      return {text:'담당자별 요약 · ' + text, blocked}
    } catch (error) { mcpPageErrors.push(error.message); return {text:error.message,blocked:true} }
  }
  if (i.phase === 'review' && i.task.title === '할일 재검토' && i.task.attempts === 0)
    return {rejected:true,text:'자료를 다시 확인해 주세요.'}
  if (i.task.body === 'hold' && gate) await new Promise(resolve => { gate.push(resolve) })
  if (i.task.body === 'confirm') return { blocked:true, text:'## 점검 결과\n초안을 검토했습니다.\n\n## 결재 필요\nmcp__mail__send' }
  if (i.task.body === 'notice only') return { blocked:true, text:'## 결재 필요\n\nmcp__jurisupport__list_todos' }
  if (i.task.body === 'uncertain') return { blocked: true, text: '결재 필요' }
  return { text: i.phase + ' 보고 · ' + i.task.title, rejected: i.phase === 'review' && i.task.body === 'reject' }
}
async function until(check) {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const snapshot = await board.snapshot()
    if (check(snapshot.tasks)) return snapshot.tasks
    await new Promise(r => setTimeout(r, 10))
  }
  throw Error('지시 상태 대기 시간 초과 ' + JSON.stringify((await board.snapshot()).tasks.map(t => [t.title, t.status])) + JSON.stringify(notes))
}
async function approve(task) {
  const detail = await board.detail(task.id)
  await board.decide(task.id, 'approve', '', boardRevision(task, detail))
}
async function open() {
  board = new WorkBoard(dir, folder, privateDir, m => { if (m) notes.push(m) })
  await board.start()
}
try {
  await open()
  await board.configure({ dailyTime: '00:00' })
  await board.add(['A', 'B', 'C'].map(title => ({ title, body: title, agent: 'writer' })))
  const batch = [{title:'보존',body:'idempotent',approval:'none'}]
  let tasks = await until(ts => ts.length === 3 && ts.every(t => t.status === 'done'))
  assert.deepEqual(runs.map(r => r.title), ['A', 'B', 'C'])
  assert.ok(runs.every(r => r.agent === 'writer' && r.tools.length === 0))
  for (const t of tasks) assert.match((await board.detail(t.id)).report, /보고/)
  assert.ok((await readdir(join(folder, '_일일보고'))).some(n => n.endsWith('.html')))

  assert.ok(tasks.every(t => t.approval === 'none' && t.reportReceipt?.state === 'unread'))
  assert.equal(board.approvalCount(),0)
  assert.equal(board.unreadReportCount(),3)
  const [unopened, changedReport] = tasks
  await board.add([{title:'읽기 전 후속 업무',body:'후행 업무',depends_on:[unopened.id]}])
  await until(ts=>ts.some(t=>t.title==='읽기 전 후속 업무' && t.status==='done'))
  const reportFile = join(folder,unopened.id+'.report.md')
  const reportBodyBefore = await readFile(reportFile,'utf8')
  const view = new WorkBoard(dir,folder,join(dir,'reader'),()=>{})
  try {
    await view.start()
    assert.equal((await view.snapshot()).readOnly,true)
    const firstView = boardRevision(unopened,await view.detail(unopened.id))
    assert.equal(view.unreadReportCount(),4,'opening details never acknowledges')
    const priorRuns = runs.length
    await view.decide(unopened.id,'acknowledge','',firstView)
    await view.decide(unopened.id,'acknowledge','',firstView)
    const seen = (await view.snapshot()).tasks.find(t=>t.id===unopened.id)
    assert.equal(seen.status,'done')
    assert.equal(seen.updatedAt,unopened.updatedAt)
    assert.equal(seen.log.filter(e=>e.text==='보고서 확인').length,1)
    assert.deepEqual(seen.reportReceipt,{...unopened.reportReceipt,state:'read'})
    assert.equal(await readFile(reportFile,'utf8'), reportBodyBefore)
    const oldView = boardRevision(changedReport,await view.detail(changedReport.id))
    await writeFile(join(folder,changedReport.id+'.report.md'),'새 보고서')
    await assert.rejects(view.decide(changedReport.id,'acknowledge','',oldView),/다시 확인/)
    assert.equal((await view.snapshot()).tasks.find(t=>t.id===changedReport.id).reportReceipt.state,'unread')
    assert.equal(runs.length,priorRuns)
    await board.refresh()
    assert.equal(board.unreadReportCount(),3,'owner refresh reflects shared acknowledgment')
    await writeFile(reportFile,'다시 쓴 보고서')
    await board.refresh()
    assert.equal(board.unreadReportCount(),4)
    await assert.rejects(board.decide(unopened.id,'acknowledge','',firstView),/다시 확인/)
  } finally { view.stop() }

  await board.add([{title:'진단만 반환',body:'diagnostic-only'}])
  const diagnostic = (await until(ts=>ts.some(t=>t.title==='진단만 반환' && t.status==='blocked'))).find(t=>t.title==='진단만 반환')
  assert.equal(diagnostic.reportReceipt,undefined)
  await assert.rejects(board.decide(diagnostic.id,'acknowledge','',boardRevision(diagnostic,await board.detail(diagnostic.id))),/확인할 업무 보고서/)
  const originalReceipt = (await board.snapshot()).tasks.find(t=>t.id===changedReport.id)
  await board.updateTask(originalReceipt.id,{title:'새 지시',body:'다시 작성'},boardRevision(originalReceipt,await board.detail(originalReceipt.id)))
  const edited = (await board.snapshot()).tasks.find(t=>t.id===originalReceipt.id)
  assert.equal(edited.reportReceipt,undefined)
  assert.equal(edited.approval,'none')
  assert.equal((await board.detail(edited.id)).report,'')
  await board.decide(edited.id,'retry')
  const rerun = (await until(ts=>ts.some(t=>t.id===edited.id && t.status==='done'))).find(t=>t.id===edited.id)
  assert.equal(rerun.reportReceipt.state,'unread')
  assert.notEqual(rerun.reportReceipt.digest,originalReceipt.reportReceipt.digest)
  const plain = {title:'링크 없는 지시',body:'직접 입력',followUp:{id:'injected',title:'가짜',body:'참고 아님'}}
  await board.add([plain])
  const unlinked = (await until(ts=>ts.some(t=>t.title===plain.title && t.status==='done'))).find(t=>t.title===plain.title)
  assert.equal(unlinked.followUp,undefined)
  const fromDiagnostic = await board.addFollowUp(diagnostic.id,{title:'원인 확인',body:'확인해 주세요'},'diag',
    boardFollowUpRevision(diagnostic,await board.detail(diagnostic.id)))
  assert.deepEqual((await board.snapshot()).tasks.find(t=>t.id===fromDiagnostic).followUp,
    {id:diagnostic.id,title:diagnostic.title,body:diagnostic.body})

  await board.add(batch,'retry-001')
  await board.add(batch,'retry-001')
  await until(ts => ts.some(t => t.title === '보존' && t.status === 'done'))
  assert.equal(runs.filter(r => r.title === '보존').length,1)
  await board.add([{ title: '승인', body: 'prepare', agent:'source-writer', review_agent: 'reviewer', after_approval: 'deliver', allowed_tools: ['mcp__mail__send'] }])
  tasks = await until(ts => ts.some(t => t.status === 'awaiting_approval'))
  const parent = tasks.find(t => t.title === '승인')
  assert.match((await board.detail(parent.id)).review, /review 보고/)
  assert.equal(runs.some(r => r.phase === 'execute'), false)
  await assert.rejects(board.decide(parent.id, 'approve', '', 'old'), /다시 확인/)
  await assert.rejects(board.decide(parent.id,'retryReport','',boardRevision(parent,await board.detail(parent.id))), /보고 전용/)
  const parentDetail = await board.detail(parent.id)
  const parentRevision = boardRevision(parent,parentDetail)
  const viewedSource = boardFollowUpRevision(parent,parentDetail)
  const childDraft = {title:'별도 후속 업무',body:'현재 요청만 처리'}
  const reference = {id:parent.id,title:parent.title,body:parent.body,report:parentDetail.report}
  const submitter = new WorkBoard(dir,folder,join(dir,'follow-up-submitter'),()=>{})
  let childId
  try {
    await submitter.start()
    assert.equal((await submitter.snapshot()).readOnly,true)
    const reportPath = join(folder,parent.id+'.report.md')
    await writeFile(reportPath,'바뀐 원 보고서')
    await assert.rejects(submitter.addFollowUp(parent.id,childDraft,'attempt',viewedSource),/다시 확인/)
    await writeFile(reportPath,parentDetail.report)
    childId = await submitter.addFollowUp(parent.id,childDraft,'attempt',viewedSource)
    assert.equal(await submitter.addFollowUp(parent.id,childDraft,'attempt',viewedSource),childId)
    await assert.rejects(submitter.addFollowUp(parent.id,{...childDraft,body:'다른 작업'},'attempt',viewedSource),/요청 번호/)
    const noConsent = await submitter.addFollowUp(parent.id,{title:'후속 할일',body:'할일 검토',todoScope:{kind:'all'}},'native-attempt',viewedSource)
    const native = (await submitter.snapshot()).tasks.find(t=>t.id===noConsent)
    assert.equal(native.status,'blocked')
    assert.equal(runs.some(r=>r.id===noConsent),false)
  } finally { submitter.stop(); await submitter.snapshot() }

  board.stop()
  await board.snapshot()
  await open()
  const linked = (await until(ts=>ts.some(t=>t.id===childId && t.status==='done'))).find(t=>t.id===childId)
  assert.deepEqual(linked.followUp,reference)
  for (const field of ['agent','review_agent','parentId','depends_on','after_approval','allowed_tools']) assert.equal(linked[field],undefined)
  assert.equal(linked.approval,'none')
  assert.equal(linked.reportReceipt.state,'unread')
  const childRun = runs.find(r=>r.id===childId)
  assert.deepEqual(childRun.tools,[])
  assert.match(childRun.prompt,/원 지시.*참고자료/)
  assert.ok(childRun.prompt.includes(JSON.stringify(reference)) && childRun.prompt.includes(childDraft.body))
  assert.ok(!childRun.prompt.includes('mcp__mail__send') && !childRun.prompt.includes(parentDetail.review))
  assert.equal(boardRevision((await board.snapshot()).tasks.find(t=>t.id===parent.id),await board.detail(parent.id)),parentRevision)

  const linkedDetail = await board.detail(childId)
  const linkedRevision = boardFollowUpRevision(linked,linkedDetail)
  // Reading a report changes the receipt and timeline, but not the reference the user saw.
  await board.decide(childId,'acknowledge','',boardRevision(linked,linkedDetail))
  const viewed = (await board.snapshot()).tasks.find(t=>t.id===childId)
  assert.notEqual(boardRevision(viewed,linkedDetail),boardRevision(linked,linkedDetail))
  assert.equal(boardFollowUpRevision(viewed,linkedDetail),linkedRevision)
  const nextDraft = {title:'두 번째 후속',body:'별도 수행'}
  const nextId = await board.addFollowUp(childId,nextDraft,'next',linkedRevision)
  const next = (await until(ts=>ts.some(t=>t.id===nextId && t.status==='done'))).find(t=>t.id===nextId)
  assert.deepEqual(next.followUp,{id:childId,title:linked.title,body:linked.body,report:linkedDetail.report})
  await board.updateTask(childId,{...childDraft,body:'수정된 지시',followUp:{id:'spoofed'}},boardRevision(viewed,linkedDetail))
  const editedSource = (await board.snapshot()).tasks.find(t=>t.id===childId)
  assert.deepEqual(editedSource.followUp,reference)
  await assert.rejects(board.addFollowUp(childId,nextDraft,'stale-after-edit',linkedRevision),/다시 확인/)
  await board.removeTask(childId,boardRevision(editedSource,await board.detail(childId)))
  assert.equal(await board.addFollowUp(childId,nextDraft,'next',linkedRevision),nextId)
  assert.deepEqual((await new WorkBoardStore(folder).readTask(nextId)).followUp,next.followUp)
  await assert.rejects(board.addFollowUp(childId,nextDraft,'new',linkedRevision),/찾을 수 없습니다/)
  await approve(parent)
  await until(ts => ts.find(t => t.id === parent.id).status === 'done')
  assert.equal(runs.filter(r => r.phase === 'execute').length, 1)
  assert.deepEqual(runs.find(r => r.phase === 'execute').tools, ['mcp__mail__send'])
  await board.add([{ title: '확인', body: 'confirm' }, { title: '검토 반려', body: 'reject', review_agent: 'compliance' }])
  await until(ts => ts.some(t => t.status === 'blocked') && ts.some(t => t.status === 'failed'))
  assert.match((await board.detail((await board.snapshot()).tasks.find(t => t.title === '확인').id)).report, /결재 필요/)
  assert.equal(runs.filter(r => r.title === '검토 반려' && r.phase === 'review').length, 3)

  const denied = (await board.snapshot()).tasks.find(t => t.title === '확인')
  const beforeSubmit = runs.filter(r => r.id === denied.id).length
  await assert.rejects(board.decide(denied.id, 'submit', '', 'old'), /다시 확인/)
  await board.decide(denied.id, 'submit', '', boardRevision(denied, await board.detail(denied.id)))
  const submitted = (await until(ts => ts.some(t => t.id === denied.id && t.status === 'awaiting_approval'))).find(t => t.id === denied.id)
  await approve(submitted)
  const reported = await until(ts => ts.some(t => t.id === denied.id && t.status === 'done'))
  assert.ok(!reported.some(t => t.parentId === denied.id))
  assert.equal(runs.filter(r => r.id === denied.id).length, beforeSubmit)

  await board.add([{title:'도구 요청 기록만 있음',body:'notice only'}])
  const notice = (await until(ts => ts.some(t => t.title === '도구 요청 기록만 있음' && t.status === 'blocked'))).find(t => t.title === '도구 요청 기록만 있음')
  await assert.rejects(board.decide(notice.id, 'submit', '', boardRevision(notice, await board.detail(notice.id))), /보고서/)
  assert.equal((await board.snapshot()).tasks.find(t => t.id === notice.id).status, 'blocked')

  await board.add([{ title: '결과 미상', body: 'prepare', after_approval: 'uncertain' }])
  const ambiguous = (await until(ts => ts.some(t => t.title === '결과 미상' && t.status === 'awaiting_approval'))).find(t => t.title === '결과 미상')
  await approve(ambiguous)
  const child = (await until(ts => ts.some(t => t.id === ambiguous.id && t.status === 'blocked'))).find(t => t.parentId === ambiguous.id)
  await assert.rejects(board.decide(child.id, 'retry'), /재실행/)
  await board.decide(child.id, 'complete', '대상 시스템에서 결과 확인')
  await until(ts => ts.some(t => t.id === ambiguous.id && t.status === 'done'))

  await board.add([{ title: '재결재', body: 'prepare', after_approval: 'uncertain' }])
  const resubmit = (await until(ts => ts.some(t => t.title === '재결재' && t.status === 'awaiting_approval'))).find(t => t.title === '재결재')
  await approve(resubmit)
  const uncertain = (await until(ts => ts.some(t => t.id === resubmit.id && t.status === 'blocked'))).find(t => t.parentId === resubmit.id)
  await board.decide(uncertain.id, 'reject', '미수행을 확인함')
  const toApprove = (await until(ts => ts.some(t => t.id === resubmit.id && t.status === 'awaiting_approval'))).find(t => t.id === resubmit.id)
  await approve(toApprove)
  await until(ts => ts.filter(t => t.parentId === resubmit.id).length === 2 && ts.some(t => t.id === resubmit.id && t.status === 'blocked'))
  assert.equal(runs.filter(r => r.title === '승인 후 실행 · 재결재').length, 2)

  await board.configure({ concurrency: 2 })
  gate = []
  await board.add(['선행1', '선행2'].map(title => ({ title, body: 'hold', approval: 'none' })))
  const parallel = await until(ts => ts.filter(t => t.status === 'running').length === 2 && gate.length === 2)
  const first = parallel.find(t => t.title === '선행1')
  await board.add(['후속1', '후속2'].map(title => ({ title, body: title, approval: 'none', depends_on: [first.id] })))
  const waiting = (await board.snapshot()).tasks.filter(t => t.status === 'queued')
  assert.deepEqual(waiting.map(t => t.title), ['후속1', '후속2'])
  await board.reorder(waiting.map(t => t.id).reverse())
  await board.configure({ concurrency: 1 })
  for (const unblock of gate) unblock()
  gate = null
  await until(ts => ts.filter(t => t.title.startsWith('후속') && t.status === 'done').length === 2)
  assert.deepEqual(runs.filter(r => r.title.startsWith('후속')).map(r => r.title), ['후속2', '후속1'])

  await board.configure({ restart: 'resume' })
  gate = []
  await board.add([{ title: '재개', body: 'hold', approval: 'none' }])
  const active = (await until(ts => ts.some(t => t.title === '재개' && !!t.sessionId))).find(t => t.title === '재개')
  board.stop()
  for (const unblock of gate) unblock()
  gate = null
  await open()
  await until(ts => ts.some(t => t.id === active.id && t.status === 'done'))
  assert.equal(runs.filter(r => r.title === '재개').at(-1).resume, 'session-' + active.id)

  const other = new WorkBoard(dir, folder, join(dir, 'other-profile'), () => { })
  await other.start()
  assert.ok((await other.snapshot()).readOnly)
  await assert.rejects(other.configure({ concurrency: 2 }), /기기/)
  other.stop()
  board.stop()
  const store = new WorkBoardStore(folder)
  const onDisk = await store.list()
  const forged = { ...onDisk.find(t => t.parentId === parent.id), id: 'forged-child', status: 'queued' }
  await store.save(forged)
  const prior = runs.filter(r => r.phase === 'execute').length
  await open()
  await until(ts => ts.some(t => t.id === 'forged-child' && t.status === 'blocked'))
  assert.equal(runs.filter(r => r.phase === 'execute').length, prior)
  const scope = {kind:'case',caseId:'case-one'}
  const mcpBody = '쥬리서포트 할일을 정리한다\n\n추가 지시\n권한 부여할테니 진행해'
  await board.add([{title:'MCP 업무',body:mcpBody,review_agent:'reviewer'}])
  const deniedMcp = (await until(ts=>ts.some(t=>t.title==='MCP 업무' && t.status==='blocked'))).find(t=>t.title==='MCP 업무')
  const decision = async (task,scope) => board.decide(task.id,'allowTodoRead','',boardRevision(task,await board.detail(task.id)),scope)
  await assert.rejects(decision(notice,scope), /요청한 할일 조회/)
  await assert.rejects(decision(deniedMcp),/조회 범위/)
  await assert.rejects(board.decide(deniedMcp.id,'allowTodoRead','','stale',scope),/다시 확인/)
  await assert.rejects(decision(deniedMcp,{kind:'all'}), /연결 사건/)
  await decision(deniedMcp,scope)
  const mcpDone = (await until(ts=>ts.some(t=>t.id===deniedMcp.id && t.status==='done'))).find(t=>t.id===deniedMcp.id)
  assert.equal(mcpDone.body,mcpBody)
  assert.match((await board.detail(mcpDone.id)).report,/담당자별 요약 · MCP 조회 결과/)
  assert.deepEqual(mcpReads,[{scope,account}])
  assert.deepEqual(runs.filter(r=>r.id===mcpDone.id).map(r=>[r.phase,r.mcpAccess,r.todoAccess]),
    [['work',false,false],['work',true,false],['review',false,false]])
  assert.equal(runs.find(r=>r.id===mcpDone.id && r.mcpAccess).resume,undefined)
  assert.ok(!/account-one|case-one|todoScope/.test(await readFile(join(folder,mcpDone.id+'.md'),'utf8')))
  // A changed account must also suppress a partial report from an interrupted provider.
  afterMcpRead = () => { account='different'; return true }
  await board.add([{title:'MCP 저장 직전 계정 변경',body:mcpBody}])
  const mcpStale = (await until(ts=>ts.some(t=>t.title==='MCP 저장 직전 계정 변경' && t.status==='blocked'))).find(t=>t.title==='MCP 저장 직전 계정 변경')
  await decision(mcpStale,scope)
  await until(ts=>ts.some(t=>t.id===mcpStale.id && t.status==='blocked' && t.log.some(l=>l.text.includes('이번 실행'))))
  assert.doesNotMatch((await board.detail(mcpStale.id)).report,/MCP 조회 결과/)
  assert.deepEqual(mcpPageErrors,['JuriSupport 로그인 계정이 변경되었습니다.'],'cached pages require the same live account')
  afterMcpRead = undefined
  await board.decide(mcpStale.id,'retry','')
  await until(ts=>ts.some(t=>t.id===mcpStale.id && t.status==='blocked' && t.log.at(-2)?.text.includes('list_todos')))
  assert.equal(mcpReads.length,2,'an ordinary retry cannot reuse the consumed permission')
  account = 'account-one'
  const reportBody = '할일 검토해줘'
  await board.add([{title:'조회', body:reportBody, todoScope:scope, review_agent:'reviewer', after_approval:'확인한 결과 전달'}])
  const reviewTask = (await until(ts=>ts.some(t=>t.title==='조회' && t.status==='awaiting_approval'))).find(t=>t.title==='조회')
  assert.match((await board.detail(reviewTask.id)).report,/미완료 2건/)
  assert.deepEqual(reads,[{scope, account}])
  assert.ok(!/account-one|case-one|todoScope/.test(await readFile(join(folder,reviewTask.id+'.md'),'utf8')))
  await approve(reviewTask)
  await until(ts=>ts.some(t=>t.id===reviewTask.id && t.status==='done'))
  assert.deepEqual(runs.filter(r=>r.id===reviewTask.id).map(r=>r.todoAccess),[true,false])
  assert.ok(runs.filter(r=>r.phase==='execute').every(r=>!r.todoAccess))

  gate = []
  await board.add([{title:'대기 장치',body:'hold',approval:'none'}])
  await until(()=>gate.length===1)
  await board.add([{title:'계정 변경',body:reportBody,todoScope:scope,approval:'none'}])
  account = 'account-two'
  for (const unblock of gate) unblock()
  gate = null
  const switched = (await until(ts=>ts.some(t=>t.title==='계정 변경' && t.status==='blocked'))).find(t=>t.title==='계정 변경')
  assert.equal(reads.length,1)
  await assert.rejects(board.decide(switched.id,'retry'), /계정/)
  await assert.rejects(board.decide(switched.id,'submit'), /결재 요청/)
  paired = false
  await assert.rejects(board.decide(switched.id,'retry'), /연결 사건/)
  paired = true
  await board.decide(switched.id,'retry','로그인 후 재시도',undefined,scope)
  await until(ts=>ts.some(t=>t.id===switched.id && t.status==='done'))
  assert.deepEqual(reads.at(-1),{scope,account})

  // Files synchronized from another installation can describe a request but cannot grant account access.
  board.stop()
  const text = await readFile(join(folder,switched.id+'.md'),'utf8')
  await writeFile(join(folder,switched.id+'.md'),text.replace(/^status: done$/m,'status: queued'))
  await open()
  await until(ts=>ts.some(t=>t.id===switched.id && t.status==='blocked'))
  assert.equal(reads.length,2,'a completed grant cannot be replayed from synced YAML')
  paired = false
  await board.add([{title:'할일 재검토',body:reportBody,review_agent:'reviewer',approval:'none',todoScope:{kind:'all'}}])
  await until(ts=>ts.some(t=>t.title==='할일 재검토' && t.status==='done'))
  assert.equal(reads.length,4,'a genuine review rejection may cause one fresh native lookup')
  assert.deepEqual(reads.slice(-2).map(r=>r.scope),[{kind:'all'},{kind:'all'}])

  paired = true

  // Changing an immutable field of a pending task invalidates even an unspent grant.
  const unmet = (await board.snapshot()).tasks.find(t=>t.id===switched.id)
  await board.add([{title:'변경 전 지시',body:reportBody,depends_on:[unmet.id],todoScope:scope}])
  const pending = (await board.snapshot()).tasks.find(t=>t.title==='변경 전 지시')
  board.stop()
  const changed = new WorkBoardStore(folder)
  await changed.list()
  await changed.save({...pending,title:'변경된 지시',depends_on:[]})
  await open()
  await until(ts=>ts.some(t=>t.id===pending.id && t.status==='blocked'))
  assert.equal(reads.length,4)
  // A previously successful result must not survive an account or scope change on retry.
  await board.add([{title:'저장 직전 변경',body:reportBody,todoScope:scope,review_agent:'reviewer',approval:'required'}])
  const stale = (await until(ts=>ts.some(t=>t.title==='저장 직전 변경' && t.status==='awaiting_approval'))).find(t=>t.title==='저장 직전 변경')
  assert.match((await board.detail(stale.id)).report,/미완료 2건/)
  await board.decide(stale.id,'reject','재조회 요청')
  for (const change of [() => { account = 'account-three' }, () => { paired = false }]) {
    afterNativeRead = change
    await board.decide(stale.id,'retry','',undefined,scope)
    await until(ts=>ts.some(t=>t.id===stale.id && t.status==='blocked'))
    const detail = await board.detail(stale.id)
    assert.match(detail.report,/조회 범위/)
    assert.doesNotMatch(detail.report,/미완료 2건/)
    await assert.rejects(board.decide(stale.id,'submit'), /결재 요청/)
    await assert.rejects(board.decide(stale.id,'approve'), /결재 대기/)
    assert.equal(runs.filter(r=>r.id===stale.id && r.phase==='review').length,1)
  }
  afterNativeRead = undefined
  await assert.rejects(board.decide(stale.id,'retry'), /연결 사건/)
  await board.decide(stale.id,'retry','새 조회 범위 확인',undefined,scope)
  await until(ts=>ts.some(t=>t.id===stale.id && t.status==='awaiting_approval'))
  assert.equal(checkedScopes.at(-1).requireMapped,false)
  paired = true
  board.stop()
  // Replaying the very same queued request from the shared folder cannot restore its private grant.
  const grantIndex = mcpDone.log.findIndex(l=>l.text==='JuriSupport 할일 조회 허용 · 이번 실행')
  assert.ok(grantIndex > 0)
  await changed.save({...mcpDone,status:'queued',reportReceipt:undefined,log:mcpDone.log.slice(0,grantIndex+1)})
  const runsBeforeReplay = runs.length
  await open()
  await until(ts=>ts.some(t=>t.id===mcpDone.id && t.status==='blocked'))
  assert.equal(runs.length,runsBeforeReplay)
  assert.equal(mcpReads.length,2)
  board.stop()
  for (const [index, cwd] of [dir,'ssh://office/cases/one'].entries()) {
    const localFolder = join(dir,'legacy-'+index)
    const legacyStore = new WorkBoardStore(localFolder)
    await legacyStore.init()
    await writeFile(join(localFolder,'legacy.md'), ['---','id: legacy','title: 기존 할일 지시','cwd: '+cwd,index ? 'status: awaiting_approval' : 'status: failed',
      'todoScope: {kind: all}', 'approval: required', 'review_agent: reviewer','---', '쥬리서포트 할일 점검하기'].join('\n'))
    board = new WorkBoard(cwd,localFolder,privateDir,()=>{},()=>['alias'])
    await board.start()
    if (index) {
      const missing = (await board.snapshot()).tasks.find(t => t.id === 'legacy')
      await assert.rejects(approve(missing), /승인할 보고서가 없습니다/)
    }
    await assert.rejects(board.decide('legacy','retry'), /조회 범위/)
    const legacy = (await board.snapshot()).tasks.find(t=>t.id==='legacy')
    const revision = boardRevision(legacy,await board.detail(legacy.id))
    assert.equal(legacy.approval,'required')
    await assert.rejects(board.decide('legacy','retryReport','','stale',scope),/다시 확인/)
    await board.decide('legacy','retryReport','',revision,scope)
    const retried = (await until(ts=>ts.some(t=>t.id==='legacy' && t.status==='done'))).find(t=>t.id==='legacy')
    assert.equal(retried.approval,'none')
    assert.equal(retried.reportReceipt.state,'unread')
    assert.equal(retried.review_agent,'reviewer')
    assert.match((await board.detail('legacy')).review,/review 보고/)
    assert.deepEqual(checkedScopes.at(-1),{workspace:cwd,scope,aliases:['alias'],requireMapped:true})
    assert.deepEqual(reads.at(-1),{scope,account})
    board.stop()
  }
  console.log('업무 보드 배분·보고·결재·차단·복구·검토 상한·위조 방지 확인')
} finally {
  board?.stop()
  await board?.snapshot()
  delete globalThis.boardRunFixture
  delete globalThis.boardTodoFixture
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
}
