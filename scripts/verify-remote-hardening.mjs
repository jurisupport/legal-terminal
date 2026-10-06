import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import ssh2 from 'ssh2'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'lt-remote-hardening-'))
async function load(file, mocks, globals = {}, extra = '') {
  const source = await readFile(new URL(`../src/main/${file}`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
    Buffer, process, console, setTimeout, clearTimeout, AbortController, AbortSignal, ...globals
  }, { filename: file })
  return module.exports
}

let timeoutMs = 30_000
let prompt = async () => ({ response: 1 })
let promptCount = 0
const hostKeys = await load('sshHostKeys.ts', {
  electron: {
    app: { getPath: () => root },
    BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [] },
    dialog: { showMessageBox: (_window, options) => { promptCount++; return prompt(options) } }
  }
}, { AbortSignal: { any: (signals) => AbortSignal.any(signals), timeout: () => AbortSignal.timeout(timeoutMs) } })

let fakeSftp
let profile
const cached = []
const remote = await load('remoteFs.ts', {
  './settings': { getSettings: async () => ({ sshProfiles: [profile] }) },
  './sshHostKeys': hostKeys,
  './sshConnectionPool': {
    SshConnectionPool: class {
      constructor(connect) { this.connect = connect }
      get(id) { return fakeSftp ? Promise.resolve({ sftp: fakeSftp }) : this.connect(id) }
      discard() {}
    }
  },
  './remoteDirListCache': { invalidateRemoteDirListCache() {} },
  './remoteFileCache': {
    invalidateRemoteFileCache() {},
    rememberRemoteFileCache: (...args) => cached.push(args)
  }
}, {}, '\nexport { connect as connectForTest }\n')

const key = ssh2.utils.generateKeyPairSync('ed25519')
const changedKey = ssh2.utils.generateKeyPairSync('ed25519')
await writeFile(join(root, 'client-key'), key.private, { mode: 0o600 })
const serverClients = new Set()
let authenticationCalls = 0
let server
let configureSftp = () => {}
async function startServer(privateKey, port = 0) {
  server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    serverClients.add(client)
    client.on('error', () => {})
    client.on('close', () => serverClients.delete(client))
    client.on('authentication', (context) => { authenticationCalls++; context.accept() })
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => configureSftp(acceptSftp(), client))
    }))
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  profile = { id: 'test', host: '127.0.0.1', port: server.address().port, user: 'test', identityFile: join(root, 'client-key') }
}
async function stopServer() {
  for (const client of serverClients) client.end()
  if (server) await new Promise((resolve) => server.close(resolve))
  server = undefined
}
const trustFiles = () => readdir(join(root, 'ssh-host-keys')).catch(() => [])

try {
  await startServer(key.private)
  prompt = async (options) => {
    assert.equal(authenticationCalls, 0, 'user authentication must wait for approval')
    assert.equal(options.defaultId, 0)
    assert.equal(options.cancelId, 0)
    assert.match(options.detail, /SHA256:/)
    return { response: 0 }
  }
  await assert.rejects(remote.connectForTest('test'), /거절/)
  assert.equal(authenticationCalls, 0, 'rejected key must send no authentication')
  assert.equal((await trustFiles()).length, 0)

  let lateApproval
  timeoutMs = 50
  prompt = () => new Promise((resolve) => { lateApproval = resolve })
  await assert.rejects(remote.connectForTest('test'), /초과|Timeout/)
  lateApproval({ response: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(authenticationCalls, 0, 'approval timeout must send no authentication')
  assert.equal((await trustFiles()).length, 0, 'late approval must not persist trust')

  timeoutMs = 30_000
  prompt = async () => {
    assert.equal(authenticationCalls, 0)
    return { response: 1 }
  }
  const first = await remote.connectForTest('test')
  assert.ok(authenticationCalls > 0, 'approved handshake reaches authentication')
  first.client.destroy()
  const count = promptCount
  const known = await remote.connectForTest('test')
  known.client.destroy()
  assert.equal(promptCount, count, 'saved server key should not prompt again')
  assert.equal((await trustFiles()).length, 1)

  const port = profile.port
  await stopServer()
  await startServer(changedKey.private, port)
  authenticationCalls = 0
  await assert.rejects(remote.connectForTest('test'), /서버키가 변경/)
  assert.equal(authenticationCalls, 0, 'changed host key must send no authentication')
  assert.equal(promptCount, count, 'changed keys cannot be approved as new keys')
  await stopServer()

  // Trust is scoped by host, port and key algorithm, independently of profile/user.
  const raw = ssh2.utils.parseKey(key.private).getPublicSSH()
  const fingerprintPath = (host, port, type) => join(root, 'ssh-host-keys', createHash('sha256').update(JSON.stringify([host, port, type])).digest('hex'))
  prompt = async () => ({ response: 1 })
  await hostKeys.verifySshHostKey({ host: 'other.example', port }, raw, new AbortController().signal)
  await hostKeys.verifySshHostKey({ host: profile.host, port: port + 1 }, raw, new AbortController().signal)
  assert.ok((await readFile(fingerprintPath('other.example', port, 'ssh-ed25519'), 'utf8')).length)
  assert.equal((await trustFiles()).length, 3)
  console.log('SSH: real handshake rejects changed/rejected/timed-out keys before authentication; approved keys persist')

  const target = '/docs/서면.md'
  const original = 'original text'
  const content = '새 서면 내용'
  const baseline = { size: Buffer.byteLength(original), mtimeMs: 10_000 }
  const error = (message, code) => Object.assign(new Error(message), { code })
  const unicodeDirectory = '자료'.normalize('NFD')
  const unicodeFilename = '서면.md'.normalize('NFD')
  const unicodePath = `/${unicodeDirectory}/${unicodeFilename}`
  const unicodeReads = []
  fakeSftp = Object.assign(new EventEmitter(), {
    readable: true,
    lstat(path, callback) { callback(path === unicodePath ? undefined : error('missing', 2), {}) },
    readdir(path, callback) {
      unicodeReads.push(path)
      const filename = path === '/' ? unicodeDirectory : path === `/${unicodeDirectory}` ? unicodeFilename : undefined
      callback(filename ? undefined : error('missing', 2), filename ? [{ filename }] : [])
    },
    realpath(path, callback) {
      assert.equal(path, unicodePath, 'realpath uses the actual decomposed file name after Unicode fallback')
      callback(undefined, `/canonical${path}`)
    }
  })
  assert.equal(await remote.rfsRealpath('ssh://test/자료/서면.md'), `ssh://test/canonical${unicodePath}`)
  assert.deepEqual(unicodeReads, ['/', `/${unicodeDirectory}`])

  function storage(mode) {
    const files = new Map(mode === 'new' || mode === 'new-race' ? [] : [[target, { text: original, mtime: 10, mode: 0o100640, uid: 1001, gid: 2002 }]])
    const calls = []
    let destinationStats = 0
    const attrs = (file) => ({ size: Buffer.byteLength(file.text), mtime: file.mtime, mode: file.mode, uid: file.uid, gid: file.gid, isFile: () => true })
    const api = {
      realpath(path, callback) { callback(files.has(path) ? undefined : error('missing', 2), path) },
      stat(path, callback) {
        calls.push(['stat', path])
        if (path === target) {
          destinationStats++
          if (mode === 'stat-failure') return callback(error('denied', 3))
        }
        const file = files.get(path)
        callback(file ? undefined : error('missing', 2), file && attrs(file))
      },
      open(path, flags, permissions, callback) {
        calls.push(['open', path])
        assert.equal(posix.dirname(path), posix.dirname(target))
        assert.equal(flags, 'wx')
        assert.equal(permissions, 0o600)
        if (mode === 'open-failure') return callback(error('denied', 3))
        files.set(path, { text: '', mtime: 20, mode: 0o100000 | permissions, uid: 1001, gid: 1001 })
        callback(undefined, Buffer.from(path))
      },
      write(handle, data, _offset, _length, _position, callback) {
        files.get(handle.toString()).text = mode === 'upload-failure' || mode === 'short-upload' ? 'part' : data.toString()
        if (mode === 'concurrent' || mode === 'new-race') files.set(target, { text: 'someone else', mtime: 15, mode: 0o100640 })
        if (mode === 'deleted') files.delete(target)
        callback(mode === 'upload-failure' ? error('connection lost', 7) : undefined)
      },
      fchmod(handle, permissions, callback) {
        files.get(handle.toString()).mode = 0o100000 | permissions
        callback(mode === 'chmod-failure' ? error('denied', 3) : undefined)
      },
      fstat(handle, callback) { callback(undefined, attrs(files.get(handle.toString()))) },
      fchown(handle, uid, gid, callback) {
        if (mode === 'chown-failure') return callback(error('ownership denied', 3))
        Object.assign(files.get(handle.toString()), { uid, gid })
        callback()
      },
      close(_handle, callback) { callback(mode === 'close-failure' ? error('close failed', 4) : undefined) },
      ext_openssh_rename(source, destination, callback) {
        calls.push(['atomic-rename', source, destination])
        if (mode === 'unsupported') throw error('Server does not support this extended request', 8)
        if (mode === 'rename-failure') return callback(error('rename failed', 4))
        if (mode === 'rename-disconnect') { this.readable = false; this.emit('end'); return }
        files.set(destination, files.get(source))
        files.delete(source)
        if (mode === 'after-rename') files.set(target, { text: 'later writer', mtime: 40, mode: 0o100640 })
        callback()
      },
      rename(source, destination, callback) {
        calls.push(['rename', source, destination])
        assert.ok(!files.has(destination), 'non-atomic rename is only for new destinations')
        files.set(destination, files.get(source))
        files.delete(source)
        callback()
      },
      unlink(path, callback) {
        calls.push(['unlink', path])
        assert.notEqual(path, target, 'original must never be unlinked')
        files.delete(path)
        callback()
      }
    }
    return { api: Object.assign(new EventEmitter(), api, { readable: true }), files, calls, get destinationStats() { return destinationStats } }
  }

  for (const mode of ['upload-failure', 'short-upload', 'unsupported', 'rename-failure', 'rename-disconnect', 'concurrent', 'deleted', 'open-failure', 'chown-failure', 'chmod-failure', 'close-failure', 'stat-failure', 'initial-conflict', 'new-race']) {
    const state = storage(mode)
    fakeSftp = state.api
    const expected = mode === 'new-race' ? undefined : mode === 'initial-conflict' ? { ...baseline, size: 1 } : baseline
    const cacheCount = cached.length
    await assert.rejects(remote.rfsWriteText(`ssh://test${target}`, content, expected), (failure) => {
      if (['concurrent', 'deleted', 'initial-conflict', 'new-race'].includes(mode)) assert.ok(failure instanceof remote.RemoteFileConflict)
      return true
    })
    assert.equal(state.files.get(target)?.text, mode === 'deleted' ? undefined : mode === 'concurrent' || mode === 'new-race' ? 'someone else' : original, mode)
    assert.equal([...state.files.keys()].filter((path) => path !== target).length, mode === 'rename-disconnect' ? 1 : 0, `${mode}: temporary cleaned up when connection survives`)
    assert.equal(cached.length, cacheCount, `${mode}: failure must not cache attempted content`)
    if (mode === 'initial-conflict') assert.ok(!state.calls.some(([name]) => name === 'open'))
  }
  for (const mode of ['success', 'after-rename', 'new', 'no-expected', 'symlink']) {
    const state = storage(mode)
    fakeSftp = state.api
    if (mode === 'symlink') fakeSftp.realpath = (_path, callback) => callback(undefined, target)
    const result = await remote.rfsWriteText(`ssh://test${mode === 'symlink' ? '/docs/link.md' : target}`, content, ['new', 'no-expected'].includes(mode) ? undefined : baseline)
    assert.equal(result.size, Buffer.byteLength(content))
    assert.equal(result.mtimeMs, 20_000, 'success signature belongs to uploaded file, not a later writer')
    assert.equal(state.files.get(target).text, mode === 'after-rename' ? 'later writer' : content)
    assert.equal(state.files.get(target).mode, mode === 'new' ? 0o100600 : 0o100640)
    if (mode !== 'after-rename') {
      assert.equal(state.files.get(target).uid, 1001)
      assert.equal(state.files.get(target).gid, mode === 'new' ? 1001 : 2002)
    }
    assert.equal(state.destinationStats, 2, 'check destination before upload and again before replacement only')
    assert.equal(cached.at(-1)[1], `test\0${target}\0${Buffer.byteLength(content)}:20`)
  }

  // Exercise the real IPC handler as well: it must not re-stat a successful remote write.
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let handler
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' && node.arguments[0]?.text === 'fs:writeText') handler = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(handler)
  const ipc = vm.runInNewContext(ts.transpileModule(`(${handler.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    isRemote: remote.isRemote, rfsWriteText: remote.rfsWriteText, RemoteFileConflict: remote.RemoteFileConflict,
    statFileSignature: () => assert.fail('remote IPC must use the uploaded signature')
  })
  fakeSftp = storage('after-rename').api
  const saved = await ipc({}, { path: `ssh://test${target}`, content, expected: baseline })
  assert.equal(saved.ok, true)
  assert.equal(saved.stat.mtimeMs, 20_000)
  fakeSftp = storage('concurrent').api
  const conflict = await ipc({}, { path: `ssh://test${target}`, content, expected: baseline })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict, true)
  console.log('SFTP: upload/rename/conflict failures preserve originals; metadata, modes, new files and IPC verified')

  // A real transport closure rejects pending requests once. Cleanup must not queue
  // new requests on that closed channel and wait forever for another callback.
  configureSftp = (sftp, client) => {
    const attrs = { size: 8, uid: 1001, gid: 2002, mode: 0o100640, atime: 10, mtime: 10 }
    sftp.on('REALPATH', (id, path) => sftp.name(id, [{ filename: path, longname: path, attrs }]))
    sftp.on('STAT', (id) => sftp.attrs(id, attrs))
    sftp.on('OPEN', (id, path) => sftp.handle(id, Buffer.from(path)))
    sftp.on('WRITE', () => client.end())
  }
  await startServer(key.private)
  fakeSftp = undefined
  const live = await remote.connectForTest('test')
  fakeSftp = live.sftp
  let deadline
  try {
    await assert.rejects(Promise.race([
      remote.rfsWriteText('ssh://test/docs/doc.md', 'new text', { size: 8, mtimeMs: 10_000 }),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('SAVE STILL PENDING')), 1500) })
    ]), /연결이 종료/)
    assert.equal(live.sftp.readable, false)
    assert.equal(Object.keys(live.sftp._requests).length, 0, 'no abandoned cleanup request after transport closure')
  } finally {
    clearTimeout(deadline)
    live.client.destroy()
  }
  console.log('SFTP: real SSH disconnect during upload settles save failure without hanging cleanup')
} finally {
  await stopServer()
  await rm(root, { recursive: true, force: true })
}
