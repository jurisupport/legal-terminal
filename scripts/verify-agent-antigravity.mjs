import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as execution from '../src/main/agent/agentExecutionLock.ts'
import * as remote from '../src/main/agent/remoteAgentTransport.ts'

// Exercise create, send, snapshot, restore and stop through the native protocol in an isolated workspace.
const root = await mkdtemp(join(tmpdir(), 'antigravity-test-'))
const fixture = join(root, 'agy.py')
const events = []
const requireAgent = createRequire(new URL('../src/main/agent/agent-service.ts', import.meta.url))
const viewer = { id: 1, once() {}, isDestroyed: () => false, send: (_channel, event) => events.push(event) }
const cli = String.raw`
import json, os, sys, time, uuid
def emit(event, **fields):
    print(json.dumps({'event':event, **fields}), flush=True)
args = sys.argv[1:]
if args == ['models']:
    if 'LT_REMOTE_AGY_CWD' in os.environ:
        assert os.path.samefile(os.getcwd(), os.environ['LT_REMOTE_AGY_CWD'])
    host = 'server' if 'LT_REMOTE_AGY_CWD' in os.environ else 'local'
    print('Fetching available models...', file=sys.stderr)
    print(host + '-gemini-high\tGemini (High)')
    sys.exit(0)
assert args[args.index('--output-format')+1] == 'stream-json'
assert '--dangerously-skip-permissions' not in args
settings = json.loads(args[args.index('--settings')+1])
prompt = json.load(sys.stdin)['message']['content']
assert settings['allowNonWorkspaceAccess'] is False
denied = set(settings['permissions']['deny'])
assert {'read_url(*)', 'execute_url(*)', 'mcp(*)', 'read_file(private/**)'} <= denied
if 'simulate-edit' in prompt:
    assert args[args.index('--mode')+1] == 'accept-edits' and '--sandbox' in args
    assert args[args.index('--model')+1] == "mock-model '$HOME'"
    assert ('write_file(*)' in denied) == ('strict-policy' in prompt)
    native_files_only = any(character in os.getcwd() for character in '*?[]')
    assert ('command(*)' in denied) == (native_files_only or 'strict-policy' in prompt)
    assert 'write_file(protected/**)' in denied and 'command(rm)' in denied
    assert {'command(git)', 'write_file(needs-review/)'} <= set(settings['permissions']['ask'])
    assert {'command(git)', 'write_file(needs-review/)'} <= denied
    expected = 'strict' if 'strict-policy' in prompt else ('request-review' if 'review-policy' in prompt else 'proceed-in-sandbox')
    assert settings['toolPermission'] == expected
    target = './' if native_files_only else os.path.realpath(os.getcwd())
    assert settings['permissions']['allow'] == ([] if expected == 'strict' else ['write_file(' + target + ')'])
    assert 'unsandboxed(*)' in denied
else:
    assert {'write_file(*)', 'command(*)'} <= denied
    assert settings['permissions']['allow'] == []
    assert '--mode' not in args
    assert settings['toolPermission'] == 'strict'
assert 'read_file(drafts/**)' in settings['permissions']['ask']
if 'LT_REMOTE_AGY_CWD' in os.environ:
    assert os.path.samefile(os.getcwd(), os.environ['LT_REMOTE_AGY_CWD'])
    assert 'read_file(remote-only/**)' in settings['permissions']['deny']
native = args[args.index('--conversation')+1] if '--conversation' in args else str(uuid.uuid4())
if 'simulate-login' in prompt:
    print('Authentication required: https://accounts.google.com/o/oauth2/auth?state=private-test-state', file=sys.stderr, flush=True)
    sys.exit(1)
emit('init', conversation_id=native)
if 'simulate-empty-success' in prompt:
    emit('result', result={'status':'SUCCESS','response':'','denied_actions':[{'action':'write_file'}]})
    sys.exit(0)
if 'simulate-denial' in prompt:
    emit('result', result={'status':'ERROR', 'error':'403: Agent Platform API is disabled in test-project.'})
    sys.exit(3)
emit('step_update', step_update={'step_type':'agent_response','step_index':1,'text_delta':'응답'})
if 'simulate-interrupt' in prompt:
    time.sleep(15)
emit('result', result={'status':'SUCCESS','response':'응답 완료','conversation_id':native})
`
async function load(name, mocks) {
  const source = await readFile(new URL('../src/main/agent/' + name + '.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  runInNewContext(code, {
    exports, process, Buffer, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id) => mocks[id] ?? requireAgent(id.startsWith('.') ? id + '.ts' : id)
  })
  return exports
}
async function waitFor(predicate) {
  for (let n = 0; n < 500; n++) {
    if (events.some(predicate)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Timed out. Events: ' + JSON.stringify(events))
}

const caseFolder = join(root, "원격 사건 '인용' [(*)] $HOME")
const hostHome = join(root, 'ssh-home')
const fakeSsh = join(root, 'ssh.py')
const asRemoteHost = (options) => ({
  ...options, sshBin: 'python3', sshArgs: [fakeSsh],
  env: { HOME: hostHome, PATH: '/usr/bin:/bin', LT_REMOTE_AGY_CWD: caseFolder }
})
let api
try {
  const config = join(root, '.gemini', 'antigravity-cli')
  await mkdir(config, { recursive: true })
  await writeFile(join(config, 'settings.json'), JSON.stringify({
    toolPermission: 'strict', permissions: { deny: ['read_file(private/**)'], ask: ['read_file(drafts/**)'] }
  }))
  await writeFile(fixture, cli)
  const adapter = await load('antigravity', {
    'node:os': { homedir: () => root },
    'node:fs': { existsSync: () => false },
    'node:child_process': { spawn(command, args, options) {
      if (command === 'agy.exe') return spawn('python', [fixture, ...args], options)
      assert.equal(command, 'python3')
      const cliIndex = args.indexOf('agy')
      assert.ok(cliIndex > 0, 'wrap the fake CLI with the real execution lock')
      return spawn(command, [...args.slice(0, cliIndex), 'python3', fixture, ...args.slice(cliIndex + 1)], options)
    } },
    './agentExecutionLock': { ...execution, agentExecutionArgs: (identity) => {
      const args = execution.agentExecutionArgs(identity)
      args[2] = args[2].replace("os.path.expanduser('~')", JSON.stringify(root))
      return args
    } }
  })
  api = await load('agent-service', {
    './antigravity': adapter,
    'child_process': { execFile(bin, args, options, cb) {
      assert.ok(options.timeout > 0)
      if (bin === 'ssh') {
        assert.ok(args.includes('test@example.invalid'))
        return execFile('python3', [fakeSsh, args.at(-1)], { ...options, env: asRemoteHost({}).env }, cb)
      }
      assert.ok(bin === 'agy' || bin === 'agy.exe')
      assert.deepEqual(Array.from(args), ['models'])
      return execFile(process.platform === 'win32' ? 'python' : 'python3', [fixture, ...args], options, cb)
    } },
    './remoteAgentTransport': {
      RemoteAgentTransport: class extends remote.RemoteAgentTransport {
        constructor(options) { super(asRemoteHost(options)) }
      },
      probeRemoteAgentRun: options => remote.probeRemoteAgentRun(asRemoteHost(options))
    },
    '../jurisupport': { onAgentMcpAccountChange() {} },
    '../remoteFs': {}, '../sessions': {}, '../settings': {}, '../projectAgent': { releaseProjectMcp() {} },
    '@anthropic-ai/claude-agent-sdk': { query() { assert.fail('Antigravity opened Claude') } }
  })
  const options = { cwd: root, provider: 'antigravity' }
  const create = (id, extra = {}) => assert.equal(api.createAgentSession({ ...options, id, ...extra }, viewer).ok, true)
  const send = (id, text, permissionMode) => {
    events.length = 0
    const result = api.sendAgentMessage(id, { text, permissionMode })
    assert.equal(result.ok, true, result.error)
  }
  const reply = async (id, text = '검사', permissionMode) => {
    send(id, text, permissionMode)
    await waitFor(e => e.type === 'status' && e.status === 'idle')
    assert.equal(events.filter(e => e.type === 'message:assistant_delta').map(e => e.text).join(''), '응답 완료')
    assert.equal(events.filter(e => e.type === 'message:assistant_done').length, 1)
    assert.equal(events.some(e => e.type === 'error'), false)
    return api.getAgentSessionSnapshot(id).session.resumeSessionId
  }
  const checkCatalog = async (id, host) => {
    const model = host + '-gemini-high'
    const list = await api.listAgentModels(id)
    assert.equal(list.ok, true, list.error)
    assert.deepEqual(JSON.parse(JSON.stringify(list.models)), [{ id: model, model, displayName: 'Gemini (High)' }])
    assert.equal(api.setAgentModel(id, model).ok, true)
    assert.equal((await api.listAgentModels(id)).selectedModel, model)
    assert.equal(api.setAgentModel(id).ok, true)
    assert.equal((await api.listAgentModels(id)).selectedModel, undefined)
  }
  create('initial')
  await checkCatalog('initial', 'local')
  const native = await reply('initial')
  assert.match(native, /^[a-f0-9-]{36}$/)
  api.closeAgentSession('initial')
  create('restored', { resumeSessionId: native })
  assert.equal(await reply('restored'), native)
  send('restored', 'simulate-denial')
  await waitFor(e => e.type === 'error' && /403.*test-project/.test(e.message))
  assert.equal(events.some(e => e.type === 'auth:status' && e.state === 'unauthenticated'), false)
  send('restored', 'simulate-empty-success')
  await waitFor(e => e.type === 'error' && /권한/.test(e.message))
  assert.ok(!events.some(e => e.type === 'status' && e.status === 'done'))
  send('restored', 'simulate-interrupt')
  await waitFor(e => e.type === 'message:assistant_delta')
  assert.equal(api.interruptAgentSession('restored').ok, true)
  await waitFor(e => e.type === 'session:interrupted')
  assert.equal(await reply('restored'), native, 'interruption must release the native conversation lock')
  const testEditable = async (sessionId, config, extra, hostDeny = []) => {
    const permissions = { allow: ['unsandboxed(*)', 'write_file(*)'], deny: [
      'read_file(private/**)', 'write_file(protected/**)', 'command(rm)', ...hostDeny
    ], ask: ['command(git)', 'read_file(drafts/**)', 'write_file(needs-review/)'] }
    const file = join(config, 'settings.json')
    const original = await readFile(file)
    try {
      await writeFile(file, JSON.stringify({ permissions }))
      create(sessionId, { ...extra, model: "mock-model '$HOME'" })
      const editId = await reply(sessionId, 'simulate-edit', 'acceptEdits')
      for (const [policy, marker] of [['strict', 'strict-policy'], ['request-review', 'review-policy']]) {
        await writeFile(file, JSON.stringify({ toolPermission: policy, permissions }))
        assert.equal(await reply(sessionId, 'simulate-edit ' + marker, 'acceptEdits'), editId)
      }
      await writeFile(file, original)
      assert.equal(await reply(sessionId, '읽기 전용으로 전환', 'ask'), editId)
    } finally {
      api.closeAgentSession(sessionId)
      await writeFile(file, original)
    }
  }
  await testEditable('editable-local', config, {})
  if (process.platform !== 'win32') {
    const serverConfig = join(hostHome, '.gemini', 'antigravity-cli')
    const serverBin = join(hostHome, '.local', 'bin')
    await mkdir(caseFolder)
    await mkdir(serverConfig, { recursive: true })
    await mkdir(serverBin, { recursive: true })
    await writeFile(join(serverConfig, 'settings.json'), JSON.stringify({
      toolPermission: 'strict', permissions: { deny: ['read_file(private/**)', 'read_file(remote-only/**)'], ask: ['read_file(drafts/**)'] }
    }))
    await writeFile(join(serverBin, 'agy'), '#!/usr/bin/env python3\n' + cli, { mode: 0o700 })
    // Replace only the SSH connection; the broker, execution lock, host launcher and stream are real.
    await writeFile(fakeSsh, "import os, shlex, sys\nos.execl('/bin/sh', 'sh', '-c', shlex.split(sys.argv[-1])[-1])\n")
    const opts = { source: 'ssh', ssh: { host: 'example.invalid', user: 'test' }, cwd: caseFolder }
    await testEditable('editable-ssh', serverConfig, opts, ['read_file(remote-only/**)'])
    create('remote', opts)
    const remoteId = await reply('remote')
    await checkCatalog('remote', 'server')
    assert.match(remoteId, /^[a-f0-9-]{36}$/)
    assert.equal(await reply('remote'), remoteId)
    send('remote', 'simulate-login')
    await waitFor(e => e.type === 'error')
    assert.match(events.find(e => e.type === 'error').message, /SSH 서버.*로그인/)
    assert.ok(!JSON.stringify(events).includes('private-test-state'))
    await rm(join(serverBin, 'agy'))
    send('remote', '검사')
    await waitFor(e => e.type === 'error' && /SSH 서버.*agy를 설치/.test(e.message))
  }
  console.log('Antigravity streaming, resume, interrupt, isolated SSH execution, permissions and server login/install guidance passed')
} finally {
  api?.closeAgentSession('remote')
  api?.closeAgentSession('initial')
  api?.closeAgentSession('restored')
  await rm(root, { recursive: true, force: true })
}
