// Two independent app profiles share real board files; only inference is replaced.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { WorkBoardStore } from '../src/main/workBoardStore.ts'
import { boardRevision } from '../src/shared/workBoard.ts'

const result = await build({
  entryPoints: ['src/main/workBoard.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{
    name: 'providers', setup(build) {
      build.onResolve({ filter: /^\.\/(?:workBoardRunner|workBoardTodos|workBoardScope|remoteFs)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `
      export const runBoardAgent=i=>globalThis.handoffRun(i), listBoardAgents=async()=>[], boardRunCost=()=>undefined;
      export const getBoardTodoAccount=async()=>'fixture', readBoardTodos=async()=>'todo', readBoardMcpTodos=async()=>'[]', verifyBoardTodoScope=async()=>false;
    `}))
    }
  }]
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url))
const { WorkBoard } = mod.exports
const root = await mkdtemp(join(tmpdir(), 'board-handoff-'))
// Office departments live outside the board; keep them in the test folder.
process.env.LEGAL_TERMINAL_DEPARTMENTS_DIR = join(root, 'departments')
const effects = []
const executions = []
let resumeReport
let enteredEffect
let finishEffect
let releaseRun
const boards = []
globalThis.handoffRun = async input => {
  executions.push(input.task.id)
  if (input.task.title === '보고서 저장 경합') await new Promise(resolve => { resumeReport = resolve })
  if (input.task.title === '실행 보호') {
    await input.withOwnership(async () => {
      enteredEffect = true
      await new Promise(resolve => { finishEffect = resolve })
    })
  }
  if (input.task.title === '인계 중 수행') {
    await new Promise(resolve => { releaseRun = resolve })
    await input.withOwnership(async () => { effects.push('stale effect') })
  }
  if (input.phase === 'execute') await input.withOwnership(async () => { effects.push(input.task.body) })
  return { text: '보고서' }
}
async function open(workspace, folder, profile) {
  const board = new WorkBoard(workspace, folder, join(root, profile), () => { })
  boards.push(board)
  await board.start()
  return board
}
async function until(board, check) {
  const limit = Date.now() + 6000
  while (Date.now() < limit) {
    const snapshot = await board.snapshot()
    if (check(snapshot)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 8))
  }
  throw Error('보드 전이 확인 시간 초과')
}
try {
  const folder = join(root, 'shared')
  const wsA = 'ssh://first/cases/one', wsB = 'ssh://second/cases/one'
  const a = await open(wsA, folder, 'A')
  const b = await open(wsB, folder, 'B')
  const before = await b.snapshot()
  assert.equal(before.readOnly, true)
  assert.notEqual(before.ownerRevision, await readFile(join(folder, '_배분기'), 'utf8'))
  await assert.rejects(b.takeOwnership('wrong'), /다시 확인/)
  const submitterStore = new WorkBoardStore(folder)
  const token = await readFile(join(folder, '_배분기'), 'utf8')
  await a.add([{ title: '보고서 저장 경합', body: 'finish-while-busy', approval: 'none' }])
  const pending = await until(a, s => resumeReport && s.tasks.some(t => t.status === 'running'))
  const reportId = pending.tasks.find(t => t.title === '보고서 저장 경합').id
  await submitterStore.withOwner(token, async () => {
    resumeReport()
    await new Promise(resolve => setTimeout(resolve, 350))
  })
  await until(a, s => s.tasks.some(t => t.id === reportId && t.status === 'done'))
  assert.equal(executions.filter(id => id === reportId).length, 1)
  assert.equal((await a.detail(reportId)).report, '보고서')

  // Even an old activity timestamp cannot authorize taking an ongoing effect's lease.
  await a.add([{ title: '실행 보호', body: 'critical', approval: 'none' }])
  const deadline = Date.now() + 3000
  while (!enteredEffect && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(enteredEffect)
  await utimes(join(folder, '_배분기-활동'), 1, 1)
  await assert.rejects(b.takeOwnership(before.ownerRevision), error => error.code === 'BOARD_BUSY')
  finishEffect()
  await until(a, s => s.tasks.some(t => t.title === '실행 보호' && t.status === 'done'))
  await a.add([{ title: '인계 중 수행', body: 'hold', approval: 'none' }])
  await until(a, s => releaseRun && s.tasks.some(t => t.status === 'running'))
  await assert.rejects(b.takeOwnership(before.ownerRevision), /수행 중/)
  // A suspended old dispatcher stops renewing; all subsequent effects still need the ownership fence.
  await utimes(join(folder, '_배분기-활동'), 1, 1)
  await b.takeOwnership(before.ownerRevision)
  releaseRun()
  await until(a, s => s.readOnly)
  assert.deepEqual(effects, [])
  await assert.rejects(a.configure({ concurrency: 2 }))
  const transferred = await b.snapshot()
  assert.equal(transferred.readOnly, false)
  const interrupted = transferred.tasks.find(t => t.title === '인계 중 수행')
  assert.equal(interrupted.status, 'blocked')
  assert.equal(interrupted.cwd, wsB)
  await assert.rejects(a.takeOwnership(before.ownerRevision))
  b.stop()
  const reopened = await open(wsB, folder, 'B')
  assert.equal((await reopened.snapshot()).readOnly, false)
  reopened.stop()
  a.stop()

  const legacyFolder = join(root, 'legacy')
  const store = new WorkBoardStore(legacyFolder)
  await store.init()
  await store.claimOwner('old-device')
  const stamp = new Date().toISOString()
  async function seed(id, status, extra = {}) {
    await store.save({ id, status, title: id, body: id, cwd: wsA, approval: 'none', order: 0, attempts: 0, createdAt: stamp, updatedAt: stamp, log: [], ...extra })
  }
  await seed('review', 'in_review', { sessionId: 'old-session', review_agent: 'reviewer' })
  await seed('missing', 'approved', { after_approval: '외부 실행 없음 확인', approval: 'required' })
  await seed('parent', 'approved', { after_approval: '승인된 단계', approval: 'required' })
  await seed('legacy-child', 'running', { parentId: 'parent' })
  await seed('previously-failed', 'failed')
  await seed('different', 'blocked', { cwd: '/unrelated/previous-mount' })
  await seed('waiting', 'queued')
  const first = await open('/cases/one', legacyFolder, 'legacyA')
  const second = await open('/cases/one', legacyFolder, 'legacyB')
  const revision = (await first.snapshot()).ownerRevision
  const attempts = await Promise.allSettled([first.takeOwnership(revision), second.takeOwnership(revision)])
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
  const winner = attempts[0].status === 'fulfilled' ? first : second
  const acquired = await until(winner, s => s.tasks.some(t => t.id === 'waiting' && t.status === 'done'))
  const task = id => acquired.tasks.find(t => t.id === id)
  assert.equal(task('review').status, 'blocked')
  assert.equal(task('review').sessionId, undefined)
  assert.equal(task('parent').status, 'blocked')
  assert.equal(task('legacy-child').status, 'blocked')
  assert.equal(task('previously-failed').cwd, '/cases/one')
  assert.equal(task('different').cwd, '/unrelated/previous-mount')
  assert.equal(acquired.tasks.find(t => t.parentId === 'missing').status, 'blocked')
  assert.deepEqual(effects, [])
  await winner.decide('legacy-child', 'complete', '기존 시스템에서 완료 확인')
  assert.equal((await winner.snapshot()).tasks.find(t => t.id === 'parent').status, 'done')
  const child = acquired.tasks.find(t => t.parentId === 'missing')
  await winner.decide(child.id, 'reject', '실행되지 않음을 확인함')
  const parent = (await winner.snapshot()).tasks.find(t => t.id === 'missing')
  assert.equal(parent.status, 'awaiting_approval')
  await assert.rejects(winner.decide(parent.id, 'approve', '', boardRevision(parent, await winner.detail(parent.id))), /승인할 보고서가 없습니다/)
  await store.writeText('missing.report.md', '검토를 마쳤습니다. 별도 실행 승인을 요청합니다.')
  await winner.decide(parent.id, 'approve', '', boardRevision(parent, await winner.detail(parent.id)))
  await until(winner, s => s.tasks.find(t => t.id === parent.id)?.status === 'done')
  assert.deepEqual(effects, ['외부 실행 없음 확인'])
  await winner.decide('different', 'retry')
  await winner.decide('previously-failed', 'retry')
  await until(winner, s => ['different', 'previously-failed'].every(id => s.tasks.find(t => t.id === id)?.status === 'done'))
  assert.equal((await winner.snapshot()).tasks.find(t => t.id === 'different').cwd, '/cases/one')
  const viewer = await open('/cases/one', legacyFolder, 'viewer')
  const obsolete = (await viewer.snapshot()).tasks.find(t => t.id === 'waiting')
  await winner.removeTask(obsolete.id, boardRevision(obsolete, await winner.detail(obsolete.id)))
  await assert.rejects(viewer.add([{ title: '삭제된 선행 지시', body: '의존', depends_on: [obsolete.id] }]), /찾을 수 없습니다/)
  console.log('명시적 배분기 인계, 동시 취득·이전 기기 실행 차단, 결재 결과 확인·재결재, 원격 경로 재연결 확인')
} finally {
  for (const board of boards) board.stop()
  releaseRun?.()
  resumeReport?.()
  finishEffect?.()
  delete globalThis.handoffRun
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
