import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-ui-')))
const screenshotDir = path.join(os.tmpdir(), 'legal-terminal-project-preview')
const claudeAuthSmoke = process.argv.includes('--claude-auth')
const remoteSmoke = process.argv.includes('--remote')
const agentSmoke = process.argv.includes('--agent') || claudeAuthSmoke || remoteSmoke
await fs.mkdir(screenshotDir, { recursive: true })

function runApp({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteSmoke }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = []
  const agentProvider = claudeAuthSmoke ? 'claude' : 'codex'
  const agents = new Map(), workspaces = new Map()
  const caseDir = path.join(temp, 'case-a')
  const contextDir = path.join(temp, '공통 계약·증거')
  const workspaceDir = path.join(temp, '프로젝트 작성·작업 폴더')
  const changedWorkspaceDir = path.join(temp, '변경한 프로젝트 작업 폴더')
  fs.mkdirSync(caseDir)
  fs.mkdirSync(contextDir)
  fs.mkdirSync(workspaceDir)
  fs.mkdirSync(changedWorkspaceDir)
  fs.writeFileSync(path.join(workspaceDir, 'prior-work.txt'), 'keep prior workspace files')
  fs.writeFileSync(path.join(changedWorkspaceDir, 'existing-work.txt'), 'keep destination files')
  fs.writeFileSync(path.join(caseDir, 'evidence.txt'), 'keep this evidence')
  fs.writeFileSync(path.join(contextDir, 'contract.txt'), 'keep this context')
  const history = [
    { drafts: caseDir, name: 'A사 거래대금 청구', ts: Date.now() },
    { drafts: path.join(temp, 'case-b'), name: 'A사 채권 가압류', ts: Date.now() - 1000 }
  ]
  const jsCase = { id: 'js-1', caseNumber: '2026타채12345', caseName: 'A사 채권압류 및 추심', court: '서울중앙지방법원', division: null, caseType: 'civil', status: 'active', parties: [], hearings: [] }
  let connected = false, failSave = false, cancelFolder = false, expectConflictError = false, expectDeletedError = false, failWorkspace = false, expectWorkspaceError = false
  let workspaceGate = null
  let cancelWorkspacePicker = false, failWorkspacePicker = false, expectWorkspacePickerError = false
  let pickedWorkspace = { path: workspaceDir, name: '프로젝트 작성·작업 폴더' }
  const officeProfile = { id: 'office', label: '사무실 서버', host: 'example.invalid', user: 'lawyer', port: 2222 }
  let profiles = remoteSmoke ? [officeProfile] : []
  const remoteProjects = new Map()
  let remoteRevision = 0, failRemoteRestore = false, expectRemoteUiError = false
  let pickedFolder = { path: contextDir, name: '공통 계약·증거' }
  app.setPath('userData', path.join(temp, 'profile'))
  app.setPath('home', temp)
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, cb) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : cb)
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'projects:save' && failSave) throw Error('검증용 저장 실패')
    if (channel === 'projects:workspace') {
      if (workspaceGate) await workspaceGate
      if (failWorkspace) { failWorkspace = false; throw Error('검증용 저장 위치 확인 실패') }
    }
    // Renderer-only remote fixture: transport/store boundaries have dedicated real tests.
    if (remoteSmoke && channel.startsWith('projects:')) {
      if (channel === 'projects:list') return [...remoteProjects.values()]
      if (channel === 'projects:save') {
        const { expectedUpdatedAt, ...input } = args[0]
        const previous = input.id ? remoteProjects.get(input.id) : undefined
        if (input.id && !previous) throw Error('프로젝트가 삭제되었거나 존재하지 않습니다.')
        if (previous && previous.updatedAt !== expectedUpdatedAt) throw Error('다른 창에서 프로젝트가 변경되었습니다.')
        const timestamp = new Date(Date.now() + ++remoteRevision).toISOString()
        const saved = { ...input, id: previous?.id ?? `remote-project-${remoteRevision}`, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }
        if (input.workspacePath === undefined && previous?.workspacePath) saved.workspacePath = previous.workspacePath
        if (saved.workspacePath === null) delete saved.workspacePath
        remoteProjects.set(saved.id, saved)
        event.sender.send('projects:changed')
        return saved
      }
      if (channel === 'projects:workspace') {
        const project = remoteProjects.get(args[0])
        if (!project) throw Error('프로젝트를 찾을 수 없습니다.')
        const cwd = project.workspacePath ?? path.join(temp, 'remote-fixture-default', project.id)
        if (!cwd.startsWith('ssh://')) fs.mkdirSync(cwd, { recursive: true })
        return { cwd, project }
      }
      if (channel === 'projects:remove') {
        remoteProjects.delete(args[0])
        event.sender.send('projects:changed')
        return
      }
      throw Error(`Unexpected remote project IPC: ${channel}`)
    }
    if (channel.startsWith('projects:') || ['app:info', 'app:generalChatDirectory', 'app:setWindowTitle', 'tabs:ready'].includes(channel)) return handler(event, ...args)
    if (channel === 'settings:get') return { sshProfiles: profiles, notifyDone: false, agentDefaultProvider: agentSmoke ? agentProvider : 'claude' }
    if (channel === 'dialog:pickFolder') {
      if (args[0]?.title === '프로젝트 작업 폴더 선택') {
        if (failWorkspacePicker) { failWorkspacePicker = false; throw Error('검증용 작업 폴더 선택 실패') }
        return cancelWorkspacePicker ? null : pickedWorkspace
      }
      return cancelFolder ? null : pickedFolder
    }
    if (channel === 'ssh:listDir') {
      const requested = args[0].path
      return { ok: true, cwd: requested?.startsWith('~/') ? `/home/lawyer/${requested.slice(2)}` : requested?.startsWith('/') ? requested : '/home/lawyer', entries: [] }
    }
    if (channel === 'case:history' || channel === 'case:addHistory') return history
    if (channel === 'js:tokenStatus') return connected ? 'ok' : 'missing'
    if (channel === 'js:hasToken') return connected
    if (channel === 'js:listCases') return { ok: true, cases: connected ? [jsCase] : [] }
    if (channel === 'js:getCase') return { ok: true, case: jsCase }
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
      if (remoteSmoke && failRemoteRestore && args[0].profileId === 'office') {
        failRemoteRestore = false
        return { ok: false, error: '검증용 원격 작업 복원 실패' }
      }
      if (agentSmoke) await new Promise(resolve => setTimeout(resolve, 60))
      return { ok: true, remote: { ok: true, snapshot: workspaces.get(args[0].cwd) ?? null } }
    }
    if (channel === 'workspace:autoSave') {
      if (agentSmoke) workspaces.set(args[0].location.cwd, args[0].snapshot)
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
    window.webContents.on('console-message', details => {
      if (details.level !== 'error' || /검증용 저장 실패/.test(details.message)) return
      if (expectConflictError && /다른 창에서 프로젝트가 변경되었습니다/.test(details.message)) return
      if (expectDeletedError && /프로젝트가 삭제되었거나 존재하지 않습니다/.test(details.message)) return
      if (expectWorkspaceError && /검증용 저장 위치 확인 실패/.test(details.message)) return
      if (expectWorkspacePickerError && /검증용 작업 폴더 선택 실패/.test(details.message)) return
      if (expectRemoteUiError && /검증용 원격 작업 복원 실패|프로젝트.*복원|SSH.*설정|프로필/.test(details.message)) return
      errors.push(details.message)
    })
    window.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const projectAgents = () => [...agents.values()].filter(agent => agent.workspaceContext?.kind === 'project')
  const wait = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw Error(`Timed out: ${label}`)
  }
  const click = (label, scope = '.project-dashboard') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw Error('Missing button: '+${JSON.stringify(label)}); b.click() })()`)
  const fill = (name, value) => evaluate(`(() => { const el = document.querySelector('[name="${name}"]'); if (!el) throw Error('Missing field: ${name}'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
  const clickAria = label => evaluate(`(() => { const button = [...document.querySelectorAll('.project-dashboard button')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('Missing button: ' + ${JSON.stringify(label)}); button.click() })()`)
  const projectSaves = () => calls.filter(call => call.channel === 'projects:save')
  const currentProject = async id => (await evaluate('window.lt.projects.list()')).find(project => project.id === id)
  const assertOnlyFieldChanged = (before, after, field, value) => {
    assert.deepEqual({ ...after, updatedAt: before.updatedAt }, { ...before, [field]: value }, `inline ${field} save preserves every other project field`)
    assert.notEqual(after.updatedAt, before.updatedAt, `inline ${field} save updates its revision`)
    assert.equal(projectSaves().at(-1).args[0].expectedUpdatedAt, before.updatedAt, `inline ${field} save uses the revision from when editing began`)
  }
  const beginInlineEdit = async (label, field) => {
    await clickAria(label)
    await wait(() => evaluate(`!!document.querySelector('.project-inline-editor textarea[name="${field}"]')`), `inline ${field} editor opened`)
  }
  const saveInlineEdit = async () => {
    await click('저장', '.project-inline-editor')
    await wait(() => evaluate(`!document.querySelector('.project-inline-editor')`), 'inline save finished')
  }
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 120))
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const chooseWorkspaceSource = async row => {
    const label = await evaluate(`[...document.querySelectorAll('.project-workspace-picker button')].find(button => ['작업 폴더 선택', '폴더 변경'].includes(button.textContent.trim()))?.textContent.trim()`)
    await click(label, '.project-workspace-picker')
    await wait(() => evaluate(`!!document.querySelector('.conn-menu')`), 'project workspace location chooser')
    assert.equal(await evaluate(`document.querySelector('.conn-menu .modal-title').textContent`), '프로젝트 작업 폴더 — 위치 선택')
    await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[${row}].click()`)
  }
  const chooseRemotePath = async value => {
    await chooseWorkspaceSource(1)
    await wait(() => evaluate(`!!document.querySelector('.remote-picker .remote-cwd') && !document.querySelector('.remote-picker').textContent.includes('불러오는 중')`), 'remote workspace browser ready')
    assert.equal(await evaluate(`document.querySelector('.remote-picker .modal-title').textContent.includes('프로젝트 작업 폴더 선택')`), true)
    assert.equal(await evaluate(`[...document.querySelectorAll('.remote-picker button')].some(button => button.textContent.trim() === '이 폴더에서 작업')`), true, 'remote workspace confirmation describes its use')
    await evaluate(`(() => { const input = document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await click('입력 경로 선택', '.remote-picker')
    await wait(() => evaluate(`!document.querySelector('.remote-picker')`), 'relative remote workspace resolved and selected')
  }
  const verifyRemoteProject = async () => {
    const remotePath = '/home/lawyer/research'
    const remoteUri = `ssh://office${remotePath}`
    await evaluate(`document.querySelector('.project-open-button').click()`)
    await wait(() => evaluate(`!!document.querySelector('.project-dashboard') && !document.querySelector('.project-dashboard').textContent.includes('불러오는 중')`), 'remote fixture project list loaded')
    await click('+ 새 프로젝트')
    await fill('name', '원격 프로젝트 작업')
    await fill('goal', '원격 서버에서 작성하고 참고 자료와 구분합니다.')
    await chooseWorkspaceSource(0)
    await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'local choice remains available with saved servers')
    await chooseWorkspaceSource(1)
    await wait(() => evaluate(`document.querySelector('.remote-picker .remote-cwd')?.textContent === '/home/lawyer'`), 'remote chooser starts at server home')
    await click('취소', '.remote-picker')
    assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), workspaceDir, 'cancelling the remote browser retains the previous local choice')
    await chooseRemotePath('~/research')
    assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), remoteUri, 'relative remote input is saved as an absolute SSH URI')
    assert.ok(calls.some(call => call.channel === 'ssh:listDir' && call.args[0].path === '~/research'), 'relative selection is resolved through the remote directory API')
    await click('자료 폴더 연결')
    await wait(() => evaluate(`!!document.querySelector('.conn-menu')`), 'reference folder source chooser remains separate')
    await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[0].click()`)
    await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'local reference folder linked beside remote workspace')
    await capture('project-remote-workspace-picker')
    await click('프로젝트 만들기')
    await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(remoteUri)}`), 'remote project workspace saved')
    const saved = (await evaluate('window.lt.projects.list()'))[0]
    const id = saved.id
    assert.equal(saved.workspacePath, remoteUri)
    assert.deepEqual(saved.folders, [{ path: contextDir, name: '공통 계약·증거' }])
    assert.equal(await evaluate(`document.querySelector('.project-workspace-section').textContent.includes('원격 서버')`), true, 'remote workspace badge identifies its location')
    assert.equal(projectAgents().length, 0, 'saving a remote workspace does not create an agent')
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
    await evaluate(`document.querySelector('.project-open-button').click()`)
    await wait(() => evaluate(`!!document.querySelector('.project-card')`), 'remote project reloads from fixture persistence')
    await evaluate(`document.querySelector('.project-card').click()`)
    await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(remoteUri)}`), 'remote workspace survives reload')
    await click('작업 폴더 변경', '.project-workspace-section')
    const savesBeforeRemoteCancel = projectSaves().length
    const callsBeforeRemoteBrowse = calls.length
    await chooseWorkspaceSource(1)
    await wait(() => evaluate(`document.querySelector('.remote-picker .remote-cwd')?.textContent === ${JSON.stringify(remotePath)}`), 'same server reopens at the saved remote workspace')
    assert.ok(calls.slice(callsBeforeRemoteBrowse).some(call => call.channel === 'ssh:listDir' && call.args[0].path === remotePath), 'remote picker receives the current path for the same profile')
    await click('취소', '.remote-picker')
    assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), remoteUri, 'remote browser cancellation retains the saved remote choice')
    await click('취소', '.project-form-footer')
    await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'remote settings cancelled')
    assert.equal(projectSaves().length, savesBeforeRemoteCancel, 'cancelling remote settings never saves')

    // UI failures must not fall through to creating an agent or submitting a prompt.
    profiles = []
    expectRemoteUiError = true
    const blockedCallsStart = calls.length
    await clickAria('프로젝트 AI 작업')
    await wait(() => evaluate(`[...document.querySelectorAll('.project-dashboard [role="alert"]')].some(alert => /SSH|프로필|연결 설정/.test(alert.textContent))`), 'missing remote profile is surfaced')
    assert.deepEqual(calls.slice(blockedCallsStart).filter(call => ['agent:create', 'agent:send'].includes(call.channel)), [], 'missing remote profile blocks agent creation')
    profiles = [officeProfile]
    failRemoteRestore = true
    await clickAria('프로젝트 AI 작업')
    await wait(() => evaluate(`[...document.querySelectorAll('.project-dashboard [role="alert"]')].some(alert => alert.textContent.includes('복원'))`), 'remote workspace restoration failure is surfaced')
    assert.equal(failRemoteRestore, false, 'remote restoration failure was exercised')
    assert.ok(calls.some(call => call.channel === 'dialog:message' && call.args.some(arg => typeof arg === 'string' && arg.includes('검증용 원격 작업 복원 실패'))), 'restoration failure retains the underlying error message')
    assert.deepEqual(calls.slice(blockedCallsStart).filter(call => ['agent:create', 'agent:send'].includes(call.channel)), [], 'failed remote restoration never starts or sends to an agent')
    expectRemoteUiError = false
    await clickAria('프로젝트 AI 작업')
    await wait(() => projectAgents().some(agent => agent.cwd === remotePath && agent.workspaceContext.projectId === id), 'remote project agent starts after retry')
    const remoteAgent = projectAgents().find(agent => agent.cwd === remotePath && agent.workspaceContext.projectId === id)
    await wait(() => evaluate(`!!document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-composer textarea')`), 'remote project agent is visible in the project workspace')
    assert.equal(remoteAgent.source, 'ssh')
    assert.equal(remoteAgent.ssh.host, officeProfile.host)
    assert.equal(remoteAgent.ssh.user, officeProfile.user)
    assert.equal(remoteAgent.ssh.port, officeProfile.port)
    assert.equal(remoteAgent.workspaceContext.kind, 'project')
    assert.equal(remoteAgent.workspaceContext.projectId, id)
    assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'opening remote AI never submits a prompt')
    const beforeFileOpen = calls.length
    await click('작업 폴더 열기', '.project-workspace-section')
    await wait(() => evaluate(`!document.querySelector('.project-dashboard') && !!document.querySelector('.side-col > .sidebar')`), 'remote project workspace opens in the file view')
    await wait(() => calls.slice(beforeFileOpen).some(call => call.channel === 'fs:list' && call.args[0] === remoteUri), 'remote file view uses the project SSH URI')
    assert.deepEqual(calls.slice(beforeFileOpen).filter(call => ['agent:create', 'agent:send', 'projects:save'].includes(call.channel)), [], 'remote file open does not start AI or save project settings')
    await evaluate(`document.querySelector('.project-open-button').click()`)
    await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return from remote project files')
    await wait(() => workspaces.get(remotePath)?.terminals.some(term => term.id === remoteAgent.id), 'remote conversation is persisted before moving workspace')

    // Local and remote project conversations stay scoped to their actual workspace.
    await click('작업 폴더 변경', '.project-workspace-section')
    await chooseWorkspaceSource(0)
    await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'remote workspace changed to a local folder')
    const createsBeforeLocalSave = calls.filter(call => call.channel === 'agent:create').length
    await click('변경사항 저장')
    await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'local replacement workspace saved')
    assert.equal(calls.filter(call => call.channel === 'agent:create').length, createsBeforeLocalSave, 'saving local replacement does not create an agent')
    await clickAria('프로젝트 AI 작업')
    await wait(() => projectAgents().some(agent => agent.cwd === workspaceDir && agent.workspaceContext.projectId === id), 'project AI uses the new local directory')
    const localAgent = projectAgents().find(agent => agent.cwd === workspaceDir && agent.workspaceContext.projectId === id)
    assert.equal(localAgent.source, 'local')
    assert.equal(localAgent.ssh, undefined)
    assert.notEqual(localAgent.id, remoteAgent.id, 'local replacement does not reuse a remote session')
    assert.equal(localAgent.resumeSessionId, undefined)
    await click('작업 폴더 변경', '.project-workspace-section')
    await chooseRemotePath('~/review')
    const changedRemoteUri = 'ssh://office/home/lawyer/review'
    await click('변경사항 저장')
    await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(changedRemoteUri)}`), 'second remote workspace saved')
    await clickAria('프로젝트 AI 작업')
    await wait(() => projectAgents().some(agent => agent.cwd === '/home/lawyer/review' && agent.workspaceContext.projectId === id), 'local project moves to the newly selected remote directory')
    const nextRemoteAgent = projectAgents().find(agent => agent.cwd === '/home/lawyer/review' && agent.workspaceContext.projectId === id)
    assert.equal(nextRemoteAgent.source, 'ssh')
    assert.equal(nextRemoteAgent.ssh.host, officeProfile.host)
    assert.notEqual(nextRemoteAgent.id, localAgent.id, 'remote replacement does not reuse a local session')
    assert.notEqual(nextRemoteAgent.id, remoteAgent.id, 'different remote directory does not reuse the earlier remote session')
    assert.equal(nextRemoteAgent.resumeSessionId, undefined)
    assert.ok(workspaces.get(remotePath)?.terminals.some(term => term.id === remoteAgent.id), 'previous remote conversation remains in its original workspace')
    assert.deepEqual((await currentProject(id)).folders, saved.folders, 'local and remote workspace changes preserve reference folders')
    assert.equal(fs.readFileSync(path.join(workspaceDir, 'prior-work.txt'), 'utf8'), 'keep prior workspace files')
    assert.equal(fs.readFileSync(path.join(contextDir, 'contract.txt'), 'utf8'), 'keep this context')
    const projectPaths = [remoteUri, remotePath, workspaceDir, changedRemoteUri, '/home/lawyer/review']
    assert.equal(calls.some(call => call.channel === 'case:addHistory' && projectPaths.includes(call.args[0]?.drafts)), false, 'remote project workspaces are not registered as individual cases')
    assert.equal(calls.some(call => ['fs:delete', 'agent:send'].includes(call.channel)), false, 'remote workspace operations never delete files or send prompts')
    win.setMinimumSize(680, 480)
    win.setSize(900, 760)
    await capture('project-remote-workspace')
    assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'remote workspace detail fits beside AI in a narrow window')
    assert.deepEqual(errors, [])
    console.log('remote project UI: picker/cancel/canonical path, durable selection, file view, SSH AI scope, missing profile/restoration failure, local-remote isolation and preserved data OK')
  }
  ;(async () => {
    try {
      await ready
      await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-group').length === 3`), 'existing individual cases and general chat')
      if (remoteSmoke) {
        await verifyRemoteProject()
        app.exit(0)
        return
      }
      await capture('existing-cases')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-dashboard') && !document.querySelector('.project-dashboard').textContent.includes('불러오는 중')`), 'projects without account')
      await capture('empty-projects')
      await click('+ 새 프로젝트')
      assert.equal(await evaluate(`document.querySelector('.project-folder-picker h3')?.textContent`), '참고 자료 폴더', 'new project explains the reference folder role')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker h3')?.textContent`), '프로젝트 작업 폴더', 'new project offers a workspace folder choice')
      assert.equal(await evaluate(`Boolean(document.querySelector('.project-workspace-picker').compareDocumentPosition(document.querySelector('[name="goal"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true, 'workspace choice appears before the project goal')
      assert.equal(await evaluate(`[...document.querySelectorAll('.project-workspace-picker button')].some(button => button.textContent.trim() === '저장 위치 확인')`), false, 'unsaved project has no workspace lookup action')
      cancelWorkspacePicker = true
      await click('작업 폴더 선택', '.project-workspace-picker')
      await wait(() => evaluate(`[...document.querySelectorAll('.project-workspace-picker button')].some(button => !button.disabled && button.textContent.trim() === '작업 폴더 선택')`), 'new workspace picker cancellation settles')
      assert.equal(await evaluate(`!!document.querySelector('.project-workspace-picker .project-folder-path')`), false, 'cancelling the native picker keeps the automatic default')
      cancelWorkspacePicker = false
      await click('작업 폴더 선택', '.project-workspace-picker')
      await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'custom workspace selected for new project')
      assert.equal(projectSaves().length, 0, 'selecting a workspace does not save an unfinished project')
      assert.equal(calls.some(call => call.channel === 'projects:workspace'), false, 'unsaved project does not create an output workspace')
      await fill('name', 'A사 거래대금 회수')
      await fill('goal', '거래대금 회수를 위해 관련 절차를 함께 관리합니다.')
      await fill('nextAction', '가압류 결정 확인 후 본안 증거목록 정리')
      await fill('notes', '계약서와 거래명세를 기준으로 공통 사실관계를 정리합니다.')
      await evaluate(`document.querySelectorAll('.project-case-option input[type="checkbox"]').forEach(el => el.click())`)
      cancelFolder = true
      await click('자료 폴더 연결')
      await evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 0, 'cancelling folder picker leaves context unchanged')
      cancelFolder = false
      await click('자료 폴더 연결')
      await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'folder context added')
      await click('자료 폴더 연결')
      await evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 1, 'duplicate folder context deduplicated')
      await evaluate(`document.querySelector('.case-management-nav button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.dash-token')`), 'temporary individual-case navigation')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-editor')`), 'unfinished project restored')
      assert.equal(await evaluate(`document.querySelector('[name="name"]').value`), 'A사 거래대금 회수')
      assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 1, 'draft retains folder context')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), workspaceDir, 'draft retains the chosen workspace after temporary navigation')
      await evaluate(`document.querySelector('.project-dashboard').scrollTop = 0`)
      await capture('project-editor')
      assert.equal(await evaluate(`(() => { const footer = document.querySelector('.project-form-footer'); const bounds = footer.getBoundingClientRect(); const dashboardBounds = document.querySelector('.project-dashboard').getBoundingClientRect(); return getComputedStyle(footer).position === 'sticky' && bounds.top >= dashboardBounds.top && bounds.bottom <= Math.min(dashboardBounds.bottom, window.innerHeight) + 1 })()`), true, 'new project actions remain visible at the top of a long form')
      await click('프로젝트 만들기')
      await wait(() => evaluate(`document.querySelector('.project-detail')?.textContent.includes('A사 거래대금 회수')`), 'created detail')
      let projects = await evaluate('window.lt.projects.list()')
      assert.equal(projects.length, 1)
      assert.equal(projects[0].cases.length, 2)
      assert.deepEqual(projects[0].folders, [{ path: contextDir, name: '공통 계약·증거' }])
      assert.equal(projects[0].goal, '거래대금 회수를 위해 관련 절차를 함께 관리합니다.')
      const id = projects[0].id
      assert.equal(await evaluate(`document.querySelector('.project-folders-section h3')?.textContent`), '참고 자료 폴더', 'project detail explains the reference folder role')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-section h3')?.textContent`), '프로젝트 작업 폴더', 'project detail distinguishes the workspace folder')
      assert.equal(projects[0].workspacePath, workspaceDir, 'creating the project persists its selected workspace')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-section .project-folder-path').textContent.trim()`), workspaceDir, 'custom workspace is displayed immediately')
      assert.equal(await evaluate(`document.querySelector('.project-folder button').textContent.trim()`), '폴더 작업으로 이동 →', 'reference folder action explains workspace navigation')
      assert.equal(await evaluate(`document.querySelector('.project-folder button').getAttribute('aria-label')`), '공통 계약·증거 폴더 작업으로 이동', 'reference folder action has a matching accessible name')
      assert.equal(calls.some(call => call.channel === 'projects:workspace'), false, 'creating a project does not automatically request its output workspace')

      // A chosen workspace survives restart, and edits only commit on Save.
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(card => card.textContent.includes('A사 거래대금 회수'))`), 'custom workspace project survives restart')
      await evaluate(`[...document.querySelectorAll('.project-card')].find(card => card.textContent.includes('A사 거래대금 회수')).click()`)
      await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'saved custom workspace is restored')
      const beforeWorkspaceChange = await currentProject(id)
      await click('작업 폴더 변경', '.project-workspace-section')
      await wait(() => evaluate(`document.activeElement?.textContent.trim() === '폴더 변경' && !!document.activeElement?.closest('.project-workspace-picker')`), 'workspace change opens the editor at its native picker')
      profiles = [{ id: 'office', label: '사무실 서버', host: 'example.invalid', user: 'lawyer' }]
      cancelWorkspacePicker = true
      await click('폴더 변경', '.project-workspace-picker')
      await wait(() => evaluate(`!!document.querySelector('.conn-menu')`), 'workspace location chooser with saved servers')
      assert.equal(await evaluate(`document.querySelector('.conn-menu .modal-title').textContent`), '프로젝트 작업 폴더 — 위치 선택', 'workspace chooser identifies its purpose')
      await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[0].click()`)
      await wait(() => evaluate(`[...document.querySelectorAll('.project-workspace-picker button')].some(button => !button.disabled && button.textContent.trim() === '폴더 변경')`), 'existing workspace picker cancellation settles')
      assert.equal(calls.filter(call => call.channel === 'dialog:pickFolder').at(-1).args[0].defaultPath, workspaceDir, 'native workspace picker starts at the current folder')
      assert.equal(await evaluate(`!!document.querySelector('.conn-menu')`), false, 'choosing the local row closes the workspace location chooser')
      profiles = []
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), workspaceDir, 'native cancellation preserves the current workspace')
      cancelWorkspacePicker = false
      failWorkspacePicker = true
      expectWorkspacePickerError = true
      await click('폴더 변경', '.project-workspace-picker')
      await wait(() => evaluate(`document.querySelector('.project-workspace-picker [role="alert"]')?.textContent.includes('검증용 작업 폴더 선택 실패')`), 'workspace picker error is surfaced')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), workspaceDir, 'picker failure preserves the current workspace')
      expectWorkspacePickerError = false
      pickedWorkspace = { path: changedWorkspaceDir, name: '변경한 프로젝트 작업 폴더' }
      await click('폴더 변경', '.project-workspace-picker')
      await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(changedWorkspaceDir)}`), 'changed workspace retained in editor draft')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker').textContent.includes('기존 파일과 대화는 원래 폴더에 남습니다')`), true, 'workspace edit explains what remains in the previous folder')
      assert.deepEqual(await currentProject(id), beforeWorkspaceChange, 'native selection alone never changes the saved project')
      failSave = true
      await click('변경사항 저장')
      await wait(() => evaluate(`document.querySelector('.project-editor').textContent.includes('검증용 저장 실패')`), 'workspace save failure surfaced')
      assert.equal(await evaluate(`document.querySelector('.project-workspace-picker .project-folder-path').textContent.trim()`), changedWorkspaceDir, 'failed workspace save keeps the chosen draft')
      assert.deepEqual(await currentProject(id), beforeWorkspaceChange, 'failed workspace save preserves the original project')
      failSave = false
      await click('취소', '.project-form-footer')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'workspace form cancelled')
      assert.deepEqual(await currentProject(id), beforeWorkspaceChange, 'cancelling the workspace draft preserves the original project')
      await click('작업 폴더 변경', '.project-workspace-section')
      await click('폴더 변경', '.project-workspace-picker')
      await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(changedWorkspaceDir)}`), 'replacement workspace reselected')
      win.setMinimumSize(680, 480)
      win.setSize(900, 760)
      await capture('project-workspace-picker')
      assert.equal(await evaluate(`(() => { const dashboard = document.querySelector('.project-dashboard'); const section = document.querySelector('.project-workspace-picker'); const folderPath = section.querySelector('.project-folder-path'); return dashboard.scrollWidth <= dashboard.clientWidth && section.scrollWidth <= section.clientWidth && folderPath.scrollWidth <= folderPath.clientWidth })()`), true, 'custom workspace picker fits in the narrow editor')
      win.setSize(1440, 940)
      await click('변경사항 저장')
      await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(changedWorkspaceDir)}`), 'replacement workspace saved')
      assertOnlyFieldChanged(beforeWorkspaceChange, await currentProject(id), 'workspacePath', changedWorkspaceDir)
      await click('작업 폴더 변경', '.project-workspace-section')
      await click('기본 위치 사용', '.project-workspace-picker')
      assert.equal((await currentProject(id)).workspacePath, changedWorkspaceDir, 'automatic workspace reset also waits for Save')
      await click('변경사항 저장')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'automatic workspace restored')
      assert.equal(projectSaves().at(-1).args[0].workspacePath, null, 'automatic reset is explicit in the save request')
      projects = await evaluate('window.lt.projects.list()')
      assert.equal(projects[0].workspacePath, undefined, 'automatic workspace is stored without a custom override')
      assert.deepEqual(projects[0].folders, beforeWorkspaceChange.folders, 'workspace changes leave reference folders unchanged')
      assert.equal(fs.readFileSync(path.join(workspaceDir, 'prior-work.txt'), 'utf8'), 'keep prior workspace files')
      assert.equal(fs.readFileSync(path.join(changedWorkspaceDir, 'existing-work.txt'), 'utf8'), 'keep destination files')

      // Automatic location lookup is explicit, reports progress, and can be retried.
      const beforeOutputLookup = projects[0]
      const outputLookupCallStart = calls.length
      failWorkspace = true
      expectWorkspaceError = true
      let releaseWorkspace
      workspaceGate = new Promise(resolve => { releaseWorkspace = resolve })
      await click('저장 위치 확인', '.project-workspace-section')
      await wait(() => evaluate(`(() => { const button = [...document.querySelectorAll('.project-workspace-section button')].find(button => /확인.*중/.test(button.textContent)); return button?.disabled })()`), 'output folder lookup displays a pending state')
      releaseWorkspace()
      workspaceGate = null
      await wait(() => evaluate(`document.querySelector('.project-workspace-section [role="alert"]')?.textContent.includes('검증용 저장 위치 확인 실패')`), 'output folder lookup error surfaced')
      assert.equal(await evaluate(`!!document.querySelector('.project-workspace-section .project-folder-path')`), false, 'failed lookup does not display a fabricated output path')
      await click('저장 위치 확인', '.project-workspace-section')
      await wait(() => evaluate(`!!document.querySelector('.project-workspace-section .project-folder-path')`), 'output folder lookup retry succeeds')
      expectWorkspaceError = false
      const expectedOutputPath = fs.realpathSync(path.join(temp, 'profile', 'project-workspaces', id))
      assert.equal(await evaluate(`document.querySelector('.project-workspace-section .project-folder-path').textContent.trim()`), expectedOutputPath, 'displayed output path matches the actual app-managed workspace')
      assert.notEqual(expectedOutputPath, fs.realpathSync(contextDir), 'outputs are stored separately from the reference folder')
      assert.deepEqual(calls.slice(outputLookupCallStart).filter(call => call.channel === 'projects:workspace').map(call => call.args), [[id], [id]], 'retry requests the same saved project workspace')
      assert.deepEqual(calls.slice(outputLookupCallStart).filter(call => ['projects:save', 'agent:create', 'agent:send', 'dialog:pickFolder', 'fs:list', 'case:addHistory'].includes(call.channel)), [], 'output lookup does not save, start AI work, pick a folder, or navigate')
      assert.deepEqual(await currentProject(id), beforeOutputLookup, 'output lookup leaves all project data unchanged')
      assert.equal(await evaluate(`!!document.querySelector('.project-detail')`), true, 'output lookup leaves project detail open')

      win.setMinimumSize(680, 480)
      win.setSize(900, 760)
      await evaluate(`document.querySelector('.project-workspace-section').scrollIntoView({ block: 'center' })`)
      await capture('project-folder-roles')
      assert.equal(await evaluate(`(() => { const dashboard = document.querySelector('.project-dashboard'); const section = document.querySelector('.project-workspace-section'); const outputPath = section.querySelector('.project-folder-path'); return dashboard.scrollWidth <= dashboard.clientWidth && section.scrollWidth <= section.clientWidth && outputPath.scrollWidth <= outputPath.clientWidth })()`), true, 'long automatic workspace path fits in narrow detail')
      win.setSize(1440, 940)
      const workspaceOpenCallStart = calls.length
      await click('작업 폴더 열기', '.project-workspace-section')
      await wait(() => evaluate(`!document.querySelector('.project-dashboard') && !!document.querySelector('.side-col > .sidebar')`), 'project workspace opens in the file view')
      await wait(() => calls.slice(workspaceOpenCallStart).some(call => call.channel === 'fs:list' && call.args[0] === expectedOutputPath), 'file view uses the project workspace directory')
      assert.deepEqual(calls.slice(workspaceOpenCallStart).filter(call => ['agent:create', 'agent:send', 'projects:save', 'dialog:pickFolder', 'case:addHistory'].includes(call.channel)), [], 'opening workspace files never starts AI or changes project/case data')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'return from project workspace file view')
      if (agentSmoke) {
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click(); document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => projectAgents().length === 1 && evaluate(`!!document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-composer textarea')`), 'project agent created once')
        const first = projectAgents()[0]
        assert.equal(first.workspaceContext.kind, 'project')
        assert.equal(first.workspaceContext.projectId, id)
        assert.equal(first.provider, agentProvider)
        assert.equal(first.ssh, undefined)
        assert.equal(first.cwd.startsWith(fs.realpathSync(path.join(temp, 'profile'))), true)
        assert.notEqual(first.cwd, caseDir)
        assert.match(first.context, /프로젝트 작업 범위/)
        assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'opening a project never submits a prompt')
        await wait(() => evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-empty')?.textContent.includes('프로젝트') || document.querySelector('.work-right').textContent.includes('프로젝트의 현황')`), 'project-specific agent guidance')
        await evaluate(`(() => { const el = document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '연결 자료를 비교하고 근거를 구분해 줘.'); el.dispatchEvent(new Event('input', {bubbles:true})) })()`)
        await wait(() => evaluate(`!document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-send-btn').disabled`), 'project composer ready')
        if (claudeAuthSmoke) {
          const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed'
          win.webContents.send('agent:event', { type: 'auth:status', sessionId: first.id, state: 'unauthenticated', message: expired })
          win.webContents.send('agent:event', { type: 'error', sessionId: first.id, message: expired, recoverable: true })
          await wait(() => evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-auth-banner')?.textContent.includes('이 PC의 Claude 로그인이 필요합니다.')`), 'local Claude re-login guidance')
          assert.equal(await evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-send-btn').disabled`), true)
          assert.equal(await evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-composer textarea').value`), '연결 자료를 비교하고 근거를 구분해 줘.')
          await capture('project-claude-auth-expired')
          await evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-auth-banner button').click()`)
          await wait(() => calls.some(call => call.channel === 'agent:authLogin' && call.args[0] === first.id), 'local login action')
          await wait(() => evaluate(`!document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-auth-banner') && !document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-send-btn').disabled`), 'composer recovers after login')
          assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'login does not resubmit a failed request automatically')
        }
        await evaluate(`document.querySelector('.work-right .agent-panel[data-visible="true"] .agent-send-btn').click()`)
        await wait(() => calls.some(call => call.channel === 'agent:send'), 'project input sent')
        const sent = calls.find(call => call.channel === 'agent:send').args[0]
        assert.equal(sent.input.workspaceContext.projectId, id)
        assert.equal(sent.input.workspaceContext.kind, 'project')
        await evaluate(`document.querySelector('[aria-label="프로젝트 대화 이어가기"]').click()`)
        await wait(() => evaluate(`!document.querySelector('[aria-label="프로젝트 대화 이어가기"]').disabled`), 'continue settles')
        assert.equal(projectAgents().length, 1, 'continue reuses existing agent')
        await capture('project-ai-workspace')
        win.setMinimumSize(680, 480)
        win.setSize(900, 760)
        await capture('project-ai-narrow')
        assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'project detail fits beside agent in narrow window')
        win.setSize(1440, 940)
        await wait(() => workspaces.get(first.cwd)?.terminals.some(term => term.resumeSessionId === `native-${first.id}`), 'project native session persisted')
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
        assert.equal(projectAgents().length, 1, 'other project stays unloaded')
        await evaluate(`document.querySelector('[aria-label="프로젝트 새 대화"]').click()`)
        await wait(() => projectAgents().length === 2, 'explicit new project conversation')
        assert.ok(projectAgents().every(agent => agent.workspaceContext.projectId === id && agent.cwd === first.cwd))
        assert.equal(calls.some(call => call.channel === 'case:addHistory' && call.args[0].drafts === first.cwd), false, 'project workspace is not reclassified as a case')

        // Changing the workspace starts a separate conversation in the new directory.
        const previousAgents = projectAgents().filter(agent => agent.workspaceContext.projectId === id)
        const previousAgentIds = previousAgents.map(agent => agent.id)
        await wait(() => previousAgentIds.every(agentId => workspaces.get(first.cwd)?.terminals.some(term => term.id === agentId)), 'all original conversations persisted before changing workspace')
        const previousConversations = JSON.parse(JSON.stringify(workspaces.get(first.cwd).terminals))
        fs.writeFileSync(path.join(first.cwd, 'prior-chat-output.txt'), 'keep original project output')
        const sendsBeforeWorkspaceChange = calls.filter(call => call.channel === 'agent:send').length
        const beforeCustomChange = await currentProject(id)
        await click('작업 폴더 변경', '.project-workspace-section')
        pickedWorkspace = { path: workspaceDir, name: '프로젝트 작성·작업 폴더' }
        await click('작업 폴더 선택', '.project-workspace-picker')
        await wait(() => evaluate(`document.querySelector('.project-workspace-picker .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'custom agent workspace chosen')
        await click('변경사항 저장')
        await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(workspaceDir)}`), 'custom agent workspace saved')
        assertOnlyFieldChanged(beforeCustomChange, await currentProject(id), 'workspacePath', workspaceDir)
        const actualCustomWorkspace = fs.realpathSync(workspaceDir)
        assert.equal(projectAgents().some(agent => agent.cwd === actualCustomWorkspace), false, 'saving a workspace choice does not create an AI conversation')
        await evaluate(`document.querySelector('.project-work-actions .project-primary').click()`)
        await wait(() => projectAgents().some(agent => agent.workspaceContext.projectId === id && agent.cwd === actualCustomWorkspace), 'project AI starts in the selected custom workspace')
        const changedAgent = projectAgents().find(agent => agent.workspaceContext.projectId === id && agent.cwd === actualCustomWorkspace)
        assert.equal(previousAgentIds.includes(changedAgent.id), false, 'custom workspace never reuses a session from the previous directory')
        assert.equal(changedAgent.resumeSessionId, undefined, 'new custom workspace does not inherit a previous native conversation')
        assert.equal(changedAgent.ssh, undefined, 'selected workspace uses a local AI session')
        assert.equal(calls.filter(call => call.channel === 'agent:send').length, sendsBeforeWorkspaceChange, 'workspace change and open never submit a prompt')
        for (const conversation of previousConversations) {
          const retained = workspaces.get(first.cwd)?.terminals.find(term => term.id === conversation.id)
          assert.ok(retained, 'previous workspace keeps its saved conversation')
          assert.equal(retained.resumeSessionId, conversation.resumeSessionId, 'previous native conversation reference is unchanged')
        }
        assert.equal(fs.readFileSync(path.join(first.cwd, 'prior-chat-output.txt'), 'utf8'), 'keep original project output')
        assert.equal(fs.readFileSync(path.join(workspaceDir, 'prior-work.txt'), 'utf8'), 'keep prior workspace files')
        assert.equal(fs.readFileSync(path.join(contextDir, 'contract.txt'), 'utf8'), 'keep this context')
        assert.deepEqual((await currentProject(id)).folders, beforeCustomChange.folders, 'AI workspace change preserves reference folder links')
        // A path changed while Projects is closed must not reveal the old conversation.
        const createsBeforeExternalChange = calls.filter(call => call.channel === 'agent:create').length
        await evaluate(`document.querySelector('.case-management-nav button').click()`)
        await wait(() => evaluate(`!!document.querySelector('.dash-token')`), 'leave Projects before an external workspace change')
        const beforeExternalWorkspaceChange = await currentProject(id)
        await evaluate(`window.lt.projects.save(${JSON.stringify({ ...beforeExternalWorkspaceChange, workspacePath: changedWorkspaceDir, expectedUpdatedAt: beforeExternalWorkspaceChange.updatedAt })})`)
        await evaluate(`document.querySelector('.project-open-button').click()`)
        await wait(() => evaluate(`document.querySelector('.project-workspace-section .project-folder-path')?.textContent.trim() === ${JSON.stringify(changedWorkspaceDir)} && !!document.querySelector('[aria-label="프로젝트 AI 작업"]')`), 'return reflects the externally changed workspace before opening AI')
        assert.equal(await evaluate(`[...document.querySelectorAll('.work-right .agent-panel[data-visible="true"]')].some(panel => panel.getClientRects().length > 0 && getComputedStyle(panel).visibility !== 'hidden')`), false, 'returning after an external workspace change keeps the previous project panel hidden')
        assert.equal(calls.filter(call => call.channel === 'agent:create').length, createsBeforeExternalChange, 'external workspace save and return do not create an AI conversation')
        await clickAria('프로젝트 AI 작업')
        const actualChangedWorkspace = fs.realpathSync(changedWorkspaceDir)
        await wait(() => projectAgents().some(agent => agent.workspaceContext.projectId === id && agent.cwd === actualChangedWorkspace), 'explicit AI open uses the externally selected workspace')
        const externalWorkspaceAgent = projectAgents().find(agent => agent.workspaceContext.projectId === id && agent.cwd === actualChangedWorkspace)
        assert.notEqual(externalWorkspaceAgent.id, changedAgent.id, 'external workspace change does not reuse the previous custom-folder session')
        assert.equal(previousAgentIds.includes(externalWorkspaceAgent.id), false, 'external workspace change does not reuse an automatic-folder session')
        assert.equal(externalWorkspaceAgent.resumeSessionId, undefined, 'externally selected folder starts a fresh native conversation')
        assert.equal(calls.filter(call => call.channel === 'agent:send').length, sendsBeforeWorkspaceChange, 'external workspace change never submits a prompt')
        assert.equal(fs.readFileSync(path.join(changedWorkspaceDir, 'existing-work.txt'), 'utf8'), 'keep destination files')
        await capture('project-custom-workspace')
        assert.deepEqual(errors, [])
        console.log(`project agent UI: scoped ${agentProvider} workspaces, ${claudeAuthSmoke ? 'local auth expiry/re-login/draft preservation, ' : ''}no automatic prompts, duplicate-click protection, durable resume, project isolation, custom workspace changes and preserved prior conversations/files OK`)
        app.exit(0)
        return
      }
      // Inline changes keep the project open and preserve unrelated data.
      let beforeInline = await currentProject(id)
      win.setMinimumSize(680, 480)
      win.setSize(900, 760)
      await beginInlineEdit('공통 목표 수정', 'goal')
      assert.equal(await evaluate(`document.activeElement === document.querySelector('.project-inline-editor textarea[name="goal"]')`), true, 'inline editor receives keyboard focus')
      const otherDetailActions = await evaluate(`[...document.querySelectorAll('.project-detail button')].filter(button => !button.closest('.project-inline-editor')).map(button => ({ label: button.getAttribute('aria-label') || button.textContent.trim(), disabled: button.disabled }))`)
      assert.ok(otherDetailActions.length > 5, 'detail contains navigation, connection and workspace actions')
      assert.deepEqual(otherDetailActions.filter(button => !button.disabled), [], 'other detail actions cannot discard an inline draft')
      const inlineGoal = '거래대금 전액 회수를 위해 본안과 보전 절차의 증거를 함께 검토합니다.'
      await fill('goal', inlineGoal)
      const savesBeforeInlineNavigation = projectSaves().length
      await evaluate(`document.querySelector('.case-management-nav button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.dash-token')`), 'temporary individual-case navigation during inline edit')
      await evaluate(`document.querySelector('.project-open-button').click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-inline-editor textarea[name="goal"]')`), 'inline goal editor restored after navigation')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="goal"]').value`), inlineGoal, 'temporary navigation restores the same inline field and draft')
      assert.equal(projectSaves().length, savesBeforeInlineNavigation, 'temporary navigation does not save the inline draft')
      assert.deepEqual(await currentProject(id), beforeInline, 'temporary navigation preserves the original stored revision')
      await capture('project-inline-editor')
      assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth && document.querySelector('.project-inline-editor').scrollWidth <= document.querySelector('.project-inline-editor').clientWidth`), true, 'inline editor fits in a narrow window')
      win.setSize(1440, 940)
      await saveInlineEdit()
      assertOnlyFieldChanged(beforeInline, await currentProject(id), 'goal', inlineGoal)

      // Cancelling does not save, and the next edit starts with the saved value.
      beforeInline = await currentProject(id)
      const savesBeforeCancel = projectSaves().length
      await beginInlineEdit('다음 행동 수정', 'nextAction')
      await fill('nextAction', '취소하면 저장하지 않을 다음 행동')
      await click('취소', '.project-inline-editor')
      await wait(() => evaluate(`!document.querySelector('.project-inline-editor')`), 'inline cancel finished')
      assert.equal(projectSaves().length, savesBeforeCancel, 'inline cancel never invokes project save')
      assert.deepEqual(await currentProject(id), beforeInline, 'inline cancel preserves the persisted project')
      await beginInlineEdit('다음 행동 수정', 'nextAction')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="nextAction"]').value`), beforeInline.nextAction, 'cancelled draft is not reused')
      const inlineNextAction = '가압류 결정문을 검토하고 본안 증거목록을 확정합니다.'
      await fill('nextAction', inlineNextAction)
      await saveInlineEdit()
      assertOnlyFieldChanged(beforeInline, await currentProject(id), 'nextAction', inlineNextAction)

      // A failed inline save retains the draft for an explicit retry.
      beforeInline = await currentProject(id)
      const inlineNotes = '저장에 실패해도 유지할 공통 메모\n계약서와 거래명세의 차이를 확인합니다.'
      await beginInlineEdit('공통 메모 수정', 'notes')
      await fill('notes', inlineNotes)
      failSave = true
      await click('저장', '.project-inline-editor')
      await wait(() => evaluate(`document.querySelector('.project-dashboard').textContent.includes('검증용 저장 실패')`), 'inline save error surfaced')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="notes"]').value`), inlineNotes, 'failed inline save retains its draft')
      assert.deepEqual(await currentProject(id), beforeInline, 'failed inline save leaves stored data intact')
      failSave = false
      await saveInlineEdit()
      assertOnlyFieldChanged(beforeInline, await currentProject(id), 'notes', inlineNotes)

      // An external revision must not be silently overwritten by an older draft.
      beforeInline = await currentProject(id)
      const conflictDraft = '동시 변경을 확인한 뒤 다시 반영할 내 초안'
      const externalGoal = '다른 창에서 확정한 회수 목표'
      const externalNotes = '다른 창에서 저장한 공통 메모'
      await beginInlineEdit('공통 메모 수정', 'notes')
      await fill('notes', conflictDraft)
      const externalProject = await evaluate(`window.lt.projects.save(${JSON.stringify({ ...beforeInline, goal: externalGoal, notes: externalNotes, expectedUpdatedAt: beforeInline.updatedAt })})`)
      await wait(() => evaluate(`document.querySelector('.project-detail').textContent.includes(${JSON.stringify(externalGoal)})`), 'external project update reaches detail')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="notes"]').value`), conflictDraft, 'external update retains the open inline draft')
      expectConflictError = true
      await click('저장', '.project-inline-editor')
      await wait(() => evaluate(`document.querySelector('.project-dashboard').textContent.includes('다른 창에서 프로젝트가 변경되었습니다')`), 'inline revision conflict surfaced')
      assert.equal(projectSaves().at(-1).args[0].expectedUpdatedAt, beforeInline.updatedAt, 'inline conflict checks the original editing revision')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="notes"]').value`), conflictDraft, 'conflicting inline save retains its draft')
      assert.deepEqual(await currentProject(id), externalProject, 'conflicting inline save preserves every external change')
      await click('취소', '.project-inline-editor')
      await wait(() => evaluate(`!document.querySelector('.project-inline-editor') && document.querySelector('.project-notes').textContent.includes(${JSON.stringify(externalNotes)})`), 'cancel returns to the latest external notes')
      expectConflictError = false

      // Deletion in another window preserves the draft without resurrecting data.
      const deletedProject = await evaluate(`window.lt.projects.save({ name: '삭제 충돌 검증', goal: '임시 목표', nextAction: '', notes: '', cases: [], folders: [], status: 'active' })`)
      await click('← 프로젝트 목록')
      await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(card => card.textContent.includes('삭제 충돌 검증'))`), 'temporary deletion-test project listed')
      await evaluate(`[...document.querySelectorAll('.project-card')].find(card => card.textContent.includes('삭제 충돌 검증')).click()`)
      await beginInlineEdit('공통 메모 수정', 'notes')
      const deletedDraft = '프로젝트가 삭제되어도 복사할 수 있어야 하는 초안'
      await fill('notes', deletedDraft)
      await evaluate(`window.lt.projects.remove(${JSON.stringify(deletedProject.id)}, ${JSON.stringify(deletedProject.updatedAt)})`)
      assert.equal(await currentProject(deletedProject.id), undefined, 'temporary project was removed externally')
      expectDeletedError = true
      await click('저장', '.project-inline-editor')
      await wait(() => evaluate(`document.querySelector('.project-dashboard').textContent.includes('프로젝트가 삭제되었거나 존재하지 않습니다')`), 'deleted project rejects inline save')
      assert.equal(await evaluate(`document.querySelector('.project-inline-editor textarea[name="notes"]').value`), deletedDraft, 'external deletion retains the inline draft')
      assert.equal(await currentProject(deletedProject.id), undefined, 'failed save does not recreate a deleted project')
      await click('취소', '.project-inline-editor')
      await wait(() => evaluate(`document.querySelector('.project-empty')?.textContent.includes('프로젝트를 찾을 수 없습니다') && !document.querySelector('.project-inline-editor')`), 'cancelling deleted project draft shows the missing-project state')
      expectDeletedError = false
      await click('프로젝트 목록')
      await wait(() => evaluate(`[...document.querySelectorAll('.project-card')].some(card => card.textContent.includes('A사 거래대금 회수'))`), 'original project still listed')
      await evaluate(`[...document.querySelectorAll('.project-card')].find(card => card.textContent.includes('A사 거래대금 회수')).click()`)
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'original project restored after deletion scenario')

      // Connection management goes directly to the requested control.
      const savesBeforeConnectionEditors = projectSaves().length
      win.setSize(900, 760)
      await click('사건 연결 관리')
      await wait(() => evaluate(`document.activeElement?.getAttribute('aria-label') === '연결할 사건 검색'`), 'case connection search receives focus')
      assert.equal(await evaluate(`document.querySelector('.project-dashboard').scrollWidth <= document.querySelector('.project-dashboard').clientWidth`), true, 'case connection editor fits in a narrow window')
      await click('취소', '.project-form-footer')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'case connection editor cancelled')
      await click('폴더 연결 관리')
      await wait(() => evaluate(`document.activeElement?.tagName === 'BUTTON' && document.activeElement?.textContent.trim() === '자료 폴더 연결'`), 'folder connection add control receives focus')
      await capture('project-folder-editor')
      const footerLayout = await evaluate(`(() => { const dashboard = document.querySelector('.project-dashboard'); const footer = document.querySelector('.project-form-footer'); const dashboardBounds = dashboard.getBoundingClientRect(); const footerBounds = footer.getBoundingClientRect(); return { sticky: getComputedStyle(footer).position === 'sticky', visible: footerBounds.top >= dashboardBounds.top && footerBounds.bottom <= Math.min(dashboardBounds.bottom, window.innerHeight) + 1, noOverflow: dashboard.scrollWidth <= dashboard.clientWidth, buttons: [...footer.querySelectorAll('button')].map(button => button.textContent.trim()) } })()`)
      assert.equal(footerLayout.sticky, true, 'full editor actions stay sticky')
      assert.equal(footerLayout.visible, true, 'full editor actions remain visible at the folder section')
      assert.equal(footerLayout.noOverflow, true, 'folder connection editor fits in a narrow window')
      assert.ok(footerLayout.buttons.includes('취소') && footerLayout.buttons.includes('변경사항 저장'), 'full editor footer contains both cancel and save')
      await click('취소', '.project-form-footer')
      await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'folder connection editor cancelled')
      assert.equal(projectSaves().length, savesBeforeConnectionEditors, 'opening and cancelling connection editors does not save')
      win.setSize(1440, 940)
      await evaluate(`document.querySelector('.project-dashboard').scrollTop = 0`)
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
      await click('자료 폴더 연결')
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
      await click('자료 폴더 연결')
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
      await click('자료 폴더 연결')
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
      console.log('project UI: configurable workspace creation/edit/reset, preserved reference folders, workspace file view, explicit location lookup/error/retry, inline edits/cancel/failure retry/conflict protection, focused connection management, sticky actions, cases/folder context, folder-only projects, durable CRUD, draft recovery, filtering, navigation, responsive layout and preserved files OK')
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

await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteSmoke })})`)
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
