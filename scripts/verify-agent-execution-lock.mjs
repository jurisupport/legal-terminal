import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_BUSY_MESSAGE, agentExecutionArgs } from '../src/main/agent/agentExecutionLock.ts'

const root = await mkdtemp(join(tmpdir(), 'agent-execution-check-'))
const processes = []
let orphanPid
const claude = String.raw`
import json, os, signal, sys, time
args = sys.argv
session = args[args.index('--resume') + 1] if '--resume' in args else args[args.index('--session-id') + 1]
print(json.dumps({'type':'system','subtype':'init','session_id':session, 'pid':os.getpid()}), flush=True)
for line in sys.stdin:
    if line.strip() == 'fail': sys.exit(12)
    print(json.dumps({'type':'result','session':session}), flush=True)
`
const codex = String.raw`
import json, os, sys, uuid
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] in ('thread/start', 'thread/resume'):
        session = message.get('params',{}).get('threadId') or str(uuid.uuid4())
        print(json.dumps({'id':message['id'],'result':{'thread':{'id':session}}}), flush=True)
    else:
        print(json.dumps({'id':message['id'],'result':{'ok':True}}), flush=True)
`
function start(identity, code = identity.provider === 'claude' ? claude : codex) {
  const args = agentExecutionArgs(identity)
  args[2] = args[2].replace("os.path.expanduser('~')", JSON.stringify(root))
  const proc = spawn('python3', [...args, 'python3', '-u', '-c', code,
    ...(identity.provider === 'claude' && identity.resumeSessionId ? ['--resume', identity.resumeSessionId] : [])])
  const output = { proc, lines: [], stderr: '', closed: false }
  processes.push(output)
  let buffer = ''
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) if (line) output.lines.push(JSON.parse(line))
  })
  proc.stderr.on('data', (chunk) => { output.stderr += chunk })
  proc.stdin.on('error', () => {})
  output.done = new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code, signal) => { output.closed = true; resolve({ code, signal }) })
  })
  return output
}
async function wait(check, message) {
  for (let n = 0; n < 500 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), message)
}
async function busy(identity) {
  const other = start(identity)
  await wait(() => other.closed, 'contender must fail without waiting for the running prompt')
  assert.equal((await other.done).code, 75)
  assert.match(other.stderr, new RegExp(AGENT_BUSY_MESSAGE))
  assert.deepEqual(other.lines, [], 'busy contenders must never start the CLI')
}
async function stop(output) {
  output.proc.stdin.end()
  await wait(() => output.closed, 'process and lock must finish after input closes')
  await output.done
}
try {
  const initial = start({ id: 'shared-blank', provider: 'claude' })
  await wait(() => initial.lines.length, 'Claude must initialize')
  const session = initial.lines[0].session_id
  await busy({ id: 'shared-blank', provider: 'claude' })
  await busy({ id: 'different-device-tab', provider: 'claude', resumeSessionId: session })
  const independent = start({ id: 'other-conversation', provider: 'claude' })
  await wait(() => independent.lines.length, 'different conversations can run together')
  await stop(independent)
  initial.proc.stdin.write('done\n')
  await wait(() => initial.lines.length === 2, 'result must arrive')
  await busy({ id: 'result-is-not-process-exit', provider: 'claude', resumeSessionId: session })
  await stop(initial)

  const resumed = start({ id: 'shared-blank', provider: 'claude' })
  await wait(() => resumed.lines.length, 'stale blank tab must resume the session created on the other device')
  assert.equal(resumed.lines[0].session_id, session)
  resumed.proc.stdin.write('fail\n')
  await wait(() => resumed.closed, 'failed CLI must exit')
  assert.equal((await resumed.done).code, 12)
  const retry = start({ id: 'retry-tab', provider: 'claude', resumeSessionId: session })
  await wait(() => retry.lines.length, 'failed process must release its lock')
  retry.proc.kill('SIGTERM')
  await wait(() => retry.closed, 'cancellation must wait for child termination')

  const crash = start({ id: 'crash', provider: 'claude' }, claude.slice(0, claude.indexOf('for line in sys.stdin:')) + '\nwhile True: time.sleep(0.1)\n')
  await wait(() => crash.lines.length, 'crash test must initialize')
  const crashedSession = crash.lines[0].session_id
  const childPid = crash.lines[0].pid
  orphanPid = childPid
  crash.proc.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 100))
  // Its child inherited the lock descriptor, including the real-session alias.
  await busy({ id: 'after-connection-loss', provider: 'claude', resumeSessionId: crashedSession })
  process.kill(childPid, 'SIGTERM')
  orphanPid = undefined
  await wait(() => crash.closed, 'orphan child termination must close inherited pipes')
  const afterCrash = start({ id: 'after-crash-retry', provider: 'claude', resumeSessionId: crashedSession })
  await wait(() => afterCrash.lines.length, 'lock must recover without a lease or stale lock deletion')
  await stop(afterCrash)

  const firstCodex = start({ id: 'codex-blank', provider: 'codex' })
  firstCodex.proc.stdin.write(JSON.stringify({ id: 1, method: 'thread/start', params: {} }) + '\n')
  await wait(() => firstCodex.lines.length, 'Codex must create a thread')
  const threadId = firstCodex.lines[0].result.thread.id
  await busy({ id: 'codex-blank', provider: 'codex' })
  await busy({ id: 'codex-resumed', provider: 'codex', resumeSessionId: threadId })
  await stop(firstCodex)
  const secondCodex = start({ id: 'codex-blank', provider: 'codex' })
  secondCodex.proc.stdin.write(JSON.stringify({ id: 2, method: 'thread/start', params: {} }) + '\n')
  await wait(() => secondCodex.lines.length, 'Codex stale blank tab must resume')
  assert.equal(secondCodex.lines[0].result.thread.id, threadId)
  await stop(secondCodex)
  const freshCodex = start({ id: 'codex-blank', provider: 'codex', freshSession: true })
  freshCodex.proc.stdin.write(JSON.stringify({ id: 3, method: 'thread/start', params: {} }) + '\n')
  await wait(() => freshCodex.lines.length, 'explicit new conversation must bypass the stored blank-tab identity')
  assert.notEqual(freshCodex.lines[0].result.thread.id, threadId)
  await busy({ id: 'fresh-resume', provider: 'codex', resumeSessionId: freshCodex.lines[0].result.thread.id })
  const oldCodex = start({ id: 'old-conversation', provider: 'codex', resumeSessionId: threadId })
  oldCodex.proc.stdin.write(JSON.stringify({ id: 4, method: 'thread/resume', params: { threadId } }) + '\n')
  await wait(() => oldCodex.lines.length, 'old and new conversations must have independent locks')
  await stop(oldCodex)
  await stop(freshCodex)
  console.log('Agent execution lock: concurrent devices, canonical identity aliases, stale blank tab resume, independent conversations, failure/retry, cancellation and killed supervisor passed')
} finally {
  if (orphanPid) { try { process.kill(orphanPid, 'SIGTERM') } catch {} }
  for (const { proc, closed } of processes) if (!closed) proc.kill('SIGTERM')
  await Promise.allSettled(processes.map((output) => output.done))
  await rm(root, { recursive: true, force: true })
}
