import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')

const authStatus = service.match(/function emitAuthStatus[\s\S]*?\n}/)?.[0] ?? ''
assert.match(authStatus, /state === 'authenticated' \|\| state === 'error'/)
assert.match(authStatus, /queueMicrotask/)
assert.match(authStatus, /startNextQueuedMessage\(session\)/)

const send = service.match(/export function sendAgentMessage[\s\S]*?\n}/)?.[0] ?? ''
const checking = send.match(/if \(session\.authStatus === 'checking'\)[\s\S]*?\n  }/)?.[0] ?? ''
assert.match(checking, /enqueueAgentMessage\(session, input,/)
assert.match(checking, /return \{ ok: true \}/)
assert.doesNotMatch(send, /로그인 상태를 확인 중입니다/)

const interruptStart = service.indexOf('export function interruptAgentSession')
const interruptEnd = service.indexOf('export function closeAgentSession', interruptStart)
const interrupt = service.slice(interruptStart, interruptEnd)
assert.match(interrupt, /const authProcess = session\.authProcess/)
assert.match(interrupt, /if \(authProcess\) \{[\s\S]*?type: 'auth:done'/)
assert.match(interrupt, /if \(authProcess\) refreshAgentAuthStatus\(session\)/)

const composerStart = panel.indexOf('<textarea', panel.indexOf('className="agent-composer"'))
const composerEnd = panel.indexOf('/>', composerStart)
const composerInput = panel.slice(composerStart, composerEnd)
assert.doesNotMatch(composerInput, /disabled=\{authActive\}/)

console.log('messages wait for auth checks and interrupted login releases the prompt')
