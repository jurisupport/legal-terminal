import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import vm from 'node:vm'
import ssh2 from 'ssh2'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'lt-media-'))
const serverRoot = join(root, 'remote')
await mkdir(serverRoot)
let cacheEnabled = true
let mediaRoot = join(root, 'app')
let profile
const clients = new Set()
const handles = new Set()
const reads = new Map()
const { STATUS_CODE } = ssh2.utils.sftp
const settings = { getSettings: async () => ({ sshProfiles: [profile], remoteFileCache: cacheEnabled }) }
const app = Object.assign(new EventEmitter(), { getPath: () => mediaRoot })
const electron = { app, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) } }

async function load(relative, mocks = {}, extra = '', transform = (s) => s) {
  const source = transform(await readFile(new URL(`../src/${relative}`, import.meta.url), 'utf8'))
  const code = ts.transpileModule(source + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
    Buffer, process, console, setTimeout, clearTimeout, AbortController, AbortSignal,
    URL, Response, Request, Uint8Array
  }, { filename: relative })
  return module.exports
}
const shared = await load('shared/media.ts')
const pool = await load('main/sshConnectionPool.ts')
let acceptHostKey = false
let hostKeyPrompts = 0
let authenticationCalls = 0
const hostKeys = await load('main/sshHostKeys.ts', { electron: {
  app: { getPath: () => join(root, 'trust') },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [] },
  dialog: { showMessageBox: async (_parent, options) => {
    hostKeyPrompts++
    assert.equal(options.defaultId, 0)
    assert.equal(options.cancelId, 0)
    assert.match(options.detail, /SHA256:/)
    return { response: acceptHostKey ? 1 : 0 }
  } }
} })
const remote = await load('main/remoteFs.ts', {
  './settings': settings, './sshConnectionPool': pool, './sshHostKeys': hostKeys,
  './remoteDirListCache': { invalidateRemoteDirListCache() {} },
  './remoteFileCache': { readRemoteFileCache: async () => undefined, rememberRemoteFileCache() {}, invalidateRemoteFileCache() {} }
}, '\nexport { connect as connectForTest, sftpRequest as sftpRequestForTest }\n')
const mediaMocks = { electron, './settings': settings, './remoteFs': remote, '../shared/media': shared }
const fastGrace = (source) => source.replace('const EPHEMERAL_GRACE_MS = 10_000', 'const EPHEMERAL_GRACE_MS = 50')
const media = await load('main/media.ts', mediaMocks, '', fastGrace)
const handlers = new Map()
media.registerMediaIpc({ handle: (name, fn) => handlers.set(name, fn) })
const sender = (id) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send() {} })
const a = sender(1), b = sender(2)
const call = (owner, method, input) => handlers.get(`media:${method}`)({ sender: owner }, input)
let protocolHandler, ownerGuard
media.registerMediaProtocol({
  protocol: { handle: (_scheme, fn) => { protocolHandler = fn } },
  webRequest: { onBeforeRequest: (_filter, fn) => { ownerGuard = fn } }
})
const allowed = (url, webContentsId, frame) => { let result; ownerGuard({ url, webContentsId, frame }, (r) => { result = !r.cancel }); return result }
const request = (url, range, method = 'GET') => protocolHandler(new Request(url, { method, headers: range ? { range } : {} }))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const noParts = async () => assert.equal((await readdir(join(mediaRoot, 'media-review/files'))).filter((f) => f.endsWith('.part')).length, 0)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const key = ssh2.utils.generateKeyPairSync('ed25519')
await writeFile(join(root, 'key'), key.private, { mode: 0o600 })
const server = new ssh2.Server({ hostKeys: [key.private] }, (client) => {
  clients.add(client)
  client.on('error', () => {})
  client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => { authenticationCalls++; context.accept() })
  client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => {
    const sftp = acceptSftp()
    const pathFor = (path) => join(serverRoot, path)
    const attrs = (s) => ({ size: s.size, mode: s.mode, uid: s.uid, gid: s.gid, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) })
    const fail = (id, error) => { if (!sftp.destroyed) sftp.status(id, error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE) }
    for (const action of ['STAT', 'LSTAT']) sftp.on(action, (id, path) => { void stat(pathFor(path)).then((s) => sftp.attrs(id, attrs(s)), (e) => fail(id, e)) })
    sftp.on('REALPATH', (id, path) => {
      void realpath(pathFor(path)).then((p) => sftp.name(id, [{ filename: '/' + p.slice(serverRoot.length + 1), longname: '', attrs: {} }]), (e) => fail(id, e))
    })
    const openHandles = new Map()
    sftp.on('OPEN', (id, path, flags) => {
      const mode = (flags & 2) ? ((flags & 8) ? 'w' : 'r+') : 'r'
      void open(pathFor(path), mode).then((handle) => {
        const name = Buffer.from(`${id}:${path}`)
        openHandles.set(name.toString(), { handle, path })
        handles.add(handle)
        if (mode === 'r') reads.set(path, (reads.get(path) ?? 0) + 1)
        sftp.handle(id, name)
      }, (e) => fail(id, e))
    })
    sftp.on('READ', (id, token, offset, length) => {
      const item = openHandles.get(token.toString())
      if (!item) { fail(id); return }
      if (item.path.includes('disconnect') && offset > 32_768) { client.end(); return }
      const read = () => {
        const bytes = Buffer.alloc(Math.min(length, 65_536))
        void item.handle.read(bytes, 0, bytes.length, offset).then(({ bytesRead }) => {
          if (sftp.destroyed) return
          if (bytesRead) sftp.data(id, bytes.subarray(0, bytesRead))
          else sftp.status(id, STATUS_CODE.EOF)
        }, (e) => fail(id, e))
      }
      if (item.path.includes('slow')) setTimeout(read, 10)
      else read()
    })
    sftp.on('WRITE', (id, token, offset, data) => {
      const item = openHandles.get(token.toString())
      if (!item) { fail(id); return }
      void item.handle.write(data, 0, data.length, offset).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e))
    })
    sftp.on('CLOSE', (id, token) => {
      const item = openHandles.get(token.toString())
      if (!item) { fail(id); return }
      openHandles.delete(token.toString())
      handles.delete(item.handle)
      void item.handle.close().then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e))
    })
    sftp.on('MKDIR', (id, path) => { void mkdir(pathFor(path)).then(() => sftp.status(id, STATUS_CODE.OK), (e) => fail(id, e)) })
    sftp.on('OPENDIR', (id) => fail(id))
  })))
})

try {
  const closedSftp = Object.assign(new EventEmitter(), { readable: false })
  await assert.rejects(remote.sftpRequestForTest(closedSftp, () => assert.fail('closed request started')), /종료/)
  const stalledSftp = new EventEmitter()
  await assert.rejects(remote.sftpRequestForTest(stalledSftp, () => {}, 5), /초과/)
  assert.equal(stalledSftp.listenerCount('end'), 0)
  assert.equal(stalledSftp.listenerCount('close'), 0)
  const disconnected = remote.sftpRequestForTest(stalledSftp, () => {})
  stalledSftp.emit('end')
  await assert.rejects(disconnected, /종료/)
  assert.equal(stalledSftp.listenerCount('close'), 0)
  console.log('SFTP prerequisites: EOF, request timeout and disconnect reject without leaked listeners')

  const local = join(root, 'clip.mp4')
  await writeFile(local, 'old-video-contents')
  const first = await call(a, 'open', { path: local, requestId: 'local' })
  assert.equal(first.versionId, sha('old-video-contents'))
  assert.equal(allowed(first.url, 1), true)
  assert.equal(allowed(first.url, 2), false)
  assert.equal(allowed(first.url, 1, { parent: {} }), false)
  assert.equal(allowed('lt-media://snapshot/../../etc/passwd', 1), false)
  assert.equal(await (await request(first.url, 'bytes=4-8')).text(), 'video')
  assert.equal((await request(first.url, 'bytes=4-8')).status, 206)
  assert.equal(await (await request(first.url, 'bytes=-8')).text(), 'contents')
  assert.equal((await request(first.url, undefined, 'HEAD')).headers.get('content-length'), '18')
  for (const range of ['bytes=3-2', 'bytes=99-', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-999999999999999999999']) assert.equal((await request(first.url, range)).status, 416, range)
  const previousStat = await stat(local)
  await writeFile(local, 'new-video-contents')
  await utimes(local, previousStat.atime, previousStat.mtime)
  const second = await call(a, 'open', { path: local, requestId: 'force', force: true })
  assert.notEqual(first.versionId, second.versionId)
  assert.equal(await (await request(first.url)).text(), 'old-video-contents', 'open review is immutable')
  assert.equal(await (await request(second.url)).text(), 'new-video-contents')
  const diskIndex = JSON.parse(await readFile(join(mediaRoot, 'media-review/index.json'), 'utf8'))
  const secondRecord = diskIndex.records.find((r) => r.versionId === second.versionId)
  await rm(join(mediaRoot, 'media-review/files', secondRecord.file))
  assert.equal((await request(second.url)).status, 410)
  const repaired = await call(a, 'open', { path: local, requestId: 'repair', force: true })
  assert.equal(repaired.versionId, second.versionId)
  assert.equal(await (await request(repaired.url)).text(), 'new-video-contents', 'force refresh repairs missing cached body')
  const past = await call(b, 'open', { path: local, requestId: 'past', versionId: first.versionId })
  assert.equal(past.versionId, first.versionId)
  assert.equal((await call(a, 'versions', local)).length, 2)
  await call(b, 'release', first.token)
  assert.equal(allowed(first.url, 1), true, 'another owner cannot release token')
  await call(a, 'release', first.token)
  assert.equal((await request(first.url)).status, 404)
  await assert.rejects(call(a, 'open', { path: local, requestId: 'expired', versionId: 'f'.repeat(64) }), /만료/)
  await noParts()
  console.log('Snapshots: immutable content hashes, force refresh, history, byte ranges, ownership and expired tokens pass')

  await mkdir(join(root, '.legal-terminal'))
  const manifestPath = join(root, '.legal-terminal/media.json')
  await writeFile(local, 'completed-render')
  let manifest = { version: 1, engine: 'ffmpeg', completed: { version: 'v2', path: 'clip.mp4', completedAt: new Date().toISOString() } }
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal((await call(a, 'check', { path: local, versionId: second.versionId, projectDir: root })).completed, true)
  manifest.completed.completedAt = new Date(0).toISOString()
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal((await call(a, 'check', { path: local, versionId: second.versionId, projectDir: root })).completed, false)
  manifest.completed.path = '../outside.mp4'
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal((await call(a, 'check', { path: local, versionId: second.versionId, projectDir: root })).completed, false)
  await symlink(local, join(root, 'alias.mp4'))
  console.log('Completion: explicit success marker required; stale markers and path escapes rejected')

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  profile = { id: 'test', host: '127.0.0.1', port: server.address().port, user: 'test', identityFile: join(root, 'key') }
  await assert.rejects(remote.connectForTest('test'), /거절/)
  assert.equal(authenticationCalls, 0, 'rejected server key must block authentication')
  acceptHostKey = true
  const trustedConnection = await remote.connectForTest('test')
  trustedConnection.client.end()
  assert.ok(authenticationCalls > 0)
  assert.equal(hostKeyPrompts, 2)
  const changedKey = ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync('ed25519').private).getPublicSSH()
  await assert.rejects(hostKeys.verifySshHostKey(profile, changedKey, new AbortController().signal), /서버키가 변경/)
  assert.equal(hostKeyPrompts, 2, 'changed server key must not prompt for replacement')
  console.log('SSH identity: rejection blocks authentication, explicit approval persists and changed keys fail closed')
  const remotePath = 'ssh://test/slow.mp4'
  await writeFile(join(serverRoot, 'slow.mp4'), Buffer.alloc(4 * 1024 ** 2, 65))
  const p1 = call(a, 'open', { path: remotePath, requestId: 'shared-one' })
  const p2 = call(b, 'open', { path: remotePath, requestId: 'shared-two' })
  const rejected = assert.rejects(p1, /취소|abort/i)
  while (!(reads.get('/slow.mp4') > 0)) await tick()
  await call(a, 'cancel', 'shared-one')
  const downloaded = await p2
  await rejected
  assert.equal(reads.get('/slow.mp4'), 1, 'consumers share one download')
  assert.equal(hostKeyPrompts, 2, 'saved server key avoids repeated prompts')
  const cached = await call(a, 'open', { path: remotePath, requestId: 'cached' })
  assert.equal(cached.versionId, downloaded.versionId)
  assert.equal(reads.get('/slow.mp4'), 1, 'cache hit skips remote body')
  const reconnect = sender(3)
  const restoredHandlers = new Map()
  const restarted = await load('main/media.ts', mediaMocks)
  restarted.registerMediaIpc({ handle: (name, fn) => restoredHandlers.set(name, fn) })
  const restored = await restoredHandlers.get('media:open')({ sender: reconnect }, { path: remotePath, requestId: 'restored', versionId: downloaded.versionId })
  assert.equal(restored.versionId, downloaded.versionId, 'metadata survives restart')
  console.log('SFTP: shared transfer, independent cancellation, zero-body cache hit and persisted version lookup pass')

  await writeFile(join(serverRoot, 'same-signature.mp4'), 'content-one')
  const fixedTime = Math.floor(Date.now() / 1000)
  await utimes(join(serverRoot, 'same-signature.mp4'), fixedTime, fixedTime)
  const signatureOld = await call(a, 'open', { path: 'ssh://test/same-signature.mp4', requestId: 'signature-old' })
  await writeFile(join(serverRoot, 'same-signature.mp4'), 'content-two')
  await utimes(join(serverRoot, 'same-signature.mp4'), fixedTime, fixedTime)
  const signatureNew = await call(a, 'open', { path: signatureOld.sourcePath, requestId: 'signature-new', force: true })
  assert.notEqual(signatureOld.versionId, signatureNew.versionId)
  const oldAgain = await call(a, 'open', { path: signatureOld.sourcePath, requestId: 'old-again', versionId: signatureOld.versionId })
  await call(a, 'release', oldAgain.token)
  const stillCurrent = await call(a, 'open', { path: signatureOld.sourcePath, requestId: 'still-current' })
  assert.equal(stillCurrent.versionId, signatureNew.versionId, 'visiting old history must not select stale same-signature snapshot')
  assert.equal(reads.get('/same-signature.mp4'), 2, 'latest forced version reused without body download')

  const cancelled = call(a, 'open', { path: remotePath, requestId: 'cancel-last', force: true })
  const cancelledCheck = assert.rejects(cancelled, /취소|abort/i)
  while ((reads.get('/slow.mp4') ?? 0) < 2) await tick()
  await call(a, 'cancel', 'cancel-last')
  await cancelledCheck
  await new Promise((resolve) => setTimeout(resolve, 80))
  await noParts()
  assert.equal((await remote.rfsStat(remotePath)).size, 4 * 1024 ** 2, 'cancel does not destroy shared SSH')
  await writeFile(join(serverRoot, 'disconnect.mp4'), Buffer.alloc(1024 ** 2))
  await assert.rejects(call(a, 'open', { path: 'ssh://test/disconnect.mp4', requestId: 'disconnect' }), /종료|closed|end|connection|No response/i)
  await noParts()
  assert.equal((await remote.rfsStat(remotePath)).size, 4 * 1024 ** 2, 'connection recovers')
  const refused = join(root, 'existing.part')
  await writeFile(refused, 'preserve me')
  await assert.rejects(remote.rfsDownloadToFile(remotePath, refused, { signal: new AbortController().signal }), /EEXIST/)
  assert.equal(await readFile(refused, 'utf8'), 'preserve me')
  console.log('Failures: last-consumer cancel and actual SSH disconnect remove partial files, preserve reviews and allow retry')

  await writeFile(join(serverRoot, 'changing.mp4'), Buffer.alloc(1024 ** 2, 12))
  let mutated = false
  a.send = (_channel, progress) => {
    if (progress.requestId === 'mutation' && progress.downloadedBytes > 0 && !mutated) {
      mutated = true
      const future = new Date(Date.now() + 10_000)
      utimesSync(join(serverRoot, 'changing.mp4'), future, future)
    }
  }
  await assert.rejects(call(a, 'open', { path: 'ssh://test/changing.mp4', requestId: 'mutation' }), /변경/)
  a.send = () => {}
  await noParts()
  assert.equal((await call(a, 'versions', 'ssh://test/changing.mp4')).length, 0)

  const skewTime = Math.floor(Date.now() / 1000) - 86400
  await writeFile(join(serverRoot, 'skew-one.mp4'), 'clock-one')
  await utimes(join(serverRoot, 'skew-one.mp4'), skewTime, skewTime)
  const skew = await call(a, 'open', { path: 'ssh://test/skew-one.mp4', requestId: 'skew' })
  await writeFile(join(serverRoot, 'skew-two.mp4'), 'clock-two')
  await utimes(join(serverRoot, 'skew-two.mp4'), skewTime + 1, skewTime + 1)
  await mkdir(join(serverRoot, '.legal-terminal'), { recursive: true })
  await writeFile(join(serverRoot, '.legal-terminal/media.json'), JSON.stringify({ version: 1, engine: 'remotion', completed: { version: 'next', path: 'skew-two.mp4', completedAt: new Date((skewTime + 2) * 1000).toISOString() } }))
  const skewCheck = await call(a, 'check', { path: skew.sourcePath, versionId: skew.versionId, projectDir: 'ssh://test/' })
  assert.equal(skewCheck.completed, true, 'remote clock 24 hours behind local still detects completion')
  assert.equal(skewCheck.path, 'ssh://test/skew-two.mp4')
  console.log('Consistency: mid-transfer source mutation rejected; remote-clock completion compared within source clock domain')

  const uploadBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64'))
  const captured = await call(a, 'saveCapture', { bytes: uploadBytes, targetDir: 'ssh://test/' })
  assert.match(captured.path, /^ssh:\/\/test\/\.legal-terminal\/media-context\/.+\.png$/)
  assert.equal((await remote.rfsStat(captured.path)).size, uploadBytes.length)
  await assert.rejects(call(a, 'saveCapture', { bytes: Uint8Array.of(1, 2, 3) }), /PNG|JPEG/)
  await assert.rejects(call(a, 'saveCapture', { bytes: new Uint8Array(5 * 1024 ** 2 + 1) }), /5MiB/)
  cacheEnabled = false
  await writeFile(join(serverRoot, 'ephemeral.mp3'), 'audio-preview')
  const ephemeral = await call(a, 'open', { path: 'ssh://test/ephemeral.mp3', requestId: 'ephemeral' })
  await call(a, 'release', ephemeral.token)
  const moved = await call(b, 'open', { path: ephemeral.sourcePath, requestId: 'moved', versionId: ephemeral.versionId })
  assert.equal(moved.versionId, ephemeral.versionId, 'short detach/reopen gap keeps ephemeral review')
  await call(b, 'release', moved.token)
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal((await call(a, 'versions', ephemeral.sourcePath)).length, 0)
  console.log('Captures: verified remote upload, format/size rejection; opt-out cache cleaned after release')

  const bigSize = 512 * 1024 ** 2
  const large = await open(join(serverRoot, 'large.mp4'), 'w')
  await large.truncate(bigSize)
  await large.close()
  let peakRss = process.memoryUsage().rss
  const baselineRss = peakRss
  const started = performance.now()
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 5)
  const result = await remote.rfsDownloadToFile('ssh://test/large.mp4', join(root, 'large.part'), { signal: new AbortController().signal })
  clearInterval(sample)
  const expected = createHash('sha256')
  const zero = Buffer.alloc(1024 ** 2)
  for (let i = 0; i < 512; i++) expected.update(zero)
  assert.equal(result.sha256, expected.digest('hex'))
  assert.equal(result.size, bigSize)
  assert.ok(peakRss - baselineRss < 128 * 1024 ** 2, `RSS grew ${(peakRss - baselineRss) / 1024 ** 2} MiB`)
  console.log(`512MiB real loopback SFTP: hash/size verified; ${((performance.now() - started) / 1000).toFixed(1)}s; peak RSS growth ${((peakRss - baselineRss) / 1024 ** 2).toFixed(1)}MiB`)

  // Test the same eviction rules at a small disk budget; app-owned files only.
  mediaRoot = join(root, 'small-cache')
  cacheEnabled = true
  const small = await load('main/media.ts', mediaMocks, '', (s) => s.replace('const MAX_CACHE_BYTES = 2 * 1024 ** 3', 'const MAX_CACHE_BYTES = 4096'))
  const smallHandlers = new Map()
  small.registerMediaIpc({ handle: (name, fn) => smallHandlers.set(name, fn) })
  const invoke = (method, input) => smallHandlers.get(`media:${method}`)({ sender: a }, input)
  const samplePath = join(root, 'sample.mp4')
  await writeFile(samplePath, Buffer.alloc(1500, 1))
  const old = await invoke('open', { path: samplePath, requestId: 'small-old' })
  await writeFile(samplePath, Buffer.alloc(1500, 2))
  const next = await invoke('open', { path: samplePath, requestId: 'small-new', force: true })
  await invoke('release', old.token)
  const third = join(root, 'third.mp4')
  await writeFile(third, Buffer.alloc(1500))
  await assert.rejects(invoke('open', { path: third, requestId: 'full' }), /공간/)
  assert.equal((await invoke('versions', samplePath)).length, 2, 'active and previous version protected')
  await invoke('release', next.token)
  await invoke('open', { path: third, requestId: 'available' })
  assert.equal((await stat(samplePath)).size, 1500, 'never delete source files')
  await noParts()
  console.log('Cache budget: active/current comparison pinned, unused snapshots evicted, source files untouched')

  mediaRoot = join(root, 'disk-full')
  const failingMedia = await load('main/media.ts', { ...mediaMocks, fs: {
    ...require('node:fs'),
    createWriteStream(path) {
      writeFileSync(path, 'partial')
      return new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) } })
    }
  } })
  const failingHandlers = new Map()
  failingMedia.registerMediaIpc({ handle: (name, fn) => failingHandlers.set(name, fn) })
  await assert.rejects(failingHandlers.get('media:open')({ sender: a }, { path: samplePath, requestId: 'disk-full' }), /disk full/)
  await noParts()
  assert.equal((await failingHandlers.get('media:versions')({}, samplePath)).length, 0)
  console.log('Disk-full failure injection: no published snapshot or abandoned partial file')
} finally {
  remote.disposeRemote()
  for (const client of clients) client.end()
  if (profile) await new Promise((resolve) => server.close(resolve))
  await Promise.all([...handles].map((handle) => handle.close().catch(() => {})))
  await rm(root, { recursive: true, force: true })
}
