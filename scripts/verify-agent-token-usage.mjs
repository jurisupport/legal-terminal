import assert from 'node:assert/strict'
import { tokenUsageFromTranscript } from '../src/main/agent/tokenUsage.ts'

const transcript = [
  { uuid: 'user-1', message: { role: 'user', content: '첫 질문' } },
  {
    uuid: 'assistant-thinking',
    message: {
      id: 'message-1',
      role: 'assistant',
      usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100 }
    }
  },
  {
    uuid: 'assistant-text',
    message: {
      id: 'message-1',
      role: 'assistant',
      usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100 }
    }
  },
  { uuid: 'tool-result', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { uuid: 'user-2', message: { role: 'user', content: [{ type: 'text', text: '둘째 질문' }] } },
  {
    uuid: 'assistant-2',
    message: {
      id: 'message-2',
      role: 'assistant',
      usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 200 }
    }
  }
]

const usage = tokenUsageFromTranscript(transcript.map((entry) => JSON.stringify(entry)).join('\n'), 123)

assert.deepEqual(usage, {
  turns: 2,
  inputTokens: 5,
  outputTokens: 30,
  cacheCreationInputTokens: 100,
  cacheReadInputTokens: 200,
  totalTokens: 335,
  lastTurnTokens: 223,
  updatedAt: 123
})
assert.equal(tokenUsageFromTranscript('invalid\n{}'), undefined)

console.log('agent transcript token usage ok')
