import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import ssh2 from 'ssh2'

const require = createRequire(import.meta.url)
const key = ssh2.utils.generateKeyPairSync('ed25519')
const client = new ssh2.Client()
const bindings = new Map()
const serverPeers = new Set()
const serverSockets = new Set()
let serverPeer, profile = { id: 'office', host: 'saved.example', user: 'saved-user', port: 2222, identityFile: '/saved/key', remoteControl: true }
let connectionRequests = 0, failForward = false, holdForward = false, heldForward = false, disconnects = 0, requests = 0
let onConnect, discarded = 0
const home = '/home/test'
const directories = new Map([[home, 'directory']])
let aliasedPath
const sftp = new EventEmitter()
sftp.realpath = (path, done) => done(null, path === '.' ? home : path === aliasedPath ? '/outside' : path)
sftp.lstat = (path, done) => {
  const kind = directories.get(path)
  if (!kind) done(Object.assign(new Error('missing'), { code: 2 }))
  else done(null, { isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })
}
sftp.mkdir = (path, attrs, done) => { assert.equal(attrs.mode, 0o700); directories.set(path, 'directory'); done() }
const source = await readFile(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source + '\nexport { connectionProfiles as connectionProfilesForTest }', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
const mocks = {
  './settings': { getSettings: async () => ({ sshProfiles: profile ? [profile] : [] }) },
  './sshHostKeys': {}, './remoteDirListCache': {}, './remoteFileCache': {},
  './sshConnectionPool': { SshConnectionPool: class {
    get() { connectionRequests++; onConnect?.(); return Promise.resolve({ client, sftp }) }
    discard() { discarded++ }
  } }
}
vm.runInNewContext(code, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), Buffer, URL, process, console, setTimeout, clearTimeout }, { filename: 'remoteFs.ts' })
const { rfsProjectWorkspace, rfsForwardLocal, connectionProfilesForTest } = module.exports
connectionProfilesForTest.set(client, { ...profile })

const http = createHttpServer((request, response) => {
  requests++
  if (request.headers.authorization !== 'Bearer secret-in-http-only') { response.writeHead(403); response.end(); return }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ path: request.url, authorized: true }))
})
const server = new ssh2.Server({ hostKeys: [key.private] }, (peer) => {
  serverPeer = peer; serverPeers.add(peer)
  peer.on('error', () => {})
  peer.on('authentication', (context) => context.accept())
  peer.on('request', (accept, reject, name, info) => {
    if (name === 'cancel-tcpip-forward') {
      const listener = bindings.get(info.bindPort)
      bindings.delete(info.bindPort)
      listener?.close()
      accept?.(); return
    }
    if (name !== 'tcpip-forward' || failForward) { reject?.(); return }
    if (holdForward) { heldForward = true; return }
    assert.equal(info.bindAddr, '127.0.0.1', 'remote bind must stay on loopback')
    assert.equal(info.bindPort, 0, 'each tunnel requests a dedicated port')
    const listener = createTcpServer((socket) => {
      serverSockets.add(socket); socket.on('close', () => serverSockets.delete(socket)); socket.on('error', () => {})
      peer.forwardOut('127.0.0.1', listener.address().port, socket.remoteAddress, socket.remotePort, (error, channel) => {
        if (error) { socket.destroy(); return }
        channel.on('error', () => socket.destroy())
        socket.on('error', () => channel.destroy())
        socket.pipe(channel).pipe(socket)
      })
    })
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; bindings.set(port, listener); accept(port) })
  })
})
client.on('error', () => {})
const fetchTunnel = (tunnel, authorized = true) => fetch(tunnel.url, { headers: authorized ? { Authorization: 'Bearer secret-in-http-only' } : {}, signal: AbortSignal.timeout(5000) })
const waitUntil = async (condition) => {
  const until = Date.now() + 5000
  while (!condition()) { assert.ok(Date.now() < until, 'condition timed out'); await new Promise((resolve) => setTimeout(resolve, 10)) }
}

try {
  const cwd = `${home}/.legal-terminal/project-workspaces/project_1`
  const workspace = await rfsProjectWorkspace('office', 'project_1')
  assert.equal(workspace.cwd, cwd)
  assert.equal(workspace.profileId, 'office')
  assert.equal(workspace.ssh.host, 'saved.example')
  assert.equal(workspace.ssh.identityFile, '/saved/key')
  assert.equal(workspace.ssh.remoteControl, true)
  assert.equal((await rfsProjectWorkspace('office', 'project_1')).cwd, cwd)
  for (const id of ['../escape', '', '/absolute', 'a/b', 'a'.repeat(129)]) await assert.rejects(rfsProjectWorkspace('office', id), /안전하지/)
  for (const path of [`${home}/.legal-terminal`, `${home}/.legal-terminal/project-workspaces`, cwd]) {
    directories.set(path, 'symlink')
    await assert.rejects(rfsProjectWorkspace('office', 'project_1'), /안전한 폴더/)
    directories.set(path, 'directory')
  }
  aliasedPath = cwd
  await assert.rejects(rfsProjectWorkspace('office', 'project_1'), /안전한 폴더/)
  aliasedPath = undefined
  const savedProfile = profile; profile = undefined
  const before = connectionRequests
  await assert.rejects(rfsProjectWorkspace('office', 'project_1'), /프로필을 찾을 수 없습니다/)
  await assert.rejects(rfsForwardLocal('office', 'http://127.0.0.1:1234/mcp/session', () => {}), /프로필을 찾을 수 없습니다/)
  assert.equal(connectionRequests, before, 'deleted profile cannot reuse a pooled connection')
  profile = savedProfile
  for (const url of ['https://127.0.0.1/a', 'http://localhost/a', 'http://127.0.0.2/a', 'http://[::1]/a', 'http://evil.test/a', 'http://user@127.0.0.1/a', 'http://127.0.0.1/a?token=x', 'http://127.0.0.1/a#x', 'http://127.0.0.1/a?', 'http://127.0.0.1/a#', 'http://127.0.0.1:0/a', 'http://2130706433/a', 'file:///a']) {
    await assert.rejects(rfsForwardLocal('office', url, () => {}))
  }
  assert.equal(connectionRequests, before, 'invalid destinations fail before connecting')
  await assert.rejects(rfsForwardLocal('office', 'http://127.0.0.1:1234/mcp/drift', () => {}, { ...profile, host: 'untrusted.example' }), /프로필이 변경/)
  assert.equal(connectionRequests, before, 'unexpected SSH identity fails before getting a connection or allocating a port')
  onConnect = () => { profile = { ...profile, host: 'edited-while-connecting.example' } }
  await assert.rejects(rfsProjectWorkspace('office', 'project_drift'), /프로필이 변경/)
  assert.equal(directories.has(`${home}/.legal-terminal/project-workspaces/project_drift`), false)
  assert.equal(discarded, 1, 'stale pool connection is discarded so retry can connect to the current profile')
  profile = savedProfile
  await assert.rejects(rfsForwardLocal('office', 'http://127.0.0.1:1234/mcp/drift', () => {}, savedProfile), /프로필이 변경/)
  assert.equal(discarded, 2)
  onConnect = undefined; profile = savedProfile
  connectionProfilesForTest.set(client, { ...profile, host: 'cached-old.example' })
  await assert.rejects(rfsProjectWorkspace('office', 'project_old_host'), /프로필이 변경/)
  assert.equal(discarded, 3, 'old pooled host is not accepted merely because saved profile ID still matches')
  connectionProfilesForTest.set(client, { ...profile })

  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  client.connect({ host: '127.0.0.1', port: server.address().port, username: 'test', hostVerifier: () => true })
  await once(client, 'ready')
  const local = `http://127.0.0.1:${http.address().port}`
  const [first, second] = await Promise.all([
    rfsForwardLocal('office', `${local}/mcp/one`, () => disconnects++),
    rfsForwardLocal('office', `${local}/mcp/two`, () => disconnects++)
  ])
  assert.notEqual(first.url, second.url)
  assert.equal(client.listenerCount('tcp connection'), 1, 'pooled client has a single dispatcher')
  assert.equal(first.url.includes('secret'), false, 'authentication is never encoded in tunnel URL')
  assert.deepEqual(await (await fetchTunnel(first)).json(), { path: '/mcp/one', authorized: true })
  assert.deepEqual(await (await fetchTunnel(second)).json(), { path: '/mcp/two', authorized: true })
  assert.equal((await fetchTunnel(first, false)).status, 403, 'remote port cannot bypass HTTP bearer authentication')
  const requestsBeforeRogueChannel = requests
  let rejected = 0
  client.emit('tcp connection', { destIP: '0.0.0.0', destPort: Number(new URL(first.url).port) }, () => { throw new Error('unsafe address accepted') }, () => rejected++)
  client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 1 }, () => { throw new Error('unknown port accepted') }, () => rejected++)
  assert.equal(rejected, 2)
  assert.equal(requests, requestsBeforeRogueChannel)
  first.close(); first.close()
  await waitUntil(() => bindings.size === 1)
  assert.equal(disconnects, 0, 'intentional close does not abort another run')
  assert.equal((await fetchTunnel(second)).status, 200, 'closing one tunnel preserves the other on the pooled client')
  failForward = true
  await assert.rejects(rfsForwardLocal('office', `${local}/mcp/failed`, () => disconnects++))
  failForward = false
  assert.equal((await fetchTunnel(second)).status, 200, 'failed forwarding leaves existing tunnel usable')
  assert.equal(disconnects, 0)
  const deadEndpoint = createTcpServer()
  deadEndpoint.listen(0, '127.0.0.1'); await once(deadEndpoint, 'listening')
  const deadPort = deadEndpoint.address().port
  await new Promise((resolve) => deadEndpoint.close(resolve))
  const broken = await rfsForwardLocal('office', `http://127.0.0.1:${deadPort}/mcp/gone`, () => disconnects++)
  await assert.rejects(fetchTunnel(broken))
  await waitUntil(() => disconnects === 1)
  assert.equal((await fetchTunnel(second)).status, 200, 'lost local endpoint only stops its own tunnel')
  holdForward = true
  const pending = assert.rejects(rfsForwardLocal('office', `${local}/mcp/pending`, () => { throw new Error('unestablished tunnel must reject') }), /연결이 종료/)
  await waitUntil(() => heldForward)
  serverPeer.end()
  await pending
  await waitUntil(() => disconnects === 2)
  client.emit('close'); client.emit('end')
  assert.equal(disconnects, 2, 'connection loss interrupts each active tunnel exactly once')
  assert.equal(client.listenerCount('tcp connection'), 0)
  console.log('project remote connection ok: canonical saved-profile workspace, symlink and destination safety, authenticated reverse HTTP over SSH2, concurrent tunnel isolation, failure and disconnect cleanup')
} finally {
  client.destroy()
  for (const peer of serverPeers) peer.end()
  for (const socket of serverSockets) socket.destroy()
  for (const listener of bindings.values()) listener.close()
  http.closeAllConnections()
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => http.close(resolve))])
}
