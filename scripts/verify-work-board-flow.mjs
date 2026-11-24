import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { WorkBoardStore } from '../src/main/workBoardStore.ts'
import { boardRevision } from '../src/shared/workBoard.ts'

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
        contents:'export const {readBoardTodos,getBoardTodoAccount,verifyBoardTodoScope}=globalThis.boardTodoFixture'
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
const checkedScopes = []
globalThis.boardTodoFixture = {
  async getBoardTodoAccount() { if (!account) throw Error('JuriSupport 로그인 필요'); return account },
  async verifyBoardTodoScope(workspace,scope,aliases,requireMapped) {
    checkedScopes.push({workspace,scope,aliases,requireMapped})
    if ((requireMapped && !paired) || (paired && (scope.kind !== 'case' || scope.caseId !== 'case-one'))) throw Error('연결 사건을 다시 확인하세요.')
    return paired
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
const notes = [], runs = []
let board
let gate = null
let afterNativeRead
globalThis.boardRunFixture = async i => {
  runs.push({ id: i.task.id, title: i.task.title, phase: i.phase, agent: i.task.agent, todoAccess:!!i.readTodos, resume: i.resume, tools: i.approvedTools })
  i.onProgress('파일 읽음 · source.md', 'session-' + i.task.id)
  if (i.readTodos) {
    try {
      const text = await i.readTodos()
      afterNativeRead?.()
      return {text}
    }
    catch (e) { return {blocked:true, text:e.message} }
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
  await board.add(['A', 'B', 'C'].map(title => ({ title, body: title, agent: 'writer', approval: 'none' })))
  const batch = [{title:'보존',body:'idempotent',approval:'none'}]
  let tasks = await until(ts => ts.length === 3 && ts.every(t => t.status === 'done'))
  assert.deepEqual(runs.map(r => r.title), ['A', 'B', 'C'])
  assert.ok(runs.every(r => r.agent === 'writer' && r.tools.length === 0))
  for (const t of tasks) assert.match((await board.detail(t.id)).report, /보고/)
  assert.ok((await readdir(join(folder, '_일일보고'))).some(n => n.endsWith('.html')))

  await board.add(batch,'retry-001')
  await board.add(batch,'retry-001')
  await until(ts => ts.some(t => t.title === '보존' && t.status === 'done'))
  assert.equal(runs.filter(r => r.title === '보존').length,1)
  await board.add([{ title: '승인', body: 'prepare', review_agent: 'reviewer', after_approval: 'deliver', allowed_tools: ['mcp__mail__send'] }])
  tasks = await until(ts => ts.some(t => t.status === 'awaiting_approval'))
  const parent = tasks.find(t => t.title === '승인')
  assert.match((await board.detail(parent.id)).review, /review 보고/)
  assert.equal(runs.some(r => r.phase === 'execute'), false)
  await assert.rejects(board.decide(parent.id, 'approve', '', 'old'), /다시 확인/)
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
  await board.add([{title:'저장 직전 변경',body:reportBody,todoScope:scope,review_agent:'reviewer'}])
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
  for (const [index, cwd] of [dir,'ssh://office/cases/one'].entries()) {
    const localFolder = join(dir,'legacy-'+index)
    const legacyStore = new WorkBoardStore(localFolder)
    await legacyStore.init()
    await writeFile(join(localFolder,'legacy.md'), ['---','id: legacy','title: 기존 할일 지시','cwd: '+cwd,index ? 'status: awaiting_approval' : 'status: failed',
      'todoScope: {kind: all}', 'approval: none','---', '쥬리서포트 할일 점검하기'].join('\n'))
    board = new WorkBoard(cwd,localFolder,privateDir,()=>{},()=>['alias'])
    await board.start()
    if (index) {
      const missing = (await board.snapshot()).tasks.find(t => t.id === 'legacy')
      await assert.rejects(approve(missing), /승인할 보고서가 없습니다/)
    }
    await assert.rejects(board.decide('legacy','retry'), /조회 범위/)
    await board.decide('legacy','retry','',undefined,scope)
    await until(ts=>ts.some(t=>t.id==='legacy' && t.status==='done'))
    assert.deepEqual(checkedScopes.at(-1),{workspace:cwd,scope,aliases:['alias'],requireMapped:true})
    assert.deepEqual(reads.at(-1),{scope,account})
    board.stop()
  }
  console.log('업무 보드 배분·보고·결재·차단·복구·검토 상한·위조 방지 확인')
} finally {
  board?.stop()
  delete globalThis.boardRunFixture
  delete globalThis.boardTodoFixture
  await rm(dir, { recursive: true, force: true })
}
