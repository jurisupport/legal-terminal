import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Build first: npm run build && node scripts/verify-detached-quote.mjs
// Real main/preload/renderer and window IPC; isolated backend and blocked network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-quote-'))

function runApp({ root, temp }) {
  const { app, BrowserWindow, ipcMain, screen, session } = require('electron')
  const assert = require('node:assert/strict')
  const path = require('node:path')
  const calls = [], errors = [], windows = [], sessions = new Map()
  const docPath = '/synthetic/계약서.html'
  const title = '계약서.html'
  const quote = '대금은 계약일로부터 30일 이내에 지급한다.'
  const draft = '기존에 작성 중인 질문을 유지해 주세요.'
  const html = `<!doctype html><html><body><h1>계약서</h1><p id="quote">${quote}</p></body></html>`
  app.setPath('userData', path.join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
  BrowserWindow.prototype.focus = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  app.whenReady().then(() => {
    screen.getCursorScreenPoint = () => ({ x: 30000, y: -30000 })
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })
    )
  })
  const handle = ipcMain.handle.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  const real = new Set([
    'app:info', 'app:setWindowTitle', 'tabs:ready', 'tabs:beginDrag', 'tabs:endDrag',
    'claude:ask', 'window:new', 'window:close', 'window:forceClose'
  ])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, windowId: BrowserWindow.fromWebContents(event.sender)?.id, args })
    if (real.has(channel)) return handler(event, ...args)
    if (channel === 'settings:get') return { sshProfiles: [], draftsRoot: '/synthetic', notifyDone: false, agentDefaultProvider: 'claude' }
    if (channel === 'fs:readText') return { kind: 'text', ext: '.html', text: html, size: Buffer.byteLength(html), mtimeMs: 0 }
    if (channel === 'fs:stat') return { ok: true, isDir: !String(args[0]).endsWith('.html'), size: 100, mtimeMs: 0 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:tokenStatus') return { hasToken: false, error: null }
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel.startsWith('case:get')) return null
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoLoad') return { ok: true }
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'agent:create') { sessions.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (['agent:send', 'agent:close', 'workspace:autoSave', 'workspace:autoObserve', 'sessions:remember', 'fs:createFile', 'fs:ensureDir'].includes(channel)) return { ok: true }
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.on('browser-window-created', (_event, win) => {
    windows.push(win)
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
  })
  require(path.join(root, 'out/main/index.js'))
  const evaluate = (win, source) => win.webContents.executeJavaScript(source, true)
  const pause = () => new Promise(resolve => setTimeout(resolve, 40))
  const wait = async (label, check) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await pause() }
    throw Error(`Timed out: ${label}`)
  }
  const sends = () => calls.filter(call => call.channel === 'agent:send')
  const ready = win => wait('window ready', () => evaluate(win, `!!document.querySelector('.case-sidebar-trigger')`))
  const documentTab = id => ({ kind: 'doc', tab: { id, kind: 'file', path: docPath, title, side: 'left' } })
  const agentTab = id => ({ kind: 'terminal', tab: { id, kind: 'agent', agentProvider: 'claude', title: '인용 검증', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
  const prepareAgent = async (win, id) => {
    await wait('agent composer', () => evaluate(win, `!!document.querySelector('.agent-composer textarea')`))
    win.webContents.send('agent:event', { type: 'auth:status', sessionId: id, state: 'authenticated' })
    await evaluate(win, `(() => {
      const el = document.querySelector('.agent-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(draft)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait('existing draft', () => evaluate(win, `document.querySelector('.agent-composer textarea')?.value === ${JSON.stringify(draft)}`))
  }
  const clickQuote = async win => {
    await wait('HTML document', () => evaluate(win, `!!document.querySelector('.html-frame')?.contentDocument?.getElementById('quote')`))
    await evaluate(win, `(() => {
      const d = document.querySelector('.html-frame').contentDocument, el = d.getElementById('quote');
      el.dispatchEvent(new d.defaultView.PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
      const selection = d.getSelection(), range = d.createRange();
      range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      d.dispatchEvent(new d.defaultView.Event('selectionchange'));
      el.dispatchEvent(new d.defaultView.PointerEvent('pointerup', { bubbles: true, isPrimary: true, button: 0 }));
    })()`)
    await wait('quote action', () => evaluate(win, `!!document.querySelector('.sel-actions button')`))
    await evaluate(win, `document.querySelector('.sel-actions button').click()`)
  }
  const verifyAttachmentAndSend = async (win, id, expectedSends, plainSource) => {
    await wait('selection attachment without automatic send', async () => {
      assert.equal(sends().length, expectedSends, 'quoting must not send a request before explicit Enter')
      return evaluate(win, `!!document.querySelector('.agent-attachment-chip')`)
    })
    await pause()
    assert.equal(sends().length, expectedSends, 'attachment waits for explicit Enter')
    const state = await evaluate(win, `({
      text: document.querySelector('.agent-composer textarea').value,
      title: document.querySelector('.agent-attachment-chip').title,
      label: document.querySelector('.agent-attachment-chip').textContent
    })`)
    assert.ok(state.text.startsWith(draft), 'quoting preserves the existing draft')
    assert.ok(!state.text.includes(quote), 'selected passage stays in the attachment')
    assert.ok(state.title.includes(docPath) && state.title.includes(quote), 'attachment shows source path and selected text')
    assert.ok(state.label.includes(title), 'attachment shows source title')
    let expectedText = state.text
    if (plainSource) {
      const plainDraft = '문서 전체에 관해 이어서 질문합니다.'
      await evaluate(plainSource, `window.lt.claude.ask(${JSON.stringify(plainDraft)}, ${JSON.stringify({ pasteOnly: true, contextPath: docPath })})`)
      await wait('cross-window plain draft', async () => {
        assert.equal(sends().length, expectedSends, 'pasteOnly survives the window bridge without sending')
        return evaluate(win, `document.querySelector('.agent-composer textarea')?.value.includes(${JSON.stringify(plainDraft)})`)
      })
      expectedText = await evaluate(win, `document.querySelector('.agent-composer textarea').value`)
      assert.ok(expectedText.startsWith(state.text), 'a plain draft preserves existing typed text and quote prompt')
      assert.equal(await evaluate(win, `document.querySelectorAll('.agent-attachment-chip').length`), 1,
        'a plain draft preserves the existing quote attachment')
      assert.equal(await evaluate(win, `document.querySelector('.agent-attachment-chip').title`), state.title)
      console.log('PASS: cross-window plain draft waits in the composer and preserves existing text and attachment')
    }
    await evaluate(win, `document.querySelector('.agent-composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await wait('explicit send', () => sends().length === expectedSends + 1)
    const sent = sends().at(-1)
    assert.equal(sent.windowId, win.id)
    assert.equal(sent.args[0].sessionId, id)
    assert.equal(sent.args[0].input.text, expectedText.trim())
    assert.equal(sent.args[0].input.attachments.length, 1)
    const attachment = sent.args[0].input.attachments[0]
    assert.equal(attachment.kind, 'selection')
    assert.equal(attachment.source.path, docPath)
    assert.equal(attachment.source.title, title)
    assert.equal(attachment.source.text, quote)
    assert.equal(attachment.source.range, undefined)
  }
  ;(async () => {
    try {
      await wait('main window', () => windows.length > 0)
      const main = windows[0]
      await ready(main)
      main.webContents.send('tabs:receive', agentTab('main-agent'))
      await prepareAgent(main, 'main-agent')
      main.webContents.send('tabs:receive', documentTab('detached-document'))
      await wait('source document tab', () => evaluate(main, `!![...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes(${JSON.stringify(title)}))`))
      await evaluate(main, `(() => {
        const tab = [...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes(${JSON.stringify(title)}));
        if (!tab.draggable) throw Error('Document tab is not draggable');
        const dataTransfer = new DataTransfer();
        tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
      })()`)
      await wait('detached document window', () => windows.length === 2)
      const detached = windows[1]
      await wait('source document removed', () => evaluate(main, `![...document.querySelectorAll('.tab')].some(tab => tab.innerText.includes(${JSON.stringify(title)}))`))
      assert.ok((await evaluate(detached, 'location.hash')).includes('docOnly'))
      await clickQuote(detached)
      await verifyAttachmentAndSend(main, 'main-agent', 0, detached)
      assert.equal(calls.filter(call => call.channel === 'claude:ask' && call.windowId === detached.id).length, 2,
        'the quote and plain draft cross the real main-process IPC bridge')
      console.log('PASS: detached document quote preserves source and draft, then sends only after Enter')

      await evaluate(main, `window.lt.app.newWindow(${JSON.stringify({ tabs: [agentTab('new-window-agent'), documentTab('new-window-document')] })})`)
      await wait('new full window', () => windows.length === 3)
      const full = windows[2]
      await prepareAgent(full, 'new-window-agent')
      await clickQuote(full)
      await verifyAttachmentAndSend(full, 'new-window-agent', 1)
      assert.equal(calls.filter(call => call.channel === 'claude:ask' && call.windowId === full.id).length, 0,
        'a full window quotes into its own conversation')
      assert.equal(await evaluate(main, `document.querySelector('.agent-composer textarea').value`), '',
        'quoting in another full window leaves the main composer unchanged')
      console.log('PASS: new full window quotes locally and waits for Enter without changing the main conversation')

      assert.deepEqual(errors, [], 'unexpected renderer errors')
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, calls: calls.map(({ channel, windowId }) => ({ channel, windowId })), windows: await Promise.all(windows.map(async win => ({
        id: win.id, text: win.isDestroyed() ? '' : await evaluate(win, 'document.body.innerText').catch(() => ''),
        input: win.isDestroyed() ? '' : await evaluate(win, `document.querySelector('.agent-composer textarea')?.value`).catch(() => '')
      }))) }))
      app.exit(1)
    }
  })()
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const entry = path.join(temp, 'main.cjs')
  await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp })})`)
  const code = await new Promise((resolve, reject) => {
    const proc = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit' })
    const watchdog = setTimeout(() => proc.kill('SIGKILL'), 45000)
    proc.on('error', reject)
    proc.on('exit', code => { clearTimeout(watchdog); resolve(code) })
  })
  assert.equal(code, 0, 'detached and new-window quoting scenarios')
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
