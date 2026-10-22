import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['isBrowserTabPayload', 'payloadSide', 'withPayloadSide'])
const channels = new Set(['window:new', 'tabs:beginDrag', 'tabs:dropOnTabBar', 'tabs:endDrag'])
const snippets = parsed.statements.filter(node => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(parsed)))
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
  const call = node.expression
  return call.expression.getText(parsed) === 'ipcMain.handle' && ts.isStringLiteral(call.arguments[0]) && channels.has(call.arguments[0].text)
}).map(node => node.getText(parsed)).join('\n')
assert.equal(snippets.match(/ipcMain.handle\(/g)?.length, channels.size)
const callbacks = new Map(), messages = [], transfers = [], created = []
const window = id => ({ id, webContents: { id: id + 10, send: (channel, payload) => messages.push({ id, channel, payload }) }, isDestroyed: () => false, focus() {} })
const a = window(1), b = window(2)
let dropTargets = new Map()
runInNewContext(ts.transpileModule(`let pendingTabDrag = null; const pendingReceive = new Map();\n${snippets}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  ipcMain: { handle: (name, callback) => callbacks.set(name, callback) },
  BrowserWindow: { fromWebContents: sender => sender === a.webContents ? a : b, getAllWindows: () => [a, b] },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  tabDropTarget: async win => dropTargets.get(win.id),
  recordTabTransfer: (payload, target) => transfers.push({ payload, target }),
  createWindow: (...args) => { created.push(args); return window(3) }
})
const payload = { kind: 'doc', side: 'left', tab: { id: 'browser-agent', kind: 'browser', browserAgentId: 'agent', title: '브라우저', side: 'left' } }
const begin = () => callbacks.get('tabs:beginDrag')({ sender: a.webContents }, payload)
begin()
let result = callbacks.get('tabs:dropOnTabBar')({ sender: a.webContents }, { side: 'right' })
assert.equal(result.action, 'moved')
assert.equal(result.removeSource, false)
assert.equal(messages.at(-1).payload.tab.side, 'right')
assert.equal((await callbacks.get('tabs:endDrag')()).removeSource, false)
assert.equal(transfers.length, 0)
begin()
result = callbacks.get('tabs:dropOnTabBar')({ sender: b.webContents }, { side: 'right' })
assert.equal(result.action, 'none', 'browser access must not transfer to a window without its agent')
dropTargets = new Map([[2, { side: 'right' }]])
assert.equal((await callbacks.get('tabs:endDrag')()).action, 'none')
begin(); dropTargets.clear()
assert.equal((await callbacks.get('tabs:endDrag')()).action, 'none', 'dropping outside must keep browser in its owning window')
assert.equal(created.length, 0)
callbacks.get('window:new')({}, { tabs: [payload] })
assert.equal(created.length, 0)
begin(); dropTargets = new Map([[1, { side: 'right' }]])
assert.equal((await callbacks.get('tabs:endDrag')()).action, 'moved')
assert.equal(messages.at(-1).payload.tab.side, 'right')

const app = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const payloadFn = appAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(appAst) === 'docTabDragPayload'))
const module = { exports: {} }
runInNewContext(ts.transpileModule(`export ${payloadFn.getText(appAst)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports, docSide: tab => tab.side ?? 'left', RESTORABLE_DOC_KINDS: new Set(['pdf']), normalizeDocKind: kind => kind })
const browserPayload = module.exports.docTabDragPayload({ id: 'browser-agent', title: '브라우저', kind: 'browser', browserAgentId: 'agent', side: 'right' })
assert.equal(browserPayload.tab.path, undefined, 'browser tabs must not masquerade as filesystem paths')
assert.equal(browserPayload.tab.browserAgentId, 'agent')
assert.equal(browserPayload.side, 'right')
console.log('browser workspace tabs: same-window drag, pathless payload, and cross-window/tear-out ownership boundaries passed')
