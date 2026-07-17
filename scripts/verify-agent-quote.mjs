import assert from 'node:assert/strict'
import { quoteAgentRequest } from '../src/renderer/src/agent/quote.ts'

assert.equal(
  quoteAgentRequest('기존 답변', '이 부분만 고쳐줘'),
  [
    '다음은 사용자가 인용한 이전 에이전트 답변입니다.',
    '<quoted-agent-response>',
    '기존 답변',
    '</quoted-agent-response>',
    '',
    '이 부분만 고쳐줘'
  ].join('\n')
)

console.log('agent quote ok')
