import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/sharedUiState.ts'

const root = await mkdtemp(join(tmpdir(), 'lt-shared-ui-'))
const require = createRequire(import.meta.url)
const code = ts.transpileModule(await readFile(new URL('../src/main/sharedUi.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const module = { exports: {} }
const mocks = {
  '../shared/sharedUiState': shared,
  './sshOptions': { buildSshArgs: () => [] },
  child_process: {
    execFile: (_bin, args, options, callback) => execFile('/bin/sh', ['-c', args.at(-1)],
      { ...options, env: { ...process.env, HOME: root } }, callback),
    spawn: (_bin, args, options) => spawn('/bin/sh', ['-c', args.at(-1)],
      { ...options, env: { ...process.env, HOME: root } })
  }
}
vm.runInNewContext(`${code}\nmodule.exports.transactionScript = transactionScript`, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
  process, Buffer, setTimeout, clearTimeout })
const api = module.exports
const ssh = { host: 'host', user: 'owner' }
const caseKey = JSON.stringify(['/사건', 'case-id'])
const op = (id, data) => ({ id, caseKey, ...data })
const stateFile = join(root, '.claude/legal-terminal-shared-ui.json')
try {
  const initial = shared.emptySharedUiState()
  shared.applySharedUiOperation(initial, op('initial-selection', { type: 'selection', tab: null, onlyIfUnset: true }))
  assert.equal(initial.selection.caseKey, caseKey, 'bootstrap selects a case when none exists')
  assert.equal(shared.isSharedUiOperation(op('view', { type: 'selection', tab: { kind: 'view', id: 'hearing' } })), true)
  assert.equal(shared.isSharedUiOperation(op('bad-view', { type: 'selection', tab: { kind: 'view', id: 'unknown' } })), false)
  assert.equal((await api.readSharedUi(ssh)).state.revision, 0)
  const writes = await Promise.all([
    api.applySharedUi(ssh, op('one', { type: 'document', path: '/사건/서면.md', open: true })),
    api.applySharedUi(ssh, op('two', { type: 'document', path: '/사건/증거.pdf', open: true }))
  ])
  assert.ok(writes.every((result) => result.ok))
  let state = (await api.readSharedUi(ssh)).state
  assert.equal(state.revision, 2)
  assert.equal(Object.keys(state.cases[caseKey].documents).length, 2)
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600)
  state.extra = { preserved: true }
  await writeFile(stateFile, JSON.stringify(state))
  await api.applySharedUi(ssh, op('selection', { type: 'selection', tab: { kind: 'document', id: '/사건/증거.pdf' } }))
  state = (await api.readSharedUi(ssh)).state
  assert.equal(state.selection.tab.id, '/사건/증거.pdf')
  assert.equal(state.extra.preserved, true)
  await api.applySharedUi(ssh, op('one', { type: 'document', path: '/사건/서면.md', open: false }))
  assert.equal((await api.readSharedUi(ssh)).state.revision, 3)
  await api.applySharedUi(ssh, op('close', { type: 'document', path: '/사건/서면.md', open: false }))
  const closedRevision = (await api.readSharedUi(ssh)).state.revision
  await api.applySharedUi(ssh, op('bootstrap-document', { type: 'document', path: '/사건/서면.md', open: true, onlyIfMissing: true }))
  await api.applySharedUi(ssh, op('bootstrap-selection', { type: 'selection', tab: { kind: 'agent', id: 'older' }, onlyIfUnset: true }))
  state = (await api.readSharedUi(ssh)).state
  assert.equal(state.cases[caseKey].documents['/사건/서면.md'], false, 'bootstrap cannot reopen a closed document')
  assert.equal(state.selection.tab.id, '/사건/증거.pdf', 'bootstrap cannot replace a selected tab')
  assert.equal(state.revision, closedRevision + 2, 'ignored bootstrap operations are recorded')
  await api.applySharedUi(ssh, op('bootstrap-new', { type: 'document', path: '/사건/처음.md', open: true, onlyIfMissing: true }))
  assert.equal((await api.readSharedUi(ssh)).state.cases[caseKey].documents['/사건/처음.md'], true)
  await api.applySharedUi(ssh, op('start', { type: 'activity', agentId: 'agent', runId: 'run-1', sequence: 1,
    status: 'working', attention: false, start: true, expectedRunId: null }))
  await api.applySharedUi(ssh, op('done', { type: 'activity', agentId: 'agent', runId: 'run-1', sequence: 2,
    status: 'done', attention: true, start: false }))
  await api.applySharedUi(ssh, op('late', { type: 'activity', agentId: 'agent', runId: 'run-1', sequence: 1,
    status: 'working', attention: false, start: false }))
  await api.applySharedUi(ssh, op('wrong-ack', { type: 'ack', agentId: 'agent', runId: 'old', sequence: 2 }))
  await api.applySharedUi(ssh, op('stale-ack', { type: 'ack', agentId: 'agent', runId: 'run-1', sequence: 1 }))
  state = (await api.readSharedUi(ssh)).state
  assert.equal(state.cases[caseKey].activity.agent.status, 'done')
  assert.equal(state.cases[caseKey].activity.agent.attention, true)
  await api.applySharedUi(ssh, op('ack', { type: 'ack', agentId: 'agent', runId: 'run-1', sequence: 2 }))
  assert.equal((await api.readSharedUi(ssh)).state.cases[caseKey].activity.agent.attention, false)
  await api.applySharedUi(ssh, op('new-start', { type: 'activity', agentId: 'agent', runId: 'run-2', sequence: 1,
    status: 'working', attention: false, start: true, expectedRunId: 'run-1' }))
  await api.applySharedUi(ssh, op('stale-start', { type: 'activity', agentId: 'agent', runId: 'old', sequence: 1,
    status: 'working', attention: false, start: true, expectedRunId: 'run-1' }))
  assert.equal((await api.readSharedUi(ssh)).state.cases[caseKey].activity.agent.runId, 'run-2')
  assert.equal((await api.applySharedUi(ssh, op('bad', { type: 'document', path: 'relative', open: true }))).ok, false)
  const original = await readFile(stateFile, 'utf8')
  const interruptedWrite = (input) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', api.transactionScript], { env: { ...process.env, HOME: root } })
    child.on('error', reject)
    child.stdout.once('data', () => child.stdin.end(input))
    child.stdin.on('error', () => {})
    child.on('close', resolve)
  })
  assert.notEqual(await interruptedWrite(''), 0, 'disconnect before commit fails')
  assert.equal(await readFile(stateFile, 'utf8'), original)
  assert.notEqual(await interruptedWrite('COMMIT 100\npartial'), 0, 'truncated commit fails')
  assert.equal(await readFile(stateFile, 'utf8'), original)
  assert.notEqual(await interruptedWrite('COMMIT 2\nextra'), 0, 'extra commit bytes fail')
  assert.equal(await readFile(stateFile, 'utf8'), original)
  assert.notEqual(await interruptedWrite('COMMIT 16777217\n'), 0, 'oversized commit fails')
  assert.equal(await readFile(stateFile, 'utf8'), original)
  assert.equal((await api.applySharedUi(ssh, op('after-disconnect', { type: 'document', path: '/after', open: true }))).ok, true,
    'disconnect releases the lock')
  const lockPath = `${stateFile}.lock`
  await mkdir(lockPath)
  const stale = new Date(Date.now() - 180_000)
  await utimes(lockPath, stale, stale)
  assert.equal((await api.applySharedUi(ssh, op('after-stale-lock', { type: 'document', path: '/x', open: true }))).ok, false)
  await rm(lockPath, { recursive: true })
  await writeFile(stateFile, '{broken')
  assert.equal((await api.applySharedUi(ssh, op('fail', { type: 'document', path: '/x', open: true }))).ok, false)
  assert.equal(await readFile(stateFile, 'utf8'), '{broken')
  console.log('shared UI state: concurrent writes, deduplication, stale runs, acknowledgement and corruption safety OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
