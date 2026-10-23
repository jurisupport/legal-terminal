// Run after npm run build. Real renderer, isolated profile, synthetic IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-panel-width-'))
const output = path.join(root, 'output/playwright/agent-panel-width')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function checkLayout({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const errors = [], results = []
  const longName = 'contract_'.repeat(20) + '.md'
  const failure = 'Request failed: ' + 'connection_details_'.repeat(30)
  const settings = { sshProfiles: [], notifyDone: false, agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Width fixture', homeDirectory: '/synthetic' }
    if (channel === 'app:generalChatDirectory') return ''
    if (channel === 'fs:readText') return { kind: 'text', ext: '.md', text: '# 계약서\n\n검토할 문서입니다.', size: 60, mtimeMs: 0 }
    if (channel === 'fs:stat') return { ok: true, isDir: !String(args[0]).endsWith('.md'), size: 60, mtimeMs: 0 }
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
    if (channel === 'agent:send') return { ok: false, error: failure }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  w.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const pause = () => new Promise(resolve => setTimeout(resolve, 60))
  const wait = async condition => {
    for (let i = 0; i < 120; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error('Timed out: ' + condition)
  }
  const setSize = async (width, height) => {
    w.setContentSize(width, height)
    await wait(`innerWidth === ${width} && innerHeight === ${height}`)
  }
  const capture = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage()).toPNG())
  }
  const measure = async name => {
    await pause()
    const result = await run(`
      const panel = document.querySelector('.agent-panel[data-visible=true]');
      const bounds = panel.getBoundingClientRect();
      const shell = document.querySelector('.shell');
      const children = [...panel.children].filter(el => el.getClientRects().length && getComputedStyle(el).position !== 'absolute' && getComputedStyle(el).position !== 'fixed');
      return { name: ${JSON.stringify(name)}, width: bounds.width,
        fitsWindow: bounds.left >= 0 && bounds.right <= innerWidth + 1 && shell.scrollWidth <= shell.clientWidth + 1,
        fitsPanel: panel.scrollWidth <= panel.clientWidth + 1 && children.every(el => {
          const r = el.getBoundingClientRect(); return r.left >= bounds.left - 1 && r.right <= bounds.right + 1;
        }),
        composerVisible: panel.querySelector('.agent-composer').getBoundingClientRect().right <= Math.min(innerWidth, bounds.right) + 1,
        columns: getComputedStyle(panel).gridTemplateColumns,
        overflow: children.filter(el => el.getBoundingClientRect().right > bounds.right + 1).map(el => el.className)
      };
    `)
    results.push(result)
    await capture(name)
  }
  const resize = async (selector, key, count) => {
    for (let i = 0; i < count; i++) {
      await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)
    }
    await pause()
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-sidebar-trigger')")
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'width-agent', kind: 'agent', agentProvider: 'claude', title: '패널 너비 검증', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait("!!document.querySelector('.agent-panel[data-visible=true] .agent-composer')")
    w.webContents.send('agent:event', { type: 'auth:status', sessionId: 'width-agent', state: 'authenticated' })
    await measure('baseline')
    await resize('.pane-resizer-work', 'ArrowRight', 60)
    await measure('resized')
    await setSize(1280, 900)
    await pause()
    await measure('window-shrunk')
    await setSize(1440, 960)
    await pause()
    await resize('.pane-resizer-work', 'ArrowLeft', 60)
    await resize('.pane-resizer-side', 'ArrowRight', 60)
    await setSize(1280, 900)
    await pause()
    await measure('wide-sidebar-shrunk')
    await resize('.pane-resizer-side', 'ArrowLeft', 80)
    await run(`document.querySelector('.activity-item[title^="탐색기"]').click()`)
    await wait("document.querySelector('.shell').classList.contains('explorer-hidden')")
    await resize('.pane-resizer-work', 'ArrowRight', 80)
    await run(`document.querySelector('.activity-item[title^="탐색기"]').click()`)
    await wait("!!document.querySelector('.pane-resizer-side')")
    await measure('explorer-restored')
    await resize('.pane-resizer-work', 'ArrowRight', 80)
    await run(`document.querySelector('.activity-item[title^="기록뷰어"]').click()`)
    await wait("!!document.querySelector('.pane-resizer-evidence')")
    await measure('evidence-opened')
    await resize('.pane-resizer-work', 'ArrowLeft', 80)
    await resize('.pane-resizer-evidence', 'ArrowRight', 80)
    await setSize(1100, 900)
    await pause()
    await measure('wide-evidence-shrunk')
    await run(`document.querySelector('.activity-item[title^="탐색기"]').click()`)
    await wait("!document.querySelector('.pane-resizer-evidence')")
    await setSize(1280, 900)
    await pause()
    await resize('.pane-resizer-work', 'ArrowRight', 80)
    w.webContents.send('tabs:receive', { kind: 'document', tab: { id: 'width-doc', kind: 'mdview', title: longName, path: '/synthetic/' + longName, side: 'left' } })
    await wait("!!document.querySelector('.agent-document-link')")
    await measure('long-document')
    const response = '표와 코드가 패널 안에서 스크롤되어야 합니다.\n\n| 문서 | 내용 |\n| --- | --- |\n| ' + longName + ' | ' + longName + ' |\n\n```text\n' + 'long_code_'.repeat(80) + '\n```'
    for (const event of [{ type: 'message:assistant_start' }, { type: 'message:assistant_delta', text: response }]) {
      w.webContents.send('agent:event', { sessionId: 'width-agent', messageId: 'width-answer', ...event })
    }
    await wait("!!document.querySelector('.agent-code-block pre')")
    await measure('streaming-table-code')
    w.webContents.send('agent:event', { sessionId: 'width-agent', messageId: 'width-answer', type: 'message:assistant_done' })
    await measure('completed-table-code')
    const codeScrolls = await run(`const code = document.querySelector('.agent-code-block pre'); code.scrollLeft = 100; return code.scrollWidth > code.clientWidth && code.scrollLeft > 0`)
    if (!codeScrolls) errors.push('Long code must remain horizontally scrollable')
    await run(`const input = document.querySelector('.agent-panel[data-visible=true] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '오류 표시 검증');
      input.dispatchEvent(new Event('input', { bubbles: true }));`)
    await pause()
    await run(`document.querySelector('.agent-panel[data-visible=true] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await wait("!!document.querySelector('.agent-panel > .agent-error')")
    await measure('long-error')
    await setSize(1920, 900)
    await resize('.pane-resizer-work', 'ArrowLeft', 100)
    await resize('.pane-resizer-work', 'ArrowRight', 12)
    await resize('.pane-resizer-side', 'ArrowRight', 100)
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'width-general', kind: 'agent', agentProvider: 'claude', contextKind: 'global', title: '왼쪽 일반 대화', cwd: '/synthetic/legal-terminal-general', side: 'left', createdAt: Date.now() } })
    await wait("document.querySelector('.shell').classList.contains('general-chat-left')")
    await setSize(1280, 900)
    await measure('left-general-chat-shrunk')
    if (results.at(-1).width < 220) errors.push('Unified conversation must retain the minimum working width')

    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, errors }, null, 2))
    console.log(JSON.stringify({ results, errors }))
    app.exit(errors.length || results.some(result => !result.fitsWindow || !result.fitsPanel || !result.composerVisible) ? 1 : 0)
  } catch (error) {
    await capture('failure').catch(() => {})
    console.error(error)
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${checkLayout.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Panel width check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
