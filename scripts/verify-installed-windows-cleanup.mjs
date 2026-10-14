// Exercise the real smoke-test cleanup on any OS without launching apps or changing firewall rules.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
const source = readFileSync(new URL('./verify-installed-windows.mjs', import.meta.url), 'utf8')
const finalizer = source.slice(source.lastIndexOf('} finally {') + 1)
const turn = () => new Promise(setImmediate)

function runCleanup({ primaryError, killError, otherErrors = false, exited = false, noChild = false } = {}) {
  const calls = [], logged = [], timers = new Set()
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: exited ? 0 : null, signalCode: null })
  const action = name => {
    calls.push(name)
    if (name === 'terminate' ? killError : otherErrors) throw name === 'terminate' ? killError : Error(name)
  }
  const context = {
    primaryError, socket: { close() {} }, child: noChild ? undefined : child,
    execFileSync: () => action('terminate'), powershell: () => action('firewall'), firewallAdded: true,
    fs: { writeFile: () => action('log'), rm: () => action('temporary files') },
    path: { join: () => '/synthetic/log' }, evidenceDir: '/synthetic', temp: '/synthetic', output: '',
    psQuote: value => value, ruleName: 'synthetic', setImmediate,
    setTimeout(callback, delay) { assert.equal(delay, 10000); timers.add(callback); return callback },
    clearTimeout(callback) { timers.delete(callback) },
    console: { error: error => logged.push(error) }
  }
  let settled = false
  const result = vm.runInNewContext(`(async () => { try { if (primaryError) throw primaryError } ${finalizer} })()`, context)
    .then(() => { settled = true }, error => { settled = true; return error })
  return { child, calls, logged, timers, result, settled: () => settled,
    expire() { assert.equal(timers.size, 1, 'termination has a bounded wait'); for (const callback of [...timers]) callback() } }
}
const assertIndependentCleanup = run => {
  assert.deepEqual(run.calls, ['terminate', 'firewall', 'log', 'temporary files'])
  assert.equal(run.timers.size, 0)
  assert.equal(run.child.listenerCount('exit'), 0)
  assert.equal(run.child.listenerCount('error'), 0)
}

for (const status of [undefined, 128, 5]) {
  test(`termination ${status ?? 'success'} waits for delayed verified child exit`, async () => {
    const killError = status === undefined ? undefined : Object.assign(Error(`taskkill ${status}`), { status })
    const run = runCleanup({ killError })
    await turn()
    await turn()
    assert.equal(run.settled(), false, 'an event-loop turn is not proof that the child exited')
    run.child.exitCode = 0
    run.child.emit('exit', 0, null)
    assert.equal(await run.result, undefined)
    assertIndependentCleanup(run)
  })
}

for (const status of [undefined, 128, 5]) {
  test(`termination ${status ?? 'success'} still fails when the child remains running`, async () => {
    const killError = status === undefined ? undefined : Object.assign(Error(`taskkill ${status}`), { status })
    const run = runCleanup({ killError })
    run.expire()
    const error = await run.result
    assert.equal(error.name, 'AggregateError')
    assert.equal(error.errors.length, 1)
    if (killError) assert.equal(error.errors[0], killError, 'the original command failure is preserved')
    else assert.match(error.errors[0].message, /did not exit/)
    assertIndependentCleanup(run)
  })
}

test('an exit event without an exited state does not hide a termination failure', async () => {
  const killError = Object.assign(Error('taskkill 128'), { status: 128 })
  const run = runCleanup({ killError })
  run.child.emit('exit', 0, null)
  run.expire()
  assert.equal((await run.result).errors[0], killError)
  assertIndependentCleanup(run)
})

test('a child error during termination fails and still completes other cleanup', async () => {
  const run = runCleanup()
  const childError = Error('child termination error')
  run.child.emit('error', childError)
  assert.equal((await run.result).errors[0], childError)
  assertIndependentCleanup(run)
})

for (const primaryError of [undefined, new Error('primary assertion')]) {
  test(`all cleanup operations are attempted ${primaryError ? 'without replacing the primary error' : 'and their failures reported'}`, async () => {
    const killError = Error('terminate')
    const run = runCleanup({ primaryError, killError, otherErrors: true })
    run.expire()
    const error = await run.result
    if (primaryError) assert.equal(error, primaryError)
    else {
      assert.equal(error.name, 'AggregateError')
      assert.equal(error.errors.length, 4)
    }
    assertIndependentCleanup(run)
    assert.equal(run.logged.length, primaryError ? 1 : 0)
    if (primaryError) assert.equal(run.logged[0].errors.length, 4)
  })
}

for (const options of [{ exited: true }, { noChild: true }]) {
  test(`cleanup skips termination for ${options.noChild ? 'an unstarted' : 'an exited'} child`, async () => {
    const run = runCleanup(options)
    assert.equal(await run.result, undefined)
    assert.deepEqual(run.calls, ['firewall', 'log', 'temporary files'])
    assert.equal(run.timers.size, 0)
  })
}
