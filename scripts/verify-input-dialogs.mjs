import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let handler
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'ipcMain.handle' &&
      node.arguments[0]?.text === 'dialog:message') handler = node.arguments[1]
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.ok(handler, 'renderer messages use the shared asynchronous native dialog handler')
const code = ts.transpileModule(`(${handler.getText(parsed)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

let destroyed = false
const win = { isDestroyed: () => destroyed }
const frame = {}
const sender = { mainFrame: frame }
const event = { sender, senderFrame: frame }
let resolveDialog, rejectDialog, shown = [], restored = []
const show = vm.runInNewContext(code, {
  BrowserWindow: { fromWebContents: (contents) => contents === sender ? win : null },
  dialog: { showMessageBox: (parent, options) => {
    shown.push({ parent, options })
    return new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject })
  } },
  focusWindowInput: (parent) => restored.push(parent)
})

for (const [kind, response, expected] of [['confirm', 0, false], ['confirm', 1, true], ['alert', 0, true]]) {
  const pending = show(event, kind, '작업환경 저장 완료\n문서 1개')
  let settled = false
  pending.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'confirmation cannot proceed before the user answers')
  const { parent, options } = shown.at(-1)
  assert.equal(parent, win, 'the originating window owns the dialog')
  assert.equal(options.message, '작업환경 저장 완료\n문서 1개')
  assert.equal(options.cancelId, 0, 'Escape and dismissal cancel confirmation')
  assert.equal(options.buttons.length, kind === 'confirm' ? 2 : 1)
  resolveDialog({ response })
  assert.equal(await pending, expected)
  assert.equal(restored.at(-1), win, 'restore input only after the dialog closes')
}

const closing = show(event, 'confirm', '닫을까요?')
destroyed = true
resolveDialog({ response: 1 })
assert.equal(await closing, false, 'a destroyed owner cannot authorize an action')
destroyed = false
const failed = show(event, 'confirm', '실패 경로')
rejectDialog(new Error('native dialog failed'))
await assert.rejects(failed, /native dialog failed/)
assert.equal(restored.at(-1), win, 'native dialog errors also run focus cleanup')

const count = shown.length
for (const args of [
  [{ sender: {}, senderFrame: frame }, 'confirm', 'x'],
  [{ sender, senderFrame: {} }, 'confirm', 'x'],
  [event, 'unknown', 'x'],
  [event, 'confirm', {}]
]) assert.equal(await show(...args), false)
destroyed = true
assert.equal(await show(event, 'confirm', 'x'), false)
assert.equal(shown.length, count, 'invalid requests never show a dialog or target another window')

async function checkRenderer(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) await checkRenderer(url)
    else if (/\.tsx?$/.test(entry.name)) {
      assert.doesNotMatch(await readFile(url, 'utf8'), /window\.(alert|confirm)\s*\(/,
        `${url.pathname} must not reintroduce blocking Chromium dialogs`)
    }
  }
}
await checkRenderer(new URL('../src/renderer/src/', import.meta.url))
console.log('input dialogs await decisions, preserve cancellation and window ownership, and avoid blocking renderer dialogs')
