import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
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
      build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
        contents: path === 'remote' ? 'export {}' : 'export const listBoardAgents=async()=>[];export const runBoardAgent=(input)=>globalThis.boardRunFixture(input)'
      }))
    }
  }]
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(mod, mod.exports, require)
const { WorkBoard } = mod.exports
const folder = join(dir, 'tasks'), privateDir = join(dir, 'profile')
const notes = [], runs = []
let board
let gate = null
globalThis.boardRunFixture = async i => {
  runs.push({ id: i.task.id, title: i.task.title, phase: i.phase, agent: i.task.agent, resume: i.resume, tools: i.approvedTools })
  i.onProgress('파일 읽음 · source.md', 'session-' + i.task.id)
  if (i.task.body === 'hold' && gate) await new Promise(resolve => { gate.push(resolve) })
  if (i.task.body === 'confirm' || i.task.body === 'uncertain') return { blocked: true, text: '결재 필요' }
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
  await board.decide(denied.id, 'submit')
  const submitted = (await until(ts => ts.some(t => t.id === denied.id && t.status === 'awaiting_approval'))).find(t => t.id === denied.id)
  await approve(submitted)
  const reported = await until(ts => ts.some(t => t.id === denied.id && t.status === 'done'))
  assert.ok(!reported.some(t => t.parentId === denied.id))
  assert.equal(runs.filter(r => r.id === denied.id).length, beforeSubmit)

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
  console.log('업무 보드 배분·보고·결재·차단·복구·검토 상한·위조 방지 확인')
} finally {
  board?.stop()
  delete globalThis.boardRunFixture
  await rm(dir, { recursive: true, force: true })
}
