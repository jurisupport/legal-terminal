import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Build first: npm run build && node scripts/verify-detached-agent-window.mjs
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-agent-window-'))

function runApp({ root, temp, closeMode }) {
  const { app, BrowserWindow, ipcMain, screen, session } = require('electron')
  const assert = require('node:assert/strict')
  const calls = [], errors = [], windows = [], sessions = new Map()
  const fs = require('node:fs'), path = require('node:path')
  const sharedUiModule = { exports: {} }, uiStates = new Map()
  const ts = require(path.join(root, 'node_modules/typescript'))
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/shared/sharedUiState.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  require('node:vm').runInNewContext(code, { module: sharedUiModule, exports: sharedUiModule.exports })
  const isFork = closeMode.startsWith('fork')
  const provider = closeMode === 'fork-codex' ? 'codex' : 'claude'
  const movedAgentOwners = new Map()
  let draggedAgentId
  const profile = { id: 'detached-test', label: '검증 서버', host: 'example.invalid', user: 'test' }
  const cwd = '/cases/detached-window'
  const recent = { drafts: `ssh://${profile.id}${cwd}`, name: '창 분리 검증', ts: Date.now() }
  const snapshot = {
    version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceOpen: true,
    currentCase: { drafts: cwd, name: recent.name }, activeTerm: 'moved-agent', docs: [],
    terminals: [
      { id: 'moved-agent', title: '이동할 대화', renamed: true, kind: 'agent', agentProvider: provider, cwd, resumeSessionId: 'moved-session' },
      { id: 'retained-agent', title: '남아 있을 대화', kind: 'agent', agentProvider: 'claude', cwd, resumeSessionId: 'retained-session' }
    ]
  }
  let blockedSaveWindow = null
  let failNewWindow = false
  app.setPath('userData', require('node:path').join(temp, closeMode))
  const home = require('node:path').join(temp, closeMode, 'home')
  require('node:fs').mkdirSync(home, { recursive: true })
  app.setPath('home', home)
  // Keep the real windows hidden. Focus refresh uses backend ownership state,
  // which belongs to the separate workspace regression rather than this mock.
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
  BrowserWindow.prototype.focus = function () {}
  app.whenReady().then(() => { screen.getCursorScreenPoint = () => ({ x: 30000, y: -30000 }) })
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  const real = new Set([
    'app:info', 'app:generalChatDirectory', 'app:setWindowTitle', 'tabs:ready', 'tabs:beginDrag', 'tabs:endDrag',
    'tabs:dropOnTabBar', 'window:close', 'window:forceClose', 'window:new',
    'caseManagement:get', 'caseManagement:update'
  ])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id
    calls.push({ channel, windowId, args, at: Date.now() })
    if (real.has(channel)) {
      if (channel === 'window:new' && failNewWindow) throw Error('새 창 열기 실패 검증')
      if (channel === 'tabs:beginDrag') draggedAgentId = args[0]?.kind === 'terminal' && args[0].tab?.kind === 'agent' ? args[0].tab.id : undefined
      const windowCount = windows.length
      const result = await handler(event, ...args)
      if (draggedAgentId && result?.action === 'moved') {
        if (channel === 'tabs:dropOnTabBar') movedAgentOwners.set(draggedAgentId, event.sender.id)
        else if (channel === 'tabs:endDrag' && windows.length > windowCount) movedAgentOwners.set(draggedAgentId, windows.at(-1).webContents.id)
      }
      return result
    }
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
    if (channel === 'sessions:transcript') return { sessionId: args[0].sessionId, messages: isFork
      ? [{ role: 'user', text: '진행 중인 원본 질문' }, { role: 'assistant', text: '원본 답변 맥락' }] : [] }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: args[0] ? [snapshot] : [] }
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    // Match workspaceForWindow: moved conversations belong to their receiving window.
    if (channel === 'workspace:autoLoad') return { ok: true, remote: { ok: true, snapshot: args[0].cwd === cwd ? {
      ...snapshot,
      terminals: snapshot.terminals.filter(tab => !movedAgentOwners.has(tab.id) || movedAgentOwners.get(tab.id) === event.sender.id)
    } : null } }
    if (channel === 'workspace:sharedUiRead' || channel === 'workspace:sharedUiApply') {
      const host = `${args[0].user}@${args[0].host}:${args[0].port ?? 22}`
      const state = uiStates.get(host) ?? sharedUiModule.exports.emptySharedUiState()
      if (channel === 'workspace:sharedUiApply') sharedUiModule.exports.applySharedUiOperation(state, args[1])
      uiStates.set(host, state)
      return { ok: true, state: structuredClone(state) }
    }
    if (channel === 'workspace:autoObserve') return undefined
    if (channel === 'workspace:autoSave') {
      if (windowId === blockedSaveWindow) return new Promise(() => {})
      return { ok: true }
    }
    if (channel === 'agent:create') { sessions.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:send') return { ok: true }
    if (channel === 'agent:close') return { ok: true }
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })
  ))
  app.on('browser-window-created', (_event, win) => {
    windows.push(win)
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
  })
  require(require('node:path').join(root, 'out/main/index.js'))
  const evaluate = (win, source) => win.webContents.executeJavaScript(source, true)
  const wait = async (label, check) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw Error(`Timed out: ${label}`)
  }
  const tabTitles = (win) => evaluate(win, `[...document.querySelectorAll('.tab .tab-title')].map(tab => tab.textContent.replace(/^Agent · /, ''))`)
  const saves = (win) => calls.filter((call) => call.channel === 'workspace:autoSave' && call.windowId === win.id && call.args[0].location.cwd === cwd)
  const dragStart = (win, title) => evaluate(win, `(() => {
    const tab = [...document.querySelectorAll('.tab')].find(tab => tab.innerText.includes(${JSON.stringify(title)}));
    if (!tab || !tab.draggable) throw Error('Draggable tab missing');
    window.testDraggedTab = tab;
    window.testDragData = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.testDragData }));
  })()`)
  const dragEnd = (win) => evaluate(win, `window.testDraggedTab.dispatchEvent(new DragEvent('dragend', {
    bubbles: true, cancelable: true, dataTransfer: window.testDragData
  }))`)
  const tearOut = async (source, { blockSave = false } = {}) => {
    const before = windows.length
    await dragStart(source, '이동할 대화')
    await dragEnd(source)
    await wait('new detached window', () => windows.length === before + 1)
    const detached = windows.at(-1)
    if (blockSave) blockedSaveWindow = detached.id
    await wait('detached tab received', async () => (await tabTitles(detached)).includes('이동할 대화'))
    await wait('source tab removed', async () => !(await tabTitles(source)).includes('이동할 대화'))
    assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')), ['남아 있을 대화'])
    await wait('detached automatic save after debounce', () => saves(detached).length > 0)
    assert.deepEqual(saves(detached).at(-1).args[0].snapshot.terminals.map((tab) => tab.id), ['moved-agent'],
      'automatic save keeps only the conversation that was dragged out')
    assert.deepEqual(await tabTitles(detached), ['이동할 대화'],
      'the detached window still contains exactly one conversation after automatic save')
    assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' && call.windowId === detached.id), false,
      'saving a detached tab does not restore the entire shared case')
    return detached
  }
  ;(async () => {
    try {
      await wait('main window', () => windows.length > 0)
      const source = windows[0]
      await wait('case discovery', () => evaluate(source, `[...document.querySelectorAll('.case-sidebar-case')].some(tab => tab.textContent.includes(${JSON.stringify(recent.name)}))`))
      await evaluate(source, `[...document.querySelectorAll('.case-sidebar-case')].find(tab => tab.textContent.includes(${JSON.stringify(recent.name)})).click()`)
      await wait('two source conversations', async () => (await tabTitles(source)).filter((title) => title.includes('대화')).length === 2)
      await wait('initial source workspace save', () => saves(source).length > 0)

      if (isFork) {
        const button = `document.querySelector('.agent-panel[data-visible="true"] .agent-ask-beside')`
        const input = `document.querySelector('.agent-panel[data-visible="true"] textarea')`
        const sourceTitles = await tabTitles(source)
        await evaluate(source, `(() => {
          const input = ${input};
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '원본에 남길 입력');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        source.webContents.send('agent:event', { type: 'status', sessionId: 'moved-agent', status: 'working' })
        await wait('source is working', () => evaluate(source, `!!document.querySelector('.tab.working')`))
        await evaluate(source, `${button}.click()`)
        await wait('fork window', () => windows.length === 2)
        const detached = windows.at(-1)
        await wait('fork context sent', () => calls.some(call => call.channel === 'agent:send' && call.windowId === detached.id))
        const payload = calls.find(call => call.channel === 'window:new').args[0]
        const fork = payload.tabs[0].tab
        assert.equal(payload.termOnly, true)
        assert.notEqual(fork.id, 'moved-agent')
        assert.equal(fork.resumeSessionId, undefined)
        assert.equal(fork.forkFromSessionId, 'moved-session')
        assert.equal(fork.agentProvider, provider)
        assert.equal(fork.cwd, cwd)
        assert.equal(fork.ssh.host, profile.host)
        assert.equal(await evaluate(detached, 'location.hash'), '#termOnly')
        assert.deepEqual(await tabTitles(detached), ['이동할 대화 · 옆에서 물어보기'])
        assert.deepEqual(await tabTitles(source), sourceTitles)
        assert.equal(await evaluate(source, `${input}.value`), '원본에 남길 입력')
        assert.equal(await evaluate(detached, `${input}.value`), '')
        assert.equal(await evaluate(source, `!!document.querySelector('.tab.active.working')`), true)
        const send = calls.find(call => call.channel === 'agent:send' && call.windowId === detached.id)
        assert.equal(send.args[0].sessionId, fork.id)
        assert.match(send.args[0].input.text, /진행 중인 원본 질문/)
        assert.match(send.args[0].input.text, /원본 답변 맥락/)
        assert.match(send.args[0].input.text, /아직 새 작업을 시작하지 말고/)
        assert.equal(calls.some(call => call.channel === 'agent:send' && call.windowId === source.id), false)
        await wait('fork saves only itself', () => saves(detached).length > 0)
        assert.deepEqual(saves(detached).at(-1).args[0].snapshot.terminals.map(tab => tab.id), [fork.id])
        if (process.env.AGENT_FORK_SCREENSHOT_DIR) {
          const dir = process.env.AGENT_FORK_SCREENSHOT_DIR
          require('node:fs').mkdirSync(dir, { recursive: true })
          for (const [name, win] of [['source', source], ['fork', detached]]) {
            require('node:fs').writeFileSync(require('node:path').join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
          }
        }
        detached.close()
        await wait('fork closes', () => detached.isDestroyed())
        assert.equal(calls.some(call => call.channel === 'agent:close' && call.args[0] === 'moved-agent'), false)
        assert.equal(source.isDestroyed(), false)
        failNewWindow = true
        await evaluate(source, `${button}.click()`)
        await wait('window failure shown and retry enabled', () => evaluate(source,
          `document.body.innerText.includes('새 창 열기 실패 검증') && !${button}.disabled`))
        assert.deepEqual(await tabTitles(source), sourceTitles)
        assert.equal(await evaluate(source, `${input}.value`), '원본에 남길 입력')
        failNewWindow = false
        await evaluate(source, `document.querySelector('.agent-panel[data-visible="true"] button[aria-label="Fork"]').click()`)
        await wait('existing fork stays in source window', async () => (await tabTitles(source)).includes('이동할 대화 · fork'))
        await wait('existing fork receives context', () => calls.some(call => call.channel === 'agent:send' && call.windowId === source.id))
        assert.equal(windows.length, 2, 'the original Fork action does not open another window')
        assert.equal(await evaluate(source, `${input}.value`), '원본에 남길 입력', 'the original Fork action still transfers its draft')
        assert.deepEqual(errors, [])
        console.log(`PASS: ${provider} side question preserves context, running source and draft; failure handling and original Fork still work`)
        app.exit(0)
        return
      }

      if (closeMode === 'native') {
        const detached = await tearOut(source)
        console.log('PASS: dragging one conversation keeps the other in the source and saves only the moved tab')

        await dragStart(detached, '이동할 대화')
        await evaluate(source, `(() => {
          const bar = document.querySelector('.work-right > .tabs');
          if (!bar) throw Error('Source tab bar missing');
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('application/x-legal-terminal-tab', 'moved-agent');
          bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        })()`)
        await dragEnd(detached)
        await wait('empty detached window closes after moving back', () => detached.isDestroyed())
        await wait('both conversations back in source', async () => (await tabTitles(source)).filter((title) => title.includes('대화')).length === 2)
        assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')).sort(), ['남아 있을 대화', '이동할 대화'].sort())
        console.log('PASS: moving the conversation back restores it once and closes the empty detached window')

      }

      const blocked = await tearOut(source, { blockSave: true })
      if (closeMode === 'native') blocked.close()
      else await evaluate(blocked, `document.querySelector('.tab-close').click()`)
      await wait('detached close while workspace save is unresolved', () => blocked.isDestroyed())
      assert.deepEqual(saves(blocked).at(-1).args[0].snapshot.terminals.map((tab) => tab.id),
        closeMode === 'tab' ? [] : ['moved-agent'],
        'dispatch the final tab list before destroying the window so a closed tab cannot reappear')
      assert.equal(calls.some((call) => call.channel === 'window:forceClose' && call.windowId === blocked.id), true,
        'native close request goes through the real renderer close guard')
      assert.equal(source.isDestroyed(), false)
      assert.deepEqual((await tabTitles(source)).filter((title) => title.includes('대화')), ['남아 있을 대화'])
      assert.equal(calls.some((call) => call.channel === 'agent:close' && call.args[0] === 'retained-agent'), false,
        'closing the detached window never stops the conversation left in the source')
      assert.equal(calls.some((call) => call.channel === 'agent:send' || call.channel === 'dialog:message'), false)
      assert.deepEqual(errors, [])
      console.log(`PASS: detached ${closeMode === 'native' ? 'native window' : 'tab button'} close completes even while automatic workspace save never resolves`)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, calls: calls.map(({ channel, windowId, args }) => ({ channel, windowId, ...(channel === 'workspace:autoSave' ? { tabs: args[0].snapshot.terminals.map(tab => tab.id) } : {}) })), windows: await Promise.all(windows.map(async (win) => ({
        id: win.id, destroyed: win.isDestroyed(),
        text: win.isDestroyed() ? '' : await evaluate(win, 'document.body.innerText').catch(() => '')
      }))) }))
      app.exit(1)
    }
  })()
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  for (const closeMode of ['native', 'tab', 'fork', 'fork-codex']) {
    const entry = path.join(temp, `${closeMode}.cjs`)
    await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp, closeMode })})`)
    const code = await new Promise((resolve, reject) => {
      const proc = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit' })
      const watchdog = setTimeout(() => { proc.kill('SIGKILL') }, 45000)
      proc.on('error', reject)
      proc.on('exit', (code) => { clearTimeout(watchdog); resolve(code) })
    })
    assert.equal(code, 0, `${closeMode} close scenario`)
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
