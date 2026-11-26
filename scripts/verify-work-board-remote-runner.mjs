// SDK -> production SSH process adapter -> SSH2 loopback -> real CLI with isolated remote credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ssh2 from 'ssh2'
import { boardInference } from './fixtures/work-board-inference.mjs'

const root = await realpath(await mkdtemp(join(tmpdir(), 'board-remote-')))
const compiled = await mkdtemp(join(process.cwd(), 'node_modules', '.board-remote-test-'))
const localHome = join(root, 'local-without-login')
const remoteHome = join(root, 'remote-home')
const caseDir = join(remoteHome, "사건 A's $literal")
const sandbox = join(remoteHome, "sessions A's $literal")
const workspace = 'ssh://office' + caseDir
const remoteKey = 'loopback-remote-credential'
const nativeCli = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-' + process.platform + '-' + process.arch + '/claude')
const definition = "---\nname: remote-writer\ndescription: 원격 담당자\n---\n원격 담당자 'REMOTE_PROFILE_MARKER' $literal"
const local = { HOME: localHome, CLAUDE_CONFIG_DIR: join(localHome, '.claude'), PATH: '/usr/bin:/bin', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' }
const actions = []
const requests = []
const commands = []
const progress = []
let requestedTool
const inference = boardInference((input, headers) => {
  requests.push({ key: headers['x-api-key'], tools: input.tools.map(t => t.name).sort(), system: JSON.stringify(input.system), history: JSON.stringify(input.messages) })
  const reply = Array.isArray(requestedTool) ? requestedTool.shift() : requestedTool
  if (!Array.isArray(requestedTool) || !requestedTool.length) requestedTool = undefined
  return reply || { text: '## 결론\n원격 보고 완료' }
})
const client = new ssh2.Client()
const children = new Set()
const hostKeys = [ssh2.utils.generateKeyPairSync('ed25519').private]
const transport = new ssh2.Server({ hostKeys }, conn => {
  conn.on('error', () => { })
  conn.on('authentication', auth => auth.method === 'password' && auth.username === 'fixture' && auth.password === 'loopback' ? auth.accept() : auth.reject(['password']))
  conn.on('ready', () => conn.on('session', accept => accept().on('exec', (start, _reject, info) => {
    assert.ok(!info.command.includes(localHome), 'remote process command must not contain local paths')
    commands.push(info.command)
    const stream = start()
    const proc = spawn('/bin/sh', ['-c', info.command], {
      cwd: remoteHome,
      env: {
        HOME: remoteHome, PATH: join(remoteHome, '.local/bin') + ':/usr/bin:/bin', SHELL: join(remoteHome, 'fixture-shell'),
        CLAUDE_CONFIG_DIR: join(remoteHome, '.claude'),
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + inference.address().port,
        BOARD_FIXTURE_CLI: nativeCli, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost'
      }
    })
    children.add(proc)
    proc.on('close', () => children.delete(proc))
    stream.pipe(proc.stdin)
    proc.stdin.on('error', () => { })
    proc.stdout.pipe(stream, { end: false })
    proc.stderr.pipe(stream.stderr, { end: false })
    stream.on('signal', () => proc.kill())
    stream.on('close', () => proc.kill())
    proc.on('close', code => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
  })))
})
function disk(uri) {
  assert.ok(uri === workspace || uri.startsWith(workspace + '/'), 'filesystem access escaped case folder')
  return uri.slice('ssh://office'.length)
}
try {
  await Promise.all([local.CLAUDE_CONFIG_DIR, join(remoteHome, '.local/bin'), join(remoteHome, '.claude'), caseDir, sandbox]
    .map(directory => mkdir(directory, { recursive: true })))
  // The credential is available only after the remote login shell loads its profile.
  await writeFile(join(remoteHome, 'fixture-shell'), [
    '#!/bin/sh', '[ "$1" = "-ilc" ] || exit 125', 'echo "fixture shell startup message"',
    'export ANTHROPIC_API_KEY=' + remoteKey, 'exec /bin/sh -c "$2"'
  ].join('\n') + '\n', {mode:0o700})
  await writeFile(join(remoteHome, '.local/bin', 'claude'), [
    '#!/bin/sh', 'pwd -P > "$HOME/launch-cwd"', 'printf "%s\\0" "$@" > "$HOME/launch-argv"', 'exec "$BOARD_FIXTURE_CLI" "$@"'
  ].join('\n') + '\n', { mode: 0o700 })
  const outside = join(remoteHome, 'outside.txt')
  await writeFile(outside, 'PRIVATE_SENTINEL')
  await symlink(outside, join(caseDir, 'alias.txt'))
  const hookMarker = join(remoteHome, 'hook-was-run')
  await writeFile(join(remoteHome, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch "' + hookMarker + '"' }] }] } }))
  inference.listen(0, '127.0.0.1')
  await once(inference, 'listening')
  transport.listen(0, '127.0.0.1')
  await once(transport, 'listening')
  client.connect({ host: '127.0.0.1', port: transport.address().port, username: 'fixture', password: 'loopback' })
  await once(client, 'ready')

  // No real account state is used, even if the developer happens to be signed in.
  Object.assign(process.env, local)
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[key]
  let remotePlugins = []
  globalThis.boardRemoteFixture = {
    async rfsBoardAgentSources(uri) { assert.equal(uri, workspace); return [definition] },
    async rfsBoardPluginAgents(uri) { assert.equal(uri, workspace); return remotePlugins },
    async rfsBoardClaudeConnection(uri) { assert.equal(uri, workspace); return { client, cwd: sandbox } },
    async rfsRealpath(uri) { return 'ssh://office' + await realpath(disk(uri)) },
    async rfsMkdir(uri, name) { await mkdir(join(disk(uri), name)) },
    async rfsWriteText(uri, content, expected) { assert.equal(expected, null); await writeFile(disk(uri), content, { flag: 'wx' }) },
    async rfsBoardApprovedCommand(uri, command) { assert.equal(uri, workspace); actions.push(command); return '실행 확인' },
    readWorkspaceDocument() { throw Error('case_read must reject escaped symlink before reading') },
    rfsList() { throw Error('unexpected list') }
  }
  const stubs = {
    remoteFs: `export const {rfsBoardAgentSources,rfsBoardPluginAgents,rfsBoardClaudeConnection,rfsRealpath,rfsMkdir,rfsWriteText,rfsBoardApprovedCommand,rfsList}=globalThis.boardRemoteFixture; export const isRemote=p=>p.startsWith('ssh://')`,
    projectAgent: 'export const {readWorkspaceDocument}=globalThis.boardRemoteFixture',
    'agent-service': 'export const cleanEnv=()=>(' + JSON.stringify(local) + '); export const packagedClaudeAgentSdkExecutable=()=>"/nonexistent-fixture/local-claude"'
  }
  const file = join(compiled, 'runner.mjs')
  await build({
    stdin: { contents: "export * from './src/main/workBoardRunner'; export { boardClaudeCommand } from './src/main/agent/boardRemoteClaude'", resolveDir: process.cwd() }, outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{
      name: 'fixture-storage', setup(b) {
        b.onResolve({ filter: /\/(?:remoteFs|projectAgent|agent-service)$/ }, a => ({ path: a.path.split('/').at(-1), namespace: 'mock' }))
        b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: stubs[a.path] }))
      }
    }]
  })
  const { runBoardAgent, listBoardAgents, boardClaudeCommand } = await import(pathToFileURL(file))
  assert.deepEqual(await listBoardAgents(workspace), [{ name: 'remote-writer', description: '원격 담당자' }])
  const run = (id, phase, approvedTools = [], resume, readMcpTodos) => runBoardAgent({
    task: { id, cwd: workspace, agent: 'remote-writer' }, phase, prompt: '가상 원격 사건 검토', policyDir: localHome,
    signal: AbortSignal.timeout(30_000), approvedTools, resume, readMcpTodos, onProgress: message => progress.push(message)
  })
  // The owner can review application data even if the remote agent folder and CLI are offline.
  const todoReport = '## 앱 할 일 검토\n\n미완료 1건 · 내부 사건 항목'
  let scopedReads = 0
  const nativeReview = await runBoardAgent({
    task:{id:'todo',cwd:'ssh://offline/case',agent:'remote-writer'}, phase:'work', prompt:'할 일 검토',
    policyDir:localHome, approvedTools:[], signal:AbortSignal.timeout(30000), onProgress:message=>progress.push(message),
    readTodos:async()=>{ scopedReads++; return todoReport }
  })
  assert.deepEqual(nativeReview,{text:todoReport})
  assert.equal(scopedReads,1)
  assert.equal(commands.length,0)
  assert.equal(requests.length,0)
  assert.ok(progress.includes('앱의 할 일 목록 조회 · 지정 담당 remote-writer'))
  requestedTool = { name: 'mcp__board__case_draft', args: { name: '결과.md', text: '원격 전용 초안' } }
  assert.match((await run('remote', 'work')).text, /원격 보고 완료/)
  assert.equal(await readFile(join(caseDir, '_업무산출물', 'remote-결과.md'), 'utf8'), '원격 전용 초안')
  assert.ok(requests.some(r => r.system.includes('REMOTE_PROFILE_MARKER')))
  assert.ok(requests.every(r => r.key === remoteKey))
  const todoTool = 'mcp__jurisupport__list_tasks'
  assert.deepEqual(requests[0].tools, ['mcp__board__case_draft', 'mcp__board__case_list', 'mcp__board__case_read', 'mcp__board__request_action', todoTool])
  assert.ok(!commands.some(c => c.includes(nativeCli) || c.includes(remoteKey) || c.includes('nonexistent-fixture')))
  assert.equal((await readFile(join(remoteHome, 'launch-cwd'), 'utf8')).trimEnd(), sandbox)
  const args = (await readFile(join(remoteHome, 'launch-argv'), 'utf8')).split('\0').slice(0, -1)
  assert.doesNotThrow(() => boardClaudeCommand(sandbox, args))
  for (const unsafeArgs of [
    [...args, '--unrecognized-flag'],
    [...args, '--strict-mcp-config'],
    [...args, '--resume=not-a-session-id'],
    args.filter(a => a !== '--strict-mcp-config'),
    args.map(a => a === '--permission-mode=default' ? '--permission-mode=plan' : a),
    args.map(a => a === '--agent=remote-writer' ? '--agent=invalid name' : a)
  ]) assert.throws(() => boardClaudeCommand(sandbox, unsafeArgs))
  assert.throws(() => boardClaudeCommand('../sessions', args))
  for (const unsafeArgs of [
    [...args.filter(a => a !== '--strict-mcp-config'), '--plugin-dir=/home/u/.claude/plugins/cache/m/other-plugin/1.0.0'],
    [...args, '--model=haiku;rm'],
    [...args, '--max-budget-usd=-1'],
    args.map(a => a.startsWith('--max-turns') ? '--max-turns=99' : a)
  ]) assert.throws(() => boardClaudeCommand(sandbox, unsafeArgs))

  // The server's own korean-law plugin and its specialists: model, stop line and plugin MCP reach the remote CLI.
  const pluginDir = join(remoteHome, '.claude/plugins/cache/fixture-market/korean-law/1.0.0')
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
  await writeFile(join(pluginDir, 'law-server.mjs'), `import readline from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'korean-law', version: '1.0.0' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_law', description: '법령 검색', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } })
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'FIXTURE_LAW_RESULT ' + m.params.arguments.query }] } })
  else send({ jsonrpc: '2.0', id: m.id, result: {} })
})
`)
  await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'korean-law', version: '1.0.0',
    mcpServers: { 'korean-law': { command: process.execPath, args: [join(pluginDir, 'law-server.mjs')] } } }))
  remotePlugins = [{ name: 'korean-law', path: pluginDir, agents: ['---\nname: law-expert\ndescription: 법령 전문가\nmodel: haiku\n---\nPLUGIN_AGENT_MARKER'] }]
  assert.deepEqual((await listBoardAgents(workspace)).map(agent => agent.name), ['remote-writer', 'korean-law:law-expert'])
  requestedTool = { name: 'mcp__plugin_korean-law_korean-law__search_law', args: { query: '민법 제750조' } }
  const lawRun = await runBoardAgent({
    task: { id: 'law', cwd: workspace, agent: 'korean-law:law-expert', delegatedBy: 'dept' }, phase: 'work', prompt: '법령 확인', policyDir: localHome,
    signal: AbortSignal.timeout(60_000), approvedTools: [], budgetUsd: 5, department: { team: '법률지원', role: 'member', tools: { 'korean-law': 'allow' } },
    onProgress: message => progress.push(message)
  })
  assert.match(lawRun.text, /원격 보고 완료/)
  const lawArgs = (await readFile(join(remoteHome, 'launch-argv'), 'utf8')).split('\0').slice(0, -1)
  for (const flag of ['--plugin-dir=' + pluginDir, '--model=haiku', '--max-budget-usd=5', '--agent=korean-law:law-expert']) assert.ok(lawArgs.includes(flag), flag)
  assert.ok(!lawArgs.includes('--strict-mcp-config'))
  assert.ok(requests.at(-1).tools.includes('mcp__plugin_korean-law_korean-law__search_law'))
  assert.ok(requests.at(-1).history.includes('FIXTURE_LAW_RESULT 민법 제750조'), 'the server plugin answered')
  assert.ok(requests.at(-1).system.includes('PLUGIN_AGENT_MARKER'))
  remotePlugins = []

  const legacyId = 'f625cf46-64a2-4073-9fa3-74b9942b9f94'
  await writeFile(join(localHome, 'sessions', 'legacy-work.session'), legacyId)
  const prior = commands.length
  await assert.rejects(run('legacy', 'work', [], legacyId), /SSH 서버/)
  assert.equal(commands.length, prior)
  await assert.rejects(readFile(hookMarker), { code: 'ENOENT' })

  requestedTool = { name: 'mcp__board__request_action', args: { name: 'Bash', args: { command: 'echo fixture' } } }
  const blocked = await run('denied', 'work', ['Bash(echo fixture)'])
  assert.ok(blocked.blocked)
  assert.match(blocked.text, /결재 필요/)
  assert.deepEqual(actions, [])

  requestedTool = { name: todoTool, args: {} }
  const needsScope = await run('read-todos', 'work')
  assert.ok(needsScope.blocked)
  assert.match(needsScope.text, /mcp__jurisupport__list_tasks/)
  const todoList = tasks => JSON.stringify({ scope:{kind:'case', caseId:'A'}, total:tasks.length, tasks })
  const readMcpTodos = async () => { scopedReads++; return todoList([{ title: 'SCOPED_MCP_FIXTURE_TODO' }]) }
  for (const call of [
    { name: todoTool, args: {} },
    { name: 'mcp__board__request_action', args: { name: 'mcp__jurisupport__list_todos', args: {} } }
  ]) {
    requestedTool = call
    const before = requests.length
    assert.match((await run('read-todos', 'work', [], undefined, readMcpTodos)).text, /원격 보고 완료/)
    assert.ok(requests.slice(before).some(r => r.history.includes('SCOPED_MCP_FIXTURE_TODO')))
  }
  assert.equal(scopedReads, 3)
  const noLookup = await run('read-todos', 'work', [], undefined, readMcpTodos)
  assert.ok(noLookup.blocked)
  assert.match(noLookup.text, /할일 조회를 수행하지 않았습니다/)
  requestedTool = { name: todoTool, args: {} }
  const unreadable = await run('read-todos', 'work', [], undefined, async () => { throw Error('계정이 변경되었습니다.') })
  assert.ok(unreadable.blocked)
  assert.match(unreadable.text, /계정이 변경되었습니다/)
  requestedTool = { name: todoTool, args: {} }
  assert.match((await run('empty-todos', 'work', [], undefined, async () => todoList([]))).text, /원격 보고 완료/)
  const largeList = todoList(['FIRST_PAGE', 'LAST_PAGE'].map(id => ({id, title:'한'.repeat(2200)})))
  const bothPages = () => [1,2].map(page => ({name:todoTool, args:{page}}))
  let pageReads = 0
  const beforePages = requests.length
  requestedTool = bothPages()
  assert.match((await run('paged', 'work', [], undefined, async () => { pageReads++; return largeList })).text, /원격 보고 완료/)
  assert.equal(pageReads, 2)
  const pageHistory = requests.slice(beforePages).map(request => request.history)
  assert.ok(pageHistory.some(text => text.includes('FIRST_PAGE') && text.includes('nextPage') && !text.includes('LAST_PAGE')))
  assert.ok(pageHistory.some(text => text.includes('LAST_PAGE')))
  requestedTool = bothPages()[0]
  assert.match((await run('incomplete', 'work', [], undefined, async () => largeList)).text, /2페이지 중 1페이지만/)
  requestedTool = bothPages()
  let changingRead = 0
  const changed = await run('changed', 'work', [], undefined, async () => ++changingRead === 1 ? largeList : todoList([{title:'CHANGED_ROWS'}]))
  assert.ok(changed.blocked)
  assert.match(changed.text, /조회 중 할일 목록이 변경/)
  assert.ok(!requests.at(-1).history.includes('CHANGED_ROWS'))
  requestedTool = bothPages()[0]
  const oversize = await run('oversize', 'work', [], undefined, async () => todoList([{title:'한'.repeat(5000)}]))
  assert.ok(oversize.blocked)
  assert.match(oversize.text, /할일 한 건이 너무 커서/)

  requestedTool = { name: 'mcp__board__case_read', args: { path: 'alias.txt' } }
  assert.match((await run('alias', 'work')).text, /원격 보고 완료/)
  assert.ok(requests.some(r => r.history.includes('작업 폴더 밖')))
  assert.ok(requests.every(r => !r.history.includes('PRIVATE_SENTINEL')))

  requestedTool = { name: 'mcp__board__request_action', args: { name: 'Bash', args: { command: 'echo fixture' } } }
  assert.match((await run('granted', 'execute', ['Bash(echo fixture)'])).text, /원격 보고 완료/)
  assert.ok(!requests.at(-1).tools.includes(todoTool))
  assert.deepEqual(actions, ['echo fixture'])
  assert.ok(commands.length >= 4)
  assert.ok(requests.every(r => r.key === remoteKey))
  await writeFile(join(remoteHome, '.local/bin', 'claude'), '#!/bin/sh\nexit 127\n')
  await assert.rejects(run('missing-cli', 'work'), /원격 서버에 Claude CLI/)
  console.log('SSH2 채널과 실제 Claude CLI로 원격 인증·담당자·산출물·경로 제한·권한 차단·결재 실행 확인')
} finally {
  await Promise.all([...children].map(child => {
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    return closed
  }))
  client.end()
  transport.close()
  inference.closeAllConnections()
  inference.close()
  delete globalThis.boardRemoteFixture
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
