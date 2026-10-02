import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as mcp from '../src/main/agent/agentMcp.ts'
import * as executionLock from '../src/main/agent/agentExecutionLock.ts'
import * as media from '../src/shared/media.ts'
const token = 'synthetic-agent-jurisupport-secret-20260914'
const connection = { token, epoch: 1, tools: ['list_tasks', 'get_task', 'update_task', 'create_task', 'delete_case', 'send_email'] }
const full = (name) => `mcp__${mcp.MANAGED_MCP}__${name}`
for (const mode of ['ask','acceptEdits','bypassPermissions','plan','dontAsk']) {
  assert.equal(mcp.managedToolDecision(full('list_tasks'),mode),'allow')
  assert.equal(mcp.managedToolDecision(full('delete_case'),mode),'deny')
  assert.equal(mcp.managedToolDecision(full('update_task'),mode),mode==='bypassPermissions'?'allow':['plan','dontAsk'].includes(mode)?'deny':'ask')
  const native=mcp.claudeManagedServers(connection,mode)[mcp.MANAGED_MCP]
  assert.equal(native.headers.Authorization,`Bearer ${token}`)
  assert.equal(native.tools.find(t=>t.name==='delete_case').permission_policy,'always_deny')
  const config=mcp.codexManagedConfig(connection,mode)
  assert.equal(JSON.stringify(config).includes(token),false)
  assert.equal(config[`mcp_servers.${mcp.MANAGED_MCP}`].enabled_tools.includes('delete_case'),false)
  assert.equal(config['shell_environment_policy.set'][mcp.MANAGED_MCP_ENV],'')
  assert.equal(config[`mcp_servers.${mcp.MANAGED_MCP}`].enabled_tools.includes('update_task'),!['plan','dontAsk'].includes(mode))
}
assert.equal(JSON.stringify(mcp.redactManagedSecrets({nested:[`Bearer ${token}`,{message:`failed ${token}`,headers:{x:token}}]},[token])).includes(token),false)

let epoch=1,accountChanged;const events=[];const calls=[];const launches=[];let queryFailure=false
class FakeProcess extends EventEmitter {
  stdout=new EventEmitter();stderr=new EventEmitter();killed=false
  stdin={destroyed:false,writableEnded:false,write:(text)=>{calls.push(['stdin',text]);this.receive?.(text);return true},end:()=>{this.stdin.writableEnded=true;queueMicrotask(()=>this.emit('close',0))},on:()=>{}}
  kill(){this.killed=true;queueMicrotask(()=>this.emit('close',0));return true}
}
let nextProcess
const query=({prompt,options})=>{
  assert.equal(options.mcpServers,undefined,'raw token must never enter SDK argv-backed option')
  calls.push(['query',options]);
  return {
    initializationResult:async()=>{calls.push(['initialize']);return{}},
    setMcpServers:async(servers)=>{calls.push(['configure',servers]);return {added:[mcp.MANAGED_MCP],removed:[],errors:queryFailure?{[mcp.MANAGED_MCP]:token}:{}}},
    mcpServerStatus:async()=>[{name:mcp.MANAGED_MCP,status:'connected'}],getContextUsage:async()=>({}),close:()=>calls.push(['close']),
    async *[Symbol.asyncIterator](){const input=await prompt.next();if(input.done)return;calls.push(['prompt',input.value]);assert.equal(calls.some(c=>c[0]==='configure'),true)}
  }
}
const require=createRequire(import.meta.url);const serviceExports={}
const source=readFileSync(new URL('../src/main/agent/agent-service.ts',import.meta.url),'utf8')+'\nexport const __test={sessions,startAgentTurn,runRemoteAgentMessage,remoteCodexCommand,startCodexProcess,emit,requestPermission,shouldAutoAllow,assertManagedAccount,handleCodexServerRequest};'
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const ctx={exports:serviceExports,console,process,Buffer,AbortController,URL,URLSearchParams,TextDecoder,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,
  require(name){
    if(name==='@anthropic-ai/claude-agent-sdk')return{query}
    if(name==='../jurisupport')return{getAgentMcpConnection:async()=>({...connection,epoch}),agentMcpAccountEpoch:()=>epoch,onAgentMcpAccountChange:fn=>{accountChanged=fn},listTodos:async()=>[]}
    if(name==='./agentMcp')return mcp
    if(name==='./agentExecutionLock')return executionLock
    if(name==='../../shared/media')return media
    if(name==='./agentPrompt')return{currentAgentContext:async()=>'',prependAgentContext:(_context,prompt)=>prompt}
    if(name==='../sessions')return{rememberSessionMeta:async()=>{},readSessionTokenUsage:async()=>null}
    if(name==='./agentProgress')return{codexTurnRunStatus:()=> 'idle',codexWorkStepStatus:()=> 'completed'}
    if(name==='../sshOptions')return{buildSshArgs:()=>[],getControlPathForProfile:()=>''}
    if(name==='child_process')return{spawn:(...args)=>{launches.push(args);return nextProcess??new FakeProcess()},execFile:()=>{}}
    return require(name)
  }}
vm.runInNewContext(compiled,ctx)
const api=serviceExports.__test
function session(id='test'){
  const s={id,cwd:'/tmp',provider:'claude',source:'local',permissionMode:'ask',workspaceContext:{scope:'global',todoManagement:true},viewers:new Map([[1,{isDestroyed:()=>false,send:(_c,e)=>events.push(e)}]]),pendingPermissions:new Map(),pendingDialogs:new Map(),dialogs:new Map(),assistantMessages:new Set(),assistantText:new Map(),assistantStreamed:new Set(),startedTools:new Set(),queue:[],tokenUsage:{turns:0,inputTokens:0,outputTokens:0,totalTokens:0,updatedAt:0}}
  api.sessions.set(id,s);return s
}
const wait=async(check)=>{for(let i=0;i<150&&!check();i++)await new Promise(r=>setTimeout(r,2));assert.ok(check())}
let s=session();api.startAgentTurn(s,{text:'할일을 확인해줘'});await wait(()=>!s.running)
assert.ok(calls.find(c=>c[0]==='prompt'),JSON.stringify(events.filter(e=>e.type==='error')))
assert.equal(JSON.stringify(calls.find(c=>c[0]==='query')[1]).includes(token),false)
assert.equal(calls.findIndex(c=>c[0]==='configure')<calls.findIndex(c=>c[0]==='prompt'),true)
api.emit(s,{type:'raw',sessionId:s.id,message:{error:`failed ${token}`}})
api.emit(s,{type:'tool:start',sessionId:s.id,toolId:'t',name:full('update_task'),label:'update'})
api.emit(s,{type:'tool:done',sessionId:s.id,toolId:'t',isError:false})
assert.ok(events.some(e=>e.type==='process:event'&&e.toolName===full('update_task')&&e.status==='completed'))
assert.equal(JSON.stringify(events).includes(token),false)
queryFailure=true;calls.length=0;s=session('failed');api.startAgentTurn(s,{text:'never run'});await wait(()=>!s.running)
assert.equal(calls.some(c=>c[0]==='prompt'),false,'configuration failure must never release the prompt')
assert.equal(JSON.stringify(events).includes(token),false);queryFailure=false
s=session('plan');s.managedMcp=connection;s.permissionMode='plan'
assert.equal((await api.requestPermission(s,full('update_task'),{}, {signal:new AbortController().signal,toolUseID:'write'})).behavior,'deny')
s=session('account');s.managedMcp=connection;s.managedSecrets=new Set([token]);s.running=new AbortController();const signal=s.running.signal;epoch++;accountChanged()
assert.equal(signal.aborted,true);assert.equal(s.managedAccountInvalid,true);assert.throws(()=>api.assertManagedAccount(s),/계정/)

// SSH token travels as the first stdin line, never in the shell command or process argv.
epoch=1;s=session('codex');s.provider='codex';s.source='ssh';s.ssh={host:'test',user:'test',remoteControl:true};s.managedMcp=connection
const command=api.remoteCodexCommand(s);assert.equal(command.includes(token),false);assert.ok(command.includes(`read -r ${mcp.MANAGED_MCP_ENV}`));assert.equal(command.includes('daemon bootstrap'),false)
nextProcess=new FakeProcess();api.startCodexProcess(s)
assert.equal(JSON.stringify(launches.at(-1)[1]).includes(token),false)
assert.ok(calls.some(c=>c[0]==='stdin'&&c[1]===token+'\n'))
s.managedMcp=undefined;assert.ok(api.remoteCodexCommand(s).includes('daemon bootstrap'))

// Fake native remote Claude responds to initialization/configuration before receiving user input.
s=session('remote');s.source='ssh';s.ssh={host:'test',user:'test'};s.managedMcp=connection;s.managedSecrets=new Set([token]);s.running=new AbortController();const remoteStages=[]
nextProcess=new FakeProcess();nextProcess.receive=(line)=>{
  const msg=JSON.parse(line)
  if(msg.type==='control_request'){
    remoteStages.push(msg.request.subtype)
    const body=msg.request.subtype==='mcp_status'?{mcpServers:[{name:mcp.MANAGED_MCP,status:'connected'}]}:msg.request.subtype==='mcp_set_servers'?{errors:{}}:{}
    queueMicrotask(()=>nextProcess.stdout.emit('data',Buffer.from(JSON.stringify({type:'control_response',response:{request_id:msg.request_id,subtype:'success',response:body}})+'\n')))
  }else if(msg.type==='user'){
    remoteStages.push('user');queueMicrotask(()=>nextProcess.stdin.end())
  }
}
await api.runRemoteAgentMessage(s,'확인만 해줘',s.running)
assert.deepEqual(remoteStages.slice(0,4),['initialize','mcp_set_servers','mcp_status','user'])
assert.equal(JSON.stringify(launches.at(-1)[1]).includes(token),false)
assert.equal(JSON.stringify(events).includes(token),false)
console.log('managed native MCP: scoped tool policies, SDK/SSH prompt gates, no argv secrets, redaction, task events, account interruption and remote-control isolation passed')

// Managed mutation approvals reuse the existing permission UI instead of a second patch protocol.
s=session('ask-write');s.managedMcp=connection;s.permissionMode='ask'
const ask=api.requestPermission(s,full('update_task'),{id:'task'}, {signal:new AbortController().signal,toolUseID:'ask-write'})
assert.equal(s.pendingPermissions.size,1)
assert.ok(events.some(e=>e.type==='permission:request'&&e.request.toolName===full('update_task')))
s.pendingPermissions.get('ask-write').finish({behavior:'allow',updatedInput:{id:'task'}},'allow')
assert.equal((await ask).behavior,'allow')
assert.equal((await api.requestPermission(s,full('delete_case'),{}, {signal:new AbortController().signal,toolUseID:'forbidden'})).behavior,'deny')
console.log('managed writes use the existing approval request and unsupported operations are denied')

const ordinary=session('ordinary');ordinary.workspaceContext={kind:'folder',cwd:'/tmp'}
api.emit(ordinary,{type:'message:assistant_delta',sessionId:ordinary.id,messageId:'example',text:'Example: Bearer YOUR_TOKEN'})
assert.equal(events.at(-1).text,'Example: Bearer YOUR_TOKEN','unmanaged session output remains untouched')

// Custom MCP approvals use elicitation, which differs from connector requestUserInput.
const elicitation=(tool='update_task')=>({serverName:mcp.MANAGED_MCP,threadId:'managed-thread',turnId:'turn',mode:'form',message:'Apply task change?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_name:tool,tool_params:{id:'task'},persist:{scope:'all'}}})
for(const mode of ['ask','acceptEdits','bypassPermissions','plan','dontAsk']){
  s=session('elicitation-'+mode);s.provider='codex';s.permissionMode=mode;s.managedMcp=connection;s.codexThreadId='managed-thread';s.codexProcess=new FakeProcess();s.running=new AbortController()
  const before=calls.length
  api.handleCodexServerRequest(s,{id:'approve-'+mode,method:'mcpServer/elicitation/request',params:elicitation()})
  if(['ask','acceptEdits'].includes(mode)){
    assert.equal(s.pendingPermissions.size,1)
    s.pendingPermissions.get('approve-'+mode).finish({behavior:'deny',message:'declined'},'reject')
  }
  await new Promise(r=>setTimeout(r,0))
  const reply=JSON.parse(calls.slice(before).find(c=>c[0]==='stdin')[1]).result
  assert.equal(reply.action,mode==='bypassPermissions'?'accept':'decline')
  assert.equal(reply._meta,undefined,'do not persist an implicit approval grant')
}
s=session('elicitation-allow');s.provider='codex';s.permissionMode='ask';s.managedMcp=connection;s.codexThreadId='managed-thread';s.codexProcess=new FakeProcess();s.running=new AbortController()
api.handleCodexServerRequest(s,{id:'allow-one',method:'mcpServer/elicitation/request',params:elicitation()})
s.pendingPermissions.get('allow-one').finish({behavior:'allow',updatedInput:{}},'allow')
await new Promise(r=>setTimeout(r,0))
assert.deepEqual(JSON.parse(calls.at(-1)[1]).result,{action:'accept',content:{}})
api.handleCodexServerRequest(s,{id:'bad-schema',method:'mcpServer/elicitation/request',params:{...elicitation(),requestedSchema:{type:'object',properties:{unexpected:{type:'string'}}}}})
assert.equal(JSON.parse(calls.at(-1)[1]).result.action,'decline')
api.handleCodexServerRequest(s,{id:'wrong-thread',method:'mcpServer/elicitation/request',params:{...elicitation(),threadId:'other'}})
assert.equal(JSON.parse(calls.at(-1)[1]).result.action,'decline')
api.handleCodexServerRequest(s,{id:'account-race',method:'mcpServer/elicitation/request',params:elicitation()})
const waiting=s.pendingPermissions.get('account-race');epoch++;waiting.finish({behavior:'allow',updatedInput:{}},'allow');await new Promise(r=>setTimeout(r,0))
assert.equal(JSON.parse(calls.at(-1)[1]).result.action,'decline')
console.log('custom MCP elicitation uses native action/content, existing permission UI, plan/dontAsk denies and epoch/thread/schema guards')

const retired=session('restored-retired');retired.workspaceContext={kind:'global',cwd:'/tmp',todoManagement:false}
const beforeRetired=calls.length
api.startAgentTurn(retired,{text:'change old account task',workspaceContext:{kind:'global',cwd:'/tmp',todoManagement:true}})
await new Promise(r=>setTimeout(r,0))
assert.equal(calls.length,beforeRetired,'persisted retired marker cannot fall back to inherited credentials or be reactivated')
console.log('restored retired task manager starts no provider query or prompt')
