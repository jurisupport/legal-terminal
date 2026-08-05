import assert from 'node:assert/strict'
import {
  claudeUsageRateLimitType,
  shouldRefreshClaudeUsageSummaryForContextUsage,
  shouldRefreshClaudeUsageSummaryForRateLimit
} from '../src/main/agent/agent-service.ts'

assert.equal(claudeUsageRateLimitType('Week (Fable)'), 'seven_day_fable')

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'claude',
    { rateLimitType: 'seven_day', remainingPercent: 12 },
    ['seven_day']
  ),
  true,
  'a seven-day event must probe /usage when the five-hour limit has not been seen yet'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'claude',
    { rateLimitType: 'seven_day', remainingPercent: 12 },
    ['five_hour', 'seven_day']
  ),
  false,
  'a seven-day event should not probe again when the five-hour limit is already known'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'claude',
    { rateLimitType: 'five_hour', remainingPercent: 80 },
    ['five_hour']
  ),
  false,
  'a normal five-hour event with a known remaining percent does not need the /usage fallback'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'claude',
    { rateLimitType: 'five_hour' },
    ['five_hour']
  ),
  true,
  'events without utilization still need /usage to fill the displayed remaining percent'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'codex',
    { rateLimitType: 'seven_day', remainingPercent: 12 },
    ['seven_day']
  ),
  false,
  'Codex rate limits are handled by the Codex app-server path'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForRateLimit(
    'claude',
    { rateLimitType: 'overage' },
    ['overage']
  ),
  false,
  'overage status alone should not run the Claude /usage fallback'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('claude', { totalTokens: 19_999 }, undefined, 20_000),
  false,
  'short Claude conversations should not spawn /usage probes just because context is being polled'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('claude', { totalTokens: 20_000 }, undefined, 20_000),
  true,
  'Claude usage should refresh once the context reaches the first configured token interval'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('claude', { totalTokens: 35_000 }, 20_000, 20_000),
  false,
  'Claude usage should wait until the next full token interval before probing again'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('claude', { totalTokens: 40_000 }, 20_000, 20_000),
  true,
  'Claude usage should refresh again after another full context token interval'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('claude', { totalTokens: 40_000 }, 60_000, 20_000),
  false,
  'Claude usage should not probe just because compaction lowered the context token count'
)

assert.equal(
  shouldRefreshClaudeUsageSummaryForContextUsage('codex', { totalTokens: 40_000 }, undefined, 20_000),
  false,
  'Codex usage updates arrive through the Codex app-server notifications'
)

console.log('agent rate limits ok')
