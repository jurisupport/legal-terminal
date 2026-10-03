import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { RemoteAgentTransport, probeRemoteAgentRun } from '../src/main/agent/remoteAgentTransport.ts'
import * as execution from '../src/main/agent/agentExecutionLock.ts'
import * as progress from '../src/main/agent/agentProgress.ts'
import * as mcp from '../src/main/agent/agentMcp.ts'

// Exercise the real service, broker, execution lock and native message protocols.
// Only the provider executables, SSH host, auth probes and optional summaries are fake.
const root = await mkdtemp(join(tmpdir(), 'agent-recovery-'))
const fakeSsh = join(root, 'ssh.py')
const fakeProvider = join(root, 'provider.py')
await writeFile(fakeSsh, String.raw`
import os, shlex, sys
outer = shlex.split(sys.argv[-1])
args = shlex.split(outer[-1].split('; exec ', 1)[1])
args[3] = args[3].replace("os.path.expanduser('~')", repr(os.environ['LEGAL_AGENT_TEST_ROOT']))
os.execvp(args[0], args)
`)
await writeFile(fakeProvider, String.raw`
import json, os, sys, threading, time
provider, identity, root = sys.argv[1:4]
native = provider + '-' + identity
trace = os.path.join(root, identity + '.jsonl')
release = os.path.join(root, identity + '.release')
lock = threading.Lock()
background = None
def log(value):
    with open(trace, 'a') as out: out.write(json.dumps(value) + '\n')
def emit(value):
    with lock: print(json.dumps(value), flush=True)
def notice(method, **params):
    emit({'method': method, 'params': {'threadId': native, **params}})
def permission(number):
    if provider == 'claude':
        emit({'type':'control_request', 'request_id':str(900 + number), 'request':{
            'subtype':'can_use_tool', 'tool_name':'Bash', 'tool_use_id':'tool-' + str(number),
            'input':{'command':'echo recovery'}}})
    else:
        emit({'id':900 + number,'method':'item/commandExecution/requestApproval',
            'params':{'threadId':native,'turnId':'turn-1','itemId':'tool-' + str(number),'command':'echo recovery'}})
def child():
    if provider == 'claude':
        emit({'type':'system','subtype':'task_started','task_id':'child-1','tool_use_id':'child-tool','task_type':'local_agent','is_backgrounded':True})
        emit({'type':'result','subtype':'success','result':'parent finished','usage':{}})
    else:
        notice('item/started', turnId='turn-1', item={'id':'child-activity','type':'subAgentActivity','kind':'started','agentThreadId':'child-1'})
        notice('turn/completed', turn={'id':'turn-1','status':'completed'})
    log({'child':'started'})
    deadline = time.monotonic() + 25
    while not os.path.exists(release) and time.monotonic() < deadline: time.sleep(0.02)
    if not os.path.exists(release): os._exit(17)
    if provider == 'claude':
        emit({'type':'system','subtype':'task_notification','task_id':'child-1','status':'completed','summary':'background finished'})
    else:
        notice('item/completed', turnId='turn-1', item={'id':'child-activity','type':'subAgentActivity','kind':'completed','agentThreadId':'child-1'})
    log({'child':'finished'})
log({'pid':os.getpid()})
for line in sys.stdin:
    message = json.loads(line)
    log({'input':message})
    if provider == 'claude':
        if message.get('type') == 'user':
            emit({'type':'system','subtype':'init','session_id':native})
            emit({'type':'assistant','uuid':'native-answer-1','message':{'id':'native-answer-1','role':'assistant','content':[{'type':'text','text':'started once'}]}})
            if identity.endswith('-exit-error'):
                print('synthetic remote failure', file=sys.stderr, flush=True)
                sys.exit(23)
            if identity.endswith('-result-error'):
                emit({'type':'result','subtype':'error_during_execution','errors':['synthetic result failure'],'usage':{}})
                continue
            permission(1)
        elif message.get('type') == 'control_response':
            request = message['response'].get('request_id')
            if request == '901': permission(2)
            elif request == '902':
                background = threading.Thread(target=child, daemon=True)
                background.start()
        elif message.get('type') == 'control_request':
            emit({'type':'control_response','response':{'subtype':'success','request_id':message['request_id'],'response':{}}})
    else:
        method = message.get('method')
        if method == 'initialize': emit({'id':message['id'],'result':{}})
        elif method in ('thread/start','thread/resume'): emit({'id':message['id'],'result':{'thread':{'id':native}}})
        elif method == 'turn/start':
            emit({'id':message['id'],'result':{'turn':{'id':'turn-1'}}})
            notice('turn/started', turn={'id':'turn-1'})
            notice('item/completed', turnId='turn-1', item={'id':'native-answer-1','type':'agentMessage','text':'started once'})
            if identity.endswith('-exit-error'):
                print('synthetic remote failure', file=sys.stderr, flush=True)
                sys.exit(23)
            permission(1)
        elif message.get('id') == 901: permission(2)
        elif message.get('id') == 902:
            background = threading.Thread(target=child, daemon=True)
            background.start()
        elif method == 'turn/interrupt':
            emit({'id':message['id'],'result':{}})
            notice('turn/completed', turn={'id':'turn-1','status':'interrupted'})
if background: background.join(25)
`)

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`
const options = (identity) => ({
  sshBin: 'python3', sshArgs: [fakeSsh], identity,
  env: { ...process.env, LEGAL_AGENT_TEST_ROOT: root }
})
const clients = []
const identities = []
class TestTransport extends RemoteAgentTransport {
  constructor(opts) {
    const args = execution.agentExecutionArgs(opts.identity)
    args[2] = args[2].replaceAll("os.path.expanduser('~')", JSON.stringify(root))
    const command = ['python3', ...args, 'python3', '-u', fakeProvider, opts.identity.provider, opts.identity.id, root]
      .map(quote).join(' ')
    super({ ...opts, ...options(opts.identity), ...(opts.command ? { command } : {}) })
    clients.push(this)
  }
}
const require = createRequire(import.meta.url)
const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${service}
refreshAgentAuthStatus = (session) => emitAuthStatus(session, 'authenticated');
prefetchClaudeSlashCommands = () => {};
maybeGenerateSessionTitle = () => {};
scheduleWorkSummary = () => {};
flushWorkSummary = () => {};
export const recoveryCheck = { sessions, responseTimer, currentSessionStatus };
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const services = []
function freshApp(usageHydration) {
  const module = { exports: {} }
  runInNewContext(compiled, {
    exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => {
      if (name === './remoteAgentTransport') return { RemoteAgentTransport: TestTransport,
        probeRemoteAgentRun: (opts) => probeRemoteAgentRun({ ...opts, ...options(opts.identity) }) }
      if (name === './agentExecutionLock') return execution
      if (name === './agentProgress') return progress
      if (name === './agentMcp') return mcp
      if (name === '../sessions') return { rememberSessionMeta: async () => {}, readSessionTokenUsage: async () => usageHydration }
      if (name === '../sshOptions') return { buildSshArgs: () => [] }
      if (name === '../jurisupport') return { getAgentMcpConnection: async () => undefined, agentMcpAccountEpoch: () => 1, onAgentMcpAccountChange: () => {} }
      if (name === './agentPrompt') return { prependAgentContext: (_context, text) => text }
      if (name === '../../shared/media') return {}
      if (name === '@anthropic-ai/claude-agent-sdk') return { query: () => { throw new Error('Unexpected real model query') } }
      if (name === 'child_process') return { spawn: () => { throw new Error('Unexpected unmanaged subprocess') } }
      if (name.startsWith('.')) throw new Error(`Unexpected dependency ${name}`)
      return require(name)
    }
  })
  const api = module.exports
  api.events = []
  api.viewer = Object.assign(new EventEmitter(), {
    id: services.length + 1, isDestroyed: () => false, send: (_channel, event) => api.events.push(event)
  })
  services.push(api)
  return api
}
async function until(check, label) {
  for (let n = 0; n < 700; n++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`${label}\n${JSON.stringify(services.at(-1)?.events.slice(-8))}`)
}
const create = async (api, id, provider, source = 'ssh', resumeSessionId) => {
  assert.equal(api.createAgentSession({ id, provider, source, resumeSessionId, cwd: root, permissionMode: 'ask',
    ...(source === 'ssh' ? { ssh: { host: 'fake.invalid', user: 'test' } } : {}) }, api.viewer).ok, true)
  await until(() => !api.recoveryCheck.sessions.get(id).remoteRestoring, `${provider}: inspection finished`)
  return api.recoveryCheck.sessions.get(id)
}
const permissions = (api) => api.events.filter((event) => event.type === 'permission:request').map((event) => event.request.requestId)
const approve = (api, id, requestId) => assert.equal(api.approveAgentPermission({ sessionId: id, requestId, decision: 'allow' }).ok, true)
const trace = async (id) => (await readFile(join(root, `${id}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
const probe = (identity) => probeRemoteAgentRun(options(identity))

try {
  for (const provider of ['claude', 'codex']) {
    const identity = { id: `${provider}-recovery`, provider }
    identities.push(identity)
    const first = freshApp()
    const session = await create(first, identity.id, provider)
    assert.equal(first.sendAgentMessage(identity.id, { text: 'continue while the laptop sleeps' }).ok, true)
    await until(() => session.pendingPermissions.has('901'), `${provider}: first approval`)
    assert.equal(session.pendingPermissions.get('901').timer, undefined, 'remote approvals never expire on the laptop')
    approve(first, identity.id, '901')
    await until(() => session.pendingPermissions.has('902'), `${provider}: second approval`)
    const userId = first.events.find((event) => event.type === 'message:user').messageId
    const assistantIds = first.events.filter((event) => event.type === 'message:assistant_start').map((event) => event.messageId)
    const running = await probe(identity)
    const originalTurn = session.running
    first.closeAgentSession(identity.id)
    await until(async () => (await probe(identity))?.running, `${provider}: remote process survives close`)
    assert.equal(originalTurn.signal.aborted, false, 'detach does not abort remote work')
    assert.equal((await probe(identity)).runId, running.runId)

    const second = freshApp()
    const restored = await create(second, identity.id, provider)
    await until(() => restored.pendingPermissions.has('902'), `${provider}: pending approval restored`)
    assert.deepEqual(permissions(second), ['902'], 'answered historical approval must stay resolved')
    assert.equal(restored.pendingPermissions.get('902').timer, undefined)
    assert.equal(second.events.find((event) => event.type === 'message:user').messageId, userId)
    assert.deepEqual(second.events.filter((event) => event.type === 'message:assistant_start').map((event) => event.messageId), assistantIds)
    assert.equal(second.events.find((event) => event.type === 'session:restored').startedAt, running.startedAt)
    approve(second, identity.id, '902')
    await until(async () => (await trace(identity.id)).some((entry) => entry.child === 'started'), `${provider}: child started`)
    await until(() => provider === 'claude' ? restored.claudeTasks?.size > 0 : restored.codexActiveWork?.size > 0, `${provider}: child tracked`)
    assert.equal(second.recoveryCheck.currentSessionStatus(restored), 'working', 'parent result must retain the running child')
    assert.equal((await probe(identity)).running, true)
    second.disposeAgentSessions()
    await writeFile(join(root, `${identity.id}.release`), '')
    await until(async () => (await trace(identity.id)).some((entry) => entry.child === 'finished'), `${provider}: child completes without app`)

    const third = freshApp()
    const completed = await create(third, identity.id, provider)
    await until(() => !completed.running, `${provider}: detached result recovered`)
    await until(async () => !(await probe(identity)).running, `${provider}: remote process cleanly completes`)
    assert.deepEqual(permissions(third), [], 'completed replay cannot revive answered approval')
    assert.equal(third.events.some((event) => event.type === 'error'), false)
    third.disposeAgentSessions()

    const fourth = freshApp()
    const replay = await create(fourth, identity.id, provider)
    await until(() => !replay.running, `${provider}: completed-run replay ends`)
    assert.equal(fourth.events.find((event) => event.type === 'message:user').messageId, userId)
    assert.deepEqual(fourth.events.filter((event) => event.type === 'message:assistant_start').map((event) => event.messageId), assistantIds)
    assert.deepEqual(permissions(fourth), [])
    assert.equal(fourth.events.some((event) => event.type === 'error'), false)
    assert.ok(['done', 'idle'].includes(fourth.events.filter((event) => event.type === 'status').at(-1)?.status),
      'completed-run restoration must not leave the renderer working')
    const inputs = (await trace(identity.id)).flatMap((entry) => entry.input ? [entry.input] : [])
    assert.equal(inputs.filter((message) => provider === 'claude' ? message.type === 'user' : message.method === 'turn/start').length, 1,
      'reopening the app must never re-send the original instruction')
    fourth.disposeAgentSessions()

    const stopping = { id: `${provider}-stop`, provider }
    identities.push(stopping)
    const app = freshApp()
    const stopSession = await create(app, stopping.id, provider)
    app.sendAgentMessage(stopping.id, { text: 'wait for explicit stop' })
    await until(() => stopSession.pendingPermissions.has('901'), `${provider}: stop fixture started`)
    assert.equal(app.interruptAgentSession(stopping.id).ok, true)
    await until(async () => !(await probe(stopping)).running, `${provider}: Stop kills remote process`)
    await until(() => !stopSession.running, `${provider}: Stop cleanup finishes`)
    assert.equal(stopSession.pendingPermissions.size, 0, 'late approval must not survive Stop cleanup')
    app.disposeAgentSessions()

    const childStop = { id: `${provider}-child-stop`, provider }
    identities.push(childStop)
    const childApp = freshApp()
    const childSession = await create(childApp, childStop.id, provider)
    childApp.sendAgentMessage(childStop.id, { text: 'stop the child after its parent completes' })
    await until(() => childSession.pendingPermissions.has('901'), `${provider}: child-stop first approval`)
    approve(childApp, childStop.id, '901')
    await until(() => childSession.pendingPermissions.has('902'), `${provider}: child-stop second approval`)
    approve(childApp, childStop.id, '902')
    await until(() => provider === 'claude' ? childSession.turnCount > 0 : childSession.codexTurnWaiter?.completed,
      `${provider}: child-stop parent result received`)
    assert.equal(childApp.recoveryCheck.currentSessionStatus(childSession), 'working')
    childApp.interruptAgentSession(childStop.id)
    await until(async () => !(await probe(childStop)).running, `${provider}: Stop terminates background child despite EOF tolerance`)
    await until(() => !childSession.running, `${provider}: child-stop cleanup finishes`)
    childApp.disposeAgentSessions()
    console.log(`${provider}: approval recovery, stable replay, detached child completion, completed run, explicit Stop verified`)
  }

  for (const [provider, failure] of [['claude', 'exit-error'], ['claude', 'result-error'], ['codex', 'exit-error']]) {
    const identity = { id: `${provider}-${failure}`, provider }
    identities.push(identity)
    const first = freshApp()
    const session = await create(first, identity.id, provider)
    assert.equal(first.sendAgentMessage(identity.id, { text: 'exercise a remote failure' }).ok, true)
    await until(() => !session.running, `${identity.id}: failed process cleanup`)
    await until(async () => !(await probe(identity)).running, `${identity.id}: failed process exited`)
    first.disposeAgentSessions()
    const restored = freshApp()
    const replay = await create(restored, identity.id, provider)
    await until(() => !replay.running, `${identity.id}: failed replay cleanup`)
    assert.ok(restored.events.some((event) => event.type === 'error'), 'cold replay must preserve failure evidence')
    assert.equal(restored.events.filter((event) => event.type === 'status').at(-1)?.status, 'error',
      `${identity.id}: replay cleanup must not overwrite failure with idle`)
    restored.disposeAgentSessions()
  }
  console.log('cold failure replay: Claude nonzero/zero-exit errors and Codex nonzero exit keep error status')

  const hydrationIdentity = { id: 'claude-hydration-stop', provider: 'claude' }
  identities.push(hydrationIdentity)
  const initial = freshApp()
  const initialSession = await create(initial, hydrationIdentity.id, 'claude')
  initial.sendAgentMessage(hydrationIdentity.id, { text: 'stop while restored history is loading' })
  await until(() => initialSession.pendingPermissions.has('901'), 'hydration-stop: initial process waiting')
  const nativeSessionId = (await probe(hydrationIdentity)).sessionId
  initial.disposeAgentSessions()
  let finishHydration
  const hydration = new Promise((resolve) => { finishHydration = resolve })
  const reopening = freshApp(hydration)
  const hydrating = await create(reopening, hydrationIdentity.id, 'claude', 'ssh', nativeSessionId)
  assert.ok(hydrating.running, 'restore must be paused with a live turn at hydration')
  assert.equal(hydrating.remoteProcess, undefined, 'transport must not exist before hydration completes')
  reopening.interruptAgentSession(hydrationIdentity.id)
  assert.equal(hydrating.running.signal.aborted, true)
  finishHydration(undefined)
  await until(async () => !(await probe(hydrationIdentity)).running, 'hydration-stop: deferred attachment must honor earlier Stop')
  await until(() => !hydrating.running, 'hydration-stop: restoration cleanup finishes')
  assert.equal(hydrating.pendingPermissions.size, 0)
  assert.equal((await trace(hydrationIdentity.id)).filter((entry) => entry.input?.type === 'user').length, 1)
  reopening.disposeAgentSessions()
  console.log('hydration-stop: Stop before transport attachment still terminates the original remote turn')

  const local = freshApp()
  const localSession = await create(local, 'local-baseline', 'claude', 'local')
  const abort = new AbortController()
  localSession.running = abort
  const timer = local.recoveryCheck.responseTimer(localSession, () => {}, 10000)
  assert.ok(timer, 'local approval timeout remains enabled')
  clearTimeout(timer)
  local.closeAgentSession(localSession.id)
  assert.equal(abort.signal.aborted, true, 'closing a local session still aborts its local turn')
  console.log('local baseline: close still aborts; approval timeout remains enabled')
} finally {
  for (const api of services) api.disposeAgentSessions()
  for (const client of clients) client.detach()
  for (const identity of identities) {
    const run = await probe(identity).catch(() => null)
    if (!run?.running) continue
    const cleanup = new RemoteAgentTransport({ ...options(identity), runId: run.runId })
    cleanup.on('error', () => {})
    await cleanup.ready
    const closed = new Promise((resolve) => cleanup.once('close', resolve))
    cleanup.kill()
    await closed
  }
  await rm(root, { recursive: true, force: true })
}
