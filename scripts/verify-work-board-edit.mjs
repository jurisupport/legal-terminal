import assert from 'node:assert/strict'
import { verifyBoardDownloads } from './fixtures/work-board-downloads.mjs'
import { verifyBoardDocuments } from './fixtures/work-board-documents.mjs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { WorkBoardStore } from '../src/main/workBoardStore.ts'
import { boardRevision } from '../src/shared/workBoard.ts'

const tmp = await realpath(await mkdtemp(join(tmpdir(), 'board-edit-')))
// Office departments live outside the board; keep them in the test folder.
process.env.LEGAL_TERMINAL_DEPARTMENTS_DIR = join(tmp, 'departments')
const folder = join(tmp, 'board'), app = join(tmp, 'app')
const source = new WorkBoardStore(folder)
const events = [], runs = []
const held = []
globalThis.editTestRunner = async ({ task, phase }) => {
  runs.push([task.id,phase])
  if (task.id === 'busy') await new Promise(resolve => held.push(resolve))
  return {text:'새 보고 · ' + task.title}
}
const result = await build({
  stdin:{contents:"export {WorkBoard} from './src/main/workBoard'; export * from './src/main/workBoardDownload'",resolveDir:process.cwd()},
  bundle:true,write:false,format:'cjs',platform:'node',external:['electron'],
  plugins:[{name:'isolated-board',setup(b) {
    b.onResolve({filter:/^\.\/(?:workBoardRunner|workBoardScope|workBoardTodos|remoteFs)$/}, a=>({path:a.path,namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:{
      './workBoardRunner':'export const listBoardAgents=async()=>[]; export const boardRunCost=()=>undefined; export const runBoardAgent=globalThis.editTestRunner',
      './workBoardScope':'export const verifyBoardTodoScope=async()=>true',
      './workBoardTodos':'export const getBoardTodoAccount=async()=>"test-account"; export const readBoardMcpTodos=async()=>"[]"; export const readBoardTodos=async()=>"미완료 0건"',
      './remoteFs':'export {}'
    }[path]}))
  }}]
})
const module = {exports:{}}
let saveDialog
const require = createRequire(import.meta.url)
const localFs = require('node:fs/promises')
new Function('module','exports','require',result.outputFiles[0].text)(module,module.exports, name => {
  if (name === 'electron') return {app:{getPath:()=>tmp},dialog:{showSaveDialog:(...args)=>saveDialog(...args)}}
  if (name === 'node:fs/promises') return {...localFs, async link(from,to) {
    if (!from.includes('.legal-download-')) return localFs.link(from,to)
    if (to.endsWith('동시 저장.md')) await localFs.writeFile(to,'다른 사용자의 저장',{flag:'wx'})
    throw Object.assign(Error('removable volume without hard links'),{code:'ENOTSUP'})
  }, async rename(from,to) {
    if (from.includes('.legal-download-') && to.endsWith('저장 실패.md')) throw Error('fixture blocked publication')
    return localFs.rename(from,to)
  }}
  return require(name)
})
const {WorkBoard} = module.exports
const board = new WorkBoard(tmp,folder,app,message=>events.push(message))
let viewer
const at = new Date().toISOString()
async function seed(id,status,fields = {}) {
  const task = {id,status,title:id,body:'변경 전',cwd:tmp,order:0,createdAt:at,updatedAt:at,attempts:1,
    approval:'required',log:[{at,text:'이전 이력'}],...fields}
  await source.save(task)
}
const snapshot = async id => (await board.snapshot()).tasks.find(t=>t.id===id)
const revision = async id => boardRevision(await snapshot(id),await board.detail(id))
const fields = {title:'새 제목',body:'새 본문',agent:'새 담당',review_agent:'새 검토',due:'2026-12-01',
  approval:'required',after_approval:'별도 실행',allowed_tools:['mcp__approved__publish']}
const hash = value=>createHash('sha256').update(value).digest('hex')
async function wait(check) {
  for (let i=0;i<300;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,15)) }
  throw Error('상태 변경 시간 초과 · ' + events.join(', '))
}
try {
  await source.init()
  for (const state of ['blocked','failed','rejected','done','awaiting_approval']) await seed(state,state)
  await seed('used-input','done')
  await seed('dependent','done',{depends_on:['used-input']})
  await seed('parent','done',{after_approval:'기 수행'})
  await seed('child','done',{parentId:'parent'})
  await seed('unsettled','blocked',{after_approval:'여부 미확인'})
  await seed('unknown-child','blocked',{parentId:'unsettled'})
  await seed('orphan-grant','blocked')
  await seed('busy','queued')
  await seed('queue','queued',{depends_on:['busy']})
  await seed('downstream','blocked',{depends_on:['queue']})
  await seed('reported','reported',{review_agent:'검토',order:10})
  const privateDir = join(app,hash(JSON.stringify([tmp,folder])))
  await mkdir(privateDir,{recursive:true})
  await writeFile(join(privateDir,'approval-'+hash('orphan-grant')+'.json'),'{}')
  await source.writeText('blocked.report.md','이전 보고')
  await source.writeText('blocked.review.md','이전 검토')
  await writeFile(join(folder,'산출물.txt'),'기존 산출물')
  await board.start()
  await wait(()=>held.length>0)
  await verifyBoardDocuments(board,'done',tmp,tmp,source)
  await verifyBoardDownloads(board,'done',tmp,tmp,source,module.exports,fn=>{saveDialog=fn})
  await assert.rejects(board.updateTask('busy',fields,await revision('busy')),/수행/)
  await assert.rejects(board.removeTask('busy',await revision('busy')),/수행/)
  for (const id of ['queue','reported','failed','rejected','done','awaiting_approval']) {
    await board.updateTask(id,fields,await revision(id))
    assert.equal((await snapshot(id)).status,'blocked')
    assert.ok((await snapshot(id)).editedNeedsRun)
  }
  assert.deepEqual((await snapshot('queue')).depends_on,['busy'])
  await assert.rejects(board.updateTask('queue',{...fields,depends_on:['different']},await revision('queue')),/선행/)
  for (const deps of [['busy','busy'],['queue'],['downstream']]) await assert.rejects(board.updateTask('queue',{...fields,depends_on:deps},await revision('queue')),/선행/)
  await assert.rejects(board.updateTask('used-input',fields,await revision('used-input')),/후속/)
  await assert.rejects(board.removeTask('used-input',await revision('used-input')),/선행/)
  await board.updateTask('dependent',{...fields,depends_on:[]},await revision('dependent'))
  await board.removeTask('used-input',await revision('used-input'))
  for (const id of ['unknown-child','unsettled','orphan-grant']) {
    await assert.rejects(board.removeTask(id,await revision(id)),/실행/)
  }
  await assert.rejects(board.updateTask('child',fields,await revision('child')),/실행/)
  await assert.rejects(board.removeTask('parent',await revision('parent')),/실행/)
  await board.removeTask('child',await revision('child'))
  await board.removeTask('parent',await revision('parent'))

  // The viewing revision includes independently edited report and reviewer files.
  for (const sidecar of ['report','review']) {
    const stale = await revision('blocked')
    await source.writeText('blocked.'+sidecar+'.md','외부 수정 '+sidecar)
    await assert.rejects(board.updateTask('blocked',fields,stale),/다시 확인|변경/)
    await assert.rejects(board.removeTask('blocked',stale),/다시 확인|변경/)
  }
  const stale = await revision('blocked')
  const previousText = await readFile(join(folder,'blocked.md'),'utf8')
  await writeFile(join(folder,'blocked.md'),previousText.replace('변경 전','외부 수정'))
  await assert.rejects(board.updateTask('blocked',fields,stale),/다시 확인|변경/)
  assert.equal((await snapshot('blocked')).body,'외부 수정')
  await assert.rejects(board.updateTask('blocked',{...fields,due:'2026-02-30'},await revision('blocked')),/기한/)

  viewer = new WorkBoard(tmp,folder,join(tmp,'other-app'),()=>{})
  await viewer.start()
  await assert.rejects(viewer.updateTask('blocked',fields,await revision('blocked')))
  await assert.rejects(viewer.removeTask('blocked',await revision('blocked')))
  const consentFile = join(privateDir,'todo-'+hash('blocked')+'.json')
  await writeFile(consentFile,JSON.stringify({scope:{kind:'all'},state:'ready'}))
  await board.updateTask('blocked',fields,await revision('blocked'))
  const edited = await snapshot('blocked')
  assert.equal(edited.attempts,0)
  for (const key of Object.keys(fields)) assert.deepEqual(edited[key],fields[key])
  assert.equal(edited.log[0].text,'이전 이력')
  assert.deepEqual(await board.detail('blocked'),{report:'',review:''})
  await assert.rejects(readFile(consentFile),{code:'ENOENT'})
  const beforeNoop = await revision('blocked')
  await board.updateTask('blocked',fields,beforeNoop)
  assert.equal(await revision('blocked'),beforeNoop)
  await source.writeText('blocked.report.md','동기화가 복구한 이전 보고')
  await source.writeText('blocked.review.md','동기화가 복구한 이전 검토')
  await assert.rejects(board.decide('blocked','submit'),/다시 수행/)
  assert.deepEqual(runs.map(([id])=>id),['busy'])
  // Only the explicit retry starts a fresh work/review cycle.
  await board.decide('blocked','retry')
  assert.deepEqual(await board.detail('blocked'),{report:'',review:''})
  for (const release of held) release()
  await wait(async ()=>(await snapshot('blocked')).status==='awaiting_approval')
  assert.equal((await snapshot('blocked')).editedNeedsRun,undefined)
  assert.match((await board.detail('blocked')).report,/새 보고/)
  assert.deepEqual(runs.filter(([id])=>id==='blocked'),[['blocked','work'],['blocked','review']])
  const names = ['blocked.md','blocked.report.md','blocked.review.md']
  const originals = await Promise.all(names.map(name=>readFile(join(folder,name),'utf8')))
  await board.removeTask('blocked',await revision('blocked'))
  assert.equal(await snapshot('blocked'),undefined)
  for (const name of names) await assert.rejects(readFile(join(folder,name)),{code:'ENOENT'})
  const archive = join(folder,'_보관')
  const archivedNames = (await readdir(archive,{recursive:true})).filter(name=>name.endsWith('.md'))
  const archived = await Promise.all(archivedNames.map(name=>readFile(join(archive,name),'utf8')))
  for (const original of [...originals,'외부 수정 report','외부 수정 review','동기화가 복구한 이전 검토']) {
    assert.ok(archived.includes(original),'이전 버전과 삭제된 지시의 원문이 보관되어야 합니다.')
  }
  assert.equal(await readFile(join(folder,'산출물.txt'),'utf8'),'기존 산출물')
  console.log('업무 지시 수정·보관·재실행 분리, 조회본 충돌, 결재·선행 관계, 소유권 및 이전 권한 무효화 확인')
} finally {
  for (const release of held) release()
  board.stop()
  viewer?.stop()
  delete globalThis.editTestRunner
  await rm(tmp,{recursive:true,force:true,maxRetries:3})
}
