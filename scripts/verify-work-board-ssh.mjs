// Exercise the production SSH pool and board store against a private loopback OpenSSH SFTP server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import ssh2 from 'ssh2'

const binary = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync)
if (!binary) throw new Error('이 검증에는 OpenSSH sftp-server가 필요합니다.')
const root = await realpath(await mkdtemp(join(tmpdir(), 'lt-board-sftp-')))
const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
const identity = ssh2.utils.generateKeyPairSync('ed25519')
const privateKey = join(root, 'identity')
const publicKey = ssh2.utils.parseKey(identity.private).getPublicSSH()
const user = randomUUID()
let connections = 0
let configOverride = null
let configLookups = 0
const server = new ssh2.Server({hostKeys: [hostKey.private]}, client => {
  connections++
  client.on('error', () => {})
  client.on('authentication', ctx => {
    const ok = ctx.username === user && ctx.method === 'publickey' && ctx.key.data.equals(publicKey)
    if (!ok || (ctx.signature && !ssh2.utils.parseKey(identity.private).verify(ctx.blob, ctx.signature))) ctx.reject()
    else ctx.accept()
  })
  client.on('ready', () => client.on('session', accept => accept().on('exec', (start, reject, info) => {
    assert.match(info.command, /CLAUDE_CONFIG_DIR/)
    configLookups++
    if (configOverride === null) return reject()
    const channel = start()
    const shell = spawn('/bin/sh', ['-c', info.command], {
      cwd: root, env: {HOME:root, SHELL:join(root,'login-shell'), PATH:'/usr/bin:/bin', TEST_CLAUDE_CONFIG:configOverride}
    })
    channel.pipe(shell.stdin)
    shell.stdin.on('error', () => {})
    shell.stdout.pipe(channel, {end:false})
    shell.stderr.pipe(channel.stderr, {end:false})
    shell.on('close', code => {channel.exit(code ?? 1); channel.end()})
  }).on('subsystem', (start, reject, info) => {
    if (info.name !== 'sftp') return reject()
    const channel = start()
    const child = spawn(binary, [], {cwd: root, stdio: ['pipe', 'pipe', 'ignore']})
    channel.pipe(child.stdin)
    child.stdout.pipe(channel)
    child.stdin.on('error', () => {})
    channel.on('close', () => child.kill())
  })))
})
const require = createRequire(import.meta.url)
const source = buildSync({
  stdin: {contents: `
    export {WorkBoard} from './src/main/workBoard'
    export {WorkBoardStore} from './src/main/workBoardStore'
    export {setJsPairing} from './src/main/caseStore'
    export {disposeRemote, rfsBoardAgentSources} from './src/main/remoteFs'
  `, resolveDir: process.cwd()},
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external'
}).outputFiles[0].text
const mod = new Module(import.meta.filename)
let sdkRuns = 0
mod.require = id => {
  if (id === 'electron') return {app: {getPath: () => root}}
  if (id === 'os' || id === 'node:os') return { ...require(id), homedir: () => root }
  if (id === '@anthropic-ai/claude-agent-sdk') return { ...require(id), query() { sdkRuns++; throw Error('Unexpected model session') } }
  return require(id)
}
mod._compile(source, import.meta.filename)
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await writeFile(privateKey, identity.private, {mode: 0o600})
  await writeFile(join(root, 'login-shell'), [
    '#!/bin/sh', 'test "$1" = "-ilc" || exit 2', 'echo login-banner',
    'export CLAUDE_CONFIG_DIR="$TEST_CLAUDE_CONFIG"', 'exec /bin/sh -c "$2"'
  ].join('\n'), {mode:0o700})
  await writeFile(join(root, 'config.json'), JSON.stringify({jurisupportTokenEnc:'plain:loopback-test',sshProfiles: [{id: 'test', host: '127.0.0.1', port, user, identityFile: privateKey}]}))
  const key = ssh2.utils.parseKey(hostKey.private)
  const fingerprint = createHash('sha256').update(JSON.stringify(['127.0.0.1', port, key.type])).digest('hex')
  await mkdir(join(root,'ssh-host-keys'))
  await writeFile(join(root, 'ssh-host-keys', fingerprint), key.getPublicSSH().toString('base64'))
  const sshWorkspace = 'ssh://test' + root
  const lookup = () => mod.exports.rfsBoardAgentSources(sshWorkspace)
  assert.deepEqual(await lookup(), [], 'a missing remote agents directory is a normal empty roster')
  const agentFile = '---\nname: remote-review\ndescription: 검토\n---\nREMOTE_AGENT_MARKER'
  const agentsDir = join(root, '.claude', 'agents')
  await mkdir(agentsDir, {recursive:true})
  await writeFile(join(agentsDir, 'remote.md'), agentFile)
  await writeFile(join(agentsDir, 'oversize.md'), Buffer.alloc(256 * 1024 + 1))
  await symlink(privateKey, join(agentsDir, 'linked.md'))
  const realClock = Date.now
  let elapsed = 121_000
  try {
    Date.now = () => realClock() + elapsed
    const [a,b] = await Promise.all([lookup(),lookup()])
    assert.deepEqual(a,[agentFile])
    assert.deepEqual(b,a)
    assert.equal(configLookups,2,'parallel lookups share a single request on this SSH connection')
    elapsed += 121_000
    configOverride = ''
    assert.deepEqual(await lookup(), [agentFile], 'shell HOME fallback selects the same directory')
    elapsed += 121_000
    configOverride = join(root,'custom config')
    await mkdir(join(configOverride,'agents'),{recursive:true})
    await writeFile(join(configOverride,'agents','custom.md'), agentFile.replace('REMOTE_AGENT_MARKER','REMOTE_CONFIG_MARKER'))
    assert.deepEqual(await lookup(),[agentFile.replace('REMOTE_AGENT_MARKER','REMOTE_CONFIG_MARKER')])
  } finally { Date.now = realClock }
  const folder = join(root, '_업무지시')
  const board = new mod.exports.WorkBoardStore('ssh://test' + folder)
  await board.init()
  assert.equal(await board.claimOwner('one'), true)
  assert.equal(await board.claimOwner('two'), false)
  assert.ok((await board.teams()).length)
  const at = new Date().toISOString()
  const task = {id:'20261124-001', title:'검토', cwd:'ssh://test' + root, body:'확인', createdAt:at, updatedAt:at, order:0, attempts:0, status:'queued', log:[]}
  await board.save(task)
  const [queued] = await board.list()
  await board.save({...queued, status:'done'})
  // SFTP encodes whole seconds; establish the same exact on-disk timestamp for both writes.
  const savedPath = join(folder, task.id + '.md')
  const fixedSecond = 1_700_000_000
  await utimes(savedPath, fixedSecond, fixedSecond)
  assert.equal((await board.list())[0].status, 'done')
  // A sync client may replace a historical file while retaining both SFTP metadata fields.
  const original = await readFile(savedPath, 'utf8')
  await writeFile(savedPath, original.replace('title: 검토', 'title: 변경'))
  await utimes(savedPath, fixedSecond, fixedSecond)
  assert.equal((await board.list())[0].title, '검토', 'unchanged archive should use the manifest cache')
  const clock = Date.now
  try {
    Date.now = () => clock() + 61_000
    assert.equal((await board.list())[0].title, '변경', 'rotating audit finds equal-signature updates')
  } finally { Date.now = clock }
  await board.writeText(task.id + '.report.md', '검토 완료')
  await board.writeText('_일일보고/2026-11-24.md', '일일 보고')
  assert.equal(await board.readText(task.id + '.report.md'), '검토 완료')
  assert.equal(await readFile(join(folder, '_일일보고/2026-11-24.md'), 'utf8'), '일일 보고')
  // Run a native review end-to-end on a separate, newly owned SFTP board.
  const caseDir = join(root, '사건')
  const remoteCase = 'ssh://test' + caseDir
  await mkdir(caseDir)
  await mod.exports.setJsPairing('remote:test:case-a', {drafts:caseDir})
  const workflow = new mod.exports.WorkBoard(remoteCase, remoteCase + '/_업무지시', join(root,'owner-private'), () => {})
  const nativeFetch = globalThis.fetch
  const queries = []
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10)
  const rows = [
    {id:'A', title:'A 제출 준비', caseId:'case-a', status:'pending', dueDate:'2000-01-01', assigneeId:null},
    {id:'B', title:'B 의뢰인 면담', caseId:'case-a', status:'in_progress', dueDate:today, assigneeName:'김담당'},
    {id:'C', title:'C 종료한 일', caseId:'case-a', status:'completed'},
    {id:'X', title:'X 별건 초안', caseId:'case-x', status:'pending', dueDate:today, assigneeId:null}
  ]
  globalThis.fetch = async (url, options) => {
    assert.equal(url,'https://api.jurisupport.com/mcp')
    assert.equal(options.headers.Authorization,'Bearer loopback-test')
    const rpc = JSON.parse(options.body)
    let result = {}
    if (rpc.method === 'tools/call') {
      queries.push(rpc.params)
      result = {content:[{type:'text',text:JSON.stringify({tasks:rows, total:rows.length, hasNext:false})}]}
    } else assert.ok(['initialize','notifications/initialized'].includes(rpc.method))
    return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}), {headers:{'mcp-session-id':'loopback'}})
  }
  try {
    await workflow.start()
    const execsBeforeAdd = configLookups
    await workflow.add([{title:'할일 검토',body:'할일 검토',todoScope:{kind:'case',caseId:'case-a'}}])
    let review
    const deadline = Date.now() + 15_000
    do {
      review = (await workflow.snapshot()).tasks[0]
      if (['awaiting_approval','failed','blocked'].includes(review?.status)) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.equal(review?.status,'awaiting_approval',JSON.stringify(review?.log))
    assert.ok(!review.agent && !review.review_agent)
    assert.deepEqual(queries,[{name:'list_tasks',arguments:{type:'todo',includeClosed:false,fields:'compact',page:1,limit:100,caseId:'case-a'}}])
    assert.equal(configLookups,execsBeforeAdd,'no SSH exec channel opened by the instruction')
    assert.equal(sdkRuns,0,'no Claude SDK session')
    const report = (await workflow.detail(review.id)).report
    const stored = await readFile(join(caseDir,'_업무지시',review.id + '.report.md'))
    assert.deepEqual(stored,Buffer.from(report))
    for (const value of ['미완료 할일 2건','기한 초과 1건','기한 임박 1건','담당자 미지정 1건','A 제출 준비','B 의뢰인 면담']) assert.ok(report.includes(value),value)
    assert.doesNotMatch(report,/C 종료한 일|X 별건 초안|loopback-test/)
    console.log('원격 사건 할일 검토 · 범위 확인 · 단일 읽기 · SSH 지시서와 실제 보고서 바이트 일치')
  } finally {
    workflow.stop()
    globalThis.fetch = nativeFetch
  }
  assert.equal(connections, 1)
  console.log('실제 루프백 SSH/SFTP 연결 1개에서 지시서 생성·변경·조회, 보고서 및 일일 보고 저장 확인')
} finally {
  mod.exports.disposeRemote('test')
  server.close()
  await rm(root, {recursive: true, force: true})
}
