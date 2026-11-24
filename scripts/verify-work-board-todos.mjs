// Production account binding, paginated MCP reads and Markdown rendering over synthetic account data.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const {outputFiles} = await build({
  entryPoints:['src/main/workBoardTodos.ts'], platform:'node',format:'cjs',bundle:true,write:false,packages:'external',
  plugins:[{name:'isolated-settings',setup(b) {
    b.onResolve({filter:/^\.\/settings$/}, () => ({path:'settings',namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'}, () => ({contents:'export const getSettings=async()=>globalThis.boardTestSettings; export const setSettings=()=>{throw Error("unexpected credential change")}' }))
  }}]
})
let settings = {jurisupportTokenEnc:'plain:fixture-A'}
globalThis.boardTestSettings = settings
const mod = {exports:{}}
const requests = []
let respond
const transport = async (_url, options) => {
  const request = JSON.parse(options.body)
  let payload = {}
  let status = 200
  if (request.method === 'tools/call') {
    assert.equal(request.params.name,'list_tasks')
    assert.equal(options.headers.Authorization,'Bearer fixture-A')
    const args = request.params.arguments
    assert.deepEqual(Object.keys(args).sort(),['type','includeClosed','fields','page','limit',...('caseId' in args ? ['caseId'] : [])].sort())
    assert.equal(args.includeClosed,false)
    assert.equal(args.fields,'compact')
    assert.equal(args.limit,100)
    assert.equal(args.type,'todo')
    requests.push(args)
    const response = await respond(args)
    payload = {content:[{type:'text',text:JSON.stringify(response.data)}], isError:response.isError}
    status = response.status || 200
  } else assert.ok(['initialize','notifications/initialized'].includes(request.method))
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:payload}), {status,headers:{'mcp-session-id':'fixture-session'}})
}
let clock = Date.parse('2026-11-23T15:01:00Z') // Nov 24 in Korea, Nov 23 in UTC.
const testDate = class extends Date { static now() { clock += 1100; return clock } }
new Function('require','module','exports','fetch','Date',outputFiles[0].text)(name => {
  if (name === 'electron') return {safeStorage:{},app:{getPath:()=>'/unused-test-profile'}}
  if (name === 'fs/promises') return {rm:async()=>{},readFile:async()=>{throw Error('fixture file missing')}}
  return require(name)
},mod,mod.exports,transport,testDate)
const {readBoardTodos,readBoardMcpTodos,getBoardTodoAccount} = mod.exports
const key = await getBoardTodoAccount()
assert.match(key,/^[a-f\d]{64}$/)
assert.equal(await getBoardTodoAccount(),key)
const scope = {kind:'case',caseId:'only-this'}
const task = (id, patch={}) => ({id, type:'todo', caseId:'only-this', title:'제목 '+id, status:'pending', notes:'SECRET_NOTES', client:'SECRET_CLIENT', ...patch})
const page = (tasks,more=false,total) => ({data:{tasks,pagination:{hasNext:more,total}}})
const a = task('A',{dueDate:'2026-11-23', assigneeId:null})
const b = task('B',{dueDate:'2026-11-23T15:00:00Z', assignee:{id:'attorney',name:'김담당'}})
const c = task('C',{status:'completed'})
try {
  respond = () => page([a,b,c,task('OTHER',{caseId:'other',dueDate:null}),task('MEMO',{type:'memo'})],false,5)
  const example = await readBoardTodos(scope,key)
  assert.match(example,/^2026-11-24 .*사건 only-this · 미완료 할일 2건/)
  for (const label of ['기한 초과 1건','기한 임박 1건','담당자 미지정 1건']) assert.ok(example.includes('### ' + label))
  assert.ok(example.indexOf('제목 A') < example.indexOf('제목 B'))
  assert.match(example,/제목 A.*미지정.*기한 초과 · 담당자 미지정/)
  assert.match(example,/제목 B.*기한 임박/)
  assert.doesNotMatch(example,/SECRET|fixture|MEMO|OTHER|제목 C/)
  const agentResult = await readBoardMcpTodos(scope,key)
  const scoped = JSON.parse(agentResult)
  assert.deepEqual(scoped.scope,scope)
  assert.equal(scoped.total,2)
  assert.deepEqual(scoped.tasks.map(row=>row.id),['A','B'])
  assert.doesNotMatch(agentResult,/SECRET|fixture|MEMO|OTHER/)
  assert.ok(requests.every(q=>q.caseId === 'only-this'))
  const all = await readBoardTodos({kind:'all'},key)
  assert.match(all,/제목 OTHER.*other/)
  assert.equal(requests.at(-1).caseId,undefined)

  const d = task('D',{dueDate:'2026-11-23T15:30:00.000Z', assigneeId:'owner', reviewAt:'2026-11-23T15:00:00.000Z',waitingFor:'회신'})
  const plus3 = task('plus3',{dueDate:'2026-11-27'})
  const plus4 = task('plus4',{dueDate:'2026-11-28',assigneeId:null,visibility:'private',userId:'SECRET_AUTHOR'})
  const child = task('child',{dueDate:null, reviewAt:'2026-11-23T14:30:00Z', caseName:'검토 사건',caseNumber:'2026테스트3'})
  respond = ({page:p}) => p === 1 ? page([{...d, children:[{id:'plus3'}, child]}, plus4],true,5) :
    page([plus3,{...plus4,children:[child]},task('waiting',{dueDate:null})],false,5)
  const edges = await readBoardTodos(scope,key)
  assert.match(edges,/미완료 할일 5건/)
  for (const [group,count] of [['기한 초과',0],['기한 임박',2],['기한 없음',2],['재확인일 도래',2],['담당자 미지정',1]]) {
    assert.ok(edges.includes('### ' + group + ' '+count+'건'),edges)
  }
  assert.match(edges,/제목 D.*2026-11-24.*지정됨.*기한 임박.*재확인일 도래.*2026-11-24.*회신/)
  assert.match(edges,/제목 plus3.*기한 임박/)
  assert.doesNotMatch(edges,/제목 plus4[^\n]*기한 임박|SECRET_AUTHOR/)
  assert.match(edges,/제목 child.*검토 사건.*2026테스트3.*기한 없음.*재확인일 도래/)
  assert.match(edges,/담당 정보 미제공 3건/)
  assert.match(edges.split('\n')[2],/기한 초과 0건 · 기한 임박 2건.*재확인일 도래 2건/)
  respond = () => page([task('named',{assigneeName:'미지정',dueDate:null})],false,1)
  const named = await readBoardTodos(scope,key)
  assert.match(named,/### 담당자 미지정 0건/)
  assert.doesNotMatch(named,/담당 정보 미제공/)
  // A short result with no pagination metadata doesn't establish completeness.
  respond = ({page:p}) => ({data:p < 3 ? [task('short'+p)] : []})
  assert.match(await readBoardTodos(scope,key), /미완료 할일 2건/)
  respond = () => page([])
  assert.match(await readBoardTodos(scope,key),/미완료 할일 0건/)
  for (const invalid of [null,{}, {kind:'case',caseId:' '},{kind:'unknown'}]) await assert.rejects(readBoardTodos(invalid,key),/범위/)
  for (const broken of [
    {tasks:[task('unknown',{status:'new-state'})]},
    {tasks:[task('unknown',{caseId:undefined})]},
    {tasks:[{status:'pending'}]},
    {tasks:[],partial:true},
    {tasks:[],hasNext:false,total:3},
    {tasks:[a],hasNext:true,total:1},
    {tasks:[],total:'5'},
    {tasks:[{...a,children:[{id:'unconfirmed-child',title:'child',status:'pending'}]}],total:1},
    {tasks:[a],total:0},
    {tasks:[a],pagination:{page:7,total:1}},
    {unrecognized:[]}
  ]) {
    respond = () => ({data:broken})
    await assert.rejects(readBoardTodos(scope,key))
  }
  respond = () => page([a],true)
  await assert.rejects(readBoardTodos(scope,key))
  respond = ({page:p}) => p === 1 ? page([a],true) : {data:'SENSITIVE FAILURE',status:500}
  await assert.rejects(readBoardTodos(scope,key),error => /2페이지/.test(error.message) && !error.message.includes('SENSITIVE'))
  for (const [status,expected] of [[401,/인증/],[403,/권한/],[500,/실패/]]) {
    respond = () => ({status,data:'sensitive request credential'})
    await assert.rejects(readBoardTodos(scope,key),e=>expected.test(e.message) && !e.message.includes('sensitive'))
  }
  respond = () => ({data:'HTTP 403 sensitive request credential', isError:true})
  await assert.rejects(readBoardTodos(scope,key),e=>/권한/.test(e.message) && !e.message.includes('sensitive'))
  const before = requests.length
  await assert.rejects(readBoardTodos(scope,'invalid-key'),/계정/)
  assert.equal(requests.length,before)
  respond = () => {
    settings.jurisupportTokenEnc='plain:fixture-B'
    return page([a],true)
  }
  await assert.rejects(readBoardTodos(scope,key),/계정/)
  assert.equal(requests.length,before+1)
  assert.notEqual(await getBoardTodoAccount(),key)
  console.log('할일 조회 범위·미완료 ID 중복 제거·KST 기한·담당 정보·부분 조회·계정 변경·읽기 전용 호출 검증 통과')
} finally { delete globalThis.boardTestSettings }
