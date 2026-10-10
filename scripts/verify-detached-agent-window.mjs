import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Build first: npm run build && node scripts/verify-detached-agent-window.mjs
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-agent-window-'))

function runApp({ root, temp, closeMode }) {
  const { app, BrowserWindow, ipcMain, screen, session } = require('electron')
  const assert = require('node:assert/strict')
  const calls = [], errors = [], windows = [], sessions = new Map()
  const profile = { id: 'detached-test', label: '검증 서버', host: 'example.invalid', user: 'test' }
  const cwd = '/cases/detached-window'
  const recent = { drafts: `ssh://${profile.id}${cwd}`, name: '창 분리 검증', ts: Date.now() }
  const snapshot = {
    version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceOpen: true,
    currentCase: { drafts: cwd, name: recent.name }, activeTerm: 'moved-agent', docs: [],
    terminals: [
      { id: 'moved-agent', title: '이동할 대화', kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: 'moved-session' },
      { id: 'retained-agent', title: '남아 있을 대화', kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: 'retained-session' }
    ]
  }
  let blockedSaveWindow = null
  app.setPath('userData', require('node:path').join(temp, closeMode))
  // Keep the real windows hidden. Focus refresh uses backend ownership state,
  // which belongs to the separate workspace regression rather than this mock.
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
  BrowserWindow.prototype.focus = function () {}
  app.whenReady().then(() => { screen.getCursorScreenPoint = () => ({ x: 30000, y: -30000 }) })
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  const real = new Set([
    'app:info', 'app:setWindowTitle', 'tabs:ready', 'tabs:beginDrag', 'tabs:endDrag',
    'tabs:dropOnTabBar', 'window:close', 'window:forceClose',
    'caseManagement:get', 'caseManagement:update'
  ])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id
    calls.push({ channel, windowId, args, at: Date.now() })
    if (real.has(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return { sshProfiles: [profile], notifyDone: false }
    if (channel === 'case:history' || channel === 'case:addHistory') return [recent]
    if (channel === 'js:tokenStatus') return { hasToken: false, error: null }
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (['fs:list', 'fs:listPdfs', 'sessions:list'].includes(channel)) return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return undefined
    if (channel === 'sessions:transcript') return { sessionId: args[0], messages: [] }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: args[0] ? [snapshot] : [] }
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'workspace:autoLoad') {
      // Source focus refresh must respect its latest saved subset. The detached
      // window still sees the full shared case, exposing any accidental restore.
      // Actual ownership merging is covered by the separate workspace regression.
      const saved = windowId === windows[0]?.id
        ? calls.findLast((call) => call.channel === 'workspace:autoSave' && call.windowId === windowId)?.args[0].snapshot
        : undefined
      const visible = saved
        ? { ...snapshot, terminals: snapshot.terminals.filter((tab) => saved.terminals.some((live) => live.id === tab.id)) }
        : snapshot
      return { ok: true, remote: { ok: true, snapshot: visible } }
    }
    if (channel === 'workspace:autoObserve') return undefined
    if (channel === 'workspace:autoSave') {
      if (windowId === blockedSaveWindow) return new Promise(() => {})
      return { ok: true }
    }
    if (channel === 'agent:create') { sessions.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:close') return { ok: true }
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })
  ))
  app.on('browser-window-created', (_event, win) => {
    windows.push(win)
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
  })
  require(require('node:path').join(root, 'out/main/index.js'))
  const evaluate = (win, source) => win.webContents.executeJavaScript(source, true)
  const wait = async (label, check) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw Error(`Timed out: ${label}`)
  }
  const tabTitles = (win) => evaluate(win, `[...document.querySelectorAll('.tab .tab-title')].map(tab => tab.textContent.replace(/^Agent · /, ''))`)
  const saves = (win) => calls.filter((call) => call.channel === 'workspace:autoSave' && call.windowId === win.id)
  const dragStart = (win, title) => evaluate(win, `(() => {
    const tab = [...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes(${JSON.stringify(title)}));
    if (!tab || !tab.draggable) throw Error('Draggable tab missing');
    window.testDraggedTab = tab;
    window.testDragData = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.testDragData }));
  })()`)
  const dragEnd = (win) => evaluate(win, `window.testDraggedTab.dispatchEvent(new DragEvent('dragend', {
    bubbles: true, cancelable: true, dataTransfer: window.testDragData
  }))`)
  const tearOut = async (source, { blockSave = false } = {}) => {
    const before = windows.length
    await dragStart(source, '이동할 대화')
    await dragEnd(source)
    await wait('new detached window', () => windows.length === before + 1)
    const detached = windows.at(-1)
    if (blockSave) blockedSaveWindow = detached.id
    await wait('detached tab received', async () => (await tabTitles(detached)).includes('이동할 대화'))
    await wait('source tab removed', async () => !(await tabTitles(source)).includes('이동할 대화'))
    assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')), ['남아 있을 대화'])
    await wait('detached automatic save after debounce', () => saves(detached).length > 0)
    assert.deepEqual(saves(detached).at(-1).args[0].snapshot.terminals.map((tab) => tab.id), ['moved-agent'],
      'automatic save keeps only the conversation that was dragged out')
    assert.deepEqual(await tabTitles(detached), ['이동할 대화'],
      'the detached window still contains exactly one conversation after automatic save')
    assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' && call.windowId === detached.id), false,
      'saving a detached tab does not restore the entire shared case')
    return detached
  }
  ;(async () => {
    try {
      await wait('main window', () => windows.length > 0)
      const source = windows[0]
      await wait('case discovery', () => evaluate(source, `!!document.querySelector('.case-sidebar-case')`))
      await evaluate(source, `document.querySelector('.case-sidebar-case').click()`)
      await wait('two source conversations', async () => (await tabTitles(source)).filter((title) => title.includes('대화')).length === 2)
      await wait('initial source workspace save', () => saves(source).length > 0)

      if (closeMode === 'native') {
        const detached = await tearOut(source)
        console.log('PASS: dragging one conversation keeps the other in the source and saves only the moved tab')

        await dragStart(detached, '이동할 대화')
        await evaluate(source, `(() => {
          const bar = document.querySelector('.work-right > .tabs');
          if (!bar) throw Error('Source tab bar missing');
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('application/x-legal-terminal-tab', 'moved-agent');
          bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        })()`)
        await dragEnd(detached)
        await wait('empty detached window closes after moving back', () => detached.isDestroyed())
        await wait('both conversations back in source', async () => (await tabTitles(source)).filter((title) => title.includes('대화')).length === 2)
        assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')).sort(), ['남아 있을 대화', '이동할 대화'].sort())
        console.log('PASS: moving the conversation back restores it once and closes the empty detached window')

      }

      const blocked = await tearOut(source, { blockSave: true })
      if (closeMode === 'native') blocked.close()
      else await evaluate(blocked, `document.querySelector('.tab-close').click()`)
      await wait('detached close while workspace save is unresolved', () => blocked.isDestroyed())
      assert.deepEqual(saves(blocked).at(-1).args[0].snapshot.terminals.map((tab) => tab.id),
        closeMode === 'tab' ? [] : ['moved-agent'],
        'dispatch the final tab list before destroying the window so a closed tab cannot reappear')
      assert.equal(calls.some((call) => call.channel === 'window:forceClose' && call.windowId === blocked.id), true,
        'native close request goes through the real renderer close guard')
      assert.equal(source.isDestroyed(), false)
      assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')), ['남아 있을 대화'])
      assert.equal(calls.some((call) => call.channel === 'agent:close' && call.args[0] === 'retained-agent'), false,
        'closing the detached window never stops the conversation left in the source')
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      assert.deepEqual(errors, [])
      console.log(`PASS: detached ${closeMode === 'native' ? 'native window' : 'tab button'} close completes even while automatic workspace save never resolves`)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, calls: calls.map(({ channel, windowId, args }) => ({ channel, windowId, ...(channel === 'workspace:autoSave' ? { tabs: args[0].snapshot.terminals.map(tab => tab.id) } : {}) })), windows: await Promise.all(windows.map(async (win) => ({
        id: win.id, destroyed: win.isDestroyed(),
        text: win.isDestroyed() ? '' : await evaluate(win, 'document.body.innerText').catch(() => '')
      }))) }))
      app.exit(1)
    }
  })()
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  for (const closeMode of ['native', 'tab']) {
    const entry = path.join(temp, `${closeMode}.cjs`)
    await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp, closeMode })})`)
    const code = await new Promise((resolve, reject) => {
      const proc = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit' })
      const watchdog = setTimeout(() => { proc.kill('SIGKILL') }, 45000)
      proc.on('error', reject)
      proc.on('exit', (code) => { clearTimeout(watchdog); resolve(code) })
    })
    assert.equal(code, 0, `${closeMode} close scenario`)
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
