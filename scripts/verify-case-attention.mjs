import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { orderCaseTabs, recentSidebarTasks } from '../src/renderer/src/sidebarNavigation.ts'
import { matchesSearch } from '../src/renderer/src/search/sessionSearch.ts'

const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
const sidebarSource = readFileSync(new URL('../src/renderer/src/CaseSidebar.tsx', import.meta.url), 'utf8')
const sidebarParsed = ts.createSourceFile('CaseSidebar.tsx', sidebarSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const sidebarDeclarations = new Map()
let moreCasesOnClick
function visitSidebar(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) sidebarDeclarations.set(node.name.getText(sidebarParsed), node.initializer.getText(sidebarParsed))
  if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(sidebarParsed) === 'className' && attribute.initializer?.text === 'case-sidebar-more-cases')) {
    moreCasesOnClick = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sidebarParsed) === 'onClick')?.initializer?.expression?.getText(sidebarParsed)
  }
  ts.forEachChild(node, visitSidebar)
}
visitSidebar(sidebarParsed)
assert.ok(sidebarDeclarations.has('orderedCases'), 'find actual sidebar attention filter')
assert.ok(sidebarDeclarations.has('count') && moreCasesOnClick, 'find actual sidebar pagination')

const noop = () => {}
const state = {
  caseTabs: ['a', 'b', 'empty'].map((id) => ({ id, drafts: `/${id}`, activeTermId: `${id}1`, activeDocId: `${id}-visible`, activeWork: { left: `doc:${id}-visible`, right: `terminal:${id}1` } })),
  termTabs: ['a1', 'a2', 'a3', 'b1'].map((id) => ({ id, title: id, kind: 'agent', caseTabId: id[0] })),
  docTabs: ['a-visible', 'a-hidden', 'b-visible'].map((id) => ({ id, path: `/${id[0]}/${id}.md`, caseTabId: id[0], kind: 'markdown' })),
  activeCaseTabId: 'a', activeTerm: 'a1', activeDoc: 'a-visible',
  activeWork: { left: 'doc:a-visible', right: 'terminal:a1' },
  termStatus: new Map([['a1', 'question'], ['a2', 'question'], ['a3', 'done'], ['b1', 'done']]),
  termAttention: new Set(['a1', 'a2', 'a3', 'b1']),
  caseAttentionOnly: true, termFocusNonce: {}, mode: 'explorer'
}
const focus = []
const context = {
  ...state, orderCaseTabs, caseOrder: [],
  docOnly: false, termOnly: false, documentAgentTabs: {},
  activeCaseTabIdRef: { current: state.activeCaseTabId }, unloadedSharedCasesRef: { current: new Set() },
  autoRestoreWorkspaceRef: { current: async () => {} },
  savedCaseLabels: [], caseTabSubtitle: (tab) => tab.drafts, sessionListKey: (path) => path, sessionContextForTerm: noop,
  joinStatus: (parts) => parts.filter(Boolean).join(' · '),
  caseAttentionOrderRef: { current: [] }, termStatusRef: { current: state.termStatus }, sshProfiles: [],
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
  notificationTitle: (term) => term.title, notificationBody: () => '작업이 완료되었습니다',
  sharedUiCase: noop, sharedUiDocumentPath: noop, shareSelection: noop, shareAcknowledgement: noop,
  sharedUiActivities: new Map(), sharedUiActivitiesRef: { current: new Map() }, sharedUiRunsRef: { current: new Map() },
  sharedUiSendRef: { current: noop }, sharedUiCaseKey: noop,
  sharedUiActivityId: term => term.kind === 'agent' ? term.id : `terminal:${term.id}`,
  window: { lt: { app: { dismissNotify: noop, requestAttention: noop, notify: noop } } },
  document: { hasFocus: () => true }, notifyDone: true, notificationSound: '', notificationVolume: 0,
  newId: () => 'test-run',
  focusWorkTargetSoon: (side, key) => focus.push({ side, key })
}
for (const key of Object.keys(state)) {
  context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (update) => {
    state[key] = typeof update === 'function' ? update(state[key]) : update
    context[key] = state[key]
  }
}
const names = [
  'docSide', 'termSide', 'docKey', 'termKeyOf', 'parseWorkKey', 'isAgentTab', 'documentAgentKey',
  'normalizedCasePathKey', 'compareCaseTabOrder', 'orderedCaseTabs',
  'termsForCaseTab', 'docsForCaseTab', 'caseTabRows', 'sidebarCases',
  'updateCaseTabActivity', 'activateTermTab',
  'selectTerm', 'onTermStatus', 'openCaseTab', 'openNextCaseAttention'
]
function render() {
  context.termStatusRef.current = state.termStatus
  context.termTabsRef = { current: state.termTabs }
  context.sidebarCaseTabs = [...state.caseTabs, { id: 'history', drafts: '/history', updatedAt: Date.now() }]
  const code = names.map((name) => {
    assert.ok(declarations.has(name), `find actual ${name} implementation`)
    return `const ${name} = ${declarations.get(name)};`
  }).join('\n') + `\nreturn { ${names.join(', ')} }`
  return vm.runInNewContext(ts.transpileModule(`(() => { ${code} })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}
const row = (id) => render().caseTabRows.find((item) => item.tab.id === id)
function sidebarList(cases = render().sidebarCases, attentionOnly = state.caseAttentionOnly, visibleCases = 6, setVisibleCases = noop, search = '') {
  return vm.runInNewContext(ts.transpileModule(`(() => {
    const orderedCases = ${sidebarDeclarations.get('orderedCases')};
    const count = ${sidebarDeclarations.get('count')};
    return { orderedCases, count, onMore: ${moreCasesOnClick} };
  })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, { cases, attentionOnly, visibleCases, setVisibleCases, search, matchesSearch })
}
const visibleCases = () => sidebarList().orderedCases
const attentionTaskIds = () => vm.runInNewContext(sidebarDeclarations.get('recentTasks'), {
  cases: render().sidebarCases, recentSidebarTasks, sessionVisits: [], attentionOnly: true, matchesSearch, search: ''
}).map(({ task }) => task.id)


assert.equal(render().sidebarCases.find((item) => item.id === 'a').noticeCount, 3, 'one unread reply and two pending sessions count once each')
assert.equal(row('a').questionTaskCount, 2, 'active-case questions stay visible')
assert.equal(row('a').doneTaskCount, 1, 'hidden completed work in the active case stays unread')
assert.deepEqual(Array.from(visibleCases(), (item) => item.id), ['a', 'b'])
render().openCaseTab(state.caseTabs[0])
assert.equal(row('a').questionTaskCount, 2, 'opening a case does not answer either pending question')
assert.ok(state.termAttention.has('a2'), 'opening the visible agent does not acknowledge the hidden agent')
assert.ok(state.termAttention.has('a3'), 'opening a case does not acknowledge a hidden completion')
render().selectTerm('a2')
assert.equal(row('a').questionTaskCount, 2, 'reading a question does not resolve it')
render().onTermStatus('a1', 'working')
render().onTermStatus('a2', 'idle')
assert.equal(row('a').questionTaskCount, 0, 'working and idle status transitions resolve pending questions')
render().onTermStatus('b1', 'idle')
assert.ok(state.termAttention.has('b1'), 'idle snapshots preserve unread completed work')
render().selectTerm('a3')
assert.equal(row('a').doneTaskCount, 0, 'viewed completion is acknowledged')

context.setTermStatus(new Map([['a1', 'question'], ['a2', 'question'], ['b1', 'question']]))
context.setTermAttention(new Set())
context.caseAttentionOrderRef.current = []
for (let i = 0; i < 4; i++) render().openNextCaseAttention()
assert.deepEqual(focus.slice(-4).map(({ key }) => key), ['terminal:a1', 'terminal:a2', 'terminal:b1', 'terminal:a1'], 'next attention traverses agents and wraps across cases')
render().onTermStatus('a2', 'working')
render().openNextCaseAttention()
assert.equal(focus.at(-1).key, 'terminal:b1', 'resolved questions are skipped without restarting the cycle')

context.setTermStatus(new Map())
context.setTermAttention(new Set())
render().onTermStatus('a2', 'question')
render().onTermStatus('a2', 'done', undefined, false)
assert.equal(row('a').doneTaskCount, 0, 'ending a pending question without a reply clears its notification')
render().onTermStatus('a2', 'working')
render().onTermStatus('a2', 'done', '첫 답변')
render().onTermStatus('a2', 'done', '첫 답변')
assert.equal(row('a').doneTaskCount, 1, 'duplicate completion for one session counts once')
render().onTermStatus('a3', 'done', '다른 세션 답변')
assert.equal(row('a').doneTaskCount, 2, 'two sessions in the same case count separately')
render().selectTerm('a2')
assert.equal(row('a').doneTaskCount, 1, 'reading one session preserves the other unread reply')
assert.deepEqual(Array.from(attentionTaskIds()), ['a3'], 'the recent-session filter shows only the unread session within the case')
context.sharedUiActivities.set('a', {
  a3: { status: 'done', attention: true },
  'remote-only': { status: 'done', attention: true },
  'remote-no-reply': { status: 'done', attention: true, hasReply: false },
  'remote-read': { status: 'done', attention: false }
})
assert.equal(row('a').doneTaskCount, 2, 'unloaded unread sessions count once alongside loaded sessions')
render().selectTerm('a3')
assert.equal(row('a').doneTaskCount, 1, 'acknowledging the loaded session leaves the remote reply')
let remoteTarget
context.shareSelection = (tab, target) => { remoteTarget = [tab.id, target.kind, target.id] }
render().openNextCaseAttention()
assert.deepEqual(remoteTarget, ['a', 'agent', 'remote-only'], 'next attention selects the session with the remote reply')
context.sharedUiActivities.clear()
assert.equal(visibleCases().length, 0, 'attention filter handles an empty queue')
const focusedBefore = focus.length
render().openNextCaseAttention()
assert.equal(focus.length, focusedBefore, 'empty queue does not navigate')
context.setCaseAttentionOnly(false)
assert.deepEqual(Array.from(visibleCases(), (item) => item.id).slice(0, 3).sort(), ['a', 'b', 'empty'], 'turning off the filter restores all open cases')
assert.equal(visibleCases().at(-1).id, 'history', 'open cases precede more recent history')
const manyCases = [
  ...Array.from({ length: 12 }, (_, index) => ({ id: `open-${index}`, open: true, updatedAt: index, noticeCount: 0 })),
  ...Array.from({ length: 9 }, (_, index) => ({ id: `history-${index}`, open: false, updatedAt: 100 + index, noticeCount: 0 }))
]
let visibleLimit = 6
const initialList = sidebarList(manyCases, false, visibleLimit, (count) => { visibleLimit = count })
assert.equal(initialList.count, 12, 'all opened cases are visible even above the initial list limit')
assert.equal(initialList.orderedCases.slice(0, initialList.count).every((item) => item.open), true, 'newer history cannot displace open cases')
initialList.onMore()
const expandedList = sidebarList(manyCases, false, visibleLimit)
assert.equal(expandedList.count, 18, 'one More click extends the effective open-case count')
assert.equal(expandedList.orderedCases.slice(0, expandedList.count).filter((item) => !item.open).length, 6, 'one More click reveals six history cases')
const searchableCases = [
  { id: 'damages', title: '2026가단12345 손해배상', participants: '김민수 / 대한건설', court: '서울중앙지방법원', division: '제55민사단독', subtitle: '로컬 /cases/Damages', open: true, noticeCount: 1 },
  { id: 'lease', title: '2025가단54321 임대차보증금', participants: '이서연', subtitle: '로컬 /cases/lease', open: false, noticeCount: 0 },
  ...manyCases,
  { id: 'remote', title: '오래된 사건', participants: '박지훈', subtitle: '원격 사무실 /cases/remote', open: false, noticeCount: 1 }
]
const searchCases = (query, attentionOnly = false) => Array.from(sidebarList(searchableCases, attentionOnly, 6, noop, query).orderedCases, (item) => item.id)
assert.deepEqual(searchCases('2026 가단 12345'), ['damages'], 'case number search ignores spacing')
assert.deepEqual(searchCases('손해배상 대한건설'), ['damages'], 'tokens can match case title and party together')
assert.deepEqual(searchCases('김민수'.normalize('NFD')), ['damages'], 'decomposed Korean input matches party names')
assert.deepEqual(searchCases('DAMAGES'), ['damages'], 'folder search ignores case')
assert.deepEqual(searchCases('서울중앙 55민사'), ['damages'], 'court and division can be combined')
assert.deepEqual(searchCases('제55 민사 단독'), ['damages'], 'division search ignores spacing')
assert.deepEqual(searchCases('박지훈'), ['remote'], 'search includes cases beyond the first page')
assert.deepEqual(searchCases('이서연', true), [], 'search intersects the attention filter')
assert.deepEqual(searchCases('대한건설', true), ['damages'])
assert.deepEqual(searchCases('없는사건'), [], 'unmatched queries return no cases')
assert.deepEqual(searchCases('   '), searchCases(''), 'whitespace restores the full list')
assert.match(sidebarSource, /disabled=\{noticeCount === 0\}/)
assert.match(sidebarSource, /type="checkbox" checked=\{attentionOnly\}/)
assert.doesNotMatch(source, /case-tabs-flyout|visibleCaseTabRows/, 'attention navigation belongs to one sidebar')
console.log('case attention ok')
