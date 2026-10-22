import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const windows = new Map(), views = [], handlers = new Map(), cache = new Map()
const sharedSession = { setPermissionRequestHandler(callback) { this.request = callback }, setPermissionCheckHandler(callback) { this.check = callback } }
const rendererUrl = process.env.ELECTRON_RENDERER_URL
delete process.env.ELECTRON_RENDERER_URL
let nextId = 0
class Contents extends EventEmitter {
  constructor() { super(); this.id = ++nextId; this.mainFrame = {}; this.session = sharedSession; this.loads = []; this.url = ''; this.destroyed = false }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
  setWindowOpenHandler(handler) { this.popup = handler }
  loadURL(url) {
    this.url = url
    return new Promise((resolve, reject) => this.loads.push({ url, resolve, reject }))
  }
  close(options) { this.closeOptions = options; this.destroyed = true; this.emit('destroyed') }
}
class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.id = ++nextId; this.options = options; this.webContents = new Contents(); this.destroyed = false
    this.contentView = { children: [], addChildView(view) { this.children.push(view) }, removeChildView(view) { this.children = this.children.filter(child => child !== view) } }
    windows.set(this.webContents, this)
  }
  static fromWebContents(contents) { return windows.get(contents) }
  getContentSize() { return [1000, 700] }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.webContents.close(); this.emit('closed') }
}
class View {
  constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this) }
  setVisible(value) { this.visible = value }
  setBounds(value) { this.bounds = value }
}
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = name => name === 'electron' ? { BrowserWindow: Window, WebContentsView: View }
    : name.startsWith('.') ? load(join(dirname(file), `${name}.ts`)) : require(name)
  new Function('require', 'module', 'exports', '__dirname', code)(localRequire, module, module.exports, dirname(file))
  return module.exports
}
const backend = load(join(root, 'src/main/claudeRemoteControl.ts'))
const { normalizeClaudeRemoteControlUrl: normalize } = load(join(root, 'src/shared/claudeRemoteControl.ts'))
backend.registerClaudeRemoteControlIpc({ handle: (channel, callback) => handlers.set(channel, callback) })
const appUrl = pathToFileURL(join(root, 'src/renderer/index.html')).href
const owner = new Window(), other = new Window()
owner.webContents.url = `${appUrl}#case-a`; other.webContents.url = appUrl
const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
const invoke = (window, action, ...args) => Promise.resolve().then(() => handlers.get(`claudeRemoteControl:${action}`)(eventFor(window), ...args))
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const url = 'https://claude.ai/code/session_example'
const start = async (window, id = 'remote-2', target = url) => {
  const result = invoke(window, 'open', { id, url: target }); await tick()
  return { result, view: window.contentView.children.at(-1) }
}
const open = async (window, id, target) => { const { result, view } = await start(window, id, target); view.webContents.loads.at(-1).resolve(); await result; return view }
try {
  assert.equal(normalize(' https://claude.ai/code '), 'https://claude.ai/code')
  assert.equal(normalize(url), url)
  assert.equal(normalize('https://CLAUDE.ai:443/code/?session=abc#continue'), 'https://claude.ai/code/?session=abc#continue')
  for (const invalid of [null, {}, '', 'https://claude.ai/chat', 'https://claude.ai/code-spoof', 'http://claude.ai/code', 'https://claude.ai.evil.test/code',
    'https://claude.ai@evil.test/code', 'https://person:secret@claude.ai/code', 'https://claude.ai:444/code', 'https://claude.ai./code',
    'https://claude.ai/code/../chat', 'javascript:alert(1)', 'file:///code', `https://claude.ai/code/${'x'.repeat(4096)}`]) assert.throws(() => normalize(invalid), /공식 리모트/)
  for (const id of [null, '', '../bad', 'x'.repeat(201)]) await assert.rejects(invoke(owner, 'open', { id, url }), /연결 정보/)
  await assert.rejects(Promise.resolve().then(() => handlers.get('claudeRemoteControl:open')({ ...eventFor(owner), senderFrame: {} }, { id: 'bad', url })), /앱 화면/)
  owner.webContents.url = 'https://claude.ai/code'
  await assert.rejects(invoke(owner, 'open', { id: 'bad', url }), /앱 화면/)
  owner.webContents.url = `${appUrl}#case-a`
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  owner.webContents.url = 'http://localhost:5173/spoof'
  await assert.rejects(invoke(owner, 'open', { id: 'bad', url }), /앱 화면/)
  owner.webContents.url = 'http://localhost:5173/#case-a'
  const dev = await open(owner, 'dev')
  await invoke(owner, 'close', 'dev'); assert.equal(dev.webContents.isDestroyed(), true)
  delete process.env.ELECTRON_RENDERER_URL
  owner.webContents.url = `${appUrl}#case-a`
  const first = await open(owner)
  assert.equal(first.visible, false, 'views stay hidden until the owner sends bounds')
  assert.deepEqual(first.options.webPreferences, { partition: 'persist:lt-claude-remote-control', sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false })
  assert.equal(first.options.webPreferences.preload, undefined)
  await invoke(owner, 'open', { id: 'remote-2', url })
  assert.equal(first.webContents.loads.length, 1, 'same URL must preserve the active official session')
  await invoke(owner, 'bounds', 'remote-2', { x: -10, y: 650, width: 1100, height: 200 })
  assert.deepEqual(first.bounds, { x: 0, y: 650, width: 1000, height: 50 })
  assert.equal(first.visible, true)
  await assert.rejects(invoke(owner, 'bounds', 'remote-2', { x: 0, y: 0, width: Infinity, height: 20 }), /화면 크기/)
  await assert.rejects(invoke(owner, 'bounds', 'remote-2', { x: 0, y: 0, width: -5, height: 20 }), /화면 크기/)
  await invoke(other, 'bounds', 'remote-2', null)
  await invoke(other, 'close', 'remote-2')
  assert.equal(first.visible, true); assert.equal(first.webContents.isDestroyed(), false)
  const second = await open(other)
  assert.notEqual(second, first, 'saved IDs are isolated by owning window')
  await invoke(owner, 'bounds', 'remote-2', null)
  assert.equal(first.visible, false); assert.equal(first.webContents.isDestroyed(), false)
  for (const event of ['will-navigate', 'will-redirect']) {
    for (const target of ['javascript:alert(1)', 'file:///tmp/secret', 'http://claude.ai/code', 'data:text/html,unsafe', 'https://user:secret@example.com/']) {
      let blocked = false; first.webContents.emit(event, { preventDefault() { blocked = true } }, target); assert.equal(blocked, true, target)
    }
    let blocked = false; first.webContents.emit(event, { preventDefault() { blocked = true } }, 'https://accounts.google.com/auth'); assert.equal(blocked, false)
  }
  let attached = true; first.webContents.emit('will-attach-webview', { preventDefault() { attached = false } }); assert.equal(attached, false)
  assert.equal(first.webContents.popup({ url: 'file:///tmp/secret' }).action, 'deny')
  const popupRequest = first.webContents.popup({ url: 'https://accounts.google.com/auth' })
  assert.equal(popupRequest.action, 'allow')
  const popupContents = popupRequest.createWindow({ webPreferences: { preload: '/bad', nodeIntegration: true } })
  const popupWindow = Window.fromWebContents(popupContents)
  assert.equal(popupWindow.options.webPreferences.preload, undefined)
  assert.equal(popupWindow.options.webPreferences.nodeIntegration, false)
  assert.equal(popupWindow.options.webPreferences.partition, first.options.webPreferences.partition)
  await assert.rejects(invoke(popupWindow, 'close', 'remote-2'))
  assert.equal(popupContents.popup({ url: 'javascript:alert(1)' }).action, 'deny')
  let allowed = true; sharedSession.request(null, 'media', value => { allowed = value }); assert.equal(allowed, false); assert.equal(sharedSession.check(), false)
  const changed = invoke(owner, 'open', { id: 'remote-2', url: 'https://claude.ai/code/session_next' }); await tick()
  first.webContents.loads.at(-1).resolve(); await changed
  assert.equal(first.webContents.loads.length, 2)
  await invoke(owner, 'close', 'remote-2')
  assert.equal(first.webContents.isDestroyed(), true); assert.equal(popupWindow.isDestroyed(), true)
  assert.deepEqual(first.webContents.closeOptions, { waitForBeforeUnload: false })
  assert.equal(owner.contentView.children.length, 0); assert.equal(second.webContents.isDestroyed(), false)
  assert.throws(() => popupRequest.createWindow({}), /닫혔습니다/, 'a delayed popup cannot survive a closed tab')
  const raced = await open(owner, 'close-race')
  raced.webContents.close = function () { this.destroyed = true; throw new Error('Object has been destroyed') }
  await invoke(owner, 'close', 'close-race')
  const loading = await start(owner, 'pending')
  const closedResult = assert.rejects(loading.result, /닫혔습니다/)
  await invoke(owner, 'close', 'pending'); loading.view.webContents.loads[0].resolve(); await closedResult
  assert.equal(loading.view.webContents.isDestroyed(), true); assert.equal(owner.contentView.children.length, 0)
  const failing = await start(owner, 'failure')
  const failureResult = assert.rejects(failing.result, /network unavailable/)
  failing.view.webContents.loads[0].reject(new Error('network unavailable')); await failureResult
  assert.equal(failing.view.webContents.isDestroyed(), true)
  const queued = await start(owner, 'queued')
  const nextLoad = invoke(owner, 'open', { id: 'queued', url: 'https://claude.ai/code/session_later' }); await tick()
  assert.equal(queued.view.webContents.loads.length, 1, 'changed URLs wait for existing navigation')
  queued.view.webContents.loads[0].resolve(); await queued.result; await tick()
  assert.equal(queued.view.webContents.loads.length, 2)
  queued.view.webContents.loads[1].resolve(); await nextLoad
  const ownerClosing = await start(owner, 'owner-closing')
  const ownerClosedResult = assert.rejects(ownerClosing.result, /닫혔습니다/)
  owner.destroy(); ownerClosing.view.webContents.loads[0].resolve(); await ownerClosedResult
  assert.equal(queued.view.webContents.isDestroyed(), true)
  assert.equal(ownerClosing.view.webContents.isDestroyed(), true)
  backend.disposeClaudeRemoteControls()
  assert.equal(second.webContents.isDestroyed(), true)
  assert.equal(views.every(view => view.webContents.isDestroyed()), true)
  console.log('Claude Remote Control: official URL validation, IPC ownership, isolated login popups, bounds, load/close races and cleanup passed')
} finally {
  backend.disposeClaudeRemoteControls()
  if (rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = rendererUrl
}
