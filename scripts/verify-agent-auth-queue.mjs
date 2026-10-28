import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')

const authStatus = service.match(/function emitAuthStatus[\s\S]*?\n}/)?.[0] ?? ''
assert.match(authStatus, /state === 'authenticated' \|\| state === 'error'/)
assert.match(authStatus, /queueMicrotask/)
assert.match(authStatus, /startNextQueuedMessage\(session\)/)

const send = service.match(/export function sendAgentMessage[\s\S]*?\n}/)?.[0] ?? ''
const checking = send.match(/if \(session\.authStatus === 'checking' \|\| session\.remoteRestoring\)[\s\S]*?\n  }/)?.[0] ?? ''
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

const displayHelpers = ['agentInputDisplayText', 'queuedTextPreview'].map(name => {
  const match = service.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))
  assert.ok(match, `missing queued display helper: ${name}`)
  return match[0]
}).join('\n')
const queuedText = runInNewContext(ts.transpileModule(`${displayHelpers}\nqueuedTextPreview`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText)
const fullText = '다음 사항을 빠짐없이 검토해 주세요.\n'.repeat(30)
assert.equal(queuedText({ text: fullText }), fullText.trim(), 'queued details retain instructions beyond 360 characters')
assert.equal(queuedText({ text: 'internal request context', displayText: fullText }), fullText.trim(), 'queued details use user-facing text')
assert.equal(queuedText({ text: '', attachments: [{ label: '계약서.pdf' }, { label: '회의.mp4' }] }), '계약서.pdf, 회의.mp4', 'attachment-only requests retain their labels')

console.log('messages wait for auth checks, interrupted login releases the prompt, and queued details retain full user-facing text')
