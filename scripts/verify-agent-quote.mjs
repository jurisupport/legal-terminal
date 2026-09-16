import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
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
  /shouldFollowTimelineRef\.current = false\s+target\.scrollIntoView/,
  'opening a quote must pause streaming output auto-scroll'
)
assert.match(
  panel,
  /!timelineUserScrollRef\.current && shouldFollowTimelineRef\.current !== atBottom/,
  'programmatic scrolling must not override the explicit timeline follow state'
)
assert.match(
  panel,
  /data-agent-quote=""/,
  'the existing quote action must be reusable by the selection question UI'
)

// Exercise the real handlers with browser frames held until after quote navigation.
const handlers = ['revealQuotedMessage', 'scrollTimelineToBottom', 'markTimelineUserScroll', 'updateTimelineFollowState']
const handlerSource = handlers.map((name) => {
  const match = panel.match(new RegExp(`  const ${name} = useCallback\\([\\s\\S]*?(?=\\n\\n  (?:const|useEffect))`))
  assert.ok(match, `missing timeline handler: ${name}`)
  return match[0]
}).join('\n')
const frames = []
const timers = new Map()
let notice = false
let bottomScrolls = 0
let quoteScrolls = 0
const timeline = {
  scrollHeight: 2000, clientHeight: 500, scrollTop: 1500,
  scrollTo({ top }) {
    bottomScrolls++
    this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight)
  }
}
const follow = { current: true }
const userScroll = { current: false }
const controls = runInNewContext(ts.transpileModule(`${handlerSource}\n;({ ${handlers.join(', ')} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, {
  id: 'quote-regression',
  useCallback: (callback) => callback,
  shouldFollowTimelineRef: follow,
  timelineUserScrollRef: userScroll,
  timelineUserScrollTimerRef: { current: null },
  scrollRef: { current: timeline },
  setNewOutputNotice: (visible) => { notice = visible },
  isTimelineNearBottom: (element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 36,
  window: { requestAnimationFrame: (callback) => { frames.push(callback) } },
  setTimeout: (callback) => { timers.set(callback, callback); return callback },
  clearTimeout: (timer) => { timers.delete(timer) },
  document: {
    getElementById: () => ({
      querySelector: () => null,
      // A smooth scroll can report its initial position before it leaves the bottom.
      scrollIntoView: () => { quoteScrolls++ }
    })
  }
})

controls.scrollTimelineToBottom()
assert.equal(bottomScrolls, 1)
controls.revealQuotedMessage({ messageId: 'original' })
timeline.scrollTop = 200
frames.splice(0).forEach((callback) => callback())
assert.equal(bottomScrolls, 1, 'a queued auto-scroll must stop after opening a quote')
assert.equal(timeline.scrollTop, 200, 'the quoted passage must stay in view')

controls.scrollTimelineToBottom()
frames.splice(0).forEach((callback) => callback())
controls.markTimelineUserScroll() // pointerdown on the sent quote button bubbles to the timeline
controls.revealQuotedMessage({ messageId: 'original' })
controls.updateTimelineFollowState()
assert.equal(follow.current, false, 'the first smooth-scroll event must not resume following at the bottom')
timeline.scrollTop = 200
controls.updateTimelineFollowState()
timers.forEach((callback) => callback())
assert.equal(follow.current, false, 'quote navigation must remain paused after the input timer expires')
assert.equal(quoteScrolls, 2)

notice = true
controls.scrollTimelineToBottom()
assert.equal(follow.current, true, 'the new-output button must resume following')
assert.equal(notice, false)
timeline.scrollHeight += 100
frames.splice(0).forEach((callback) => callback())
assert.equal(timeline.scrollTop, 1600, 'resumed following must account for output added before the next frame')
controls.markTimelineUserScroll()
timeline.scrollTop = 200
controls.updateTimelineFollowState()
assert.equal(follow.current, false, 'manual scrolling up must still pause following')
timeline.scrollTop = 1600
controls.updateTimelineFollowState()
assert.equal(follow.current, true, 'manual scrolling back to the bottom must still resume following')

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
