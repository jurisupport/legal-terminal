import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const service = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const remoteControl = service.match(/function handleRemoteControlRequest[\s\S]*?\n}\n\nfunction runRemoteAgentMessage/)?.[0] ?? ''
const assistantMessage = service.match(/function handleAssistantMessage[\s\S]*?\n}\n\nfunction handleUserMessage/)?.[0] ?? ''
const streamEvent = service.match(/function handleStreamEvent[\s\S]*?\n}\n\nfunction handleSdkMessage/)?.[0] ?? ''
const codexDialogResult = service.match(/function buildCodexDialogResult[\s\S]*?\n}\n\nfunction handleCodexUserInputRequest/)?.[0] ?? ''
const serviceAnswerDialog = service.match(/export function answerAgentDialog[\s\S]*?\n}\n\nexport function interruptAgentSession/)?.[0] ?? ''
const panelAnswerDialog = panel.match(/const answerDialog[\s\S]*?\n  const selectDialogOption/)?.[0] ?? ''
const selectDialogOption = panel.match(/const selectDialogOption[\s\S]*?\n  const submitDialogChoices/)?.[0] ?? ''

assert.match(remoteControl, /request_user_dialog/)
assert.match(remoteControl, /requestUserDialog\(/)
assert.match(remoteControl, /writeRemoteControlResponse\([\s\S]*?result/)
assert.doesNotMatch(assistantMessage, /makeQuestionDialog\(/)
assert.doesNotMatch(streamEvent, /makeQuestionDialog\(/)
assert.match(codexDialogResult, /selected\.answers\.push\(response\)/)
assert.match(serviceAnswerDialog, /session\.turnAssistantMessageId = randomUUID\(\)[\s\S]*pending\.finish/)
assert.match(panelAnswerDialog, /input\.trim\(\)[\s\S]*response: combinedResponse[\s\S]*setInput\(''\)/)
assert.match(selectDialogOption, /dialogResponses\[dialogId\]\?\.trim\(\)/)
assert.match(selectDialogOption, /questions\.every\([\s\S]*answerDialog/)
assert.match(panel, /placeholder="추가 메시지 또는 직접 입력"/)
assert.match(panel, /item\.status !== 'waiting' && item\.text/)

console.log('selection dialogs preserve ordering and submit complete answers immediately')
