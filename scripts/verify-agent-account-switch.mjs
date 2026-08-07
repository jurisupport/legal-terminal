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

console.log('authenticated agents can start account switching')
