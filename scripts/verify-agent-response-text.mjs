import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as browserBridge from '../src/main/browserAgentBridge.ts'
import * as values from '../src/renderer/src/agent/values.ts'

// Exercise provider events through the real renderer reducer, without a model call.
const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const service = { exports: {} }
runInNewContext(ts.transpileModule(`${source}\nexport const check = { handleSdkMessage, handleRemoteJsonLine, handleCodexNotification };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: service.exports, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  require: (name) => {
    if (name === '@anthropic-ai/claude-agent-sdk') return {}
    if (name === '../jurisupport') return { onAgentMcpAccountChange: () => {} }
    if (name === '../browserAgentBridge') return browserBridge
    if (name === './agentMcp') return { managedToolName: () => undefined }
    if (name.startsWith('.')) return {}
    return require(name)
  }
})
const { handleSdkMessage, handleRemoteJsonLine, handleCodexNotification } = service.exports.check
const panel = readFileSync(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('AgentPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const reducerNames = new Set(['upsertItem', 'reduceTimeline'])
const reducerSource = ast.statements.filter((node) => reducerNames.has(node.name?.text) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => reducerNames.has(declaration.name.getText(ast)))))
  .map((node) => node.getText(ast)).join('\n')
const reduceTimeline = runInNewContext(ts.transpileModule(`${reducerSource}\nreduceTimeline`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, values)

function conversation(provider) {
  let items = []
  const session = {
    id: 'response-check', provider: provider === 'codex' ? 'codex' : 'claude',
    turnAssistantMessageId: 'answer-1', codexThreadId: 'thread-1', codexTurnWaiter: { turnId: 'turn-1' },
    assistantMessages: new Set(), assistantText: new Map(), assistantStreamed: new Set(), startedTools: new Set(),
    viewers: new Map([[1, { isDestroyed: () => false, send: (_channel, event) => {
      if (event.type.startsWith('message:assistant_')) items = reduceTimeline(items, event, 'Agent')
    } }]])
  }
  const send = (message) => provider === 'ssh'
    ? handleRemoteJsonLine(session, JSON.stringify(message)) : handleSdkMessage(session, message)
  const notify = (method, extra) => handleCodexNotification(session, {
    method, params: { threadId: 'thread-1', turnId: 'turn-1', ...extra }
  })
  return {
    session,
    items: () => items,
    reply(chunks, nativeId = 'native-answer-1') {
      if (provider === 'codex') notify('item/started', { item: { id: nativeId, type: 'agentMessage', text: '' } })
      else {
        send({ type: 'stream_event', event: { type: 'message_start', message: { id: nativeId } } })
        send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      }
      for (const text of chunks) {
        if (provider === 'codex') notify('item/agentMessage/delta', { itemId: nativeId, delta: text })
        else send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
      }
      const streamed = items.at(-1)?.text
      const complete = () => {
        if (provider === 'codex') notify('item/completed', { item: { id: nativeId, type: 'agentMessage', text: chunks.join('') } })
        else send({ type: 'assistant', uuid: nativeId, message: { id: nativeId, content: [{ type: 'text', text: chunks.join('') }] } })
      }
      complete()
      complete()
      if (provider !== 'codex') {
        send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
        send({ type: 'stream_event', event: { type: 'message_stop' } })
      }
      return streamed
    }
  }
}

const chunkCases = [
  ['검토 결과:\n', '- 확인 필요\n', '- 확인 필요\n', '이상입니다.'],
  ['가', '가 반복됩니다.'],
  ['들여쓰기:\n    ', '    ', '본문\n완료'],
  ['경계: 같은 문구', '같은 문구를 반복합니다.']
]
const markdown = '## 검토 결과\n\n| 항목 | 결과 |\n| -------- | -------- |\n| 가 | 확인 |\n\n        들여쓰기\n같은 문구같은 문구.\n끝.'
for (let size = 1; size <= 32; size++) {
  chunkCases.push(Array.from({ length: Math.ceil(markdown.length / size) }, (_, i) => markdown.slice(i * size, (i + 1) * size)))
}
for (const provider of ['claude', 'ssh', 'codex']) {
  for (const chunks of chunkCases) {
    const view = conversation(provider)
    const streamed = view.reply(chunks)
    assert.equal(view.items().length, 1, `${provider}: completing a streamed reply must keep one message`)
    assert.equal(view.items()[0].text, chunks.join(''), `${provider}: the final answer must not append a second copy`)
    assert.equal(streamed, chunks.join(''), `${provider}: repeated text and whitespace must survive streaming`)
    assert.equal(view.items()[0].status, 'done')
    if (provider !== 'codex') assert.deepEqual(Array.from(view.items()[0].transcriptIds), ['history-native-answer-1'],
      `${provider}: native response IDs survive repeated completion events for live history matching`)
    view.session.turnAssistantMessageId = 'answer-2'
    view.reply(chunks, 'native-answer-2')
    assert.equal(view.items().length, 2, `${provider}: a new turn may intentionally repeat the previous answer`)
    assert.equal(view.items()[1].text, chunks.join(''))
  }
  const view = conversation(provider)
  view.reply(['먼저 자료를 확인하겠습니다.\n\n'])
  view.reply(['검토 결과:\n', '- 확인 필요\n', '- 확인 필요\n', '이상입니다.'], 'native-answer-2')
  assert.equal(view.items().map((item) => item.text).join(''), '먼저 자료를 확인하겠습니다.\n\n검토 결과:\n- 확인 필요\n- 확인 필요\n이상입니다.',
    `${provider}: later replies in the same turn must preserve earlier output`)
  if (provider !== 'codex') assert.deepEqual(Array.from(view.items()[0].transcriptIds), ['history-native-answer-1', 'history-native-answer-2'],
    'one rich local answer retains every native response identity')
}
console.log('agent response text: local Claude, SSH and Codex preserve repeated text across chunk boundaries without duplicating completed replies')
