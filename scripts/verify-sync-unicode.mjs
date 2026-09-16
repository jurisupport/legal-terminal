import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { cancelSync, cloudPathForms, runRemoteSync } from '../src/main/sync.ts'

const path = 'onedrive:진행중사건/서울가정법원_2025느합1050'
const { root, segments } = cloudPathForms(path)

assert.equal(root, 'onedrive:')
assert.equal(segments.length, 2)
assert.ok(segments[0].includes('진행중사건'.normalize('NFC')))
assert.ok(segments[0].includes('진행중사건'.normalize('NFD')))
assert.ok(segments[1].includes('서울가정법원_2025느합1050'.normalize('NFC')))
assert.ok(segments[1].includes('서울가정법원_2025느합1050'.normalize('NFD')))

const decomposed = cloudPathForms(path.normalize('NFD'))
assert.ok(decomposed.segments[0].includes('진행중사건'.normalize('NFC')))
assert.ok(decomposed.segments[1].includes('서울가정법원_2025느합1050'.normalize('NFC')))

assert.equal(cloudPathForms('onedrive:').segments.length, 0)

console.log('verify-sync-unicode: OK')

// 백그라운드 실행 중 새 요청이나 중단이 기존 프로세스 추적을 덮어쓰면 안 된다.
const originalSpawn = childProcess.spawn
const processes = []
childProcess.spawn = () => {
  const proc = new EventEmitter()
  proc.kill = () => { proc.killed = true }
  processes.push(proc)
  return proc
}
syncBuiltinESMExports()
try {
  const opts = {
    profile: { id: 'test', host: 'example.invalid', user: 'test' },
    direction: 'pull', macFolder: '/tmp/case', dest: 'onedrive:case'
  }
  const wc = { isDestroyed: () => false, send: () => {} }
  const first = runRemoteSync(opts, wc)
  assert.equal((await runRemoteSync(opts, wc)).ok, false)
  assert.equal(processes.length, 1, '중복 요청은 프로세스를 시작하지 않는다')
  cancelSync()
  assert.equal(processes[0].killed, true)
  assert.equal((await runRemoteSync(opts, wc)).ok, false, '중단 완료 전에는 새 동기화를 막는다')
  processes[0].emit('close', null)
  assert.equal((await first).ok, false)

  const failed = runRemoteSync(opts, wc)
  processes[1].emit('error', new Error('test spawn failure'))
  assert.equal((await failed).ok, false)
  const next = runRemoteSync(opts, wc)
  processes[1].emit('close', null)
  assert.equal((await runRemoteSync(opts, wc)).ok, false, '이전 close 이벤트가 새 실행을 지우면 안 된다')
  cancelSync()
  assert.equal(processes[2].killed, true)
  processes[2].emit('close', 0)
  assert.equal((await next).ok, true)
  console.log('sync lifecycle: duplicate starts, cancellation and process ownership OK')
} finally {
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
}
