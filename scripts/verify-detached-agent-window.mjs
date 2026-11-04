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
  let failSend = closeMode === 'fork-failure'
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
    'tabs:dropOnTabBar', 'window:close', 'window:forceClose', 'window:new'
  ])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id
    calls.push({ channel, windowId, args, at: Date.now() })
    if (real.has(channel)) {
      if (channel === 'tabs:beginDrag') draggedAgentId = args[0]?.kind === 'terminal' && args[0].tab?.kind === 'agent' ? args[0].tab.id : undefined
      const windowCount = windows.length
      const result = await handler(event, ...args)
      if (draggedAgentId && result?.action === 'moved') {
        if (channel === 'tabs:dropOnTabBar') movedAgentOwners.set(draggedAgentId, event.sender.id)
        else if (channel === 'tabs:endDrag' && windows.length > windowCount) movedAgentOwners.set(draggedAgentId, windows.at(-1).webContents.id)
      }
      return result
    }
    if (channel === 'settings:get') return { sshProfiles: [profile], notifyDone: false }
    if (channel === 'case:history' || channel === 'case:addHistory') return [recent]
    if (channel === 'js:tokenStatus') return { hasToken: false, error: null }
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
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
    // The shared case still has both conversations. A detached window must never
    // load it just to save its single tab. Ownership merging is tested separately.
    if (channel === 'workspace:autoLoad') return { ok: true, remote: { ok: true, snapshot: args[0].cwd === cwd ? {
      ...snapshot,
      // Match workspaceForWindow: transferred tabs belong only to the receiving window.
      terminals: snapshot.terminals.filter(tab => !movedAgentOwners.has(tab.id) || movedAgentOwners.get(tab.id) === event.sender.id)
    } : null } }
    if (channel === 'workspace:autoObserve') return undefined
    if (channel === 'workspace:sharedUiRead' || channel === 'workspace:sharedUiApply') return { ok: true,
      state: { version: 1, revision: 0, selection: { caseKey: null, tab: null }, cases: {}, appliedOperationIds: [] } }
    if (channel === 'workspace:autoSave') {
      if (windowId === blockedSaveWindow) return new Promise(() => {})
      return { ok: true }
    }
    if (channel === 'agent:create') { sessions.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') {
      if (isFork) event.sender.send('agent:event', { type: 'auth:status', sessionId: args[0], state: 'authenticated' })
      return { ok: true, session: sessions.get(args[0]) }
    }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'fs:stat') return { ok: true, isDir: false }
    if (channel === 'agent:send') {
      if (failSend) { failSend = false; return { ok: false, error: '포크 질문 전송 실패 검증' } }
      return { ok: true }
    }
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
        const panel = `document.querySelector('.agent-panel[data-visible="true"]')`
        const button = `[...${panel}.querySelectorAll('button')].find(button => button.textContent.includes('같은 맥락으로 질문'))`
        const input = `${panel}.querySelector('textarea')`
        const pending = `${panel}.querySelectorAll('.agent-attachments.pending .agent-attachment-pending')`
        const sourceTitles = await tabTitles(source)
        const draft = '새 탭에서 바로 물어볼 질문\n작성해 둔 자세한 내용'
        const writeDraft = (text) => evaluate(source, `(() => {
          const input = ${input};
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        const attach = async () => {
          await evaluate(source, `(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('application/x-lt-path', ${JSON.stringify(`ssh://${profile.id}${cwd}/참고자료.md`)});
            ${panel}.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
          })()`)
          await wait('draft attachment', () => evaluate(source, `${pending}.length === 1`))
        }
        const selectSource = () => evaluate(source,
          `[...document.querySelectorAll('.tab')].find(tab => tab.querySelector('.tab-title')?.textContent.replace(/^Agent · /, '') === '이동할 대화').click()`)
        const sends = () => calls.filter(call => call.channel === 'agent:send')
        if (provider === 'codex') {
          source.webContents.send('agent:event', { type: 'message:user', sessionId: 'moved-agent', messageId: 'restored-user', text: '진행 중인 원본 질문' })
          source.webContents.send('agent:event', { type: 'message:assistant_delta', sessionId: 'moved-agent', messageId: 'restored-answer', text: '원본 답변 맥락' })
          source.webContents.send('agent:event', { type: 'message:assistant_done', sessionId: 'moved-agent', messageId: 'restored-answer' })
        }
        await wait('source transcript loaded', () => evaluate(source, `${panel}.innerText.includes('원본 답변 맥락')`))
        assert.equal(await evaluate(source, `Boolean(${button})`), false, 'fork-and-send is only shown while the source is busy')
        source.webContents.send('agent:event', { type: 'status', sessionId: 'moved-agent', status: 'working' })
        source.webContents.send('agent:event', { type: 'message:assistant_delta', sessionId: 'moved-agent', messageId: 'live-reply', text: '아직 저장되지 않은 진행 중 답변' })
        await wait('source is working', () => evaluate(source, `!!document.querySelector('.tab.working') && Boolean(${button})`))
        assert.equal(await evaluate(source, `${button}.disabled`), true, 'empty draft cannot create and send a fork')
        await writeDraft(draft)
        await attach()
        await wait('fork question enabled', () => evaluate(source, `!${button}.disabled`))
        const screenshot = async (name) => {
          if (!process.env.AGENT_FORK_SCREENSHOT_DIR) return
          const dir = process.env.AGENT_FORK_SCREENSHOT_DIR
          require('node:fs').mkdirSync(dir, { recursive: true })
          require('node:fs').writeFileSync(require('node:path').join(dir, `${closeMode}-${name}.png`), (await source.webContents.capturePage()).toPNG())
        }
        await screenshot('source')
        await evaluate(source, `${button}.click()`)
        await wait('fork question sent', () => sends().length === 1)
        const send = sends()[0]
        const fork = sessions.get(send.args[0].sessionId)
        assert.ok(fork)
        assert.notEqual(fork.id, 'moved-agent')
        assert.equal(fork.resumeSessionId, undefined)
        assert.equal(fork.provider, provider)
        assert.equal(fork.cwd, cwd)
        assert.equal(fork.ssh.host, profile.host)
        assert.equal(send.windowId, source.id)
        assert.equal(send.args[0].input.delivery, 'normal')
        for (const text of ['진행 중인 원본 질문', '원본 답변 맥락', '아직 저장되지 않은 진행 중 답변', draft]) {
          assert.ok(send.args[0].input.text.includes(text), `fork request includes ${text}`)
        }
        assert.doesNotMatch(send.args[0].input.text, /아직 새 작업을 시작하지 말고/)
        assert.equal(send.args[0].input.attachments.length, 1)
        assert.equal(send.args[0].input.attachments[0].path, `${cwd}/참고자료.md`)
        assert.equal(windows.length, 1)
        assert.equal(calls.some(call => call.channel === 'window:new'), false)
        assert.deepEqual(await tabTitles(source), [...sourceTitles, '이동할 대화 · fork'])
        assert.equal(await evaluate(source, `document.querySelector('.tab.active .tab-title').textContent.includes('fork')`), true)
        if (closeMode === 'fork-failure') {
          await wait('failed send restores draft and attachment', () => evaluate(source,
            `${panel}.innerText.includes('포크 질문 전송 실패 검증') && ${input}.value === ${JSON.stringify(draft)} && ${pending}.length === 1`))
          await evaluate(source, `${panel}.querySelector('.agent-send-btn').click()`)
          await wait('retry sends in same fork', () => sends().length === 2)
          assert.deepEqual(sends()[1].args[0], send.args[0], 'retry retains context, question and attachment')
        }
        await wait('sent fork draft clears', () => evaluate(source, `${input}.value === '' && ${pending}.length === 0`))
        await screenshot('fork')
        await selectSource()
        assert.equal(await evaluate(source, `${input}.value`), '', 'the source draft moves instead of duplicating')
        assert.equal(await evaluate(source, `${pending}.length`), 0)
        assert.equal(await evaluate(source, `!!document.querySelector('.tab.active.working')`), true)
        assert.equal(calls.some(call => ['agent:interrupt', 'agent:close'].includes(call.channel) && call.args[0] === 'moved-agent'), false)
        assert.equal(sends().some(call => call.args[0].sessionId === 'moved-agent'), false)

        const sendCount = sends().length
        await writeDraft('일반 Fork에서 이어서 쓸 입력')
        await attach()
        await evaluate(source, `${panel}.querySelector('button[aria-label="Fork"]').click()`)
        await wait('original Fork primes context', () => sends().length === sendCount + 1)
        assert.equal(windows.length, 1)
        assert.equal(await evaluate(source, `${input}.value`), '일반 Fork에서 이어서 쓸 입력')
        assert.equal(await evaluate(source, `${pending}.length`), 1)
        assert.match(sends().at(-1).args[0].input.text, /진행 중인 원본 질문/)
        assert.match(sends().at(-1).args[0].input.text, /아직 새 작업을 시작하지 말고/)
        assert.ok(!sends().at(-1).args[0].input.text.includes('일반 Fork에서 이어서 쓸 입력'))
        assert.deepEqual(errors, [])
        console.log(`PASS: ${provider} fork sends draft, attachment and live context once in a new tab; source keeps running; original Fork preserves draft${closeMode === 'fork-failure' ? '; failed send restores draft for retry' : ''}`)
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
  for (const closeMode of ['native', 'tab', 'fork', 'fork-codex', 'fork-failure']) {
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
