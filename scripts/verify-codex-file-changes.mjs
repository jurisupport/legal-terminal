import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Exercise the actual provider handlers without starting Electron or calling a model.
// Wire shape: `codex app-server generate-json-schema` (0.155.1), FileUpdateChange.
const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const progress = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/main/agent/agentProgress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: progress })
const service = { exports: {} }
runInNewContext(ts.transpileModule(`${source}\nexport const check = { handleCodexNotification, handleUserMessage, handleCodexJsonLine, runCodexAgentMessage };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: service.exports, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  require: (name) => {
    if (name === '@anthropic-ai/claude-agent-sdk') return {}
    if (name === '../jurisupport') return { onAgentMcpAccountChange: () => {} }
    if (name === './agentMcp') return { managedToolName: () => undefined }
    if (name === './agentProgress') return progress
    if (name.startsWith('.')) return {}
    return require(name)
  }
})
const { handleCodexNotification, handleUserMessage, handleCodexJsonLine, runCodexAgentMessage } = service.exports.check
const events = []
const session = {
  id: 'files-check', codexThreadId: 'thread-1', codexTurnWaiter: { turnId: 'turn-1' },
  viewers: new Map([[1, { isDestroyed: () => false, send: (_channel, event) => events.push(JSON.parse(JSON.stringify(event))) }]])
}
const notify = (method, item, ids = {}) => handleCodexNotification(session, {
  method, params: { threadId: 'thread-1', turnId: 'turn-1', ...ids, item }
})
const item = {
  id: 'patch-1', type: 'fileChange', status: 'inProgress', changes: [
    { path: '/case/a/brief.md', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old a\n+new a\n' },
    { path: '/case/b/brief.md', kind: { type: 'update', move_path: null }, diff: '@@ -2 +2 @@\n-old b\n+new b\n' }
  ]
}
notify('item/started', item)
const proposed = events.splice(0).map((event) => {
  assert.equal(event.type, 'diff:proposed')
  return event.proposal
})
assert.equal(proposed.length, 2, 'every changed file must get its own proposal')
assert.equal(new Set(proposed.map((proposal) => proposal.proposalId)).size, 2, 'same filename in different folders must remain distinct')
for (const [index, proposal] of proposed.entries()) {
  assert.equal(proposal.toolUseId, item.id)
  assert.equal(proposal.sessionId, session.id)
  assert.equal(proposal.filePath, item.changes[index].path)
  assert.equal(proposal.gitDiff.diff, item.changes[index].diff)
  assert.equal(proposal.newString, undefined, 'a patch is not replacement file content')
}
notify('item/completed', { ...item, status: 'completed', changes: [...item.changes].reverse() })
const applied = events.splice(0)
assert.equal(applied.length, 2, 'a completed multi-file change must confirm each file')
for (const event of applied) {
  const proposal = proposed.find((candidate) => candidate.filePath === event.filePath)
  assert.equal(event.type, 'diff:applied')
  assert.equal(event.sessionId, session.id)
  assert.equal(event.proposalId, proposal.proposalId, 'proposal identity must survive reordered changes')
  assert.deepEqual(event.gitDiff, proposal.gitDiff)
}

for (const status of ['failed', 'declined', 'interrupted', 'cancelled', 'inProgress', undefined]) {
  notify('item/completed', { ...item, status })
  assert.equal(events.length, 0, `${status} does not confirm a file change`)
}
for (const changes of [[], undefined, [null, {}, { path: '' }]]) {
  notify('item/started', { ...item, changes })
  notify('item/completed', { ...item, status: 'completed', changes })
  assert.equal(events.length, 0, 'missing paths must not create phantom documents')
}

// Add/delete carry full content; do not invent the other side or enable unsafe text reversal.
for (const [kind, field] of [['add', 'newString'], ['delete', 'oldString']]) {
  const diff = kind === 'add' ? '# new brief\n\n안녕하세요\n' : '# old brief\n'
  notify('item/completed', { ...item, id: kind, status: 'completed', changes: [{ path: 'brief.md', kind: { type: kind }, diff }] })
  const event = events.pop()
  assert.equal(event[field], diff)
  assert.equal(event[kind === 'add' ? 'oldString' : 'newString'], undefined)
  assert.equal(event.gitDiff.diff, diff)
}
// Preserve SSH/Windows paths as supplied, including a rename's destination.
for (const path of ['/srv/cases/사건/brief.md', 'C:\\cases\\brief.md']) {
  const movePath = `${path}.renamed`
  const renamed = { ...item, id: `rename-${path}`, changes: [{ path, kind: { type: 'update', move_path: movePath }, diff: '@@ -1 +1 @@\n-a\n+b\n\nMoved to: ' + movePath }] }
  notify('item/started', renamed)
  notify('item/completed', { ...renamed, status: 'completed' })
  const [start, end] = events.splice(0)
  assert.equal(start.proposal.filePath, movePath)
  assert.equal(end.filePath, movePath)
  assert.equal(start.proposal.proposalId, end.proposalId)
  assert.equal(end.gitDiff.diff, renamed.changes[0].diff)
}
notify('item/completed', { ...item, status: 'completed' }, { threadId: 'another-thread' })
notify('item/completed', { ...item, status: 'completed' }, { turnId: 'previous-turn' })
assert.equal(events.length, 0, 'unrelated or delayed turns must not leak changes')

// Child notifications share the app-server transport. Only thread/start's response
// owns the parent identity, and only the matching turn may finish its waiter.
handleCodexNotification(session, { method: 'thread/started', params: { thread: { id: 'child-thread' } } })
assert.equal(session.codexThreadId, 'thread-1', 'a child must never overwrite the parent thread ID')
const requests = []
session.codexProcess = { stdin: { write: (line) => requests.push(JSON.parse(line)) } }
session.cwd = '/case'
const turnNotice = (method, threadId, id, status = 'completed') => handleCodexNotification(session, {
  method, params: { threadId, turn: { id, status } }
})
for (const withStartedNotification of [true, false]) {
  const turnId = withStartedNotification ? 'turn-with-start' : 'turn-from-response'
  const run = runCodexAgentMessage(session, 'Review changes', new AbortController())
  await new Promise((resolve) => setImmediate(resolve))
  const request = requests.at(-1)
  assert.equal(request.method, 'turn/start')
  assert.equal(request.params.threadId, 'thread-1')
  const waiter = session.codexTurnWaiter
  turnNotice('turn/started', 'child-thread', 'child-turn', 'inProgress')
  turnNotice('turn/completed', 'thread-1', 'previous-turn')
  assert.equal(waiter.turnId, undefined, 'a child start cannot assign the current parent turn')
  assert.equal(session.codexTurnWaiter, waiter, 'an old completion cannot finish a starting turn')
  if (withStartedNotification) turnNotice('turn/started', 'thread-1', turnId, 'inProgress')
  handleCodexJsonLine(session, JSON.stringify({ id: request.id, result: { turn: { id: turnId } } }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(waiter.turnId, turnId, 'the turn/start response initializes the ID when its notification is absent')
  events.length = 0
  turnNotice('turn/started', 'thread-1', 'previous-turn', 'inProgress')
  turnNotice('turn/completed', 'thread-1', 'previous-turn', 'failed')
  turnNotice('turn/completed', 'child-thread', turnId)
  assert.equal(session.codexTurnWaiter, waiter, 'late or child completions cannot finish the new work')
  assert.equal(waiter.turnId, turnId, 'late starts cannot replace the active turn')
  assert.equal(events.length, 0, 'ignored lifecycle messages cannot update the visible work status')
  notify('item/completed', { ...item, status: 'completed' }, { turnId })
  assert.equal(events.filter((event) => event.type === 'diff:applied').length, 2, 'matching changes are still delivered')
  turnNotice('turn/completed', 'thread-1', turnId)
  await run
  assert.equal(session.codexTurnWaiter, undefined)
  events.length = 0
  notify('item/completed', { ...item, status: 'completed' }, { turnId })
  turnNotice('turn/started', 'thread-1', turnId, 'inProgress')
  assert.equal(events.length, 0, 'finished turns cannot reopen or append changes while idle')
}

// Claude may include a proposed patch alongside an error; it is not an applied edit.
for (const structuredPatch of [[], [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]]) {
  for (const [isError, staged] of [[true, false], [false, true], [false, false]]) {
    handleUserMessage(session, {
      message: { content: [{ type: 'tool_result', tool_use_id: 'claude-edit', is_error: isError }] },
      tool_use_result: { filePath: '/case/brief.md', structuredPatch, newString: 'b', staged }
    })
    assert.equal(events.filter((event) => event.type === 'diff:applied').length, isError || staged ? 0 : 1)
    events.length = 0
  }
}
console.log('Codex file changes: per-file proposals/applied, stable IDs, failure exclusion, content, remote paths, turn isolation and Claude error/staged exclusion passed')
