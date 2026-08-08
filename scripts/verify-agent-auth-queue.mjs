import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')

const authStatus = service.match(/function emitAuthStatus[\s\S]*?\n}/)?.[0] ?? ''
assert.match(authStatus, /state === 'authenticated' \|\| state === 'error'/)
assert.match(authStatus, /queueMicrotask/)
assert.match(authStatus, /startNextQueuedMessage\(session\)/)

const send = service.match(/export function sendAgentMessage[\s\S]*?\n}/)?.[0] ?? ''
const checking = send.match(/if \(session\.authStatus === 'checking'\)[\s\S]*?\n  }/)?.[0] ?? ''
assert.match(checking, /enqueueAgentMessage\(session, input,/)
assert.match(checking, /return \{ ok: true \}/)
assert.doesNotMatch(send, /로그인 상태를 확인 중입니다/)

console.log('messages wait for the initial agent auth check')
