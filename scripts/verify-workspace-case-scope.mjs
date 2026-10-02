import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/workspaceAgentTabs.ts'

const directory = await fs.mkdtemp(path.join(tmpdir(), 'legal-terminal-workspace-case-'))
const remoteFiles = new Map()
let remoteError
const filename = command => command.match(/([a-f0-9]+\.json)/)?.[1] ?? assert.fail('hashed remote filename')
const source = readFileSync(new URL('../src/main/workspace.ts', import.meta.url), 'utf8')
const api = {}
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: api, process: { platform: process.platform, pid: process.pid }, setTimeout, clearTimeout,
  require(name) {
    if (name === 'electron') return { app: { getPath: () => path.join(directory, 'userData') } }
    if (name === 'fs/promises') return fs
    if (name === 'path') return path
    if (name === 'crypto') return crypto
    if (name === 'os') return { homedir: () => path.join(directory, 'home'), hostname: () => 'synthetic-device' }
    if (name === '../shared/workspaceAgentTabs') return shared
    if (name === './sshOptions') return { buildSshArgs: () => ['synthetic-host'] }
    if (name === 'child_process') return {
      execFile(_bin, args, _options, callback) {
        if (args.at(-1).startsWith('mkdir ') || args.at(-1).startsWith('rmdir ')) {
          queueMicrotask(() => callback(remoteError, ''))
          return
        }
        if (args.at(-1).startsWith('for file ')) {
          queueMicrotask(() => callback(remoteError, [...remoteFiles.values()].join('\x1e')))
          return
        }
        assert.match(args.at(-1), /else exit 3; fi$/, 'only a missing file uses the empty-result exit code')
        const content = remoteFiles.get(filename(args.at(-1)))
        queueMicrotask(() => callback(remoteError ?? (content === undefined ? Object.assign(new Error('missing'), { code: 3 }) : null), content ?? ''))
      },
      spawn(_bin, args) {
        const proc = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.stdin = new EventEmitter()
        proc.kill = () => proc.emit('close', 1)
        proc.stdin.end = content => {
          remoteFiles.set(filename(args.at(-1)), content)
          queueMicrotask(() => proc.emit('close', 0))
        }
        return proc
      }
    }
    throw Error(`Unexpected dependency: ${name}`)
  }
})
const location = { cwd: '/synthetic/shared-folder' }
const snapshot = caseId => ({
  version: 1, savedAt: '2026-10-01T00:00:00.000Z',
  currentCase: { drafts: location.cwd, ...(caseId ? { meta: { jsId: caseId } } : {}) },
  caseTabs: [{ id: `tab-${caseId ?? 'folder'}`, drafts: location.cwd, ...(caseId ? { meta: { jsId: caseId } } : {}) }],
  docs: [{ id: 'doc', path: `/synthetic/${caseId ?? 'folder'}.md` }],
  terminals: [{ id: 'session', kind: 'agent', cwd: location.cwd, resumeSessionId: `session-${caseId ?? 'folder'}`, ...(caseId ? { jsId: caseId } : {}) }]
})
const assertSnapshot = (actual, caseId, remote = false) => {
  if (remote) assert.equal(actual.docs.length, 0, 'automatic shared restore only includes agents')
  else assert.equal(actual.docs[0].path, `/synthetic/${caseId ?? 'folder'}.md`)
  assert.equal(actual.terminals[0].resumeSessionId, `session-${caseId ?? 'folder'}`)
}
const empty = result => {
  assert.equal(result.local.snapshot, null)
  assert.equal(result.remote.snapshot, null)
}
try {
  assert.equal(api.workspaceIdForLocation(location.cwd), crypto.createHash('sha256').update(`auto-workspace:${location.cwd}`).digest('hex').slice(0, 16))
  assert.equal(api.workspaceIdForLocation(location.cwd, 'ssh-1'), crypto.createHash('sha256').update(`auto-workspace:ssh-1:${location.cwd}`).digest('hex').slice(0, 16))
  assert.notEqual(api.workspaceIdForLocation(location.cwd, undefined, 'A'), api.workspaceIdForLocation(location.cwd, undefined, 'B'))
  assert.notEqual(api.workspaceIdForLocation(location.cwd, 'ssh-1', 'A'), api.workspaceIdForLocation(location.cwd, 'ssh-2', 'A'))
  assert.equal(api.snapshotMatchesCase(snapshot('A'), 'A'), true)
  assert.equal(api.snapshotMatchesCase(snapshot(), 'A'), false)
  const mixed = snapshot('A')
  mixed.terminals.push({ jsId: 'B' })
  assert.equal(api.snapshotMatchesCase(mixed, 'A'), false)
  assert.equal((await api.saveAutomaticWorkspace(mixed, { ...location, caseId: 'A' })).ok, false)
  assert.equal((await api.saveAutomaticWorkspace(snapshot('A'), { ...location, caseId: 'B' })).ok, false)

  // Legacy folder-only work remains restorable, but cannot seed any linked case.
  assert.equal((await api.saveAutomaticWorkspace(snapshot(), location)).ok, true)
  const folder = await api.loadAutomaticWorkspace(location)
  assertSnapshot(folder.local.snapshot)
  assertSnapshot(folder.remote.snapshot, undefined, true)
  const unscoped = await api.loadAutomaticWorkspace({ ...location, caseId: 'A' })
  empty(unscoped)
  assert.match(unscoped.error, /복원하지 않았습니다/)

  // A known legacy case can migrate to its own new identity, never the neighbouring case.
  await api.saveAutomaticWorkspace(snapshot('A'), location)
  const migrated = await api.loadAutomaticWorkspace({ ...location, caseId: 'A' })
  assertSnapshot(migrated.local.snapshot, 'A')
  assertSnapshot(migrated.remote.snapshot, 'A', true)
  empty(await api.loadAutomaticWorkspace({ ...location, caseId: 'B' }))
  const savedA = await api.saveAutomaticWorkspace(snapshot('A'), { ...location, caseId: 'A' })
  const savedB = await api.saveAutomaticWorkspace(snapshot('B'), { ...location, caseId: 'B' })
  assert.notEqual(savedA.path, savedB.path)
  for (const caseId of ['A', 'B']) {
    const restored = await api.loadAutomaticWorkspace({ ...location, caseId })
    assert.equal(restored.ok, true)
    assertSnapshot(restored.local.snapshot, caseId)
    assertSnapshot(restored.remote.snapshot, caseId, true)
  }
  const discovered = await api.listAutomaticWorkspaces()
  assert.equal(discovered.ok, true)
  assert.deepEqual([...new Set(discovered.snapshots.map(s => s.currentCase.meta.jsId))].sort(), ['A', 'B'],
    'discovery keeps distinct cases sharing one folder')
  const mixedShared = { ...mixed, workspaceOpen: true, currentCase: { ...mixed.currentCase, name: 'mixed' } }
  const mixedPath = path.join(directory, 'home/.claude/legal-terminal-workspaces/000000000000000000000000.json')
  await fs.writeFile(mixedPath, JSON.stringify(mixedShared))
  assert.equal((await api.listAutomaticWorkspaces()).snapshots.length, discovered.snapshots.length,
    'mixed-case snapshots are not offered for automatic restore')
  assert.throws(() => api.observeAutomaticWorkspace({ ...location, caseId: 'B' }, snapshot('A')), /일치하지 않아/)

  const observerLocation = { cwd: '/synthetic/observer', caseId: 'C' }
  for (const caseId of ['C', 'D']) {
    await api.saveAutomaticWorkspace(snapshot(caseId), { ...observerLocation, caseId }, 12)
    await api.loadAutomaticWorkspace({ ...observerLocation, caseId }, 12)
  }
  await api.saveAutomaticWorkspace({ ...snapshot('C'), terminals: [] }, observerLocation, 12)
  const closedC = (await api.loadAutomaticWorkspace(observerLocation, 12)).remote.snapshot
  assert.equal(closedC.terminals.length, 0)
  assert.deepEqual(Array.from(closedC.closedAgentTabs, tab => tab.resumeSessionId), ['session-C'],
    'observer state is isolated by case even when folder and window match')
  assertSnapshot((await api.loadAutomaticWorkspace({ ...observerLocation, caseId: 'D' }, 12)).remote.snapshot, 'D', true)
  const terminalOnly = { ...snapshot('E'), currentCase: undefined, caseTabs: undefined }
  const terminalLocation = { ...observerLocation, caseId: 'E' }
  assert.equal((await api.saveAutomaticWorkspace(terminalOnly, terminalLocation)).remoteError, undefined)
  const terminalShared = (await api.loadAutomaticWorkspace(terminalLocation)).remote.snapshot
  assert.equal(terminalShared.currentCase.meta.jsId, 'E', 'shared discovery always retains its validated case identity')

  assertSnapshot((await api.loadAutomaticWorkspace(location)).local.snapshot, 'A')
  await fs.writeFile(savedB.path, JSON.stringify(snapshot('A')))
  const mismatch = await api.loadAutomaticWorkspace({ ...location, caseId: 'B' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.local.snapshot, undefined)
  await fs.writeFile(savedA.path, '{broken')
  assert.equal((await api.loadAutomaticWorkspace({ ...location, caseId: 'A' })).ok, false, 'corrupt exact files must not silently fall back')

  // SSH uses the same scope separation and legacy guard without touching real hosts.
  const sshLocation = { cwd: '/remote/same-folder', profileId: 'ssh-1', ssh: { host: 'synthetic' } }
  await api.saveAutomaticWorkspace(snapshot('A'), sshLocation)
  assertSnapshot((await api.loadAutomaticWorkspace({ ...sshLocation, caseId: 'A' })).remote.snapshot, 'A', true)
  empty(await api.loadAutomaticWorkspace({ ...sshLocation, caseId: 'B' }))
  for (const caseId of ['A', 'B']) await api.saveAutomaticWorkspace(snapshot(caseId), { ...sshLocation, caseId })
  assert.equal(remoteFiles.size, 3, 'legacy and each case have distinct shared SSH files')
  for (const caseId of ['A', 'B']) assertSnapshot((await api.loadAutomaticWorkspace({ ...sshLocation, caseId })).remote.snapshot, caseId, true)
  const otherProfile = { ...sshLocation, profileId: 'ssh-2', caseId: 'B' }
  assert.equal((await api.loadAutomaticWorkspace(otherProfile)).local.snapshot, null)
  assertSnapshot((await api.loadAutomaticWorkspace(otherProfile)).remote.snapshot, 'B', true)
  const remoteDiscovery = await api.listAutomaticWorkspaces(sshLocation.ssh)
  assert.deepEqual([...new Set(remoteDiscovery.snapshots.map(s => s.currentCase.meta.jsId))].sort(), ['A', 'B'])
  const exactRemoteName = crypto.createHash('sha256')
    .update(JSON.stringify(['case-workspace', sshLocation.cwd, 'B'])).digest('hex').slice(0, 24) + '.json'
  const originalB = remoteFiles.get(exactRemoteName)
  remoteFiles.set(exactRemoteName, JSON.stringify(snapshot('A')))
  assert.equal((await api.loadAutomaticWorkspace(otherProfile)).ok, false)
  const corruptSave = await api.saveAutomaticWorkspace(snapshot('B'), { ...sshLocation, caseId: 'B' })
  assert.match(corruptSave.remoteError, /일치하지 않아/, 'read/merge/write rejects an exact wrong-case shared file')
  assert.equal(remoteFiles.get(exactRemoteName), JSON.stringify(snapshot('A')), 'wrong-case data is never overwritten during merge')
  remoteFiles.set(exactRemoteName, originalB)
  remoteError = Object.assign(new Error('synthetic SSH disconnect'), { code: 255 })
  const disconnected = await api.loadAutomaticWorkspace({ ...sshLocation, caseId: 'A' })
  assert.equal(disconnected.ok, false)
  assert.match(disconnected.remote.error, /SSH disconnect/)
  remoteError = undefined
  for (const key of remoteFiles.keys()) remoteFiles.set(key, '')
  assert.equal((await api.loadAutomaticWorkspace({ ...sshLocation, caseId: 'A' })).ok, false, 'empty/corrupt remote file is an error, not absent')
  console.log('workspace case scope: local/SSH same-folder isolation, guarded legacy migration, folder compatibility, mismatches and load failures verified')
} finally { await fs.rm(directory, { recursive: true, force: true }) }
