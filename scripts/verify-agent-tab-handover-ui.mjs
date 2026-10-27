import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tab-ui-'))
function runApp({ root, temp, appMain, syncBaseline }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const assert = require('node:assert/strict')
  const calls = [], errors = [], sessions = new Map()
  const profile = { id: 'test-server', label: '검증 서버', host: 'example.invalid', user: 'test' }
  const cwd = '/cases/tab-handover'
  const recent = { drafts: `ssh://${profile.id}${cwd}`, name: '탭 공유 검증', ts: Date.now() }
  const snapshot = {
    version: 1, savedAt: new Date().toISOString(), workspaceOpenedAt: '2026-10-01T00:00:00Z', mode: 'todos', workspaceDevice: 'Android', workspaceOpen: true,
    currentCase: { drafts: cwd, name: recent.name }, activeTerm: 'mobile-agent',
    docs: [{ id: 'excluded-document', kind: 'markdown', title: '열리면 안 되는 문서', path: '/private.md' }],
    terminals: [
      { id: 'mobile-agent', title: '폰에서 열린 대화', kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: 'phone-session', originDevice: 'android' },
      { id: 'blank-agent', title: '빈 에이전트 탭', kind: 'agent', agentProvider: 'claude', cwd },
      { id: 'excluded-shell', title: '열리면 안 되는 터미널', kind: 'terminal', cwd }
    ]
  }
  const sharedCases = new Map([[cwd, snapshot]])
  const knownTabs = new Map()
  const phoneMessages = [{ id: 'phone-user-1', role: 'user', text: '폰에서 보낸 질문' }]
  let releaseStartupDiscovery
  const startupDiscovery = new Promise(resolve => { releaseStartupDiscovery = resolve })
  let delayStartupDiscovery = true
  let delayNextDiscovery
  let releaseCloseObservation
  let holdCloseObservation = true
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
    // The user opens a case while the general-chat directory is still loading.
    if (channel === 'app:generalChatDirectory') return new Promise(() => {})
    if (real.has(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
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
    if (channel === 'sessions:transcript') return { sessionId: args[0].sessionId,
      messages: args[0].sessionId === 'phone-session' ? structuredClone(phoneMessages) : [] }
    if (channel === 'workspace:autoList') {
      if (args[0] && delayNextDiscovery) {
        const delay = delayNextDiscovery
        delayNextDiscovery = undefined
        await delay()
      }
      if (args[0] && delayStartupDiscovery) {
        delayStartupDiscovery = false
        await startupDiscovery
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      return { ok: true, snapshots: args[0] ? [...sharedCases.values()].filter((s) => s.workspaceOpen || args[1]) : [] }
    }
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'workspace:autoLoad') {
      const saved = sharedCases.get(args[0].cwd)
      if (args[1] !== false && saved) knownTabs.set(args[0].cwd, structuredClone(saved))
      return { ok: true, remote: { ok: true, snapshot: saved } }
    }
    if (channel === 'workspace:autoObserve') {
      knownTabs.set(args[0].cwd, structuredClone(args[1]))
      // Hold the acknowledgement until the next focus event arrives during this refresh.
      if (holdCloseObservation && args[1].closedAgentTabs?.some(tab => tab?.id === 'new-remote-agent')) {
        holdCloseObservation = false
        await new Promise(resolve => { releaseCloseObservation = resolve })
      }
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
  require(appMain)
  const evaluate = (source) => win.webContents.executeJavaScript(source, true)
  const wait = async (check) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)) }
    throw Error('Timed out waiting for agent tabs')
  }
  ;(async () => {
    try {
      await ready
      await wait(() => evaluate(`!!document.querySelector('.case-sidebar-case')`))
      assert.equal(await evaluate(`document.querySelector('.case-sidebar-group').dataset.open`), 'false',
        'recent history renders before the delayed shared-case discovery completes')
      releaseStartupDiscovery()
      // A history row is visible before the remote open state has been applied.
      await wait(() => evaluate(`!!document.querySelector('.case-sidebar-group[data-open="true"] .case-sidebar-case')`))
      assert.equal(sessions.size, 0, 'discovery leaves cases collapsed and agents unloaded')
      assert.equal(await evaluate(`document.querySelectorAll('.toast.synced').length`), 0, 'startup discovery is quiet')
      assert.equal(await evaluate(`document.querySelector('.case-sidebar-group').dataset.open`), 'true',
        'an open phone case is automatically an open desktop tab')
      assert.equal(await evaluate(`!!document.querySelector('.case-sidebar-group.active')`), false,
        'background discovery does not select a case')
      assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' || call.channel === 'sessions:list'), false)
      await evaluate(`document.querySelector('.case-sidebar-case').click()`)
      await wait(() => sessions.has('mobile-agent'))
      assert.equal(await evaluate(`document.querySelector('.activity-item[title^="탐색기 표시"]').getAttribute('aria-pressed')`), 'true',
        'restoring a conversation does not switch to the remote device\'s saved Todos screen')
      assert.ok(calls.some((call) => call.channel === 'workspace:autoList'), 'startup discovers case names')
      assert.equal(sessions.get('mobile-agent').resumeSessionId, 'phone-session')
      assert.equal(sessions.get('mobile-agent').ssh.host, profile.host)
      assert.equal(await evaluate(`document.body.innerText.includes('열리면 안 되는 문서') || document.body.innerText.includes('열리면 안 되는 터미널')`), false)
      assert.equal(await evaluate(`document.body.innerText.includes('빈 에이전트 탭')`), true)
      assert.equal(await evaluate(`!!document.querySelector('.workspace-restore-prompt')`), false)
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: false }); window.dispatchEvent(new Event('focus'))`)
      await wait(() => evaluate(`document.body.innerText.includes('폰에서 보낸 질문')`))
      await evaluate(`(() => {
        const input = [...document.querySelectorAll('.agent-composer textarea')].find(el => el.offsetParent);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'PC에서 작성 중인 초안');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      phoneMessages.push({ id: 'phone-user-2', role: 'user', text: '폰에서 추가한 실시간 질문' },
        { id: 'phone-answer-2', role: 'assistant', text: '폰 작업의 새 답변' })
      await wait(() => evaluate(`document.body.innerText.includes('폰 작업의 새 답변')`))
      assert.equal(await evaluate(`[...document.querySelectorAll('.agent-composer textarea')].find(el => el.offsetParent).value`),
        'PC에서 작성 중인 초안', 'polling does not replace the draft')
      assert.equal(await evaluate(`[...document.querySelectorAll('.agent-msg.user')].filter(el => el.innerText.includes('폰에서 추가한 실시간 질문')).length`), 1)
      phoneMessages.at(-1).text = '폰 작업의 새 답변 완성'
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      await wait(() => evaluate(`document.body.innerText.includes('폰 작업의 새 답변 완성')`))
      assert.equal(await evaluate(`[...document.querySelectorAll('.agent-msg.assistant')].filter(el => el.innerText.includes('폰 작업의 새 답변')).length`), 1,
        'remote answer growth updates the existing bubble')
      await evaluate(`(() => {
        const input = [...document.querySelectorAll('.agent-composer textarea')].find(el => el.offsetParent);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await wait(() => calls.some((call) => call.channel === 'workspace:autoSave'))
      const saved = calls.find((call) => call.channel === 'workspace:autoSave').args[0].snapshot
      assert.deepEqual(saved.terminals.map((tab) => tab.id).sort(), ['blank-agent', 'mobile-agent'])
      assert.equal(saved.docs.length, 0)
      assert.equal(saved.terminals.find((tab) => tab.id === 'mobile-agent').originDevice, 'android',
        'restoring and resaving on PC keeps the original phone creator')
      assert.equal(saved.terminals.find((tab) => tab.id === 'blank-agent').originDevice, undefined,
        'legacy unknown tabs do not inherit Android from the workspace writer')
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
      assert.equal(calls.filter((call) => call.channel === 'workspace:autoLoad' && call.args[1] !== false).length, 1,
        'reopening reuses loaded conversations even if a scheduled background refresh ran')

      const otherPath = '/cases/another-device'
      sharedCases.set(otherPath, { ...snapshot, workspaceOpenedAt: '2026-10-02T00:00:00.001Z', currentCase: { drafts: otherPath, name: '다른 컴퓨터의 사건' },
        activeTerm: undefined, docs: [], terminals: [] })
      snapshot.terminals.push({ id: 'new-remote-agent', title: '다른 컴퓨터의 새 대화', kind: 'agent', cwd,
        agentProvider: 'claude', resumeSessionId: 'new-remote-conversation' })
      await evaluate(`window.dispatchEvent(new Event('online'))`)
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 사건')`))
      assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length`), 2,
        'a new remote case appears as an open tab without user action')
      const sharedOrder = await evaluate(`[...document.querySelectorAll('.case-sidebar-group[data-open="true"] .case-sidebar-case-title')].map(el => el.textContent)`)
      assert.deepEqual(sharedOrder, [recent.name, '다른 컴퓨터의 사건'], 'shared opening order is stable across devices')
      assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' && call.args[0].cwd === otherPath), false, 'newly discovered cases stay unloaded')
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 새 대화')`))
      assert.equal(await evaluate(`[...document.querySelectorAll('.tab.active')].some(tab => tab.innerText.includes('폰에서 열린 대화'))`), true,
        'focus refresh keeps the existing active agent')
      const syncOutput = require('node:path').join(root, '.omx/state/sync-notice')
      require('node:fs').mkdirSync(syncOutput, { recursive: true })
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      require('node:fs').writeFileSync(require('node:path').join(syncOutput, syncBaseline ? 'desktop-before.png' : 'desktop-after.png'),
        (await win.webContents.capturePage()).toPNG())
      if (syncBaseline) { app.exit(0); return }
      assert.equal(await evaluate(`document.querySelectorAll('.toast.synced').length`), 1,
        'one light notice groups new case and conversation tabs')
      assert.equal(await evaluate(`document.querySelector('.toast.synced').textContent.includes('새 탭 2개')`), true)
      assert.equal(await evaluate(`document.querySelector('.toast.synced').getAttribute('role')`), 'status')
      assert.equal(calls.some(call => ['app:notify', 'app:requestAttention', 'app:setBadgeCount'].includes(call.channel)), false,
        'sync notifications do not interrupt with native alerts or badges')
      await wait(() => evaluate(`!document.querySelector('.toast.synced')`))
      const syncReads = calls.filter(call => call.channel === 'workspace:autoObserve').length
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      await wait(() => calls.filter(call => call.channel === 'workspace:autoObserve').length > syncReads)
      assert.equal(await evaluate(`document.querySelectorAll('.toast.synced').length`), 0,
        'unchanged refreshes do not repeat the notification')
      await evaluate(`document.querySelector('.case-sidebar-trigger').click()`)
      await wait(() => evaluate(`document.body.innerText.includes('다른 컴퓨터의 사건')`))
      await evaluate(`document.querySelector('.case-sidebar-trigger').click()`)
      await evaluate(`[...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes('빈 에이전트 탭')).querySelector('.tab-close').click(); window.dispatchEvent(new Event('focus'))`)
      for (let visit = 0; visit < 3; visit++) {
        for (const title of ['다른 컴퓨터의 사건', '탭 공유 검증']) {
          await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(button => button.innerText.includes(${JSON.stringify(title)})).click()`)
          await wait(() => evaluate(`document.querySelector('.case-sidebar-case.active')?.innerText.includes(${JSON.stringify(title)})`))
        }
        assert.equal(await evaluate(`[...document.querySelectorAll('.tab')].some(tab => tab.innerText.includes('빈 에이전트 탭'))`), false,
          'a closed AI tab stays closed while switching cases before and after autosave')
      }
      await wait(() => !snapshot.terminals.some((tab) => tab.id === 'blank-agent'))
      assert.equal(await evaluate(`document.body.innerText.includes('빈 에이전트 탭')`), false,
        'focus refresh flushes a just-closed agent before reading remote state')
      snapshot.closedAgentTabs = [...(snapshot.closedAgentTabs ?? []), snapshot.terminals.find((tab) => tab.id === 'new-remote-agent')]
      snapshot.terminals = snapshot.terminals.filter((tab) => tab.id !== 'new-remote-agent')
      let releaseDiscovery
      delayNextDiscovery = async () => {
        await new Promise(resolve => { releaseDiscovery = resolve })
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      await wait(() => typeof releaseDiscovery === 'function')
      for (const title of ['다른 컴퓨터의 사건', '탭 공유 검증']) {
        await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(button => button.innerText.includes(${JSON.stringify(title)})).click()`)
        await wait(() => evaluate(`document.querySelector('.case-sidebar-case.active')?.innerText.includes(${JSON.stringify(title)})`))
      }
      releaseDiscovery()
      await wait(() => evaluate(`!document.body.innerText.includes('다른 컴퓨터의 새 대화')`))
      assert.equal(snapshot.terminals.some((tab) => tab.id === 'new-remote-agent'), false, 'an old desktop cannot republish a remote tab closure')
      await wait(() => typeof releaseCloseObservation === 'function')
      snapshot.workspaceOpen = false
      await evaluate(`window.dispatchEvent(new Event('focus'))`)
      releaseCloseObservation()
      await wait(() => evaluate(`!document.body.innerText.includes('폰에서 열린 대화')`))
      assert.equal(snapshot.workspaceOpen, false, 'background flush preserves the other computer’s case close')
      assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length`), 1)
      snapshot.workspaceOpen = true
      await evaluate(`window.dispatchEvent(new Event('online'))`)
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-case').length === 2`))
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length === 2`))
      assert.equal(await evaluate(`!![...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes('폰에서 열린 대화'))`), false, 'remote reopen does not eagerly reactivate a case')
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      assert.deepEqual(errors, [])
      console.log('agent tab UI: startup discovery, focus refresh, close/navigation persistence, empty cases, preserved focus, SSH restoration and repeat-open dedupe OK')
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, channels: calls.map((call) => call.channel), dom: await evaluate('document.body.innerText').catch(() => '') }))
      app.exit(1)
    }
  })()
}
const appMain = process.env.LT_TEST_APP_MAIN || path.join(root, 'out/main/index.js')
await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, appMain, syncBaseline: process.argv.includes('--sync-baseline') })})`)
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
