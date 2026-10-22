// Built renderer/preload and a native view fixture; no Claude account, SSH host, or external website is contacted.
// Run after npm run build. Screenshots are retained for visual review.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-claude-remote-ui-'))
const screenshotDir = path.join(root, 'output/playwright/claude-remote-control')
await fs.mkdir(screenshotDir, { recursive: true })

function runApp({ root, temp, screenshotDir }) {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = [], unexpected = [], agents = new Map(), views = new Map()
  const profile = { id: 'remote-one', label: '원격1 · Mac', host: 'example.invalid', user: 'lawyer' }
  const settings = { sshProfiles: [profile], caseOpenTarget: 'remote:remote-one', notifyDone: false, agentDefaultProvider: 'claude', claudeRemoteConnections: [] }
  const originalSsh = JSON.stringify(settings.sshProfiles)
  const remoteCwd = '/Users/lawyer/legal-terminal-general'
  let failOpen = false, failSave = false, win, stage = 'load renderer'
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.setPath('userData', path.join(temp, 'profile'))
  fs.mkdirSync(path.join(temp, 'home'), { recursive: true })
  app.setPath('home', path.join(temp, 'home'))
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
  BrowserWindow.prototype.focus = function () {}
  app.focus = function () {}
  global.fetch = async () => { throw Error('External network blocked by Remote Control UI test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (['app:info', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'].includes(channel)) return handler(event, ...args)
    if (channel === 'app:generalChatDirectory') { assert.equal(args[0], profile.id); return remoteCwd }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return settings
    if (channel === 'settings:set') {
      if (failSave) throw Error('테스트 저장 실패')
      Object.assign(settings, args[0])
      return settings
    }
    if (['case:history', 'case:addHistory', 'fs:list', 'fs:listPdfs', 'sessions:list', 'projects:list'].includes(channel)) return []
    if (channel === 'js:tokenStatus') return 'missing'
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (channel === 'fs:loadDocumentDraft') return { ok: true, draft: null }
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'fs:stat') return { ok: true, isDir: true, size: 0 }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return { ok: true }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoLoad') return { ok: true, remote: { ok: true, snapshot: null } }
    if (channel === 'workspace:autoSave') return { ok: true }
    if (channel === 'workspace:autoObserve') return
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:create') {
      const options = args[0]
      agents.set(options.id, options)
      setTimeout(() => {
        if (event.sender.isDestroyed()) return
        event.sender.send('agent:event', { type: 'auth:status', sessionId: options.id, state: 'authenticated' })
        event.sender.send('agent:event', { type: 'status', sessionId: options.id, status: 'idle' })
      }, 30)
      return { ok: true, sessionId: options.id }
    }
    if (channel === 'agent:snapshot') return { ok: true, session: agents.get(args[0]) }
    if (['agent:close', 'agent:setModel', 'agent:slashCommand'].includes(channel)) return { ok: true }
    if (channel === 'claudeRemoteControl:open') {
      if (failOpen) throw Error('테스트 연결 실패')
      const { id } = args[0]
      if (views.has(id)) return
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      views.set(id, view)
      view.setVisible(false)
      win.contentView.addChildView(view)
      await view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="ko"><meta charset="utf-8"><style>body{margin:0;padding:32px;background:#f5f3ed;color:#292722;font:16px system-ui}h1{font-size:25px}article{max-width:600px;margin:35px auto;padding:24px;border:1px solid #d3d0c7;border-radius:12px;background:white}small{color:#716c62}textarea{box-sizing:border-box;width:100%;height:90px;border:1px solid #bbb6aa;border-radius:8px;padding:12px;font:inherit}</style><small>연결 화면 검증용 예시 · 외부 연결 없음</small><h1>원격2 · Windows 작업</h1><article><p>이 화면은 별도 컴퓨터의 Claude 세션을 표시하는 영역입니다.</p><p>원격1 대화와 나란히 작업할 수 있습니다.</p><textarea aria-label="예시 메시지" placeholder="원격2에 요청할 작업"></textarea></article></html>'))
      return
    }
    if (channel === 'claudeRemoteControl:bounds') {
      const view = views.get(args[0]), bounds = args[1]
      if (!view) return
      if (bounds) view.setBounds(bounds)
      view.setVisible(Boolean(bounds))
      return
    }
    if (channel === 'claudeRemoteControl:close') {
      const view = views.get(args[0])
      if (view) { win.contentView.removeChildView(view); view.webContents.close(); views.delete(args[0]) }
      return
    }
    unexpected.push(channel)
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })))
  const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => {
    win = window
    win.setContentSize(1440, 940)
    win.webContents.setZoomFactor(1)
    win.webContents.setBackgroundThrottling(false)
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
    win.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await pause(40) }
    throw Error(`Timed out: ${label}`)
  }
  const capture = async (name, contents = win.webContents) => {
    stage = `capture ${name}: wait for paint`
    await contents.executeJavaScript('window.__fixturePaintReady = false; requestAnimationFrame(() => requestAnimationFrame(() => { window.__fixturePaintReady = true })); true')
    await wait(() => contents.executeJavaScript('window.__fixturePaintReady'), stage)
    stage = `capture ${name}: read compositor surface`
    const image = await contents.capturePage()
    assert.equal(image.isEmpty(), false, `${name} screenshot must contain pixels`)
    const { width, height } = image.getSize()
    assert.ok(width > 100 && height > 100, `${name} screenshot must have usable dimensions: ${width}x${height}`)
    const bitmap = image.toBitmap()
    assert.ok(bitmap.some((value, index) => value !== bitmap[index % 4]), `${name} screenshot must not be a blank surface`)
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), image.toPNG())
    stage = `after capture ${name}`
  }
  const showManager = async () => {
    await evaluate("[...document.querySelectorAll('.general-chat-button')].find(el => el.textContent.trim() === '원격 제어').click()")
    await wait(() => evaluate("!!window.manager() && !manager().querySelector('button[type=submit]').disabled"), 'manager loaded')
  }
  const fill = async (label, url) => evaluate(`window.fill(${JSON.stringify(label)}, ${JSON.stringify(url)})`)
  const submit = async () => evaluate("manager().querySelector('form').requestSubmit()")
  const activePanel = async () => wait(() => evaluate("!!window.panel() && !panel().querySelector('[role=status]')"), 'connection ready')
  const unchangedRemoteOne = () => {
    assert.equal(JSON.stringify(settings.sshProfiles), originalSsh)
    assert.equal(settings.caseOpenTarget, 'remote:remote-one')
    assert.equal(calls.some(call => ['agent:close', 'agent:interrupt', 'pty:kill'].includes(call.channel)), false, 'Remote1 must not stop')
  }
  ;(async () => {
    try {
      await ready
      // A visible host lets Windows create the child WebContentsView's compositor surface.
      win.showInactive()
      assert.equal(win.isVisible(), true, 'native-view screenshots require a visible host window')
      await evaluate(`window.manager = () => [...document.querySelectorAll('.claude-remote-manager')].find(el => el.offsetParent !== null); window.panel = () => [...document.querySelectorAll('.claude-remote-panel')].find(el => el.offsetParent !== null); window.fill = (label, url) => { const inputs = manager().querySelectorAll('input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; [label, url].forEach((value, index) => { setter.call(inputs[index], value); inputs[index].dispatchEvent(new Event('input', { bubbles: true })); }); }; true;`)
      await wait(() => agents.size > 0, 'existing Remote1 agent')
      assert.equal([...agents.values()][0].ssh.host, profile.host)
      const initialAgents = agents.size
      await showManager()
      await capture('manager')
      for (const url of ['https://claude.ai.evil.example/code/session_test', 'http://claude.ai/code/session_test', 'https://example.com/code/session_test']) {
        await fill('원격2', url)
        await submit()
        await wait(() => evaluate("!!manager().querySelector('[role=alert]')"), 'invalid URL rejected')
        assert.equal(settings.claudeRemoteConnections.length, 0)
        assert.equal(calls.some(call => call.channel === 'claudeRemoteControl:open'), false)
      }
      await fill('원격2', 'https://claude.ai/code/session_test')
      failSave = true
      await submit()
      await wait(() => evaluate("manager().textContent.includes('테스트 저장 실패')"), 'save error displayed')
      assert.equal(settings.claudeRemoteConnections.length, 0)
      failSave = false
      await submit()
      await activePanel()
      assert.equal(settings.claudeRemoteConnections.length, 1)
      const id = settings.claudeRemoteConnections[0].id
      assert.deepEqual(calls.find(call => call.channel === 'claudeRemoteControl:open').args[0], { id, url: 'https://claude.ai/code/session_test' })
      await wait(() => calls.some(call => call.channel === 'claudeRemoteControl:bounds' && call.args[0] === id && call.args[1]?.height > 100), 'native view bounds')
      assert.equal(await evaluate("[...document.querySelectorAll('.tab-title')].filter(el => el.textContent === '원격2').length"), 1)
      assert.equal(await evaluate("!![...document.querySelectorAll('.agent-composer textarea')].find(el => el.offsetParent !== null)"), true)
      const nativeView = views.get(id)
      assert.equal(nativeView.getVisible(), true)
      const bounds = nativeView.getBounds()
      const viewport = await evaluate("(() => { const r = panel().querySelector('.claude-remote-viewport').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()")
      assert.deepEqual(bounds, viewport, 'native view fills only its designated viewport')
      assert.equal(await nativeView.webContents.executeJavaScript("document.querySelector('h1').textContent"), '원격2 · Windows 작업')
      await nativeView.webContents.executeJavaScript("document.querySelector('textarea').focus(); true")
      await nativeView.webContents.insertText('윈도우 작업을 확인해 주세요.')
      assert.equal(await nativeView.webContents.executeJavaScript("document.querySelector('textarea').value"), '윈도우 작업을 확인해 주세요.')
      await capture('remote-view-fixture', nativeView.webContents)
      await capture('active-session')
      unchangedRemoteOne()
      const beforeHide = calls.length
      await showManager()
      await wait(() => calls.slice(beforeHide).some(call => call.channel === 'claudeRemoteControl:bounds' && call.args[1] === null), 'hidden native view')
      assert.equal(await evaluate("!!manager().querySelector('[aria-label=\"원격2 열기\"]')"), true, 'saved connection reloads')
      await evaluate("manager().querySelector('[aria-label=\"원격2 열기\"]').click()")
      await activePanel()
      assert.equal(await evaluate("[...document.querySelectorAll('.tab-title')].filter(el => el.textContent === '원격2').length"), 1, 'reopening uses the same tab')
      failOpen = true
      await evaluate("[...panel().querySelectorAll('button')].find(el => el.textContent === '다시 연결').click()")
      await wait(() => evaluate("panel().textContent.includes('테스트 연결 실패')"), 'connection error displayed')
      failOpen = false
      await evaluate("[...panel().querySelectorAll('button')].find(el => el.textContent === '다시 연결').click()")
      await activePanel()
      assert.equal(await evaluate("!!panel().querySelector('[role=alert]')"), false)
      await showManager()
      await evaluate("manager().querySelector('[aria-label=\"원격2 수정\"]').click()")
      await fill('원격2 · Windows', 'https://claude.ai/code/session_updated')
      await submit()
      await activePanel()
      assert.deepEqual(settings.claudeRemoteConnections, [{ id, label: '원격2 · Windows', url: 'https://claude.ai/code/session_updated' }])
      assert.equal(await evaluate("[...document.querySelectorAll('.tab-title')].filter(el => el.textContent.startsWith('원격2')).length"), 1, 'editing updates the existing tab')
      await showManager()
      await capture('saved-connection')
      await evaluate("manager().querySelector('[aria-label=\"원격2 · Windows 연결 삭제\"]').click()")
      await wait(() => settings.claudeRemoteConnections.length === 0 && !views.has(id), 'connection deleted and view closed')
      assert.equal(await evaluate("[...document.querySelectorAll('.tab-title')].some(el => el.textContent.startsWith('원격2'))"), false)
      assert.equal(agents.size, initialAgents, 'Remote Control does not create or replace an SSH agent')
      unchangedRemoteOne()
      assert.deepEqual(unexpected, [])
      assert.deepEqual(errors, [])
      console.log('PASS: Remote1 preserved; official URL validation; save failure/retry; native view; hide/reopen; stable tabs; connection failure/retry; edit/delete; settings persistence. Screenshots: ' + screenshotDir)
      app.exit(0)
    } catch (error) {
      const failedStage = stage
      await capture('failure').catch(captureError => console.error('Failure screenshot:', captureError))
      console.error(error)
      console.error(JSON.stringify({ stage: failedStage, visible: win?.isVisible(), errors, unexpected, calls: calls.slice(-12), dom: await evaluate('document.body.innerText').catch(() => ''), screenshotDir }))
      app.exit(1)
    }
  })()
}

const entry = path.join(temp, 'main.cjs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshotDir })})`)
  const code = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [entry], { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0, 'Claude Remote Control UI verification')
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
