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
  const settings = { draftsRoot: chosenDir, sshProfiles: [], agentDefaultProvider: 'codex', agentDefaultPermissionMode: 'ask', notifyDone: false }
  app.setPath('userData', require('node:path').join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('Smoke test blocked external fetch') }
  const register = ipcMain.handle.bind(ipcMain)
  const originalOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => originalOn(channel, channel === 'fs:watch' || channel.startsWith('pty:') ? () => {} : callback)
  const realChannels = new Set(['app:info', 'app:setWindowTitle', 'tabs:ready', 'workspace:save', 'workspace:list', 'workspace:load'])
  ipcMain.handle = (channel, handler) => register(channel, async (event, ...args) => {
    const call = { channel, args }
    calls.push(call)
    if (realChannels.has(channel)) {
      const result = await handler(event, ...args)
      call.result = result
      return result
    }
    if (channel === 'settings:get') return settings
    if (channel === 'settings:set') return Object.assign(settings, args[0])
    if (channel === 'js:hasToken') return true
    if (channel === 'js:tokenStatus') return { hasToken: true, error: null }
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 27, weekCount: 42, fetchedAt: new Date().toISOString() } }
    if (channel === 'todo:list') return { ok: true, todos: args[0]?.type === 'memo' ? [] : rows }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: { queryFields: ['fields', 'includeClosed'], createFields: ['reviewAt', 'priority', 'parentId'], updateFields: ['reviewAt', 'priority', 'parentId', 'evidence'], statusFields: ['childDispositions'], evidenceSuggestions: true } }
    if (channel === 'dialog:pickFolder') return { path: chosenDir, name: 'existing-work' }
    if (channel === 'dialog:message') return true
    if (channel === 'case:history' || channel === 'fs:list' || channel === 'fs:listPdfs' || channel === 'sessions:list') return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'sessions:current' || channel === 'case:getPairing' || channel === 'case:getJsPairing') return null
    if (channel === 'case:addHistory' || channel === 'sessions:remember') return undefined
    if (channel === 'workspace:autoLoad') return { ok: true }
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
      await evaluate(`smoke.textButton('기한 없음')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 1 && document.querySelector('.todo-card').textContent.includes('통합 검증 기한 없는 할일')`), 'Undated filter')
      await evaluate(`smoke.textButton('전체 열린 할일')`)
      await wait(() => evaluate(`document.querySelectorAll('.todo-card').length === 3`), 'All open todos')
      await evaluate(`smoke.textButton('전체 할일 정리 시작')`)
      await wait(() => calls.some((call) => call.channel === 'agent:create'), 'Global Agent creation')
      const created = calls.find((call) => call.channel === 'agent:create').args[0]
      assert.equal(created.cwd, chosenDir)
      assert.equal(created.workspaceContext?.kind, 'global')
      assert.equal(created.workspaceContext?.todoManagement, true)
      assert.equal(calls.filter(call => call.channel === 'agent:create').length, 1, 'task view and open button reuse the same right agent')
      assert.match(created.context, /"contextKind": "global"/)
      assert.equal(calls.filter((call) => call.channel === 'dialog:pickFolder').length, 0)
      assert.equal(calls.some((call) => call.channel === 'fs:mkdir'), false)
      assert.deepEqual(fs.readdirSync(chosenDir), ['existing.txt'])
      await evaluate(`smoke.textButton('오른쪽 에이전트로 정리')`)
      await wait(() => evaluate(`document.querySelector('.agent-composer textarea')?.value.includes('첨부한 선택 할일')`), 'Selected tasks reach right composer')
      await wait(() => evaluate(`!!document.querySelector('.agent-send-btn:not([disabled])')`), 'Global prompt ready')
      await evaluate(`smoke.check(document.querySelector('.workspace-todo-header').textContent.includes('기한 도과 1'), 'Header remains after global task'); smoke.click('.agent-send-btn')`)
      await wait(() => calls.some((call) => call.channel === 'agent:send'), 'Global Agent send')
      const sent = calls.find((call) => call.channel === 'agent:send').args[0]
      assert.equal(sent.input.workspaceContext?.kind, 'global')
      assert.match(sent.input.text, /첨부한 선택 할일/)
      assert.equal(sent.input.workspaceContext.todoManagement, true)
      assert.equal(sent.input.attachments.length, 1)
      const selected = JSON.parse(sent.input.attachments[0].text.match(/<selected-tasks>(.*)<\/selected-tasks>/s)[1])
      assert.deepEqual([...selected.taskIds].sort(), ['overdue','review','undated'])
      assert.equal(calls.filter(call => call.channel === 'agent:create').length, 1)
      await evaluate(`smoke.click('button[title="현재 작업환경 저장"]')`)
      await wait(() => calls.some((call) => call.channel === 'workspace:save' && call.result?.ok), 'Actual workspace save')
      const saved = calls.find((call) => call.channel === 'workspace:save').result
      assert.ok(saved.path.startsWith(app.getPath('userData')))
      const snapshot = JSON.parse(fs.readFileSync(saved.path, 'utf8'))
      assert.equal(snapshot.terminals[0].contextKind, 'global')
      assert.equal(snapshot.terminals[0].todoManagement, true)
      assert.equal(snapshot.terminals[0].cwd, chosenDir)
      assert.equal(snapshot.caseTabs[0].meta.contextKind, 'global')
      const beforeReload = calls.filter((call) => call.channel === 'agent:create').length
      const reloadReady = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
      win.webContents.reload()
      await reloadReady
      await wait(() => evaluate(`!!document.querySelector('button[title="저장된 작업환경 불러오기"]')`), 'Reloaded App')
      await evaluate(`document.querySelector('button[title="저장된 작업환경 불러오기"]').click()`)
      await wait(() => evaluate(`!!document.querySelector('.workspace-row')`), 'Saved workspace picker')
      await evaluate(`document.querySelector('.workspace-row').click()`)
      await wait(() => calls.filter((call) => call.channel === 'agent:create').length > beforeReload, 'Restored global Agent')
      const restored = calls.filter((call) => call.channel === 'agent:create').at(-1).args[0]
      assert.equal(restored.workspaceContext?.kind, 'global')
      assert.equal(restored.workspaceContext?.todoManagement, true)
      assert.equal(restored.cwd, chosenDir)
      await evaluate(`const input = document.querySelector('.agent-panel textarea') || document.querySelector('.term-pane textarea'); if (!input) throw Error('Restored Agent input missing'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '복원된 전체 할일 검토'); input.dispatchEvent(new Event('input', { bubbles: true }));`)
      await wait(() => evaluate(`!!document.querySelector('.agent-send-btn:not([disabled])')`), 'Restored global prompt ready')
      const beforeRestoredSend = calls.filter((call) => call.channel === 'agent:send').length
      await evaluate(`document.querySelector('.agent-send-btn:not([disabled])').click()`)
      await wait(() => calls.filter((call) => call.channel === 'agent:send').length > beforeRestoredSend, 'Restored global send')
      assert.equal(calls.filter((call) => call.channel === 'agent:send').at(-1).args[0].input.workspaceContext?.kind, 'global')
      await wait(() => evaluate(`document.querySelector('.term-pane textarea')?.value === ''`), 'Restored send clears input')
      assert.equal(await evaluate(`document.querySelector('.workspace-todo-header')?.textContent.includes('기한 도과 1')`), true)
      const readsBeforeMutation = calls.filter(call => call.channel === 'todo:list').length
      await evaluate(`const box=document.querySelector('.agent-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'도과 할일 완료');box.dispatchEvent(new Event('input',{bubbles:true}))`)
      await wait(() => evaluate(`!!document.querySelector('.agent-send-btn:not([disabled])')`), 'Mutation prompt ready')
      await evaluate(`document.querySelector('.agent-send-btn').click()`)
      await wait(() => evaluate(`document.querySelector('.workspace-todo-header').textContent.includes('기한 도과 0')`), 'Managed write refreshes header')
      assert.ok(calls.filter(call => call.channel === 'todo:list').length > readsBeforeMutation)
      assert.equal(await evaluate(`document.body.innerText.includes('클코 응답 JSON') || !!document.querySelector('.todo-patch-input')`), false)
      assert.equal(calls.filter((call) => call.channel === 'dialog:pickFolder').length, 0)
      assert.deepEqual(fs.readdirSync(chosenDir), ['existing.txt'])
      // A token change in another window retires the native session even before this renderer hears it.
      sessions.get(restored.id).workspaceContext.todoManagement = false
      const savesBeforeRetirement = calls.filter(call => call.channel === 'workspace:save').length
      await evaluate(`document.querySelector('button[title="현재 작업환경 저장"]').click()`)
      await wait(() => calls.filter(call => call.channel === 'workspace:save' && call.result?.ok).length > savesBeforeRetirement, 'Retired native snapshot saved')
      const retired = calls.filter(call => call.channel === 'workspace:save').at(-1).result
      assert.equal(JSON.parse(fs.readFileSync(retired.path,'utf8')).terminals[0].todoManagement, false, 'runtime retirement must survive stale renderer snapshots')
      assert.deepEqual([...new Set(unexpected)], [])
      assert.deepEqual(rendererErrors, [])
      await capture()
      console.log('TODO_APP_RESULT ' + JSON.stringify({ checks: 32, ipcCalls: calls.length, actualWorkspaceSaveReload: true, rendererErrors, screenshot }))
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
