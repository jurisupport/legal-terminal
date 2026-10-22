import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { isGeneralChatDirectory } from '../src/shared/generalChat.ts'

const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
let refresh
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  if (ts.isBinaryExpression(node) && node.left.getText(parsed) === 'refreshAutomaticCasesRef.current') refresh = node.right.getText(parsed)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.ok(refresh)
const helpers = ['safeHash', 'normalizedCasePathKey', 'caseProfileKey', 'caseIdentityKey', 'caseTabId',
  'findCaseTab', 'caseTabFromCurrentCase', 'currentCaseFromCaseTab', 'upsertCaseTab', 'compareCaseTabOrder',
  'markWorkspaceReopened', 'saveCaseWorkspace']
const code = ts.transpileModule(helpers.map(name => `const ${name} = ${declarations.get(name)};`).join('\n') +
  `\nrefreshAutomaticCasesRef.current = ${refresh};\n({ ${helpers.join(', ')} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
const profile = { id: 'office', host: 'office.invalid', user: 'lawyer', label: 'Office' }
const snapshot = (path, workspaceOpen = true, opened = '2026-10-01T00:00:00Z') => ({
  version: 1, savedAt: '2026-10-18T00:00:00Z', workspaceOpenedAt: opened, workspaceOpen,
  currentCase: { drafts: path, name: path }, terminals: [], docs: []
})
function harness(snapshots) {
  const state = { cases: [], history: [], error: '', loads: [], closes: [], fail: false, onList: null }
  const cases = { current: state.cases }
  const context = {
    isGeneralChatDirectory, console, Date,
    automaticCasesLoadingRef: { current: false }, termTabsRef: { current: [] }, caseTabsRef: cases,
    saveAllCaseWorkspacesRef: { current: async () => true }, workspaceHostsRef: { current: 'office' }, workspaceHostsSignature: 'office',
    sshProfiles: [profile], sshConnFromProfile: p => p,
    sanitizeCurrentCase: value => value?.drafts && value?.name ? value : null,
    remoteUri: (id, path) => `ssh://${id}${path}`,
    sessionListKey: (_, ssh) => ssh ? `${ssh.user}@${ssh.host}:${ssh.port ?? 22}` : 'local',
    workspaceLocationKey: s => s.drafts,
    pendingCaseClosesRef: { current: new Map() }, pendingWorkspaceReopensRef: { current: new Map() },
    closedAutomaticCasesRef: { current: new Set() }, unloadedSharedCasesRef: { current: new Set() },
    setDiscoveredCaseTabs: update => { state.history = update(state.history) },
    setCaseTabs: value => { state.cases = typeof value === 'function' ? value(state.cases) : value; cases.current = state.cases },
    closeCaseTab: async id => { state.closes.push(id); context.setCaseTabs(state.cases.filter(tab => tab.id !== id)) },
    restoreAutomaticWorkspace: async s => { state.loads.push(s); return true },
    setWorkspaceSyncError: value => { state.error = value }, autoWorkspaceSaveChainRef: { current: Promise.resolve() },
    refreshAutomaticCasesRef: { current: undefined },
    window: { lt: { workspace: { autoList: async ssh => {
      if (ssh && state.onList) state.onList()
      return state.fail ? { ok: false, error: 'offline' } : { ok: true, snapshots: ssh ? snapshots : [] }
    } } } }
  }
  const actual = vm.runInNewContext(code, context)
  return { state, context, actual, run: () => context.refreshAutomaticCasesRef.current() }
}

const shared = [snapshot('/cases/later', true, '2026-10-01T00:00:00.001Z'), snapshot('/cases/earlier'), snapshot('/cases/closed', false),
  { ...snapshot('/cases/legacy'), workspaceOpen: undefined }]
const h = harness(shared)
await h.run()
assert.equal(h.state.cases.length, 2, 'only explicitly open remote cases become open tabs')
assert.equal(h.state.history.length, 4, 'closed and legacy workspaces remain discoverable')
assert.equal(h.state.loads.length, 0, 'discovery must not start agents')
assert.equal(h.context.unloadedSharedCasesRef.current.size, 2)
assert.deepEqual(Array.from(h.state.cases.sort(h.actual.compareCaseTabOrder), tab => tab.remotePath), ['/cases/earlier', '/cases/later'],
  'ISO timestamps with different fractional precision sort chronologically')
await h.run()
assert.equal(h.state.cases.length, 2, 'repeated reads do not duplicate open tabs')
assert.equal(h.state.loads.length, 0, 'unselected shared cases remain unloaded on later refreshes')

const later = h.state.cases.find(tab => tab.remotePath === '/cases/later')
h.context.unloadedSharedCasesRef.current.delete(later.id)
await h.run()
assert.equal(h.state.loads.length, 1, 'only locally opened conversations refresh')
const orderedAt = later.workspaceOpenedAt
const revisited = h.actual.upsertCaseTab(h.state.cases, { ...later, workspaceOpenedAt: '2027-01-01T00:00:00Z' })[0]
assert.equal(revisited.workspaceOpenedAt, orderedAt, 'selecting a tab cannot change shared order')

shared[0].workspaceOpen = false
await h.run()
assert.ok(h.state.closes.includes(later.id), 'remote closure reaches locally open case')
assert.equal(h.state.cases.length, 1)
shared[0].workspaceOpen = true
await h.run()
assert.equal(h.state.cases.length, 2, 'explicit remote reopen restores the outer tab')
assert.ok(h.context.unloadedSharedCasesRef.current.has(later.id), 'reopen waits for local selection before loading agents')
h.state.fail = true
await h.run()
assert.equal(h.state.cases.length, 2, 'offline/error is never interpreted as an empty remote list')
assert.match(h.state.error, /공유 실패/)

const pending = harness([snapshot('/cases/pending')])
pending.context.pendingCaseClosesRef.current.set('ssh://office/cases/pending', () => {})
await pending.run()
assert.equal(pending.state.cases.length, 0, 'a pending local close is not undone by an older remote read')

const alias = harness([snapshot('/cases/alias')])
const aliasSource = { name: 'Alias', drafts: 'ssh://another-name/cases/alias', remotePath: '/cases/alias',
  profileId: 'another-name', ssh: profile }
alias.context.setCaseTabs([alias.actual.caseTabFromCurrentCase(aliasSource)])
await alias.run()
assert.equal(alias.state.cases.length, 1, 'profile aliases for the same endpoint do not duplicate a case')
assert.equal(alias.state.cases[0].profileId, 'another-name')

// An old phone folder-close and a newer registered case coexist on the server.
// Folder equality cannot authorize closing the registered case.
for (const reversed of [false, true]) {
  const legacy = snapshot('/cases/same-folder', false)
  const registered = { ...snapshot('/cases/same-folder'),
    currentCase: { drafts: '/cases/same-folder', name: 'Registered case', meta: { jsId: 'registered-case' } } }
  const scoped = harness(reversed ? [registered, legacy] : [legacy, registered])
  const live = scoped.actual.caseTabFromCurrentCase({ ...registered.currentCase,
    drafts: 'ssh://another-name/cases/same-folder', remotePath: '/cases/same-folder', profileId: 'another-name', ssh: profile })
  scoped.context.setCaseTabs([live])
  await scoped.run()
  assert.deepEqual(scoped.state.closes, [], 'legacy folder close must not close an open registered case or select its neighbor')
  assert.equal(scoped.state.cases.length, 1)
  assert.equal(scoped.state.cases[0].id, live.id, 'keep the live case identity across refresh order and SSH profile aliases')
  registered.workspaceOpen = false
  await scoped.run()
  assert.deepEqual(scoped.state.closes, [live.id], 'a close bearing the same registered case ID still applies')
}


const race = harness([snapshot('/cases/stale')])
race.state.onList = () => race.context.setCaseTabs([race.actual.caseTabFromCurrentCase({ drafts: '/local/new', name: 'New local case' })])
await race.run()
assert.equal(race.state.cases.length, 1)
assert.equal(race.state.cases[0].drafts, '/local/new', 'a response read during a local case change is discarded')

const newTask = harness([snapshot('/cases/new-task')])
await newTask.run()
const taskCase = newTask.state.cases[0]
const saved = []
Object.assign(newTask.context, {
  newId: () => 'new-task-intent', isAgentTab: tab => tab.kind === 'agent', setRetainedSharedCases: () => {},
  autoRestoreInFlightRef: { current: new Set() }, autoRestoreDoneRef: { current: new Set([taskCase.drafts]) },
  buildWorkspaceSnapshot: async () => ({ version: 1, savedAt: new Date().toISOString(),
    terminals: [{ id: 'new-agent', kind: 'agent', cwd: taskCase.remotePath, resumeSessionId: saved.length ? 'new-session' : undefined }] }),
  workspaceLocation: s => ({ cwd: s.remotePath, ssh: s.ssh })
})
newTask.context.window.lt.workspace.autoSave = async value => { saved.push(value); return { ok: true } }
newTask.actual.markWorkspaceReopened(taskCase)
await newTask.actual.saveCaseWorkspace(taskCase.id)
await newTask.actual.saveCaseWorkspace(taskCase.id)
assert.equal(saved.length, 2, 'creating work directly from a shared shell keeps later automatic saves enabled')
assert.equal(saved[1].terminals[0].resumeSessionId, 'new-session', 'the first resumable conversation ID is shared after initial save')
assert.equal(newTask.context.unloadedSharedCasesRef.current.has(taskCase.id), false)
console.log('shared case UI: open/close/reopen, lazy agents, stable order, aliases, offline and in-flight protection OK')
