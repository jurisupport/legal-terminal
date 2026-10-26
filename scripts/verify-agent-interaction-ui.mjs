// Run after npm run build. Real renderer, isolated profile, synthetic IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-interaction-'))
const output = path.join(root, 'output/playwright/agent-interaction')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function checkInteraction({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const errors = [], answers = []
  let markRendererReady
  const rendererReady = new Promise(resolve => { markRendererReady = resolve })
  const settings = { sshProfiles: [], notifyDone: false, agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    if (channel === 'tabs:ready') { markRendererReady(); return }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Interaction fixture', homeDirectory: '/synthetic' }
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
    if (channel === 'agent:answerDialog') {
      answers.push(args[0])
      w.webContents.send('agent:event', { type: 'dialog:resolved', ...args[0] })
      w.webContents.send('agent:event', { type: 'status', sessionId: args[0].sessionId, status: 'working' })
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
  const pause = () => new Promise(resolve => setTimeout(resolve, 60))
  const wait = async condition => {
    for (let i = 0; i < 120; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error('Timed out: ' + condition)
  }
  const check = (value, message) => { if (!value) throw Error(message) }
  const capture = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const bounds = await run("const r = document.querySelector('.agent-panel[data-visible=true]').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }")
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage(bounds)).toPNG())
  }
  const send = event => w.webContents.send('agent:event', { sessionId: 'interaction-agent', ...event })
  const question = (dialogId, multiSelect = false, count = 1) => {
    send({ type: 'dialog:request', dialog: { dialogId, title: '검토 방향', questions: Array.from({ length: count }, (_, index) => ({
      id: `q-${index}`, header: index ? '출력 형식' : '검토 범위', question: index ? '어떤 형식으로 정리할까요?' : '어떤 범위로 검토할까요?', multiSelect,
      options: [{ id: 'summary', label: '핵심 쟁점 먼저', description: '주요 쟁점과 확인할 자료를 간결하게 정리합니다.' },
        { id: 'detail', label: '전체 기록 검토', description: '기록 전체를 읽고 쟁점별 근거를 정리합니다.' }]
    })) } })
    send({ type: 'status', status: 'waiting_user' })
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await rendererReady
    await wait("!!document.querySelector('.case-sidebar-trigger')")
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'interaction-agent', kind: 'agent', agentProvider: 'claude', title: '에이전트 표시 검증', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait("!!document.querySelector('.agent-panel[data-visible=true] .agent-composer')")
    send({ type: 'auth:status', state: 'authenticated' })
    send({ type: 'message:user', messageId: 'user', text: '기록을 검토하고 필요한 사항은 선택지로 물어봐 주세요.' })
    send({ type: 'status', status: 'working' })
    await wait("!!document.querySelector('.agent-status-line.working')")
    await capture('thinking')
    question('single')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await capture('question')
    check(await run("return !!document.querySelector('.agent-status-indicator svg')"), 'active work needs a visible thinking indicator')
    check(await run("return !!document.querySelector('.agent-status-jump')"), 'pending choices need a shortcut outside the scrolling conversation')
    await run("document.querySelector('.agent-option').click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[0].answers['어떤 범위로 검토할까요?'] === '핵심 쟁점 먼저', 'single choice must submit immediately')
    check(await run("return document.querySelector('.agent-option').getAttribute('aria-pressed') === 'true'"), 'resolved choices must retain their selected appearance')

    // Multiple questions collect all answers; multiple selection waits for explicit send.
    question('multiple-questions', false, 2)
    await wait("document.querySelectorAll('.agent-card.dialog.waiting .agent-question').length === 2")
    await run("document.querySelector('.agent-card.dialog.waiting .agent-option').click()")
    check(answers.length === 1, 'an incomplete multi-question answer must not submit')
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-question')[1].querySelectorAll('.agent-option')[1].click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(Object.keys(answers[1].answers).length === 2, 'all question answers must be delivered')
    question('multi-select', true)
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-option').forEach(button => button.click())")
    check(answers.length === 2, 'multiple selection must wait for send')
    await run("document.querySelector('.agent-card.dialog.waiting .agent-dialog-actions button').click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[2].answers['어떤 범위로 검토할까요?'] === '핵심 쟁점 먼저, 전체 기록 검토', 'all selected choices must be delivered')
    question('freeform')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run(`const input = document.querySelector('.agent-card.dialog.waiting input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '입증 자료부터 정리해 주세요.');
      input.dispatchEvent(new Event('input', { bubbles: true }));`)
    await pause()
    await run("document.querySelector('.agent-card.dialog.waiting input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))")
    check(answers.length === 3, 'Korean IME composition must not submit')
    await run("document.querySelector('.agent-card.dialog.waiting input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[3].response === '입증 자료부터 정리해 주세요.', 'freeform answer must be delivered')
    question('cancel')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-dialog-actions button')[1].click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[4].cancelled === true, 'cancel must preserve the dialog cancellation path')
    send({ type: 'status', status: 'done' })
    await wait("!document.querySelector('.agent-status-line')")
    send({ type: 'status', status: 'working' })
    await wait("!!document.querySelector('.agent-status-line.working')")
    check(await run("return document.querySelector('.agent-status-text').textContent.includes('생각 중')"), 'working without a running tool shows thinking')
    send({ type: 'tool:start', toolId: 'read', name: 'Read', inputPreview: '{"file_path":"/synthetic/기록.pdf"}' })
    await wait("document.querySelector('.agent-status-text').textContent.includes('도구 실행 중')")
    send({ type: 'tool:done', toolId: 'read', outputPreview: '자료 확인 완료' })
    send({ type: 'message:assistant_delta', messageId: 'reply', text: '검토할 자료를 확인했습니다.' })
    await wait("document.querySelector('.agent-status-text').textContent.includes('답변 작성 중')")
    send({ type: 'message:assistant_done', messageId: 'reply' })
    question('narrow', true)
    w.setContentSize(900, 760)
    await wait('innerWidth === 900')
    check(await run("const p = document.querySelector('.agent-panel[data-visible=true]'); return p.scrollWidth <= p.clientWidth + 1"), 'narrow panels must not overflow')
    await run("document.querySelector('.agent-timeline').scrollTop = 0; document.querySelector('.agent-status-jump').click()")
    await wait("(() => { const r = document.querySelector('.agent-card.dialog.waiting').getBoundingClientRect(); const p = document.querySelector('.agent-timeline').getBoundingClientRect(); return r.bottom <= p.bottom + 1 && r.top >= p.top - 1 })()")
    check(await run("return document.querySelector('.agent-card.dialog.waiting .agent-option') === document.activeElement"), 'jump must focus the first choice')
    await capture('narrow-question')
    send({ type: 'status', status: 'error' })
    await wait("!document.querySelector('.agent-status-line')")
    check(errors.length === 0, errors.join('\n'))
    console.log('Agent interaction: thinking/tool/response states, choices, freeform, IME, cancel, jump, narrow layout passed')
    app.exit(0)
  } catch (error) {
    await capture('failure').catch(() => {})
    console.error(error)
    app.exit(1)
  }
}
await fs.writeFile(path.join(temp, 'main.cjs'), `(${checkInteraction.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Agent interaction check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
