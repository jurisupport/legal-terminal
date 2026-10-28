// Run after npm run build. Real renderer/preload; isolated files, IPC, and user profile.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'document-agent-memory-'))
const output = path.join(root, 'output/playwright/document-agent-memory')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function electronCheck({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const assert = require('node:assert/strict')
  app.setPath('userData', path.join(temp, 'profile'))
  const calls = [], checks = []
  const markdown = '# 선택 영역 회귀 검사\n\n' + Array.from({ length: 260 }, (_, i) => `제${i + 1}항 대금은 계약일로부터 30일 이내에 지급한다.\n\n`).join('')
  const html = '<!doctype html><html><body><h1>HTML 계약서</h1>' + Array.from({ length: 160 }, (_, i) => `<p id="paragraph-${i}">제${i + 1}항 지연이자는 연 5퍼센트로 한다.</p>`).join('') + '</body></html>'
  const settings = { sshProfiles: [], draftsRoot: '/synthetic', notificationSound: 'none', agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Document memory fixture', homeDirectory: '/synthetic' }
    if (channel === 'fs:readText') {
      const text = String(args[0]).endsWith('.html') ? html : markdown
      return { kind: 'text', ext: path.extname(String(args[0])), text, size: Buffer.byteLength(text), mtimeMs: 0 }
    }
    if (channel === 'fs:readBytes') return Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')).buffer
    if (channel === 'fs:list') return ['이미지 A.png', '이미지 B.png'].map(name => ({ name, path: '/synthetic/' + name, isDir: false }))
    if (channel === 'fs:stat') return { ok: true, isDir: !/\.(md|html)$/.test(String(args[0])), size: 100, mtimeMs: 0 }
    if (['fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false } })
  const consoleErrors = []
  w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message) })
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async (condition, label) => {
    for (let i = 0; i < 160; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-3000)')}`)
  }
  const screenshot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await w.webContents.capturePage()).toPNG())
  const clickTab = async title => {
    await run(`const tab = visible('.tab').find(el => el.querySelector('.tab-title')?.textContent === ${JSON.stringify(title)}); if (!tab) throw Error('Missing tab: ' + ${JSON.stringify(title)}); tab.click()`)
  }
  const activeAgent = title => `visible('.work-right .tab.active .tab-title').some(el => el.textContent === ${JSON.stringify(title)})`
  const sendAgent = async (id, title) => {
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id, kind: 'agent', agentProvider: 'claude', title, renamed: true, cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait(activeAgent(title), title)
    await wait("visible('.agent-composer textarea').length === 1", 'Agent composer ready')
    w.webContents.send('agent:event', { type: 'auth:status', sessionId: id, state: 'authenticated' })
  }
  const sendDoc = async (id, title, kind = 'mdview') => {
    w.webContents.send('tabs:receive', { kind: 'document', tab: { id, kind, path: '/synthetic/' + title, title, side: 'left' } })
    await wait(`visible('.work-left .tab.active .tab-title').some(el => el.textContent === ${JSON.stringify(title)})`, title)
    await wait(kind === 'mdview' ? "visible('.cm-editor').length === 1" : kind === 'image' ? "visible('.image-wrap img').some(el => el.complete && el.naturalWidth > 0)" : "!!document.querySelector('.html-frame')?.contentDocument?.getElementById('paragraph-80')", 'Document content ready')
  }
  const clickNative = async code => {
    const point = await run(`const r = (${code}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`)
    w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }
  const drag = async rect => {
    w.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: rect.x, y: rect.y })
    for (let step = 1; step <= 8; step++) {
      w.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: Math.round(rect.x + (rect.endX - rect.x) * step / 8), y: rect.y })
      await pause()
    }
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: rect.endX, y: rect.y })
    await wait("visible('.sel-actions button').some(el => el.textContent.includes('Claude에 묻기'))", 'Selection question action')
  }
  const quoteMarkdown = async () => {
    await run("visible('[title=\"원본(소스)\"]')[0].click(); visible('.cm-scroller')[0].scrollTop = 4000")
    await wait("visible('.cm-host.source').length === 1 && visible('.cm-scroller')[0].scrollTop > 2000", 'Scrolled Markdown source')
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const rect = await run(`
      const scroller = visible('.cm-scroller')[0], bounds = scroller.getBoundingClientRect();
      const el = [...scroller.querySelectorAll('.cm-line')].find(el => {
        const r = el.getBoundingClientRect(); return el.textContent.includes('대금은') && r.top > bounds.top + 120 && r.bottom < bounds.bottom - 100;
      });
      if (!el) throw Error('No visible source paragraph');
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
      return { x: Math.ceil(b.left + 1), endX: Math.floor(b.right - 1), y: Math.round(b.top + b.height / 2) };
    `)
    await drag(rect)
    const before = await run("return { top: visible('.cm-scroller')[0].scrollTop, text: getSelection().toString() }")
    assert.ok(before.text.includes('대금은'), 'Native drag selects the Markdown passage')
    await clickNative("visible('.sel-actions button').find(el => el.textContent.includes('Claude에 묻기'))")
    await wait("visible('.agent-attachments.pending .agent-attachment-chip').length === 1 && document.activeElement === visible('.agent-composer textarea')[0]", 'Quote attachment and focused composer')
    // Observe through layout and editor reconciliation, not just the first focus frame.
    await run('await new Promise(resolve => setTimeout(resolve, 300))')
    const after = await run("return { top: visible('.cm-scroller')[0].scrollTop, title: visible('.agent-attachments.pending .agent-attachment-chip')[0].title }")
    assert.ok(Math.abs(after.top - before.top) <= 2, `Markdown source stays at ${before.top}; got ${after.top}`)
    assert.ok(after.title.includes(before.text), 'Attached quote retains the actual selected text')
    assert.equal(await run("return visible('.sel-actions').length"), 0, 'Quote action closes after attachment')
    return before
  }
  const sendQuote = async (sessionId, sourceTitle) => {
    const count = calls.filter(call => call.channel === 'agent:send').length
    await run("visible('.agent-composer textarea')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
    for (let i = 0; i < 100 && calls.filter(call => call.channel === 'agent:send').length === count; i++) await pause()
    const call = calls.filter(call => call.channel === 'agent:send')[count]?.args[0]
    assert.equal(call?.sessionId, sessionId, 'Question sends to the expected panel')
    assert.equal(call?.input?.attachments?.[0]?.source?.path, '/synthetic/' + sourceTitle)
    w.webContents.send('agent:event', { type: 'status', sessionId, status: 'idle' })
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-sidebar-trigger')", 'App ready')
    await run(`
      window.visible = selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      window.memory = () => visible('.agent-document-link input[type=checkbox]')[0];
    `)
    await sendAgent('memory-agent-a', '문서 A 대화')
    await sendDoc('memory-doc-a', '문서 A.md')
    await wait('!!memory()', 'Document memory checkbox')
    assert.equal(await run('return memory().checked'), false, 'Document links are opt in')
    assert.ok(await run("return (memory().getAttribute('aria-label') || memory().labels?.[0]?.textContent || '').includes('에이전트 패널 기억하기')"), 'Checkbox has its accessible Korean label')
    assert.ok(await run("return visible('.agent-document-link')[0].textContent.includes('문서 A.md')"), 'Checkbox identifies its document')
    await run('memory().click()')
    await wait('memory()?.checked', 'A remembers panel 1')
    checks.push('A document can remember panel 1 through the labeled checkbox')
    await sendDoc('memory-doc-b', '문서 B.md')
    await sendAgent('memory-agent-b', '문서 B 대화')
    assert.equal(await run('return memory().checked'), false, 'B starts without an association')
    await run('memory().click()')
    await wait('memory()?.checked', 'B remembers panel 2')
    await clickTab('문서 A 대화')
    await wait("visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 A.md') && memory()?.checked", 'Panel 1 restores document A')
    await clickTab('문서 B 대화')
    await wait("visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 B.md') && memory()?.checked", 'Panel 2 restores document B')
    checks.push('Selecting either remembered panel restores its document')
    await clickTab('문서 A.md')
    await wait(activeAgent('문서 A 대화'), 'Returning to A restores panel 1')
    assert.equal(await run('return memory().checked'), true)
    checks.push('Returning from B to A restores its remembered panel 1')
    const markdownScroll = await quoteMarkdown()
    await screenshot('markdown-quote-memory')
    await sendQuote('memory-agent-a', '문서 A.md')
    checks.push('Native Markdown selection keeps the scrolled source position and focuses the composer')
    checks.push('A selection question sends to remembered panel 1 with its source attachment')
    await clickTab('문서 B.md')
    await wait(activeAgent('문서 B 대화'), 'Returning to B restores panel 2')
    assert.equal(await run('return memory().checked'), true)
    await quoteMarkdown()
    await sendQuote('memory-agent-b', '문서 B.md')
    checks.push('Returning to B restores panel 2 and sends its selected passage there')
    await run('memory().click()')
    await wait('memory() && !memory().checked', 'Uncheck removes B association')
    await clickTab('문서 A.md')
    await wait(activeAgent('문서 A 대화'), 'A remains associated after B uncheck')
    await clickTab('문서 B 대화')
    assert.ok(await run("return visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 A.md')"), 'An unlinked panel leaves the document unchanged')
    await clickTab('문서 A 대화')
    await clickTab('문서 B.md')
    assert.ok(await run(`return ${activeAgent('문서 A 대화')}`), 'Unlinked B leaves the current panel unchanged')
    assert.equal(await run('return memory().checked'), false)
    checks.push('Unchecking B removes only B association and stops automatic panel switching')
    await clickNative("visible('.agent-composer textarea')[0]")
    await wait("visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 A.md') && memory()?.checked", 'Clicking the active panel restores its linked document')
    checks.push('Clicking inside a panel also restores its document; unlinked panels leave documents unchanged')
    await sendDoc('memory-doc-c', '문서 C.md')
    await clickNative('memory()')
    await wait("memory()?.checked && visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 C.md')", 'Checkbox links C without navigating back to A')
    await clickTab('문서 A 대화')
    assert.ok(await run("return visible('.work-left .tab.active .tab-title').some(el => el.textContent === '문서 C.md')"), 'A shared panel keeps the current linked document')
    await clickNative('memory()')
    await wait('memory() && !memory().checked', 'Native checkbox unlinks C without navigating')
    await run("visible('.work-left .tab').find(el => el.querySelector('.tab-title')?.textContent === '문서 C.md').querySelector('.tab-close').click()")
    checks.push('Multiple documents can share a panel without checkbox clicks switching the document')
    await clickTab('문서 A.md')
    await run("visible('.work-right .tab').find(el => el.querySelector('.tab-title')?.textContent === '문서 A 대화').querySelector('.tab-close').click()")
    await wait("!visible('.work-right .tab-title').some(el => el.textContent === '문서 A 대화')", 'Remembered panel closes')
    await clickTab('문서 B.md')
    await clickTab('문서 A.md')
    await wait(activeAgent('문서 B 대화'), 'Closed panel cannot be restored')
    assert.equal(await run('return memory().checked'), false, 'Closing a panel removes its remembered association')
    await quoteMarkdown()
    await sendQuote('memory-agent-b', '문서 A.md')
    checks.push('Closing remembered panel 1 clears the link and routes the next question to live panel 2')
    await sendDoc('memory-doc-html', 'HTML 계약서.html', 'file')
    await run("document.querySelector('.html-frame').contentDocument.getElementById('paragraph-80').scrollIntoView({ block: 'center' })")
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const htmlRect = await run(`
      const f = document.querySelector('.html-frame'), d = f.contentDocument, r = d.createRange();
      r.selectNodeContents(d.getElementById('paragraph-80')); const b = r.getBoundingClientRect(), outer = f.getBoundingClientRect();
      return { x: Math.ceil(outer.left + f.clientLeft + b.left + 1), endX: Math.floor(outer.left + f.clientLeft + b.right - 1), y: Math.round(outer.top + f.clientTop + b.top + b.height / 2) };
    `)
    await drag(htmlRect)
    const htmlBefore = await run("return document.querySelector('.html-frame').contentWindow.scrollY")
    assert.ok(htmlBefore > 2000, 'HTML fixture is well below its first page')
    await clickNative("visible('.sel-actions button').find(el => el.textContent.includes('Claude에 묻기'))")
    await wait("visible('.agent-attachments.pending .agent-attachment-chip').length === 1 && document.activeElement === visible('.agent-composer textarea')[0]", 'HTML quote attachment and focused composer')
    await run('await new Promise(resolve => setTimeout(resolve, 300))')
    assert.equal(await run("return document.querySelector('.html-frame').contentWindow.scrollY"), htmlBefore, 'HTML source stays at its scroll position')
    await screenshot('html-quote-memory')
    await sendQuote('memory-agent-b', 'HTML 계약서.html')
    checks.push('Native HTML selection keeps its scroll position and sends its source to the live panel')
    await run('memory().click()')
    await wait('memory()?.checked', 'HTML document remembers panel 2')
    await run("visible('[title=\"문서를 오른쪽으로 이동\"]')[0].click()")
    await wait("visible('.work-right .tab.active .tab-title').some(el => el.textContent === 'HTML 계약서.html')", 'HTML document moves beside its remembered panel')
    await clickTab('문서 A.md')
    await clickTab('문서 B 대화')
    await wait(activeAgent('문서 B 대화'), 'Same-pane agent is accessible')
    await wait("memory()?.checked && visible('.agent-document-link')[0].textContent.includes('HTML 계약서.html')", 'Same-pane panel selects its linked document context without hiding itself')
    await clickTab('HTML 계약서.html')
    await wait("visible('.work-right .tab.active .tab-title').some(el => el.textContent === 'HTML 계약서.html') && visible('.html-frame').length === 1", 'Returning to same-pane document keeps it visible')
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.ok(await run("return visible('.work-right .tab.active .tab-title').some(el => el.textContent === 'HTML 계약서.html')"), 'Remembering an agent in the same pane does not replace the selected document')
    checks.push('A document and remembered panel can share a pane without hiding the document on return')
    await sendAgent('memory-agent-image-a', '이미지 A 대화')
    await sendDoc('memory-doc-image', '이미지 A.png', 'image')
    await run('memory().click()')
    await wait('memory()?.checked', 'Image A remembers its panel')
    const imageTabId = await run("return visible('.image-doc')[0].closest('[data-doc-id]').dataset.docId")
    const navigateImage = async (title, direction) => {
      await run(`const el = visible('.image-wrap')[0]; el.scrollTop = ${direction} > 0 ? el.scrollHeight : 0; el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: ${direction} * 100 }))`)
      await wait(`visible('.work-left .tab.active .tab-title').some(el => el.textContent === ${JSON.stringify(title)}) && visible('.image-wrap img').some(el => el.complete && el.naturalWidth > 0)`, 'Navigate to ' + title)
      assert.equal(await run("return visible('.image-doc')[0].closest('[data-doc-id]').dataset.docId"), imageTabId, 'Previous/next navigation reuses the same document tab')
    }
    await navigateImage('이미지 B.png', 1)
    assert.equal(await run('return memory().checked'), false, 'The next image does not inherit the previous image association')
    await sendAgent('memory-agent-image-b', '이미지 B 대화')
    await run('memory().click()')
    await wait('memory()?.checked', 'Image B remembers a different panel')
    await navigateImage('이미지 A.png', -1)
    await wait(activeAgent('이미지 A 대화'), 'Previous image restores its own panel')
    assert.equal(await run('return memory().checked'), true)
    await navigateImage('이미지 B.png', 1)
    await wait(activeAgent('이미지 B 대화'), 'Next image restores its own panel')
    assert.equal(await run('return memory().checked'), true)
    checks.push('Previous/next images sharing one document tab keep independent panel associations by file')
    assert.deepEqual(consoleErrors, [], 'Unexpected renderer errors')
    const result = { checks, markdownScroll: markdownScroll.top, htmlScroll: htmlBefore, consoleErrors, screenshots: ['markdown-quote-memory.png', 'html-quote-memory.png'].map(name => path.join(output, name)) }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('DOCUMENT_AGENT_MEMORY_RESULT ' + JSON.stringify(result))
    app.exit(0)
  } catch (error) {
    await screenshot('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, consoleErrors, state: await run("return { selection: getSelection().toString(), active: document.activeElement?.outerHTML?.slice(0, 1000), scroll: window.visible?.('.cm-scroller')[0]?.scrollTop, actions: window.visible?.('.sel-actions').map(el => el.outerHTML) }").catch(() => null) }, null, 2))
    console.error(error)
    console.error(JSON.stringify({ checks, consoleErrors, channels: [...new Set(calls.map(call => call.channel))] }))
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
    const timeout = setTimeout(() => { child.kill(); reject(Error('Document memory check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  if (result.code !== 0) console.error(result.output)
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('DOCUMENT_AGENT_MEMORY_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
