import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'case-sidebar-ui-'))
const screenshot = path.join(os.tmpdir(), 'legal-terminal-case-sidebar.png')
function runApp({ root, temp, screenshot }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const assert = require('node:assert/strict')
  const calls = [], errors = [], agents = new Map()
  const now = Date.now(), day = 86400000
  const profile = { id: 'server', label: '사무실', host: 'example.invalid', user: 'lawyer' }
  const history = [
    { drafts: '/cases/kim', name: '김민수 · 손해배상', ts: now },
    { drafts: '/cases/lee', name: '이서연 · 임대차보증금', ts: now - day },
    ...Array.from({ length: 5 }, (_, i) => ({ drafts: `/cases/history-${i}`, name: `이전 사건 ${i + 1}`, ts: now - (i + 2) * day })),
    { drafts: 'ssh://server/cases/kim', name: '박지훈 · 원격 사건', ts: now - 8 * day },
    { drafts: 'ssh://missing/cases/kim', name: '연결 설정이 없는 사건', ts: now - 9 * day }
  ]
  const snapshots = history.slice(0, 2).map((entry, i) => ({
    version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceOpen: true,
    currentCase: { drafts: entry.drafts, name: entry.name }, docs: [], activeTerm: `agent-${i}`,
    terminals: [{ id: `agent-${i}`, title: i ? '보증금 반환 검토' : '준비서면 쟁점 정리', kind: 'agent',
      agentProvider: 'claude', cwd: entry.drafts, resumeSessionId: `open-session-${i}`, createdAt: now - 60 * day }]
  }))
  const meta = { court: '서울중앙지방법원', caseNumber: '2026가단12345', caseName: '손해배상(기)', client: '김민수', opponent: '주식회사 대한건설', partyNames: '김민수 / 주식회사 대한건설' }
  snapshots[0].currentCase.meta = meta
  Object.assign(snapshots[0].terminals[0], meta)
  const remoteSnapshot = { version: 1, savedAt: new Date(now - 8 * day).toISOString(), workspaceOpen: false,
    currentCase: { drafts: '/cases/kim', name: '박지훈 · 원격 사건', meta: { caseNumber: '2026나123', caseName: '대여금', client: '박지훈', opponent: '김철수', partyNames: '박지훈 / 김철수' } },
    docs: [], terminals: [] }
  const sessions = Array.from({ length: 46 }, (_, i) => ({
    sessionId: `past-session-${i}`, title: `이전 작업 ${i}`, transcriptTitle: i === 0 ? '증거목록 검토' : `이전 작업 ${i}`,
    cwd: '/cases/kim', mtime: now - (i === 0 ? 2 : 9 + i) * day
  }))
  let failLee = true
  let delaySessionList = false
  let activeProfile = profile, holdDiscovery = false, releaseDiscovery
  app.setPath('userData', require('node:path').join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : callback)
  const real = new Set(['app:info', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'])
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (real.has(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return { sshProfiles: [activeProfile], notifyDone: false }
    if (channel === 'case:history' || channel === 'case:addHistory') return history
    if (channel === 'js:tokenStatus') return { hasToken: false, error: null }
    if (channel === 'js:hasToken') return false
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true, fetchedAt: new Date().toISOString() }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (['fs:list', 'fs:listPdfs'].includes(channel)) return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return { ok: true }
    if (channel === 'sessions:list') {
      const { cwd, ssh, limit } = args[0]
      if (delaySessionList) await new Promise((resolve) => setTimeout(resolve, 300))
      if (cwd === '/cases/lee' && failLee) throw Error('검증용 연결 오류')
      if (cwd !== '/cases/kim') return []
      if (ssh) return [{ sessionId: 'remote-session', title: '원격 기록 검토', cwd, mtime: now }]
      return [{ sessionId: 'open-session-0', title: '중복되면 안 되는 작업', mtime: now }, ...sessions].slice(0, limit ?? 40)
    }
    if (channel === 'sessions:transcript') return { sessionId: args[0], messages: [{ role: 'user', text: '사건의 쟁점을 검토해 주세요.' }] }
    if (channel === 'workspace:autoList') {
      if (!args[0]) return { ok: true, snapshots }
      if (holdDiscovery && args[0].host === profile.host) {
        await new Promise((resolve) => { releaseDiscovery = resolve })
        return { ok: true, snapshots: [{ ...remoteSnapshot, workspaceOpen: true, savedAt: new Date().toISOString(), currentCase: { drafts: '/cases/obsolete', name: '이전 서버에서 늦게 도착한 사건' } }] }
      }
      if (args[0].host !== profile.host) return { ok: true, snapshots: [{ ...remoteSnapshot, workspaceOpen: true, savedAt: new Date().toISOString(), currentCase: { drafts: '/cases/new-server', name: '변경된 서버의 사건' } }] }
      return { ok: true, snapshots: [remoteSnapshot] }
    }
    if (channel === 'workspace:autoLoad') return { ok: true, remote: { ok: true, snapshot: args[0].ssh ? remoteSnapshot : snapshots.find((s) => s.currentCase.drafts === args[0].cwd) } }
    if (channel === 'workspace:autoSave') return { ok: true }
    if (channel === 'workspace:list') return { ok: true, entries: [{ id: 'legacy', label: history[1].name, cwd: history[1].drafts, caseNumber: '2025가단54321', caseName: '임대차보증금', client: '이서연', savedAt: new Date().toISOString() }] }
    if (channel === 'workspace:autoObserve') return
    if (channel === 'agent:create') { agents.set(args[0].id, args[0]); return { ok: true } }
    if (channel === 'agent:snapshot') return { ok: true, session: agents.get(args[0]) }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:close') return { ok: true }
    if (channel === 'dialog:message') return { response: 0 }
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
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)) }
    throw Error('Timed out waiting for case sidebar')
  }
  const group = (title) => `[...document.querySelectorAll('.case-sidebar-group')].find(el => el.querySelector('.case-sidebar-case')?.textContent.includes(${JSON.stringify(title)}))`
  const clickText = (title, text) => evaluate(`[...${group(title)}.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(text)})).click()`)
  ;(async () => {
    try {
      await ready
      await wait(() => evaluate(`${group('김민수')}?.querySelector('.case-sidebar-case-participants')?.textContent.includes('대한건설')`))
      assert.equal(agents.size, 0, 'startup does not activate saved agents')
      assert.equal(calls.some((call) => ['sessions:list', 'sessions:transcript', 'workspace:autoLoad', 'workspace:autoSave'].includes(call.channel)), false, 'startup only discovers case names')
      assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-tasks').length`), 0, 'all groups start collapsed')
      assert.equal(await evaluate(`${group('김민수')}.querySelector('.case-sidebar-case-title').textContent`), '2026가단12345 손해배상(기)')
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('/cases/kim')`), false, 'paths do not crowd the party line')
      assert.equal(await evaluate(`${group('이서연')}.querySelector('.case-sidebar-case-participants').textContent`), '이서연', 'legacy history uses locally saved party information without opening the case')
      await evaluate(`${group('김민수')}.querySelector('.case-sidebar-case').click()`)
      await wait(() => agents.has('agent-0'))
      await wait(() => evaluate(`${group('김민수')}?.textContent.includes('증거목록 검토')`))
      assert.equal(agents.has('agent-1'), false, 'opening one case leaves other agents unloaded')
      assert.equal(calls.filter((call) => call.channel === 'workspace:autoLoad').length, 1)
      const readsBeforeFocus = calls.filter((call) => call.channel === 'sessions:list').length
      const discoveriesBeforeFocus = calls.filter((call) => call.channel === 'workspace:autoList').length
      await evaluate(`window.sidebarLoadingFlashed = false; window.sidebarObserver = new MutationObserver(() => { if (document.querySelector('.case-sidebar')?.textContent.includes('작업 불러오는 중')) window.sidebarLoadingFlashed = true }); window.sidebarObserver.observe(document.querySelector('.case-sidebar'), { childList: true, subtree: true, characterData: true }); window.dispatchEvent(new Event('focus'))`)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(calls.filter((call) => call.channel === 'sessions:list').length, readsBeforeFocus, 'focus reuses the fresh session list')
      assert.equal(calls.filter((call) => call.channel === 'workspace:autoList').length, discoveriesBeforeFocus, 'focus reuses case discovery')
      delaySessionList = true
      await evaluate(`${group('김민수')}.querySelector('.case-sidebar-refresh').click()`)
      await wait(() => calls.filter((call) => call.channel === 'sessions:list').length > readsBeforeFocus)
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('증거목록 검토')`), true, 'refresh keeps loaded rows')
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('작업 불러오는 중')`), false, 'refresh does not replace loaded data with loading text')
      await wait(() => evaluate(`!${group('김민수')}.querySelector('.case-sidebar-refresh').disabled`))
      assert.equal(await evaluate('window.sidebarLoadingFlashed'), false, 'no loading flash after focus or refresh')
      await evaluate('window.sidebarObserver.disconnect()')
      delaySessionList = false
      assert.equal(await evaluate(`document.querySelectorAll('.case-sidebar-group').length`), 6, 'initial case page')
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('이전 작업 1')`), false, 'old work is hidden initially')
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('중복되면')`), false, 'open and saved conversation are deduplicated')
      assert.equal(await evaluate(`${group('김민수')}.textContent.includes('준비서면 쟁점 정리')`), true, 'an older open task stays reachable')
      await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value = '14'; document.querySelector('select[aria-label="최근 작업 기간"]').dispatchEvent(new Event('change', { bubbles: true }))`)
      await wait(() => evaluate(`${group('김민수')}.textContent.includes('이전 작업 1')`))
      await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value = '7'; document.querySelector('select[aria-label="최근 작업 기간"]').dispatchEvent(new Event('change', { bubbles: true }))`)
      await clickText('김민수', '더 보기')
      await wait(() => evaluate(`${group('김민수')}.textContent.includes('이전 작업 1')`))
      for (let page = 0; page < 12 && !await evaluate(`${group('김민수')}.textContent.includes('이전 작업 45')`); page++) {
        await wait(() => evaluate(`!!${group('김민수')}.querySelector('.case-sidebar-more-tasks:not(:disabled)')`))
        await clickText('김민수', '더 보기')
      }
      await wait(() => evaluate(`${group('김민수')}.textContent.includes('이전 작업 45')`))
      assert.ok(calls.some((call) => call.channel === 'sessions:list' && call.args[0].limit > 40), 'older pages fetch beyond the initial server limit')
      await clickText('김민수', '최근 작업만')
      await evaluate(`${group('이서연')}.querySelector('.case-sidebar-toggle').click()`)
      await wait(() => evaluate(`${group('이서연')}.textContent.includes('다시 시도')`))
      failLee = false
      await clickText('이서연', '다시')
      await wait(() => evaluate(`!${group('이서연')}.textContent.includes('다시')`))
      await evaluate(`document.querySelector('.case-sidebar-more-cases').click()`)
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-group').length === 9`))
      assert.equal(calls.some((call) => call.channel === 'sessions:list' && call.args[0]?.cwd.includes('ssh://')), false, 'SSH URI never scanned as a local folder')
      const remoteReads = calls.filter((call) => call.channel === 'sessions:list' && call.args[0].ssh).length
      assert.equal(remoteReads, 0, 'more cases does not open remote histories')
      await evaluate(`${group('박지훈')}.querySelector('.case-sidebar-toggle').click()`)
      await wait(() => evaluate(`${group('박지훈')}?.textContent.includes('원격 기록 검토')`))
      assert.equal(calls.some((call) => call.channel === 'sessions:transcript' && call.args[1]), false, 'remote history expansion does not preload conversations')
      await clickText('박지훈', '원격 기록 검토')
      await wait(() => [...agents.values()].some((agent) => agent.resumeSessionId === 'remote-session'))
      const remote = [...agents.values()].find((agent) => agent.resumeSessionId === 'remote-session')
      assert.equal(remote.cwd, '/cases/kim')
      assert.equal(remote.ssh.host, profile.host, 'resume retains selected SSH host despite same local cwd')
      assert.equal(await evaluate(`${group('박지훈')}.querySelector('.case-sidebar-case-participants').textContent`), '박지훈 / 김철수', 'direct history resume preserves both parties from a closed case')
      await clickText('김민수', '증거목록 검토')
      await wait(() => [...agents.values()].some((agent) => agent.resumeSessionId === 'past-session-0'))
      const resumed = [...agents.values()].find((agent) => agent.resumeSessionId === 'past-session-0')
      assert.equal(resumed.cwd, '/cases/kim')
      assert.equal(resumed.ssh, undefined, 'switching from remote restores local source')
      const before = agents.size
      await clickText('김민수', '증거목록 검토')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(agents.size, before, 'repeated selection reuses the open task')
      await evaluate(`${group('이서연')}.querySelector('.case-sidebar-new-task').click()`)
      await wait(() => [...agents.values()].some((agent) => agent.cwd === '/cases/lee' && agent.id !== 'agent-1'))
      assert.equal(calls.some((call) => call.channel === 'agent:send'), false, 'navigation does not submit prompts')
      await evaluate(`[...document.querySelectorAll('.side-view-switch button')].find(el => el.textContent.includes('파일')).click()`)
      await wait(() => evaluate(`!!document.querySelector('.side-col > .sidebar')`))
      await evaluate(`[...document.querySelectorAll('.side-view-switch button')].find(el => el.textContent.includes('사건')).click()`)
      await wait(() => evaluate(`!!document.querySelector('.case-sidebar')`))
      assert.equal(await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value`), '7')
      await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value = '30'; document.querySelector('select[aria-label="최근 작업 기간"]').dispatchEvent(new Event('change', { bubbles: true }))`)
      await evaluate(`[...document.querySelectorAll('.side-view-switch button')].find(el => el.textContent.includes('파일')).click()`)
      await evaluate(`[...document.querySelectorAll('.side-view-switch button')].find(el => el.textContent.includes('사건')).click()`)
      assert.equal(await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value`), '30', 'chosen period survives sidebar remount')
      await evaluate(`document.querySelector('select[aria-label="최근 작업 기간"]').value = '7'; document.querySelector('select[aria-label="최근 작업 기간"]').dispatchEvent(new Event('change', { bubbles: true }))`)
      assert.equal(await evaluate(`!!${group('김민수')}.querySelector('.case-sidebar-tasks')`), false, 'remount keeps initial groups collapsed')
      await evaluate(`${group('김민수')}.querySelector('.case-sidebar-toggle').click()`)
      await evaluate(`${group('김민수')}.querySelector('.case-sidebar-toggle').click()`)
      assert.equal(await evaluate(`!!${group('김민수')}.querySelector('.case-sidebar-tasks')`), false, 'case can collapse')
      await evaluate(`${group('김민수')}.querySelector('.case-sidebar-toggle').click()`)
      await evaluate(`document.querySelector('.case-sidebar-add-case').click()`)
      await wait(() => evaluate(`!!document.querySelector('.new-case-launcher')`))
      await evaluate(`document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      await evaluate(`document.querySelector('.shell').style.setProperty('--side-pane-width', '160px')`)
      assert.equal(await evaluate(`document.querySelector('.case-sidebar').scrollWidth <= document.querySelector('.side-col').clientWidth`), true, 'minimum width does not overflow')
      await evaluate(`document.querySelector('.shell').style.setProperty('--side-pane-width', '272px')`)
      await clickText('김민수', '증거목록 검토')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      win.setSize(1440, 940)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await require('node:fs/promises').writeFile(screenshot, (await win.webContents.capturePage()).toPNG())
      holdDiscovery = true
      await evaluate(`window.dispatchEvent(new Event('online'))`)
      await wait(() => typeof releaseDiscovery === 'function')
      activeProfile = { ...profile, host: 'new-server.invalid', label: '새 사무실' }
      await evaluate(`window.dispatchEvent(new CustomEvent('lt:settings-updated', { detail: ${JSON.stringify({ sshProfiles: [activeProfile], notifyDone: false })} }))`)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      releaseDiscovery()
      await wait(() => evaluate(`document.querySelector('.case-sidebar').textContent.includes('변경된 서버의 사건')`))
      assert.equal(await evaluate(`document.querySelector('.case-sidebar').textContent.includes('이전 서버에서 늦게 도착한 사건')`), false, 'stale discovery cannot put a previous SSH host back in the sidebar')
      assert.equal(calls.some((call) => call.channel === 'workspace:autoLoad' && call.args[0].cwd === '/cases/new-server'), false)
      assert.deepEqual(errors, [])
      console.log('case sidebar UI: lazy startup, retained party labels, no refresh flash, pagination, retry, SSH source changes and resume isolation OK')
      console.log(`Screenshot: ${screenshot}`)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ errors, dom: await evaluate('document.body.innerText').catch(() => '') }))
      app.exit(1)
    }
  })()
}
await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshot })})`)
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
