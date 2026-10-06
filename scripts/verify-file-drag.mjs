import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'lt-file-drag-test-'))
const handlers = new Map()
const broadcasts = []
const remoteFiles = new Map()
const remoteReads = []
let iconPath = '/test/icon.png'
let emptyIcon = false
let checks = 0
const icon = { resize: () => icon, isEmpty: () => emptyIcon }
const electron = {
  app: { getPath: (name) => { assert.equal(name, 'temp'); return root } },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args) => broadcasts.push(args) } }] },
  nativeImage: { createFromPath: () => icon, createEmpty: () => ({ isEmpty: () => true }) }
}
const remoteFs = {
  isRemote: (path) => path.startsWith('ssh://'),
  parseRemote: (path) => ({ path: new URL(path).pathname }),
  rfsStat: async (path) => {
    const item = remoteFiles.get(path)
    if (!item) throw new Error('Remote file does not exist')
    return { isDir: !!item.isDir, size: item.bytes?.length ?? 0, mtimeMs: item.mtimeMs ?? 1 }
  },
  rfsReadBytes: async (path) => {
    remoteReads.push(path)
    const item = remoteFiles.get(path)
    if (item.error) throw new Error(item.error)
    return item.bytes
  }
}
const source = await readFile(new URL('../src/main/fileDrag.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  module, exports: module.exports,
  require: (id) => ({ electron, './remoteFs': remoteFs }[id] ?? require(id))
}, { filename: 'fileDrag.ts' })
module.exports.registerFileDragIpc({
  handle: (channel, handler) => handlers.set(channel, handler),
  on: (channel, handler) => handlers.set(channel, handler)
}, () => iconPath)

function sender(id) {
  return {
    id, drags: [], errors: [], destroyed: false,
    isDestroyed() { return this.destroyed },
    startDrag(payload) { this.drags.push(payload) },
    send(...args) { this.errors.push(args) }
  }
}
const owner = sender(1)
const call = (channel, input, from = owner) => handlers.get(`fs:${channel}`)({ sender: from }, input)
const prepare = async (paths, from = owner) => {
  const result = await call('prepareDrag', paths, from)
  assert.equal(result.ok, true, result.error)
  return result
}
const check = async (name, run) => {
  try { await run(); checks++ } catch (error) { error.message = `${name}: ${error.message}`; throw error }
}
const fixture = async (name, bytes) => {
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}
const stagingFiles = async () => (await readdir(join(root, 'legal-terminal-file-drags'), { recursive: true })).sort()

try {
  await check('a native move cannot remove the original file', async () => {
    const source = await fixture('original.txt', 'keep the original')
    const result = await prepare([source])
    const entry = result.entries[0]
    assert.equal(entry.source, source)
    assert.notEqual(entry.file, source)
    assert.equal(basename(entry.file), 'original.txt')
    call('startDrag', result.id)
    assert.deepEqual(Array.from(owner.drags.at(-1).files), [entry.file])
    assert.equal(owner.drags.at(-1).file, entry.file)
    await rm(entry.file)
    assert.equal(await readFile(source, 'utf8'), 'keep the original')
  })

  await check('prepared file contents remain stable when the source changes', async () => {
    const source = await fixture('snapshot.txt', 'before')
    const result = await prepare([source])
    await writeFile(source, 'after with more bytes')
    assert.equal(await readFile(result.entries[0].file, 'utf8'), 'before')
  })

  await check('multiple files with the same name remain distinct', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    const first = await fixture('a/same.txt', 'first')
    const second = await fixture('b/same.txt', 'second')
    const result = await prepare([first, second, first])
    assert.equal(result.entries.length, 2, 'repeated source paths are deduplicated')
    assert.notEqual(result.entries[0].file, result.entries[1].file)
    assert.deepEqual(Array.from(result.entries, ({ file }) => basename(file)), ['same.txt', 'same.txt'])
    assert.deepEqual(await Promise.all(result.entries.map(({ file }) => readFile(file, 'utf8'))), ['first', 'second'])
    call('startDrag', result.id)
    assert.deepEqual(Array.from(owner.drags.at(-1).files), Array.from(result.entries, ({ file }) => file))
    const broadcast = broadcasts.at(-1)
    assert.equal(broadcast[0], 'fs:dragPrepared')
    assert.deepEqual(Array.from(broadcast[1], ({ source }) => source), [first, second])
  })

  await check('unchanged files reuse preparation and changed files refresh it', async () => {
    const source = await fixture('cache.txt', 'version one')
    const first = await prepare([source])
    assert.equal((await prepare([source])).id, first.id)
    await writeFile(source, 'version two')
    await utimes(source, new Date(10_000), new Date(10_000))
    const second = await prepare([source])
    assert.notEqual(second.id, first.id)
    assert.equal(await readFile(second.entries[0].file, 'utf8'), 'version two')
    assert.equal(await readFile(first.entries[0].file, 'utf8'), 'version one')
  })

  await check('a removed staged file is recreated on the next preparation', async () => {
    const source = await fixture('moved.txt', 'available')
    const first = await prepare([source])
    await rm(first.entries[0].file)
    const next = await prepare([source])
    assert.notEqual(next.id, first.id)
    assert.equal(await readFile(next.entries[0].file, 'utf8'), 'available')
  })

  await check('remote files become local files with their exact binary content', async () => {
    const path = 'ssh://profile/cases/evidence.pdf'
    const bytes = Buffer.from([0, 255, 37, 80, 68, 70, 10])
    remoteFiles.set(path, { bytes })
    const result = await prepare([path])
    assert.equal(result.entries[0].source, path)
    assert.equal(basename(result.entries[0].file), 'evidence.pdf')
    assert.deepEqual(await readFile(result.entries[0].file), bytes)
    assert.deepEqual(remoteReads, [path])
    assert.equal((await prepare([path])).id, result.id)
    assert.equal(remoteReads.length, 1, 'cached remote preparation avoids a second download')
    remoteFiles.set(path, { bytes: Buffer.from('new remote version'), mtimeMs: 2 })
    const refreshed = await prepare([path])
    assert.notEqual(refreshed.id, result.id)
    assert.equal(await readFile(refreshed.entries[0].file, 'utf8'), 'new remote version')
  })

  await check('a failed batch removes every partially prepared file', async () => {
    const local = await fixture('batch.txt', 'copied before the remote failure')
    const remote = 'ssh://profile/cases/failure.txt'
    remoteFiles.set(remote, { bytes: Buffer.from('unavailable'), error: 'connection lost' })
    const before = await stagingFiles()
    const broadcastCount = broadcasts.length
    const result = await call('prepareDrag', [local, remote])
    assert.equal(result.ok, false)
    assert.match(result.error, /connection lost/)
    assert.deepEqual(await stagingFiles(), before)
    assert.equal(broadcasts.length, broadcastCount, 'failed batches expose no paths to other windows')
    assert.equal(await readFile(local, 'utf8'), 'copied before the remote failure')
  })

  await check('invalid paths and local or remote directories are rejected', async () => {
    const remoteDirectory = 'ssh://profile/cases'
    remoteFiles.set(remoteDirectory, { isDir: true })
    for (const input of [null, [], 'a.txt', [12], ['relative.txt'], ['invalid\0path'], [root], [remoteDirectory], [join(root, 'missing')]]) {
      const result = await call('prepareDrag', input)
      assert.equal(result.ok, false, `accepted invalid input: ${JSON.stringify(input)}`)
      assert.equal(result.id, undefined)
    }
  })

  await check('only the window that prepared the token can start its drag', async () => {
    const result = await prepare([await fixture('owned.txt', 'owner')])
    const other = sender(2)
    for (const id of [result.id, 'missing-token', undefined, { id: result.id }]) call('startDrag', id, other)
    assert.equal(other.drags.length, 0)
    assert.equal(other.errors.length, 4)
    assert.ok(other.errors.every(([channel]) => channel === 'fs:dragError'))
    call('startDrag', result.id)
    assert.equal(owner.drags.at(-1).file, result.entries[0].file)
  })

  await check('starting native drag keeps staged files available for deferred upload', async () => {
    const result = await prepare([await fixture('deferred.txt', 'read later')])
    call('startDrag', result.id)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await readFile(result.entries[0].file, 'utf8'), 'read later')
    assert.ok((await stat(result.entries[0].file)).isFile())
  })

  await check('an absent or empty native icon reports an error without starting drag', async () => {
    const result = await prepare([await fixture('icon.txt', 'icon')])
    const count = owner.drags.length
    iconPath = undefined
    call('startDrag', result.id)
    assert.equal(owner.drags.length, count)
    assert.equal(owner.errors.at(-1)[0], 'fs:dragError')
    assert.match(owner.errors.at(-1)[1], /아이콘/)
    iconPath = '/test/icon.png'
    emptyIcon = true
    call('startDrag', result.id)
    assert.equal(owner.drags.length, count)
    assert.match(owner.errors.at(-1)[1], /아이콘/)
    emptyIcon = false
  })

  await check('a closed requesting window leaves no staged batch', async () => {
    const closed = sender(3)
    closed.destroyed = true
    const source = await fixture('closed.txt', 'cancelled')
    const before = await stagingFiles()
    const result = await call('prepareDrag', [source], closed)
    assert.equal(result.ok, false)
    assert.deepEqual(await stagingFiles(), before)
  })

  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const ipcRenderer = new EventEmitter()
  const sent = []
  let api
  let preparedResult
  ipcRenderer.invoke = async (channel, paths) => {
    assert.equal(channel, 'fs:prepareDrag')
    assert.deepEqual(Array.from(paths), ['/source/brief.pdf'])
    return preparedResult
  }
  ipcRenderer.send = (...args) => sent.push(args)
  vm.runInNewContext(ts.transpileModule(preload, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    exports: {}, process: { contextIsolated: true, platform: 'win32' }, console,
    require: (id) => {
      assert.equal(id, 'electron')
      return {
        ipcRenderer, webUtils: { getPathForFile: (file) => file.path },
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'lt'); api = value } }
      }
    }
  }, { filename: 'preload.ts' })

  await check('preload forwards preparation and native drag through their IPC channels', async () => {
    preparedResult = { ok: true, id: 'prepared-token', entries: [{ source: '/source/brief.pdf', file: 'C:\\temp\\Brief.pdf' }] }
    assert.equal(await api.fs.prepareDrag(['/source/brief.pdf']), preparedResult)
    api.fs.startDrag(preparedResult.id)
    assert.deepEqual(sent, [['fs:startDrag', 'prepared-token']])
    assert.deepEqual(Array.from(api.fs.dragPathsForFiles([{ path: 'c:/temp/brief.pdf' }])), ['/source/brief.pdf'])
  })

  await check('preload restores original paths across windows without adopting unrelated files', async () => {
    ipcRenderer.emit('fs:dragPrepared', {}, [{ source: 'ssh://profile/remote.txt', file: 'C:\\temp\\remote.txt' }])
    assert.deepEqual(Array.from(api.fs.dragPathsForFiles([{ path: 'c:/TEMP/remote.txt' }])), ['ssh://profile/remote.txt'])
    assert.deepEqual(Array.from(api.fs.dragPathsForFiles([{ path: 'C:\\temp\\Brief.pdf' }, { path: 'C:\\other.txt' }])), [])
    assert.deepEqual(Array.from(api.fs.dragPathsForFiles([])), [])
  })

  await check('preload drag error subscriptions detach cleanly', async () => {
    const errors = []
    const dispose = api.fs.onDragError((message) => errors.push(message))
    ipcRenderer.emit('fs:dragError', {}, 'failed')
    dispose()
    ipcRenderer.emit('fs:dragError', {}, 'unsubscribed')
    assert.deepEqual(errors, ['failed'])
  })

  const fileTree = await readFile(new URL('../src/renderer/src/filetree/FileTree.tsx', import.meta.url), 'utf8')
  const treeModule = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fileTree, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, {
    module: treeModule, exports: treeModule.exports, window: { lt: api },
    require: (id) => id === '../dragGuard' ? { cancelIfTerminalPointerDrag: () => false } : require(id)
  }, { filename: 'FileTree.tsx' })
  const { LT_PATH, LT_PATHS, readLtPaths } = treeModule.exports
  const transfer = (data, files = []) => ({ getData: (type) => data[type] ?? '', files })

  await check('file tree restores native source paths and preserves legacy internal drag data', async () => {
    assert.deepEqual(Array.from(readLtPaths(transfer({}, [{ path: 'c:/temp/brief.pdf' }]))), ['/source/brief.pdf'])
    assert.deepEqual(Array.from(readLtPaths(transfer({ [LT_PATHS]: '["/a", "/b", "/a"]' }))), ['/a', '/b'])
    assert.deepEqual(Array.from(readLtPaths(transfer({ [LT_PATHS]: 'invalid', [LT_PATH]: '/folder' }))), ['/folder'])
    assert.deepEqual(Array.from(readLtPaths(transfer({}, [{ path: 'C:\\unrelated.txt' }]))), [])
  })

  const parsed = ts.createSourceFile('FileTree.tsx', fileTree, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rendererHandlers = new Map()
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['startDrag', 'prepareDrag', 'rootDrop'].includes(node.name.getText(parsed))) {
      rendererHandlers.set(node.name.getText(parsed), node.initializer.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(rendererHandlers.size, 3, 'exercise the actual file tree drag handlers')

  await check('file tree starts only a prepared native drag synchronously during dragstart', async () => {
    const paths = ['/source/brief.pdf']
    const preparedDrag = { current: { key: JSON.stringify(paths), id: 'ready-token' } }
    const native = []
    const legacy = []
    const status = []
    const start = vm.runInNewContext(ts.transpileModule(`(${rendererHandlers.get('startDrag')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, {
      cancelIfTerminalPointerDrag: () => false, selectedDragPaths: () => paths, preparedDrag,
      setDragStatus: (value) => status.push(value),
      window: { lt: { fs: { startDrag: (id) => native.push(id) } } },
      writeLtPaths: (_transfer, value) => legacy.push(Array.from(value))
    })
    let prevented = 0
    const event = { stopPropagation() {}, preventDefault() { prevented++ }, dataTransfer: {} }
    start(event, { path: paths[0] })
    assert.deepEqual(native, ['ready-token'])
    assert.equal(prevented, 1)
    assert.deepEqual(legacy, [])
    preparedDrag.current = { key: JSON.stringify(paths) }
    start(event, { path: paths[0] })
    assert.deepEqual(native, ['ready-token'], 'pending preparation never starts a late native drag')
    assert.equal(preparedDrag.current.wanted, true)
    assert.match(status.at(-1), /준비 중/)
    assert.deepEqual(legacy, [paths])
    assert.equal(event.dataTransfer.effectAllowed, 'copyMove')
  })

  for (const internal of [true, false]) {
    await check(`root drop ${internal ? 'moves the staged file original' : 'copies an external file'} exactly once without bubbling`, async () => {
      const moves = []
      const copies = []
      let stopped = false
      let prevented = false
      let cleared = 0
      const files = [{ path: internal ? 'c:/temp/brief.pdf' : 'C:\\external.txt' }]
      const drop = vm.runInNewContext(ts.transpileModule(`(${rendererHandlers.get('rootDrop')})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
      }).outputText, {
        readLtPaths, root: '/destination', pathKey: (path) => path,
        clearRootDropState: () => { cleared++ },
        onMove: (...args) => moves.push(args), onDropTo: (...args) => copies.push(args)
      })
      drop({
        dataTransfer: transfer({}, files),
        preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true }
      })
      // Model the enclosing sidebar's file-drop handler only if the event bubbles.
      if (!stopped) copies.push(['/destination', files])
      assert.equal(stopped, true)
      assert.equal(prevented, true)
      assert.equal(cleared, 1)
      assert.deepEqual(moves, internal ? [['/source/brief.pdf', '/destination']] : [])
      assert.deepEqual(copies, internal ? [] : [['/destination', files]])
    })
  }

  await check('preparation reuses pending and recently ready requests, then retries expired or failed requests', async () => {
    const paths = ['/source/brief.pdf']
    const preparedDrag = { current: null }
    const requests = []
    let now = 100_000
    const prepare = vm.runInNewContext(ts.transpileModule(`(${rendererHandlers.get('prepareDrag')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, {
      selectedDragPaths: () => paths, visibleEntries: () => [{ path: paths[0], isDir: false }],
      preparedDrag, setDragStatus() {}, Date: { now: () => now },
      window: { lt: { fs: { prepareDrag: (selected) => new Promise((resolve) => requests.push({ selected, resolve })) } } }
    })
    const entry = { path: paths[0], isDir: false }
    prepare(entry)
    prepare(entry)
    assert.equal(requests.length, 1, 'a pending download is reused on the next drag attempt')
    assert.deepEqual(requests[0].selected, paths)
    requests[0].resolve({ ok: true, id: 'fresh-token' })
    await Promise.resolve()
    now += 29_999
    prepare(entry)
    assert.equal(requests.length, 1, 'a ready request is reused within 30 seconds')
    assert.equal(preparedDrag.current.id, 'fresh-token')
    now++
    prepare(entry)
    assert.equal(requests.length, 2, 'a ready request is refreshed after 30 seconds')
    requests[1].resolve({ ok: false, error: 'temporary failure' })
    await Promise.resolve()
    assert.equal(preparedDrag.current.error, 'temporary failure')
    prepare(entry)
    assert.equal(requests.length, 3, 'a failed request is retried immediately')
    requests[2].resolve({ ok: true, id: 'retried-token' })
    await Promise.resolve()
    assert.equal(preparedDrag.current.id, 'retried-token')
  })

  console.log(`file drag ok: ${checks} behavior checks`)
} finally {
  await rm(root, { recursive: true, force: true })
}
