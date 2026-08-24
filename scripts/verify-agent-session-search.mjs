import assert from 'node:assert/strict'
import {
  expandSessionSearchLimit,
  matchesSearch,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_RECENT_LIMIT
} from '../src/renderer/src/search/sessionSearch.ts'

const sessions = [
  ['최근 계약 검토', '/사건/계약'],
  ['오래된 임대차 분쟁', '/사건/임대차'],
  ['형사 기록 정리', '/사건/형사']
]

assert.deepEqual(
  sessions.filter((parts) => matchesSearch(parts, '오래된 임대차')),
  [sessions[1]]
)
assert.equal(expandSessionSearchLimit(SESSION_SEARCH_RECENT_LIMIT), 200)
assert.equal(expandSessionSearchLimit(200), SESSION_SEARCH_MAX_LIMIT)
assert.equal(expandSessionSearchLimit(SESSION_SEARCH_MAX_LIMIT), SESSION_SEARCH_MAX_LIMIT)

console.log('verify-agent-session-search: OK')
