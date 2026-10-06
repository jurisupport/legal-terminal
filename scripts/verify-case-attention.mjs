import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)

const noop = () => {}
const state = {
  caseTabs: ['a', 'b', 'empty'].map((id) => ({ id, drafts: `/${id}`, activeTermId: `${id}1`, activeDocId: `${id}-visible`, activeWork: { left: `doc:${id}-visible`, right: `terminal:${id}1` } })),
  termTabs: ['a1', 'a2', 'a3', 'b1'].map((id) => ({ id, title: id, kind: 'agent', caseTabId: id[0] })),
  docTabs: ['a-visible', 'a-hidden', 'b-visible'].map((id) => ({ id, path: `/${id[0]}/${id}.md`, caseTabId: id[0], kind: 'markdown' })),
  activeCaseTabId: 'a', activeTerm: 'a1', activeDoc: 'a-visible',
  activeWork: { left: 'doc:a-visible', right: 'terminal:a1' },
  termStatus: new Map([['a1', 'question'], ['a2', 'question'], ['a3', 'done'], ['b1', 'done']]),
  termAttention: new Set(['a1', 'a2', 'a3', 'b1']),
  caseDocumentUpdates: { a: { paths: ['/a/a-visible.md', '/a/a-hidden.md'], latestAt: 1 }, b: { paths: ['/b/new.md'], latestAt: 2 } },
  caseAttentionOnly: true, caseTabsOpen: true, termFocusNonce: {}, mode: 'explorer'
}
const focus = []
const context = {
  ...state,
  caseAttentionOrderRef: { current: [] }, termStatusRef: { current: state.termStatus }, sshProfiles: [], liveCaseTabIds: new Set(['a', 'b', 'empty']),
  caseIdForTerm: (term) => term.caseTabId, caseIdForDoc: (doc) => doc.caseTabId,
  isSharedDocTab: () => false, currentCaseFromCaseTab: (tab) => tab,
  currentCaseFromTerm: (term) => state.caseTabs.find((tab) => tab.id === term.caseTabId),
  currentCaseSessionSource: noop, setCurrentCase: noop, preloadPastSessions: noop,
  registerCaseTabFromTerm: noop,
  upsertCaseTab: (tabs, incoming) => tabs.map((tab) => tab.id === incoming.id ? incoming : tab),
  isWorkKey: (key) => /^(doc|terminal):/.test(key ?? ''),
  setWorkActive: (side, key) => context.setActiveWork((work) => ({ ...work, [side]: key })),
  activeWorkKeyForSide: (side) => state.activeWork[side],
  isTermVisibleInCurrentWorkspace: (id) => state.activeCaseTabId === id[0] && Object.values(state.activeWork).includes(`terminal:${id}`),
  bumpFocusNonce: (current, id) => ({ ...current, [id]: (current[id] ?? 0) + 1 }),
  dismissToastForTerm: noop, pushToast: noop, playNotificationSound: noop,
  window: { lt: { app: { dismissNotify: noop, requestAttention: noop, notify: noop } } },
  document: { hasFocus: () => true }, notifyDone: true, notificationSound: '', notificationVolume: 0,
  pathLeaf: (path) => path.split('/').at(-1), docKindForPath: () => 'markdown', newId: () => 'new-doc',
  currentCaseTabIdForNewTab: () => state.activeCaseTabId,
  inferCaseTabIdForPath: (path) => path.split('/')[1],
  focusWorkTargetSoon: (side, key) => focus.push({ side, key })
}
for (const key of Object.keys(state)) {
  context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (update) => {
    state[key] = typeof update === 'function' ? update(state[key]) : update
    context[key] = state[key]
  }
}
const names = [
  'docSide', 'termSide', 'docKey', 'termKeyOf', 'parseWorkKey', 'isAgentTab',
  'termsForCaseTab', 'docsForCaseTab', 'caseTabRows', 'visibleCaseTabRows',
  'clearCaseDocumentUpdates', 'updateCaseTabActivity', 'activateDocTab', 'activateTermTab',
  'openFile', 'selectTerm', 'onTermStatus', 'openCaseTab', 'openNextCaseAttention', 'onDocumentChanged'
]
function render() {
  context.termStatusRef.current = state.termStatus
  const code = names.map((name) => {
    assert.ok(declarations.has(name), `find actual ${name} implementation`)
    return `const ${name} = ${declarations.get(name)};`
  }).join('\n') + `\nreturn { ${names.join(', ')} }`
  return vm.runInNewContext(ts.transpileModule(`(() => { ${code} })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}
const row = (id) => render().caseTabRows.find((item) => item.tab.id === id)

assert.equal(row('a').questionTaskCount, 2, 'active-case questions stay visible')
assert.equal(row('a').doneTaskCount, 1, 'hidden completed work in the active case stays unread')
assert.deepEqual(Array.from(render().visibleCaseTabRows, (item) => item.tab.id), ['a', 'b'])
render().openCaseTab(state.caseTabs[0])
assert.equal(row('a').questionTaskCount, 2, 'opening a case does not answer either pending question')
assert.ok(state.termAttention.has('a2'), 'opening the visible agent does not acknowledge the hidden agent')
assert.ok(state.termAttention.has('a3'), 'opening a case does not acknowledge a hidden completion')
assert.deepEqual(Array.from(state.caseDocumentUpdates.a.paths), ['/a/a-hidden.md'], 'only the visible document is acknowledged')
render().selectTerm('a2')
assert.equal(row('a').questionTaskCount, 2, 'reading a question does not resolve it')
assert.deepEqual(Array.from(state.caseDocumentUpdates.a.paths), ['/a/a-hidden.md'], 'selecting an agent does not acknowledge documents')
render().onTermStatus('a1', 'working')
render().onTermStatus('a2', 'idle')
assert.equal(row('a').questionTaskCount, 0, 'working and idle status transitions resolve pending questions')
render().onTermStatus('b1', 'idle')
assert.ok(state.termAttention.has('b1'), 'idle snapshots preserve unread completed work')
render().selectTerm('a3')
assert.equal(row('a').doneTaskCount, 0, 'viewed completion is acknowledged')

context.setTermStatus(new Map([['a1', 'question'], ['a2', 'question'], ['b1', 'question']]))
context.setTermAttention(new Set())
context.setCaseDocumentUpdates({})
context.caseAttentionOrderRef.current = []
for (let i = 0; i < 4; i++) render().openNextCaseAttention()
assert.deepEqual(focus.slice(-4).map(({ key }) => key), ['terminal:a1', 'terminal:a2', 'terminal:b1', 'terminal:a1'], 'next attention traverses agents and wraps across cases')
render().onTermStatus('a2', 'working')
render().openNextCaseAttention()
assert.equal(focus.at(-1).key, 'terminal:b1', 'resolved questions are skipped without restarting the cycle')

context.setTermStatus(new Map())
context.setTermAttention(new Set())
context.setCaseDocumentUpdates({ b: { paths: ['/b/new.md', '/b/other.md'], latestAt: 3 } })
render().openNextCaseAttention()
assert.equal(state.activeCaseTabId, 'b')
assert.equal(state.docTabs.find((doc) => doc.id === state.activeDoc).path, '/b/new.md', 'next attention opens an unopened updated document')
assert.deepEqual(Array.from(state.caseDocumentUpdates.b.paths), ['/b/other.md'], 'opening one update preserves the other update')

const change = (paths) => render().onDocumentChanged({ detail: { caseTabId: 'b', paths } })
change(['/b/new.md', '/b/hidden.md'])
assert.deepEqual(Array.from(state.caseDocumentUpdates.b.paths), ['/b/other.md', '/b/hidden.md'], 'active-case hidden document updates are tracked, visible updates are quiet')
context.setCaseDocumentUpdates({})
assert.equal(render().visibleCaseTabRows.length, 0, 'attention filter handles an empty queue')
const focusedBefore = focus.length
render().openNextCaseAttention()
assert.equal(focus.length, focusedBefore, 'empty queue does not navigate')
context.setCaseAttentionOnly(false)
assert.equal(render().visibleCaseTabRows.length, 3, 'turning off the filter restores all cases')
assert.match(source, /disabled=\{totalCaseNoticeCount === 0\}/)
assert.match(source, /type="checkbox" checked=\{caseAttentionOnly\}/)
console.log('case attention ok')
