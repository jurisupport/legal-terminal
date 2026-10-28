// Run after npm run build. Real renderer, isolated profile, synthetic IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-queue-'))
const output = path.join(root, 'output/playwright/agent-queue')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function checkQueue({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const errors = [], calls = []
  let markRendererReady
  const rendererReady = new Promise(resolve => { markRendererReady = resolve })
  const settings = { sshProfiles: [], notifyDone: false, agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'tabs:ready') { markRendererReady(); return }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Queue fixture', homeDirectory: '/synthetic' }
    if (channel === 'app:generalChatDirectory') return ''
    if (channel === 'fs:readText') return { kind: 'text', ext: '.md', text: '# 계약서\n\n검토할 문서입니다.', size: 60, mtimeMs: 0 }
    if (channel === 'fs:stat') return { ok: true, isDir: !/\.(md|mp4)$/.test(String(args[0])), size: 60, mtimeMs: 0 }
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
    if (channel === 'agent:promoteQueued' || channel === 'agent:removeQueued') {
      w.webContents.send('agent:event', { type: channel === 'agent:promoteQueued' ? 'queue:promoted' : 'queue:removed', ...args[0] })
      return { ok: true }
    }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  w.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async condition => {
    for (let i = 0; i < 120; i++) {
      if (await run(`return (${condition})`)) return
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    throw Error('Timed out: ' + condition)
  }
  const check = (value, message) => { if (!value) throw Error(message) }
  const capture = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const bounds = await run("const r = document.querySelector('.agent-panel[data-visible=true]').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }")
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage(bounds)).toPNG())
  }
  const send = event => w.webContents.send('agent:event', { sessionId: 'queue-agent', ...event })
  const longText = '계약서에서 손해배상 조항과 해지 사유를 검토해 주세요.\n'.repeat(18) + '끝까지 보이는 지시 내용'
  const queue = (queueId, text, extra = {}) => send({ type: 'queue:added', queueId, text, delivery: 'queue', ...extra })
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await rendererReady
    await wait("!!document.querySelector('.case-sidebar-trigger')")
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'queue-agent', kind: 'agent', agentProvider: 'claude', title: '대기 중인 지시', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait("!!document.querySelector('.agent-panel[data-visible=true] .agent-composer')")
    await run("window.queueCopies = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.queueCopies.push(text) } } })")
    send({ type: 'auth:status', state: 'authenticated' })
    send({ type: 'message:user', messageId: 'initial-user', text: '계약서를 검토해 주세요.' })
    send({ type: 'message:assistant_delta', messageId: 'original-answer', text: '해지 사유와 손해배상 조항을 확인하겠습니다.' })
    send({ type: 'message:assistant_done', messageId: 'original-answer' })
    send({ type: 'status', status: 'working' })
    queue('first', longText, {
      quote: { messageId: 'original-answer', preview: '해지 사유와 손해배상 조항' },
      attachments: [
        { kind: 'file', label: '계약서.md', path: '/synthetic/계약서.md', source: { path: '/synthetic/계약서.md' } },
        { kind: 'file', label: '회의.mp4', path: '/synthetic/회의.mp4' }
      ]
    })
    queue('second', '검토한 쟁점을 표로 정리해 주세요.')
    queue('third', '추가 확인이 필요한 자료 목록도 만들어 주세요.')
    await wait("document.querySelectorAll('.agent-queue-item').length === 3")
    check(await run("return Array.from(document.querySelectorAll('.agent-queue-item')).every(row => row.tagName === 'DETAILS' && !row.open)"), 'queued instructions must default to collapsed disclosures')
    check(await run("const list = document.querySelector('.agent-queue-list'); return list.parentElement.classList.contains('agent-prompt') && list.nextElementSibling.classList.contains('agent-composer') && !document.querySelector('.agent-timeline .agent-card.queue, .agent-timeline .agent-queue-item')"), 'waiting instructions belong directly above the composer, outside the timeline')
    check(await run("return Array.from(document.querySelectorAll('.agent-queue-preview')).every(el => { const s = getComputedStyle(el); return s.whiteSpace === 'nowrap' && s.textOverflow === 'ellipsis' && el.getBoundingClientRect().height < 30 })"), 'each collapsed instruction must occupy one ellipsized text line')
    check(await run("return Array.from(document.querySelectorAll('.agent-queue-number')).map(el => el.textContent).join(',') === '1,2,3'"), 'queued rows retain their ordinal labels')
    await capture('collapsed')

    await run("document.querySelector('.agent-queue-item summary').click()")
    await wait("document.querySelector('.agent-queue-item').open")
    check(await run(`return document.querySelector('.agent-queue-detail pre').textContent === ${JSON.stringify(longText)}`), 'expanded instructions must preserve text beyond 360 characters and line breaks')
    check(await run("return document.querySelector('.agent-queue-detail .agent-quote-preview').textContent === '해지 사유와 손해배상 조항' && document.querySelectorAll('.agent-queue-detail .agent-attachment-chip').length === 2 && !!document.querySelector('.agent-queue-detail .agent-media-preview[data-media-path=\"/synthetic/회의.mp4\"]')"), 'expanded instructions retain quotes, attachment controls and media previews')
    await capture('expanded')
    await run("Array.from(document.querySelector('.agent-queue-item').querySelectorAll('.agent-queue-actions button')).find(el => el.textContent === '복사').click()")
    await wait('window.queueCopies.length === 1')
    check(await run(`return window.queueCopies[0] === ${JSON.stringify(longText)}`), 'copy must include the entire queued instruction')
    await run("document.querySelector('.agent-queue-detail .agent-attachment-chip:not(:disabled)').click()")
    await wait("!!document.querySelector('.cm-editor')")
    check(calls.some(call => call.channel === 'fs:readText' && call.args[0] === '/synthetic/계약서.md'), 'attachment source opens the existing document path')

    await run("document.querySelector('.agent-queue-item summary').focus()")
    check(await run("return document.activeElement === document.querySelector('.agent-queue-item summary')"), 'queue disclosures are keyboard focusable')
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await wait("!document.querySelector('.agent-queue-item').open")
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await wait("document.querySelector('.agent-queue-item').open")
    await run("Array.from(document.querySelector('.agent-queue-item').querySelectorAll('.agent-queue-actions button')).find(el => el.textContent === '바로 지시하기').click()")
    await wait("document.querySelector('.agent-queue-item summary').textContent.includes('바로 지시 대기')")
    check(calls.some(call => call.channel === 'agent:promoteQueued' && call.args[0].sessionId === 'queue-agent' && call.args[0].queueId === 'first'), 'promote must target the existing queued instruction')
    await run("document.querySelector('.agent-queue-item summary').click(); document.querySelectorAll('.agent-queue-item summary')[1].click(); document.querySelectorAll('.agent-queue-item')[1].querySelector('.agent-queue-actions .danger').click()")
    await wait("document.querySelectorAll('.agent-queue-item').length === 2")
    check(calls.some(call => call.channel === 'agent:removeQueued' && call.args[0].sessionId === 'queue-agent' && call.args[0].queueId === 'second'), 'delete must target the selected queued instruction')
    send({ type: 'queue:started', queueId: 'first' })
    await wait("document.querySelectorAll('.agent-queue-item').length === 1")
    send({ type: 'queue:cleared', queueIds: ['third'] })
    await wait("!document.querySelector('.agent-queue-list')")

    for (let index = 0; index < 16; index++) queue(`many-${index}`, `${index + 1}번째 후속 검토 지시: ` + '긴 지시 내용을 확인하고 기록을 정리해 주세요. '.repeat(5))
    await wait("document.querySelectorAll('.agent-queue-item').length === 16")
    w.setContentSize(900, 760)
    await wait('innerWidth === 900')
    check(await run("const p = document.querySelector('.agent-panel[data-visible=true]'); const list = p.querySelector('.agent-queue-list'); const composer = p.querySelector('.agent-composer').getBoundingClientRect(); const r = list.getBoundingClientRect(); return p.scrollWidth <= p.clientWidth + 1 && list.scrollHeight > list.clientHeight && r.height <= Math.min(innerHeight * 0.3, 240) + 1 && composer.top >= r.bottom - 1 && composer.bottom <= innerHeight"), 'many queued rows scroll within a bounded list and leave the narrow composer visible')
    await capture('narrow-many')
    await run("document.querySelector('.agent-queue-list').scrollTop = 99999")
    check(await run("const list = document.querySelector('.agent-queue-list'); const last = list.lastElementChild.getBoundingClientRect(); return list.scrollTop > 0 && last.bottom <= list.getBoundingClientRect().bottom + 1"), 'the last waiting instruction remains reachable by scrolling')
    await capture('narrow-last')
    send({ type: 'queue:cleared', queueIds: Array.from({ length: 16 }, (_, index) => `many-${index}`) })
    await wait("!document.querySelector('.agent-queue-list')")
    check(errors.length === 0, errors.join('\n'))
    console.log('Agent queue UI: collapsed rows, composer placement, full details/copy, attachments, keyboard disclosure, promote/delete IPC, lifecycle removal and narrow scrolling passed')
    app.exit(0)
  } catch (error) {
    await capture('failure').catch(() => {})
    console.error(error)
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${checkQueue.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Agent queue check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
