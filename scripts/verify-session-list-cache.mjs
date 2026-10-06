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
