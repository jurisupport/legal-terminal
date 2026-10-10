import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { normalizeMediaSelection } from '../src/shared/media.ts'
import { asRecord, stringValue, numberValue, recordArray } from '../src/renderer/src/agent/values.ts'
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

// Follow a PDF quote from selection through attachment serialization to source navigation.
const declarations = new Map()
for (const source of [app, panel]) {
  const parsed = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer)
      declarations.set(node.name.getText(parsed), `const ${node.name.getText(parsed)} = ${node.initializer.getText(parsed)};`)
    if (ts.isFunctionDeclaration(node) && node.name)
      declarations.set(node.name.text, node.getText(parsed))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
}
const selectedNode = {}
const pdfLayer = {
  dataset: { pdfPage: '12', pdfPath: 'ssh://office/records/contract.pdf' },
  contains: (node) => node === selectedNode
}
const selectedRange = { startContainer: selectedNode, endContainer: selectedNode }
const pdfElement = {
  closest: () => pdfLayer,
  ownerDocument: { defaultView: { getSelection: () => ({ rangeCount: 1, getRangeAt: () => selectedRange }) } }
}
const docs = { current: [{ id: 'record-tab', path: pdfLayer.dataset.pdfPath, kind: 'pdf' }] }
let openedPath, activatedDoc, pdfRequest, markdownRequest
const quoteHandlers = [
  'selectionSourceForElement', 'selectionAttachmentLabel', 'selectionAttachmentForAgent',
  'markdownRangeFromAttachmentSource', 'openAgentAttachmentSource',
  'attachmentSource', 'attachmentOrigin', 'attachmentAccess', 'normalizeAgentAttachments',
  'askClaude', 'agentSelectionInputText', 'rememberedAgentForDoc', 'documentAgentKey'
]
let queuedQuote, queuedTarget
const agents = []
const documentAgentTabs = {}
const pdf = runInNewContext(ts.transpileModule(
  quoteHandlers.map((name) => {
    assert.ok(declarations.has(name), `missing quote handler: ${name}`)
    return declarations.get(name)
  }).join('\n') + `\n;({ ${quoteHandlers.join(', ')} })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText, {
  asRecord, stringValue, numberValue, recordArray, normalizeMediaSelection,
  closestHTMLElement: () => ({ dataset: { docId: 'record-tab' } }),
  claudeReadablePath: (path) => path.replace('ssh://office', ''),
  formatCharCount: String, selectionAttachmentSeqRef: { current: 0 },
  docTabsRef: docs, jumpNonce: { current: 0 }, markdownRevealSeqRef: { current: 0 },
  activateDocTab: (id) => { activatedDoc = id },
  openFile: (path) => { openedPath = path; return 'reopened-pdf' },
  fileNameFromPath: (path) => path.split('/').at(-1),
  setPdfJump: (request) => { pdfRequest = request },
  setMarkdownRevealRequests: (update) => { markdownRequest = update({}) },
  visibleTermTabs: agents, termTabsRef: { current: agents }, activeTerm: '', activeWork: {}, activeTermTab: undefined,
  documentAgentTabs,
  activeDoc: 'some-other-doc', sessionCaseSource: {}, docOnly: false,
  resolveClaudeAgentTargetTab: () => undefined,
  dirtyMarkdownTabForPath: () => undefined,
  confirmCaseFileScope: async () => true,
  isAgentTab: (tab) => tab?.kind === 'agent',
  createClaudeAgentForPrompt: () => ({ id: 'new-agent', kind: 'agent' }),
  queueAgentAttachment: (tab, attachment) => { queuedTarget = tab; queuedQuote = attachment }
})
const captured = pdf.selectionSourceForElement(pdfElement, '인용한 계약 조항')
assert.equal(captured.range.startPage, 12)
assert.equal(captured.docPath, pdfLayer.dataset.pdfPath)
const attachment = pdf.selectionAttachmentForAgent('인용한 계약 조항', {
  docPath: captured.docPath, docName: '계약서', selectionSource: captured
}, {})
assert.match(attachment.label, /계약서 · PDF 12쪽/)
assert.match(attachment.text, /인용 위치: PDF 12쪽 \(파일의 실제 쪽번호\)/)
assert.equal(attachment.path, '/records/contract.pdf', 'agent receives its remote-readable path')
const [saved] = pdf.normalizeAgentAttachments(JSON.parse(JSON.stringify([attachment])))
assert.equal(saved.source.range.startPage, 12, 'sent/history attachments preserve page metadata')
pdf.openAgentAttachmentSource(saved)
assert.equal(activatedDoc, 'record-tab')
assert.equal(pdfRequest.page, 12)
assert.equal(pdfRequest.docId, 'record-tab')
assert.equal(pdfRequest.path, captured.docPath)
assert.equal(markdownRequest, undefined, 'PDF navigation must not use Markdown reveal')
docs.current[0].path = 'ssh://office/records/next.pdf'
pdf.openAgentAttachmentSource(saved)
assert.equal(openedPath, captured.docPath, 'a record tab that changed document must not misdirect the citation')
assert.equal(pdfRequest.docId, 'reopened-pdf')
const secondNonce = pdfRequest.nonce
pdf.openAgentAttachmentSource(saved)
assert.ok(pdfRequest.nonce > secondNonce, 'opening the same citation again must navigate again')
for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
  pdfLayer.dataset.pdfPage = invalid
  assert.equal(pdf.selectionSourceForElement(pdfElement, 'text').range, undefined)
}
pdfLayer.dataset.pdfPage = '12'
selectedRange.endContainer = {}
assert.equal(pdf.selectionSourceForElement(pdfElement, 'text').range, undefined,
  'a selection spanning different containers must not claim a single PDF page')
const markdownRange = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 }
pdf.openAgentAttachmentSource({ source: { docId: 'record-tab', text: '원문', range: markdownRange } })
assert.equal(markdownRequest['record-tab'].range.startLine, 2, 'Markdown source navigation remains intact')
pdf.askClaude('인용한 계약 조항', { selectionSource: captured })
await new Promise(setImmediate)
assert.equal(queuedQuote.source.range.startPage, 12, 'a new Agent tab receives the same navigable citation')
assert.equal(queuedQuote.source.path, captured.docPath, 'quote source must not drift when another document becomes active')

agents.push({ id: 'remembered-codex', kind: 'agent', agentProvider: 'codex' })
docs.current[0].path = captured.docPath
documentAgentTabs[pdf.documentAgentKey(docs.current[0])] = 'remembered-codex'
const linkedPath = docs.current[0].path
docs.current[0].path = 'ssh://office/records/another.pdf'
assert.equal(pdf.rememberedAgentForDoc(docs.current[0]), undefined, 'another file in the same record tab starts unlinked')
docs.current[0].path = linkedPath
assert.equal(pdf.rememberedAgentForDoc(docs.current[0]).id, 'remembered-codex', 'returning to the original file restores its link')
assert.equal(pdf.rememberedAgentForDoc({ ...docs.current[0], caseTabId: 'another-case' }), undefined,
  'the same file opened in another case has a separate panel link')
pdf.askClaude('기억한 패널에 질문', { selectionSource: captured })
await new Promise(setImmediate)
assert.equal(queuedTarget.id, 'remembered-codex', 'selection uses the source document’s remembered panel, including Codex')
assert.equal(queuedQuote.source.docId, 'record-tab')
pdf.askClaude('에이전트 답변 인용', { docPath: null })
await new Promise(setImmediate)
assert.equal(queuedTarget.id, 'new-agent', 'agent response quotes do not inherit the current document link')
agents.length = 0
pdf.askClaude('닫힌 패널 대신 질문', { selectionSource: captured })
await new Promise(setImmediate)
assert.equal(queuedTarget.id, 'new-agent', 'a closed remembered panel falls back to an available agent')

const media = { sourcePath: '/shorts/video.mp4', versionId: 'review-v1', time: 12.3, start: 12.3, end: 15.8 }
const [mediaQuote] = pdf.normalizeAgentAttachments([{ kind: 'media-range', label: '12.3–15.8초', media }])
assert.deepEqual(JSON.parse(JSON.stringify(mediaQuote.media)), media, 'media selection survives history normalization')
assert.equal(pdf.normalizeAgentAttachments([{ kind: 'media-range', label: 'invalid', media: { ...media, end: 1 } }]).length, 0)

console.log('agent quote ok: timeline, PDF/media capture, attachment history, and original-document navigation')
