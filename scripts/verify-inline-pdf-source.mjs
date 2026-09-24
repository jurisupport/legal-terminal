import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const read = (path) => readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), 'utf8')
const app = read('App.tsx')
const viewer = read('viewer/PdfViewer.tsx')
const record = read('viewer/RecordViewer.tsx')
const parse = (source) => ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const run = (source, context) => vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, context)
const declarations = new Map()
const appAst = parse(app)
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(appAst), node.initializer.getText(appAst))
  ts.forEachChild(node, visit)
}
visit(appAst)
const selectedNode = {}
const selectedRange = { startContainer: selectedNode, endContainer: selectedNode }
const layer = { dataset: { pdfPage: '12', pdfPath: 'ssh://office/records/contract.pdf' }, contains: (node) => node === selectedNode }
const element = {
  closest: () => layer,
  ownerDocument: { defaultView: { getSelection: () => ({ rangeCount: 1, getRangeAt: () => selectedRange }) } }
}
const docs = { current: [{ id: 'record-tab', path: layer.dataset.pdfPath, kind: 'pdf' }] }
let activated, opened, jump, markdown
const names = ['selectionSourceForElement', 'selectionAttachmentForAgent', 'selectionAttachmentLabel', 'markdownRangeFromAttachmentSource', 'openAgentAttachmentSource']
const handlers = run(names.map((name) => {
  assert.ok(declarations.has(name), `missing ${name}`)
  return `const ${name} = ${declarations.get(name)};`
}).join('\n') + `\n({ ${names.join(', ')} })`, {
  closestHTMLElement: () => ({ dataset: { docId: 'record-tab' } }),
  claudeReadablePath: (path) => path.replace('ssh://office', ''), formatCharCount: String,
  selectionAttachmentSeqRef: { current: 0 }, docTabsRef: docs,
  jumpNonce: { current: 0 }, markdownRevealSeqRef: { current: 0 },
  activateDocTab: (id) => { activated = id },
  openFile: (path) => { opened = path; return 'reopened' },
  fileNameFromPath: (path) => path.split('/').at(-1),
  setPdfJump: (value) => { jump = value },
  setMarkdownRevealRequests: (update) => { markdown = update({}) }
})
const captured = handlers.selectionSourceForElement(element, '선택한 계약 조항')
layer.dataset.pdfPage = '15'
layer.dataset.pdfPath = 'ssh://office/records/next.pdf'
assert.equal(captured.range.startPage, 12, 'the source freezes the rendered page at selection time')
assert.equal(captured.range.endPage, 12)
assert.equal(captured.docPath, 'ssh://office/records/contract.pdf', 'later record navigation cannot rewrite the captured URI')
const attachment = handlers.selectionAttachmentForAgent('선택한 계약 조항', {
  docPath: captured.docPath, docName: '계약서', selectionSource: captured
}, {})
assert.equal(attachment.path, '/records/contract.pdf', 'the agent receives its readable remote path')
assert.equal(attachment.source.path, captured.docPath, 'source navigation retains the original SSH URI')
assert.match(attachment.label, /계약서 · PDF 12쪽/)
assert.match(attachment.text, /인용 위치: PDF 12쪽 \(파일의 실제 쪽번호\)/)
const saved = JSON.parse(JSON.stringify(attachment))
handlers.openAgentAttachmentSource(saved)
assert.equal(activated, 'record-tab')
assert.equal(jump.docId, 'record-tab')
assert.equal(jump.page, 12)
assert.equal(markdown, undefined)
docs.current[0].path = layer.dataset.pdfPath
handlers.openAgentAttachmentSource(saved)
assert.equal(opened, captured.docPath, 'a record tab that has moved must reopen the original file')
assert.equal(jump.docId, 'reopened')
const nonce = jump.nonce
handlers.openAgentAttachmentSource(saved)
assert.ok(jump.nonce > nonce, 'repeated source clicks issue another jump')
for (const page of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
  layer.dataset.pdfPage = page
  assert.equal(handlers.selectionSourceForElement(element, 'text').range, undefined)
}
layer.dataset.pdfPage = '12'
selectedRange.endContainer = {}
assert.equal(handlers.selectionSourceForElement(element, 'text').range, undefined, 'cross-container selections must not claim one page')
handlers.openAgentAttachmentSource({ source: { docId: 'record-tab', text: '원문', range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 } } })
assert.equal(markdown['record-tab'].range.startLine, 2, 'Markdown source navigation remains intact')

// Execute the actual asynchronous load effect and jump effect in mount order.
const effects = []
const viewerAst = parse(viewer)
function collectEffects(node) {
  if (ts.isCallExpression(node) && node.expression.getText(viewerAst) === 'useEffect') effects.push(node.arguments[0].getText(viewerAst))
  ts.forEachChild(node, collectEffects)
}
collectEffects(viewerAst)
const loadingEffect = effects.find((body) => body.includes('.readBytes(path)'))
const jumpEffect = effects.find((body) => body.includes('jumpTo?.path === path'))
assert.ok(loadingEffect && jumpEffect)
for (const [targetPath, requestedPage, expectedPage] of [['/record.pdf', 12, 12], ['/record.pdf', 80, 20], ['/other.pdf', 12, 3]]) {
  let page = 1, completeRead
  const noop = () => {}
  const context = {
    path: '/record.pdf', jumpTo: { path: targetPath, page: requestedPage, nonce: 1 },
    initialStatusRef: { current: { path: '/record.pdf', page: 3 } }, numPagesRef: { current: 0 },
    setPage: (update) => { page = typeof update === 'function' ? update(page) : update },
    setNumPages: noop, setRotation: noop, setErr: noop, setLoading: noop, setLoadCancelled: noop,
    setPasswordPrompt: noop, setPasswordValue: noop, setPasswordBusy: noop, clearPageCache: noop,
    passwordCallbackRef: { current: null }, cancelLoadRef: { current: null }, taskRef: { current: null }, docRef: { current: null },
    window: { lt: { fs: { readBytes: () => new Promise((resolve) => { completeRead = resolve }) } } },
    PdfJsWorker: class {}, pdfjs: { PDFWorker: class {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 20 }) }) },
    onOutline: undefined, cleanPdfError: (error) => { throw error }
  }
  run(`(${loadingEffect})()`, context)
  run(`(${jumpEffect})()`, context)
  completeRead(new ArrayBuffer(0))
  await new Promise(setImmediate)
  assert.equal(page, expectedPage, 'async loading preserves a target jump, clamps to page count, and ignores other files')
}
assert.equal((app.match(/jumpTo=\{pdfJump\?\.docId === tab\.id \? pdfJump : undefined\}/g) ?? []).length, 2, 'both document render paths isolate jumps by tab')
assert.match(record, /jumpTo=\{jumpTo\?\.path === cur\.path \? jumpTo : undefined\}/, 'record viewer forwards only the current file jump')
assert.match(viewer, /tl\.dataset\.pdfPage = String\(page\)/)
assert.match(viewer, /tl\.dataset\.pdfPath = path/)
console.log('inline PDF source: frozen citation, remote path, original document, and async isolated jumps ok')
