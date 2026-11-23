// Exercise the production SSH pool and board store against a private loopback OpenSSH SFTP server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import ssh2 from 'ssh2'

const binary = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync)
if (!binary) throw new Error('이 검증에는 OpenSSH sftp-server가 필요합니다.')
const root = await realpath(await mkdtemp(join(tmpdir(), 'lt-board-sftp-')))
const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
const identity = ssh2.utils.generateKeyPairSync('ed25519')
const privateKey = join(root, 'identity')
const publicKey = ssh2.utils.parseKey(identity.private).getPublicSSH()
const user = randomUUID()
let connections = 0
const server = new ssh2.Server({hostKeys: [hostKey.private]}, client => {
  connections++
  client.on('error', () => {})
  client.on('authentication', ctx => {
    const ok = ctx.username === user && ctx.method === 'publickey' && ctx.key.data.equals(publicKey)
    if (!ok || (ctx.signature && !ssh2.utils.parseKey(identity.private).verify(ctx.blob, ctx.signature))) ctx.reject()
    else ctx.accept()
  })
  client.on('ready', () => client.on('session', accept => accept().on('subsystem', (start, reject, info) => {
    if (info.name !== 'sftp') return reject()
    const channel = start()
    const child = spawn(binary, [], {cwd: root, stdio: ['pipe', 'pipe', 'ignore']})
    channel.pipe(child.stdin)
    child.stdout.pipe(channel)
    child.stdin.on('error', () => {})
    channel.on('close', () => child.kill())
  })))
})
const require = createRequire(import.meta.url)
const source = buildSync({
  stdin: {contents: "export * from './src/main/workBoardStore'; export {disposeRemote} from './src/main/remoteFs'", resolveDir: process.cwd()},
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external'
}).outputFiles[0].text
const mod = new Module(import.meta.filename)
mod.require = id => id === 'electron' ? {app: {getPath: () => root}} : require(id)
mod._compile(source, import.meta.filename)
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await writeFile(privateKey, identity.private, {mode: 0o600})
  await writeFile(join(root, 'config.json'), JSON.stringify({sshProfiles: [{id: 'test', host: '127.0.0.1', port, user, identityFile: privateKey}]}))
  const key = ssh2.utils.parseKey(hostKey.private)
  const fingerprint = createHash('sha256').update(JSON.stringify(['127.0.0.1', port, key.type])).digest('hex')
  await mkdir(join(root,'ssh-host-keys'))
  await writeFile(join(root, 'ssh-host-keys', fingerprint), key.getPublicSSH().toString('base64'))
  const folder = join(root, '_업무지시')
  const board = new mod.exports.WorkBoardStore('ssh://test' + folder)
  await board.init()
  assert.equal(await board.claimOwner('one'), true)
  assert.equal(await board.claimOwner('two'), false)
  assert.ok((await board.teams()).length)
  const at = new Date().toISOString()
  const task = {id:'20261124-001', title:'검토', cwd:'ssh://test' + root, body:'확인', createdAt:at, updatedAt:at, order:0, attempts:0, status:'queued', log:[]}
  await board.save(task)
  const [queued] = await board.list()
  await board.save({...queued, status:'done'})
  assert.equal((await board.list())[0].status, 'done')
  // A sync client may replace a historical file while retaining both SFTP metadata fields.
  const savedPath = join(folder, task.id + '.md')
  const stamp = await stat(savedPath)
  const original = await readFile(savedPath, 'utf8')
  await writeFile(savedPath, original.replace('title: 검토', 'title: 변경'))
  await utimes(savedPath, stamp.atime, stamp.mtime)
  assert.equal((await board.list())[0].title, '검토', 'unchanged archive should use the manifest cache')
  const clock = Date.now
  try {
    Date.now = () => clock() + 61_000
    assert.equal((await board.list())[0].title, '변경', 'rotating audit finds equal-signature updates')
  } finally { Date.now = clock }
  await board.writeText(task.id + '.report.md', '검토 완료')
  await board.writeText('_일일보고/2026-11-24.md', '일일 보고')
  assert.equal(await board.readText(task.id + '.report.md'), '검토 완료')
  assert.equal(await readFile(join(folder, '_일일보고/2026-11-24.md'), 'utf8'), '일일 보고')
  assert.equal(connections, 1)
  console.log('실제 루프백 SSH/SFTP 연결 1개에서 지시서 생성·변경·조회, 보고서 및 일일 보고 저장 확인')
} finally {
  mod.exports.disposeRemote('test')
  server.close()
  await rm(root, {recursive: true, force: true})
}
