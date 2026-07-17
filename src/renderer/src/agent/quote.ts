export function quoteAgentRequest(quote: string, request: string): string {
  return [
    '다음은 사용자가 인용한 이전 에이전트 답변입니다.',
    '<quoted-agent-response>',
    quote,
    '</quoted-agent-response>',
    '',
    request
  ].join('\n')
}
