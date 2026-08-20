import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  quoteAgentRequest,
  restoreTextSelection,
  selectionTextOffsets
} from '../src/renderer/src/agent/quote.ts'

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

const panel = await readFile(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
assert.match(
  panel,
  /<button[^>]*className="agent-quote-preview"[^>]*onClick=\{onOpen\}/,
  'the quoted preview itself must open the original response'
)
assert.match(
  panel,
  /selectionTextOffsets\(selection, content\)/,
  'a selected quote must retain its exact text offsets'
)
assert.match(
  panel,
  /restoreTextSelection\(content, quote\.selectionStart, quote\.selectionEnd\)/,
  'opening a selected quote must restore the original text selection'
)
assert.match(
  panel,
  /data-agent-quote=""/,
  'the existing quote action must be reusable by the selection question UI'
)

const app = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
assert.match(
  app,
  /agentQuoteMessageId:\s*element\?\.closest<HTMLElement>\('\.agent-msg\.assistant'\)\?\.id/,
  'an Agent-panel selection must retain its source message id'
)
assert.equal(
  app.match(/quoteAgentPanelSelection\([^)]*\.askOpts\)/g)?.length,
  2,
  'both Agent-panel selection question entry points must reuse the quote action'
)

const firstText = { length: 5, parentElement: { id: 'first' } }
const secondText = { length: 6, parentElement: { id: 'second' } }
const nodes = [firstText, secondText]
const restoredRange = {}
const restoredSelection = {
  removeAllRanges() {},
  addRange(range) {
    assert.equal(range, restoredRange)
  }
}
const root = {
  contains: () => true,
  ownerDocument: {
    defaultView: { NodeFilter: { SHOW_TEXT: 4 }, getSelection: () => restoredSelection },
    createTreeWalker: () => {
      let index = 0
      return { nextNode: () => nodes[index++] }
    },
    createRange: () => Object.assign(restoredRange, {
      setStart(node, offset) {
        assert.equal(node, secondText)
        assert.equal(offset, 0)
      },
      setEnd(node, offset) {
        assert.equal(node, secondText)
        assert.equal(offset, 2)
      }
    })
  }
}
const sourceRange = {
  startContainer: firstText,
  startOffset: 3,
  endContainer: secondText,
  endOffset: 2,
  toString: () => '가나다라',
  cloneRange: () => ({
    selectNodeContents() {},
    setEnd() {},
    toString: () => '앞쪽문'
  })
}
assert.deepEqual(
  selectionTextOffsets(
    { isCollapsed: false, rangeCount: 1, getRangeAt: () => sourceRange },
    root
  ),
  { start: 3, end: 7 }
)
assert.equal(restoreTextSelection(root, 5, 7), secondText.parentElement)

console.log('agent quote ok')
