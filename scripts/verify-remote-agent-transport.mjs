import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RemoteAgentTransport, probeRemoteAgentRun } from '../src/main/agent/remoteAgentTransport.ts'

const root = await mkdtemp(join(tmpdir(), 'remote-agent-check-'))
const fakeSsh = join(root, 'ssh.py')
await writeFile(fakeSsh, String.raw`
import os, shlex, sys
outer = shlex.split(sys.argv[-1])
args = shlex.split(outer[-1].split('; exec ', 1)[1])
args[3] = args[3].replace("os.path.expanduser('~')", repr(os.environ['LEGAL_AGENT_TEST_ROOT']))
os.execvp(args[0], args)
`)
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`
const claude = String.raw`
import json, os, sys, time
print(json.dumps({'type':'system','subtype':'init','session_id':'claude-persistent','pid':os.getpid()}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if message.get('type') == 'user':
        print(json.dumps({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool'}}), flush=True)
    elif message.get('type') == 'control_response':
        time.sleep(0.15)
        print(json.dumps({'type':'assistant','message':'approved exactly once'}), flush=True)
        print('private stderr', file=sys.stderr, flush=True)
        print(json.dumps({'type':'result','result':'done'}), flush=True)
    elif message.get('type') == 'fail': sys.exit(12)
`
const codex = String.raw`
import json, sys, time
token = ''
for line in sys.stdin:
    try: message = json.loads(line)
    except ValueError:
        token = line.strip()
        continue
    if message.get('method') == 'thread/start':
        print(json.dumps({'id':message['id'],'result':{'thread':{'id':'codex-persistent'}}}), flush=True)
    elif message.get('method') == 'turn/start':
        print(json.dumps({'method':'notice','token':token}), flush=True)
        print(json.dumps({'id':message['id'],'result':{'turn':{'id':'turn-1'}}}), flush=True)
        print(json.dumps({'id':900,'method':'item/commandExecution/requestApproval','params':{}}), flush=True)
    elif message.get('id') == 900:
        print(json.dumps({'method':'turn/completed','params':{'turn':{'id':'turn-1'}}}), flush=True)
    elif message.get('method') == 'config/read':
        print(json.dumps({'id':message['id'],'result':{'config':{'mcp_servers':{'private':{'token':'do-not-persist-token'}}}}}), flush=True)
`
const options = (provider = 'claude', id = provider) => ({
  sshBin: 'python3', sshArgs: [fakeSsh],
  env: { ...process.env, LEGAL_AGENT_TEST_ROOT: root },
  identity: { id, provider }
})
const clients = []
const runs = []
const orphanPids = []
const orphanDirectories = []
function start(opts) {
  const process = new RemoteAgentTransport(opts)
  const result = { process, stdout: '', stderr: '', replayed: 0, errors: [], closed: false }
  process.stdout.on('data', (data) => { result.stdout += data })
  process.stderr.on('data', (data) => { result.stderr += data })
  process.on('replayComplete', () => result.replayed++)
  process.on('error', (error) => result.errors.push(error))
  process.on('close', (code) => { result.closed = true; result.code = code })
  clients.push(result)
  return result
}
async function until(check, label) {
  for (let n = 0; n < 600 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), label)
}
function write(client, message) { client.process.stdin.write(JSON.stringify(message) + '\n') }
async function attach(base, runId) {
  const result = start({ ...base, runId })
  await result.process.ready
  await until(() => result.replayed, 'attachment must finish backlog replay')
  return result
}
try {
  assert.equal(await probeRemoteAgentRun(options()), null, 'read-only absent probe')
  const first = start({ ...options(), command: `python3 -u -c ${quote(claude)}`, metadata: { userText: 'keep going', messageId: 'm1' } })
  const info = await first.process.ready
  runs.push({ base: options(), runId: info.runId })
  assert.equal(info.attached, false)
  assert.ok(info.startedAt > 0)
  assert.equal(info.hasTurnInput, false)
  await until(() => first.stdout.includes('claude-persistent'), 'Claude init must arrive')
  write(first, { type: 'user', message: 'work' })
  await until(() => first.stdout.includes('permission-1'), 'permission must arrive')
  first.process.detach()
  const waiting = await probeRemoteAgentRun(options())
  assert.equal(waiting.hasTurnInput, true)
  assert.equal(waiting.running, true, 'detaching must preserve waiting worker')
  assert.deepEqual(waiting.pendingRequestIds, ['permission-1'])
  assert.equal(waiting.metadata.messageId, 'm1')
  const alias = await probeRemoteAgentRun({ ...options('claude', 'other-device'), identity: { id: 'other-device', provider: 'claude', resumeSessionId: 'claude-persistent' } })
  assert.equal(alias.runId, info.runId, 'real session identity must discover run from another tab')
  const busy = start({ ...options(), command: `python3 -u -c ${quote(claude)}` })
  await assert.rejects(busy.process.ready, /다른 컴퓨터/)
  await until(() => busy.closed, 'conflicting start must finish')

  const second = await attach(options(), info.runId)
  assert.equal(second.stdout, first.stdout, 'active replay must match output exactly')
  const otherDevice = await attach(options(), info.runId)
  const operation = { type: 'input', id: 'same-operation', data: Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: 'permission-1' } }) + '\n').toString('base64') }
  second.process.pending.set(operation.id, operation)
  second.process.connection.stdin.write(JSON.stringify(operation) + '\n')
  second.process.connection.stdin.write(JSON.stringify(operation) + '\n')
  write(otherDevice, { type: 'control_response', response: { request_id: 'permission-1' } })
  second.process.connection.kill('SIGKILL')
  await until(() => second.process.connected && second.replayed >= 2, 'SSH loss must reconnect automatically')
  await until(() => second.stdout.includes('approved exactly once'), 'worker must finish while SSH is disconnected')
  second.process.reconnect()
  await until(() => second.process.connected && second.replayed >= 3, 'wake reconnect must preserve cursor')
  assert.equal((second.stdout.match(/approved exactly once/g) || []).length, 1, 'retry and replay must not duplicate output/input')
  otherDevice.process.detach()
  second.process.detach()
  const third = await attach(options(), info.runId)
  assert.ok(!third.stdout.includes('permission-1'), 'answered historical permissions must not reappear')
  assert.ok(third.stdout.includes('approved exactly once'))
  assert.equal(third.stderr, 'private stderr\n')
  third.process.stdin.end()
  await until(() => third.closed, 'explicit end-input must finish worker')
  assert.equal(third.code, 0)
  const finished = await probeRemoteAgentRun(options())
  assert.equal(finished.running, false, 'completed run must remain discoverable')
  const final = await attach(options(), info.runId)
  await until(() => final.closed, 'completed replay must end')
  assert.equal(final.stdout, third.stdout)
  assert.equal(final.code, 0)

  const failure = start({ ...options(), command: `python3 -u -c ${quote(claude)}` })
  const failureInfo = await failure.process.ready
  runs.push({ base: options(), runId: failureInfo.runId })
  write(failure, { type: 'user', message: 'wait before failure' })
  await until(() => failure.stdout.includes('permission-1'), 'failed run must have an unanswered approval')
  write(failure, { type: 'fail' })
  await until(() => failure.closed, 'nonzero process exit must propagate')
  assert.equal(failure.code, 12)
  assert.deepEqual((await probeRemoteAgentRun(options())).pendingRequestIds, [], 'finished run must expose no answerable approvals')
  const failedReplay = await attach(options(), failureInfo.runId)
  await until(() => failedReplay.closed, 'failed run replay must end')
  assert.ok(!failedReplay.stdout.includes('permission-1'), 'failed run replay must suppress unanswered historical approval')
  assert.equal((await probeRemoteAgentRun({ ...options(), identity: { id: 'alias-newest', provider: 'claude', resumeSessionId: 'claude-persistent' } })).runId, failureInfo.runId, 'session alias must discover newest turn')

  const codexBase = options('codex')
  const codexClient = start({ ...codexBase, command: `python3 -u -c ${quote(codex)}` })
  const codexInfo = await codexClient.process.ready
  runs.push({ base: codexBase, runId: codexInfo.runId })
  codexClient.process.stdin.write('managed-token-must-stay-private\n')
  write(codexClient, { id: 1, method: 'thread/start', params: {} })
  write(codexClient, { id: 2, method: 'config/read', params: {} })
  write(codexClient, { id: 3, method: 'turn/start', params: {} })
  await until(() => codexClient.stdout.includes('requestApproval'), 'Codex approval must arrive')
  const codexState = await probeRemoteAgentRun(codexBase)
  assert.equal(codexState.sessionId, 'codex-persistent')
  assert.equal(codexState.lastRequestId, 3)
  assert.deepEqual(codexState.pendingRequestIds, [900])
  assert.ok(!codexClient.stdout.includes('do-not-persist-token'))
  assert.ok(!codexClient.stdout.includes('managed-token-must-stay-private'))
  codexClient.process.detach()
  const codexRestored = await attach(codexBase, codexInfo.runId)
  const otherCodexDevice = await attach(codexBase, codexInfo.runId)
  write(codexRestored, { id: 900, result: { decision: 'accept' } })
  write(otherCodexDevice, { id: 900, result: { decision: 'decline' } })
  await until(() => codexRestored.stdout.includes('turn/completed'), 'Codex approval must resume after detach')
  await until(() => !codexRestored.process.pending.size && !otherCodexDevice.process.pending.size, 'both devices must receive response acknowledgements')
  otherCodexDevice.process.detach()
  codexRestored.process.kill()
  await until(() => codexRestored.closed, 'explicit stop must terminate remote worker')
  assert.ok(codexRestored.code !== 0)
  const codexReplay = await attach(codexBase, codexInfo.runId)
  await until(() => codexReplay.closed, 'stopped run replay must finish')
  assert.equal((codexReplay.stdout.match(/turn\/completed/g) || []).length, 1, 'different transport operations answering the same Codex request must be forwarded once')
  assert.ok(!codexReplay.stdout.includes('requestApproval'), 'resolved Codex approval must be filtered')
  const largeBase = options('claude', 'large-input')
  const large = start({ ...largeBase, command: `python3 -u -c ${quote("import sys\nfor _ in range(128): print('x'*16384, flush=True)\nline = sys.stdin.readline()\nprint('large-done', len(line), flush=True)\n")}` })
  const largeInfo = await large.process.ready
  runs.push({ base: largeBase, runId: largeInfo.runId })
  large.process.stdin.write(JSON.stringify({ type: 'user', message: 'x'.repeat(2 * 1024 * 1024) }) + '\n')
  await until(() => large.closed, 'large simultaneous stdin/stdout must not deadlock')
  assert.ok(large.stdout.includes('large-done'))
  assert.equal(large.code, 0)

  const crashBase = options('claude', 'broker-crash')
  const crash = start({ ...crashBase, command: `python3 -u -c ${quote("import os, time\nprint(os.getpid(), flush=True)\ntime.sleep(60)\n")}` })
  const crashInfo = await crash.process.ready
  runs.push({ base: crashBase, runId: crashInfo.runId })
  await until(() => crash.stdout.trim(), 'crash test child must initialize')
  orphanPids.push(Number(crash.stdout.trim()))
  orphanDirectories.push(dirname(crashInfo.socket))
  const crashJournal = join(root, '.legal-terminal', 'agent-runs', crashInfo.runId, 'events')
  const partialRecord = JSON.stringify({ type: 'stdout', data: Buffer.from('partial-record-survived\n').toString('base64') }) + '\n'
  const split = Math.floor(partialRecord.length / 2)
  await appendFile(crashJournal, partialRecord.slice(0, split))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(crash.closed, false, 'an incomplete journal append must not end a healthy connection')
  assert.deepEqual(crash.errors, [])
  await appendFile(crashJournal, partialRecord.slice(split))
  await until(() => crash.stdout.includes('partial-record-survived'), 'completed append must replay exactly once')
  assert.equal((crash.stdout.match(/partial-record-survived/g) || []).length, 1)
  await appendFile(crashJournal, '{"type":')
  process.kill(crashInfo.pid, 'SIGKILL')
  await until(() => crash.closed, 'broker death must close an attached transport')
  assert.equal(crash.code, 1)
  assert.match(crash.stderr, /예기치 않게/)
  const crashed = await probeRemoteAgentRun(crashBase)
  assert.equal(crashed.running, false)
  assert.equal(crashed.interrupted, true)
  const crashReplay = await attach(crashBase, crashInfo.runId)
  await until(() => crashReplay.closed, 'crashed broker replay must end rather than hang')
  assert.equal(crashReplay.code, 1)

  const runRoot = join(root, '.legal-terminal', 'agent-runs')
  for (const run of runs) {
    for (const file of await readdir(join(runRoot, run.runId))) {
      const path = join(runRoot, run.runId, file)
      assert.equal((await stat(path)).mode & 0o077, 0, 'run artifacts must be private')
      const raw = await readFile(path, 'utf8')
      const decoded = file === 'events' ? raw.split('\n').slice(0, -1).map((line) => { const event = JSON.parse(line); return event.data ? Buffer.from(event.data, 'base64').toString() : line }).join('\n') : raw
      assert.ok(!decoded.includes('do-not-persist-token'), 'config credentials must not be persisted')
      assert.ok(!decoded.includes('managed-token-must-stay-private'), 'known bearer tokens must be redacted')
    }
  }
  console.log('Remote agent transport: detach/reconnect, permission recovery, exact cursor replay, duplicate input, run aliases, private config logs, explicit EOF/stop, completed-run discovery, broker crash, partial journal writes and large bidirectional I/O passed')
} finally {
  for (const client of clients) client.process.detach()
  for (const { base, runId } of runs) {
    try {
      const state = await probeRemoteAgentRun({ ...base, runId })
      if (state?.running) {
        const cleanup = start({ ...base, runId })
        await cleanup.process.ready
        cleanup.process.kill()
        await until(() => cleanup.closed, 'cleanup worker')
      }
    } catch {}
  }
  for (const client of clients) client.process.detach()
  for (const pid of orphanPids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  for (const directory of orphanDirectories) await rm(directory, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}
