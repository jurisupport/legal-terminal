import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
let titleEffect
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  }
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect' &&
      node.arguments[1]?.getText(parsed) === '[termKey]') titleEffect = node.arguments[0].getText(parsed)
  ts.forEachChild(node, visit)
}
visit(parsed)
const compile = (source, context) => vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, context)

for (const ssh of [undefined, { host: 'server.invalid', user: 'lawyer' }]) {
  const original = { id: 'old', title: '프롬프트에 따라 답변을 만들어', sessionTitle: '기존 대화 제목',
    renamed: true, resumeSessionId: 'old-session', kind: 'agent', agentProvider: 'claude',
    cwd: '/work/project', caseTabId: 'project', recordsFolder: '/records', ssh, projectId: 'project-1' }
  let tabs = [original], movedDraft, registered
  const create = compile(`(${declarations.get('addAgentSame')})`, {
    termTabs: tabs, activeTerm: original.id, currentCase: { name: original.title },
    newId: () => 'new', termSide: () => 'right', agentDefaultProvider: 'claude',
    resolveAgentProvider: (provider) => provider ?? 'claude', isAgentTab: (tab) => tab?.kind === 'agent',
    setTermTabs: (update) => { tabs = update(tabs) }, setActiveTerm: () => {}, setWorkActive: () => {},
    termKeyOf: (id) => `terminal:${id}`, moveAgentDraft: (...args) => { movedDraft = args },
    registerCaseTabFromTerm: (tab) => { registered = tab }
  })
  const tab = create()
  assert.equal(tab.title, '새 대화', 'new tabs must not copy a restored or manually named conversation')
  for (const key of ['sessionTitle', 'renamed', 'resumeSessionId', 'forkFromSessionId']) assert.equal(tab[key], undefined)
  for (const key of ['cwd', 'caseTabId', 'recordsFolder', 'ssh', 'projectId', 'agentProvider']) assert.equal(tab[key], original[key])
  assert.deepEqual(movedDraft, ['old', 'new'], 'existing draft handoff remains available')
  assert.equal(registered, tab)
  assert.equal(tabs[0], original, 'the original conversation is untouched')
}

const caseFromTerm = compile(`(${declarations.get('currentCaseFromTerm')})`, {
  caseTabsRef: { current: [{ id: 'project', name: '동영상 프로젝트' }] },
  remoteUri: (profile, cwd) => `ssh://${profile}${cwd}`
})
assert.equal(caseFromTerm({ title: '새 대화', caseTabId: 'project', cwd: '/work/project' }).name, '동영상 프로젝트',
  'a fresh conversation title must not rename its workspace')
assert.equal(caseFromTerm({ title: '열린 폴더', cwd: '/work/new' }).name, '열린 폴더')

const service = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const serviceParsed = ts.createSourceFile('service.ts', service, ts.ScriptTarget.Latest, true)
const functions = serviceParsed.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['getAgentSessionSnapshot', 'clipForTitlePrompt'].includes(node.name?.text))
const sessions = new Map()
const snapshot = compile(functions.map(node => node.getText(serviceParsed).replace(/^export /, '')).join('\n') +
  '\ngetAgentSessionSnapshot', { sessions })
sessions.set('blank', { id: 'blank', title: '새 대화' })
sessions.set('first', { id: 'first', title: '새 대화', firstUserText: '  새로운 영상\n제작 요청  ' })
sessions.set('generated', { id: 'generated', firstUserText: '질문', generatedTitle: '영상 제작 기획' })
assert.equal(snapshot('blank').session.sessionTitle, undefined)
assert.equal(snapshot('first').session.sessionTitle, '새로운 영상 제작 요청')
assert.equal(snapshot('generated').session.sessionTitle, '영상 제작 기획')
sessions.get('first').firstUserText = '가'.repeat(80)
assert.equal(snapshot('first').session.sessionTitle, '가'.repeat(48) + '…')

let tabs = [
  { id: 'blank', kind: 'agent', agentProvider: 'claude', cwd: '/same' },
  { id: 'local', kind: 'agent', agentProvider: 'claude', cwd: '/same', resumeSessionId: 'local-session' },
  { id: 'remote', kind: 'agent', agentProvider: 'claude', cwd: '/same', ssh: { host: 'server.invalid' } },
  { id: 'codex', kind: 'agent', agentProvider: 'codex', cwd: '/same' },
  { id: 'manual', kind: 'agent', cwd: '/same', renamed: true, sessionTitle: '직접 정한 제목' },
  { id: 'shell', kind: 'terminal', cwd: '/shell' }
]
const ref = { current: tabs }, reads = [], remembered = []
let interval, pendingResolve, fail = false
const replies = new Map([
  ['blank', { id: 'blank' }],
  ['local', { id: 'local', sessionTitle: '로컬 질문', resumeSessionId: 'local-session' }],
  ['remote', { id: 'remote', sessionTitle: '원격 질문', resumeSessionId: 'remote-session' }],
  ['codex', { id: 'codex', sessionTitle: 'Codex 질문', resumeSessionId: 'codex-session' }]
])
const effect = compile(`(${titleEffect})`, {
  termTabs: tabs, termTabsRef: ref, isAgentTab: (tab) => tab?.kind === 'agent',
  resolveAgentProvider: (provider) => provider ?? 'claude',
  setTermTabs: (update) => { tabs = update(tabs); ref.current = tabs },
  rememberSessionForTerm: (tab, sessionId) => remembered.push([tab.id, sessionId]),
  setInterval: (callback) => { interval = callback; return 1 }, clearInterval: () => {},
  window: { lt: {
    agent: { snapshot: async (id) => {
      reads.push(id)
      if (fail) throw Error('closed')
      if (id === 'delayed') return new Promise(resolve => { pendingResolve = resolve })
      return { ok: true, session: replies.get(id) }
    } },
    sessions: { current: async (cwd) => {
      assert.equal(cwd, '/shell', 'agent tabs must never guess a session from the latest transcript in their folder')
      return { sessionId: 'shell-session', title: '터미널 대화' }
    } }
  } }
})
const flush = () => new Promise(resolve => setImmediate(resolve))
const cleanup = effect()
await flush()
assert.equal(tabs.find(tab => tab.id === 'blank').sessionTitle, undefined)
for (const id of ['local', 'remote', 'codex']) assert.equal(tabs.find(tab => tab.id === id).sessionTitle, replies.get(id).sessionTitle)
assert.equal(tabs.find(tab => tab.id === 'shell').sessionTitle, '터미널 대화')
assert.equal(reads.includes('manual'), false)
assert.equal(remembered.some(([id, session]) => id !== 'shell' && session === 'shell-session'), false)

tabs = tabs.map(tab => tab.id === 'local' ? { ...tab, renamed: true, title: '수동 이름' } : tab)
ref.current = tabs
reads.length = 0
interval()
await flush()
assert.equal(reads.includes('local'), false, 'polling uses current tab state after a rename')
ref.current = tabs = [{ id: 'delayed', kind: 'agent', agentProvider: 'claude', cwd: '/same' }]
interval()
ref.current = tabs = [{ ...tabs[0], agentProvider: 'codex' }]
pendingResolve({ ok: true, session: { id: 'delayed', sessionTitle: '이전 프로바이더 제목' } })
await flush()
assert.equal(tabs[0].sessionTitle, undefined, 'a late reply cannot overwrite a switched provider')
fail = true
interval()
await flush()
fail = false
interval()
cleanup()
pendingResolve({ ok: true, session: { id: 'delayed', sessionTitle: '닫힌 탭 제목' } })
await flush()
assert.equal(tabs[0].sessionTitle, undefined, 'cleanup ignores in-flight title responses')
console.log('Agent tab titles: fresh names, workspace preservation, own-session updates, SSH/Codex, rename and async guards passed')
