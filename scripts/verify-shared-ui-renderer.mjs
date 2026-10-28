import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let apply
let backgroundTick
const handlers = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    handlers.set(node.name.getText(parsed), node.initializer.getText(parsed))
    if (node.name.getText(parsed) === 'applySharedUi') apply = node.initializer.getText(parsed)
  }
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'window.setInterval' &&
      node.arguments[0]?.getText(parsed).includes('sharedUiRefreshRef.current')) backgroundTick = node.arguments[0].getText(parsed)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.ok(apply)
const tab = { id: 'case', profileId: 'desktop', ssh: { host: 'office' }, drafts: 'ssh://desktop/cases/a', remotePath: '/cases/a' }
const doc = { id: 'dirty', caseTabId: 'case', path: 'ssh://desktop/cases/a/dirty.md', side: 'left' }
const context = {
  workspaceHostKey: ssh => ssh.host,
  caseTabsRef: { current: [tab] }, docTabsRef: { current: [doc] }, dirtyDocsRef: { current: new Set(['dirty']) },
  termTabsRef: { current: [{ id: 'agent', caseTabId: 'case', side: 'right' }] },
  sharedUiActivitiesRef: { current: new Map() }, sharedUiRunsRef: { current: new Map() },
  sharedUiOpenAgentsRef: { current: new Map() }, sharedUiActivityId: term => term.kind === 'terminal' ? `terminal:${term.id}` : term.id,
  observedSharedUiHostsRef: { current: new Set() }, notifyDone: true, notificationSound: '', notificationVolume: 0,
  sharedUiSeenSelectionsRef: { current: new Map() }, sharedUiPendingSelectionsRef: { current: new Map() },
  isTermVisibleInCurrentWorkspace: () => false, pushToast: (id, status) => context.notices.push([id, status]), notices: [],
  playNotificationSound: () => {}, dismissToastForTerm: () => {}, window: { lt: { app: { requestAttention: () => {}, notify: () => {}, dismissNotify: () => {} } } },
  sharedUiCaseKey: () => '["/cases/a",""]', caseIdForDoc: item => item.caseTabId, caseIdForTerm: item => item.caseTabId,
  sharedUiDocumentPath: path => path?.replace('ssh://desktop', ''), remoteUri: (id, path) => `ssh://${id}${path}`,
  newId: () => 'new-doc', fileNameFromPath: path => path.split('/').at(-1), docKindForPath: () => 'markdown',
  setDocTabs: docs => { context.docTabsRef.current = docs }, setSharedUiActivities: () => {},
  setTermStatus: update => { context.status = update(context.status ?? new Map()) },
  setTermAttention: update => { context.attention = update(context.attention ?? new Set()) },
  closeDoc: id => { context.closed.push(id) }, closed: [],
  activeCaseTabIdRef: { current: 'other' }, activeWorkRef: { current: {} }, unloadedSharedCasesRef: { current: new Set() },
  document: { activeElement: null, hasFocus: () => true }, docKey: id => `doc:${id}`, termKeyOf: id => `terminal:${id}`,
  docSide: item => item.side, termSide: item => item.side,
  openCaseTab: (...args) => { context.selected = args }
}
const fn = vm.runInNewContext(ts.transpileModule(`(${apply})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
const state = { selection: { caseKey: '["/cases/a",""]', tab: { kind: 'document', id: '/cases/a/new.md' } }, cases: {
  '["/cases/a",""]': { documents: { '/cases/a/dirty.md': false, '/cases/a/new.md': true }, activity: {
    agent: { runId: 'run', sequence: 2, status: 'done', attention: true }
  } }
} }
fn({ host: 'office' }, state)
assert.deepEqual(context.closed, [], 'a remote close must not discard a dirty document')
assert.equal(context.docTabsRef.current.at(-1).path, 'ssh://desktop/cases/a/new.md', 'remote paths use this device profile')
assert.equal(context.status.get('agent'), 'done')
assert.ok(context.attention.has('agent'))
assert.equal(context.notices.length, 0, 'initial sync must not notify for historical activity')
assert.equal(context.selected, undefined, 'remote selection waits while a dirty document exists')
context.dirtyDocsRef.current.clear()
fn({ host: 'office' }, state)
assert.deepEqual(context.closed, ['dirty'])
assert.equal(context.selected[0].id, 'case')
assert.equal(context.selected[1].key, 'doc:new-doc')
assert.equal(context.selected[2], true, 'applying remote selection must not republish it')
context.selected = undefined
context.activeCaseTabIdRef.current = 'other'
fn({ host: 'office' }, state)
assert.equal(context.selected, undefined, 'an unchanged selection does not reactivate a case later')
context.sharedUiPendingSelectionsRef.current.set('office', JSON.stringify(state.selection))
context.document.activeElement = { closest: () => true }
fn({ host: 'office' }, state)
assert.equal(context.selected, undefined, 'remote selection waits while editing')
state.cases['["/cases/a",""]'].activity = { agent: { runId: 'next', sequence: 1, status: 'working', attention: false } }
fn({ host: 'office' }, state)
state.cases['["/cases/a",""]'].activity = { agent: { runId: 'next', sequence: 2, status: 'done', attention: true } }
fn({ host: 'office' }, state)
fn({ host: 'office' }, state)
assert.equal(context.notices.length, 1, 'a new remote completion notifies once')
let dismissed = 0
context.dismissToastForTerm = () => dismissed++
state.cases['["/cases/a",""]'].activity = { agent: { runId: 'next', sequence: 2, status: 'done', attention: false } }
fn({ host: 'office' }, state)
assert.equal(dismissed, 1, 'an acknowledgment on another device dismisses the old notice')
context.sharedUiOpenAgentsRef.current.set('case', new Set())
context.termTabsRef.current = []
fn({ host: 'office' }, state)
assert.equal(context.sharedUiActivitiesRef.current.get('case').agent, undefined, 'a closed agent cannot leave a ghost activity')
const closingCalls = []
const closingContext = {
  docTabsRef: { current: [{ id: 'old', caseTabId: 'case', path: 'ssh://desktop/cases/a/old.md', side: 'left' },
    { id: 'next', caseTabId: 'case', path: 'ssh://desktop/cases/a/next.md', side: 'left' }] },
  dirtyDocsRef: { current: new Set() }, termTabsRef: { current: [] }, activeWork: { left: 'doc:old', right: '' },
  activeDoc: 'old', visibleDocTabs: [], visibleTermTabs: [],
  sharedUiCase: () => tab, caseIdForDoc: d => d.caseTabId, sharedUiDocumentPath: path => path.replace('ssh://desktop', ''),
  shareDocument: (_, open) => closingCalls.push(['document', open]), shareSelection: (_, selected) => closingCalls.push(['selection', selected]),
  docSide: d => d.side, docKey: id => `doc:${id}`, otherSide: () => 'right', isAgentTab: () => false,
  parseWorkKey: key => key ? { kind: 'doc', id: key.slice(4) } : null,
  workKeysForSide: () => ['doc:old', 'doc:next'], resolveActiveWorkKey: (_, key) => key,
  nextWorkKeyAfterClose: () => 'doc:next', setDirtyDocs: () => {}, setPdfStatus: () => {},
  setDocTabs: () => {}, closeTab: () => [], setActiveDoc: () => {}, activateWorkKeyAfterClose: () => {}
}
const close = vm.runInNewContext(ts.transpileModule(`(${handlers.get('closeDoc')})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, closingContext)
await close('old')
assert.equal(closingCalls[0][1], false)
assert.equal(closingCalls[1][1].id, '/cases/a/next.md', 'closing the selected document publishes the fallback')
closingCalls.length = 0
await close('old', { fromSync: true })
assert.equal(closingCalls.length, 0, 'a remote close does not echo local changes')
const sent = []
const runtime = {
  termTabsRef: { current: [{ id: 'agent', caseTabId: 'case', kind: 'agent' }] },
  termTabs: [{ id: 'agent', title: 'Task' }], termStatusRef: { current: new Map() },
  sharedUiActivitiesRef: { current: new Map([['case', { agent: { runId: 'previous', sequence: 9, status: 'done', attention: false } }]]) },
  sharedUiRunsRef: { current: new Map() }, sharedUiSendRef: { current: (_, op) => sent.push(op) },
  sharedUiCase: () => tab, sharedUiCaseKey: () => 'case-key', caseIdForTerm: t => t.caseTabId,
  isAgentTab: t => t.kind === 'agent', newId: (() => { let id = 0; return () => `id-${++id}` })(),
  sharedUiActivityId: term => term.kind === 'agent' ? term.id : `terminal:${term.id}`,
  isTermVisibleInCurrentWorkspace: () => false, document: { hasFocus: () => true },
  setTermStatus: () => {}, setTermAttention: () => {}, dismissToastForTerm: () => {}, pushToast: () => {},
  playNotificationSound: () => {}, notificationSound: '', notificationVolume: 0, notifyDone: true,
  window: { lt: { app: { dismissNotify: () => {}, requestAttention: () => {}, notify: () => {} } } }
}
const code = ['onTermStatus', 'shareAcknowledgement'].map(name => `const ${name} = ${handlers.get(name)};`).join('\n') + '\n({ onTermStatus, shareAcknowledgement })'
const event = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, runtime)
event.onTermStatus('agent', 'working')
event.onTermStatus('agent', 'done')
assert.equal(sent[0].start, true)
assert.equal(sent[0].expectedRunId, 'previous', 'new runs compare against the observed run')
assert.equal(sent[1].runId, sent[0].runId)
assert.equal(sent[1].sequence, 2)
event.shareAcknowledgement('agent')
assert.equal(sent[2].type, 'ack')
assert.equal(sent[2].runId, sent[1].runId)
assert.equal(sent[2].sequence, sent[1].sequence, 'acknowledgments target the exact activity')
runtime.termTabsRef.current.push({ id: 'shell', caseTabId: 'case', kind: 'terminal' })
event.onTermStatus('shell', 'working')
assert.equal(sent.at(-1).agentId, 'terminal:shell', 'terminal work uses a distinct shared identity')
const bootSent = []
const boot = {
  workspaceHostKey: ssh => ssh.host, caseTabsRef: { current: [tab] }, docTabsRef: { current: [doc,
    { id: 'new', caseTabId: 'case', path: 'ssh://desktop/cases/a/existing.md' }] },
  termTabsRef: { current: [] }, activeCaseTabIdRef: { current: 'case' },
  activeWorkRef: { current: { left: 'doc:new', right: '' } }, focusedWorkSide: () => 'left',
  sharedUiCaseKey: () => 'case-key', caseIdForDoc: item => item.caseTabId,
  sharedUiDocumentPath: path => path?.replace('ssh://desktop', ''),
  parseWorkKey: key => key.startsWith('doc:') ? { kind: 'doc', id: key.slice(4) } : null,
  isAgentTab: () => false, newId: (() => { let n = 0; return () => `boot-${++n}` })(),
  sharedUiSendRef: { current: (_, operation) => bootSent.push(operation) }
}
const bootstrap = vm.runInNewContext(ts.transpileModule(`(${handlers.get('bootstrapSharedUi')})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, boot)
bootstrap({ host: 'office' }, { selection: { caseKey: null }, cases: {
  'case-key': { documents: { '/cases/a/dirty.md': false } }
} })
assert.equal(bootSent.length, 2)
assert.equal(bootSent[0].path, '/cases/a/existing.md')
assert.equal(bootSent[0].onlyIfMissing, true, 'bootstrap never replaces an existing close')
assert.equal(bootSent[1].onlyIfUnset, true, 'bootstrap cannot overwrite a concurrent selection')
assert.ok(backgroundTick)
let backgroundReads = 0, foregroundReads = 0
const tick = vm.runInNewContext(ts.transpileModule(`(${backgroundTick})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  document: { hasFocus: () => false }, refresh: () => foregroundReads++,
  sharedUiRefreshRef: { current: async () => { backgroundReads++ } }, setWorkspaceSyncError: () => {}
})
tick()
assert.equal(backgroundReads, 1, 'background windows still check remote completion')
assert.equal(foregroundReads, 0, 'background check avoids full workspace refresh')
console.log('shared UI renderer: remote documents, dirty protection, selection and activity OK')
