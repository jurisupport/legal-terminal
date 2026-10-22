// Real loopback SSH forwarding and shell permission checks, with no accounts or external hosts.
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer as createHttpServer, get } from 'node:http'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import ssh2 from 'ssh2'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8')
const root = await mkdtemp(join(tmpdir(), 'lt-project-remote-'))
const fixture = join(root, "작업 ' $(touch injected)")
const alias = join(root, 'linked')
const readonly = join(root, 'readonly')
const commands = [], bindings = new Map(), sockets = new Set(), peers = new Set()
let connection, fastTimeout = false
const remote = (() => {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module, exports: module.exports, Buffer, process, console, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, fastTimeout && ms === 8000 ? 25 : ms), clearTimeout,
    require(name) {
      if (name === './settings') return { getSettings: async () => ({ sshProfiles: [] }) }
      if (name === './sshHostKeys') return { verifySshHostKey: () => { throw new Error('No user accounts in fixture') } }
      if (name === './sshConnectionPool') return { SshConnectionPool: class {
        async get(profileId) { assert.equal(profileId, 'fixture'); return connection }
        dispose() {}
      } }
      if (name === './remoteDirListCache') return { invalidateRemoteDirListCache() {} }
      if (name === './remoteFileCache') return { invalidateRemoteFileCache() {} }
      return require(name)
    }
  }, { filename: 'remoteFs.ts' })
  return module.exports
})()
const key = ssh2.utils.generateKeyPairSync('ed25519')
const client = new ssh2.Client()
client.on('error', () => {})
const sshServer = new ssh2.Server({ hostKeys: [key.private] }, peer => {
  peers.add(peer)
  peer.on('error', () => {})
  peer.on('close', () => peers.delete(peer))
  peer.on('authentication', context => context.accept())
  peer.on('ready', () => {
    peer.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
      assert.match(info.command, /^if \[ -d /)
      commands.push(info.command)
      const channel = acceptExec()
      const child = spawn('/bin/sh', ['-c', info.command], { cwd: root })
      child.stdout.pipe(channel, { end: false })
      child.stderr.pipe(channel.stderr, { end: false })
      child.on('close', code => { channel.exit(code); channel.end() })
    }))
    peer.on('request', (accept, reject, name, info) => {
      assert.equal(info.bindAddr, '127.0.0.1', 'remote binding must remain loopback-only')
      if (name === 'cancel-tcpip-forward') {
        const server = bindings.get(info.bindPort)
        bindings.delete(info.bindPort)
        if (server) server.close(() => accept())
        else reject()
        return
      }
      assert.equal(name, 'tcpip-forward')
      assert.equal(info.bindPort, 0)
      const server = createServer(socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket)).on('error', () => {})
        peer.forwardOut('127.0.0.1', server.address().port, socket.remoteAddress, socket.remotePort, (error, channel) => {
          if (error) { socket.destroy(); return }
          channel.on('error', () => socket.destroy()).on('close', () => socket.destroy())
          socket.on('close', () => channel.destroy())
          socket.pipe(channel).pipe(socket)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        bindings.set(server.address().port, server)
        accept(server.address().port)
      })
    })
  })
})
const http = createHttpServer((req, res) => {
  if (req.url === '/hold') res.write('open')
  else res.end(`echo:${req.url}`)
})
http.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const request = port => new Promise((resolve, reject) => {
  get({ hostname: '127.0.0.1', port, path: '/project', agent: false, timeout: 3000 }, res => {
    let body = ''
    res.on('data', data => { body += data }).on('end', () => resolve(body))
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('HTTP fixture timed out')) })
})
const eventually = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate())
}
class FakeClient extends EventEmitter {
  cancelled = []
  forwardIn(address, port, callback) { assert.equal(address, '127.0.0.1'); assert.equal(port, 0); this.ready = callback }
  unforwardIn(address, port, callback) { this.cancelled.push([address, port]); callback() }
}
try {
  await mkdir(fixture)
  await mkdir(readonly)
  await symlink(fixture, alias)
  await writeFile(join(root, 'file'), 'fixture')
  const httpPort = await listen(http)
  const sshPort = await listen(sshServer)
  const ready = once(client, 'ready')
  client.connect({ host: '127.0.0.1', port: sshPort, username: 'fixture', hostVerifier: value => value.equals(ssh2.utils.parseKey(key.private).getPublicSSH()) })
  await ready
  const sftp = Object.assign(new EventEmitter(), {
    lstat: fs.lstat,
    stat: fs.stat,
    realpath: fs.realpath,
    readdir(path, callback) { fs.readdir(path, (error, files) => callback(error, files?.map(filename => ({ filename })))) }
  })
  connection = { client, sftp }
  const uri = path => remote.makeRemote('fixture', path)
  assert.equal(await remote.rfsValidateWorkspace(uri(alias)), uri(await realpath(fixture)))
  assert.equal(commands.length, 1)
  assert.equal(fs.existsSync(join(root, 'injected')), false, 'shell metacharacters in paths must remain literal')
  await assert.rejects(remote.rfsValidateWorkspace(uri(join(root, 'missing'))), /찾을 수 없/)
  await assert.rejects(remote.rfsValidateWorkspace(uri(join(root, 'file'))), /디렉터리/)
  for (const invalid of ['relative/path', 'ssh://fixture', 'ssh:///tmp', 'ssh://fixture/tmp\0bad']) {
    await assert.rejects(remote.rfsValidateWorkspace(invalid))
  }
  for (const mode of [0o500, 0o300, 0o600]) {
    await chmod(readonly, mode)
    await assert.rejects(remote.rfsValidateWorkspace(uri(readonly)), /읽기·쓰기·접근/)
  }
  await chmod(readonly, 0o700)
  assert.equal(fs.readdirSync(fixture).length, 0, 'validation must never create a probe file')

  const baseline = new Map(['tcp connection', 'end', 'close', 'error'].map(event => [event, client.listenerCount(event)]))
  const [first, second] = await Promise.all([
    remote.rfsForwardLocalPort('fixture', httpPort), remote.rfsForwardLocalPort('fixture', httpPort)
  ])
  assert.equal(client.listenerCount('tcp connection'), baseline.get('tcp connection') + 1)
  assert.equal(await request(first.port), 'echo:/project')
  assert.equal(await request(second.port), 'echo:/project')
  for (const details of [
    { destIP: '0.0.0.0' }, { srcIP: '192.0.2.1' }, { destPort: 1 }, { srcPort: 0 }
  ]) {
    let rejected = 0
    client.emit('tcp connection', { destIP: '127.0.0.1', srcIP: '127.0.0.1', srcPort: 1234, destPort: first.port, ...details },
      () => assert.fail('unexpected remote source/destination must not reach local service'), () => { rejected++ })
    assert.equal(rejected, 1)
  }
  const heldResponse = await new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: first.port, path: '/hold', agent: false }, response => {
      response.on('error', () => {})
      response.once('data', () => resolve(response))
    }).on('error', reject)
  })
  const heldClosed = new Promise(resolve => heldResponse.once('close', resolve))
  first.close(); first.close()
  await heldClosed
  assert.equal(first.isAlive(), false)
  assert.equal(second.isAlive(), true)
  await eventually(() => !bindings.has(first.port))
  assert.equal(await request(second.port), 'echo:/project', 'closing one tunnel must preserve another on the shared client')
  remote.disposeRemote('fixture')
  assert.equal(second.isAlive(), false)
  await eventually(() => bindings.size === 0)
  for (const [event, count] of baseline) assert.equal(client.listenerCount(event), count, `listener leak: ${event}`)

  for (const event of ['end', 'close', 'error']) {
    const fake = new FakeClient()
    fake.on('error', () => {})
    connection = { client: fake, sftp }
    const pending = remote.rfsForwardLocalPort('fixture', httpPort)
    await eventually(() => typeof fake.ready === 'function')
    fake.ready(null, 20000)
    const tunnel = await pending
    fake.emit(event, new Error('simulated disconnect'))
    assert.equal(tunnel.isAlive(), false)
    assert.equal(fake.listenerCount('tcp connection'), 0)
    assert.deepEqual(fake.cancelled, [['127.0.0.1', 20000]])
  }
  {
    const fake = new FakeClient()
    connection = { client: fake, sftp }
    fastTimeout = true
    const pending = remote.rfsForwardLocalPort('fixture', httpPort)
    await assert.rejects(pending, /시간이 초과/)
    fastTimeout = false
    assert.equal(fake.listenerCount('tcp connection'), 0)
    fake.ready(null, 21000)
    assert.deepEqual(fake.cancelled, [['127.0.0.1', 21000]], 'late setup success must be unbound')
    fake.ready = undefined
    const denied = remote.rfsForwardLocalPort('fixture', httpPort)
    await eventually(() => typeof fake.ready === 'function')
    fake.ready(new Error('forwarding denied'))
    await assert.rejects(denied, /forwarding denied/)
    assert.equal(fake.listenerCount('tcp connection'), 0)
    for (const port of [0, -1, 65536, 1.5, NaN]) await assert.rejects(remote.rfsForwardLocalPort('fixture', port), /유효한 로컬 포트/)
  }
  await eventually(() => sockets.size === 0)
  console.log('verify-project-remote-transport: OK (canonical workspace, permissions, quoted paths, real SSH forwarding, concurrent tunnels, rejection, timeout, disconnect and cleanup)')
} finally {
  remote.disposeRemote()
  client.destroy()
  for (const peer of peers) peer.end()
  for (const socket of sockets) socket.destroy()
  for (const server of bindings.values()) server.close()
  await Promise.all([sshServer, http].map(server => new Promise(resolve => server.close(resolve))))
  await chmod(readonly, 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
}
