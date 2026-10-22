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
const names = ['sessionListCache', 'sessionListInflight', 'sessionListKey', 'cachedPastSessions', 'loadPastSessions']
let now = 1000000, reads = 0, resolveRead, rejectRead
const api = vm.runInNewContext(ts.transpileModule(names.map((name) => `const ${name} = ${declarations.get(name)};`).join('\n') + '\n({loadPastSessions, cachedPastSessions})', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, {
  Date: { now: () => now }, SESSION_SEARCH_RECENT_LIMIT: 40,
  sessionContextForTerm: (term) => term ? { caseNumber: term.caseNumber } : undefined,
  pathLeaf: (path) => path.split('/').pop(),
  window: { lt: { sessions: {
    list: () => { reads++; return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject }) },
    remember: async () => ({ ok: true })
  } } }
})
const remote = { cwd: '/cases/one', ssh: { host: 'server', user: 'lawyer' }, caseNumber: '2026가단1' }
const initial = api.loadPastSessions(remote.cwd, remote)
assert.equal(api.loadPastSessions(remote.cwd, remote, '', true), initial, 'force refresh joins an in-flight read')
assert.equal(reads, 1)
const rows = [{ sessionId: 'one', mtime: now, title: '기존 작업' }]
resolveRead(rows)
assert.equal(await initial, rows)
now += 60001
assert.equal(await api.loadPastSessions(remote.cwd, remote), rows, 'remote history stays fresh beyond one minute')
assert.equal(reads, 1)
now += 120000
const stale = api.loadPastSessions(remote.cwd, remote)
assert.equal(reads, 2, 'stale remote history refreshes after three minutes')
assert.equal(api.cachedPastSessions(remote.cwd, remote), rows, 'old rows remain available while refreshing')
rejectRead(Error('offline'))
await assert.rejects(stale, /offline/)
assert.equal(api.cachedPastSessions(remote.cwd, remote), rows, 'a failure preserves usable cached history')
const retry = api.loadPastSessions(remote.cwd, remote, '', true)
resolveRead([])
await retry
assert.deepEqual(await api.loadPastSessions(remote.cwd, remote), [], 'empty results are cached too')
assert.equal(reads, 3)
const local = api.loadPastSessions(remote.cwd)
assert.equal(reads, 4, 'same folder on local and remote uses separate caches')
resolveRead(rows)
await local
now += 60001
const localRefresh = api.loadPastSessions(remote.cwd)
assert.equal(reads, 5, 'local cache refreshes after one minute')
resolveRead(rows)
await localRefresh
console.log('session list cache: TTL, refresh dedupe, cached empty results, source isolation and failure retention OK')

const resumeHandlers = []
let clickHandler
function findResumeHandlers(node) {
  if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
    if (node.name.text === 'onResume') resumeHandlers.push(node.initializer.expression.getText(parsed))
    if (node.name.text === 'onClick' && node.initializer.expression?.getText(parsed).includes('onResume(p.sessionId')) {
      clickHandler = node.initializer.expression.getText(parsed)
    }
  }
  ts.forEachChild(node, findResumeHandlers)
}
findResumeHandlers(parsed)
assert.equal(resumeHandlers.length, 2, 'both desktop history layouts are covered')
for (const handler of resumeHandlers) {
  let resumed
  const context = vm.createContext({
    p: { sessionId: 'phone', cwd: '/cases/one', title: '폰 작업', originDevice: 'android' },
    filterSource: remote, side: 'right', setSessionListOpen: () => {},
    openPastSession: (...args) => { resumed = args }
  })
  vm.runInContext(`const onResume = ${handler}; (${clickHandler})()`, context)
  assert.equal(resumed[0], 'phone')
  assert.equal(resumed[7], 'android', 'history row forwards creator through the layout wrapper')
}
console.log('session history creator propagation: both layouts OK')

// Run each real dashboard resume branch so creator metadata reaches the reopened tab.
let dashboardResume
const resumeApi = vm.runInNewContext(ts.transpileModule(
  ['resumeCaseSession', 'resumePathSession'].map((name) => `const ${name} = ${declarations.get(name)};`).join('\n') +
    '\n({resumeCaseSession, resumePathSession})', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText, {
  setMode: () => {}, findSshProfile: async () => ({ id: 'office' }),
  openCaseRemote: async () => ({ source: {} }), openCaseWorkspace: async () => ({ drafts: '/cases/one' }),
  openRemoteCaseContext: () => ({ id: 'case', title: '작업', source: {} }), resolveRemoteRecordsLater: () => {},
  openPastSession: (...args) => { dashboardResume = args }
})
for (const profileId of [undefined, 'office']) {
  for (const originDevice of ['android', 'desktop', undefined]) {
    const summary = { sessionId: 'phone', cwd: '/cases/one', title: '작업', profileId, originDevice }
    await resumeApi.resumeCaseSession({ id: 'case' }, summary, true)
    assert.equal(dashboardResume[7], originDevice, 'local/remote case history keeps creator')
    assert.equal(dashboardResume[6], true, 'opening a new tab keeps existing resume semantics')
    await resumeApi.resumePathSession(summary.sessionId, summary.cwd, summary.title, profileId, true, originDevice)
    assert.equal(dashboardResume[7], originDevice, 'local/remote work log path keeps creator')
  }
}
const dashboardSource = readFileSync(new URL('../src/renderer/src/dashboard/CasesDashboard.tsx', import.meta.url), 'utf8')
const dashboardParsed = ts.createSourceFile('CasesDashboard.tsx', dashboardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const dashboardDeclarations = new Map()
let folderClick
function visitDashboard(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) dashboardDeclarations.set(node.name.getText(dashboardParsed), node.initializer.getText(dashboardParsed))
  if (ts.isJsxAttribute(node) && node.name.text === 'onClick' && ts.isJsxExpression(node.initializer) &&
    node.initializer.expression?.getText(dashboardParsed).includes('onResumePath(s.sessionId')) folderClick = node.initializer.expression.getText(dashboardParsed)
  ts.forEachChild(node, visitDashboard)
}
visitDashboard(dashboardParsed)
let summaryArgs, pathArgs
const dashboardContext = vm.createContext({
  cases: [{ id: 'case', caseNumber: '2026가단1' }],
  onResumeSession: (...args) => { summaryArgs = args }, onResumePath: (...args) => { pathArgs = args },
  s: { sessionId: 'phone', cwd: '/cases/one', originDevice: 'android' }, f: { cwd: '/cases/one' }
})
const resumeWorkLog = vm.runInContext(ts.transpileModule(
  ['norm', 'resumeFromWorkLog'].map((name) => `const ${name} = ${dashboardDeclarations.get(name)};`).join('\n') +
    '\nresumeFromWorkLog', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText, dashboardContext)
resumeWorkLog({ sessionId: 'phone', cwd: '/cases/one', caseNumber: '2026가단1', originDevice: 'android' })
assert.equal(summaryArgs[1].originDevice, 'android', 'case-matched work log retains creator in its summary')
resumeWorkLog({ sessionId: 'phone', cwd: '/cases/one', originDevice: 'android' })
assert.equal(pathArgs[5], 'android', 'unmatched work log retains creator in its path callback')
vm.runInContext(`(${folderClick})()`, dashboardContext)
assert.equal(pathArgs[5], 'android', 'folder card retains creator in its path callback')
function verifyDashboardWrappers(node) {
  if (ts.isJsxAttribute(node) && ['onResumeSession', 'onResumePath'].includes(node.name.text)) {
    const context = vm.createContext({ resumeCaseSession: (...args) => { summaryArgs = args },
      resumePathSession: (...args) => { pathArgs = args } })
    const handler = vm.runInContext(`(${node.initializer.expression.getText(parsed)})`, context)
    if (node.name.text === 'onResumePath') {
      handler('phone', '/cases/one', '작업', 'office', true, 'android')
      assert.equal(pathArgs[5], 'android', 'App forwards the dashboard path creator')
    } else {
      handler({ id: 'case' }, { originDevice: 'android' }, true)
      assert.equal(summaryArgs[1].originDevice, 'android', 'App forwards the dashboard session creator')
    }
  }
  ts.forEachChild(node, verifyDashboardWrappers)
}
verifyDashboardWrappers(parsed)
console.log('dashboard creator resume: local/remote case, folder, both work log routes and App wrappers OK')
