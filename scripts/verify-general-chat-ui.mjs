import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'general-chat-ui-'))
const screenshotDir = path.join(temp, 'screenshots')
await fs.mkdir(screenshotDir, { recursive: true })
await fs.access(path.join(root, 'out/main/index.js'))

function runApp({ root, temp, screenshotDir, provider, mode, remote }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = [], unexpected = [], agents = new Map()
  const caseDir = path.join(temp, 'existing-case')
  const homeDir = path.join(temp, 'home')
  fs.mkdirSync(caseDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(caseDir, 'evidence.txt'), 'Existing case evidence must stay untouched.')
  const history = [{ drafts: caseDir, name: '기존 거래대금 사건', ts: Date.now() }]
  const phoneProfile = { id: 'phone-host', label: '휴대폰과 공유하는 서버', host: 'example.invalid', user: 'lawyer' }
  const remoteCwd = '/home/lawyer/legal-terminal-general'
  const mobileSnapshot = {
    version: 1, savedAt: new Date().toISOString(), mode: 'explorer', docs: [],
    currentCase: { name: '일반 작업', drafts: remoteCwd },
    terminals: [{ id: 'mobile-shared', title: '휴대폰 일반 질문', kind: 'agent', agentProvider: 'claude', cwd: remoteCwd, resumeSessionId: 'phone-session', originDevice: 'android', createdAt: Date.now(), side: 'right' }],
    activeTerm: 'mobile-shared', activeWork: { right: 'terminal:mobile-shared' }
  }
  const replacementProfile = { ...phoneProfile, host: 'replacement.invalid' }
  const staleLocalSnapshot = {
    ...mobileSnapshot,
    currentCase: { ...mobileSnapshot.currentCase, drafts: `ssh://${phoneProfile.id}${remoteCwd}`, remotePath: remoteCwd, profileId: phoneProfile.id, ssh: phoneProfile },
    terminals: [...mobileSnapshot.terminals, { ...mobileSnapshot.terminals[0], id: 'old-server-cached', title: '이전 서버 캐시', resumeSessionId: 'old-session' }]
      .map(term => ({ ...term, profileId: phoneProfile.id, ssh: phoneProfile }))
  }
  const settings = { sshProfiles: remote ? [phoneProfile] : [], caseOpenTarget: remote ? 'remote:phone-host' : 'local', notifyDone: false, agentDefaultProvider: provider }
  let releaseSettings
  const settingsReady = new Promise(resolve => { releaseSettings = resolve })
  app.setPath('userData', path.join(temp, 'profile'))
  app.setPath('home', homeDir)
  BrowserWindow.prototype.show = function () {}
  const loadFile = BrowserWindow.prototype.loadFile
  BrowserWindow.prototype.loadFile = function (file, options) {
    return loadFile.call(this, file, mode && mode !== 'navigate' ? { ...options, hash: mode } : options)
  }
  global.fetch = async () => { throw Error('External network blocked by general-chat UI test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (remote && channel === 'app:generalChatDirectory') {
      assert.equal(args[0], phoneProfile.id, 'general chat targets the configured phone server')
      return remoteCwd
    }
    if (['app:info', 'app:generalChatDirectory', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'].includes(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') { await settingsReady; return settings }
    if (channel === 'case:history' || channel === 'case:addHistory') return history
    if (channel === 'js:tokenStatus') return 'missing'
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true, fetchedAt: new Date().toISOString() }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (['fs:list', 'fs:listPdfs', 'sessions:list', 'projects:list'].includes(channel)) return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'fs:stat') return { ok: true, isDir: true, size: 0 }
    if (channel === 'fs:readText') return { ext: 'rst', kind: 'text', text: '질문과 함께 확인할 참고 문서입니다.' }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return { ok: true }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoLoad') {
      if (remote && args[0].ssh?.host === replacementProfile.host) return {
        ok: true, local: { ok: true, snapshot: staleLocalSnapshot },
        remote: { ok: true, snapshot: { ...mobileSnapshot, terminals: [], activeTerm: undefined, activeWork: {} } }
      }
      return { ok: true, remote: { ok: true, snapshot: remote && args[0].cwd === remoteCwd ? mobileSnapshot : null } }
    }
    if (channel === 'workspace:autoSave') return { ok: true }
    if (channel === 'workspace:autoObserve') return
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:create') {
      const options = args[0]
      agents.set(options.id, options)
      setTimeout(() => {
        if (event.sender.isDestroyed()) return
        event.sender.send('agent:event', { type: 'auth:status', sessionId: options.id, state: 'authenticated' })
        event.sender.send('agent:event', { type: 'status', sessionId: options.id, status: 'idle' })
      }, 30)
      return { ok: true, sessionId: options.id }
    }
    if (channel === 'agent:snapshot') return { ok: true, session: agents.get(args[0]) }
    if (channel === 'sessions:transcript') return { sessionId: args[0].sessionId, messages: [{ role: 'user', text: '휴대폰에서 먼저 물어본 질문입니다.' }, { role: 'assistant', text: '이 대화는 컴퓨터에서도 이어갈 수 있습니다.' }] }
    if (['agent:close', 'agent:setModel', 'agent:slashCommand'].includes(channel)) return { ok: true }
    if (channel === 'agent:send') {
      const { sessionId, input } = args[0]
      const send = message => event.sender.send('agent:event', { sessionId, ...message })
      send({ type: 'status', status: 'working' })
      send({ type: 'message:user', messageId: `user-${calls.length}`, text: input.text, attachments: [] })
      send({ type: 'message:assistant_start', messageId: `answer-${calls.length}` })
      send({ type: 'message:assistant_delta', messageId: `answer-${calls.length}`, text: '안녕하세요. 사건을 선택하지 않아도 일반적인 질문을 하실 수 있습니다.' })
      send({ type: 'message:assistant_done', messageId: `answer-${calls.length}` })
      send({ type: 'status', status: 'done' })
      return { ok: true }
    }
    unexpected.push(channel)
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })))
  let win
  const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => {
    win = window
    win.setSize(1440, 940)
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
    win.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw Error(`Timed out: ${label}`)
  }
  const capture = async name => fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  const test = async (name, callback) => { await callback(); console.log(`PASS ${remote ? 'remote' : provider}${mode ? `/${mode}` : ''}: ${name}`) }
  const checkUnifiedChat = async () => {
    const layout = await evaluate(`(() => {
      const shell = document.querySelector('.shell');
      const pane = window.visibleComposer()?.closest('.work-pane');
      const bounds = pane?.getBoundingClientRect();
      return {
        unified: shell?.classList.contains('general-chat'),
        visiblePanes: [...document.querySelectorAll('.work-pane')].filter(el => el.offsetParent !== null).length,
        composers: [...document.querySelectorAll('.agent-composer textarea')].filter(el => el.offsetParent !== null).length,
        divider: document.querySelector('.pane-resizer-work')?.offsetParent !== null,
        right: bounds?.right, edge: shell?.getBoundingClientRect().right,
        overflow: shell.scrollWidth > shell.clientWidth,
        draft: window.visibleComposer()?.value
      };
    })()`)
    assert.equal(layout.unified, true)
    assert.equal(layout.visiblePanes, 1, 'general questions use one combined document/chat area')
    assert.equal(layout.composers, 1, 'there is only one visible question input')
    assert.equal(layout.divider, false, 'no divider splits the general conversation')
    assert.ok(Math.abs(layout.right - layout.edge) < 2, 'conversation reaches the work-area edge')
    assert.equal(layout.overflow, false, 'unified conversation fits the window')
    return layout
  }
  const checkScope = (agent, profile = phoneProfile) => {
    assert.equal(agent.provider, remote ? 'claude' : provider)
    assert.equal(agent.source, remote ? 'ssh' : 'local')
    if (remote) {
      assert.equal(agent.ssh?.host, profile.host)
      assert.equal(agent.ssh?.user, profile.user)
      assert.equal(agent.cwd, remoteCwd)
    } else {
      assert.equal(agent.ssh, undefined)
      assert.equal(fs.realpathSync(agent.cwd), path.join(fs.realpathSync(homeDir), 'legal-terminal-general'))
    }
    assert.equal(agent.workspaceContext?.kind, 'global')
    for (const key of ['todoManagement', 'caseId', 'caseNumber', 'caseName', 'court', 'client', 'projectId']) {
      assert.equal(agent.workspaceContext[key], undefined, `general chat has no ${key}`)
    }
  }
  ;(async () => {
    try {
      await ready
      await evaluate(`window.visibleComposer = () => [...document.querySelectorAll('.work-right .agent-composer textarea')].find(el => el.offsetParent !== null); window.addEventListener('error', event => console.error('GENERAL_CHAT_ERROR: ' + event.message)); window.addEventListener('unhandledrejection', event => console.error('GENERAL_CHAT_REJECTION: ' + event.reason));`)
      await wait(() => calls.some(call => call.channel === 'settings:get'), 'settings requested')
      await test('waits for settings before opening general chat', async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
        assert.equal(agents.size, 0)
      })
      if (mode === 'navigate') await evaluate(`document.querySelector('.project-open-button').click()`)
      releaseSettings()
      if (mode === 'navigate') {
        await test('does not replace a view chosen while startup is still loading', async () => {
          await wait(() => evaluate(`!document.querySelector('.general-chat-button').disabled`), 'general chat directory ready')
          await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
          assert.equal(await evaluate(`!!document.querySelector('.project-dashboard')`), true)
          assert.equal(agents.size, 0, 'background preparation must not steal the selected view')
        })
      } else if (remote) {
        await test('opens shared general questions with Android-compatible Claude', async () => {
          await wait(() => [...agents.values()].some(agent => agent.id !== 'mobile-shared'), 'new remote general chat')
          checkScope([...agents.values()].find(agent => agent.id !== 'mobile-shared'))
          await wait(() => evaluate(`!!window.visibleComposer() && document.activeElement === window.visibleComposer()`), 'remote composer focused')
          assert.equal(calls.some(call => call.channel === 'agent:send'), false)
          assert.equal(calls.some(call => call.channel.startsWith('dialog:')), false)
          await checkUnifiedChat()
          await capture('initial-remote')
        })
        await test('restores the phone conversation in the same general-question workspace', async () => {
          await wait(() => evaluate(`[...document.querySelectorAll('.work-right .tab-title')].some(el => el.textContent.includes('휴대폰 일반 질문'))`), 'phone conversation tab restored')
          await evaluate(`[...document.querySelectorAll('.work-right .tab-title')].find(el => el.textContent.includes('휴대폰 일반 질문')).click()`)
          await wait(() => agents.has('mobile-shared'), 'phone session restored')
          checkScope(agents.get('mobile-shared'))
          assert.equal(agents.get('mobile-shared').resumeSessionId, 'phone-session')
          assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length`), 1, 'phone and desktop share one workspace')
          await evaluate(`(() => { const button = document.querySelector('.case-sidebar-group.active .case-sidebar-toggle'); if (button?.getAttribute('aria-expanded') !== 'true') button?.click() })()`)
          await wait(() => evaluate(`!!document.querySelector('.case-sidebar-task-origin[title="폰에서 시작한 작업"]')`), 'phone origin label')
          await wait(() => evaluate(`window.visibleComposer()?.closest('.agent-panel').textContent.includes('휴대폰에서 먼저 물어본 질문입니다.')`), 'phone transcript shown')
        })
        await test('continues the phone conversation through its restored session', async () => {
          await evaluate(`(() => { const el = window.visibleComposer(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '컴퓨터에서 이어서 질문합니다.'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
          await wait(() => evaluate(`!window.visibleComposer().closest('.agent-panel').querySelector('.agent-send-btn').disabled`), 'phone conversation ready')
          await evaluate(`window.visibleComposer().closest('.agent-panel').querySelector('.agent-send-btn').click()`)
          await wait(() => evaluate(`window.visibleComposer().closest('.agent-panel').textContent.includes('안녕하세요. 사건을 선택하지 않아도')`), 'continued response shown')
          const sent = calls.find(call => call.channel === 'agent:send').args[0]
          assert.equal(sent.sessionId, 'mobile-shared')
          assert.equal(sent.input.text, '컴퓨터에서 이어서 질문합니다.')
          checkScope({ ...agents.get('mobile-shared'), workspaceContext: sent.input.workspaceContext })
          await capture('conversation-remote')
        })
        await test('preserves the phone session when saving and starting a new conversation', async () => {
          const savedPhone = () => calls.filter(call => call.channel === 'workspace:autoSave').find(call => call.args[0].snapshot.terminals.some(term => term.id === 'mobile-shared'))
          await wait(() => !!savedPhone(), 'phone session saved')
          const saved = savedPhone().args[0]
          assert.equal(saved.location.cwd, remoteCwd)
          assert.equal(saved.location.ssh.host, phoneProfile.host)
          const phone = saved.snapshot.terminals.find(term => term.id === 'mobile-shared')
          assert.equal(phone.resumeSessionId, 'phone-session')
          assert.equal(phone.originDevice, 'android')
          assert.equal(phone.cwd, remoteCwd)
          assert.notEqual(phone.contextKind, 'global', 'shared metadata stays compatible with Android folder scope')
          const before = agents.size
          await evaluate(`document.querySelector('.general-chat-button').click(); document.querySelector('.general-chat-button').click()`)
          await wait(() => evaluate(`document.activeElement === window.visibleComposer()`), 'remote general chat reused')
          assert.equal(agents.size, before)
          const ids = new Set(agents.keys())
          await evaluate(`document.querySelector('.work-right button[title="새 대화"]').click()`)
          await wait(() => agents.size === before + 1, 'new remote conversation')
          checkScope([...agents.values()].find(agent => !ids.has(agent.id)))
          assert.equal(calls.some(call => call.channel.startsWith('dialog:')), false)
        })
        let replacementAgent, originalCaseId, replacementCaseId
        await test('starts a fresh conversation after changing the host of the same SSH profile', async () => {
          originalCaseId = await evaluate(`document.querySelector('.case-sidebar-group.active').dataset.caseId`)
          const before = agents.size
          const directoryCalls = calls.filter(call => call.channel === 'app:generalChatDirectory').length
          settings.sshProfiles = [replacementProfile]
          await evaluate(`window.dispatchEvent(new CustomEvent('lt:settings-updated', { detail: ${JSON.stringify(settings)} }))`)
          await wait(() => calls.filter(call => call.channel === 'app:generalChatDirectory').length > directoryCalls, 'replacement server directory prepared')
          await wait(() => evaluate(`!document.querySelector('.general-chat-button').disabled`), 'replacement server ready')
          await evaluate(`document.querySelector('.general-chat-button').click()`)
          await wait(() => [...agents.values()].some(agent => agent.ssh?.host === replacementProfile.host), 'replacement server conversation')
          replacementAgent = [...agents.values()].find(agent => agent.ssh?.host === replacementProfile.host)
          checkScope(replacementAgent, replacementProfile)
          assert.equal(agents.size, before + 1, 'the replacement server receives a new agent')
          assert.equal(replacementAgent.resumeSessionId, undefined, 'the replacement server never resumes an old server session')
          assert.equal(agents.get('mobile-shared').ssh.host, phoneProfile.host, 'the phone session stays on its original server')
          await wait(() => calls.some(call => call.channel === 'workspace:autoLoad' && call.args[0].ssh?.host === replacementProfile.host), 'replacement workspace loaded separately')
          await wait(() => evaluate(`window.visibleComposer()?.closest('[data-term-id]')?.dataset.termId === ${JSON.stringify(replacementAgent.id)}`), 'replacement conversation visible')
          replacementCaseId = await evaluate(`document.querySelector('.case-sidebar-group.active').dataset.caseId`)
          assert.notEqual(replacementCaseId, originalCaseId, 'same profile and cwd on another server has a distinct workspace')
          await checkUnifiedChat()
        })
        await test('excludes stale server sessions from the replacement workspace and saved snapshot', async () => {
          const replacementSaves = () => calls.filter(call => call.channel === 'workspace:autoSave' && call.args[0].location.ssh?.host === replacementProfile.host)
          await wait(() => replacementSaves().some(call => call.args[0].snapshot.terminals.some(term => term.id === replacementAgent.id)), 'replacement conversation saved')
          for (const { args: [saved] } of replacementSaves()) {
            assert.equal(saved.location.cwd, remoteCwd)
            assert.equal(saved.snapshot.terminals.some(term => ['mobile-shared', 'old-server-cached'].includes(term.id) || ['phone-session', 'old-session'].includes(term.resumeSessionId)), false, 'old server sessions are never written to the replacement server')
          }
          assert.equal(agents.has('old-server-cached'), false, 'stale local cache is not started on the replacement server')
          assert.equal(await evaluate(`[...document.querySelectorAll('.work-right .tab-title')].filter(el => el.offsetParent !== null).some(el => /휴대폰 일반 질문|이전 서버 캐시/.test(el.textContent))`), false, 'old server tabs are absent from the replacement workspace')
          assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length`), 2, 'both servers keep their own workspace groups')
        })
        await test('reuses the replacement conversation while keeping the original phone workspace independent', async () => {
          const before = agents.size
          await evaluate(`document.querySelector('.general-chat-button').click(); document.querySelector('.general-chat-button').click()`)
          await wait(() => evaluate(`document.activeElement === window.visibleComposer()`), 'replacement conversation reused')
          assert.equal(agents.size, before)
          await evaluate(`[...document.querySelectorAll('.case-sidebar-group')].find(el => el.dataset.caseId === ${JSON.stringify(originalCaseId)}).querySelector('.case-sidebar-case').click()`)
          await evaluate(`[...document.querySelectorAll('.case-sidebar-group')].find(el => el.dataset.caseId === ${JSON.stringify(originalCaseId)}).querySelectorAll('.case-sidebar-task').forEach(el => { if (el.textContent.includes('휴대폰 일반 질문')) el.click() })`)
          await wait(() => evaluate(`window.visibleComposer()?.closest('[data-term-id]')?.dataset.termId === 'mobile-shared'`), 'original phone conversation remains available')
          checkScope(agents.get('mobile-shared'))
          assert.equal(agents.get('mobile-shared').resumeSessionId, 'phone-session')
          await evaluate(`document.querySelector('.general-chat-button').click()`)
          await wait(() => evaluate(`document.querySelector('.case-sidebar-group.active')?.dataset.caseId === ${JSON.stringify(replacementCaseId)} && window.visibleComposer()?.closest('[data-term-id]')?.dataset.termId === ${JSON.stringify(replacementAgent.id)}`), 'general questions return to the configured replacement server')
          assert.equal(agents.size, before, 'switching between servers reuses each server conversation')
          await capture('replacement-server-remote')
        })
      } else if (mode) {
        await test('detached window does not open general chat', async () => {
          await evaluate(`new Promise(resolve => setTimeout(resolve, 300))`)
          assert.equal(await evaluate('window.location.hash'), `#${mode}`)
          assert.equal(agents.size, 0)
          assert.equal(calls.some(call => call.channel === 'app:generalChatDirectory'), false)
          assert.equal(await evaluate(`!!document.querySelector('.general-chat-button')`), false)
        })
      } else {
        let first
        await test('opens a focused local general chat using the configured provider', async () => {
          await wait(() => agents.size === 1, 'automatic general-chat session')
          first = [...agents.values()][0]
          checkScope(first)
          assert.equal(fs.statSync(first.cwd).isDirectory(), true)
          await wait(() => evaluate(`!!window.visibleComposer() && document.activeElement === window.visibleComposer()`), 'composer focused')
          assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'opening does not send a prompt')
        })
        await test('shows a useful general-question empty state', async () => {
          await wait(() => evaluate(`window.visibleComposer()?.closest('.agent-panel').textContent.includes('무엇이 궁금하신가요?')`), 'general-chat welcome')
          assert.equal(await evaluate(`window.visibleComposer().closest('.agent-panel').querySelectorAll('.agent-empty button').length > 0`), true)
          assert.equal(await evaluate(`!!document.querySelector('.general-chat-button')`), true)
          await checkUnifiedChat()
          await capture(`initial-${provider}`)
        })
        await test('keeps one input and preserves its draft in a narrow window', async () => {
          await evaluate(`(() => { const input = window.visibleComposer(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '아직 전송하지 않은 일반 질문'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
          win.setMinimumSize(680, 480)
          win.setSize(900, 760)
          await wait(() => evaluate(`innerWidth <= 900`), 'narrow general chat')
          assert.equal((await checkUnifiedChat()).draft, '아직 전송하지 않은 일반 질문')
          await capture(`unified-narrow-${provider}`)
          win.setSize(1440, 940)
        })
        await test('opens a document beside the conversation and reunites the view without losing the draft', async () => {
          win.webContents.send('tabs:receive', { kind: 'doc', tab: {
            id: 'general-note', kind: 'file', path: path.join(first.cwd, 'note.rst'), title: 'note.rst', side: 'left'
          } })
          await wait(() => evaluate(`document.querySelector('.work-left')?.textContent.includes('질문과 함께 확인할 참고 문서입니다.')`), 'reference document displayed')
          assert.equal(await evaluate(`document.querySelector('.shell').classList.contains('general-chat')`), false)
          assert.equal(await evaluate(`document.querySelector('.work-left').offsetParent !== null && document.querySelector('.work-right').offsetParent !== null`), true)
          assert.equal(await evaluate(`window.visibleComposer().value`), '아직 전송하지 않은 일반 질문')
          await evaluate(`document.querySelector('[data-doc-id="general-note"]').focus(); [...document.querySelectorAll('.work-left .tab')].find(el => el.textContent.includes('note.rst')).querySelector('.tab-close').click()`)
          await wait(() => evaluate(`document.querySelector('.shell').classList.contains('general-chat')`), 'single conversation restored')
          await wait(() => evaluate(`document.activeElement === window.visibleComposer()`), 'typing returns to the single question input')
          assert.equal((await checkUnifiedChat()).draft, '아직 전송하지 않은 일반 질문')
          assert.equal(agents.size, 1, 'layout changes reuse the existing conversation')
        })
        await test('repeated general-question clicks reuse the existing conversation', async () => {
          await evaluate(`document.querySelector('.general-chat-button').click(); document.querySelector('.general-chat-button').click()`)
          await wait(() => evaluate(`document.activeElement === window.visibleComposer()`), 'existing conversation focused')
          assert.equal(agents.size, 1)
        })
        await test('sends a question and displays a response without selecting a case or folder', async () => {
          await evaluate(`(() => { const el = window.visibleComposer(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '일반 질문은 어떻게 시작하나요?'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
          await wait(() => evaluate(`!window.visibleComposer().closest('.agent-panel').querySelector('.agent-send-btn').disabled`), 'composer ready')
          await evaluate(`window.visibleComposer().closest('.agent-panel').querySelector('.agent-send-btn').click()`)
          await wait(() => evaluate(`window.visibleComposer().closest('.agent-panel').textContent.includes('안녕하세요. 사건을 선택하지 않아도')`), 'mocked answer rendered')
          const sent = calls.find(call => call.channel === 'agent:send').args[0]
          assert.equal(sent.sessionId, first.id)
          assert.equal(sent.input.text, '일반 질문은 어떻게 시작하나요?')
          checkScope({ ...first, workspaceContext: sent.input.workspaceContext })
          assert.equal(calls.some(call => call.channel.startsWith('dialog:')), false)
          await capture(`conversation-${provider}`)
        })
        await test('new conversation keeps the same general-question scope', async () => {
          await evaluate(`document.querySelector('.work-right button[title="새 대화"]').click()`)
          await wait(() => agents.size === 2, 'new general-chat session')
          const second = [...agents.values()].find(agent => agent.id !== first.id)
          checkScope(second)
          assert.notEqual(second.id, first.id)
          assert.equal(second.cwd, first.cwd)
          await wait(() => evaluate(`window.visibleComposer()?.closest('.agent-panel').textContent.includes('무엇이 궁금하신가요?')`), 'new conversation empty state')
          assert.equal(calls.some(call => call.channel.startsWith('dialog:')), false)
        })
        await test('opens an existing case and returns to general questions', async () => {
          await wait(() => evaluate(`[...document.querySelectorAll('.case-sidebar-case')].some(el => el.textContent.includes('기존 거래대금 사건'))`), 'existing case entry')
          await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(el => el.textContent.includes('기존 거래대금 사건')).click()`)
          await wait(() => evaluate(`document.querySelector('.case-sidebar-case.active')?.textContent.includes('기존 거래대금 사건')`), 'existing case workspace')
          await evaluate(`document.querySelector('.case-sidebar-group.active .case-sidebar-new-task').click()`)
          await wait(() => [...agents.values()].some(agent => agent.cwd === caseDir), 'existing case agent')
          const caseAgent = [...agents.values()].find(agent => agent.cwd === caseDir)
          assert.equal(caseAgent.workspaceContext?.kind, 'folder', 'unlinked local case keeps its folder scope')
          assert.equal(caseAgent.provider, provider)
          assert.equal(await evaluate(`document.querySelector('.shell').classList.contains('general-chat')`), false, 'case work keeps the document/agent split')
          const before = agents.size
          await evaluate(`document.querySelector('.general-chat-button').click()`)
          await wait(() => evaluate(`document.activeElement === window.visibleComposer() && !document.querySelector('.case-sidebar-case.active')?.textContent.includes('기존 거래대금 사건')`), 'return to general chat')
          assert.equal(agents.size, before)
          await checkUnifiedChat()
          assert.equal(fs.readFileSync(path.join(caseDir, 'evidence.txt'), 'utf8'), 'Existing case evidence must stay untouched.')
          assert.equal(calls.some(call => call.channel === 'case:addHistory' && call.args[0]?.drafts === first.cwd), false, 'general chat does not become case history')
        })
      }
      assert.deepEqual(unexpected, [])
      assert.deepEqual(errors, [])
      app.exit(0)
    } catch (error) {
      await capture(`failure-${provider}${mode ? `-${mode}` : ''}`).catch(() => {})
      console.error(error)
      console.error(JSON.stringify({ errors, unexpected, dom: await evaluate('document.body.innerText').catch(() => '') }))
      app.exit(1)
    }
  })()
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const scenarios = process.argv.includes('--remote') ? [{ provider: 'codex', mode: '', remote: true }]
    : [{ provider: 'codex', mode: '' }, { provider: 'claude', mode: '' }, { provider: 'codex', mode: 'docOnly' }, { provider: 'codex', mode: 'termOnly' }, { provider: 'codex', mode: 'navigate' }]
  for (const scenario of scenarios) {
    const scenarioTemp = path.join(temp, `${scenario.provider}-${scenario.mode || 'main'}`)
    await fs.mkdir(scenarioTemp)
    const entry = path.join(scenarioTemp, 'main.cjs')
    await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp: scenarioTemp, screenshotDir, ...scenario })})`)
    const code = await new Promise((resolve, reject) => {
      const proc = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit' })
      proc.on('error', reject)
      proc.on('exit', resolve)
    })
    assert.equal(code, 0, `${scenario.provider}/${scenario.mode || 'main'} UI verification`)
  }
  const workspaceScreenshots = path.join(root, '.omx/state/general-chat-preview')
  await fs.mkdir(workspaceScreenshots, { recursive: true })
  for (const name of await fs.readdir(screenshotDir)) {
    if (name.endsWith('.png') && !name.startsWith('failure-')) await fs.copyFile(path.join(screenshotDir, name), path.join(workspaceScreenshots, name))
  }
  console.log(`Screenshots: ${workspaceScreenshots}`)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
