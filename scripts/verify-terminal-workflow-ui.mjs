// Run after npm run build. Real renderer/preload; isolated fixtures and stubbed IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-workflow-ui-'))
const output = path.join(root, 'output/playwright/terminal-workflow')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map((match) => match[1]))]

// Two-page, selectable PDF built without fixtures, external files, or extra libraries.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
  '',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  '',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
]
for (const [index, text] of [[3, 'Synthetic contract page one.'], [5, 'Quoted payment term on page two.']]) {
  const stream = `BT /F1 18 Tf 60 720 Td (${text}) Tj ET\n`
  objects[index] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
}
let pdf = '%PDF-1.4\n'
const offsets = [0]
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf))
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
}
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

async function electronCheck({ root, temp, output, channels, pdf }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const calls = []
  const created = new Set()
  const settings = { sshProfiles: [], draftsRoot: '/synthetic', notificationSound: 'none', agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'UI fixture', homeDirectory: '/synthetic' }
    if (channel === 'fs:readBytes') return Uint8Array.from(Buffer.from(pdf, 'base64')).buffer
    if (channel === 'fs:stat') return { ok: true, isDir: !String(args[0]).endsWith('.pdf'), size: 100, mtimeMs: 0 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:create') created.add(args[0].id)
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
  const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = (code) => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async (condition, label) => {
    for (let i = 0; i < 160; i++) {
      if (await run(`return (${condition})`)) return
      await pause()
    }
    throw new Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-3500)')}`)
  }
  const screenshot = async (name) => fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage()).toPNG())
  const terminal = (id, title, cwd) => ({ kind: 'terminal', tab: { id, kind: 'agent', agentProvider: 'claude', title, cwd, side: 'right', createdAt: Date.now() } })
  const add = async (id, title, cwd) => {
    w.webContents.send('tabs:receive', terminal(id, title, cwd))
    for (let i = 0; i < 100 && !created.has(id); i++) await pause()
    if (!created.has(id)) throw new Error(`Agent not created: ${id}`)
    await pause()
  }
  const status = async (id, value) => {
    w.webContents.send('agent:event', { type: 'status', sessionId: id, status: value })
    await pause()
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-tabs-trigger')", 'App ready')
    await run(`
      window.smokeChecks = [];
      window.check = (condition, label) => { if (!condition) throw Error(label); window.smokeChecks.push(label) };
      window.visible = (selector) => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      window.click = (selector) => { const el = visible(selector)[0]; if (!el || el.disabled) throw Error('Missing or disabled '+selector); el.click() };
      window.openCases = () => { if (!document.querySelector('.case-tabs-flyout')) click('.case-tabs-trigger') };
    `)
    await add('fixture-a', '계약서 검토', '/synthetic/case-a')
    w.webContents.send('tabs:receive', { kind: 'document', tab: { id: 'fixture-pdf', kind: 'pdf', path: '/synthetic/case-a/계약서.pdf', title: '계약서.pdf', side: 'left' } })
    await wait("visible('.textLayer[data-pdf-page=" + '"1"' + "] span').length > 0", 'PDF page one')
    await run(`click('.pdf-toolbar [title="다음 페이지"]')`)
    await wait("visible('.textLayer[data-pdf-page=" + '"2"' + "] span').length > 0", 'PDF page two')
    await run(`
      const span = visible('.textLayer span').find(el => el.textContent.includes('Quoted payment'));
      check(!!span, 'PDF page two selectable text');
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    `)
    await wait("visible('.sel-actions button').length > 0", 'Selection action')
    await run(`visible('.textLayer span').find(el => el.textContent.includes('Quoted payment')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 220 }))`)
    await wait("visible('.ctx-item').some(el => el.textContent.includes('Claude'))", 'Quote context action')
    await run(`visible('.ctx-item').find(el => el.textContent.includes('Claude')).click()`)
    await wait("visible('.agent-attachment-chip').some(el => el.textContent.includes('PDF 2쪽'))", 'Page-labelled attachment')
    await run(`
      const chip = visible('.agent-attachment-chip')[0];
      check(chip.textContent.includes('계약서.pdf') && chip.textContent.includes('PDF 2쪽'), 'Selection attachment names document and physical PDF page');
      check(chip.title.includes('Quoted payment term on page two.') && chip.title.includes('인용 위치: PDF 2쪽'), 'Quoted content includes page and selected text');
      click('.pdf-toolbar [title="이전 페이지"]');
    `)
    await wait("visible('.textLayer[data-pdf-page=" + '"1"' + "] span').length > 0", 'Navigate away from citation')
    await run(`click('.agent-attachment-chip')`)
    await wait("visible('.textLayer[data-pdf-page=" + '"2"' + "] span').length > 0", 'Citation returns to original page')
    await run(`check(visible('.pdf-page-input')[0].value === '2', 'Clicking attachment restores cited page after navigating away')`)
    await screenshot('pdf-citation-desktop')
    w.setSize(800, 800)
    await pause(250)
    await run(`
      const chip = visible('.agent-attachment-chip')[0].getBoundingClientRect();
      const remove = visible('.agent-attachment-remove-button')[0].getBoundingClientRect();
      check(chip.width > 0 && chip.right <= remove.left + 1 && remove.right <= innerWidth, 'Narrow citation attachment and remove button stay separate and visible');
    `)
    await screenshot('pdf-citation-narrow')
    w.setSize(1440, 1000)
    await pause(250)
    await run(`
      const textarea = visible('.agent-composer textarea')[0];
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    `)
    for (let i = 0; i < 100 && !calls.some((c) => c.channel === 'agent:send'); i++) await pause()
    const sent = calls.find((c) => c.channel === 'agent:send')?.args[0]?.input?.attachments?.[0]
    if (sent?.source?.range?.startPage !== 2 || sent?.source?.range?.endPage !== 2 || !sent.source.path.endsWith('/계약서.pdf')) throw Error(`Attachment source did not reach send: ${JSON.stringify(sent)}`)
    await run(`check(true, 'Agent send retains source path and page range')`)

    await add('fixture-b', '답변 대기 사건', '/synthetic/case-b')
    await add('fixture-c', '확인 완료 사건', '/synthetic/case-c')
    await status('fixture-a', 'waiting_user')
    await status('fixture-b', 'waiting_permission')
    await run('openCases()')
    await wait("document.querySelectorAll('.case-tab-row').length === 3", 'Three synthetic cases')
    await run(`
      check(document.querySelectorAll('.case-tab-row.has-question').length === 2, 'Two unresolved question cases');
      click('.case-tabs-filter input');
    `)
    await wait("document.querySelectorAll('.case-tab-row').length === 2", 'Only attention cases remain')
    await run(`
      check(!document.querySelector('.case-tabs-list').textContent.includes('확인 완료 사건'), 'Attention filter excludes quiet case');
      click('.case-tabs-filter button');
    `)
    await wait("!document.querySelector('.case-tabs-flyout')", 'Next attention navigates')
    await run(`
      check(visible('.agent-panel').length === 1, 'Next attention shows one target agent');
      window.firstTarget = visible('.agent-panel')[0].closest('[data-term-id]').dataset.termId;
      openCases();
    `)
    await wait("document.querySelectorAll('.case-tab-row.has-question').length === 2", 'First viewed question stays pending')
    await run(`
      check(document.querySelectorAll('.case-tab-row').length === 2, 'Attention filter survives opening a case');
      check(document.querySelectorAll('.case-tab-row.has-question').length === 2, 'Viewing question leaves both questions unresolved');
      click('.case-tabs-filter button');
    `)
    await wait("!document.querySelector('.case-tabs-flyout')", 'Next attention cycles')
    await run(`
      const target = visible('.agent-panel')[0].closest('[data-term-id]').dataset.termId;
      check(target !== window.firstTarget, 'Next attention moves to the other pending task');
      openCases();
    `)
    await wait("document.querySelectorAll('.case-tab-row.has-question').length === 2", 'Second viewed question stays pending')
    await screenshot('case-attention-desktop')
    w.setSize(800, 800)
    await pause(250)
    await run(`
      const panel = document.querySelector('.case-tabs-flyout').getBoundingClientRect();
      const label = document.querySelector('.case-tabs-filter label').getBoundingClientRect();
      const next = document.querySelector('.case-tabs-filter button').getBoundingClientRect();
      check(panel.left >= 0 && panel.right <= innerWidth, 'Narrow attention panel fits viewport');
      check(label.right <= next.left || label.bottom <= next.top || next.bottom <= label.top, 'Narrow filter and next button do not overlap');
    `)
    await screenshot('case-attention-narrow')
    await status('fixture-a', 'working')
    await wait("document.querySelectorAll('.case-tab-row.has-question').length === 1", 'Resumed task leaves pending filter')
    await status('fixture-b', 'idle')
    await wait("!!document.querySelector('.case-tabs-empty')", 'Resolved tasks leave empty attention view')
    await run(`check(document.querySelector('.case-tabs-empty').textContent.includes('확인이 필요한 작업 없음') && document.querySelector('.case-tabs-filter button').disabled, 'Empty attention view disables next action')`)
    await status('fixture-a', 'idle')
    await run(`
      click('.case-tabs-filter input');
      window.agentBeforeClose = visible('.agent-panel')[0].closest('[data-term-id]').dataset.termId;
    `)
    await wait("document.querySelectorAll('.case-tab-row').length === 3", 'All cases before closing')
    await run(`
      document.querySelector('.case-tab-row[title*="/synthetic/case-c"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    `)
    await wait("!!document.querySelector('.tab-context-menu-item[title^=" + '"이 사건탭"' + "]')", 'Background close menu')
    await run(`click('.tab-context-menu-item[title^="이 사건탭"]')`)
    await wait("document.querySelectorAll('.case-tab-row').length === 2", 'Background case closed')
    await run(`
      check(visible('.agent-panel')[0].closest('[data-term-id]').dataset.termId === window.agentBeforeClose, 'Closing a background case preserves the active work');
      click('.case-tab-row[title*="/synthetic/case-b"]');
    `)
    await wait("!document.querySelector('.case-tabs-flyout')", 'Select case B')
    await run('openCases()')
    await wait("!!document.querySelector('.case-tab-row.active')", 'Active case close menu ready')
    await run(`document.querySelector('.case-tab-row.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))`)
    await wait("!!document.querySelector('.tab-context-menu-item')", 'Active close menu')
    await run(`click('.tab-context-menu-item[title^="이 사건탭"]')`)
    await wait("visible('.agent-panel').length === 1 && visible('.agent-panel')[0].closest('[data-term-id]').dataset.termId === 'fixture-a'", 'Neighbor agent restored after menu close')
    await wait("visible('[data-doc-id=" + '"fixture-pdf"' + "]').length === 1", 'Neighbor document restored')
    await run(`check(visible('.welcome').length === 0, 'Closing an active case restores the remaining case instead of startup')`)
    w.webContents.send('app:closeActiveCaseTab')
    await wait("visible('.agent-panel').length === 0 && visible('[data-doc-id]').length === 0", 'Last case closes through shortcut handler')
    await run(`check(visible('.welcome').length === 0 && document.body.innerText.includes('왼쪽에 열린 탭이 없습니다'), 'Only closing the final case leaves an empty workspace')`)
    if (consoleErrors.length) throw new Error('Renderer console errors: ' + consoleErrors.join('\n'))
    const result = { checks: await run('return window.smokeChecks'), consoleErrors, screenshots: ['pdf-citation-desktop', 'pdf-citation-narrow', 'case-attention-desktop', 'case-attention-narrow'].map(name => path.join(output, name + '.png')) }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('TERMINAL_WORKFLOW_UI_RESULT ' + JSON.stringify(result))
    app.exit(0)
  } catch (error) {
    await screenshot('failure').catch(() => {})
    console.error(error)
    console.error(JSON.stringify({ consoleErrors, calls: [...new Set(calls.map(c => c.channel))] }))
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${electronCheck.toString()})(${JSON.stringify({ root, temp, output, channels, pdf: Buffer.from(pdf).toString('base64') })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error('UI smoke check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('TERMINAL_WORKFLOW_UI_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
