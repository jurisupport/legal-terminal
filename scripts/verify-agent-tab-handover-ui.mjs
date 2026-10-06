import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tab-ui-'))
function runApp({ root, temp }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const assert = require('node:assert/strict')
  const calls = [], errors = [], sessions = new Map()
  const profile = { id: 'test-server', label: '검증 서버', host: 'example.invalid', user: 'test' }
  const cwd = '/cases/tab-handover'
  const recent = { drafts: `ssh://${profile.id}${cwd}`, name: '탭 공유 검증', ts: Date.now() }
  const snapshot = {
    version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceDevice: 'Android', workspaceOpen: true,
    currentCase: { drafts: cwd, name: recent.name }, activeTerm: 'mobile-agent',
    docs: [{ id: 'excluded-document', kind: 'markdown', title: '열리면 안 되는 문서', path: '/private.md' }],
    terminals: [
      { id: 'mobile-agent', title: '폰에서 열린 대화', kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: 'phone-session' },
      { id: 'blank-agent', title: '빈 에이전트 탭', kind: 'agent', agentProvider: 'claude', cwd },
      { id: 'excluded-shell', title: '열리면 안 되는 터미널', kind: 'terminal', cwd }
    ]
  }
  const sharedCases = new Map([[cwd, snapshot]])
  const knownTabs = new Map()
  const sharedModule = { exports: {} }
  const sharedCode = require(require('node:path').join(root, 'node_modules/typescript')).transpileModule(
    require('node:fs').readFileSync(require('node:path').join(root, 'src/shared/workspaceAgentTabs.ts'), 'utf8'),
    { compilerOptions: { module: 1, target: 9 } }).outputText
  require('node:vm').runInNewContext(sharedCode, { module: sharedModule, exports: sharedModule.exports })
  const { mergeSharedAgentTabs } = sharedModule.exports
  app.setPath('userData', require('node:path').join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  const real = new Set(['app:info', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (real.has(channel)) return handler(event, ...args)
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
    if (channel === 'sessions:transcript') return { sessionId: 'phone-session', messages: [{ role: 'user', text: '폰에서 보낸 질문' }] }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: args[0] ? [...sharedCases.values()].filter((s) => s.workspaceOpen || args[1]) : [] }
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'workspace:autoLoad') {
      const saved = sharedCases.get(args[0].cwd)
      if (args[1] !== false && saved) knownTabs.set(args[0].cwd, structuredClone(saved))
      return { ok: true, remote: { ok: true, snapshot: saved } }
    }
    if (channel === 'workspace:autoObserve') {
      knownTabs.set(args[0].cwd, structuredClone(args[1]))
      return
    }
    if (channel === 'workspace:autoSave') {
      const saved = sharedCases.get(args[0].location.cwd)
      if (saved) {
        const incoming = args[0].snapshot
        const merged = mergeSharedAgentTabs(saved, incoming, incoming.workspaceOpen === false ? undefined : knownTabs.get(args[0].location.cwd), incoming.reopenAgentTabs)
        const workspaceOpen = incoming.workspaceOpen !== false && (saved.workspaceOpen !== false || incoming.workspaceReopen === true)
        Object.assign(saved, merged, { currentCase: saved.currentCase, workspaceOpen })
        knownTabs.set(args[0].location.cwd, structuredClone(incoming))
      }
      return { ok: true }
    }
    if (channel === 'agent:create') { sessions.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:close') return { ok: true }
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })))
  let win
  const ready = new Promise((resolve) => app.once('browser-window-created', (_event, window) => {
    win = window
    window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
    window.webContents.once('did-finish-load', resolve)
  }))
  require(require('node:path').join(root, 'out/main/index.js'))
  const evaluate = (source) => win.webContents.executeJavaScript(source, true)
  const wait = async (check) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)) }
    throw Error('Timed out waiting for agent tabs')
  }
  ;(async () => {
    try {
      await ready
      await wait(() => evaluate(`!!document.querySelector('.case-sidebar-case')`))
      assert.equal(sessions.size, 0, 'discovery leaves cases collapsed and agents unloaded')
      assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' || call.channel === 'sessions:list'), false)
      await evaluate(`document.querySelector('.case-sidebar-case').click()`)
      await wait(() => sessions.has('mobile-agent'))
      assert.ok(calls.some((call) => call.channel === 'workspace:autoList'), 'startup discovers case names')
      assert.equal(sessions.get('mobile-agent').resumeSessionId, 'phone-session')
      assert.equal(sessions.get('mobile-agent').ssh.host, profile.host)
      assert.equal(await evaluate(`document.body.innerText.includes('열리면 안 되는 문서') || document.body.innerText.includes('열리면 안 되는 터미널')`), false)
      assert.equal(await evaluate(`document.body.innerText.includes('빈 에이전트 탭')`), true)
      assert.equal(await evaluate(`!!document.querySelector('.workspace-restore-prompt')`), false)
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      await wait(() => calls.some((call) => call.channel === 'workspace:autoSave'))
      const saved = calls.find((call) => call.channel === 'workspace:autoSave').args[0].snapshot
      assert.deepEqual(saved.terminals.map((tab) => tab.id).sort(), ['blank-agent', 'mobile-agent'])
      assert.equal(saved.docs.length, 0)
      const beforeStart = calls.filter((call) => call.channel === 'workspace:autoSave').length
      sessions.set('blank-agent', { id: 'blank-agent', resumeSessionId: 'new-conversation' })
      win.webContents.send('agent:event', { type: 'session:init', sessionId: 'blank-agent' })
      await wait(() => calls.filter((call) => call.channel === 'workspace:autoSave').length > beforeStart)
      assert.equal(calls.filter((call) => call.channel === 'workspace:autoSave').at(-1).args[0].snapshot.terminals
        .find((tab) => tab.id === 'blank-agent').resumeSessionId, 'new-conversation',
      'the first conversation ID is shared without requiring another tab action')
      await evaluate(`document.querySelector('.activity-item[title*="새 사건 추가"]').click()`)
      await wait(() => evaluate(`!!document.querySelector('.new-case-recent-row')`))
      await evaluate(`document.querySelector('.new-case-recent-row').click()`)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(calls.filter((call) => call.channel === 'workspace:autoLoad').length, 1)

      const otherPath = '/cases/another-device'
      sharedCases.set(otherPath, { ...snapshot, currentCase: { drafts: otherPath, name: '다른 컴퓨터의 사건' },
        activeTerm: undefined, docs: [], terminals: [] })
      snapshot.terminals.push({ id: 'new-remote-agent', title: '다른 컴퓨터의 새 대화', kind: 'agent', cwd,
        agentProvider: 'claude', resumeSessionId: 'new-remote-conversation' })
      await evaluate(`window.dispatchEvent(new Event('online'))`)
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 사건')`))
      assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' && call.args[0].cwd === otherPath), false, 'newly discovered cases stay unloaded')
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 새 대화')`))
      assert.equal(await evaluate(`[...document.querySelectorAll('.tab.active')].some(tab => tab.innerText.includes('폰에서 열린 대화'))`), true,
        'focus refresh keeps the existing active agent')
      await evaluate(`document.querySelector('.activity-item[title^="사건탭"]').click()`)
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 사건')`))
      await evaluate(`document.querySelector('.activity-item[title^="사건탭"]').click()`)
      await evaluate(`[...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes('빈 에이전트 탭')).querySelector('.tab-close').click(); window.dispatchEvent(new Event('focus'))`)
      await wait(() => !snapshot.terminals.some((tab) => tab.id === 'blank-agent'))
      assert.equal(await evaluate(`document.body.innerText.includes('빈 에이전트 탭')`), false,
        'focus refresh flushes a just-closed agent before reading remote state')
      snapshot.closedAgentTabs = [...(snapshot.closedAgentTabs ?? []), snapshot.terminals.find((tab) => tab.id === 'new-remote-agent')]
      snapshot.terminals = snapshot.terminals.filter((tab) => tab.id !== 'new-remote-agent')
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      await wait(() => evaluate(`!document.body.innerText.includes('다른 컴퓨터의 새 대화')`))
      assert.equal(snapshot.terminals.some((tab) => tab.id === 'new-remote-agent'), false, 'an old desktop cannot republish a remote tab closure')
      snapshot.workspaceOpen = false
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      await wait(() => evaluate(`!document.body.innerText.includes('폰에서 열린 대화')`))
      assert.equal(snapshot.workspaceOpen, false, 'background flush preserves the other computer’s case close')
      snapshot.workspaceOpen = true
      await evaluate(`window.dispatchEvent(new Event('online'))`)
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-case').length === 2`))
      assert.equal(await evaluate(`!![...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes('폰에서 열린 대화'))`), false, 'remote reopen does not eagerly reactivate a case')
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      assert.deepEqual(errors, [])
      console.log('agent tab UI: startup discovery, focus refresh, empty cases, preserved focus, SSH restoration and repeat-open dedupe OK')
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, channels: calls.map((call) => call.channel), dom: await evaluate('document.body.innerText').catch(() => '') }))
      app.exit(1)
    }
  })()
}
await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp })})`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const code = await new Promise((resolve, reject) => {
    const proc = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('exit', resolve)
  })
  assert.equal(code, 0)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
