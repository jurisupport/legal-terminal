import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as summary from '../src/shared/todoSummary.ts'
const { kstDateKey, setTodoDate, filterTodos, summarizeTodos, todoTags } = summary
const now = '2026-09-12T00:00:00+09:00'
const todo = (id, extra = {}) => ({ id, title: id, type: 'todo', status: 'pending', ...extra })
assert.equal(kstDateKey('2026-09-11T15:00:00Z'), '2026-09-12')
for (const invalid of ['oops', '2026-02-30', '2026-13-01', '2026-00-00']) assert.equal(kstDateKey(invalid), null)
assert.equal(setTodoDate('2026-08-01T01:02:03.456Z', '2026-09-12'), '2026-09-12T01:02:03.456Z')
assert.equal(setTodoDate(null, '2026-09-12'), '2026-09-12T14:59:00.000Z')
const rows = [todo('today', {dueDate:'2026-09-12'}), todo('29', {dueDate:'2026-08-14'}), todo('30', {dueDate:'2026-08-13'}), todo('59', {createdAt:'2026-07-15'}), todo('60', {createdAt:'2026-07-14'}), todo('stale29', {status:'in_progress', updatedAt:'2026-08-14'}), todo('stale30', {status:'in_progress', updatedAt:'2026-08-13'}), todo('bad', {dueDate:'bad'}), todo('memo', {type:'memo'}), todo('done', {status:'completed'}), todo('closed', {status:'closed'}), todo('review', {reviewAt:now})]
assert.equal(summarizeTodos([...rows, rows[2]], now).openCount, 9)
assert.deepEqual(filterTodos(rows,'overdue30',now).map(t=>t.id), ['30'])
assert.deepEqual(filterTodos(rows,'undated60',now).map(t=>t.id), ['60'])
assert.deepEqual(filterTodos(rows,'stale30',now).map(t=>t.id), ['stale30'])
assert.equal(filterTodos(rows,'overdue',now).length,2)
assert.equal(filterTodos(rows,'undated',now).some(t=>t.id==='bad'),false)
assert.ok(todoTags(rows[7],now).includes('날짜 확인 필요'))
assert.equal(filterTodos(rows,'review',now).length,1)

// Run the real main-process adapter with a synthetic MCP transport, never live case data.
const schema = (name, fields) => ({ name, inputSchema: {properties:Object.fromEntries(fields.map(f=>[f,{}]))} })
const legacyTools = [schema('list_tasks',['type','status','caseId','page','limit']), schema('create_task',['type','title','content','dueDate','caseId','priority']), schema('update_task',['title','content','dueDate','priority']), schema('update_task_status',['status'])]
const modernTools = [schema('list_tasks',['type','status','caseId','page','limit','fields','includeClosed']), ...['create_task','update_task'].map(n=>schema(n,['type','title','content','dueDate','priority','reviewAt','parentId','evidence','version'])),schema('update_task_status',['status','childDispositions','version']),schema('get_task_evidence_suggestions',['id'])]
function adapter(handler, toolSchemas=modernTools, hooks={}) {
  const calls=[]; let settings={jurisupportTokenEnc:'plain:synthetic-test'}
  const exports={}
  const code=ts.transpileModule(readFileSync(new URL('../src/main/jurisupport.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const context={exports, module:{exports}, console:{warn(){}}, Buffer, Date, Promise, Map, Set, JSON, String, Number, Object, Array, Error, AbortController, setTimeout, clearTimeout,
    require(name) {
      if(name==='electron')return {app:{getPath:()=>'/tmp'},safeStorage:{isEncryptionAvailable:()=>false}}
      if(name==='./settings')return {getSettings:async()=>settings,setSettings:async(p)=>{await hooks.beforeSettings?.();settings={...settings,...p}}}
      if(name==='fs/promises')return {rm:async()=>{}}
      if(name==='path')return {join:(...v)=>v.join('/')}
      if(name==='./mcpResponse')return {parseRpc:JSON.parse}
      if(name==='../shared/todoSummary')return summary
      if(name==='./jurisupportNormalize')return {normalizeCase:x=>x,normalizeCaseList:x=>x}
      if(name==='./imageSize')return {}
      throw new Error(`Unexpected import ${name}`)
    },
    async fetch(_url, options) {
      const request=JSON.parse(options.body)
      let result={}
      if(request.method==='tools/list') result={tools:toolSchemas}
      if(request.method==='tools/call') {
        calls.push(request.params)
        const data=await handler(request.params.name, request.params.arguments)
        result={content:[{type:'text',text:JSON.stringify(data)}]}
      }
      return {status:200,headers:{get:()=> 'synthetic-session'},text:async()=>JSON.stringify({jsonrpc:'2.0',result})}
    }
  }
  vm.runInNewContext(code,context)
  return {api:exports,calls}
}
let transport=adapter((name,args)=> {
  assert.equal(name,'list_tasks')
  if(args.status==='in_progress')return {data:[todo('duplicate',{status:'in_progress',title:'changed title'})],pagination:{total:1,totalPages:1}}
  return args.page===1 ? {data:[todo('duplicate'),todo('2')],pagination:{total:3,totalPages:2}} : {data:[todo('2',{title:'updated'}),todo('3')],pagination:{total:3,totalPages:2}}
})
const full=await transport.api.listTodos({openOnly:true,enrichCaseDetails:false,fields:'compact'})
assert.equal(full.length,3)
assert.equal(full.find(t=>t.id==='duplicate').status,'in_progress')
assert.equal(transport.calls.filter(c=>c.name==='list_tasks').length,3)
assert.equal(transport.calls.some(c=>c.name==='get_case'),false)
for (const mode of ['first-failure','later-failure','repeat','cap','missing','bad-response']) {
  transport=adapter((_name,args)=>{
    if(mode==='first-failure'||(mode==='later-failure'&&args.page===2))throw new Error('synthetic failure')
    if(mode==='bad-response')return {message:'not a list'}
    if(mode==='missing')return {data:[],pagination:{total:2}}
    const rows=Array.from({length:100},(_,i)=>todo(`${mode==='repeat'?'same':args.page}-${i}`))
    return {data:rows,pagination:{hasNext:true}}
  })
  await assert.rejects(()=>transport.api.listTodos({enrichCaseDetails:false}),undefined,mode)
}
transport=adapter((_name,args)=>({data:[todo(String(args.page))],pagination:{hasNext:true}}))
assert.equal((await transport.api.listTodos({page:3,limit:1,enrichCaseDetails:false}))[0].id,'3')
transport=adapter((_name,args)=>({data:[todo('m',{...args})]}),legacyTools)
await assert.rejects(()=>transport.api.createTodo({title:'unsupported priority',priority:'high'}),/priority/)
await transport.api.createTodo({title:'memo',type:'memo'})
assert.equal(transport.calls.at(-1).arguments.type,'memo')
transport=adapter((_name,args)=>({data:todo('modern',args)}))
const saved=await transport.api.createTodo({title:'modern',dueDate:null,reviewAt:'2026-09-12',priority:'high',parentId:'parent',evidence:[{kind:'document',id:'d',label:'증거',status:'confirmed'}]})
assert.equal(saved.priority,'high'); assert.equal(saved.parentId,'parent'); assert.equal(saved.evidence.length,1)
assert.equal(transport.calls.at(-1).arguments.dueDate,null)
assert.equal(saved.reviewAt,'2026-09-12T14:59:00.000Z')
let release
transport=adapter(async()=>{await new Promise(resolve=>{release=resolve});return {data:[todo('old-account')]}})
const pending=transport.api.listTodos({enrichCaseDetails:false})
while(!release) await new Promise(resolve=>setImmediate(resolve))
await transport.api.setToken('synthetic-new-account')
release()
await assert.rejects(()=>pending,/계정/)
console.log('todo summary, pagination, legacy capabilities, preservation, and account isolation ok')

// Minimal hook harness: run actual effect callbacks with controllable IPC promises/events.
const effects=[]; const listeners=new Map(); const timers=new Map(); const pendingLists=[]
let state; let timerId=0; let token=true
const hookExports={}
const hookCode=ts.transpileModule(readFileSync(new URL('../src/renderer/src/dashboard/useTodoSnapshot.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const harness={exports:hookExports,Date,Promise,Array,Error,String,
  require(name){
    if(name==='react') return {useState(initial){state=initial; return [initial,(update)=>{state=typeof update==='function'?update(state):update}]},useRef:current=>({current}),useCallback:fn=>fn,useEffect:fn=>{effects.push(fn)}}
    if(name==='../../../shared/todoSummary')return summary
    throw new Error(name)
  },
  setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},
  window:{addEventListener:(event,fn)=>listeners.set(event,fn),removeEventListener:(event)=>listeners.delete(event),lt:{js:{hasToken:async()=>token},todo:{list:()=>new Promise(resolve=>pendingLists.push(resolve))}}}
}
vm.runInNewContext(hookCode,harness)
const snapshot=hookExports.useTodoSnapshot()
const cleanup=effects[0]();effects[1]()
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
await flush();assert.equal(pendingLists.length,1)
listeners.get('focus')();listeners.get('focus')();assert.equal(pendingLists.length,1)
pendingLists.shift()({ok:true,todos:[todo('first')]});await flush()
assert.equal(state.todos[0].id,'first');assert.ok(state.fetchedAt);assert.equal(pendingLists.length,0)
snapshot.refresh();await flush();pendingLists.shift()({ok:false,error:'refresh failed'});await flush()
assert.equal(state.todos[0].id,'first');assert.equal(state.error,'refresh failed')
snapshot.refresh();await flush();const old=pendingLists.shift()
listeners.get('lt-js-token-updated')();assert.equal(state.todos,null);await flush()
const fresh=pendingLists.shift();fresh({ok:true,todos:[todo('new-account')]});await flush()
old({ok:true,todos:[todo('old-account')]});await flush();assert.equal(state.todos[0].id,'new-account')
const midnight=[...timers.values()].at(-1);midnight();await flush();assert.equal(pendingLists.length,1)
pendingLists.shift()({ok:true,todos:[]});await flush();assert.equal(state.todos.length,0);assert.equal(state.error,'')
token=false;listeners.get('lt-js-token-updated')();await flush();assert.equal(state.hasToken,false);assert.equal(state.todos,null)
cleanup();assert.equal(listeners.size,0)
console.log('shared snapshot focus dedup, stale preservation, midnight refresh, token reset and late-response guards ok')

// Regression checks from independent cross-account and partial-capability review.
let releaseCase
transport=adapter(async(name,args)=>{
  assert.equal(name,'list_cases')
  if(args.page===1)return Array.from({length:50},(_,i)=>({id:String(i),caseName:'old'}))
  await new Promise(resolve=>{releaseCase=resolve})
  return []
})
const caseRead=transport.api.listCases()
while(!releaseCase)await new Promise(resolve=>setImmediate(resolve))
await transport.api.setToken('synthetic-account-two');releaseCase()
await assert.rejects(()=>caseRead,/계정/)
let finishSettings, finishList
transport=adapter(async()=>{await new Promise(resolve=>{finishList=resolve});return {data:[todo('during-save')]}},modernTools,{beforeSettings:()=>new Promise(resolve=>{finishSettings=resolve})})
const credentialChange=transport.api.setToken('synthetic-committed')
while(!finishSettings)await new Promise(resolve=>setImmediate(resolve))
const duringSave=transport.api.listTodos({enrichCaseDetails:false})
while(!finishList)await new Promise(resolve=>setImmediate(resolve))
finishSettings();await credentialChange;finishList();await assert.rejects(()=>duringSave,/계정/)
transport=adapter((_name,args)=>({data:todo('must-not-write',args)}))
await transport.api.todoCapabilities()
const guardedWrite=transport.api.createTodo({title:'guarded',reviewAt:now})
await transport.api.setToken('switched-during-capability-wait')
await assert.rejects(()=>guardedWrite,/계정/)
assert.equal(transport.calls.length,0)
transport=adapter(()=>({}),[...modernTools,schema('get_case_closure_preview',['id']),schema('update_case_status',['version','taskDispositions']),schema('update_case',['caseName'])])
assert.equal((await transport.api.todoCapabilities()).caseClosure,true)
await assert.rejects(()=>transport.api.updateCaseEngagement('case','retained'),/수임/)
assert.equal(transport.calls.length,0)
console.log('case cache account isolation, credential persistence window, mutation preflight and partial-server engagement guard ok')

transport=adapter((name,args)=>name==='get_task'?todo('progress',{notes:'existing note',version:4}):{data:todo('progress',args)})
await transport.api.appendTodoProgress('progress','new progress')
assert.equal(transport.calls.at(-1).arguments.version,4)
assert.match(transport.calls.at(-1).arguments.content,/existing note/)
assert.match(transport.calls.at(-1).arguments.content,/new progress/)
console.log('progress append preserves content and includes the read version for optimistic concurrency')

transport=adapter((_name,args)=>todo('legacy',args),legacyTools)
await transport.api.completeTodo('legacy',undefined,undefined,{version:2})
assert.equal(transport.calls.at(-1).name,'update_task_status')
assert.equal(transport.calls.at(-1).arguments.version,undefined)
await transport.api.updateTodo('legacy',{dueDate:'2026-09-12',version:2})
assert.equal(transport.calls.at(-1).name,'update_task')
assert.equal(transport.calls.at(-1).arguments.version,undefined)
transport=adapter(()=>todo('legacy',{notes:'original',version:2}),legacyTools)
await assert.rejects(()=>transport.api.appendTodoProgress('legacy','new progress'),/서버 업데이트/)
assert.equal(transport.calls.some(c=>c.name==='update_task'),false)
console.log('legacy simple status/date writes remain available; unsafe legacy append is rejected')
