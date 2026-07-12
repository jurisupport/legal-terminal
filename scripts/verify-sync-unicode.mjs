import assert from 'node:assert/strict'
import { cloudPathForms } from '../src/main/sync.ts'

const path = 'onedrive:진행중사건/서울가정법원_2025느합1050'
const { root, segments } = cloudPathForms(path)

assert.equal(root, 'onedrive:')
assert.equal(segments.length, 2)
assert.ok(segments[0].includes('진행중사건'.normalize('NFC')))
assert.ok(segments[0].includes('진행중사건'.normalize('NFD')))
assert.ok(segments[1].includes('서울가정법원_2025느합1050'.normalize('NFC')))
assert.ok(segments[1].includes('서울가정법원_2025느합1050'.normalize('NFD')))

console.log('verify-sync-unicode: OK')
