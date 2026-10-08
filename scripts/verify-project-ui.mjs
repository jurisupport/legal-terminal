import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-ui-'))
const screenshotDir = path.join(os.tmpdir(), 'legal-terminal-project-preview')
const claudeAuthSmoke = process.argv.includes('--claude-auth')
const remoteAgentSmoke = process.argv.includes('--remote-agent')
const agentSmoke = process.argv.includes('--agent') || claudeAuthSmoke || remoteAgentSmoke
await fs.mkdir(screenshotDir, { recursive: true })

function runApp({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteAgentSmoke }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = []
  const agentProvider = claudeAuthSmoke ? 'claude' : 'codex'
  const agents = new Map(), workspaces = new Map()
  const caseDir = path.join(temp, 'case-a')
  const contextDir = path.join(temp, '공통 계약·증거')
  fs.mkdirSync(caseDir)
  fs.mkdirSync(contextDir)
  fs.writeFileSync(path.join(caseDir, 'evidence.txt'), 'keep this evidence')
  fs.writeFileSync(path.join(contextDir, 'contract.txt'), 'keep this context')
  const history = [
    { drafts: caseDir, name: 'A사 거래대금 청구', ts: Date.now() },
    { drafts: path.join(temp, 'case-b'), name: 'A사 채권 가압류', ts: Date.now() - 1000 }
  ]
  const jsCase = { id: 'js-1', caseNumber: '2026타채12345', caseName: 'A사 채권압류 및 추심', court: '서울중앙지방법원', division: null, caseType: 'civil', status: 'active', parties: [], hearings: [] }
  let connected = false, failSave = false, cancelFolder = false
  let profiles = [], caseOpenTarget = 'local', staleLocalWorkspace = null
  const workspaceKey = location => JSON.stringify([location.cwd, location.profileId ?? null, location.ssh?.host ?? null, location.ssh?.user ?? null])
  let pickedFolder = { path: contextDir, name: '공통 계약·증거' }
  app.setPath('userData', path.join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, cb) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : cb)
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'projects:save' && failSave) throw Error('검증용 저장 실패')
    if (channel === 'projects:workspace' && remoteAgentSmoke) {
      const project = JSON.parse(fs.readFileSync(path.join(temp, 'profile', 'projects.json'), 'utf8')).projects.find(project => project.id === args[0])
      if (project?.executionProfileId) return { project, cwd: `/home/lawyer/.legal-terminal/project-workspaces/${project.id}` }
    }
    if (channel.startsWith('projects:') || ['app:info', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'].includes(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return { sshProfiles: profiles, caseOpenTarget, notifyDone: false, agentDefaultProvider: agentSmoke ? agentProvider : 'claude' }
    if (channel === 'dialog:pickFolder') return cancelFolder ? null : pickedFolder
    if (channel === 'ssh:listDir') return { ok: true, cwd: args[0].path === '~/research' ? '/home/lawyer/research' : '/home/lawyer', entries: [] }
    if (channel === 'case:history' || channel === 'case:addHistory') return history
    if (channel === 'js:tokenStatus') return connected ? 'ok' : 'missing'
    if (channel === 'js:hasToken') return connected
    if (channel === 'js:listCases') return { ok: true, cases: connected ? [jsCase] : [] }
    if (channel === 'js:getCase') return { ok: true, case: jsCase }
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true, fetchedAt: new Date().toISOString() }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (['fs:list', 'fs:listPdfs', 'sessions:list'].includes(channel)) return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'fs:stat') return { ok: true, isDir: true, size: 0 }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return { ok: true }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoLoad') {
      if (agentSmoke) await new Promise(resolve => setTimeout(resolve, 60))
      return { ok: true, ...(staleLocalWorkspace ? { local: { ok: true, snapshot: staleLocalWorkspace } } : {}), remote: { ok: true, snapshot: workspaces.get(workspaceKey(args[0])) ?? null } }
    }
    if (channel === 'workspace:autoSave') {
      if (agentSmoke) workspaces.set(workspaceKey(args[0].location), args[0].snapshot)
      return { ok: true }
    }
    if (channel === 'workspace:autoObserve') return
    if (channel === 'workspace:list') return { ok: true, entries: [] }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:create') {
      const options = args[0]
      agents.set(options.id, { ...agents.get(options.id), ...options })
      setTimeout(() => {
        if (event.sender.isDestroyed()) return
        event.sender.send('agent:event', { type: 'auth:status', sessionId: options.id, state: 'authenticated' })
        event.sender.send('agent:event', { type: 'status', sessionId: options.id, status: 'idle' })
      }, 30)
      return { ok: true, sessionId: options.id }
    }
    if (channel === 'agent:snapshot') return { ok: true, session: agents.get(args[0]) }
    if (channel === 'agent:authLogin') {
      const sessionId = args[0]
      event.sender.send('agent:event', { type: 'auth:started', sessionId, source: 'local' })
      setTimeout(() => {
        event.sender.send('agent:event', { type: 'auth:done', sessionId, ok: true, exitCode: 0 })
        event.sender.send('agent:event', { type: 'auth:status', sessionId, state: 'authenticated' })
        event.sender.send('agent:event', { type: 'status', sessionId, status: 'idle' })
      }, 30)
      return { ok: true }
    }
    if (channel === 'agent:close' || channel === 'agent:setModel' || channel === 'agent:slashCommand') return { ok: true }
    if (channel === 'sessions:transcript') return { sessionId: args[0], messages: [{ role: 'user', text: '프로젝트 자료를 비교해 줘.' }] }
    if (channel === 'agent:send') {
      const { sessionId, input } = args[0]
      agents.set(sessionId, { ...agents.get(sessionId), resumeSessionId: `native-${sessionId}`, workspaceContext: input.workspaceContext })
      for (const status of ['working', 'done']) event.sender.send('agent:event', { type: 'status', sessionId, status })
      return { ok: true }
    }
    if (channel === 'dialog:message') return { response: 0 }
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true })))
  let win
  const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => {
    win = window
    win.setSize(1440, 940)
    window.webContents.on('console-message', details => { if (details.level === 'error' && !/검증용 저장 실패/.test(details.message)) errors.push(details.message) })
    window.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw Error(`Timed out: ${label}`)
  }
  const click = (label, scope = '.project-dashboard') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw Error('Missing button: '+${JSON.stringify(label)}); b.click() })()`)
  const fill = (name, value) => evaluate(`(() => { const el = document.querySelector('[name="${name}"]'); if (!el) throw Error('Missing field: ${name}'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 120))
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  ;(async () => {
    try {
      await ready
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-group').length === 2`), 'existing individual cases')
      await capture('existing-cases')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-dashboard') && !document.querySelector('.project-dashboard').textContent.includes('불러오는 중')`), 'projects without account')
      await capture('empty-projects')
      await click('+ 새 프로젝트')
      await fill('name', 'A사 거래대금 회수')
      await fill('goal', '거래대금 회수를 위해 관련 절차를 함께 관리합니다.')
      await fill('nextAction', '가압류 결정 확인 후 본안 증거목록 정리')
      await fill('notes', '계약서와 거래명세를 기준으로 공통 사실관계를 정리합니다.')
      await evaluate(`document.querySelectorAll('.project-case-option input[type="checkbox"]').forEach(el => el.click())`)
      cancelFolder = true
      await click('폴더 추가')
      await evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 0, 'cancelling folder picker leaves context unchanged')
      cancelFolder = false
      await click('폴더 추가')
      await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'folder context added')
      await click('폴더 추가')
      await evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 1, 'duplicate folder context deduplicated')
      await evaluate(`document.querySelector('.case-management-nav button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.dash-token')`), 'temporary individual-case navigation')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-editor')`), 'unfinished project restored')
      assert.equal(await evaluate(`document.querySelector('[name="name"]').value`), 'A사 거래대금 회수')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 1, 'draft retains folder context')
      await capture('project-editor')
      await click('프로젝트 만들기')
      await wait(() => evaluate(`document.querySelector('.project-detail')?.textContent.includes('A사 거래대금 회수')`), 'created detail')
      let projects = await evaluate('window.lt.projects.list()')
      assert.equal(projects.length, 1)
      assert.equal(projects[0].cases.length, 2)
      assert.deepEqual(projects[0].folders, [{ path: contextDir, name: '공통 계약·증거' }])
      assert.equal(projects[0].goal, '거래대금 회수를 위해 관련 절차를 함께 관리합니다.')
      const id = projects[0].id
      if (agentSmoke) {
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click(); document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => agents.size === 1 && evaluate(`!!document.querySelector('.work-right .agent-composer textarea')`), 'project agent created once')
        const first = [...agents.values()][0]
        assert.equal(first.workspaceContext.kind, 'project')
        assert.equal(first.workspaceContext.projectId, id)
        assert.equal(first.provider, agentProvider)
        assert.equal(first.ssh, undefined)
        assert.equal(first.cwd.startsWith(fs.realpathSync.native(path.join(temp, 'profile')) + path.sep), true, 'project workspace stays under the canonical app profile, including Windows short-path aliases')
        assert.notEqual(first.cwd, caseDir)
        assert.match(first.context, /프로젝트 작업 범위/)
        assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'opening a project never submits a prompt')
        await wait(() => evaluate(`document.querySelector('.work-right .agent-empty')?.textContent.includes('프로젝트') || document.querySelector('.work-right').textContent.includes('프로젝트의 현황')`), 'project-specific agent guidance')
        await evaluate(`(() => { const el = document.querySelector('.work-right .agent-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '연결 자료를 비교하고 근거를 구분해 줘.'); el.dispatchEvent(new Event('input', {bubbles:true})) })()`)
        await wait(() => evaluate(`!document.querySelector('.work-right .agent-send-btn').disabled`), 'project composer ready')
        if (claudeAuthSmoke) {
          const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed'
          win.webContents.send('agent:event', { type: 'auth:status', sessionId: first.id, state: 'unauthenticated', message: expired })
          win.webContents.send('agent:event', { type: 'error', sessionId: first.id, message: expired, recoverable: true })
          await wait(() => evaluate(`document.querySelector('.work-right .agent-auth-banner')?.textContent.includes('이 PC의 Claude 로그인이 필요합니다.')`), 'local Claude re-login guidance')
          assert.equal(await evaluate(`document.querySelector('.work-right .agent-send-btn').disabled`), true)
          assert.equal(await evaluate(`document.querySelector('.work-right .agent-composer textarea').value`), '연결 자료를 비교하고 근거를 구분해 줘.')
          await capture('project-claude-auth-expired')
          await evaluate(`document.querySelector('.work-right .agent-auth-banner button').click()`)
          await wait(() => calls.some(call => call.channel === 'agent:authLogin' && call.args[0] === first.id), 'local login action')
          await wait(() => evaluate(`!document.querySelector('.work-right .agent-auth-banner') && !document.querySelector('.work-right .agent-send-btn').disabled`), 'composer recovers after login')
          assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'login does not resubmit a failed request automatically')
        }
        await evaluate(`document.querySelector('.work-right .agent-send-btn').click()`)
        await wait(() => calls.some(call => call.channel === 'agent:send'), 'project input sent')
        const sent = calls.find(call => call.channel === 'agent:send').args[0]
        assert.equal(sent.input.workspaceContext.projectId, id)
        assert.equal(sent.input.workspaceContext.kind, 'project')
        await evaluate(`document.querySelector('[aria-label="프로젝트 대화 이어가기"]').click()`)
        await wait(() => evaluate(`!document.querySelector('[aria-label="프로젝트 대화 이어가기"]').disabled`), 'continue settles')
        assert.equal(agents.size, 1, 'continue reuses existing agent')
        await capture('project-ai-workspace')
        win.setMinimumSize(680, 480)
        win.setSize(900, 760)
        await capture('project-ai-narrow')
        assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'project detail fits beside agent in narrow window')
        win.setSize(1440, 940)
        await wait(() => workspaces.get(workspaceKey(first))?.terminals.some(term => term.resumeSessionId === `native-${first.id}`), 'project native session persisted')
        const second = await evaluate(`window.lt.projects.save({name:'B사 자문',goal:'별도 프로젝트',nextAction:'',notes:'',cases:[],folders:[],status:'active'})`)
        await click('← 프로젝트 목록')
        await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(el => el.textContent.includes('B사 자문'))`), 'second project shown')
        await evaluate(`[...document.querySelectorAll('.project-card')].find(el => el.textContent.includes('B사 자문')).click()`)
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => [...agents.values()].some(agent => agent.workspaceContext?.projectId === second.id), 'second project opens')
        const secondAgent = [...agents.values()].find(agent => agent.workspaceContext.projectId === second.id)
        assert.notEqual(first.id, secondAgent.id)
        assert.notEqual(first.cwd, secondAgent.cwd)
        agents.clear()
        await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
        await evaluate(`document.querySelector('.project-open-button').click()`)
        await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(el => el.textContent.includes('A사 거래대금 회수'))`), 'project list restored')
        await evaluate(`[...document.querySelectorAll('.project-card')].find(el => el.textContent.includes('A사 거래대금 회수')).click()`)
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => agents.has(first.id), 'same project conversation restored after restart')
        assert.equal(agents.get(first.id).resumeSessionId, `native-${first.id}`)
        assert.equal(agents.get(first.id).provider, agentProvider)
        assert.equal(agents.get(first.id).workspaceContext.projectId, id)
        assert.equal(agents.size, 1, 'other project stays unloaded')
        await evaluate(`document.querySelector('[aria-label="프로젝트 새 대화"]').click()`)
        await wait(() => agents.size === 2, 'explicit new project conversation')
        assert.ok([...agents.values()].every(agent => agent.workspaceContext.projectId === id && agent.cwd === first.cwd))
        assert.equal(calls.some(call => call.channel === 'case:addHistory' && call.args[0].drafts === first.cwd), false, 'project workspace is not reclassified as a case')
        if (remoteAgentSmoke) {
          profiles = [
            { id: 'office', label: '사무실 서버', host: 'office.invalid', user: 'lawyer', port: 2222, identityFile: '/keys/office' },
            { id: 'other', label: '다른 서버', host: 'other.invalid', user: 'lawyer' }
          ]
          caseOpenTarget = 'remote:office'
          await evaluate(`window.lt.settings.get().then(settings => window.dispatchEvent(new CustomEvent('lt:settings-updated', {detail: settings})))`)
          await click('프로젝트 수정')
          assert.equal(await evaluate(`document.querySelector('[name="executionProfileId"]').value`), '', 'existing projects stay local when app default becomes remote')
          await fill('executionProfileId', 'office')
          await capture('project-remote-editor')
          await click('변경사항 저장')
          await wait(() => evaluate(`document.querySelector('.project-execution-location')?.textContent.includes('사무실 서버')`), 'remote selection shown')
          assert.equal((await evaluate('window.lt.projects.list()')).find(project => project.id === id).executionProfileId, 'office', 'remote selection persists')
          const sendCount = calls.filter(call => call.channel === 'agent:send').length
          const openProject = () => evaluate(`document.querySelector('[aria-label="프로젝트 대화 이어가기"], [aria-label="프로젝트 AI 작업"]').click()`)
          await openProject()
          await wait(() => [...agents.values()].some(agent => agent.ssh?.host === 'office.invalid'), 'project agent on saved SSH host')
          const remote = [...agents.values()].find(agent => agent.ssh?.host === 'office.invalid')
          assert.equal(remote.provider, agentProvider, 'remote uses normal selected provider')
          assert.equal(remote.source, 'ssh')
          assert.deepEqual(remote.ssh, { host: 'office.invalid', user: 'lawyer', port: 2222, identityFile: '/keys/office', remoteControl: undefined })
          assert.equal(remote.workspaceContext.projectId, id)
          assert.equal(remote.cwd, `/home/lawyer/.legal-terminal/project-workspaces/${id}`)
          assert.notEqual(remote.id, first.id, 'local transcript is not reused for remote execution')
          const countBeforeContinue = agents.size
          await openProject()
          await wait(() => evaluate(`!document.querySelector('[aria-label="프로젝트 대화 이어가기"]').disabled`), 'remote continue settles')
          assert.equal(agents.size, countBeforeContinue, 'same remote location reuses its conversation')
          await wait(() => workspaces.get(workspaceKey({ ...remote, profileId: 'office' }))?.currentCase?.profileId === 'office', 'remote workspace persistence')
          const storedRemote = workspaces.get(workspaceKey({ ...remote, profileId: 'office' }))
          assert.equal(storedRemote.currentCase.drafts, `ssh://office${remote.cwd}`)
          assert.equal(storedRemote.currentCase.remotePath, remote.cwd)
          assert.equal(storedRemote.currentCase.ssh.host, 'office.invalid')
          await capture('project-remote-agent')

          profiles = profiles.map(profile => profile.id === 'office' ? { ...profile, host: 'replacement.invalid' } : profile)
          staleLocalWorkspace = structuredClone(storedRemote)
          staleLocalWorkspace.terminals.forEach(term => { term.resumeSessionId = 'old-host-session' })
          agents.clear()
          await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
          await evaluate(`document.querySelector('.project-open-button').click()`)
          await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(el => el.textContent.includes('A사 거래대금 회수'))`), 'remote project persisted after restart')
          await evaluate(`[...document.querySelectorAll('.project-card')].find(el => el.textContent.includes('A사 거래대금 회수')).click()`)
          const remoteCreatesBefore = calls.filter(call => call.channel === 'agent:create').length
          await openProject()
          await wait(() => calls.filter(call => call.channel === 'agent:create').length > remoteCreatesBefore, 'edited SSH host creates a separate conversation')
          const replacement = calls.filter(call => call.channel === 'agent:create').at(-1).args[0]
          assert.equal(replacement.ssh.host, 'replacement.invalid')
          assert.notEqual(replacement.id, remote.id, 'cached conversation from previous host is rejected')
          assert.equal(replacement.resumeSessionId, undefined)
          staleLocalWorkspace = null

          await click('프로젝트 수정')
          await fill('executionProfileId', 'other')
          await click('변경사항 저장')
          await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'other profile saved')
          await openProject()
          await wait(() => [...agents.values()].some(agent => agent.ssh?.host === 'other.invalid'), 'different profile creates a separate conversation')
          const other = [...agents.values()].find(agent => agent.ssh?.host === 'other.invalid')
          assert.notEqual(other.id, remote.id)
          assert.equal(other.source, 'ssh')
          assert.equal(other.cwd, remote.cwd, 'different hosts may use the same remote directory')
          assert.equal(calls.filter(call => call.channel === 'agent:send').length, sendCount, 'switching execution never submits a prompt')

          profiles = profiles.filter(profile => profile.id !== 'other')
          await evaluate(`window.lt.settings.get().then(settings => window.dispatchEvent(new CustomEvent('lt:settings-updated', {detail: settings})))`)
          const createsBeforeMissing = calls.filter(call => call.channel === 'agent:create').length
          await openProject()
          await wait(() => evaluate(`document.querySelector('.project-inline-error')?.textContent.includes('원격 연결 설정을 찾을 수 없습니다')`), 'missing profile failure')
          assert.equal(calls.filter(call => call.channel === 'agent:create').length, createsBeforeMissing, 'missing profile never falls back to local')
          await click('프로젝트 수정')
          assert.equal(await evaluate(`document.querySelector('[name="executionProfileId"] option:checked').textContent.includes('연결 설정 없음')`), true, 'removed profile is clearly shown in editor')
          await fill('executionProfileId', '')
          await click('변경사항 저장')
          await wait(() => evaluate(`document.querySelector('.project-execution-location')?.textContent.includes('이 PC')`), 'local selection restored')
          assert.equal((await evaluate('window.lt.projects.list()')).find(project => project.id === id).executionProfileId, undefined)
          await openProject()
          await wait(() => evaluate(`!document.querySelector('[aria-label="프로젝트 대화 이어가기"]').disabled`), 'local conversation reopened')
          await wait(() => [...agents.values()].some(agent => agent.source === 'local'), 'local transcript restored after changing location')
          assert.equal([...agents.values()].filter(agent => agent.source === 'local').every(agent => agent.cwd === first.cwd), true, 'switching back restores only local conversations')
          assert.equal(calls.some(call => call.channel === 'case:addHistory' && call.args[0].drafts === `ssh://office${remote.cwd}`), false, 'remote project never becomes an individual case')
          await click('← 프로젝트 목록')
          await click('+ 새 프로젝트')
          assert.equal(await evaluate(`document.querySelector('[name="executionProfileId"]').value`), 'office', 'new projects use known app execution default')
          await click('취소')
        }
        assert.deepEqual(errors, [])
        console.log(`project agent UI: scoped ${agentProvider} workspaces, ${remoteAgentSmoke ? 'SSH selection/persistence/host isolation/missing profile, ' : ''} ${claudeAuthSmoke ? 'local auth expiry/re-login/draft preservation, ' : ''}no automatic prompts, duplicate-click protection, durable resume, project isolation and new conversation OK`)
        app.exit(0)
        return
      }
      await capture('project-detail')
      await evaluate(`document.querySelector('.project-folder').scrollIntoView({ block: 'center' })`)
      await capture('project-context-folders')
      assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'no overflow')
      await evaluate(`document.querySelector('.project-folder button').click()`)
      await wait(() => evaluate(`!document.querySelector('.project-dashboard') && !!document.querySelector('.side-col > .sidebar')`), 'folder context opens in explorer')
      assert.ok(calls.some(call => call.channel === 'fs:list' && call.args[0] === contextDir), 'folder opened with its own root')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return from reference folder')
      await evaluate(`document.querySelector('.side-view-switch button').click()`)
      await evaluate(`document.querySelector('.project-member button').click()`)
      await wait(() => evaluate(`!document.querySelector('.project-dashboard') && !!document.querySelector('.case-sidebar-group.active')`), 'individual workspace from project')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return to same project')
      await click('프로젝트 수정')
      assert.equal(await evaluate(`document.querySelectorAll('.project-case-option').length`), 2, 'reference folders are not presented as cases')
      await fill('notes', '저장 실패에도 유지할 공통 메모')
      failSave = true
      await click('변경사항 저장')
      await wait(() => evaluate(`document.querySelector('.project-dashboard').textContent.includes('검증용 저장 실패')`), 'save error surfaced')
      assert.equal(await evaluate(`document.querySelector('[name="notes"]').value`), '저장 실패에도 유지할 공통 메모')
      failSave = false
      await fill('status', 'completed')
      await click('변경사항 저장')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'edited detail')
      projects = await evaluate('window.lt.projects.list()')
      assert.equal(projects[0].status, 'completed')
      assert.equal(projects[0].notes, '저장 실패에도 유지할 공통 메모')
      await evaluate(`document.querySelector('.case-management-nav button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.dash-token')`), 'individual case management unchanged')
      connected = true
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return for connected case')
      await click('프로젝트 수정')
      await wait(() => evaluate(`document.querySelector('.project-editor').textContent.includes('2026타채12345')`), 'connected case selection')
      await evaluate(`document.querySelector('.project-case-option input[value="js:js-1"]').click()`)
      await click('변경사항 저장')
      await wait(() => evaluate(`document.querySelectorAll('.project-member').length === 3`), 'three cases linked')
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-dashboard')`), 'reload project list')
      await evaluate(`document.querySelectorAll('.project-filters button')[1].click()`)
      await wait(() => evaluate(`document.querySelector('.project-card')?.textContent.includes('A사 거래대금 회수')`), 'completed filter after reload')
      await evaluate(`document.querySelector('.project-card').click()`)
      await wait(() => evaluate(`document.querySelectorAll('.project-member').length === 3`), 'durable cases after reload')
      assert.equal((await evaluate('window.lt.projects.list()'))[0].id, id)
      assert.deepEqual((await evaluate('window.lt.projects.list()'))[0].folders, [{ path: contextDir, name: '공통 계약·증거' }])
      win.setMinimumSize(680, 480)
      win.setSize(900, 760)
      await capture('project-narrow')
      assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'narrow view fits')
      win.setSize(1440, 940)
      await click('프로젝트 삭제')
      await click('프로젝트만 삭제')
      await wait(async () => (await evaluate('window.lt.projects.list()')).length === 0, 'delete persisted')
      assert.equal(fs.readFileSync(path.join(caseDir, 'evidence.txt'), 'utf8'), 'keep this evidence')
      assert.equal(fs.readFileSync(path.join(contextDir, 'contract.txt'), 'utf8'), 'keep this context')
      await click('+ 새 프로젝트')
      await fill('name', '판례 리서치 자료')
      await click('폴더 추가')
      await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'folder-only project context')
      await click('프로젝트 만들기')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'folder-only project saved')
      const folderOnly = (await evaluate('window.lt.projects.list()'))[0]
      assert.equal(folderOnly.cases.length, 0)
      assert.equal(folderOnly.folders.length, 1)
      await click('프로젝트 수정')
      await evaluate(`document.querySelector('.project-folder-option button').click()`)
      await click('변경사항 저장')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'folder unlink saved')
      assert.equal((await evaluate('window.lt.projects.list()'))[0].folders.length, 0)
      assert.equal(fs.readFileSync(path.join(contextDir, 'contract.txt'), 'utf8'), 'keep this context')
      pickedFolder = { path: caseDir, name: '사건 폴더 참조' }
      await click('프로젝트 수정')
      await click('폴더 추가')
      await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'existing case folder as reference')
      await click('변경사항 저장')
      await wait(() => evaluate(`!!document.querySelector('.project-folder')`), 'existing folder reference saved')
      await evaluate(`document.querySelector('.project-folder button').click()`)
      await wait(() => evaluate(`!document.querySelector('.project-dashboard')`), 'existing case folder opens')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return after case folder reference')
      await click('프로젝트 수정')
      assert.equal(await evaluate(`[...document.querySelectorAll('.project-case-option strong')].some(el => el.textContent === 'A사 거래대금 청구')`), true, 'opening case as reference preserves its case identity')
      await evaluate(`document.querySelector('.project-folder-option button').click()`)
      profiles = [{ id: 'office', label: '사무실 서버', host: 'example.invalid', user: 'lawyer' }]
      await click('폴더 추가')
      await wait(() => evaluate(`!!document.querySelector('.conn-menu')`), 'folder source chooser')
      await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[1].click()`)
      await wait(() => evaluate(`document.querySelector('.remote-cwd')?.textContent === '/home/lawyer'`), 'remote folder browser')
      await evaluate(`(() => { const el = document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '~/research'); el.dispatchEvent(new Event('input', {bubbles:true})) })()`)
      await click('입력 경로 선택', '.remote-picker')
      await wait(() => evaluate(`document.querySelector('.project-folder-option')?.textContent.includes('ssh://office/home/lawyer/research')`), 'relative remote path resolves before storing')
      await click('변경사항 저장')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'remote folder context saved')
      assert.equal((await evaluate('window.lt.projects.list()'))[0].folders[0].path, 'ssh://office/home/lawyer/research')
      await evaluate(`document.querySelector('.project-folder button').click()`)
      await wait(() => evaluate(`!document.querySelector('.project-dashboard')`), 'remote folder opens')
      await wait(() => calls.some(call => call.channel === 'fs:list' && call.args[0] === 'ssh://office/home/lawyer/research'), 'remote reference folder source')
      assert.equal(calls.some(call => ['fs:delete', 'agent:send'].includes(call.channel)), false, 'project operations do not alter files or send prompts')
      assert.deepEqual(errors, [])
      console.log('project UI: cases/folder context, folder-only projects, durable CRUD, draft recovery, filtering, navigation, responsive layout and preserved files OK')
      console.log(`Screenshots: ${screenshotDir}`)
      app.exit(0)
    } catch (error) {
      await capture('failure').catch(() => {})
      console.error(error)
      console.error(JSON.stringify({ errors, dom: await evaluate('document.body.innerText').catch(() => '') }))
      app.exit(1)
    }
  })()
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteAgentSmoke })})`)
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
