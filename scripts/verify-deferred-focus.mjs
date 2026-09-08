import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import vm from 'node:vm'
import ts from 'typescript'

async function loadInitializer(file, marker) {
  const source = await readFile(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let initializer
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect' &&
        node.arguments[0]?.getText(parsed).includes(marker)) {
      initializer = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(initializer, `find the actual asynchronous initializer in ${file}`)
  return ts.transpileModule(`(${initializer.getText(parsed)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}
const terminalEffect = await loadInitializer('terminal/Terminal.tsx', 'Promise.all([window.lt.settings.get()')
const markdownEffect = await loadInitializer('editor/MarkdownEditor.tsx', 'Promise.all([init, window.lt.settings.get()')

const noop = () => {}
const disposable = () => ({ dispose: noop })

// ponytail: DOM/editor libraries are mocked; use Electron for native focus or persistent input locks.
async function check({ name, moveDuring, hidden = false, canceled = false }) {
  let releaseSettings, releaseFonts
  const settings = new Promise((resolve) => { releaseSettings = resolve })
  const fonts = new Promise((resolve) => { releaseFonts = resolve })
  const initial = { id: 'new-terminal-tab' }
  const search = { id: 'case-party-search' }
  const textarea = { id: 'right-terminal-textarea' }
  const document = { activeElement: initial, fonts: { load: () => fonts } }
  const visibleRef = { current: true }
  const termRef = { current: null }
  let focusCalls = 0
  class XTerm {
    modes = { bracketedPasteMode: false }
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() { focusCalls++; document.activeElement = textarea }
    onWriteParsed = disposable
    attachCustomKeyEventHandler() {}
    onData = disposable
    onBell = disposable
    onSelectionChange = disposable
    onScroll = disposable
    dispose() {}
  }
  const context = {
    Promise, setTimeout, clearTimeout, document, XTerm,
    FitAddon: class { fit() {} },
    WebglAddon: class { onContextLoss() {} },
    CanvasAddon: class {},
    ResizeObserver: class { observe() {} disconnect() {} },
    DEFAULT_FONT: 'monospace',
    hostRef: { current: { addEventListener: noop, removeEventListener: noop } },
    termRef, fitRef: { current: null }, visible: true, visibleRef,
    id: 'right-terminal', cwd: '/tmp', ssh: undefined,
    autoAgent: undefined, autoClaude: false, resumeSessionId: undefined,
    installWindowsImeCorrection: () => ({ setClaudeWorking: noop, dispose: noop }),
    onBracketedPasteModeChangeRef: { current: undefined }, setSelectionAction: noop,
    window: { lt: {
      settings: { get: () => settings },
      app: { info: () => Promise.resolve({ platform: 'darwin' }) },
      pty: { onData: () => noop, onExit: () => noop, create: noop, resize: noop, detach: noop }
    } }
  }
  const cleanup = vm.runInNewContext(terminalEffect, context)()
  try {
    if (moveDuring === 'settings') document.activeElement = search
    releaseSettings({ termFontSize: 13 })
    await nextTurn()
    if (moveDuring === 'fonts') document.activeElement = search
    if (hidden) visibleRef.current = false
    if (canceled) cleanup()
    releaseFonts([])
    await nextTurn()
    const shouldFocus = !moveDuring && !hidden && !canceled
    assert.equal(document.activeElement, shouldFocus ? textarea : moveDuring ? search : initial, name)
    assert.equal(focusCalls, shouldFocus ? 1 : 0, name)
    assert.equal(termRef.current !== null, !canceled, name)
  } finally {
    cleanup()
  }
}

async function checkMarkdown({ name, moveDuring, canceledDuring, newDocument = false }, effect = markdownEffect) {
  let releaseFile, releaseDraft
  const file = new Promise((resolve) => { releaseFile = resolve })
  const draft = new Promise((resolve) => { releaseDraft = resolve })
  const initial = { id: 'new-document-tab' }
  const search = { id: 'case-party-search' }
  const editor = { id: 'right-markdown-editor' }
  const document = { activeElement: initial }
  const viewRef = { current: null }
  const errors = []
  let focusCalls = 0
  class EditorView {
    static lineWrapping = []
    static domEventHandlers = noop
    static updateListener = { of: noop }
    focus() { focusCalls++; document.activeElement = editor }
    destroy() {}
  }
  const context = {
    Promise, clearTimeout, document, EditorView, viewRef,
    hostRef: { current: {} }, pathRef: { current: newDocument ? null : '/tmp/example.md' },
    savedContentRef: { current: '' }, remoteSigRef: { current: null },
    initialScrollRef: { current: null }, saveTimer: { current: null },
    localDirtyRef: { current: false }, remoteAppliedTimer: { current: null },
    previewComp: { current: { of: noop } }, preview: false, plainText: false,
    EditorState: { create: (state) => state }, keymap: { of: noop },
    history: noop, drawSelection: noop, dropCursor: noop, makeTheme: noop,
    markdown: noop, syntaxHighlighting: noop, GFM: {}, defaultHighlightStyle: {},
    defaultKeymap: [], historyKeymap: [], indentWithTab: {}, findHighlightField: {},
    DEFAULT_MD_FONT: 'monospace', fileSignatureOf: (value) => value,
    draftIdentity: () => ({}), applyRevealRequest: noop, reportScrollPosition: noop,
    setDirtyState: noop, setDraftSaved: noop, setHasDraftHistory: noop, setSavedState: noop,
    setErr: (error) => { if (error) errors.push(error) },
    window: { lt: {
      settings: { get: () => Promise.resolve({}) },
      fs: { readText: () => file, loadDocumentDraft: () => draft }
    } }
  }
  const cleanup = vm.runInNewContext(effect, context)()
  try {
    if (moveDuring === 'file') document.activeElement = search
    if (canceledDuring === 'file') cleanup()
    releaseFile({ text: '# Example', size: 9, mtimeMs: 1 })
    await nextTurn()
    if (moveDuring === 'draft') document.activeElement = search
    if (canceledDuring === 'draft') cleanup()
    releaseDraft({ ok: true, draft: null })
    await nextTurn()
    assert.deepEqual(errors, [], name)
    const shouldFocus = !moveDuring && !canceledDuring
    assert.equal(document.activeElement, shouldFocus ? editor : moveDuring ? search : initial, name)
    assert.equal(focusCalls, shouldFocus ? 1 : 0, name)
    assert.equal(viewRef.current !== null, !canceledDuring, name)
  } finally {
    cleanup()
  }
}

await check({ name: 'new terminal still receives automatic focus when the user has not moved focus' })
await check({ name: 'party search retains focus while terminal settings load', moveDuring: 'settings' })
await check({ name: 'party search retains focus while terminal fonts load', moveDuring: 'fonts' })
await check({ name: 'a terminal hidden during initialization never receives focus', hidden: true })
await check({ name: 'an unmounted terminal does not initialize or receive focus', canceled: true })
await checkMarkdown({ name: 'new document receives focus when the user has not moved focus', newDocument: true })
await checkMarkdown({ name: 'party search retains focus while a document file loads', moveDuring: 'file' })
await checkMarkdown({ name: 'party search retains focus while a document draft loads', moveDuring: 'draft' })
await checkMarkdown({ name: 'a document unmounted while its file loads never initializes', canceledDuring: 'file' })
await checkMarkdown({ name: 'a document unmounted while its draft loads never initializes', canceledDuring: 'draft' })

const unguardedMarkdownEffect = markdownEffect.replace(/if \(document\.activeElement === initialFocus\)\s*/, '')
assert.notEqual(unguardedMarkdownEffect, markdownEffect, 'locate the Markdown automatic focus guard')
await assert.rejects(
  checkMarkdown({ name: 'unguarded Markdown focus steals party search', moveDuring: 'draft' }, unguardedMarkdownEffect),
  { code: 'ERR_ASSERTION', message: /unguarded Markdown focus steals party search/ }
)
console.log('terminal/document initialization preserves input focus and cancels on unmount; old Markdown focus fails')
