import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const renderer = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')

assert.match(renderer, /authStatus === 'authenticated'\s*\? '계정 변경'/)
const disabled = renderer.match(/const authButtonDisabled =([\s\S]*?)\n  const visibleRateLimits/)?.[1] ?? ''
assert.doesNotMatch(disabled, /authStatus === 'authenticated'/)

const login = service.match(/export function startAgentAuthLogin[\s\S]*?\n}\n\nexport function sendAgentAuthInput/)?.[0] ?? ''
assert.doesNotMatch(login, /session\.authStatus === 'authenticated'/)
assert.match(login, /call \$\{codexBin} logout/)
assert.match(login, /codexProcess\?\.kill\(\)/)
const remoteClaude = service.match(/function remoteClaudeAuthCommand[\s\S]*?\n}\n\nfunction remoteClaudeAuthStatusCommand/)?.[0] ?? ''
assert.match(remoteClaude, /auth logout >\/dev\/null 2>&1 \|\| true/)
assert.match(remoteClaude, /__LT_CLAUDE_AUTH_PID__/)
assert.match(login, /controlMaster: true/)
assert.match(service, /-O',\s*'forward'/)
assert.match(service, /-O',\s*'cancel'/)
assert.match(service, /remoteClaudeAuthPortCommand/)

const completeLinesSource = service.match(/function completeAuthOutputLines[\s\S]*?\n}/)?.[0] ?? ''
assert.ok(completeLinesSource)
const completeAuthOutputLines = Function(`return (${completeLinesSource})`)()
const partialUrl = 'https://claude.ai/oauth/authorize?code=true&client_id=test&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co'
let [complete, remainder] = completeAuthOutputLines({ chunk: partialUrl })
assert.equal(complete, '')
const urlTail = 'm&scope=user%3Aprofile&code_challenge=test&code_challenge_method=S256&state=test'
;[complete, remainder] = completeAuthOutputLines({
  buffer: remainder,
  chunk: `${urlTail}\n`
})
assert.match(complete, /platform\.claude\.com&scope=/)
assert.equal(remainder, '')
assert.match(service, /filter\(isCompleteClaudeAuthUrl\)/)
const completeUrlSource = service.match(/function isCompleteClaudeAuthUrl[\s\S]*?\n}/)?.[0] ?? ''
assert.ok(completeUrlSource)
const isCompleteClaudeAuthUrl = Function(`return (${completeUrlSource})`)()
assert.equal(isCompleteClaudeAuthUrl(partialUrl), false)
assert.equal(isCompleteClaudeAuthUrl(partialUrl + urlTail), true)

console.log('authenticated agents can start account switching')
