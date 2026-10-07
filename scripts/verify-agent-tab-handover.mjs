import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/workspaceAgentTabs.ts'
import { mergeWorkspaceSessions } from '../src/renderer/src/workspaceSessions.ts'

const root = await mkdtemp(join(tmpdir(), 'lt-agent-tabs-'))
const hostHome = join(root, 'host')
const userData = join(root, 'desktop')
const cwd = '/사건/대여금'
const folder = join(hostHome, '.claude/legal-terminal-workspaces')
const file = join(folder, `${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}.json`)
const require = createRequire(import.meta.url)
let failRead = false
let writes = 0
let delayRead = false
const mocks = {
  electron: { app: { getPath: () => userData } },
  os: { homedir: () => hostHome, hostname: () => 'test-pc' },
  './sshOptions': { buildSshArgs: () => [] },
  '../shared/workspaceAgentTabs': shared,
  child_process: {
    execFile: (_bin, args, options, done) => failRead
      ? done(new Error('offline'), '')
      : execFile('/bin/sh', ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: hostHome } },
        (...result) => delayRead && args.at(-1).includes('then cat') ? setTimeout(() => done(...result), 100) : done(...result)),
    spawn: (_bin, args, options) => {
      writes++
      return spawn('/bin/sh', ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: hostHome } })
    }
  }
}
const term = (id, session = id) => ({ id, title: id, kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: session })
const snapshot = (terminals) => ({ version: 1, savedAt: new Date().toISOString(), mode: 'explorer',
  docs: [{ id: 'doc', kind: 'pdf', path: '/private.pdf' }], terminals,
  currentCase: { name: '사건', drafts: cwd }, activeTerm: terminals[0]?.id })
const location = { cwd, profileId: 'desktop-profile', ssh: { host: 'host', user: 'user' } }
try {
  await mkdir(folder, { recursive: true })
  const code = ts.transpileModule(await readFile(new URL('../src/main/workspace.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loadDevice = (directory = userData) => {
    const module = { exports: {} }
    vm.runInNewContext(code, { module, exports: module.exports,
      require: (id) => id === 'electron' ? { app: { getPath: () => directory } } : mocks[id] ?? require(id),
      process, Buffer, console, setTimeout, clearTimeout })
    return module.exports
  }
  const api = loadDevice()
  assert.equal((await api.loadAutomaticWorkspace(location)).ok, true, 'missing shared file is not an SSH error')
  const saved = await api.saveAutomaticWorkspace(snapshot([
    { ...term('pc'), ssh: location.ssh, profileId: 'private-profile', recordsFolder: 'ssh://private/path' },
    { ...term('shell'), kind: 'terminal' }
  ]), location)
  assert.equal(saved.ok, true)
  assert.equal(saved.remoteError, undefined)
  const published = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(published.docs, [])
  assert.deepEqual(published.terminals.map((tab) => tab.id), ['pc'])
  assert.equal(published.terminals[0].ssh, undefined)
  assert.equal(published.terminals[0].profileId, undefined)
  assert.equal(published.currentCase.drafts, cwd)
  const backup = await api.loadWorkspaceSnapshot(saved.entry.id)
  assert.equal(backup.snapshot.docs.length, 1, 'local manual backup still retains documents')

  const phone = { ...term('mobile'), originDevice: 'android' }
  await writeFile(file, JSON.stringify({ ...published, terminals: [...published.terminals, phone] }))
  await api.saveAutomaticWorkspace(snapshot([term('pc')]), location)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id), ['pc', 'mobile'])
  assert.equal(JSON.parse(await readFile(file, 'utf8')).terminals.find((tab) => tab.id === 'mobile').originDevice, 'android')
  await api.loadAutomaticWorkspace(location)
  await api.saveAutomaticWorkspace(snapshot([phone]), location)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id), ['mobile'], 'closing an imported tab is persisted')

  failRead = true
  assert.equal((await api.loadAutomaticWorkspace(location)).ok, false)
  const writeCount = writes
  const offlineSave = await api.saveAutomaticWorkspace(snapshot([]), location)
  assert.equal(offlineSave.ok, true, 'offline saves still retain the local backup')
  assert.match(offlineSave.remoteError, /offline/)
  assert.equal(writes, writeCount, 'failed remote reads never overwrite saved phone tabs')
  failRead = false
  await writeFile(file, '{broken')
  assert.equal((await api.loadAutomaticWorkspace(location)).ok, false)
  assert.ok((await api.saveAutomaticWorkspace(snapshot([]), location)).remoteError)
  assert.equal(await readFile(file, 'utf8'), '{broken', 'malformed remote content is not overwritten')

  await rm(file)
  const deviceA = loadDevice(join(root, 'device-a'))
  const deviceB = loadDevice(join(root, 'device-b'))
  delayRead = true
  const concurrent = await Promise.all([
    deviceA.saveAutomaticWorkspace(snapshot([term('A')]), location),
    deviceB.saveAutomaticWorkspace(snapshot([term('B')]), location)
  ])
  delayRead = false
  for (const result of concurrent) assert.equal(result.remoteError, undefined)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id).sort(), ['A', 'B'],
    'independent devices must serialize the whole read/merge/write, not only final rename')
  await assert.rejects(readFile(`${file}.lock`), /ENOENT/, 'successful save releases the shared lock')

  await writeFile(file, JSON.stringify(snapshot([term('A')])))
  await api.loadAutomaticWorkspace(location, 1)
  await writeFile(file, JSON.stringify(snapshot([term('A'), term('phone-B')])))
  await api.loadAutomaticWorkspace(location, 2)
  await api.saveAutomaticWorkspace(snapshot([term('A')]), location, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id), ['A', 'phone-B'],
    'one window loading phone tabs must not make another window treat those tabs as locally closed')

  // Discover only explicitly open cases, including an empty case, across local/SSH access.
  await writeFile(file, JSON.stringify({ ...snapshot([term('A'), term('phone-B')]), workspaceOpen: true }))
  const emptyLocation = { ...location, cwd: '/cases/empty' }
  await api.saveAutomaticWorkspace({ ...snapshot([]), workspaceLabel: '빈 사건',
    currentCase: { records: 'ssh://desktop-profile/records/empty' } }, emptyLocation)
  // Android 0.1.6 publishes this shape without workspaceOpen, including for new cases.
  const phoneCwd = '/cases/phone-only'
  const phoneSnapshot = { ...snapshot([{ ...term('mobile-only', 'phone-session'), cwd: phoneCwd, originDevice: 'android' }]),
    workspaceDevice: 'Android', currentCase: { name: '폰에서 시작한 사건', drafts: phoneCwd } }
  const phoneFile = join(folder, `${createHash('sha256').update(phoneCwd).digest('hex').slice(0, 24)}.json`)
  await writeFile(phoneFile, JSON.stringify(phoneSnapshot))
  await writeFile(join(folder, '222222222222222222222222.json'), '{broken')
  const discovered = await api.listAutomaticWorkspaces(location.ssh)
  assert.equal(discovered.ok, true)
  assert.deepEqual(Array.from(discovered.snapshots, (s) => s.currentCase.drafts).sort(), ['/cases/empty', cwd].sort())
  assert.equal(discovered.snapshots.find((s) => s.currentCase.drafts === emptyLocation.cwd).currentCase.records, '/records/empty')
  assert.equal((await api.listAutomaticWorkspaces()).snapshots.length, 2)
  for (const ssh of [undefined, location.ssh]) {
    const history = await api.listAutomaticWorkspaces(ssh, true)
    assert.equal(history.ok, true)
    assert.equal(history.snapshots.length, 3, 'history includes phone cases without an open flag, skipping damaged files')
    const mobile = history.snapshots.find((entry) => entry.currentCase.drafts === phoneCwd)
    assert.equal(mobile.terminals[0].resumeSessionId, 'phone-session', 'phone conversations remain resumable')
    assert.equal(mobile.terminals[0].originDevice, 'android', 'history discovery keeps the phone creator')
    assert.equal(mobile.workspaceOpen, undefined, 'history discovery must not mark a phone case as open')
  }
  assert.deepEqual(JSON.parse(await readFile(phoneFile, 'utf8')), phoneSnapshot, 'listing history must not rewrite phone data')
  // Merely listing a phone's new tab must not turn it into a known local deletion.
  await api.loadAutomaticWorkspace(location, 1, false)
  await api.saveAutomaticWorkspace(snapshot([term('A')]), location, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id), ['A', 'phone-B'])
  await api.saveAutomaticWorkspace({ ...snapshot([]), workspaceOpen: false }, location, 1)
  assert.equal((await api.listAutomaticWorkspaces(location.ssh)).snapshots.length, 1, 'closed cases are not rediscovered')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).terminals.length, 2, 'closing a case preserves its conversations')
  const applied = (await api.loadAutomaticWorkspace(location, 1, false)).remote.snapshot
  api.observeAutomaticWorkspace(location, applied, 1)
  await api.saveAutomaticWorkspace(snapshot([term('A')]), location, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).terminals.map((tab) => tab.id), ['A'],
    'a newly imported tab closed before autosave stays closed once its exact snapshot is acknowledged')
  failRead = true
  assert.equal((await api.listAutomaticWorkspaces(location.ssh)).ok, false)
  failRead = false
  assert.equal((await api.listAutomaticWorkspaces(location.ssh)).ok, true, 'discovery retries after reconnect')

  const staleLocation = { ...location, cwd: '/cases/stale-desktop' }
  const staleSnapshot = (tabs) => ({ ...snapshot(tabs.map((tab) => ({ ...tab, cwd: staleLocation.cwd }))),
    currentCase: { name: '기존 PC 유지', drafts: staleLocation.cwd } })
  const oldDesktop = loadDevice(join(root, 'old-desktop'))
  const newDesktop = loadDevice(join(root, 'new-desktop'))
  const original = staleSnapshot([term('original')])
  await oldDesktop.saveAutomaticWorkspace(original, staleLocation)
  await newDesktop.loadAutomaticWorkspace(staleLocation)
  await newDesktop.saveAutomaticWorkspace(staleSnapshot([]), staleLocation)
  await oldDesktop.saveAutomaticWorkspace(original, staleLocation)
  let latest = (await newDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.terminals.length, 0, 'an old open desktop cannot resurrect a remotely closed agent')
  await oldDesktop.loadAutomaticWorkspace(staleLocation)
  await oldDesktop.saveAutomaticWorkspace(original, staleLocation)
  latest = (await newDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.terminals.length, 0, 'reading the closed state cannot forget the remote deletion')
  await newDesktop.saveAutomaticWorkspace({ ...staleSnapshot([]), workspaceOpen: false }, staleLocation)
  await oldDesktop.saveAutomaticWorkspace(original, staleLocation)
  latest = (await newDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.workspaceOpen, false, 'old desktop background saves cannot reopen a remotely closed case')
  assert.ok((await newDesktop.listAutomaticWorkspaces(location.ssh, true)).snapshots.some((s) =>
    s.currentCase.drafts === staleLocation.cwd && s.workspaceOpen === false), 'refresh can reconcile closed cases')
  const reopened = { ...staleSnapshot([term('reopened', 'original')]), workspaceReopen: true,
    reopenAgentTabs: [{ ...term('reopened', 'original'), cwd: staleLocation.cwd }] }
  await newDesktop.saveAutomaticWorkspace(reopened, staleLocation)
  await oldDesktop.saveAutomaticWorkspace(original, staleLocation)
  latest = (await newDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.workspaceOpen, true, 'explicit user reopen succeeds while the older desktop remains open')
  assert.equal(latest.terminals.length, 1, 'reopening the same conversation deduplicates device tab ids')
  assert.equal(latest.closedAgentTabs.length, 0, 'stale device close records cannot undo an explicit reopen')
  const closeRequest = { ...staleSnapshot([]), workspaceOpen: false, workspaceIntentId: 'close-once' }
  const reopenRequest = { ...reopened, workspaceIntentId: 'reopen-once' }
  await oldDesktop.saveAutomaticWorkspace(closeRequest, staleLocation)
  await newDesktop.saveAutomaticWorkspace(reopenRequest, staleLocation)
  await oldDesktop.saveAutomaticWorkspace(closeRequest, staleLocation)
  latest = (await newDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.workspaceOpen, true, 'retrying an already-applied close cannot erase a newer reopen')
  await oldDesktop.saveAutomaticWorkspace({ ...closeRequest, workspaceIntentId: 'close-again' }, staleLocation)
  await newDesktop.saveAutomaticWorkspace(reopenRequest, staleLocation)
  latest = (await oldDesktop.loadAutomaticWorkspace(staleLocation)).remote.snapshot
  assert.equal(latest.workspaceOpen, false, 'retrying an old reopen cannot erase a newer close')

  // Exercise the actual renderer restore handler, including async failure/retry and live work.
  const app = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'restoreAutomaticWorkspace') handler = node.initializer.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(handler)
  let response
  let loaded = 0
  let restored
  const alerts = []
  const observed = []
  const context = {
    resolveCaseTabId: () => 'case', workspaceLocationKey: () => 'key', workspaceLocation: () => location,
    autoRestoreDoneRef: { current: new Set() }, autoRestoreInFlightRef: { current: new Set() },
    autoRestorePromisesRef: { current: new Map() },
    autoSaveEligibleRef: { current: new Set() }, caseTabsRef: { current: [{ id: 'case' }] },
    termTabsRef: { current: [term('live-pc', 'pc')] }, activeCaseTabIdRef: { current: 'case' },
    caseIdForTerm: () => 'case', rebaseRemoteWorkspace: (s) => s,
    agentTabsOnly: shared.agentTabsOnly, isAgentTabClosed: shared.isAgentTabClosed, mergeWorkspaceSessions,
    pendingWorkspaceReopensRef: { current: new Map() }, hasLocalTermWork: () => false,
    closeTerm: (id) => { context.termTabsRef.current = context.termTabsRef.current.filter((term) => term.id !== id) },
    closeCaseTab: async () => { context.caseTabsRef.current = [] },
    window: { lt: { workspace: { autoLoad: async () => { loaded++; return response },
      autoObserve: async (_location, snapshot) => observed.push(snapshot) }, dialog: { alert: async (text) => alerts.push(text) } } },
    restoreWorkspaceSnapshot: (s, activate) => { restored = { s, activate } }
  }
  const run = vm.runInNewContext(ts.transpileModule(`(${handler})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  response = { ok: false, error: 'offline' }
  await run({})
  assert.equal(context.autoRestoreDoneRef.current.size, 0, 'failure is retryable')
  assert.equal(context.autoRestoreInFlightRef.current.size, 0)
  response = { ok: true, local: { snapshot: snapshot([term('pc')]) }, remote: { snapshot: snapshot([phone, { ...term('shell'), kind: 'terminal' }]) } }
  await run({})
  assert.deepEqual(Array.from(restored.s.terminals, (tab) => tab.id), ['mobile'])
  assert.equal(restored.s.docs.length, 0)
  assert.equal(restored.activate, false, 'existing agent focus is preserved')
  assert.equal(alerts.length, 1, 'successful handover requires no confirmation')
  await run({})
  assert.equal(loaded, 2, 'same workspace is not repeatedly restored')
  context.autoRestoreDoneRef.current.clear()
  response = { ok: false, error: 'offline', local: { ok: true, snapshot: snapshot([term('offline-local')]) } }
  await run({})
  assert.equal(restored.s.terminals[0].id, 'offline-local', 'offline restore still opens the local agent backup')
  assert.equal(context.autoRestoreDoneRef.current.size, 0)
  context.caseTabsRef.current = []
  restored = undefined
  await run({})
  assert.equal(restored, undefined, 'a late response cannot reopen a closed case')

  context.caseTabsRef.current = [{ id: 'case' }]
  response = { ok: true, remote: { snapshot: snapshot([phone]) } }
  await run({}, true)
  assert.equal(observed[0], response.remote.snapshot, 'acknowledge the exact applied response without rereading')
  restored = undefined
  context.termTabsRef.current = [term('closing-agent')]
  let finishRead
  context.window.lt.workspace.autoLoad = (_location, observe) => {
    assert.equal(observe, false, 'background refresh cannot mark unseen tabs as observed')
    return new Promise((resolve) => { finishRead = resolve })
  }
  const refreshing = run({}, true)
  context.termTabsRef.current = []
  finishRead({ ok: true, remote: { snapshot: snapshot([term('closing-agent'), phone]) } })
  await refreshing
  assert.equal(restored, undefined, 'a late refresh cannot resurrect an individually closed agent')
  assert.equal(observed.length, 1, 'a discarded response never marks unknown remote tabs as observed')

  const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
  const serviceTree = ts.createSourceFile('agent-service.ts', service, ts.ScriptTarget.Latest, true)
  const functions = new Map()
  let initializer
  const inspect = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(serviceTree))
    if (ts.isVariableDeclaration(node) && node.name.getText(serviceTree) === 'session' && node.type?.getText(serviceTree) === 'AgentSession') initializer = node.initializer.getText(serviceTree)
    ts.forEachChild(node, inspect)
  }
  inspect(serviceTree)
  const codexCalls = []
  const codex = vm.createContext({
    opts: { id: 'codex-tab', cwd, resumeSessionId: 'existing-thread' }, provider: 'codex', source: 'ssh',
    emptyTokenUsage: () => ({}), assertManagedAccount: () => {}, startCodexProcess: () => {},
    ensureCodexInitialized: async () => {}, codexMaybeModel: () => ({}),
    codexApprovalPolicy: () => 'on-request', codexSandboxMode: () => 'workspace-write', emit: () => {},
    asRecord: (value) => value, stringValue: (value) => typeof value === 'string' ? value : undefined,
    codexRequest: async (_session, method, payload) => { codexCalls.push({ method, payload }); return { thread: { id: 'existing-thread' } } }
  })
  vm.runInContext(ts.transpileModule(`const session = ${initializer}; const sessions = new Map([[session.id, session]]);\n` +
    functions.get('ensureCodexThread') + '\n' + functions.get('getAgentSessionSnapshot').replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, codex)
  await vm.runInContext('ensureCodexThread(session)', codex)
  assert.equal(codexCalls[0].method, 'thread/resume', 'a restored Codex agent resumes rather than starts a new conversation')
  assert.equal(codexCalls[0].payload.threadId, 'existing-thread')
  assert.equal(vm.runInContext('getAgentSessionSnapshot(session.id).session.resumeSessionId', codex), 'existing-thread')
  console.log('agent tab handover: backend SSH round trip, agent-only renderer restore, concurrency and failure checks OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
