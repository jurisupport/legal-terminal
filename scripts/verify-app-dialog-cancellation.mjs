import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['confirmCloseDirtyDocs', 'closeDoc', 'closeTermWithConfirm', 'closeDetachedDoc', 'closeDetachedTerm', 'deleteJsToken', 'deleteDictationKey', 'forceCloseWindow']
const handlers = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(parsed))) {
    handlers.set(node.name.getText(parsed), node.initializer.getText(parsed))
  }
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.equal(handlers.size, names.length, 'exercise the actual App handlers')
const code = ts.transpileModule(
  [...handlers].map(([name, value]) => `const ${name} = ${value}`).join('\n') + `\n({ ${names.join(', ')} })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText
const noop = () => {}

for (const mode of ['docOnly', 'termOnly']) {
  for (const blocked of ['queue', 'save']) {
    const pending = new Promise(() => {})
    const calls = []
    const forceWindowCloseRef = { current: false }
    const actual = vm.runInNewContext(code, {
      docOnly: mode === 'docOnly', termOnly: mode === 'termOnly',
      autoWorkspaceSaveChainRef: { current: blocked === 'queue' ? pending : Promise.resolve() },
      saveAllCaseWorkspacesRef: { current: () => { calls.push('save'); return pending } },
      caseTabsRef: { current: [{ id: 'case' }] },
      saveCaseWorkspace: async (id, waitForSync) => {
        assert.equal(id, 'case')
        assert.equal(waitForSync, false, 'dispatch the final snapshot without awaiting shared storage')
        calls.push('dispatch')
      },
      forceWindowCloseRef, setCloseWindowPrompt: noop,
      window: { lt: { app: { forceCloseWindow: () => calls.push('close') } } }
    })
    void actual.forceCloseWindow()
    await new Promise(setImmediate)
    assert.deepEqual(calls, ['dispatch', 'close'], `${mode}: close does not wait for a blocked workspace ${blocked}`)
    assert.equal(forceWindowCloseRef.current, true)
  }
}

{
  let finishQueue, finishSave
  const calls = []
  const actual = vm.runInNewContext(code, {
    docOnly: false, termOnly: false,
    autoWorkspaceSaveChainRef: { current: new Promise((resolve) => { finishQueue = resolve }) },
    saveAllCaseWorkspacesRef: { current: () => { calls.push('save'); return new Promise((resolve) => { finishSave = resolve }) } },
    forceWindowCloseRef: { current: false }, setCloseWindowPrompt: noop,
    window: { lt: { app: { forceCloseWindow: () => calls.push('close') } } }
  })
  const closing = actual.forceCloseWindow()
  assert.deepEqual(calls, [], 'a full workspace still flushes its pending saves before closing')
  finishQueue()
  await new Promise(setImmediate)
  assert.deepEqual(calls, ['save'])
  finishSave()
  await closing
  assert.deepEqual(calls, ['save', 'close'])
}

for (const kind of ['doc', 'term']) {
  for (const scenario of ['cancel', 'approve', 'gone', 'added']) {
    const target = { id: 'intended', title: '작성서면.md', side: 'left' }
    const refs = { current: [target] }
    const dirty = { current: new Set([target.id]) }
    const closed = []
    let release, windowCloses = 0
    const context = {
      window: { lt: { dialog: { confirm: () => new Promise((resolve) => { release = resolve }) } } },
      docOnly: true, termOnly: true, docTabsRef: refs, termTabsRef: refs, dirtyDocsRef: dirty,
      visibleDocTabs: [target], visibleTermTabs: [target], activeDoc: target.id,
      activeWork: { left: 'doc:intended' },
      termStatus: new Map([[target.id, 'working']]),
      docSide: () => 'left', docKey: (id) => `doc:${id}`, workKeysForSide: () => [],
      resolveActiveWorkKey: () => '', nextWorkKeyAfterClose: () => '',
      activateWorkKeyAfterClose: noop, setActiveDoc: noop,
      setDirtyDocs: (update) => { dirty.current = update(dirty.current) },
      setPdfStatus: (update) => { update({}) },
      setDocTabs: (update) => { refs.current = update(refs.current) },
      closeTab: (tabs, id) => { closed.push(id); return tabs.filter((tab) => tab.id !== id) },
      closeTerm: (id) => { closed.push(id); refs.current = refs.current.filter((tab) => tab.id !== id); return true },
      closeCurrentWindowSoon: () => { windowCloses++ }
    }
    const actual = vm.runInNewContext(code, context)
    const pending = actual[kind === 'doc' ? 'closeDetachedDoc' : 'closeDetachedTerm'](target.id)
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false, `${kind}: closing waits for a decision`)
    assert.deepEqual(closed, [], `${kind}: no close before confirmation`)
    assert.equal(windowCloses, 0)
    if (scenario === 'gone') refs.current = []
    if (scenario === 'added') refs.current.push({ id: 'new-tab' })
    release(scenario !== 'cancel')
    await pending
    const shouldClose = scenario === 'approve' || scenario === 'added'
    assert.deepEqual(closed, shouldClose ? [target.id] : [], `${kind}: ${scenario} targets only the surviving intended tab`)
    assert.equal(windowCloses, scenario === 'approve' ? 1 : 0, `${kind}: ${scenario} preserves any remaining window`)
    if (scenario === 'cancel') {
      assert.equal(refs.current[0], target)
      assert.equal(dirty.current.has(target.id), true)
    }
    if (scenario === 'added') assert.deepEqual(refs.current.map((tab) => tab.id), ['new-tab'])
  }
}

for (const name of ['deleteJsToken', 'deleteDictationKey']) {
  for (const answer of [false, true]) {
    let release
    const deleted = []
    const actual = vm.runInNewContext(code, {
      window: { lt: { dialog: { confirm: () => new Promise((resolve) => { release = resolve }) } } },
      applyJsToken: (value) => { deleted.push(value) },
      applyDictationKey: (value) => { deleted.push(value) }
    })
    const pending = actual[name]()
    assert.deepEqual(deleted, [], `${name}: do not delete while confirmation is unresolved`)
    release(answer)
    await pending
    assert.deepEqual(deleted, answer ? [''] : [], `${name}: cancellation preserves credentials`)
  }
}

console.log('App confirmations defer closing/deletion, preserve cancellation, and guard surviving tabs and detached windows')
