// A loopback Messages API fixture for the actual packaged Claude CLI.
import { createServer } from 'node:http'

export function boardInference(respond) {
  return createServer(async (req, res) => {
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 3 }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    const { name, args, text } = respond(input, req.headers)
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 8 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    function event(type, value) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`) }
    event('message_start', { message })
    event('content_block_start', { index: 0, content_block: name ? { type: 'tool_use', id: 'toolu_fixture', name, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: name ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    event('message_stop', {})
    res.end()
  })
}
