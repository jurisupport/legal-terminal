import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/workspaceAgentTabs.ts'

const root = await mkdtemp(join(tmpdir(), 'lt-shared-cases-'))
const require = createRequire(import.meta.url)
const userData = join(root, 'desktop')
const homes = { alpha: join(root, 'alpha'), beta: join(root, 'beta') }
const shell = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/sh.exe') : '/bin/sh'
const shellHome = (host) => homes[host].replaceAll('\\', '/')
const failedHosts = new Set()
const usedHosts = []
const code = ts.transpileModule(await readFile(new URL('../src/main/workspace.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loadDevice = (directory = userData) => {
  const module = { exports: {} }
  const mocks = {
    electron: { app: { getPath: () => directory } },
    os: { homedir: () => homes.alpha, hostname: () => 'test-desktop' },
    './sshOptions': { buildSshArgs: (ssh) => [ssh.host] },
    '../shared/workspaceAgentTabs': shared,
    child_process: {
      execFile: (_bin, args, options, done) => {
        const host = args[0]
        usedHosts.push(host)
        if (failedHosts.has(host)) return done(new Error('offline'), '')
        return execFile(shell, ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: shellHome(host) } }, done)
      },
      spawn: (_bin, args, options) => spawn(shell, ['-c', args.at(-1)], {
        ...options, env: { ...process.env, HOME: shellHome(args[0]) }
      })
    }
  }
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
    process, Buffer, console, setTimeout, clearTimeout })
  return module.exports
}
const location = (cwd, host = 'alpha', profileId = `${host}-profile`) => ({ cwd, profileId, ssh: { host, user: 'owner' } })
const pathFor = (where) => join(homes[where.ssh?.host ?? 'alpha'], '.claude/legal-terminal-workspaces',
  `${createHash('sha256').update(where.caseId ? JSON.stringify(['case-workspace', where.cwd, where.caseId]) : where.cwd).digest('hex').slice(0, 24)}.json`)
const read = async (where) => JSON.parse(await readFile(pathFor(where), 'utf8'))
const date = (day) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`
const term = (id, cwd) => ({ id, kind: 'agent', cwd, title: id, resumeSessionId: id, agentProvider: 'claude' })
const snapshot = (where, day, extra = {}) => ({ version: 1, savedAt: date(day), workspaceLabel: where.cwd,
  currentCase: { drafts: where.cwd, name: where.cwd, ...(where.caseId ? { meta: { jsId: where.caseId } } : {}) }, terminals: [], ...extra })
const save = async (api, where, day, extra = {}) => {
  const result = await api.saveAutomaticWorkspace(snapshot(where, day, extra), where)
  assert.equal(result.ok, true)
  assert.equal(result.remoteError, undefined)
  return read(where)
}

try {
  let api = loadDevice()
  const first = location('/cases/가')
  const second = location('/cases/z')
  let state = await save(api, first, 1, { terminals: [term('agent', first.cwd)],
    currentCase: { drafts: first.cwd, name: '사건', records: 'ssh://alpha-profile/records', jsId: 'case-id',
      meta: { jsId: 'meta-case-id', caseNumber: '2026가단1', client: '의뢰인' } } })
  assert.equal(state.workspaceOpenedAt, date(1), 'first publication fixes the open order')
  await save(api, second, 2)
  state = await save(api, first, 9, { terminals: [term('agent', first.cwd)], workspaceOpenedAt: date(9),
    currentCase: { drafts: first.cwd, name: '사건', records: '', jsId: '', meta: { caseNumber: '', court: '서울' } } })
  assert.equal(state.workspaceOpenedAt, date(1), 'background saves do not reorder cases')
  assert.equal(state.currentCase.records, '/records')
  assert.equal(state.currentCase.jsId, 'case-id')
  assert.equal(state.currentCase.meta.jsId, 'meta-case-id')
  assert.equal(state.currentCase.meta.caseNumber, '2026가단1')
  assert.equal(state.currentCase.meta.court, '서울')
  assert.deepEqual(Array.from((await api.listAutomaticWorkspaces(first.ssh)).snapshots, (s) => s.currentCase.drafts),
    [first.cwd, second.cwd], 'list order follows opening, not most recent activity')

  await save(api, first, 10, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'close-1' })
  state = await read(first)
  assert.equal(state.terminals.length, 1, 'state-only closing preserves conversations')
  assert.equal(state.workspaceStateOnly, undefined)
  state = await save(api, first, 11)
  assert.equal(state.workspaceOpen, false, 'stale autosave cannot reopen a closed case')
  assert.equal(state.workspaceOpenedAt, date(1))
  state = await save(api, first, 12, { workspaceReopen: true, workspaceStateOnly: true, workspaceIntentId: 'open-2' })
  assert.equal(state.workspaceOpenedAt, date(12), 'explicit reopen goes to the end')
  assert.equal(state.terminals.length, 1)
  state = await save(api, first, 13, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'close-1' })
  assert.equal(state.workspaceOpen, true, 'duplicate close cannot override a newer reopen')
  assert.equal(state.workspaceOpenedAt, date(12))
  await save(api, first, 14, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'close-3' })
  state = await save(api, first, 15, { workspaceReopen: true, workspaceStateOnly: true, workspaceIntentId: 'open-2' })
  assert.equal(state.workspaceOpen, false, 'duplicate reopen cannot override a newer close')
  assert.equal(state.workspaceOpenedAt, date(12))

  const legacy = location('/cases/legacy')
  await mkdir(dirname(pathFor(legacy)), { recursive: true })
  await writeFile(pathFor(legacy), JSON.stringify(snapshot(legacy, 3)))
  assert.equal((await api.listAutomaticWorkspaces(first.ssh)).snapshots.some((s) => s.currentCase.drafts === legacy.cwd), false)
  assert.equal((await api.listAutomaticWorkspaces(first.ssh, true)).snapshots.some((s) => s.currentCase.drafts === legacy.cwd), true)
  state = await save(api, legacy, 16)
  assert.equal(state.workspaceOpenedAt, date(3), 'legacy migration uses the stored time')
  await save(api, second, 17, { terminals: [term('deleted', second.cwd)] })
  await save(api, second, 18)
  state = await save(api, second, 19, { workspaceStateOnly: true, terminals: [term('deleted', second.cwd)] })
  assert.equal(state.terminals.length, 0)
  assert.equal(state.closedAgentTabs[0].id, 'deleted', 'state-only writes retain agent tombstones')
  const tied = [snapshot(first, 1), snapshot(second, 1)].sort(shared.compareSharedCaseOrder)
  assert.deepEqual(tied.map((s) => s.currentCase.drafts), [second.cwd, first.cwd], 'path tiebreaker is locale-independent')
  assert.ok(shared.compareSharedCaseOrder({ savedAt: '2026-10-01T00:00:00Z' },
    { savedAt: '2026-10-01T00:00:00.001Z' }) < 0, 'Java ISO timestamps with variable fractional seconds sort chronologically')

  // A fresh process can deliver an offline close without storing connection credentials.
  const offline = location('/cases/offline')
  await save(api, offline, 1, { terminals: [term('keep', offline.cwd)] })
  failedHosts.add('alpha')
  const close = snapshot(offline, 2, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'offline-close' })
  assert.match((await api.saveAutomaticWorkspace(close, offline)).remoteError, /offline/)
  assert.equal((await api.listAutomaticWorkspaces(offline.ssh)).ok, false, 'pending failure is not a successful stale list')
  let pending = JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8'))
  assert.equal(pending[0].snapshot.workspaceIntentId, 'offline-close')
  assert.equal(pending[0].snapshot.currentCase.profileId, undefined)
  assert.equal(JSON.stringify(pending).includes('"ssh"'), false)
  api = loadDevice()
  const wrong = location(offline.cwd, 'beta', 'other-profile')
  usedHosts.length = 0
  assert.equal((await api.listAutomaticWorkspaces(wrong.ssh)).ok, true)
  assert.deepEqual([...new Set(usedHosts)], ['beta'], 'recovery uses only the requested endpoint')
  assert.equal(JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8')).length, 1)
  failedHosts.delete('alpha')
  assert.equal((await api.loadAutomaticWorkspace({ ...offline, profileId: 'renamed-profile' })).ok, true,
    'another profile alias for the same host/user can deliver the pending intent')
  assert.equal((await read(offline)).workspaceOpen, false)
  assert.equal((await read(offline)).terminals[0].id, 'keep')
  assert.equal(JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8')).length, 0)

  // Simulate a crash after server success but before removing the local outbox entry.
  await save(api, offline, 3, { workspaceReopen: true, workspaceStateOnly: true, workspaceIntentId: 'after-crash-open' })
  await writeFile(join(userData, 'workspace-intents.json'), JSON.stringify(pending))
  api = loadDevice()
  assert.equal((await api.listAutomaticWorkspaces(offline.ssh)).ok, true)
  state = await read(offline)
  assert.equal(state.workspaceOpen, true, 'replayed delivered close does not defeat newer changes')
  assert.equal(state.workspaceOpenedAt, date(3))
  assert.equal(JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8')).length, 0)

  failedHosts.add('alpha')
  await api.saveAutomaticWorkspace(snapshot(offline, 4, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'superseded-close' }), offline)
  await api.saveAutomaticWorkspace(snapshot(offline, 5, { workspaceReopen: true, workspaceStateOnly: true, workspaceIntentId: 'latest-open' }), offline)
  pending = JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8'))
  assert.deepEqual(pending.map((item) => item.snapshot.workspaceIntentId), ['latest-open'], 'new explicit action supersedes an unsent action')
  failedHosts.delete('alpha')
  api = loadDevice()
  assert.equal((await api.listAutomaticWorkspaces(offline.ssh)).ok, true)
  assert.equal((await read(offline)).workspaceOpen, true)
  assert.equal((await read(offline)).workspaceOpenedAt, date(3), 'reopening an already open case leaves its order intact')
  // A shared folder must keep each linked case and its recovery intent separate.
  const scopedA = { ...location('/cases/same-folder'), caseId: 'A' }
  const scopedB = { ...scopedA, caseId: 'B' }
  for (const locations of [[scopedB, scopedA], [scopedA, scopedB]]) {
    const sameTime = locations.map(where => snapshot(where, 1)).sort(shared.compareSharedCaseOrder)
    assert.deepEqual(sameTime.map(s => s.currentCase.meta.jsId), ['A', 'B'], 'same-folder ties use the linked case ID on every device')
  }
  await save(api, scopedA, 1)
  await save(api, scopedB, 2)
  const legacyScoped = { ...scopedA, caseId: undefined }
  await writeFile(pathFor(legacyScoped), JSON.stringify({ ...snapshot(scopedA, 9), workspaceOpen: true }))
  await save(api, scopedA, 3, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'scoped-close' })
  const listed = await api.listAutomaticWorkspaces(scopedA.ssh)
  assert.equal(listed.ok, true)
  assert.deepEqual(Array.from(listed.snapshots.filter(s => s.currentCase.drafts === scopedA.cwd), s => s.currentCase.meta.jsId), ['B'],
    'a legacy open copy cannot resurrect a canonically closed case')
  const history = await api.listAutomaticWorkspaces(scopedA.ssh, true)
  assert.equal(history.snapshots.filter(s => s.currentCase.drafts === scopedA.cwd).length, 2,
    'canonical and legacy copies collapse without merging different linked cases')
  failedHosts.add('alpha')
  await api.saveAutomaticWorkspace(snapshot(scopedA, 4, { workspaceReopen: true, workspaceStateOnly: true, workspaceIntentId: 'scoped-reopen' }), scopedA)
  await api.saveAutomaticWorkspace(snapshot(scopedB, 5, { workspaceOpen: false, workspaceStateOnly: true, workspaceIntentId: 'scoped-b-close' }), scopedB)
  pending = JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8'))
  assert.deepEqual(pending.map(item => item.caseId).sort(), ['A', 'B'])
  failedHosts.delete('alpha')
  api = loadDevice()
  assert.equal((await api.listAutomaticWorkspaces(scopedA.ssh)).ok, true)
  assert.equal((await read(scopedA)).workspaceOpen, true)
  assert.equal((await read(scopedB)).workspaceOpen, false)
  assert.equal(JSON.parse(await readFile(join(userData, 'workspace-intents.json'), 'utf8')).length, 0)
  console.log('shared case state: order, metadata, state-only safety, tombstones, restart recovery and endpoint isolation OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
