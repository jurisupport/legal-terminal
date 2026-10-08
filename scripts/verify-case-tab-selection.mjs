import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { closeTab } from '../src/renderer/src/tabSelection.ts'
import { resolveAgentContextKind } from '../src/shared/agentWorkspaceContext.ts'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const handlers = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    handlers.set(node.name.getText(parsed), node.initializer.getText(parsed))
  }
  ts.forEachChild(node, visit)
}
visit(parsed)
function loadHandlers(names, context = {}) {
  const source = names.map((name) => {
    assert.ok(handlers.has(name), `find the actual ${name} implementation`)
    return `const ${name} = ${handlers.get(name)};`
  }).join('\n') + `\n({ ${names.join(', ')} })`
  return vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
}
const caseHelpers = [
  'safeHash', 'normalizedCasePathKey', 'caseProfileKey', 'caseIdentityKey', 'caseTabId', 'findCaseTab',
  'caseTabFromCurrentCase', 'currentCaseFromCaseTab', 'upsertCaseTab', 'mergeCaseTabs'
]
const actual = loadHandlers(caseHelpers)
const folderCase = { drafts: '/drafts/홍길동', name: '홍길동' }
const linkedCase = { ...folderCase, meta: { jsId: 'case-1', caseNumber: '2026가단1' } }
const globalCase = { ...folderCase, meta: { contextKind: 'global' } }
assert.notEqual(actual.caseTabFromCurrentCase(globalCase).id, actual.caseTabFromCurrentCase(folderCase).id)
assert.equal(actual.upsertCaseTab([actual.caseTabFromCurrentCase(globalCase)], actual.caseTabFromCurrentCase(folderCase)).length, 2,
  'global work and a folder case using the same cwd must remain separate')
let resumed
const resumeHandlers = loadHandlers(['currentCaseFromTerm', 'openPastSession'], {
  currentCase: linkedCase,
  termTabs: [{ id: 'wrong-existing', kind: 'agent', cwd: folderCase.drafts, resumeSessionId: 'same-session', jsId: 'case-1', caseNumber: '2026가단1' }],
  resolveAgentContextKind,
  termSide: () => 'right', isAgentTab: (term) => term.kind === 'agent',
  selectTerm: () => assert.fail('must not reuse another scope'), newId: () => 'resumed',
  resolveCaseTabId: () => 'scope-tab', currentCaseTabIdForNewTab: () => 'scope-tab',
  setTermTabs: (update) => { resumed = update([])[0] }, setActiveTerm: () => {},
  setWorkActive: () => {}, termKeyOf: (id) => id, registerCaseTabFromTerm: () => {}, preloadPastSessions: () => {}
})
resumeHandlers.openPastSession('same-session', folderCase.drafts, '전체 정리', {
  id: 'global-source', cwd: folderCase.drafts, title: '전체 정리', contextKind: 'global'
})
assert.equal(resumed.contextKind, 'global', 'resume keeps the chosen source scope')
assert.equal(resumed.jsId, undefined, 'same-cwd current case cannot overwrite global source')
const folderTab = actual.caseTabFromCurrentCase(folderCase)
const linkedTab = actual.caseTabFromCurrentCase(linkedCase)
assert.notEqual(folderTab.id, linkedTab.id, 'reproduce the legacy folder/dashboard identity mismatch')
for (const [existing, incoming] of [[folderTab, linkedTab], [linkedTab, folderTab]]) {
  const tabs = actual.upsertCaseTab([{ ...existing, activeDocId: 'draft', activeTermId: 'agent' }], incoming)
  assert.equal(tabs.length, 1, 'reopening the same folder with or without case metadata must reuse its tab')
  assert.equal(tabs[0].id, existing.id, 'keep the ID referenced by existing documents and agents')
  assert.equal(tabs[0].meta.jsId, 'case-1')
  assert.equal(tabs[0].activeDocId, 'draft')
  assert.equal(tabs[0].activeTermId, 'agent')
}
for (const source of [
  { ...folderCase, drafts: `${folderCase.drafts.normalize('NFD')}/` },
  { ...folderCase, meta: { jsId: undefined } },
  { ...linkedCase, drafts: '/renamed-folder' },
  { ...linkedCase, drafts: '' }
]) {
  const tabs = actual.upsertCaseTab([linkedTab], actual.caseTabFromCurrentCase(source))
  assert.equal(tabs.length, 1, 'path spelling and late case details must not duplicate a tab')
  assert.equal(tabs[0].meta.jsId, 'case-1')
}
for (const source of [
  { ...folderCase, drafts: '/drafts/other' },
  { ...linkedCase, meta: { jsId: 'case-2' } },
  { ...linkedCase, profileId: 'ssh-1', ssh: { host: 'remote' }, remotePath: folderCase.drafts }
]) {
  assert.equal(actual.upsertCaseTab([linkedTab], actual.caseTabFromCurrentCase(source)).length, 2,
    'different folders, linked cases, and local/remote workspaces must stay separate')
}
const remoteSource = { ...folderCase, profileId: 'ssh-1', ssh: { host: 'remote' }, remotePath: folderCase.drafts }
const remoteTab = actual.caseTabFromCurrentCase(remoteSource)
assert.equal(actual.upsertCaseTab([remoteTab], actual.caseTabFromCurrentCase({
  ...remoteSource, meta: linkedCase.meta
})).length, 1, 'remote folder and dashboard entry points must reuse a tab')
assert.equal(actual.upsertCaseTab([remoteTab], actual.caseTabFromCurrentCase({
  ...remoteSource, profileId: 'ssh-2'
})).length, 2, 'different SSH profiles must stay separate')

// Model two opens before React applies its queued state updates.
const queued = []
const registry = { caseTabsRef: { current: [] }, activeId: '' }
const registration = loadHandlers([...caseHelpers, 'resolveCaseTabId', 'registerCaseTab'], {
  caseTabsRef: registry.caseTabsRef,
  setCaseTabs: (update) => queued.push(update),
  setActiveCaseTabId: (id) => { registry.activeId = id }
})
const firstOpen = registration.registerCaseTab(folderCase)
const secondOpen = registration.registerCaseTab(linkedCase)
const registered = queued.reduce((tabs, update) => update(tabs), [])
assert.equal(registered.length, 1, 'back-to-back opening requests must not duplicate a tab')
assert.equal(secondOpen.id, firstOpen.id)
assert.equal(registry.activeId, registered[0].id, 'activate the surviving tab')
const moved = registration.registerCaseTab({ ...linkedCase, drafts: '/moved-case' })
const unrelated = registration.registerCaseTab(folderCase)
assert.notEqual(unrelated.id, moved.id, 'a reused old folder must not collide with a moved case ID')
assert.equal(registry.caseTabsRef.current.length, 2)
assert.equal(registry.caseTabsRef.current.find((tab) => tab.id === moved.id).drafts, '/moved-case')
assert.equal(actual.upsertCaseTab([{ ...linkedTab, id: folderTab.id, drafts: '/moved-case' }], folderTab).length,
  2, 'restore-generated IDs must not overwrite a moved case either')

const noop = () => {}
const movedSource = { ...linkedCase, drafts: '/moved-case' }
const movedTab = { ...linkedTab, id: folderTab.id, drafts: movedSource.drafts }
for (const [existingTab, savedCaseTabs, savedSource, canonicalId, caseCount] of [
  [undefined, [folderTab, linkedTab], linkedCase, folderTab.id, 1],
  [folderTab, [folderTab, linkedTab], linkedCase, folderTab.id, 1],
  [linkedTab, [folderTab, linkedTab], linkedCase, linkedTab.id, 1],
  [movedTab, [folderTab], folderCase, `${folderTab.id}-1`, 2],
  [folderTab, [movedTab], movedSource, linkedTab.id, 2]
]) {
  const state = {
    caseTabs: existingTab ? [existingTab] : [],
    termTabs: existingTab ? [{ id: 'live-agent', caseTabId: existingTab.id, cwd: existingTab.drafts, jsId: existingTab.meta?.jsId }] : [],
    docTabs: existingTab ? [{ id: 'live-draft', caseTabId: existingTab.id, kind: 'markdown', path: `${existingTab.drafts}/live.md` }] : [],
    activeCaseTabId: existingTab?.id ?? '', activeDoc: '', activeTerm: '', activeWork: {}
  }
  const context = { sshProfiles: [], ...state, currentCase: null }
  for (const name of ['caseTabs', 'termTabs', 'docTabs']) context[`${name}Ref`] = { current: state[name] }
  for (const name of ['caseTabs', 'termTabs', 'docTabs', 'activeCaseTabId', 'activeDoc', 'activeTerm', 'activeWork']) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = (update) => {
      state[name] = typeof update === 'function' ? update(state[name]) : update
      if (context[`${name}Ref`]) context[`${name}Ref`].current = state[name]
    }
  }
  Object.assign(context, {
    RESTORABLE_DOC_KINDS: new Set(['markdown', 'pdf', 'settings']),
    normalizeDocKind: (kind) => kind,
    resolveAgentProvider: (provider) => provider ?? 'claude',
    remoteUri: (profile, path) => `ssh://${profile}${path}`,
    isAgentTab: () => false, isWorkspaceMode: () => false,
    docKey: (id) => `doc:${id}`, termKeyOf: (id) => `terminal:${id}`,
    docSide: (tab) => tab.side ?? 'left', termSide: (tab) => tab.side ?? 'right',
    isWorkKey: (key) => /^(doc|terminal):/.test(key ?? ''),
    setCurrentCase: noop, preloadPastSessions: noop, currentCaseSessionSource: noop, setTreeRefresh: noop
  })
  const restore = loadHandlers([
    ...caseHelpers, 'resolveCaseTabId', 'sanitizeCurrentCase', 'sanitizeCaseWorkspaceTab',
    'currentCaseFromTerm', 'sanitizeWorkspaceTerm', 'toDocTab',
    'pathMatchesCasePrefix', 'caseTabPathPrefixes', 'inferCaseTabIdForPath',
    'caseIdForTerm', 'isSharedDocTab', 'restoreWorkspaceSnapshot'
  ], context)
  const activeSavedIndex = savedCaseTabs.length - 1
  const snapshot = {
    caseTabs: savedCaseTabs, currentCase: savedSource, activeCaseTabId: savedCaseTabs.at(-1).id,
    docs: savedCaseTabs.map((tab, i) => ({
      id: `saved-draft-${i}`, title: '준비서면', kind: 'markdown', caseTabId: tab.id,
      path: `${savedSource.drafts}/saved.md`
    })),
    terminals: savedCaseTabs.map((tab, i) => ({
      id: `saved-agent-${i}`, kind: 'agent', caseTabId: tab.id, cwd: tab.drafts, jsId: tab.meta?.jsId
    })),
    activeDoc: `saved-draft-${activeSavedIndex}`, activeTerm: `saved-agent-${activeSavedIndex}`,
    activeWork: { left: `doc:saved-draft-${activeSavedIndex}`, right: `terminal:saved-agent-${activeSavedIndex}` }
  }
  restore.restoreWorkspaceSnapshot(snapshot)
  assert.equal(state.caseTabs.length, caseCount, 'restore merges duplicate cases and preserves distinct cases')
  assert.ok(state.caseTabs.some((tab) => tab.id === canonicalId))
  assert.equal(state.activeCaseTabId, canonicalId)
  assert.equal(state.docTabs.length, existingTab ? 2 : 1, 'restore the same document only once')
  const termCount = savedCaseTabs.length + (existingTab ? 1 : 0)
  assert.equal(state.termTabs.length, termCount, 'keep every distinct live and saved agent')
  for (const tab of [...state.docTabs, ...state.termTabs]) {
    assert.equal(tab.caseTabId, tab.id.startsWith('live-') ? existingTab.id : canonicalId,
      'restored aliases must not move existing work into a different case')
  }
  assert.equal(state.activeDoc, 'saved-draft-0')
  assert.equal(state.activeWork.left, 'doc:saved-draft-0', 'show the remapped active document')
  assert.equal(state.activeTerm, `saved-agent-${activeSavedIndex}`)
  restore.restoreWorkspaceSnapshot(snapshot)
  assert.equal(state.caseTabs.length, caseCount, 'repeated restore must remain idempotent')
  assert.equal(state.docTabs.length, existingTab ? 2 : 1)
  assert.equal(state.termTabs.length, termCount)
}
assert.match(
  app,
  /caseTabIdOverride \?\? currentCaseTabIdForNewTab\(\) \?\? inferCaseTabIdForPath\(path, caseTabs\)/,
  'opening a file must stay in the current case before considering a nested case path'
)

const caseTabSubtitle = app.match(/const caseTabSubtitle[\s\S]*?\n    \]\)/)?.[0] ?? ''
assert.match(caseTabSubtitle, /tab\.remotePath \?\? tab\.drafts/, 'case tabs must expose the full case path')
assert.doesNotMatch(caseTabSubtitle, /pathLeaf\(/, 'case tabs must not reduce the case path to its last folder')

const oldCaseAgent = { id: 'old-case-agent' }
const newCaseAgent = { id: 'new-case-agent' }
let active = newCaseAgent.id

const remaining = closeTab(
  [oldCaseAgent, newCaseAgent],
  newCaseAgent.id,
  active,
  (id) => {
    active = id
  },
  [newCaseAgent]
)

assert.deepEqual(remaining, [oldCaseAgent])
assert.equal(active, '', 'closing the last agent must not activate an agent from another case')

const first = { id: 'first' }
const middle = { id: 'middle' }
const last = { id: 'last' }
active = middle.id
closeTab(
  [first, middle, last],
  middle.id,
  active,
  (id) => {
    active = id
  },
  [first, middle, last]
)
assert.equal(active, last.id, 'closing an agent must still activate its same-case neighbor')

for (const scenario of ['active', 'active-middle', 'active-end', 'empty-neighbor', 'last', 'background', 'cancel-dirty', 'cancel-working', 'switch-during-save', 'remove-neighbor-during-save',
  'remote-idle', 'remote-dirty', 'remote-working', 'remote-question', 'remote-draft', 'remote-attachment']) {
  const fromSync = scenario.startsWith('remote-')
  const closing = { id: 'closing', drafts: '/closing', name: '닫을 사건' }
  const other = { id: 'other', drafts: '/other', name: '다른 사건', activeDocId: 'other-draft', activeTermId: 'other-agent', activeWork: { left: 'doc:other-draft', right: 'terminal:other-agent' } }
  const before = { id: 'before', drafts: '/before', name: '이전 사건' }
  const state = {
    caseTabs: scenario === 'last' ? [closing]
      : scenario === 'active-middle' ? [before, closing, other]
      : scenario === 'active-end' ? [other, closing]
      : scenario === 'remove-neighbor-during-save' ? [closing, before, other]
      : [closing, other],
    docTabs: [
      { id: 'doc-welcome', title: '시작하기.md', kind: 'welcome', side: 'left' },
      { id: 'draft', caseTabId: closing.id }
    ],
    termTabs: [{ id: 'agent', caseTabId: closing.id, kind: 'agent' }],
    dirtyDocs: new Set(['cancel-dirty', 'remote-dirty'].includes(scenario) ? ['draft'] : []),
    termStatus: new Map(['cancel-working', 'remote-working'].includes(scenario) ? [['agent', 'working']]
      : scenario === 'remote-question' ? [['agent', 'question']] : []),
    activeCaseTabId: scenario === 'background' ? other.id : closing.id,
    activeDoc: 'draft', activeTerm: 'agent', activeWork: { left: 'doc:draft', right: 'terminal:agent' },
    currentCase: closing, folderRecord: {}, pdfRecord: {},
    newCaseOpen: false, mode: 'viewer',
    pdfStatus: {}, agentAttachmentRequests: {}, agentDrafts: {}, agentDraftClearNonce: {},
    termAttention: new Set(), termBracketedPasteMode: {}, caseTabContextMenu: {}, termFocusNonce: {}
  }
  if (scenario === 'remote-draft') state.agentDrafts.agent = { input: '작성 중인 질문', attachments: [] }
  if (scenario === 'remote-attachment') state.agentAttachmentRequests.agent = [{}]
  if (scenario !== 'last' && scenario !== 'empty-neighbor') {
    state.docTabs.push({ id: 'other-first-draft', caseTabId: other.id })
    state.termTabs.push({ id: 'other-first-agent', caseTabId: other.id, kind: 'agent' })
    state.docTabs.push({ id: 'other-draft', caseTabId: other.id })
    state.termTabs.push({ id: 'other-agent', caseTabId: other.id, kind: 'agent' })
  }
  const closedAgents = []
  const savedSnapshots = []
  const context = { ...state, docOnly: false, termOnly: false, inlineSelection: null }
  for (const [key, value] of Object.entries(state)) {
    context[`${key}Ref`] = { current: value }
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (update) => {
      state[key] = typeof update === 'function' ? update(state[key]) : update
      context[key] = state[key]
      context[`${key}Ref`].current = state[key]
    }
  }
  Object.assign(context, {
    window: { lt: {
      dialog: { confirm: async () => false },
      agent: { close: (id) => { closedAgents.push(id) } },
      workspace: { autoSave: async (snapshot) => { savedSnapshots.push(snapshot); return { ok: true } } },
      app: { dismissNotify: noop }
    } },
    caseIdForDoc: (doc) => doc.caseTabId, caseIdForTerm: (term) => term.caseTabId,
    isAgentTab: (term) => term.kind === 'agent',
    currentCaseFromCaseTab: actual.currentCaseFromCaseTab,
    upsertCaseTab: actual.upsertCaseTab,
    sshProfiles: [], currentCaseSessionSource: noop, preloadPastSessions: noop,
    dismissToastForTerm: noop, clearCaseDocumentUpdates: noop,
    workspaceLocationKey: (source) => source.drafts,
    workspaceLocation: (source) => ({ cwd: source.drafts }),
    autoSaveEligibleRef: { current: new Set() }, autoRestoreDoneRef: { current: new Set() },
    closedAutomaticCasesRef: { current: new Set() },
    pendingCaseClosesRef: { current: new Map() },
    pendingWorkspaceReopensRef: { current: new Map() },
    autoWorkspaceSaveChainRef: { current: Promise.resolve() }, setWorkspaceSyncError: noop,
    setRetainedSharedCases: noop,
    newId: () => 'close-request',
    buildWorkspaceSnapshot: async () => {
      if (scenario === 'switch-during-save') context.setActiveCaseTabId(other.id)
      if (scenario === 'remove-neighbor-during-save') context.setCaseTabs((tabs) => tabs.filter((tab) => tab.id !== before.id))
      return { version: 1, savedAt: new Date().toISOString(), docs: [], terminals: [] }
    }
  })
  const closingHandlers = loadHandlers([
    'isSharedDocTab', 'visibleInActiveCase', 'isDocVisibleInActiveCase',
    'docSide', 'termSide', 'docKey', 'termKeyOf', 'workKeysForSide', 'resolveActiveWorkKey',
    'parseWorkKey', 'isWorkKey', 'bumpFocusNonce', 'updateCaseTabActivity',
    'termsForCaseTab', 'docsForCaseTab', 'openCaseTab',
    'openNewCaseLauncher', 'hasAgentDraft', 'hasLocalTermWork', 'closeCaseTab'
  ], context)
  await closingHandlers.closeCaseTab(closing.id, fromSync)
  await context.autoWorkspaceSaveChainRef.current
  const cancelled = scenario.startsWith('cancel-') || (fromSync && scenario !== 'remote-idle')
  assert.equal(savedSnapshots.length, fromSync || cancelled ? 0 : 1,
    `${scenario}: applying a remote close must not publish a fresh local close`)
  const closesActiveCase = !cancelled && scenario !== 'background' && scenario !== 'switch-during-save'
  const visibleDocs = state.docTabs.filter(closingHandlers.isDocVisibleInActiveCase)
  const activeLeftKey = closingHandlers.resolveActiveWorkKey(
    closingHandlers.workKeysForSide(visibleDocs, [], 'left'), state.activeWork.left
  )
  assert.notEqual(activeLeftKey, 'doc:doc-welcome', `${scenario}: closing a case must not reveal the startup screen`)
  assert.equal(state.newCaseOpen, false, `${scenario}: closing a case must not open the new-case launcher`)
  assert.equal(state.caseTabs.some((tab) => tab.id === closing.id), cancelled)
  assert.deepEqual(closedAgents, cancelled ? [] : ['agent'])
  assert.equal(state.docTabs.some((tab) => tab.id === 'draft'), cancelled)
  if (scenario !== 'last') {
    assert.ok(state.caseTabs.some((tab) => tab.id === other.id))
    if (scenario !== 'empty-neighbor') {
      assert.ok(state.docTabs.some((tab) => tab.id === 'other-draft'))
      assert.ok(state.termTabs.some((tab) => tab.id === 'other-agent'))
    }
  }
  if (closesActiveCase) {
    const hasNeighbor = scenario !== 'last'
    const hasWork = hasNeighbor && scenario !== 'empty-neighbor'
    assert.equal(state.activeCaseTabId, hasNeighbor ? other.id : '', `${scenario}: activate the surviving neighbor`)
    assert.equal(state.currentCase?.drafts ?? null, hasNeighbor ? other.drafts : null)
    assert.equal(activeLeftKey, hasWork ? 'doc:other-draft' : '')
    assert.equal(state.activeDoc, hasWork ? 'other-draft' : '')
    assert.equal(state.activeTerm, hasWork ? 'other-agent' : '')
    assert.equal(state.activeWork.right, hasWork ? 'terminal:other-agent' : '')
    assert.equal(state.folderRecord, null)
    assert.equal(state.pdfRecord, null)
    assert.equal(state.mode, 'explorer')
    assert.equal(closingHandlers.visibleInActiveCase(other.id), hasNeighbor)
    assert.equal(closingHandlers.visibleInActiveCase(undefined), !hasNeighbor)
  } else {
    assert.ok(state.docTabs.some((tab) => tab.kind === 'welcome'), 'background or cancelled closes preserve the startup tab')
    assert.equal(state.activeCaseTabId, cancelled ? closing.id : other.id)
  }
  closingHandlers.openNewCaseLauncher()
  assert.equal(state.newCaseOpen, true, 'explicitly adding a new case must still open the launcher')
}

for (const detached of ['docOnly', 'termOnly']) {
  const { visibleInActiveCase } = loadHandlers(['visibleInActiveCase'], {
    docOnly: false, termOnly: false, [detached]: true, activeCaseTabId: ''
  })
  assert.equal(visibleInActiveCase('other'), true, `${detached}: detached work remains visible`)
}

console.log('case tab selection ok')
