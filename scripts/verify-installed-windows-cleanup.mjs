// Exercise the real smoke-test cleanup on any OS without launching apps or changing firewall rules.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('./verify-installed-windows.mjs', import.meta.url), 'utf8')
const finalizer = source.slice(source.lastIndexOf('} finally {') + 1)
for (const primaryError of [undefined, new Error('primary assertion')]) {
  const calls = [], logged = []
  const fail = name => { calls.push(name); throw Error(name) }
  const context = {
    primaryError, socket: { close() {} }, child: { pid: 123, exitCode: null, signalCode: null },
    execFileSync: () => fail('terminate'), powershell: () => fail('firewall'), firewallAdded: true,
    fs: { writeFile: () => fail('log'), rm: () => fail('temporary files') },
    path: { join: () => '/synthetic/log' }, evidenceDir: '/synthetic', temp: '/synthetic', output: '',
    psQuote: value => value, ruleName: 'synthetic', setImmediate,
    console: { error: error => logged.push(error) }
  }
  await assert.rejects(vm.runInNewContext(`(async () => { try { if (primaryError) throw primaryError } ${finalizer} })()`, context), error => primaryError ? error === primaryError : error.name === 'AggregateError' && error.errors.length === 4)
  assert.deepEqual(calls, ['terminate', 'firewall', 'log', 'temporary files'], 'every cleanup must run even after prior failures')
  assert.equal(logged.length, primaryError ? 1 : 0, 'primary assertion stays the reported failure')
}
console.log('installed Windows cleanup: all four cleanup operations attempted; primary failures preserved')
