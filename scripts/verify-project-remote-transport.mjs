// Real loopback SSH forwarding and SFTP path checks, with no accounts or external hosts.
// Managed-directory and profile validation are exercised by verify-project-remote-connection.mjs;
// selected-directory validation is exercised by verify-project-agent.mjs (the former shell validator is gone).
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer as createHttpServer, get } from 'node:http'
import { createServer } from 'node:net'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join, posix, win32 } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import ssh2 from 'ssh2'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8') + '\nexport { connectionProfiles as connectionProfilesForTest }'
const root = await mkdtemp(join(tmpdir(), 'lt-project-remote-'))
const fixture = join(root, "작업 ' $(touch injected)")
const alias = join(root, 'linked')
const remoteRoot = '/fixture'
function fixturePaths(nativeRoot, paths) {
  return {
    local(remotePath) {
      assert.ok(remotePath === remoteRoot || remotePath.startsWith(remoteRoot + '/'), 'SFTP paths stay in the virtual fixture')
      const relative = posix.relative(remoteRoot, remotePath)
      assert.ok(relative !== '..' && !relative.startsWith('../') && !remotePath.includes('\\'), 'SFTP paths use POSIX separators without escaping the fixture')
      return paths.join(nativeRoot, ...relative.split('/'))
    },
    remote(nativePath) {
      const relative = paths.relative(nativeRoot, nativePath)
      assert.ok(!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep), 'native fixtures remain under their temporary root')
      return posix.join(remoteRoot, ...relative.split(paths.sep))
    }
  }
}
const commands = [], bindings = new Map(), sockets = new Set(), peers = new Set()
const profile = { id: 'fixture', host: '127.0.0.1', user: 'fixture' }
let connection, fastTimeout = false
const remote = (() => {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module, exports: module.exports, Buffer, process, console, AbortController, URL,
    setTimeout: (fn, ms) => setTimeout(fn, fastTimeout && ms === 15000 ? 25 : ms), clearTimeout,
    require(name) {
      if (name === './settings') return { getSettings: async () => ({ sshProfiles: [profile] }) }
      if (name === './sshHostKeys') return { verifySshHostKey: () => { throw new Error('No user accounts in fixture') } }
      if (name === './sshConnectionPool') return { SshConnectionPool: class {
        async get(profileId) { assert.equal(profileId, 'fixture'); module.exports.connectionProfilesForTest.set(connection.client, profile); return connection }
        dispose() { connection?.client.emit('end') }
        discard() {}
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
    peer.on('session', accept => accept().on('exec', (_acceptExec, reject, info) => {
      commands.push(info.command)
      reject()
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
  await symlink(fixture, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(root, 'file'), 'fixture')
  const httpPort = await listen(http)
  const sshPort = await listen(sshServer)
  const ready = once(client, 'ready')
  client.connect({ host: '127.0.0.1', port: sshPort, username: 'fixture', hostVerifier: value => value.equals(ssh2.utils.parseKey(key.private).getPublicSSH()) })
  await ready
  const paths = fixturePaths(await realpath(root), path)
  const sftp = Object.assign(new EventEmitter(), {
    lstat(remotePath, callback) { fs.lstat(paths.local(remotePath), callback) },
    stat(remotePath, callback) { fs.stat(paths.local(remotePath), callback) },
    realpath(remotePath, callback) { fs.realpath(paths.local(remotePath), (error, actual) => callback(error, error ? undefined : paths.remote(actual))) },
    readdir(remotePath, callback) { fs.readdir(paths.local(remotePath), (error, files) => callback(error, files?.map(filename => ({ filename })))) }
  })
  connection = { client, sftp }
  const uri = name => remote.makeRemote('fixture', posix.join(remoteRoot, name))
  const fixtureName = path.basename(fixture)
  const canonical = await remote.rfsRealpath(uri('linked'))
  assert.equal(canonical, uri(fixtureName))
  assert.equal((await remote.rfsStat(canonical)).isDir, true)
  assert.equal((await remote.rfsStat(uri('file'))).isDir, false)
  await assert.rejects(remote.rfsRealpath(uri('missing')))
  for (const windowsRoot of ['C:\\Users\\fixture\\AppData\\Local\\Temp', '\\\\server\\share\\Temp']) {
    const windowsPaths = fixturePaths(windowsRoot, win32)
    const native = win32.join(windowsRoot, fixtureName)
    assert.equal(windowsPaths.local(posix.join(remoteRoot, fixtureName)), native, 'POSIX SFTP paths map to native Windows paths')
    assert.equal(windowsPaths.remote(native), posix.join(remoteRoot, fixtureName), 'Windows drive and UNC prefixes never enter SFTP paths')
    assert.equal(remote.makeRemote('fixture', windowsPaths.remote(native)), uri(fixtureName))
    assert.throws(() => windowsPaths.local('/fixture/../outside'))
    assert.throws(() => windowsPaths.local('/fixture/C:\\outside'))
    assert.throws(() => windowsPaths.remote(win32.join(windowsRoot, '..', 'outside')))
  }
  assert.equal(commands.length, 0, 'path resolution uses SFTP without interpolating a shell command')
  assert.equal(fs.existsSync(join(root, 'injected')), false, 'metacharacters in paths remain literal')
  assert.equal(fs.readdirSync(fixture).length, 0, 'canonical path checks never create a probe file')

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
    await assert.rejects(pending, /연결이 종료/)
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
  console.log('verify-project-remote-transport: OK (portable POSIX/SFTP paths, Windows drive/UNC mapping, literal metacharacters, real SSH forwarding, concurrent tunnels, rejection, timeout, disconnect and cleanup)')
} finally {
  remote.disposeRemote()
  client.destroy()
  for (const peer of peers) peer.end()
  for (const socket of sockets) socket.destroy()
  for (const server of bindings.values()) server.close()
  await Promise.all([sshServer, http].map(server => new Promise(resolve => server.close(resolve))))
  await rm(root, { recursive: true, force: true })
}
