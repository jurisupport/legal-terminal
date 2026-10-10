import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
const state = {
  inlineSelection: null,
  activeTerm: 'b1',
  activeCaseTabIdRef: { current: 'a' },
  termTabsRef: { current: [
    { id: 'a1', kind: 'agent', caseTabId: 'a', side: 'right', agentProvider: 'claude' },
    { id: 'a2', kind: 'agent', caseTabId: 'a', side: 'right', agentProvider: 'codex' },
    { id: 'b1', kind: 'agent', caseTabId: 'b', side: 'right' },
    { id: 'a-shell', kind: 'terminal', caseTabId: 'a', side: 'right' },
    { id: 'a-left', kind: 'agent', caseTabId: 'a', side: 'left' }
  ] },
  docTabsRef: { current: [{ id: 'doc', path: 'ssh://office/case-a/source.pdf', title: 'source.pdf', caseTabId: 'a', side: 'left' }] },
  caseTabsRef: { current: [
    { id: 'a', name: '원문 사건', drafts: 'ssh://office/case-a', ssh: { host: 'synthetic' }, profileId: 'office', remotePath: '/case-a' },
    { id: 'b', name: '다른 사건', drafts: '/case-b' }
  ] },
  sshProfiles: [{ id: 'office', host: 'synthetic' }]
}
const sent = [], work = [], created = [], alerts = []
let allow = true, confirmHook, rememberedTarget
const rememberedByPath = new Map()
const actions = new Map(['a1', 'a2'].map((id) => [id, { submit: async (request) => { sent.push({ id, request }); return { ok: true } } }]))
const context = {
  ...state, inlineActionsRef: { current: actions },
  rememberedAgentForDoc: (doc) => rememberedByPath.get(doc.path) ?? rememberedTarget,
  isAgentTab: (term) => term.kind === 'agent', caseIdForTerm: (term) => term.caseTabId, caseIdForDoc: (doc) => doc.caseTabId,
  termSide: (term) => term.side ?? 'right', docSide: (doc) => doc.side ?? 'left', otherSide: (side) => side === 'left' ? 'right' : 'left',
  currentCaseFromCaseTab: (tab) => tab, caseTabTitle: (tab) => tab.name,
  fileNameFromPath: (path) => path.split('/').at(-1), newId: () => 'popup', termKeyOf: (id) => `terminal:${id}`,
  setInlineSelection: (value) => { state.inlineSelection = typeof value === 'function' ? value(state.inlineSelection) : value; context.inlineSelection = state.inlineSelection },
  setActiveTerm: (value) => { state.activeTerm = value; context.activeTerm = value },
  setMountedTermIds: (update) => update(new Set()),
  setWorkActive: (side, key) => work.push({ side, key }),
  confirmCaseFileScope: async () => { confirmHook?.(); return allow },
  selectionAttachmentForAgent: (text, options, target) => ({ kind: 'selection', text, source: options.selectionSource, targetId: target.id }),
  createCase: (...args) => { created.push({ kind: 'local', args }); const term = { id: 'new-local', kind: 'agent', caseTabId: 'b', side: args[5] }; state.termTabsRef.current.push(term); return term },
  createRemoteCase: (...args) => { created.push({ kind: 'remote', args }); const term = { id: 'new-remote', kind: 'agent', caseTabId: 'a', side: args[5] }; state.termTabsRef.current.push(term); return term },
  window: { lt: { dialog: { alert: async (text) => alerts.push(text) } } }
}
const names = ['inlineTargetsForCase', 'createInlineAgent', 'openInlineSelection', 'changeInlineTarget', 'submitInlineSelection']
const implementation = names.map((name) => {
  assert.ok(declarations.has(name), name)
  return `const ${name} = ${declarations.get(name)};`
}).join('\n') + `\n;({${names.join(',')}})`
const api = runInNewContext(ts.transpileModule(implementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
assert.deepEqual(Array.from(api.inlineTargetsForCase('a', 'left'), (term) => term.id), ['a1', 'a2'], 'only same-case Agents on the receiving pane are offered')
const box = { text: '선택한 원문', x: 100, y: 200, bottom: 260, askOpts: { selectionSource: {
  docId: 'doc', docPath: 'ssh://office/case-a/source.pdf', range: { startPage: 12, endPage: 12 }
} } }
rememberedTarget = state.termTabsRef.current.find((term) => term.id === 'a2')
api.openInlineSelection(box)
assert.equal(state.inlineSelection.targetId, 'a2', 'document memory chooses its eligible panel before the active panel')
rememberedTarget = state.termTabsRef.current.find((term) => term.id === 'a-left')
api.openInlineSelection(box)
assert.equal(state.inlineSelection.targetId, 'a1', 'a remembered panel cannot hide the document by using its source pane')
rememberedTarget = undefined
api.openInlineSelection(box)
assert.equal(state.inlineSelection.targetId, 'a1', 'active Agent from another case cannot become the recipient')
context.activeTerm = 'a2'
state.docTabsRef.current[0].path = 'ssh://office/case-a/next.pdf'
state.docTabsRef.current[0].title = 'next.pdf'
rememberedByPath.set(box.askOpts.selectionSource.docPath, state.termTabsRef.current[0])
rememberedByPath.set(state.docTabsRef.current[0].path, state.termTabsRef.current[1])
api.openInlineSelection(box)
assert.equal(state.inlineSelection.targetId, 'a1', 'a moving record tab uses the captured source file’s remembered panel')
rememberedByPath.clear()
assert.equal((await api.submitInlineSelection('반박해줘')).ok, true)
assert.equal(sent[0].id, 'a1', 'changing the active Agent does not redirect the frozen recipient')
assert.equal(sent[0].request.attachment.source.docPath, box.askOpts.selectionSource.docPath)
assert.equal(sent[0].request.attachment.source.range.startPage, 12)
assert.equal(work.at(-1).side, 'right', 'sending never replaces the source viewer pane')
api.changeInlineTarget('b1')
assert.equal(state.inlineSelection.targetId, 'a1', 'foreign-case selector values are ignored')
api.changeInlineTarget('a2')
assert.equal((await api.submitInlineSelection('요약해줘')).ok, true)
assert.equal(sent.at(-1).id, 'a2', 'explicit same-case choice is used')
state.activeCaseTabIdRef.current = 'b'
assert.equal((await api.submitInlineSelection('보내지 마')).ok, false)
assert.equal(sent.length, 2)
state.activeCaseTabIdRef.current = 'a'
allow = false
assert.equal((await api.submitInlineSelection('취소 확인')).ok, false)
assert.equal(sent.length, 2)
allow = true
confirmHook = () => { state.termTabsRef.current = state.termTabsRef.current.filter((term) => term.id !== 'a2') }
assert.equal((await api.submitInlineSelection('대상 종료 확인')).ok, false, 'target closure during scope confirmation is rechecked')
assert.equal(sent.length, 2)
confirmHook = undefined
assert.equal((await api.submitInlineSelection('닫힌 세션')).ok, false, 'closed destination never falls back to another Agent')
api.changeInlineTarget('__new__')
assert.equal(state.inlineSelection.targetId, 'new-remote')
assert.equal(created[0].kind, 'remote')
assert.equal(created[0].args[0].id, 'office')
assert.equal(created[0].args[1], '/case-a')
assert.equal(created[0].args[5], 'right')
api.createInlineAgent('b', 'left')
assert.equal(created.at(-1).kind, 'local')
assert.equal(created.at(-1).args[0], '/case-b')
api.openInlineSelection(box)
assert.equal(state.inlineSelection.source.docTitle, 'source.pdf', 'a moving record tab cannot rename the frozen quote')
state.termTabsRef.current = state.termTabsRef.current.filter((term) => term.caseTabId !== 'a')
api.openInlineSelection(box)
assert.equal(state.inlineSelection.targetId, 'new-remote', 'opening without a same-case Agent creates one for the source case')
api.openInlineSelection({ ...box, askOpts: undefined })
assert.equal(alerts.length, 1, 'unsupported source must not inherit an unrelated current case')
assert.equal(state.inlineSelection.text, '선택한 원문')
console.log('inline selection routing: source and recipient freeze, case separation, closure, local/SSH creation passed')
