import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const app = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const handlers = new Map()
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && ['saveCaseWorkspace', 'markWorkspaceReopened'].includes(node.name.getText(parsed))) {
    handlers.set(node.name.getText(parsed), node.initializer.getText(parsed))
  }
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.equal(handlers.size, 2)
const sharedModule = { exports: {} }
vm.runInNewContext(compile(await readFile(new URL('../src/shared/workspaceAgentTabs.ts', import.meta.url), 'utf8')),
  { module: sharedModule, exports: sharedModule.exports })

const agent = (id = 'A') => ({ id, kind: 'agent', cwd: '/case', resumeSessionId: 'session-A' })
const harness = () => {
  const saved = []
  const context = {
    caseTabsRef: { current: [{ id: 'case', name: 'Case' }] },
    termTabsRef: { current: [agent()] },
    currentCaseFromCaseTab: (tab) => tab,
    workspaceLocationKey: () => 'key', workspaceLocation: () => ({ cwd: '/case' }),
    autoRestoreInFlightRef: { current: new Map() }, autoRestoreDoneRef: { current: new Set(['key']) },
    pendingWorkspaceReopensRef: { current: new Map() }, pendingAgentClosesRef: { current: new Map() },
    closedAutomaticCasesRef: { current: new Set() }, pendingCaseClosesRef: { current: new Map() },
    newId: () => 'reopen-intent', isAgentTab: (tab) => tab.kind === 'agent', setRetainedSharedCases: () => {},
    isAgentTabClosed: sharedModule.exports.isAgentTabClosed,
    buildWorkspaceSnapshot: async () => ({ terminals: [...context.termTabsRef.current] }),
    window: { lt: { workspace: { autoSave: async (snapshot) => {
      saved.push(structuredClone(snapshot))
      return { ok: true }
    } } } }
  }
  const sandbox = vm.createContext(context)
  const run = (name) => vm.runInContext(compile(`(${handlers.get(name)})`), sandbox)
  return { context, saved, save: run('saveCaseWorkspace'), reopen: run('markWorkspaceReopened') }
}

test('a late snapshot cannot restore a close already acknowledged by a newer save', { timeout: 5000 }, async () => {
  const { context, saved, save } = harness()
  let signalStarted, release, builds = 0
  const started = new Promise((resolve) => { signalStarted = resolve })
  const resumed = new Promise((resolve) => { release = resolve })
  context.buildWorkspaceSnapshot = async () => {
    const terminals = [...context.termTabsRef.current]
    if (++builds === 1) {
      signalStarted()
      await resumed
    }
    return { terminals }
  }
  const older = save('case')
  await started
  context.pendingAgentClosesRef.current.set('key', [agent()])
  context.termTabsRef.current = []
  await save('case')
  assert.equal(context.pendingAgentClosesRef.current.size, 0, 'the newer save has acknowledged the close')
  release()
  await older
  assert.deepEqual(saved.map((snapshot) => snapshot.terminals.map((tab) => tab.id)), [[], []],
    'the older build must not overwrite the local backup with the closed tab')
})

test('an intentional live reopen still publishes its explicit reopen intent', async () => {
  const { context, saved, save, reopen } = harness()
  const reopened = agent('reopened-A')
  context.pendingAgentClosesRef.current.set('key', [agent()])
  context.termTabsRef.current = [reopened]
  reopen({}, reopened)
  await save('case')
  assert.deepEqual(saved[0].terminals.map((tab) => tab.id), ['reopened-A'])
  assert.equal(saved[0].workspaceReopen, true)
  assert.equal(saved[0].workspaceIntentId, 'reopen-intent')
  assert.deepEqual(saved[0].reopenAgentTabs.map((tab) => tab.id), ['reopened-A'])
})

test('a stale source-window snapshot excludes a moved tab without recording a close', async () => {
  const { context, saved, save } = harness()
  context.buildWorkspaceSnapshot = async () => {
    const terminals = [...context.termTabsRef.current]
    context.termTabsRef.current = []
    return { terminals }
  }
  await save('case')
  assert.deepEqual(saved[0].terminals, [])
  assert.equal(context.pendingAgentClosesRef.current.size, 0)
})
