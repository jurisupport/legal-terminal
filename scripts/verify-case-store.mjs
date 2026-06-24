import assert from 'node:assert/strict'
import { parseCaseStoreText } from '../src/main/caseStoreData.ts'

const broken = `{
  "pairings": {},
  "recent": [
    { "drafts": "/drafts", "records": "/records", "name": "case", "ts": 1 }
  ],
  "jsPairings": {}
}  "remote:profile:case": {
    "drafts": "ssh://profile/drafts"
  }
}`

const repaired = parseCaseStoreText(broken)
assert.equal(repaired.recent.length, 1)
assert.equal(repaired.recent[0].drafts, '/drafts')
assert.equal(repaired.jsPairings['remote:profile:case'].drafts, 'ssh://profile/drafts')

const normal = parseCaseStoreText(
  JSON.stringify({
    pairings: { '/drafts': '/records' },
    recent: [],
    jsPairings: { case: { drafts: '/drafts', records: '/records' } }
  })
)
assert.equal(normal.pairings['/drafts'], '/records')
assert.equal(normal.jsPairings.case.records, '/records')

console.log('case store ok')
