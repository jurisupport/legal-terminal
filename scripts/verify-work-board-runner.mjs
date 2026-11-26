// Actual bundled Claude process, with an isolated agent definition and a loopback-only inference fixture.
import assert from 'node:assert/strict'
import { boardInference } from './fixtures/work-board-inference.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { boardPermission, boardRelativePath, readBoardPolicy } from '../src/main/workBoardPolicy.ts'

const directory = await mkdtemp(join(tmpdir(), 'board-runner-'))
const compiled = await mkdtemp(join(process.cwd(), 'node_modules', '.board-runner-'))
let researchCalls = 0
let scenario = '', toolCalled = false, observedTools, sawNamedAgent = false, observedSystem = '', observedModel = '', toolResult = ''
const server = boardInference(input => {
  observedTools = input.tools?.map(t => t.name)
  observedSystem = JSON.stringify(input.system)
  observedModel = input.model
  toolResult = JSON.stringify(input.messages)
  sawNamedAgent ||= observedSystem.includes('SYNTHETIC_AGENT_MARKER')
  if (scenario === 'research') {
    // Two read-only lookups, then the report.
    const step = researchCalls++
    if (step === 0) return { name: 'mcp__research__legal_books_search', args: { query: '소멸시효', top_k: 2 } }
    if (step === 1) return { name: 'mcp__research__lbox_search', args: { queries: ['소멸시효 중단'], limit: 3 } }
    return { text: '## 결론\n조사 완료' }
  }
  const useTool = !toolCalled && scenario !== 'report'
  const name = scenario === 'draft' ? 'mcp__board__case_draft' : scenario === 'delegate' ? 'mcp__board__assign_members'
    : scenario === 'route' ? 'mcp__board__assign_departments' : 'mcp__board__request_action'
  const args = scenario === 'draft' ? { name: '초안.md', text: '검수 본문' }
    : scenario === 'route' ? { routes: [
      { team: '조사부', title: '판결 조사', goal: '판결 목록', sources: [], scope: '대법원 판결만', output: '표', after: [] },
      { team: '작성부', title: '의견서', goal: '의견서 초안', sources: [], scope: '조사 결과로 작성', output: '서면 md', after: [1] }] }
    : scenario === 'delegate' ? { assignments: [{ member: 'fixture', title: '사실관계 정리', goal: '사건 경과표', sources: ['기록/소장.pdf'], scope: '기록을 시간순으로 정리', output: '표', after: [] }] }
    : {name:'Bash',args:{command:'echo approved'}}
  if (useTool) toolCalled = true
  return useTool ? {name,args} : {text:scenario === 'review' ? '검토 완료\nREVIEW: PASS' : '## 결론\n검수 완료'}
})
try {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR,'agents'), {recursive:true})
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR,'agents','fixture.md'), '---\nname: fixture\ndescription: 테스트\n---\nSYNTHETIC_AGENT_MARKER')
  // A specialist's own model and turn budget come from its file.
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR,'agents','member.md'), '---\nname: member\ndescription: 부서원\nmodel: haiku\nmaxTurns: 5\ntools: [Read]\n---\nMEMBER_AGENT_MARKER')
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
    './remoteFs': 'export const isRemote=()=>false; export function remote(){throw Error("unexpected SSH")} export {remote as rfsBoardAgentSources,remote as rfsBoardPluginAgents,remote as rfsBoardClaudeConnection,remote as rfsList,remote as rfsRealpath,remote as rfsMkdir,remote as rfsWriteText,remote as rfsBoardApprovedCommand}'
  }
  const file = join(compiled,'runner.mjs')
  await build({entryPoints:['src/main/workBoardRunner.ts'],outfile:file,format:'esm',platform:'node',bundle:true,packages:'external',plugins:[{ name:'local-fixtures',setup(b) {
    b.onResolve({filter:/^\.\.\/remoteFs$/},()=>({path:'./remoteFs',namespace:'stub'}))
    b.onResolve({filter:/^\.\//},a=>Object.hasOwn(stubs,a.path)?{path:a.path,namespace:'stub'}:null)
    b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path]}))
  }}]})
  const {runBoardAgent,listBoardAgents} = await import(pathToFileURL(file))
  assert.deepEqual((await listBoardAgents()).sort((a,b)=>a.name.localeCompare(b.name)),[{name:'fixture',description:'테스트'},{name:'member',description:'부서원'}])
  const progress = []
  const todoInput = {
    task: {id:'todo',cwd:join(directory,'unavailable-case')}, phase:'work', prompt:'할 일 검토',
    approvedTools:[], policyDir:join(directory,'unused-policy'), signal:new AbortController().signal,
    onProgress:message=>progress.push(message)
  }
  const report = '## 앱 할 일 검토\n\n미완료 0건'
  let reads = 0
  assert.deepEqual(await runBoardAgent({...todoInput, readTodos:async()=>{ reads++; return report }}),{text:report})
  assert.equal(reads,1)
  assert.equal(observedTools,undefined)
  const missing = await runBoardAgent({...todoInput, readTodos:async()=>'   '})
  assert.equal(missing.blocked,true)
  assert.match(missing.text,/조회 결과를 받지 못했습니다/)
  const lostAccount = await runBoardAgent({...todoInput, readTodos:async()=>{ throw Error('계정이 변경되었습니다.') }})
  assert.equal(lostAccount.blocked,true)
  assert.match(lostAccount.text,/계정이 변경/)
  const abort = new AbortController()
  await assert.rejects(runBoardAgent({...todoInput,signal:abort.signal,readTodos:async()=>{ abort.abort(); return report }}),{name:'AbortError'})
  const run = (phase,approvedTools=[],readTodos,withOwnership) => runBoardAgent({task:{id:'sample',cwd:directory,agent:'fixture'},phase,prompt:'검수용 지시',
    approvedTools,readTodos,withOwnership,signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  let fenced = 0
  const lostOwnership = async () => { fenced++; throw Error('다른 기기로 전환됨') }
  scenario='draft'
  assert.ok((await run('work',[],undefined,lostOwnership)).blocked)
  assert.equal(fenced,1)
  await assert.rejects(readFile(join(directory,'_업무산출물','sample-초안.md')),{code:'ENOENT'})
  toolCalled=false
  assert.match((await run('work')).text,/검수 완료/)
  assert.match(await readFile(join(directory,'_업무산출물','sample-초안.md'),'utf8'),/검수 본문/)
  assert.equal(sawNamedAgent,true)
  await assert.rejects(readFile(hookMarker),{code:'ENOENT'})
  assert.ok(observedTools?.includes('mcp__board__case_draft'))
  assert.deepEqual([...observedTools].sort(),['mcp__board__case_draft','mcp__board__case_list','mcp__board__case_read','mcp__board__request_action','mcp__jurisupport__list_tasks'])
  toolCalled=false; scenario='command'
  assert.match((await run('work',['Bash(echo approved)'])).text,/결재 필요/)
  assert.equal(progress.some(message=>message.includes('승인된 실행')),false)
  toolCalled=false
  assert.ok((await run('execute',['Bash(echo approved)'],undefined,lostOwnership)).blocked)
  assert.equal(fenced,2)
  assert.equal(progress.some(message=>message.includes('승인된 실행')),false)
  toolCalled=false
  assert.match((await run('execute',['Bash(echo approved)'],async()=>{ reads++; return report })).text,/검수 완료/)
  toolCalled=false; scenario='delegate'
  const delegated = await runBoardAgent({task:{id:'dept',cwd:directory,team:'송무팀'},phase:'work',prompt:'준비서면 초안',agentName:'fixture',
    delegation:{team:'송무팀',members:[{name:'fixture',description:'테스트'}]},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  assert.deepEqual(delegated.assignments,[{member:'fixture',title:'사실관계 정리',after:[],
    instruction:'## 목표\n사건 경과표\n\n## 참고 자료\n- 기록/소장.pdf\n\n## 범위\n기록을 시간순으로 정리\n\n## 산출물 형식\n표'}])
  assert.ok(observedTools?.includes('mcp__board__assign_members'))
  assert.ok(progress.some(message=>message.startsWith('부서장 배분 · fixture 사실관계 정리')))
  // A member works under its department's rules; a tool the department keeps off is refused without an approval request.
  toolCalled=false; scenario='command'
  const member = await runBoardAgent({task:{id:'member',cwd:directory,agent:'member',delegatedBy:'dept'},phase:'work',prompt:'하위 업무',
    department:{team:'송무팀',role:'member',rules:'DEPARTMENT_RULES_MARKER',tools:{}},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  assert.equal(member.blocked,undefined)
  assert.match(member.text,/검수 완료/)
  assert.ok(progress.includes('부서 도구 권한 없음 · Bash'))
  assert.match(toolResult,/부서에는 이 도구\(Bash\)를 쓸 권한이 없습니다/)
  assert.match(observedSystem,/DEPARTMENT_RULES_MARKER[\s\S]*MEMBER_AGENT_MARKER/)
  assert.match(observedModel,/haiku/)
  assert.ok(member.costUsd > 0, 'session cost is reported')
  // A department that asks first still sends the command to the approval inbox.
  toolCalled=false
  const asking = await runBoardAgent({task:{id:'member2',cwd:directory,agent:'member',delegatedBy:'dept'},phase:'work',prompt:'하위 업무',
    department:{team:'송무팀',role:'member',tools:{bash:'ask'}},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  assert.equal(asking.blocked,true)
  assert.match(asking.text,/결재 필요[\s\S]*Bash\(echo approved\)/)
  // The chief of staff routes to departments in order with the same instruction form.
  toolCalled=false; scenario='route'
  const routed = await runBoardAgent({task:{id:'chief',cwd:directory,chief:true},phase:'work',prompt:'의견서',
    routing:{teams:[{name:'조사부',description:'조사',members:1},{name:'작성부',members:1}]},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  assert.deepEqual(routed.routes.map(r => [r.team, r.title, r.after]), [['조사부','판결 조사',[]],['작성부','의견서',[1]]])
  assert.match(routed.routes[1].instruction, /^## 목표\n의견서 초안/)
  assert.ok(observedTools?.includes('mcp__board__assign_departments'))
  assert.match(observedSystem + JSON.stringify(observedTools), /assign_departments/)
  assert.ok(progress.some(message=>message.startsWith('비서실장 배분 · 조사부 판결 조사')))

  // legal-books and lbox open only where the department allows them, through the services' own HTTP APIs.
  const { createServer } = await import('node:http')
  const research = []
  const services = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk
    research.push([req.url, JSON.parse(body)])
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(req.url === '/search' && JSON.parse(body).query
      ? { results: [{ cite: '저자, 『민법』, 2020, 10면', text: 'BOOK_TEXT' }] } : { op: 'search', result: [{ case_no: '2020다1', url: 'https://lbox.kr/case/1' }] }))
  })
  await new Promise(resolve => services.listen(0,'127.0.0.1',resolve))
  process.env.LEGAL_BOOKS_URL = process.env.LBOX_SERVER_URL = 'http://127.0.0.1:' + services.address().port
  try {
    scenario='research'; researchCalls=0
    const looked = await runBoardAgent({task:{id:'look',cwd:directory,agent:'fixture',delegatedBy:'dept'},phase:'work',prompt:'조사',
      department:{team:'조사부',role:'member',tools:{'legal-books':'allow',lbox:'allow'}},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
    assert.match(looked.text,/조사 완료/)
    assert.deepEqual(research.map(([url,body]) => [url, body.query ?? body.queries]), [['/search','소멸시효'],['/search',['소멸시효 중단']]])
    assert.match(toolResult, /2020다1/)
    assert.ok(observedTools.includes('mcp__research__legal_books_search') && observedTools.includes('mcp__research__lbox_fetch'))
    // Without the department's permission the tools are not offered at all.
    toolCalled=false; scenario='report'
    await runBoardAgent({task:{id:'plain',cwd:directory,agent:'fixture',delegatedBy:'dept'},phase:'work',prompt:'조사',
      department:{team:'조사부',role:'member',tools:{}},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:()=>{}})
    assert.equal(observedTools.some(name => name.startsWith('mcp__research__')), false)
  } finally { services.close(); delete process.env.LEGAL_BOOKS_URL; delete process.env.LBOX_SERVER_URL }

  // A session past the department's stop line ends as a review item, not a failure.
  toolCalled=false; scenario='command'
  const stopped = await runBoardAgent({task:{id:'budget',cwd:directory,agent:'member',delegatedBy:'dept'},phase:'work',prompt:'하위 업무',budgetUsd:0.0000001,
    department:{team:'송무팀',role:'member',tools:{}},approvedTools:[],signal:AbortSignal.timeout(30000),policyDir:directory,onProgress:message=>progress.push(message)})
  assert.equal(stopped.blocked,true)
  assert.match(stopped.text,/비용 정지선 도달/)
  assert.ok(stopped.costUsd > 0)

  scenario='review'
  assert.equal((await run('review',[],async()=>{ reads++; return report })).rejected,false)
  assert.equal(reads,1)
  assert.ok(progress.some(message=>message.includes('승인된 실행')))
  console.log('Named native SDK session, actual draft, denied Bash in ordinary phase, and exact approved command passed using local synthetic inference.')
} finally {
  server.closeAllConnections()
  server.close()
  await rm(compiled,{recursive:true,force:true})
  await rm(directory,{recursive:true,force:true})
}
