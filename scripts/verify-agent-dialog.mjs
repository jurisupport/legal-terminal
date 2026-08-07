import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const remoteControl = service.match(/function handleRemoteControlRequest[\s\S]*?\n}\n\nfunction runRemoteAgentMessage/)?.[0] ?? ''
const assistantMessage = service.match(/function handleAssistantMessage[\s\S]*?\n}\n\nfunction handleUserMessage/)?.[0] ?? ''
const streamEvent = service.match(/function handleStreamEvent[\s\S]*?\n}\n\nfunction handleSdkMessage/)?.[0] ?? ''

assert.match(remoteControl, /request_user_dialog/)
assert.match(remoteControl, /requestUserDialog\(/)
assert.match(remoteControl, /writeRemoteControlResponse\([\s\S]*?result/)
assert.doesNotMatch(assistantMessage, /makeQuestionDialog\(/)
assert.doesNotMatch(streamEvent, /makeQuestionDialog\(/)

console.log('remote Claude selection dialogs resume the active turn')
