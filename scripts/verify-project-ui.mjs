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
const remoteAgentSmoke = process.argv.includes('--remote-agent') || process.argv.includes('--remote')
const projectFolderRaces = process.argv.includes('--project-folder-races')
const projectFolderIdentity = process.argv.includes('--project-folder-identity') || projectFolderRaces
const folderFocus = process.argv.find(arg => arg.startsWith('--folder-focus='))?.split('=')[1] ?? ''
assert.ok(!folderFocus || ['close-local', 'close-remote', 'restore-local', 'restore-remote'].includes(folderFocus), 'known folder-focus scenario')
const windowsFolderPaths = process.argv.includes('--windows-folder-paths')
assert.ok(!windowsFolderPaths || folderFocus, 'Windows folder paths require a folder-focus scenario')
const agentSmoke = process.argv.includes('--agent') || claudeAuthSmoke || remoteAgentSmoke || projectFolderIdentity
await fs.mkdir(screenshotDir, { recursive: true })

function runApp({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteAgentSmoke, projectFolderIdentity, projectFolderRaces, folderFocus, windowsFolderPaths }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = []
  const storeModule = { exports: {} }
  const ts = require(path.join(root, 'node_modules/typescript'))
  const sharedUiModule = { exports: {} }, uiStates = new Map()
  const sharedUiCode = ts.transpileModule(fs.readFileSync(path.join(root, 'src/shared/sharedUiState.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  require('node:vm').runInNewContext(sharedUiCode, { module: sharedUiModule, exports: sharedUiModule.exports })
  require('node:vm').runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/projectStore.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports: storeModule.exports, require })
  const remoteProjectStore = new storeModule.exports.ProjectStore(path.join(temp, 'profile', 'projects.json'))
  const agentProvider = claudeAuthSmoke ? 'claude' : 'codex'
  const agents = new Map(), workspaces = new Map()
  const caseDir = path.join(temp, 'case-a')
  const contextDir = path.join(temp, '공통 계약·증거')
  fs.mkdirSync(caseDir)
  fs.mkdirSync(contextDir)
  fs.writeFileSync(path.join(caseDir, 'evidence.txt'), 'keep this evidence')
  fs.writeFileSync(path.join(contextDir, 'contract.txt'), 'keep this context')
  const sharedProfile = { id: 'office', label: '사무실 서버', host: 'example.invalid', user: 'lawyer' }
  const sharedCaseDir = '/home/lawyer/cases/case-a'
  const sharedCasePaths = [sharedCaseDir, '/home/lawyer/cases/case-b']
  const remoteIdentity = projectFolderIdentity && remoteAgentSmoke
  const history = [
    { drafts: folderFocus || remoteIdentity ? `ssh://${sharedProfile.id}${sharedCasePaths[0]}` : caseDir, name: 'A사 거래대금 청구', ts: Date.now() },
    { drafts: folderFocus || remoteIdentity ? `ssh://${sharedProfile.id}${sharedCasePaths[1]}` : path.join(temp, 'case-b'), name: 'A사 채권 가압류', ts: Date.now() - 1000 }
  ]
  const jsCase = { id: 'js-1', caseNumber: '2026타채12345', caseName: 'A사 채권압류 및 추심', court: '서울중앙지방법원', division: null, caseType: 'civil', status: 'active', parties: [], hearings: [] }
  let connected = false, failSave = false, cancelFolder = false
  let profiles = folderFocus || remoteIdentity ? [sharedProfile] : [], caseOpenTarget = 'local', staleLocalWorkspace = null
  const workspaceKey = location => JSON.stringify([location.cwd, location.profileId ?? null, location.ssh?.host ?? null, location.ssh?.user ?? null, location.projectId ?? location.workspaceContext?.projectId ?? null])
  let pickedFolder = { path: windowsFolderPaths ? path.win32.join('C:/Users/fixture/Documents', '공통 계약·증거') : contextDir, name: '공통 계약·증거' }
  let holdFolder = false, releaseFolder, holdRestore = false, releaseRestore, holdWorkingFolder = false, releaseWorkingFolder
  const sharedCases = folderFocus ? history.map((item, index) => ({
    version: 1, mode: 'explorer', savedAt: '2026-10-19T00:00:00Z', workspaceOpenedAt: `2026-10-0${index + 1}T00:00:00Z`,
    workspaceOpen: true, currentCase: { drafts: sharedCasePaths[index], name: item.name }, docs: [], terminals: []
  })) : []
  if (folderFocus) {
    assert.ok(sharedCases.every(item => item.currentCase.drafts.startsWith('/') && !item.currentCase.drafts.includes('\\')),
      'shared snapshots use Unix remote paths independently of Windows local paths')
    assert.ok(history.every(item => item.drafts.startsWith(`ssh://${sharedProfile.id}/`)), 'history matches the shared SSH endpoint')
    assert.ok(sharedCases.every(item => item.currentCase.drafts !== pickedFolder.path), 'local reference folders do not become shared case paths')
    if (windowsFolderPaths) assert.ok(path.win32.isAbsolute(pickedFolder.path) && !pickedFolder.path.startsWith('/'), 'exercise a Windows native folder result')
  }
  require('node:os').homedir = () => path.join(temp, 'home')
  app.setPath('userData', path.join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('External network blocked by test') }
  const handle = ipcMain.handle.bind(ipcMain), on = ipcMain.on.bind(ipcMain)
  const handlers = new Map()
  ipcMain.on = (channel, cb) => on(channel, channel.startsWith('fs:') || channel.startsWith('pty:') ? () => {} : cb)
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler)
    return handle(channel, async (event, ...args) => {
    calls.push({ channel, args, senderId: event.sender.id })
    // The user opens a project while the general-chat directory is still loading.
    if (channel === 'app:generalChatDirectory') return new Promise(() => {})
    if (channel === 'projects:save' && failSave) throw Error('검증용 저장 실패')
    if (channel === 'projects:setWorkingFolder' && projectFolderIdentity) {
      let result
      if (remoteIdentity) {
        const [id, folder, expectedUpdatedAt] = args
        const current = (await remoteProjectStore.list()).find(project => project.id === id)
        assert.ok(current, 'remote fixture targets an existing project')
        assert.equal(current.executionProfileId, sharedProfile.id)
        assert.ok(folder.path.startsWith(`ssh://${sharedProfile.id}/`), 'remote fixture preserves the selected execution server')
        // Keep remote I/O synthetic while exercising the real store's CAS and atomic save.
        const project = await remoteProjectStore.save({ ...current, expectedUpdatedAt, workingFolder: folder })
        result = { project, cwd: folder.path.replace(/^ssh:\/\/[^/]+/, ''), profileId: sharedProfile.id, ssh: { host: sharedProfile.host, user: sharedProfile.user } }
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('projects:changed')
      } else result = await handler(event, ...args)
      for (const [id, agent] of agents) if (agent.workspaceContext?.projectId === result.project.id) agents.set(id, { ...agent, cwd: result.cwd })
      if (holdWorkingFolder) {
        holdWorkingFolder = false
        await new Promise(resolve => { releaseWorkingFolder = resolve })
      }
      return result
    }
    if (channel === 'projects:workspace' && remoteAgentSmoke) {
      const project = JSON.parse(fs.readFileSync(path.join(temp, 'profile', 'projects.json'), 'utf8')).projects.find(project => project.id === args[0])
      if (project?.executionProfileId) return { project, cwd: project.workingFolder?.path?.replace(/^ssh:\/\/[^/]+/, '') ?? `/home/lawyer/.legal-terminal/project-workspaces/${project.id}` }
    }
    if (channel.startsWith('projects:') || ['app:info', 'app:setWindowTitle', 'tabs:ready', 'caseManagement:get', 'caseManagement:update'].includes(channel)) return handler(event, ...args)
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return { sshProfiles: profiles, caseOpenTarget, notifyDone: false, agentDefaultProvider: agentSmoke ? agentProvider : 'claude' }
    if (channel === 'dialog:pickFolder') {
      if (holdFolder) { holdFolder = false; return new Promise(resolve => { releaseFolder = resolve }) }
      return cancelFolder ? null : pickedFolder
    }
    if (channel === 'ssh:listDir') return { ok: true, cwd: projectFolderIdentity && args[0].path.startsWith('/') ? args[0].path : args[0].path === '~/research' ? '/home/lawyer/research' : '/home/lawyer', entries: [] }
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
    if (channel === 'workspace:autoList') return { ok: true, snapshots: folderFocus && args[0]?.host === sharedProfile.host && args[0]?.user === sharedProfile.user ? structuredClone(sharedCases) : [] }
    if (channel === 'workspace:autoLoad') {
      if (folderFocus) {
        if (holdRestore && args[0].cwd === sharedCaseDir && args[1] === false) {
          holdRestore = false
          await new Promise(resolve => { releaseRestore = resolve })
        }
        return { ok: true, remote: { ok: true, snapshot: structuredClone(sharedCases.find(item => item.currentCase.drafts === args[0].cwd) ?? null) } }
      }
      if (agentSmoke) await new Promise(resolve => setTimeout(resolve, 60))
      return { ok: true, ...(staleLocalWorkspace ? { local: { ok: true, snapshot: staleLocalWorkspace } } : {}), remote: { ok: true, snapshot: workspaces.get(workspaceKey(args[0])) ?? null } }
    }
    if (channel === 'workspace:autoSave') {
      if (agentSmoke) {
        const key = workspaceKey(args[0].location), snapshot = args[0].snapshot
        workspaces.set(key, projectFolderIdentity ? { ...snapshot,
          workspaceOpen: workspaces.get(key)?.workspaceOpen === false && !snapshot.workspaceReopen ? false : snapshot.workspaceOpen !== false
        } : snapshot)
      }
      return { ok: true }
    }
    if (channel === 'workspace:sharedUiRead' || channel === 'workspace:sharedUiApply') {
      const host = `${args[0].user}@${args[0].host}:${args[0].port ?? 22}`
      const state = uiStates.get(host) ?? sharedUiModule.exports.emptySharedUiState()
      if (channel === 'workspace:sharedUiApply') sharedUiModule.exports.applySharedUiOperation(state, args[1])
      uiStates.set(host, state)
      return { ok: true, state: structuredClone(state) }
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
    if (channel === 'agent:close') {
      if (projectFolderIdentity) agents.delete(args[0])
      return { ok: true }
    }
    if (channel === 'agent:setModel' || channel === 'agent:slashCommand') return { ok: true }
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
  }
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
      if (projectFolderIdentity) {
        const name = '독립된 연구 프로젝트'
        const referencePath = remoteIdentity ? `ssh://${sharedProfile.id}${sharedCaseDir}` : caseDir
        const expectedCwd = remoteIdentity ? sharedCaseDir : fs.realpathSync.native(caseDir)
        const workingPaths = new Set([referencePath, remoteIdentity ? referencePath : expectedCwd])
        const selectRemoteReference = async () => {
          await wait(() => evaluate(`!!document.querySelector('.conn-menu, .remote-picker')`), 'project reference source picker')
          if (await evaluate(`!!document.querySelector('.conn-menu')`)) await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[1].click()`)
          await wait(() => evaluate(`!!document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]')`), 'remote reference browser')
          await evaluate(`(() => { const el = document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(sharedCaseDir)}); el.dispatchEvent(new Event('input', {bubbles:true})) })()`)
          await click('입력 경로 선택', '.remote-picker')
        }
        pickedFolder = { path: caseDir, name: 'A사 거래대금 청구' }
        await evaluate(`document.querySelector('.project-open-button').click()`)
        await wait(() => evaluate(`!!document.querySelector('.project-dashboard') && !document.querySelector('.project-dashboard').textContent.includes('불러오는 중')`), 'identity project editor ready')
        await click('+ 새 프로젝트')
        await fill('name', name)
        await fill('goal', '기존 사건 폴더를 참고자료로 연결')
        await fill('notes', '프로젝트의 작업 위치는 그대로 유지')
        if (remoteIdentity) await fill('executionProfileId', sharedProfile.id)
        await evaluate(`void (window.identityProjectEditor = document.querySelector('.project-editor'))`)
        await click('자료 폴더 연결')
        if (remoteIdentity) await selectRemoteReference()
        await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'existing case linked from project settings')
        assert.equal(await evaluate(`document.querySelector('.project-editor') === window.identityProjectEditor`), true, 'choosing a known case folder keeps the same project form')
        assert.equal(await evaluate(`document.querySelector('[name="name"]').value`), name, 'settings folder selection preserves project name before save')
        assert.equal(await evaluate(`document.querySelector('[name="notes"]').value`), '프로젝트의 작업 위치는 그대로 유지')
        assert.equal(await evaluate(`document.querySelector('.project-folder-option').textContent.includes(${JSON.stringify(referencePath)})`), true)
        assert.equal(calls.some(call => ['case:addHistory', 'agent:create', 'agent:send'].includes(call.channel)), false, 'settings folder selection does not open the existing case or start a conversation')
        // Remove this unsaved reference so the toolbar must perform a fresh link below.
        await evaluate(`document.querySelector('.project-folder-option button').click()`)
        await click('프로젝트 만들기')
        await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'identity project saved')
        const project = (await evaluate('window.lt.projects.list()'))[0]
        await assert.rejects(handlers.get('projects:save')({ sender: win.webContents }, {
          ...project, expectedUpdatedAt: project.updatedAt,
          workingFolder: { name: '우회 변경', path: referencePath }
        }), /작업 폴더 변경 메뉴/, 'ordinary project edits cannot bypass the dedicated working-folder mutation')
        assert.deepEqual((await evaluate('window.lt.projects.list()'))[0], project, 'rejected general saves preserve project data')
        const caseKey = workspaceKey({ cwd: expectedCwd, ...(remoteIdentity ? { profileId: sharedProfile.id, ssh: { host: sharedProfile.host, user: sharedProfile.user } } : {}) })
        const existingCase = { version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceOpen: true,
          currentCase: { drafts: expectedCwd, name: 'A사 거래대금 청구' }, docs: [],
          terminals: [{ id: 'existing-case-agent', title: '기존 사건 대화', kind: 'agent', cwd: expectedCwd, resumeSessionId: 'unrelated-case-conversation' }] }
        workspaces.set(caseKey, structuredClone(existingCase))
        const closedProjectKey = workspaceKey({ cwd: expectedCwd, projectId: project.id,
          ...(remoteIdentity ? { profileId: sharedProfile.id, ssh: { host: sharedProfile.host, user: sharedProfile.user } } : {}) })
        workspaces.set(closedProjectKey, { version: 1, savedAt: new Date().toISOString(), mode: 'explorer', workspaceOpen: false,
          currentCase: { drafts: expectedCwd, name: `프로젝트 · ${name}`, meta: { contextKind: 'project', projectId: project.id } }, docs: [], terminals: [] })
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => agents.size === 1, 'identity project agent opened')
        const original = structuredClone([...agents.values()][0])
        const resumeSessionId = 'prior-project-conversation'
        agents.set(original.id, { ...original, resumeSessionId })
        win.webContents.send('agent:event', { type: 'status', sessionId: original.id, status: 'done' })
        await wait(() => workspaces.get(workspaceKey({ ...original, ...(remoteIdentity ? { profileId: sharedProfile.id } : {}) }))?.currentCase?.meta?.projectId === project.id, 'initial project workspace saved')
        const key = workspaceKey({ ...original, ...(remoteIdentity ? { profileId: sharedProfile.id } : {}) })
        await wait(() => workspaces.get(key)?.terminals.some(term => term.resumeSessionId === resumeSessionId), 'existing project conversation remembered before changing folder')
        const before = structuredClone(workspaces.get(key))
        await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(el => el.textContent.includes('프로젝트 · ' + ${JSON.stringify(name)})).click()`)
        await evaluate(`document.querySelectorAll('.side-view-switch button')[1].click()`)
        const showProjectFiles = async () => {
          if (!await evaluate(`!!document.querySelector('[aria-label="작성서류 폴더 변경"]')`)) {
            await evaluate(`document.querySelector('.activity-item[title^="탐색기 표시"]').click()`)
          }
          await wait(() => evaluate(`!!document.querySelector('[aria-label="작성서류 폴더 변경"]')`), 'project file toolbar')
        }
        const choose = async () => {
          await showProjectFiles()
          await evaluate(`document.querySelector('[aria-label="작성서류 폴더 변경"]').click()`)
          if (remoteIdentity) await selectRemoteReference()
        }
        await choose()
        await wait(async () => workingPaths.has((await evaluate('window.lt.projects.list()')).find(item => item.id === project.id)?.workingFolder?.path), 'existing case folder assigned to the project without changing its identity')
        await choose()
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await showProjectFiles()
        const saved = (await evaluate('window.lt.projects.list()')).find(item => item.id === project.id)
        assert.equal(saved.name, name, 'working folder selection keeps the project name')
        assert.equal(workingPaths.has(saved.workingFolder.path), true, 'selected working folder is saved')
        assert.equal(saved.folders.length, 0, 'working folder assignment is distinct from reference folders')
        const assigned = await evaluate(`window.lt.projects.workspace(${JSON.stringify(project.id)})`)
        assert.equal(assigned.cwd, expectedCwd, 'project backend reuses the selected working folder')
        const nextKey = workspaceKey({ ...original, cwd: expectedCwd, ...(remoteIdentity ? { profileId: sharedProfile.id } : {}) })
        await wait(() => workspaces.get(nextKey)?.terminals.some(term => term.resumeSessionId === resumeSessionId), 'assigned project workspace and original conversation saved')
        assert.equal(agents.size, 1, 'folder assignment keeps the project conversation')
        assert.equal([...agents.values()][0].cwd, expectedCwd, 'project agent uses the assigned folder')
        assert.equal([...agents.values()][0].workspaceContext.projectId, project.id)
        const after = workspaces.get(nextKey)
        assert.equal(nextKey, closedProjectKey)
        assert.equal(after.workspaceOpen, true, 'assigning a previously closed project folder explicitly reopens that scope')
        assert.equal(after.currentCase.name, before.currentCase.name)
        assert.equal(after.currentCase.drafts, remoteIdentity ? referencePath : expectedCwd)
        assert.equal(after.currentCase.meta.projectId, project.id)
        assert.equal(calls.some(call => ['case:addHistory', 'case:setPairing', 'case:setJsPairing', 'agent:send'].includes(call.channel)), false, 'folder assignment creates neither case history/pairing nor a prompt')
        await evaluate(`document.querySelectorAll('.side-view-switch button')[0].click()`)
        assert.equal(await evaluate(`[...document.querySelectorAll('.case-sidebar-case-title')].filter(el => el.textContent === 'A사 거래대금 청구').length`), 1, 'existing case name remains unchanged')
        assert.equal(await evaluate(`[...document.querySelectorAll('.case-sidebar-case-title')].filter(el => el.textContent === '프로젝트 · ' + ${JSON.stringify(name)}).length`), 1, 'project remains separate from the case')
        assert.equal(await evaluate(`[...document.querySelectorAll('.case-sidebar-group[data-open="true"]')].some(el => el.querySelector('.case-sidebar-case-title')?.textContent === '프로젝트 · ' + ${JSON.stringify(name)})`), true, 'assigned project remains open after returning to its previously closed folder')
        agents.clear()
        await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
        await evaluate(`document.querySelector('.project-open-button').click()`)
        await wait(() => evaluate(`!!document.querySelector('.project-card')`), 'assigned project listed after restart')
        await evaluate(`document.querySelector('.project-card').click()`)
        await evaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
        await wait(() => agents.size === 1, 'assigned project reopens after restart')
        const reopened = [...agents.values()][0]
        assert.equal(reopened.cwd, expectedCwd, 'restart preserves assigned project working folder')
        assert.equal(reopened.workspaceContext.projectId, project.id)
        assert.equal(reopened.resumeSessionId, resumeSessionId, 'restart resumes the project conversation instead of the folder case')
        assert.deepEqual(workspaces.get(caseKey), existingCase, 'project assignment and restart never overwrite the existing case workspace')
        assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'folder assignment and reopening never submit a prompt')
        if (projectFolderRaces) {
          assert.equal(remoteIdentity, false, 'race scenarios use the isolated local host')
          const peer = new BrowserWindow({ show: false, width: 1440, height: 940,
            webPreferences: { preload: path.join(root, 'out/preload/index.js'), sandbox: false, contextIsolation: true } })
          peer.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
          await peer.loadURL(win.webContents.getURL())
          const peerEvaluate = source => peer.webContents.executeJavaScript(source, true)
          await wait(() => peerEvaluate(`!!document.querySelector('.project-open-button')`), 'second renderer ready')
          await peerEvaluate(`document.querySelector('.project-open-button').click()`)
          await wait(() => peerEvaluate(`!!document.querySelector('.project-card')`), 'project shared with second window')
          await peerEvaluate(`document.querySelector('.project-card').click()`)
          await peerEvaluate(`document.querySelector('[aria-label="프로젝트 AI 작업"]').click()`)
          await wait(() => calls.some(call => call.channel === 'agent:create' && call.senderId === peer.webContents.id && call.args[0].id === reopened.id) &&
            peerEvaluate(`document.querySelector('[aria-label="프로젝트 새 대화"]')?.disabled === false`), 'second window project restored')
          await peerEvaluate(`document.querySelector('[aria-label="프로젝트 새 대화"]').click()`)
          await wait(() => calls.some(call => call.channel === 'agent:create' && call.senderId === peer.webContents.id && call.args[0].id !== reopened.id), 'independent project conversation in second window')
          const peerAgent = calls.find(call => call.channel === 'agent:create' && call.senderId === peer.webContents.id && call.args[0].id !== reopened.id).args[0]
          assert.notEqual(peerAgent.id, reopened.id)
          const peerResume = 'independent-second-window-conversation'
          agents.set(peerAgent.id, { ...agents.get(peerAgent.id), resumeSessionId: peerResume })
          peer.webContents.send('agent:event', { type: 'status', sessionId: peerAgent.id, status: 'done' })
          const projectSnapshot = windowId => calls.filter(call => call.channel === 'workspace:autoSave' && call.senderId === windowId &&
            call.args[0].snapshot.currentCase?.meta?.projectId === project.id).at(-1)?.args[0].snapshot
          await wait(() => projectSnapshot(peer.webContents.id)?.terminals.some(term => term.id === peerAgent.id && term.resumeSessionId === peerResume), 'second conversation persisted')
          await peerEvaluate(`document.querySelectorAll('.side-view-switch button')[0].click()`)
          await peerEvaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(el => el.textContent.includes('A사 거래대금 청구')).click()`)
          await wait(() => peerEvaluate(`document.querySelector('.case-sidebar-group.active .case-sidebar-case-title')?.textContent === 'A사 거래대금 청구'`), 'second window focuses a different case')
          await evaluate(`document.querySelectorAll('.side-view-switch button')[0].click()`)
          await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(el => el.textContent.includes('프로젝트 · ' + ${JSON.stringify(name)})).click()`)
          await evaluate(`document.querySelectorAll('.side-view-switch button')[1].click()`)
          const movedCwd = fs.realpathSync.native(contextDir)
          pickedFolder = { path: contextDir, name: '공통 계약·증거' }
          await choose()
          for (const windowId of [win.webContents.id, peer.webContents.id]) {
            await wait(() => projectSnapshot(windowId)?.currentCase.drafts === movedCwd &&
              projectSnapshot(windowId).terminals.every(term => term.cwd === movedCwd), 'both renderers persist the same moved project root')
          }
          for (const [windowId, id, resume] of [[win.webContents.id, reopened.id, resumeSessionId], [peer.webContents.id, peerAgent.id, peerResume]]) {
            assert.ok(projectSnapshot(windowId).terminals.some(term => term.id === id && term.resumeSessionId === resume), 'each window keeps its own conversation identity')
            assert.equal(agents.get(id).cwd, movedCwd)
          }
          assert.equal(await peerEvaluate(`document.querySelector('.case-sidebar-group.active .case-sidebar-case-title')?.textContent`), 'A사 거래대금 청구', 'project relocation never steals the other window focus')
          assert.equal(workspaces.get(caseKey).currentCase.name, existingCase.currentCase.name, 'other window case keeps its identity after project relocation')
          assert.equal(workspaces.get(caseKey).currentCase.drafts, expectedCwd)
          assert.equal(workspaces.get(caseKey).terminals.some(term => term.projectId === project.id), false, 'project conversations never enter the other case workspace')

          // Hold only the IPC reply: the real store transaction and cross-window event finish first.
          pickedFolder = { path: caseDir, name: 'A사 거래대금 청구' }
          holdWorkingFolder = true
          await choose()
          await wait(() => typeof releaseWorkingFolder === 'function', 'working folder reply held')
          await evaluate(`document.querySelectorAll('.side-view-switch button')[0].click()`)
          await evaluate(`[...document.querySelectorAll('.case-sidebar-group')].find(el => el.querySelector('.case-sidebar-case-title')?.textContent === '프로젝트 · ' + ${JSON.stringify(name)}).querySelector('.case-sidebar-manage').click()`)
          await click('사건 닫기', '.tab-context-menu')
          await wait(() => evaluate(`[...document.querySelectorAll('.case-sidebar-group[data-open="true"]')].every(el => el.querySelector('.case-sidebar-case-title')?.textContent !== '프로젝트 · ' + ${JSON.stringify(name)})`), 'project closed while folder reply pending')
          await evaluate(`[...document.querySelectorAll('.case-sidebar-case')].find(el => el.textContent.includes('A사 채권 가압류')).click()`)
          await wait(() => evaluate(`document.querySelector('.case-sidebar-group.active .case-sidebar-case-title')?.textContent === 'A사 채권 가압류'`), 'different case selected before folder reply')
          const activeCaseState = `(() => { const el = document.querySelector('.case-sidebar-group.active'); return {id:el?.dataset.caseId,title:el?.querySelector('.case-sidebar-case-title')?.textContent,path:el?.querySelector('.case-sidebar-case')?.title.split('\\n').at(-1)} })()`
          const activeCaseBefore = await evaluate(activeCaseState)
          const savesBeforeReply = calls.length
          releaseWorkingFolder()
          await evaluate('new Promise(resolve => setTimeout(resolve, 1600))')
          assert.deepEqual(await evaluate(activeCaseState), activeCaseBefore, 'late project response leaves the selected case unchanged')
          assert.equal(await evaluate(`[...document.querySelectorAll('.case-sidebar-group[data-open="true"]')].some(el => el.querySelector('.case-sidebar-case-title')?.textContent === '프로젝트 · ' + ${JSON.stringify(name)})`), false, 'late response does not reopen the closed project')
          assert.equal(calls.slice(savesBeforeReply).some(call => call.senderId === win.webContents.id && call.channel === 'workspace:autoSave' &&
            call.args[0].snapshot.currentCase?.meta?.projectId === project.id && call.args[0].snapshot.workspaceOpen !== false), false, 'closed project is never republished as open by a late reply')
          assert.equal((await evaluate('window.lt.projects.list()')).find(item => item.id === project.id).workingFolder.path, expectedCwd, 'completed folder transaction still persists after closing its view')
          assert.equal(calls.some(call => call.channel === 'agent:send'), false)
          console.log('project folder races: both real renderers relocate with distinct conversations and preserved focus; late assignment cannot reopen a closed project or overwrite another case OK')
          peer.destroy()
        }
        assert.equal(fs.readFileSync(path.join(caseDir, 'evidence.txt'), 'utf8'), 'keep this evidence')
        assert.deepEqual(errors, [])
        console.log(`project folder identity: ${remoteIdentity ? 'SSH' : 'local'} existing case folder assignment preserves project identity/conversation, persists cwd across restart and sends no prompt OK`)
        app.exit(0)
        return
      }
      if (folderFocus) {
        const closing = folderFocus.startsWith('close-')
        const remote = folderFocus.endsWith('-remote')
        await wait(() => evaluate(`document.querySelectorAll('.case-sidebar-group[data-open="true"]').length === 2`), 'shared case shells')
        await evaluate(`document.querySelector('.case-sidebar-case').click()`)
        await wait(() => calls.some(call => call.channel === 'workspace:autoLoad' && call.args[0].cwd === sharedCaseDir), 'active empty case restored')
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        if (!closing) await evaluate(`window.lt.projects.save({name:'기존 프로젝트',goal:'기존 목표',nextAction:'',notes:'',cases:[],folders:[],status:'active'})`)
        await evaluate(`document.querySelector('.project-open-button').click()`)
        await wait(() => evaluate(`!!document.querySelector('.project-dashboard') && !document.querySelector('.project-dashboard').textContent.includes('불러오는 중')`), 'project view before picking')
        if (closing) await click('+ 새 프로젝트')
        else {
          await evaluate(`document.querySelector('.project-card').click()`)
          await click('프로젝트 수정')
        }
        await fill('name', '폴더 선택 중 프로젝트')
        await fill('goal', '선택 중에도 프로젝트 목표 유지')
        await fill('notes', '저장하지 않은 프로젝트 설명 유지')
        await evaluate(`void (window.projectEditorBeforePick = document.querySelector('.project-editor'))`)
        if (!remote) holdFolder = true
        await click('자료 폴더 연결')
        await wait(() => evaluate(`!!document.querySelector('.conn-menu')`), 'reference folder source chooser')
        if (remote) {
          await evaluate(`document.querySelectorAll('.conn-menu .conn-row')[1].click()`)
          await wait(() => evaluate(`document.querySelector('.remote-cwd')?.textContent === '/home/lawyer'`), 'remote picker ready')
          await evaluate(`(() => { const el = document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '~/research'); el.dispatchEvent(new Event('input', {bubbles:true})) })()`)
        } else {
          await evaluate(`document.querySelector('.conn-menu .conn-row').click()`)
          await wait(() => typeof releaseFolder === 'function', 'native picker reply held')
        }
        if (closing) sharedCases[0].workspaceOpen = false
        else holdRestore = true
        await evaluate(`window.dispatchEvent(new Event('focus'))`)
        if (closing) {
          await wait(() => evaluate(`[...document.querySelectorAll('.case-sidebar-group')].find(el => el.querySelector('.case-sidebar-case-title')?.textContent === 'A사 거래대금 청구')?.dataset.open === 'false'`), 'shared active case closes while picking')
        } else {
          await wait(() => typeof releaseRestore === 'function', 'background restore reply held')
          sharedCases[0].terminals = [{ id: 'late-folder-agent', title: '늦게 도착한 다른 작업', kind: 'agent', cwd: sharedCaseDir, agentProvider: 'claude', resumeSessionId: 'late-folder-session' }]
          releaseRestore()
          await wait(() => calls.some(call => call.channel === 'workspace:autoObserve' && call.args[0].cwd === sharedCaseDir
            && call.args[1].terminals?.some(term => term.id === 'late-folder-agent')), 'late background restore applied')
        }
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        assert.equal(await evaluate(`document.querySelector('.project-editor') === window.projectEditorBeforePick`), true,
          `${folderFocus}: background workspace change must keep the same project editor mounted`)
        for (const [name, value] of [['name', '폴더 선택 중 프로젝트'], ['goal', '선택 중에도 프로젝트 목표 유지'], ['notes', '저장하지 않은 프로젝트 설명 유지']]) {
          assert.equal(await evaluate(`document.querySelector('[name="${name}"]')?.value`), value, `${folderFocus}: preserve ${name}`)
        }
        if (remote) {
          assert.equal(await evaluate(`document.querySelector('.remote-cwd')?.textContent`), '/home/lawyer', 'remote browsing position survives')
          assert.equal(await evaluate(`document.querySelector('.remote-picker input[placeholder^="원격 경로 입력"]')?.value`), '~/research', 'typed remote path survives')
          await click('입력 경로 선택', '.remote-picker')
        } else releaseFolder(pickedFolder)
        await wait(() => evaluate(`document.querySelectorAll('.project-folder-option').length === 1`), 'selection adds one project folder')
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        assert.equal(await evaluate(`document.querySelectorAll('.project-folder-option').length`), 1, 'selection is not duplicated by refresh')
        await click(closing ? '프로젝트 만들기' : '변경사항 저장')
        await wait(() => evaluate(`!!document.querySelector('.project-detail')`), 'project remains saveable')
        const saved = await evaluate('window.lt.projects.list()')
        assert.equal(saved.length, 1)
        assert.equal(saved[0].name, '폴더 선택 중 프로젝트')
        assert.equal(saved[0].notes, '저장하지 않은 프로젝트 설명 유지')
        assert.deepEqual(saved[0].folders, [remote ? { path: 'ssh://office/home/lawyer/research', name: 'research' } : pickedFolder])
        assert.equal(calls.some(call => call.channel === 'agent:send'), false, 'folder linking never submits a prompt')
        assert.deepEqual(errors, [])
        console.log(`project folder focus: ${folderFocus} preserves form, inputs, picker location and one saved folder OK`)
        app.exit(0)
        return
      }
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
        assert.equal(await evaluate(`!!document.querySelector('.work-right .agent-panel[data-visible="true"] [aria-label="음성 입력 시작"]')`), true, 'project agents also offer dictation')
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
      for (const [field, label] of [['goal', '공통 목표'], ['nextAction', '다음 행동'], ['notes', '공통 메모']]) {
        const before = (await evaluate('window.lt.projects.list()'))[0]
        await evaluate(`document.querySelector('[aria-label="${label} 수정"]').click()`)
        await wait(() => evaluate(`!!document.querySelector('.project-inline-editor [name="${field}"]')`), 'inline field editor')
        const revised = `${before[field]} (직접 수정)`
        await fill(field, revised)
        if (field === 'notes') {
          failSave = true
          await click('저장')
          await wait(() => evaluate(`document.querySelector('.project-inline-editor')?.textContent.includes('검증용 저장 실패')`), 'inline save error')
          assert.equal(await evaluate(`document.querySelector('.project-inline-editor [name="${field}"]').value`), revised, 'failed inline save preserves the draft')
          failSave = false
        }
        await click('저장')
        await wait(() => evaluate(`!document.querySelector('.project-inline-editor')`), 'inline edit saved')
        const after = (await evaluate('window.lt.projects.list()'))[0]
        assert.equal(after[field], revised)
        assert.equal(after.id, before.id)
        assert.deepEqual(after.cases, before.cases, 'inline editing preserves case links')
        assert.deepEqual(after.folders, before.folders, 'inline editing preserves reference folders')
        assert.equal(after.executionProfileId, before.executionProfileId)
        assert.deepEqual(after.workingFolder, before.workingFolder)
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

await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshotDir, agentSmoke, claudeAuthSmoke, remoteAgentSmoke, projectFolderIdentity, projectFolderRaces, folderFocus, windowsFolderPaths })})`)
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
