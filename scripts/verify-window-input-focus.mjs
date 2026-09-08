import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let recovery, focusListener, menuClick
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'recoverWindowInput') recovery = node
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'win.on' &&
      node.arguments[0]?.text === 'focus') focusListener = node.arguments[1]
  if (ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'label' &&
    property.initializer.text === '입력 다시 활성화')) {
    menuClick = node.properties.find((property) =>
      ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'click')?.initializer
  }
  ts.forEachChild(node, visit)
}
visit(parsed)
function evaluate(node, context) {
  assert.ok(node, 'locate the recovery helper, focus listener and recovery menu in the actual source')
  const code = ts.transpileModule(`(${node.getText(parsed)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return vm.runInNewContext(code, context)
}

// ponytail: Electron objects are mocked; this checks recovery wiring, not the native lock's cause.
function makeWindow(id, { destroyed = false, enabled = true, contentsDestroyed = false, devTools = false, focused = false } = {}) {
  const calls = []
  const unexpected = () => assert.fail('input recovery must not reload or close the window')
  return {
    id, calls,
    isDestroyed: () => destroyed,
    isEnabled: () => enabled,
    blur: () => calls.push('blur'),
    focus: () => calls.push('focus'),
    close: unexpected, destroy: unexpected, reload: unexpected,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      isDevToolsFocused: () => devTools,
      isFocused: () => focused,
      focus: () => calls.push('webContents.focus'),
      reload: unexpected, forcefullyCrashRenderer: unexpected
    }
  }
}
const recoverWindowInput = evaluate(recovery, {})
const mainWindow = makeWindow(1)
const secondaryWindow = makeWindow(2)
const recovered = ['blur', 'focus', 'webContents.focus']
recoverWindowInput(secondaryWindow)
assert.deepEqual(secondaryWindow.calls, recovered, 'recovery restores the window before the web contents')
assert.deepEqual(mainWindow.calls, [], 'recovering another window leaves the main window untouched')
recoverWindowInput(null)
for (const state of [{ destroyed: true }, { enabled: false }, { contentsDestroyed: true }]) {
  const win = makeWindow(3, state)
  recoverWindowInput(win)
  assert.deepEqual(win.calls, [], `unsafe recovery is ignored: ${JSON.stringify(state)}`)
}

for (const state of [{}, { contentsDestroyed: true }, { devTools: true }, { enabled: false }, { focused: true }]) {
  const win = makeWindow(4, state)
  evaluate(focusListener, {
    win,
    stopWindowAttention: (target) => {
      assert.equal(target, win)
      target.calls.push('stopWindowAttention')
    }
  })()
  assert.deepEqual(win.calls,
    state.contentsDestroyed || state.devTools || state.enabled === false || state.focused
      ? ['stopWindowAttention'] : ['stopWindowAttention', 'webContents.focus'],
    'window activation restores input only for live contents outside developer tools')
}

let focusedWindow = mainWindow
const lookups = []
const click = evaluate(menuClick, {
  recoverWindowInput, mainWindow,
  BrowserWindow: {
    fromId: (id) => { lookups.push(id); return id === secondaryWindow.id ? secondaryWindow : null },
    getFocusedWindow: () => { lookups.push('focused'); return focusedWindow }
  }
})
secondaryWindow.calls.length = 0
click({}, { id: secondaryWindow.id })
assert.deepEqual(lookups, [secondaryWindow.id], 'the clicked window is resolved by its own id')
assert.deepEqual(secondaryWindow.calls, recovered, 'the clicked window receives recovery')
assert.deepEqual(mainWindow.calls, [], 'the menu must not redirect recovery to the main window')
lookups.length = 0
click({}, { id: 999 })
assert.deepEqual(lookups, [999], 'a vanished clicked window must not redirect to another window')
assert.deepEqual(mainWindow.calls, [])
click({}, undefined)
assert.deepEqual(mainWindow.calls, recovered, 'without a clicked window, recover the focused window')
assert.equal(lookups.at(-1), 'focused')
focusedWindow = null
click({}, undefined)
assert.deepEqual(mainWindow.calls, recovered, 'without a focused window, do nothing')
console.log('window input recovery preserves window ownership, native modal guards and developer-tool focus')
