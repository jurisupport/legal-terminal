import assert from 'node:assert/strict'
import {
  normalizeRemoteQuickStartPaths,
  toggleRemoteQuickStartPath
} from '../src/renderer/src/remoteQuickStart.ts'

const saved = normalizeRemoteQuickStartPaths([' /cases/one/ ', '/cases/two', '/cases/one'])

assert.deepEqual(saved, ['/cases/one/', '/cases/two'])
assert.deepEqual(toggleRemoteQuickStartPath(saved, '/cases/one'), ['/cases/two'])
assert.deepEqual(toggleRemoteQuickStartPath(saved, '/cases/three'), [
  '/cases/one/',
  '/cases/two',
  '/cases/three'
])

console.log('remote quick start paths can be added and removed')
