import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const mainSource = ts.createSourceFile('index.ts', await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const listHandler = mainSource.statements.find((node) => node.getText(mainSource).startsWith("ipcMain.handle('fs:list',"))
const visibleCheck = mainSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'hasVisibleDirEntry')
assert.ok(listHandler && visibleCheck)
let localList
const local = vm.createContext({
  ipcMain: { handle: (_channel, handler) => { localList = handler } },
  isRemote: () => false, readLocalDirEntries: (path) => readdir(path, { withFileTypes: true }),
  join, stat, prefetchLocalCloudFiles() {}
})
vm.runInContext(compile(`${listHandler.getText(mainSource)}\n${visibleCheck.getText(mainSource)}`), local)

const recordName = '2026-10-14_2026가단12345.hearing.json'
const names = (entries) => Array.from(entries, (entry) => entry.name).sort()
await test('Local file list exposes hearing records and keeps unrelated dotfiles hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lt-hearing-visibility-'))
  try {
    for (const name of ['.hearings', '.git', '.legal-terminal']) await mkdir(join(root, name))
    await writeFile(join(root, '.DS_Store'), '')
    await writeFile(join(root, '서면.md'), '서면')
    await writeFile(join(root, '.hearings', recordName), '{"version":1}')
    await writeFile(join(root, '.hearings', '.temporary'), '')
    const entries = await localList({}, root)
    assert.deepEqual(names(entries), ['.hearings', '서면.md'])
    const folder = entries.find((entry) => entry.name === '.hearings')
    assert.equal(folder.isDir, true)
    const records = await localList({}, folder.path)
    assert.deepEqual(names(records), [recordName])
    assert.equal(await readFile(records[0].path, 'utf8'), '{"version":1}')
  } finally { await rm(root, { recursive: true, force: true }) }
})
await test('A OneDrive folder containing only hearings already has visible content', () => {
  assert.equal(local.hasVisibleDirEntry([{ name: '.hearings' }]), true)
  assert.equal(local.hasVisibleDirEntry([{ name: '.git' }, { name: '.DS_Store' }]), false)
})

let cloudOnly = false
const directoryNames = ['.', '..', '.hearings', '.git', '.legal-terminal', '.DS_Store', '서면.md']
const sftp = {
  lstat: (_path, callback) => callback(null, {}),
  readdir: (path, callback) => callback(null, cloudOnly ? [] :
    (path.endsWith('/.hearings') ? [recordName, '.temporary'] : directoryNames).map((filename) => ({
      filename, attrs: { mode: filename === recordName || filename.endsWith('.md') ? 0o100644 : 0o040755, mtime: 1 }
    })))
}
const client = {
  exec: (_command, callback) => {
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    callback(null, channel)
    queueMicrotask(() => { channel.emit('data', Buffer.from('.hearings/\n.git/\n.DS_Store\n서면.md\n')); channel.emit('close', 0) })
  }
}
const mocks = {
  './settings': {}, './sshHostKeys': {}, './remoteFileCache': {},
  './sshConnectionPool': { SshConnectionPool: class { async get() { return { sftp, client } } } },
  './remoteDirListCache': {
    readRemoteDirListCache: async (namespace) => namespace === 'remote-fs' ? { entries: [] } : undefined,
    rememberRemoteDirListCache() {}, invalidateRemoteDirListCache() {}
  }
}
const module = { exports: {} }
vm.runInNewContext(compile(await readFile(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8')), {
  module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
  Buffer, process, console, setTimeout, clearTimeout, AbortController, AbortSignal
})
const remote = module.exports
await test('SSH file list exposes the folder and its records without reusing old hidden-folder caches', async () => {
  const entries = await remote.rfsList('ssh://test/cases/sample', { prefetch: false })
  assert.deepEqual(names(entries), ['.hearings', '서면.md'])
  const folder = entries.find((entry) => entry.name === '.hearings')
  assert.equal(folder.isDir, true)
  assert.equal(folder.path, 'ssh://test/cases/sample/.hearings')
  assert.deepEqual(names(await remote.rfsList(folder.path, { refresh: true, prefetch: false })), [recordName])
})
await test('Remote OneDrive fallback also exposes hearings while hiding other dotfiles', async () => {
  cloudOnly = true
  const entries = await remote.rfsList('ssh://test/Users/test/OneDrive/case', { refresh: true, prefetch: false })
  assert.deepEqual(names(entries), ['.hearings', '서면.md'])
  assert.equal(entries.find((entry) => entry.name === '.hearings').isDir, true)
})
