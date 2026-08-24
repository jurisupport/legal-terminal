import assert from 'node:assert/strict'
import { shouldKeepPendingRecord } from '../src/renderer/src/hearing/loadPolicy.ts'

assert.equal(shouldKeepPendingRecord(undefined, '/records/a.hearing.json'), true)
assert.equal(shouldKeepPendingRecord('/records/a.hearing.json', '/records/a.hearing.json'), true)
assert.equal(shouldKeepPendingRecord('/records/a.hearing.json', '/records/b.hearing.json'), false)

console.log('hearing load policy ok')
