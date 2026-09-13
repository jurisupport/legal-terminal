// Optional installed-Codex smoke check. Uses only a synthetic local MCP and no model turn.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codexManagedConfig, managedMcpApproval, MANAGED_MCP, MANAGED_MCP_ENV } from '../src/main/agent/agentMcp.ts'
const token=`synthetic-native-mcp-${Date.now()}`
let authorization, activeThread, elicitationDecision='decline', writeCount=0, elicitationSeq=0
const elicitationReplies=new Map()
const elicitationMethods=[]
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  let input='';for await(const chunk of req)input+=chunk
  const message=JSON.parse(input);authorization=req.headers.authorization
  if(message.result && elicitationReplies.has(message.id)){const reply=elicitationReplies.get(message.id);elicitationReplies.delete(message.id);reply(message.result);res.writeHead(202);res.end();return}
  if(message.method==='tools/call' && message.params.name==='update_task'){
    const id=`synthetic-approval-${++elicitationSeq}`
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
    elicitationReplies.set(id,(decision)=>{if(decision.action==='accept')writeCount++;res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({changed:decision.action==='accept'})}]}})}\n\n`)})
    res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id,method:'elicitation/create',params:{mode:'form',message:'Synthetic task write approval',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'update_task',tool_params:message.params.arguments??{}}}})}\n\n`)
    return
  }
  if(message.id===undefined){res.writeHead(202);res.end();return}
  const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:message.method==='tools/list'?{tools:[{name:'list_tasks',description:'Synthetic read only',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},{name:'update_task',description:'Synthetic write',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:false}}]}:message.method==='tools/call'?{content:[{type:'text',text:'{"data":[]}'}]}:{}
  res.writeHead(200,{'Content-Type':'application/json','mcp-session-id':'synthetic-session'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const cwd=await mkdtemp(join(tmpdir(),'lt-mcp-native-'))
const config=codexManagedConfig({token,epoch:1,tools:['list_tasks','update_task']},'ask')
config[`mcp_servers.${MANAGED_MCP}`].url=`http://127.0.0.1:${server.address().port}/mcp`
assert.equal(JSON.stringify(config).includes(token),false)
config['mcp_servers.synthetic_http_alias.enabled']=false
config['mcp_servers.synthetic_stdio_alias.enabled']=false
const proc=spawn('codex',['-c','mcp_servers={}','-c','mcp_servers.synthetic_http_alias={url="http://127.0.0.1:9/mcp",enabled=false}','-c','mcp_servers.synthetic_stdio_alias={command="node",args=["-e","process.exit(0)"],enabled=false}','app-server'],{cwd,env:{...process.env,[MANAGED_MCP_ENV]:token},stdio:['pipe','pipe','pipe']})
let seq=0,buffer='';const pending=new Map();const messages=[]
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});proc.stdin.write(JSON.stringify({id,method,params})+'\n')})
proc.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const value=JSON.parse(line);messages.push(value);if(value.method==='mcpServer/elicitation/request'){elicitationMethods.push(value.method);const recognized=managedMcpApproval(value.params,activeThread);proc.stdin.write(JSON.stringify({id:value.id,result:recognized&&elicitationDecision==='accept'?{action:'accept',content:{}}:{action:'decline'}})+'\n');continue}const callback=pending.get(value.id);if(callback){pending.delete(value.id);value.error?callback.reject(new Error(JSON.stringify(value.error))):callback.resolve(value.result)}}catch{}}})
proc.stderr.resume()
const timer=setTimeout(()=>{for(const item of pending.values())item.reject(new Error('Native MCP timeout'));proc.kill()},25000)
try{
 await rpc('initialize',{clientInfo:{name:'lt_native_mcp_test',version:'1'},capabilities:{experimentalApi:true}});proc.stdin.write('{"method":"initialized"}\n')
 const started=await rpc('thread/start',{cwd,config,ephemeral:false,approvalPolicy:'on-request',sandbox:'read-only'})
 assert.ok(started.thread?.id)
 activeThread=started.thread.id
 const status=await rpc('mcpServerStatus/list',{threadId:started.thread.id,limit:100,detail:'toolsAndAuthOnly'})
 assert.equal(authorization,`Bearer ${token}`,'native MCP must read bearer token from its process environment')
 assert.ok(JSON.stringify(status).includes('list_tasks'))
 await rpc('mcpServer/tool/call',{threadId:activeThread,server:MANAGED_MCP,tool:'update_task',arguments:{id:'synthetic-task'}})
 assert.equal(writeCount,0,'declined native elicitation must not apply the synthetic write')
 elicitationDecision='accept'
 await rpc('mcpServer/tool/call',{threadId:activeThread,server:MANAGED_MCP,tool:'update_task',arguments:{id:'synthetic-task'}})
 assert.equal(writeCount,1)
 assert.equal(elicitationMethods.length,2)
 for(const mode of ['acceptEdits','bypassPermissions','plan','dontAsk']){
   const next=codexManagedConfig({token,epoch:1,tools:['list_tasks','update_task']},mode)
   next[`mcp_servers.${MANAGED_MCP}`].url=config[`mcp_servers.${MANAGED_MCP}`].url
   next['mcp_servers.synthetic_http_alias.enabled']=false;next['mcp_servers.synthetic_stdio_alias.enabled']=false
   const thread=await rpc('thread/start',{cwd,config:next,ephemeral:true,approvalPolicy:['bypassPermissions','dontAsk'].includes(mode)?'never':'on-request',sandbox:'read-only'})
   assert.ok(thread.thread.id,`native ${mode} setup must accept the approval configuration`)
 }
 await new Promise(resolve=>setTimeout(resolve,200))
 let rollout=''
 for(let retry=0;retry<10;retry++){try{rollout=await readFile(started.thread.path,'utf8');break}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,100))}}
 assert.equal(rollout.includes(token),false)
 assert.equal(JSON.stringify(messages).includes(token),false)
 // Codex logs and thread-history SQLite WALs are where inline HTTP headers leaked during the earlier probe.
 const scan=execFileSync('python3',['-c',`import sys,json,mmap\nfrom pathlib import Path\nneedle=json.load(sys.stdin).encode();root=Path.home()/'.codex'\nhits=[]\nfor p in [root/'config.toml',*root.glob('*.sqlite*')]:\n if p.is_file() and p.stat().st_size:\n  with p.open('rb') as f:\n   with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as data:\n    if data.find(needle)>=0:hits.append(p.name)\nprint(json.dumps(hits))`],{input:JSON.stringify(token),encoding:'utf8'})
 assert.deepEqual(JSON.parse(scan),[],'native bearer token must not be persisted in config, logs or thread-history stores')
 await rpc('thread/archive',{threadId:started.thread.id}).catch(()=>{})
 console.log('installed Codex native MCP: token-free config in every permission mode, HTTP/stdio alias preservation, real elicitation decline/accept, bearer env and no persisted/raw credential')
}finally{clearTimeout(timer);proc.kill();server.closeAllConnections();server.close()}
