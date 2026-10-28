import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { basename } from 'node:path'
import ts from 'typescript'
import { matchesSearch } from '../src/renderer/src/search/sessionSearch.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/renderer/src/dashboard/caseListCache.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const calls = []
const cases = [
  ...Array.from({ length: 60 }, (_, i) => ({ id: `ordinary-${i}`, status: 'active', court: null, division: null })),
  { id: 'late', status: 'active', court: '서울중앙지방법원', division: '제55민사단독', caseName: '보관된 이름' },
  { id: 'closed', status: 'closed', court: '서울중앙지방법원', division: '제55민사단독' }
]
let reply = async (query) => ({ ok: true, cases: query.search ? [] : cases.filter((item) => !query.status || item.status === query.status) })
const module = { exports: {} }
vm.runInNewContext(code, {
  module, exports: module.exports, require: () => ({ matchesSearch }),
  window: { lt: { js: { listCases: (query) => { calls.push(query); return reply(query) } } } }
})
const { listCasesCached, readCachedCaseList, clearCaseListCache } = module.exports
const ids = (result) => Array.from(result.cases ?? [], (item) => item.id)

await listCasesCached({ status: 'active' })
assert.deepEqual(ids(await listCasesCached({ status: 'active', search: '제55 민사 단독' })), ['late'], 'division search includes cases beyond page one')
assert.deepEqual(ids(await listCasesCached({ status: 'active', search: '서울중앙 55민사' })), ['late'], 'court and division tokens can be combined')
assert.equal(calls.filter((query) => !query.search).length, 1, 'reuse the already-loaded full list')
assert.equal(calls.filter((query) => !query.search).every((query) => query.limit === undefined && query.page === undefined), true, 'supplement uses all pages')
assert.deepEqual(ids(await listCasesCached({ status: 'closed', search: '55민사' })), ['closed'], 'preserve status filtering')
assert.deepEqual(ids(await listCasesCached({ search: '제55민사단독'.normalize('NFD') })), ['late', 'closed'], 'all statuses and decomposed Korean work')

clearCaseListCache()
reply = async (query) => ({ ok: true, cases: query.search
  ? [{ ...cases[60], caseName: '최신 이름' }, { id: 'phone-match', court: null, division: null }]
  : cases.slice(0, 61) })
const merged = await listCasesCached({ status: 'active', search: '55민사' })
assert.deepEqual(ids(merged), ['late', 'phone-match'], 'keep server-only matches and deduplicate overlapping results')
assert.equal(merged.cases[0].caseName, '최신 이름', 'cached metadata cannot replace a fresh server match')
const before = calls.length
await listCasesCached({ status: 'active', search: '55민사' })
assert.equal(calls.length, before, 'cache the merged search results')
await listCasesCached({ status: 'active', search: '55민사', refresh: true })
assert.equal(calls.slice(before).length, 2, 'refresh both server results and supplementary metadata')
assert.equal(calls.slice(before).every((query) => query.refresh), true)

clearCaseListCache()
const beforePage = calls.length
await listCasesCached({ page: 2, limit: 10, search: '55민사' })
assert.equal(calls.length, beforePage + 1, 'explicit pagination keeps its server contract')

clearCaseListCache()
reply = async (query) => query.search ? { ok: true, cases: [] } : { ok: false, error: '전체 목록 조회 실패' }
assert.equal((await listCasesCached({ search: '55민사' })).error, '전체 목록 조회 실패', 'do not report false empty results when supplementary lookup fails')
assert.equal(readCachedCaseList({ search: '55민사' }), undefined, 'failed searches are not cached')

clearCaseListCache()
let release
reply = async (query) => query.search ? { ok: true, cases: [cases[60]] } : new Promise((resolve) => { release = resolve })
const pending = listCasesCached({ status: 'active', search: '55민사' })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(typeof release, 'function')
clearCaseListCache()
release({ ok: true, cases: [cases[60]] })
assert.equal((await pending).ok, false, 'account/cache changes reject an older in-flight search')
assert.equal(readCachedCaseList({ status: 'active', search: '55민사' }), undefined, 'older searches cannot repopulate cleared cache')

const workspace = ts.createSourceFile('workspace.ts', readFileSync(new URL('../src/main/workspace.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const metadataFunctions = ['asRecord', 'asString', 'displayNameFromPath', 'activeTermRecord', 'workspaceEntryMetadata']
const metadataCode = workspace.statements.filter((node) => ts.isFunctionDeclaration(node) && metadataFunctions.includes(node.name?.text)).map((node) => node.getText(workspace)).join('\n')
const readMetadata = vm.runInNewContext(ts.transpileModule(metadataCode + '\nworkspaceEntryMetadata', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, { basename })
const savedCase = { currentCase: { drafts: '/cases/one', meta: { court: '서울중앙지방법원', division: '제55민사단독' } } }
assert.equal(readMetadata(savedCase).division, '제55민사단독', 'saved workspace index retains case division without open tasks')
assert.equal(readMetadata({ ...savedCase, terminals: [{ id: 'one', division: '제2민사부' }] }).division, '제2민사부', 'workspace index follows the active task metadata')

console.log('case list court/division search: cached full-list supplement, server matches, pagination, refresh and invalidation OK')
