// Actual bundled Claude process, with an isolated agent definition and a loopback-only inference fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { boardPermission, boardRelativePath, readBoardPolicy } from '../src/main/workBoardPolicy.ts'

const directory = await mkdtemp(join(tmpdir(), 'board-runner-'))
const compiled = await mkdtemp(join(process.cwd(), 'node_modules', '.board-runner-'))
let scenario = '', toolCalled = false, observedTools, sawNamedAgent = false
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 3 }))
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  observedTools = input.tools?.map(t => t.name)
  sawNamedAgent ||= JSON.stringify(input.system).includes('SYNTHETIC_AGENT_MARKER')
  const useTool = !toolCalled && scenario !== 'report'
  const name = scenario === 'draft' ? 'mcp__board__case_draft' : 'mcp__board__request_action'
  const args = scenario === 'draft' ? { name: '초안.md', text: '검수 본문' } : {name:'Bash',args:{command:'echo approved'}}
  if (useTool) toolCalled = true
  const answer = '## 결론\n검수 완료'
  const stop = useTool ? 'tool_use' : 'end_turn'
  const message = {id:'msg_fixture',type:'message',role:'assistant',model:input.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:8,output_tokens:8}}
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  function event(type, value) { res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`) }
  event('message_start',{message})
  event('content_block_start',{index:0,content_block:useTool ? {type:'tool_use',id:'toolu_fixture',name,input:{}} : {type:'text',text:''}})
  event('content_block_delta',{index:0,delta:useTool ? {type:'input_json_delta',partial_json:JSON.stringify(args)} : {type:'text_delta',text:answer}})
  event('content_block_stop',{index:0})
  event('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:8}})
  event('message_stop',{})
  res.end()
})
try {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR,'agents'), {recursive:true})
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR,'agents','fixture.md'), '---\nname: fixture\ndescription: 테스트\n---\nSYNTHETIC_AGENT_MARKER')
  const hookMarker = join(directory, 'unexpected-hook')
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR,'settings.json'), JSON.stringify({
    hooks:{SessionStart:[{hooks:[{type:'command',command:`echo ran > "${hookMarker}"`}]}]}
  }))
  const [policy, otherPolicy] = await Promise.all([readBoardPolicy(directory),readBoardPolicy(directory)])
  assert.deepEqual(otherPolicy,policy)
  for (const tool of ['Bash','mcp__mail__send','Agent','Write','WebFetch']) {
    assert.equal(boardPermission(tool,'echo approved',[],policy),false)
  }
  assert.equal(boardPermission('Bash','echo changed',['Bash(echo approved)'],policy),false)
  assert.equal(boardPermission('mcp__mail__send',undefined,['mcp__mail__*'],policy),false)
  assert.equal(boardPermission('case_read',undefined,[],{...policy,dangerTools:['*read*']}),false)
  for (const path of ['../private','/absolute','C:\\boot','a/.config']) assert.throws(() => boardRelativePath(path))
  const url = 'http://127.0.0.1:' + server.address().port
  const fixtureEnv = { PATH:process.env.PATH, SYSTEMROOT:process.env.SYSTEMROOT, TEMP:process.env.TEMP, TMPDIR:tmpdir(), CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,
    ANTHROPIC_API_KEY:'local-test-only', ANTHROPIC_BASE_URL:url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
    HTTPS_PROXY:'http://127.0.0.1:1', HTTP_PROXY:'http://127.0.0.1:1', NO_PROXY:'127.0.0.1,localhost' }
  const stubs = {
    './agent/agent-service': 'export const cleanEnv=()=>(' + JSON.stringify(fixtureEnv) + '); export const packagedClaudeAgentSdkExecutable=()=>undefined;',
    './projectAgent': 'export function readWorkspaceDocument(){throw Error("unexpected read")}',
    './remoteFs': 'export const isRemote=()=>false; export function remote(){throw Error("unexpected SSH")} export {remote as rfsList,remote as rfsRealpath,remote as rfsMkdir,remote as rfsWriteText,remote as rfsBoardApprovedCommand}'
  }
  const file = join(compiled,'runner.mjs')
  await build({entryPoints:['src/main/workBoardRunner.ts'],outfile:file,format:'esm',platform:'node',bundle:true,packages:'external',plugins:[{ name:'local-fixtures',setup(b) {
    b.onResolve({filter:/^\.\//},a=>Object.hasOwn(stubs,a.path)?{path:a.path,namespace:'stub'}:null)
    b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path]}))
  }}]})
  const {runBoardAgent,listBoardAgents} = await import(pathToFileURL(file))
  assert.deepEqual(await listBoardAgents(),[{name:'fixture',description:'테스트'}])
  const progress = []
  const run = (phase,approvedTools=[]) => runBoardAgent({task:{id:'sample',cwd:directory,agent:'fixture'},phase,prompt:'검수용 지시',
    approvedTools,signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  scenario='draft'
  assert.match((await run('work')).text,/검수 완료/)
  assert.match(await readFile(join(directory,'_업무산출물','sample-초안.md'),'utf8'),/검수 본문/)
  assert.equal(sawNamedAgent,true)
  await assert.rejects(readFile(hookMarker),{code:'ENOENT'})
  assert.ok(observedTools?.includes('mcp__board__case_draft'))
  assert.deepEqual([...observedTools].sort(),['mcp__board__case_draft','mcp__board__case_list','mcp__board__case_read','mcp__board__request_action'])
  toolCalled=false; scenario='command'
  assert.match((await run('work',['Bash(echo approved)'])).text,/결재 필요/)
  assert.equal(progress.some(message=>message.includes('승인된 실행')),false)
  toolCalled=false
  assert.match((await run('execute',['Bash(echo approved)'])).text,/검수 완료/)
  assert.ok(progress.some(message=>message.includes('승인된 실행')))
  console.log('Named native SDK session, actual draft, denied Bash in ordinary phase, and exact approved command passed using local synthetic inference.')
} finally {
  server.closeAllConnections()
  server.close()
  await rm(compiled,{recursive:true,force:true})
  await rm(directory,{recursive:true,force:true})
}
