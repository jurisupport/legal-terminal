import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-app-'))
const chosenDir = path.join(temp, 'existing-work')
const screenshot = path.join(root, '.omx/screenshots/todo-app.png')
await fs.mkdir(chosenDir)
await fs.writeFile(path.join(chosenDir, 'existing.txt'), 'Synthetic existing folder; the app must not create a new work folder.\n')
await fs.mkdir(path.dirname(screenshot), { recursive: true })
await fs.access(path.join(root, 'out/main/index.js'))

function runApp({ root, temp, chosenDir, screenshot }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const assert = require('node:assert/strict')
  const calls = [], rendererErrors = [], unexpected = [], sessions = new Map()
  const rows = [
    { id: 'overdue', type: 'todo', title: '통합 검증 도과 할일', status: 'pending', dueDate: '2020-01-01', createdAt: '2019-01-01', version: 1 },
    { id: 'undated', type: 'todo', title: '통합 검증 기한 없는 할일', status: 'in_progress', createdAt: '2020-01-01', updatedAt: '2020-01-01', version: 1 },
    { id: 'review', type: 'todo', title: '통합 검증 재확인 할일', status: 'pending', dueDate: '2099-01-01', reviewAt: '2020-01-01', createdAt: '2020-01-01', version: 1 }
  ]
  const home = require('node:path').join(temp, 'home')
  fs.mkdirSync(home, { recursive: true })
  require('node:os').homedir = () => home
  app.setPath('home', home)
  let releaseGeneralChat
  const generalChatReady = new Promise(resolve => { releaseGeneralChat = resolve })
  const settings = { draftsRoot: chosenDir, sshProfiles: [], agentDefaultProvider: 'codex', agentDefaultPermissionMode: 'ask', notifyDone: false }
  app.setPath('userData', require('node:path').join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('Smoke test blocked external fetch') }
  const register = ipcMain.handle.bind(ipcMain)
  const originalOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => originalOn(channel, channel === 'fs:watch' || channel.startsWith('pty:') ? () => {} : callback)
  const realChannels = new Set(['app:generalChatDirectory', 'app:info', 'app:setWindowTitle', 'tabs:ready', 'workspace:save', 'workspace:list', 'workspace:load', 'caseManagement:get', 'caseManagement:update'])
  ipcMain.handle = (channel, handler) => register(channel, async (event, ...args) => {
    const call = { channel, args }
    calls.push(call)
    // Opening todos during startup must win over the later general-chat directory response.
    if (channel === 'app:generalChatDirectory') await generalChatReady
    if (realChannels.has(channel)) {
      const result = await handler(event, ...args)
      call.result = result
      return result
    }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return settings
    if (channel === 'settings:set') return Object.assign(settings, args[0])
    if (channel === 'ssh:listDir') {
      const { profile, path: requestedPath } = args[0]
      if (profile.id === 'remote-error') return { ok: false, error: '합성 원격 경로 조회 실패' }
      return { ok: true, entries: [], cwd: `/home/${profile.id}${requestedPath === '~' ? '' : '/drafts'}` }
    }
    if (channel === 'js:hasToken') return true
    if (channel === 'js:tokenStatus') return { hasToken: true, error: null }
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:upcomingHearings') {
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
      const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10)
      return { ok: true, complete: true, fetchedAt: new Date().toISOString(), hearings: Array.from({ length: 42 }, (_, index) => ({ id: `hearing-${index}`, dateTime: `${index < 27 ? today : tomorrow}T10:00:00+09:00`, type: '변론', status: 'scheduled', case: { id: `case-${index}`, caseName: `합성 사건 ${index}`, parties: [], hearings: [] } })) }
    }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 27, weekCount: 42, fetchedAt: new Date().toISOString() } }
    if (channel === 'todo:list') return { ok: true, todos: args[0]?.type === 'memo' ? [] : rows }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: { queryFields: ['fields', 'includeClosed'], createFields: ['reviewAt', 'priority', 'parentId'], updateFields: ['reviewAt', 'priority', 'parentId', 'evidence'], statusFields: ['childDispositions'], evidenceSuggestions: true } }
    if (channel === 'dialog:pickFolder') return { path: chosenDir, name: 'existing-work' }
    if (channel === 'dialog:message') return true
    if (channel === 'case:history' || channel === 'fs:list' || channel === 'fs:listPdfs' || channel === 'sessions:list') return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'sessions:current' || channel === 'case:getPairing' || channel === 'case:getJsPairing') return null
    if (channel === 'case:addHistory') return []
    if (channel === 'sessions:remember') return undefined
    if (channel === 'workspace:autoLoad') return { ok: true }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoSave') return { ok: true, savedAt: new Date().toISOString() }
    if (channel === 'agent:create') {
      const options = args[0]
      sessions.set(options.id, options)
      setTimeout(() => {
        if (event.sender.isDestroyed()) return
        event.sender.send('agent:event', { type: 'auth:status', sessionId: options.id, state: 'authenticated' })
        event.sender.send('agent:event', { type: 'status', sessionId: options.id, status: 'idle' })
      }, 30)
      return { ok: true, sessionId: options.id }
    }
    if (channel === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [{ id: 'synthetic', model: 'synthetic', displayName: '검증용 모델', isDefault: true }] }
    if (channel === 'agent:send') {
      if (args[0].input.text.includes('도과 할일 완료')) {
        rows[0].status = 'completed'
        event.sender.send('agent:event', { type:'status', sessionId:args[0].sessionId, status:'working' })
        event.sender.send('agent:event', { type:'process:event', sessionId:args[0].sessionId, processId:'managed-write-1', title:'할일 상태 변경', toolName:'mcp__legal_terminal_jurisupport__update_task_status', status:'completed' })
        event.sender.send('agent:event', { type:'status', sessionId:args[0].sessionId, status:'done' })
      }
      return { ok: true }
    }
    if (channel === 'agent:close') return {ok:true}
    if (channel === 'fs:mkdir' || channel.startsWith('pty:')) throw Error(`Forbidden smoke-test side effect: ${channel}`)
    unexpected.push(channel)
    throw Error(`Unmocked smoke-test IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })))
  let win
  const windowReady = new Promise((resolve) => app.once('browser-window-created', (_event, window) => {
    win = window
    window.setSize(1440, 1000)
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') rendererErrors.push(details.message)
    })
    window.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer exited: ${details.reason}`))
    window.webContents.once('did-finish-load', resolve)
  }))
  require(require('node:path').join(root, 'out/main/index.js'))
  const wait = async (check, label) => { for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)) } throw Error(`Timed out: ${label}`) }
  const evaluate = (source) => win.webContents.executeJavaScript(source, true)
  const capture = async () => { if (win && !win.isDestroyed()) fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG()) }
  ;(async () => {
    try {
      await windowReady
      await evaluate(`window.smoke = {
        check(condition, message) { if (!condition) throw Error(message) },
        click(selector) { const button = document.querySelector(selector); if (!button || button.disabled) throw Error('Missing/disabled: ' + selector); button.click() },
        textButton(label, root = document) { const button = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === label); if (!button || button.disabled) throw Error('Missing/disabled button: ' + label); button.click() }
      }; window.addEventListener('error', event => console.error('SMOKE_RUNTIME_ERROR: '+event.message)); window.addEventListener('unhandledrejection', event => console.error('SMOKE_REJECTION: '+event.reason));`)
      await wait(() => evaluate(`!!document.querySelector('.welcome .todo-summary') && document.querySelector('.workspace-todo-header')?.textContent.includes('기한 도과 1')`), 'Welcome summary and permanent header')
      await capture()
      await wait(() => evaluate(`Array.from(document.querySelectorAll('.welcome .todo-metric strong')).some(node => node.textContent === '27')`), 'Complete hearing aggregate ready')
      await evaluate(`smoke.check(Array.from(document.querySelectorAll('.welcome .todo-metric strong')).some(node => node.textContent === '27'), 'Today count is independent of case/list caps'); smoke.check(Array.from(document.querySelectorAll('.welcome .todo-metric strong')).some(node => node.textContent === '42'), 'Seven-day count is complete')`)
      await evaluate(`smoke.check(document.querySelector('.welcome .todo-summary').textContent.includes('통합 검증 도과 할일'), 'Welcome overdue item'); smoke.click('.workspace-todo-header .header-btn')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 1 && document.querySelector('.todo-card').textContent.includes('통합 검증 도과 할일')`), 'Header opens overdue filter')
      releaseGeneralChat()
      await wait(() => calls.some(call => call.channel === 'app:generalChatDirectory' && typeof call.result === 'string'), 'General chat directory resolves inside the isolated home')
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      assert.equal(await evaluate(`document.querySelector('.activity-item[title="할일"]')?.getAttribute('aria-pressed')`), 'true', 'Late general-chat initialization preserves the requested todo view')
      await evaluate(`smoke.textButton('기한 없음')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 1 && document.querySelector('.todo-card').textContent.includes('통합 검증 기한 없는 할일')`), 'Undated filter')
      await evaluate(`smoke.textButton('전체 열린 할일')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 3`), 'All open todos')
      const checkRemovedActions = async () => {
        assert.equal(await evaluate(`!!document.querySelector('.project-open-button, .projects-dashboard')`), false, 'Project management is absent')
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(button => /전체 할일 정리|에이전트로 정리/.test(button.textContent))`), false, 'Todo AI actions are absent')
        assert.equal(calls.filter(call => call.channel === 'agent:create').length, 0, 'Opening todos does not start an AI agent')
        assert.equal(calls.some(call => call.channel.startsWith('projects:')), false, 'Navigation does not load projects')
      }
      await checkRemovedActions()
      await evaluate(`smoke.click('.activity-item[title="사건"]')`)
      await wait(() => evaluate(`!!document.querySelector('.cases-dashboard') || document.querySelector('.activity-item[title="사건"]')?.getAttribute('aria-pressed') === 'true'`), 'Cases remain accessible')
      await checkRemovedActions()
      await evaluate(`smoke.click('.activity-item[title="할일"]')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 1`), 'Todo dashboard restores the summary filter')
      await evaluate(`smoke.textButton('전체 열린 할일')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 3`), 'Todo dashboard remains accessible')
      await checkRemovedActions()
      assert.equal(calls.some(call => call.channel === 'fs:mkdir'), false)
      assert.deepEqual(fs.readdirSync(chosenDir), ['existing.txt'])
      assert.deepEqual([...new Set(unexpected)], [])
      assert.deepEqual(rendererErrors, [])
      await capture()
      console.log('TODO_APP_RESULT ' + JSON.stringify({ summaryAndFilters: true, removedActions: true, noAutomaticAgent: true, ipcCalls: calls.length, rendererErrors, screenshot }))
      app.exit(0)
    } catch (error) {
      await capture()
      console.error(error)
      console.error('TODO_APP_DEBUG ' + JSON.stringify({ unexpected, rendererErrors, calls: calls.map(({ channel }) => channel), dom: win ? await evaluate('document.body.innerText').catch(() => '') : '' }))
      app.exit(1)
    }
  })()
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, chosenDir, screenshot })})`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.LEGAL_TERMINAL_CHECK_UPDATE_IN_DEV
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs'), `--user-data-dir=${path.join(temp, 'profile')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, output }))
    setTimeout(() => { child.kill(); reject(Error(`App smoke timeout\n${output}`)) }, 45000).unref()
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter((line) => line.includes('TODO_APP_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
