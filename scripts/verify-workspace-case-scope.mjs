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
const remoteLocks = new Set()
let remoteError
const filename = command => command.match(/([a-f0-9]+\.json)/)?.[1] ?? assert.fail('hashed remote filename')
const source = readFileSync(new URL('../src/main/workspace.ts', import.meta.url), 'utf8')
const api = {}
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: api, process: { platform: process.platform, pid: process.pid }, Buffer, setTimeout, clearTimeout,
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
          if (args.at(-1).startsWith('mkdir ')) remoteLocks.add(filename(args.at(-1)))
          queueMicrotask(() => callback(remoteError, ''))
          return
        }
        if (args.at(-1).startsWith('for file ')) {
          queueMicrotask(() => callback(remoteError, [...remoteFiles].map(([name, content]) => `${name}\n${content}`).join('\x1e')))
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
  assert.equal(discovered.snapshots.length, 2, 'local canonical files replace legacy copies in discovery')
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
  assert.equal(remoteDiscovery.snapshots.length, 2, 'remote canonical files replace legacy copies in discovery')
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
  remoteFiles.clear()
  const projectSnapshot = (projectId, cwd = '/synthetic/project-shared-folder') => ({
    version: 1, savedAt: '2026-10-19T00:00:00.000Z', workspaceOpen: true,
    workspaceLabel: `Project ${projectId}`,
    currentCase: { drafts: cwd, name: `Project ${projectId}`, meta: { contextKind: 'project', projectId } },
    caseTabs: [{ id: `project-${projectId}`, drafts: cwd, meta: { contextKind: 'project', projectId } }],
    docs: [{ id: `doc-${projectId}`, path: `${cwd}/${projectId}.md` }],
    terminals: [{ id: 'same-agent-id', kind: 'agent', cwd, contextKind: 'project', projectId, resumeSessionId: `project-session-${projectId}` }]
  })
  const projectName = (cwd, projectId) => crypto.createHash('sha256')
    .update(JSON.stringify(['project-workspace', cwd, projectId])).digest('hex').slice(0, 24) + '.json'
  const legacyName = cwd => crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 24) + '.json'
  const localFile = target => path.join(directory, 'userData/workspaces',
    `${api.workspaceIdForLocation(target.cwd, target.profileId, target.caseId, target.projectId)}.json`)
  const sharedFile = name => path.join(directory, 'home/.claude/legal-terminal-workspaces', name)
  const seedLegacyProject = async (target, stored) => {
    await fs.writeFile(localFile(target), JSON.stringify(stored))
    if (target.ssh) remoteFiles.set(legacyName(target.cwd), JSON.stringify(shared.agentTabsOnly(stored)))
    else await fs.writeFile(sharedFile(legacyName(target.cwd)), JSON.stringify(shared.agentTabsOnly(stored)))
  }
  const assertProject = (restored, projectId) => {
    assert.equal(restored.ok, true)
    for (const loaded of [restored.local, restored.remote]) {
      assert.equal(loaded.snapshot.currentCase.meta.contextKind, 'project')
      assert.equal(loaded.snapshot.currentCase.meta.projectId, projectId)
      assert.equal(loaded.snapshot.currentCase.meta.jsId, undefined, 'project identity must not be encoded as a case id')
      assert.deepEqual(Array.from(loaded.snapshot.terminals, tab => tab.resumeSessionId), [`project-session-${projectId}`])
    }
  }
  assert.notEqual(api.workspaceIdForLocation(location.cwd, undefined, 'P'), api.workspaceIdForLocation(location.cwd, undefined, undefined, 'P'))
  assert.notEqual(api.workspaceIdForLocation(location.cwd, undefined, undefined, 'P'), api.workspaceIdForLocation(location.cwd, undefined, undefined, 'Q'))
  assert.notEqual(api.workspaceIdForLocation(location.cwd, 'ssh-1', undefined, 'P'), api.workspaceIdForLocation(location.cwd, 'ssh-2', undefined, 'P'))
  assert.equal(api.snapshotMatchesProject(projectSnapshot('P'), 'P'), true)
  assert.equal(api.snapshotMatchesProject(snapshot('P'), 'P'), false)
  assert.equal(api.snapshotMatchesCase(projectSnapshot('P'), 'P'), false)
  assert.equal(api.snapshotMatchesProject(projectSnapshot('P'), 'Q'), false)
  const mixedProject = projectSnapshot('P')
  mixedProject.terminals.push(...projectSnapshot('Q').terminals)
  assert.equal(api.snapshotMatchesProject(mixedProject, 'P'), false)
  const projectWithCase = projectSnapshot('P')
  projectWithCase.terminals.push(...snapshot('case').terminals)
  assert.equal(api.snapshotMatchesProject(projectWithCase, 'P'), false)
  assert.equal((await api.saveAutomaticWorkspace(projectWithCase, { cwd: location.cwd, projectId: 'P' })).ok, false)
  assert.equal((await api.saveAutomaticWorkspace(projectSnapshot('P'), { cwd: location.cwd, caseId: 'P' })).ok, false)
  assert.equal((await api.saveAutomaticWorkspace(projectSnapshot('P'), { cwd: location.cwd, caseId: 'P', projectId: 'P' })).ok, false)
  assert.throws(() => api.observeAutomaticWorkspace({ cwd: location.cwd, projectId: 'Q' }, projectSnapshot('P')), /일치하지 않아/)

  for (const target of [
    { cwd: '/synthetic/project-shared-folder' },
    { cwd: '/remote/project-shared-folder', profileId: 'project-host', ssh: { user: 'tester', host: 'synthetic' } }
  ]) {
    // Legacy currentCase metadata alone is sufficient; old agents did not always repeat it.
    const legacyProject = projectSnapshot('P', target.cwd)
    legacyProject.caseTabs = undefined
    delete legacyProject.terminals[0].contextKind
    delete legacyProject.terminals[0].projectId
    await seedLegacyProject(target, legacyProject)
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'P' }), 'P')
    empty(await api.loadAutomaticWorkspace({ ...target, projectId: 'Q' }))
    empty(await api.loadAutomaticWorkspace({ ...target, caseId: 'P' }))
    empty(await api.loadAutomaticWorkspace(target))
    let discovery = await api.listAutomaticWorkspaces(target.ssh)
    assert.equal(discovery.snapshots.filter(s => s.currentCase.drafts === target.cwd).length, 1,
      'legacy project currentCase remains discoverable before migration')

    // The ordinary folder may be used first after upgrade; preserve the legacy project.
    const plain = snapshot()
    plain.currentCase = { drafts: target.cwd, name: 'Ordinary folder' }
    plain.caseTabs = []
    plain.terminals[0].cwd = target.cwd
    const plainSave = await api.saveAutomaticWorkspace(plain, target, 41)
    assert.equal(plainSave.ok, true)
    assert.equal(plainSave.remoteError, undefined)
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'P' }), 'P')
    assertSnapshot((await api.loadAutomaticWorkspace(target)).remote.snapshot, undefined, true)
    empty(await api.loadAutomaticWorkspace({ ...target, projectId: 'Q' }))
    for (const id of ['P', 'Q']) {
      const saved = await api.saveAutomaticWorkspace(projectSnapshot(id, target.cwd), { ...target, projectId: id }, 41)
      assert.equal(saved.ok, true)
      assert.equal(saved.remoteError, undefined)
      await api.loadAutomaticWorkspace({ ...target, projectId: id }, 41)
    }
    const caseSave = await api.saveAutomaticWorkspace(snapshot('P'), { ...target, caseId: 'P' }, 41)
    assert.equal(caseSave.remoteError, undefined)
    assert.notEqual(localFile({ ...target, caseId: 'P' }), localFile({ ...target, projectId: 'P' }))
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'P' }, 41), 'P')
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'Q' }, 41), 'Q')
    assertSnapshot((await api.loadAutomaticWorkspace({ ...target, caseId: 'P' }, 41)).remote.snapshot, 'P', true)
    discovery = await api.listAutomaticWorkspaces(target.ssh)
    const here = discovery.snapshots.filter(s => s.currentCase.drafts === target.cwd)
    assert.equal(here.length, 4, 'ordinary folder, case, and two projects sharing one path remain separate')
    assert.deepEqual(Array.from(here.filter(s => s.currentCase.meta?.contextKind === 'project'), s => s.currentCase.meta.projectId).sort(), ['P', 'Q'])

    const movedProjectLocation = { ...target, cwd: `${target.cwd}/new-working-folder`, projectId: 'P' }
    const movedProject = projectSnapshot('P', movedProjectLocation.cwd)
    movedProject.terminals[0].resumeSessionId = 'new-working-folder-session'
    assert.equal((await api.saveAutomaticWorkspace(movedProject, movedProjectLocation)).remoteError, undefined)
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'P' }), 'P')
    assert.equal((await api.loadAutomaticWorkspace(movedProjectLocation)).remote.snapshot.terminals[0].resumeSessionId, 'new-working-folder-session',
      'changing the working folder preserves the old project history in its separate location')

    const closedP = await api.saveAutomaticWorkspace({ ...projectSnapshot('P', target.cwd), terminals: [] }, { ...target, projectId: 'P' }, 41)
    assert.equal(closedP.remoteError, undefined)
    const projectP = (await api.loadAutomaticWorkspace({ ...target, projectId: 'P' }, 41)).remote.snapshot
    assert.equal(projectP.terminals.length, 0)
    assert.deepEqual(Array.from(projectP.closedAgentTabs, tab => tab.resumeSessionId), ['project-session-P'])
    assertProject(await api.loadAutomaticWorkspace({ ...target, projectId: 'Q' }, 41), 'Q')
    assertSnapshot((await api.loadAutomaticWorkspace(target, 41)).remote.snapshot, undefined, true)
    assertSnapshot((await api.loadAutomaticWorkspace({ ...target, caseId: 'P' }, 41)).remote.snapshot, 'P', true)

    // Exact wrong-project files must be rejected without merging or overwriting their contents.
    const wrong = JSON.stringify(projectSnapshot('P', target.cwd))
    const exactQ = projectName(target.cwd, 'Q')
    const originalLocal = await fs.readFile(localFile({ ...target, projectId: 'Q' }), 'utf8')
    await fs.writeFile(localFile({ ...target, projectId: 'Q' }), wrong)
    assert.equal((await api.loadAutomaticWorkspace({ ...target, projectId: 'Q' })).ok, false)
    await fs.writeFile(localFile({ ...target, projectId: 'Q' }), originalLocal)
    const originalShared = target.ssh ? remoteFiles.get(exactQ) : await fs.readFile(sharedFile(exactQ), 'utf8')
    if (target.ssh) remoteFiles.set(exactQ, wrong)
    else await fs.writeFile(sharedFile(exactQ), wrong)
    const rejected = await api.saveAutomaticWorkspace(projectSnapshot('Q', target.cwd), { ...target, projectId: 'Q' })
    assert.match(rejected.remoteError, /일치하지 않아/)
    assert.equal(target.ssh ? remoteFiles.get(exactQ) : await fs.readFile(sharedFile(exactQ), 'utf8'), wrong)
    if (target.ssh) remoteFiles.set(exactQ, originalShared)
    else await fs.writeFile(sharedFile(exactQ), originalShared)

    // A later old-client save must not replace the canonical project state or vanish.
    const lateLegacy = projectSnapshot('P', target.cwd)
    lateLegacy.terminals[0].resumeSessionId = 'old-client-project-session'
    await seedLegacyProject(target, lateLegacy)
    assert.equal((await api.saveAutomaticWorkspace(plain, target)).remoteError, undefined)
    const localBackups = await api.listWorkspaceSnapshots()
    const recovered = await Promise.all(localBackups.entries.map(entry => api.loadWorkspaceSnapshot(entry.id)))
    assert.ok(recovered.some(result => result.snapshot?.terminals?.some(tab => tab.resumeSessionId === 'old-client-project-session')),
      'legacy history is retained even when a newer canonical project already exists')
    const sharedContents = target.ssh ? [...remoteFiles.values()]
      : await Promise.all((await fs.readdir(path.dirname(sharedFile('unused.json')))).filter(name => name.endsWith('.json'))
        .map(name => fs.readFile(sharedFile(name), 'utf8')))
    assert.ok(sharedContents.some(content => content.includes('old-client-project-session')), 'shared legacy history remains backed up')
    assert.equal((await api.loadAutomaticWorkspace({ ...target, projectId: 'P' })).remote.snapshot.terminals.length, 0,
      'preserving old history never reopens a closed canonical project conversation')
    if (target.ssh) {
      assert.ok(remoteLocks.has(projectName(target.cwd, 'P')))
      assert.ok(remoteLocks.has(projectName(target.cwd, 'Q')), 'each project locks its own shared file')
    }
  }

  // Failed project closes are queued and retried independently from the same-folder case.
  const intentLocation = { cwd: '/remote/project-intents', profileId: 'project-host', ssh: { user: 'tester', host: 'synthetic' } }
  const intentions = [
    { ...intentLocation, projectId: 'P' }, { ...intentLocation, projectId: 'Q' }, { ...intentLocation, caseId: 'P' }
  ]
  for (const target of intentions) {
    const stored = target.projectId ? projectSnapshot(target.projectId, target.cwd) : snapshot(target.caseId)
    assert.equal((await api.saveAutomaticWorkspace(stored, target)).remoteError, undefined)
  }
  remoteError = Object.assign(new Error('synthetic close disconnect'), { code: 255 })
  for (const target of intentions) {
    const stored = target.projectId ? projectSnapshot(target.projectId, target.cwd) : snapshot(target.caseId)
    const result = await api.saveAutomaticWorkspace({ ...stored, workspaceOpen: false,
      workspaceIntentId: `close-${target.projectId ? 'project' : 'case'}-${target.projectId ?? target.caseId}` }, target)
    assert.match(result.remoteError, /close disconnect/)
  }
  const intentPath = path.join(directory, 'userData/workspace-intents.json')
  const pending = JSON.parse(await fs.readFile(intentPath, 'utf8'))
  assert.equal(pending.length, 3)
  assert.deepEqual(pending.map(item => item.projectId ?? `case:${item.caseId}`).sort(), ['P', 'Q', 'case:P'])
  remoteError = undefined
  assert.equal((await api.listAutomaticWorkspaces(intentLocation.ssh)).ok, true)
  assert.deepEqual(JSON.parse(await fs.readFile(intentPath, 'utf8')), [])
  for (const target of intentions) assert.equal((await api.loadAutomaticWorkspace(target)).remote.snapshot.workspaceOpen, false)

  // Pending closes written by the old desktop infer their project identity from metadata.
  await fs.writeFile(intentPath, JSON.stringify([{ endpoint: 'tester@synthetic:22', cwd: intentLocation.cwd,
    profileId: intentLocation.profileId, snapshot: { ...projectSnapshot('Q', intentLocation.cwd),
      workspaceOpen: true, workspaceReopen: true, workspaceIntentId: 'legacy-project-reopen' } }]))
  assert.equal((await api.listAutomaticWorkspaces(intentLocation.ssh)).ok, true)
  assert.equal((await api.loadAutomaticWorkspace({ ...intentLocation, projectId: 'Q' })).remote.snapshot.workspaceOpen, true)
  assert.equal((await api.loadAutomaticWorkspace({ ...intentLocation, projectId: 'P' })).remote.snapshot.workspaceOpen, false)
  assert.equal((await api.loadAutomaticWorkspace({ ...intentLocation, caseId: 'P' })).remote.snapshot.workspaceOpen, false)
  assert.deepEqual(JSON.parse(await fs.readFile(intentPath, 'utf8')), [])
  console.log('workspace case/project scope: local/SSH same-folder isolation, guarded legacy migration, folder compatibility, observers, locks, independent close recovery and mismatches verified')
} finally { await fs.rm(directory, { recursive: true, force: true }) }
