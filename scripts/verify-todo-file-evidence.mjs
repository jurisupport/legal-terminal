import assert from 'node:assert/strict'
import { containsCaseNumber, pairedFileEvidence } from '../src/main/todoFileEvidence.ts'
const entry=(path,extra={})=>({path,name:path.split('/').at(-1),isDir:false,mtimeMs:0,...extra})
assert.equal(containsCaseNumber('2026가합1234.pdf','2026가합123'),false)
assert.equal(containsCaseNumber('서울 2026 가합 123 준비서면.pdf','2026가합123'),true)
let reads=0
assert.equal((await pairedFileEvidence(null,[{path:'/shared',kind:'drafts'}],async()=>{reads++;return []})).candidates.length,0)
assert.equal(reads,0)
const result=await pairedFileEvidence('2026가합123',[{path:'/shared',kind:'drafts'},{path:'/2026가합123',kind:'records',caseSpecific:true}],async(folder)=>folder==='/shared'?[entry('/shared/2026가합123 초안.md'),entry('/shared/2026가합1234 다른사건.pdf'),entry('/shared/다른사건.pdf'),entry('/else/2026가합123.pdf'),entry('/shared/subdir',{isDir:true})]:[entry('/2026가합123/기록.pdf')])
assert.equal(result.candidates.length,2)
assert.match(result.candidates[0].reason,/초안/)
assert.equal(result.candidates[0].uri,'/shared/2026가합123 초안.md')
assert.equal(result.candidates[0].status,'candidate')
assert.equal(result.candidates[1].occurredAt,'1970-01-01T00:00:00.000Z')
const remote=await pairedFileEvidence('2026가합123',[{path:'ssh://profile/case',kind:'records'}],async()=>[entry('ssh://profile/case/2026가합123.pdf'),entry('ssh://profile/case/generic.pdf')])
assert.equal(remote.candidates.length,1)
assert.equal(remote.candidates[0].uri,'ssh://profile/case/2026가합123.pdf')
const again=await pairedFileEvidence('2026가합123',[{path:'ssh://profile/case',kind:'records'}],async()=>[entry('ssh://profile/case/2026가합123.pdf')])
assert.equal(remote.candidates[0].id,again.candidates[0].id)
const cap=await pairedFileEvidence('2026가합123',[{path:'/case',kind:'drafts'}],async()=>Array.from({length:250},(_,i)=>entry(`/case/2026가합123-${i}.pdf`)))
assert.equal(cap.candidates.length,20);assert.match(cap.warnings.join(' '),/200/);assert.match(cap.warnings.join(' '),/20/)
const failed=await pairedFileEvidence('2026가합123',[{path:'/case',kind:'records'}],async()=>{throw new Error('missing')})
assert.equal(failed.candidates.length,0);assert.match(failed.warnings.join(' '),/조회 실패/)
assert.match((await pairedFileEvidence('2026가합123',[],async()=>[])).warnings.join(' '),/연결된/)
console.log('paired file evidence exact case scope, prefix isolation, shallow cap, candidate-only status, local/SSH paths and errors ok')

// Exercise the native Windows path branch without requiring a Windows runner.
const { readFileSync } = await import('node:fs')
const { createRequire } = await import('node:module')
const path = await import('node:path')
const ts = await import('typescript')
const require = createRequire(import.meta.url)
const source = ts.default.transpileModule(readFileSync(new URL('../src/main/todoFileEvidence.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.default.ModuleKind.CommonJS, target: ts.default.ScriptTarget.ES2022 } }).outputText
const winExports = {}
new Function('require', 'exports', source)((name) => name === 'node:path' ? { ...path.win32, posix: path.posix } : require(name), winExports)
const windows = await winExports.pairedFileEvidence('2026가합123', [{ path: 'C:\\cases', kind: 'drafts' }], async () => [{ path: 'C:\\cases\\2026가합123.pdf', name: '2026가합123.pdf', isDir: false }])
assert.equal(windows.candidates[0].uri, 'C:/cases/2026가합123.pdf')
assert.equal(windows.candidates[0].id.length, 64)
console.log('Windows file candidate uses normalized native path and bounded deterministic identifier')

const vm = await import('node:vm')
const remoteSource = ts.default.createSourceFile('remoteFs.ts', readFileSync(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8'), ts.default.ScriptTarget.Latest, true)
const reader = remoteSource.statements.find((node) => ts.default.isFunctionDeclaration(node) && node.name?.text === 'readRemoteDir')
assert.ok(reader)
let symlinkStats = 0, prefetched = 0, aliasedRoot = false
const readRemoteDir = vm.runInNewContext(ts.default.transpileModule(reader.getText(remoteSource) + '\nreadRemoteDir', { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText, {
  getSftp: async () => ({ realpath: (p, cb) => cb(null, aliasedRoot ? '/another-case' : p), readdir: (_p, cb) => cb(null, [{ filename: '2026가합123.pdf', attrs: { mode: 0o100000 } }, { filename: '2026가합123 link.pdf', attrs: { mode: 0o120000 } }]) }),
  oneDriveCloudPath: () => null, resolveRemotePath: async (_s, p) => p,
  posix: path.posix, S_IFMT: 0o170000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,
  statIsDir: async () => { symlinkStats++; return false }, makeRemote: (id, p) => `ssh://${id}${p}`,
  sortEntryArray: (rows) => rows, prefetchRemoteOneDriveFiles: () => { prefetched++ }
})
assert.equal((await readRemoteDir('profile', '/cases', false, false)).length, 1)
assert.equal(symlinkStats, 0); assert.equal(prefetched, 0)
assert.equal((await readRemoteDir('profile', '/cases')).length, 2)
assert.equal(symlinkStats, 1); assert.equal(prefetched, 1)
aliasedRoot = true
await assert.rejects(readRemoteDir('profile', '/cases', false, false), /실제 경로/)
const listDeclaration = remoteSource.statements.find((node) => ts.default.isFunctionDeclaration(node) && node.name?.text === 'rfsList')
const isolatedList = vm.runInNewContext(ts.default.transpileModule(listDeclaration.getText(remoteSource).replace('export ', '') + '\nrfsList', { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText, {
  parseRemote: () => ({profileId:'profile',path:'/cases'}),
  readRemoteDir: async (_id, _path, prefetch, follow) => { assert.equal(prefetch,false); assert.equal(follow,false); return [] },
  remoteDirCacheKey: () => assert.fail('filtered evidence listing must not read or publish the normal explorer cache')
})
await isolatedList('ssh://profile/cases', {prefetch:false,followSymlinks:false})

const appSource = ts.default.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.default.ScriptTarget.Latest, true)
let handler
function visit(node) {
  if (ts.default.isCallExpression(node) && node.arguments[0]?.text === 'todo:evidenceSuggestions') handler = node.arguments[1]
  ts.default.forEachChild(node, visit)
}
visit(appSource); assert.ok(handler)
let allowed = true, listed = 0
const ipc = vm.runInNewContext(ts.default.transpileModule(`(${handler.getText(appSource)})`, { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText, {
  js: { getTodo: async () => ({ id:'task',caseId:'case',caseNumber:'2026가합999',evidence:[] }), getCase: async () => { if (!allowed) throw Error('forbidden'); return {id:'case',caseNumber:'2026가합123'} }, todoEvidenceSuggestions: async () => [] },
  getSettings: async () => ({jurisupportTokenEnc:'synthetic',sshProfiles:[{id:'profile'}],caseOpenTarget:'remote:profile'}),
  allJsPairings: async () => ({'remote:profile:case':{records:'ssh://profile/2026가합123',drafts:'ssh://profile/shared'},'remote:profile:other':{records:'ssh://profile/other'}}),
  isRemote: (p) => p.startsWith('ssh://'), parseRemote: (p) => ({path:decodeURIComponent(new URL(p).pathname)}), basename:path.posix.basename,
  containsCaseNumber, realpath: async (p) => p,
  pairedFileEvidence: async (number, folders, list) => { assert.equal(number,'2026가합123'); assert.equal(folders[0].path,'ssh://profile/2026가합123'); assert.equal(folders[0].caseSpecific,true); await list(folders[0].path); return {candidates:[],warnings:[]} },
  rfsList: async (_folder, opts) => { listed++; assert.equal(opts.prefetch,false); assert.equal(opts.followSymlinks,false); return [] }
})
const checked = await ipc(null,'task'); assert.equal(checked.ok,true,JSON.stringify(checked))
assert.equal(listed,1)
allowed=false
assert.equal((await ipc(null,'task')).ok,false)
assert.equal(listed,1,'case access denial prevents file listing')
console.log('remote evidence skips symlinks/prefetch and uses accessible case identity plus exact profile pairing')
