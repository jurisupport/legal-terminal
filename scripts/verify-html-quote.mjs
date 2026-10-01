// Run after npm run build. Real renderer/preload, isolated HTML and stubbed IPC.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'html-quote-'))
const output = path.join(root, 'output/playwright/html-quote')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function electronCheck({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const assert = require('node:assert/strict')
  app.setPath('userData', path.join(temp, 'profile'))
  const calls = []
  const html = '<!doctype html><html><head><title>HTML 계약서</title></head><body class="sidebar agent-panel"><h1>HTML 계약서</h1><p id="quote" class="textLayer" data-pdf-page="7" data-pdf-path="/wrong.pdf">대금은 계약일로부터 30일 이내에 지급한다.</p><p id="keyboard">지연이자는 연 5퍼센트로 한다.</p><button id="unsafe" onclick="document.body.dataset.handlerRan = 1">실행 차단 확인</button><script>document.body.dataset.scriptRan = 1</script><div style="height:1600px"></div></body></html>'
  const settings = { sshProfiles: [], draftsRoot: '/synthetic', notificationSound: 'none', agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (ipc, ...args) => {
    calls.push({ channel, args })
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'HTML fixture', homeDirectory: '/synthetic' }
    if (channel === 'fs:readText') return { kind: 'text', ext: '.html', text: html, size: Buffer.byteLength(html), mtimeMs: 0 }
    if (channel === 'fs:stat') return { ok: true, isDir: !String(args[0]).endsWith('.html'), size: 100, mtimeMs: 0 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel === 'agent:create') ipc.sender.send('agent:event', { type: 'auth:status', sessionId: args[0].id, state: 'authenticated' })
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const consoleErrors = []
  w.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !/Blocked script execution.*sandboxed.*allow-scripts/.test(message)) consoleErrors.push(message)
  })
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async (condition, label) => {
    for (let i = 0; i < 160; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-2500)')}`)
  }
  const screenshot = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(output, name + '.png'), (await w.webContents.capturePage()).toPNG())
  }
  const select = async (id = 'quote', keyboard = false) => {
    await run(`
      const d = document.querySelector('.html-frame').contentDocument, el = d.getElementById(${JSON.stringify(id)});
      const s = d.getSelection(), r = d.createRange();
      if (!${keyboard}) el.dispatchEvent(new d.defaultView.PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
      r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);
      d.dispatchEvent(new d.defaultView.Event('selectionchange'));
      el.dispatchEvent(${keyboard} ? new d.defaultView.KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }) : new d.defaultView.PointerEvent('pointerup', { bubbles: true, isPrimary: true, button: 0 }));
    `)
    await wait("visible('.sel-actions button').length === 1", 'HTML selection action')
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-tabs-trigger')", 'App ready')
    await run(`
      window.checks = [];
      window.check = (value, label) => { if (!value) throw Error(label); checks.push(label) };
      window.visible = selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      window.click = selector => { const el = visible(selector)[0]; if (!el || el.disabled) throw Error('Missing or disabled: ' + selector); el.click() };
      window.popup = () => document.querySelector('.inline-selection-command');
      window.frame = () => document.querySelector('.html-frame');
      window.highlight = () => frame().contentWindow.CSS.highlights.get('inline-command-source');
    `)
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'html-agent', kind: 'agent', agentProvider: 'claude', title: 'HTML 계약 검토', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait("visible('.agent-composer textarea').length === 1", 'Agent ready')
    w.webContents.send('tabs:receive', { kind: 'document', tab: { id: 'html-doc', kind: 'file', path: '/synthetic/계약서.html', title: '계약서.html', side: 'left' } })
    await wait("!!document.querySelector('.html-frame')", 'HTML frame')
    await wait("!!document.querySelector('.html-frame').contentDocument?.getElementById('quote')", 'HTML document accessible for selection')
    await run(`
      const frame = document.querySelector('.html-frame'), d = frame.contentDocument;
      check(!frame.sandbox.contains('allow-scripts'), 'HTML preview does not permit scripts');
      d.getElementById('unsafe').click();
      check(!d.body.dataset.scriptRan && !d.body.dataset.handlerRan, 'Inline scripts and event handlers stay blocked');
    `)
    const drag = await run(`
      const frame = document.querySelector('.html-frame'), d = frame.contentDocument, r = d.createRange();
      r.selectNodeContents(d.getElementById('quote'));
      const text = r.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
      return { x: Math.floor(bounds.left + frame.clientLeft + text.left), endX: Math.ceil(bounds.left + frame.clientLeft + text.right), y: Math.round(bounds.top + frame.clientTop + text.top + text.height / 2) };
    `)
    w.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: drag.x, y: drag.y })
    for (let step = 1; step <= 8; step++) {
      w.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: Math.round(drag.x + (drag.endX - drag.x) * step / 8), y: drag.y })
      await pause()
    }
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: drag.endX, y: drag.y })
    await wait("visible('.sel-actions button').length === 1", 'Real pointer drag creates HTML selection action')
    await run(`
      check(document.querySelector('.html-frame').contentDocument.getSelection().toString() === '대금은 계약일로부터 30일 이내에 지급한다.', 'Real pointer drag selects the HTML passage');
      const f = document.querySelector('.html-frame').getBoundingClientRect(), box = visible('.sel-actions')[0].getBoundingClientRect();
      check(box.left >= f.left && box.right <= innerWidth && box.top >= f.top && box.bottom <= f.bottom, 'HTML selection action uses parent viewport coordinates');
    `)
    await screenshot('html-selection')
    await run("click('.sel-actions button')")
    await wait("!!popup() && highlight()?.size === 1", 'HTML inline command and source highlight')
    await run(`
      check(popup().getAttribute('role') === 'dialog' && popup().querySelector('.inline-selection-source').title.includes('계약서.html') && popup().querySelector('.inline-selection-source').title.includes('대금은 계약일로부터 30일 이내에 지급한다.'), 'Inline command captures HTML filename and selected text');
      check([...highlight()][0].toString() === '대금은 계약일로부터 30일 이내에 지급한다.', 'HTML source stays highlighted while instruction input has focus');
      check(!frame().contentDocument.getSelection().toString() && !visible('.sel-actions').length, 'Opening inline command clears native selection and floating action');
      const selected = [...highlight()][0].getBoundingClientRect(), bounds = popup().getBoundingClientRect(), f = frame().getBoundingClientRect(), pane = frame().closest('.work-pane').getBoundingClientRect();
      const bottom = selected.bottom + f.top + frame().clientTop;
      check(bounds.left >= pane.left && bounds.right <= pane.right && bounds.top >= bottom && bounds.top - bottom < 24, 'HTML inline command stays below selection inside its source pane');
      window.beforeScroll = bounds.top;
      frame().contentWindow.scrollTo(0, 24);
    `)
    await wait("frame().contentWindow.scrollY === 24 && Math.abs(popup().getBoundingClientRect().top - beforeScroll + 24) < 3", 'Inline popup follows real iframe scroll')
    await run("check(true, 'Inline command follows iframe scroll'); frame().contentWindow.scrollTo(0, 0)")
    await wait("Math.abs(popup().getBoundingClientRect().top - beforeScroll) < 3", 'Inline popup returns with source')
    await screenshot('html-inline-command')
    await run(`
      const el = popup().querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '이 조항을 검토해줘.');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    `)
    await wait("!popup().querySelector('.inline-selection-send').disabled", 'Inline command ready to send')
    await run("click('.inline-selection-send')")
    await wait('!popup() && !highlight()', 'Successful inline send closes command and clears highlight')
    for (let i = 0; i < 100 && !calls.some(c => c.channel === 'agent:send'); i++) await pause()
    const sent = calls.find(c => c.channel === 'agent:send')?.args[0]
    assert.equal(sent?.sessionId, 'html-agent')
    assert.equal(sent?.input?.text, '이 조항을 검토해줘.')
    const attachment = sent?.input?.attachments?.[0]
    assert.equal(attachment?.source?.path, '/synthetic/계약서.html')
    assert.equal(attachment?.source?.title, '계약서.html')
    assert.equal(attachment?.source?.text, '대금은 계약일로부터 30일 이내에 지급한다.')
    assert.equal(attachment?.source?.range, undefined, 'HTML classes cannot supply PDF metadata')
    await run("check(true, 'Inline send retains selected text and HTML source path/title without fake PDF metadata')")
    w.webContents.send('agent:event', { type: 'status', sessionId: 'html-agent', status: 'idle' })
    for (const modifier of ['metaKey', 'ctrlKey']) {
      await select('keyboard', true)
      await run(`const d = frame().contentDocument; d.getElementById('keyboard').dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'j', ${modifier}: true, bubbles: true, cancelable: true }))`)
      await wait("!!popup() && highlight()?.size === 1", modifier + '+J opens HTML inline command')
      await run("check(popup().querySelector('.inline-selection-source').title.includes('지연이자는 연 5퍼센트로 한다.'), 'Iframe shortcut opens command for the selected text'); click('[aria-label=\"지시창 닫기\"]')")
      await wait('!popup() && !highlight()', 'Closing command clears HTML highlight')
    }
    await select('keyboard')
    await run(`
      const d = document.querySelector('.html-frame').contentDocument;
      d.getElementById('keyboard').dispatchEvent(new d.defaultView.MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 200 }));
    `)
    await wait("visible('.ctx-item').some(el => el.textContent.includes('Claude'))", 'HTML context menu')
    await run("visible('.ctx-item').find(el => el.textContent.includes('Claude')).click()")
    await wait("visible('.agent-attachment-chip').some(el => el.title.includes('지연이자는 연 5퍼센트로 한다.'))", 'Context menu quote attachment')
    await run("check(true, 'Right-click question attaches the selected HTML text')")
    await select()
    await run("document.querySelector('.html-frame').contentDocument.dispatchEvent(new Event('scroll'))")
    await wait("!visible('.sel-actions').length", 'Iframe scroll dismisses action')
    await select()
    await run("document.dispatchEvent(new Event('scroll'))")
    await wait("!visible('.sel-actions').length", 'Outer scroll dismisses action')
    await select()
    await run(`
      const d = document.querySelector('.html-frame').contentDocument;
      d.body.dispatchEvent(new d.defaultView.PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
      d.getSelection().removeAllRanges();
      d.body.dispatchEvent(new d.defaultView.PointerEvent('pointerup', { bubbles: true, isPrimary: true, button: 0 }));
      d.body.click();
    `)
    await wait("!visible('.sel-actions').length", 'Iframe click dismisses action')
    await select()
    await run("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 })); document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, button: 0 })); document.body.click()")
    await wait("!visible('.sel-actions').length", 'Outer click dismisses action')
    await run("check(true, 'Iframe/outer scroll and clicks dismiss stale selection actions'); click('[title=\"HTML 코드 보기\"]')")
    await wait("visible('.text-doc .file-view').length === 1", 'HTML source mode')
    await run(`
      const el = [...document.querySelectorAll('.file-view span')].find(el => el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE && el.textContent.includes('대금은'));
      const r = document.createRange(); r.selectNodeContents(el);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    `)
    await wait("visible('.sel-actions button').length === 1", 'Source mode selection action')
    await run("click('.sel-actions button')")
    await wait("!!popup() && CSS.highlights.get('inline-command-source')?.size === 1", 'Source mode inline command')
    await run("check(popup().querySelector('.inline-selection-source').title.includes('계약서.html') && popup().querySelector('.inline-selection-source').title.includes('대금은 계약일로부터'), 'HTML source mode keeps the existing inline command'); click('[aria-label=\"지시창 닫기\"]')")
    assert.deepEqual(consoleErrors, [], 'Unexpected renderer errors')
    const result = { checks: await run('return window.checks'), consoleErrors, screenshots: ['html-selection', 'html-inline-command'].map(name => path.join(output, name + '.png')) }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('HTML_QUOTE_RESULT ' + JSON.stringify(result))
    app.exit(0)
  } catch (error) {
    await screenshot('failure').catch(() => {})
    console.error(error)
    console.error(JSON.stringify({ consoleErrors, channels: [...new Set(calls.map(c => c.channel))] }))
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${electronCheck.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : ''))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('HTML quote check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('HTML_QUOTE_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
