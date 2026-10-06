import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'case-management-app-'))
const chosenDir = path.join(temp, 'existing-work')
const screenshot = path.join(root, '.omx/screenshots/case-management-app.png')
await fs.mkdir(chosenDir)
await fs.writeFile(path.join(chosenDir, 'existing.txt'), 'Synthetic existing folder; the app must not create a new work folder.\n')
await fs.mkdir(path.dirname(screenshot), { recursive: true })
await fs.access(path.join(root, 'out/main/index.js'))

function runApp({ root, temp, chosenDir, screenshot }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const assert = require('node:assert/strict')
  const calls = [], rendererErrors = [], unexpected = [], sessions = new Map()
  const cases = ['a','b','corrupt','cancel','switch'].map(id => ({ id, caseName: '통합 사건 '+id, status: 'active', caseNumber: null, court: null, division: null, caseType: null, parties: [], hearings: [] }))
  const rows = cases.map(c => ({ id: 'task-'+c.id, type:'todo', title: '통합 할일 '+c.id, status:'pending', caseId:c.id, caseName:c.caseName, dueDate:'2020-01-01', version:1 }))
  const pairs = new Map()
  let picker = 'normal', releasePicker, delayedLoad = false, releaseLoad, freshTitle = ''
  require('node:os').homedir = () => require('node:path').join(temp, 'home')
  const settings = { draftsRoot: chosenDir, sshProfiles: [], agentDefaultProvider: 'codex', agentDefaultPermissionMode: 'ask', notifyDone: false }
  app.setPath('userData', require('node:path').join(temp, 'profile'))
  BrowserWindow.prototype.show = function () {}
  global.fetch = async () => { throw Error('Smoke test blocked external fetch') }
  const register = ipcMain.handle.bind(ipcMain)
  const originalOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, callback) => originalOn(channel, channel === 'fs:watch' || channel.startsWith('pty:') ? () => {} : callback)
  const realChannels = new Set(['app:info', 'app:setWindowTitle', 'tabs:ready', 'workspace:save', 'workspace:list', 'workspace:load', 'caseManagement:get', 'caseManagement:update', 'workspace:autoSave', 'workspace:autoLoad', 'workspace:autoList', 'workspace:autoObserve'])
  ipcMain.handle = (channel, handler) => register(channel, async (event, ...args) => {
    const call = { channel, args }
    calls.push(call)
    if (channel === 'workspace:autoLoad' && delayedLoad) { delayedLoad = false; await new Promise(resolve => { releaseLoad = resolve }) }
    if (realChannels.has(channel)) {
      const result = await handler(event, ...args)
      call.result = result
      return result
    }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get') return settings
    if (channel === 'settings:set') return Object.assign(settings, args[0])
    if (channel === 'ssh:listDir') {
      const { profile, path: requestedPath } = args[0]
      if (profile.id === 'remote-error') return { ok: false, error: '합성 원격 경로 조회 실패' }
      return { ok: true, entries: [], cwd: `/home/${profile.id}${requestedPath === '~' ? '' : '/drafts'}` }
    }
    if (channel === 'js:hasToken') return true
    if (channel === 'js:tokenStatus') return { hasToken: true, error: null }
    if (channel === 'js:listCases') return { ok: true, cases }
    if (channel === 'js:getCase') return { ok:true, case: cases.find(c=>c.id===args[0]) }
    if (channel === 'todo:get') { const todo=rows.find(t=>t.id===args[0]);return {ok:true,todo:{...todo,...(freshTitle&&todo?.caseId==='a'?{title:freshTitle,version:2}:{})}} }
    if (channel === 'todo:create') { const todo={...args[0],id:'new-'+rows.length,type:'todo',status:'pending',version:1};rows.push(todo);return {ok:true,todo} }
    if (channel === 'case:getJsPairing') return pairs.get(args[0]) || null
    if (channel === 'case:setJsPairing') { pairs.set(args[0].id,{drafts:args[0].drafts,records:args[0].records});return undefined }
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:byFolder') return []
    if (channel === 'fs:stat') return {ok:true,isDir:true}
    if (channel === 'js:upcomingHearings') {
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
      const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10)
      return { ok: true, complete: true, fetchedAt: new Date().toISOString(), hearings: Array.from({ length: 42 }, (_, index) => ({ id: `hearing-${index}`, dateTime: `${index < 27 ? today : tomorrow}T10:00:00+09:00`, type: '변론', status: 'scheduled', case: { id: `case-${index}`, caseName: `합성 사건 ${index}`, parties: [], hearings: [] } })) }
    }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 27, weekCount: 42, fetchedAt: new Date().toISOString() } }
    if (channel === 'todo:list') return { ok: true, todos: args[0]?.type === 'memo' ? [] : rows }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: { queryFields: ['fields', 'includeClosed'], createFields: ['reviewAt', 'priority', 'parentId'], updateFields: ['reviewAt', 'priority', 'parentId', 'evidence'], statusFields: ['childDispositions'], evidenceSuggestions: true } }
    if (channel === 'dialog:pickFolder') { if (picker==='cancel') return null; if(picker==='hold') await new Promise(resolve=>{releasePicker=resolve}); return {path:chosenDir,name:'existing-work'} }
    if (channel === 'dialog:message') return true
    if (channel === 'case:history' || channel === 'fs:list' || channel === 'fs:listPdfs' || channel === 'sessions:list') return []
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'sessions:current' || channel === 'case:getPairing' || channel === 'case:getJsPairing') return null
    if (channel === 'case:addHistory') return []
    if (channel === 'sessions:remember') return undefined
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

      await wait(()=>evaluate(`!!document.querySelector('.welcome .todo-summary')`),'Initial summary')
      const enterTodos=async()=>{await evaluate(`smoke.click('.workspace-todo-header .header-btn')`);await wait(()=>evaluate(`document.querySelectorAll('.todo-card').length>=5`),'Open task cards')}
      const clickTask=async(id,label='사건 작업환경 열기')=>{await enterTodos();await evaluate(`{const c=[...document.querySelectorAll('.todo-card')].find(c=>c.querySelector('.todo-title')?.textContent==='통합 할일 ${id}');smoke.textButton(${JSON.stringify(label)},c)}`)}
      const counts=channel=>calls.filter(c=>c.channel===channel).length
      const selected=()=>evaluate(`window.lt.caseManagement.get().then(r=>r.state.ui.selectedTaskByCase)`)
      assert.equal(counts('agent:create'),0)
      picker='cancel';await clickTask('cancel');await wait(()=>counts('dialog:pickFolder')===1,'Canceled folder picker')
      await evaluate(`new Promise(r=>setTimeout(r,60))`)
      assert.equal(pairs.size,0,'Canceled picker does not pair a case')
      assert.deepEqual(await selected(),{},'Canceled picker does not select a task')
      assert.equal(counts('agent:create'),0,'Task start never creates an Agent')
      picker='hold';await clickTask('switch');await wait(()=>!!releasePicker,'Pending folder picker')
      win.webContents.send('js:tokenChanged')
      await evaluate(`new Promise(r=>setTimeout(r,60))`)
      releasePicker();await evaluate(`new Promise(r=>setTimeout(r,60))`)
      assert.equal(pairs.has('switch'),false,'Old-account picker result cannot pair case')
      assert.deepEqual(await selected(),{},'Old-account picker result cannot select task')
      picker='normal';delayedLoad=true;await clickTask('a');await wait(()=>!!releaseLoad,'Automatic restore is pending')
      assert.deepEqual(await selected(),{},'Start waits for pending automatic restore before saving selection')
      releaseLoad();await wait(async()=> (await selected()).a==='task-a','Task starts after restore finishes')
      assert.equal(counts('agent:create'),0,'Start remains AI-free')
      assert.equal(counts('agent:send'),0,'Start never sends prompt')
      const pickCount=counts('dialog:pickFolder');await clickTask('a');await wait(()=>evaluate(`document.querySelector('[aria-label="현재 사건의 다음 행동"]')?.textContent.includes('통합 할일 a')`),'Existing case reuse')
      assert.equal(counts('dialog:pickFolder'),pickCount,'Same-case repeat reuses workspace')
      await evaluate(`smoke.click('button[title="현재 작업환경 저장"]')`)
      await wait(()=>calls.some(c=>c.channel==='workspace:save'&&c.result?.ok),'Actual selected-task workspace save')
      const saved=calls.filter(c=>c.channel==='workspace:save').at(-1).result
      const savedSnapshot=JSON.parse(fs.readFileSync(saved.path,'utf8'))
      assert.equal(savedSnapshot.caseTabs.find(t=>t.meta?.jsId==='a').selectedTaskId,'task-a','Selected source task is persisted in workspace')
      const locationA={cwd:chosenDir,caseId:'a'}
      const autoSaved=await evaluate(`window.lt.workspace.autoSave(${JSON.stringify(savedSnapshot)},${JSON.stringify(locationA)})`)
      assert.equal(autoSaved.ok,true,'Automatic workspace save uses isolated storage')
      await clickTask('b');await wait(async()=> (await selected()).b==='task-b','Case B opens in same folder')
      const loadB=calls.filter(c=>c.channel==='workspace:autoLoad'&&c.args[0].caseId==='b').at(-1)
      assert.ok(loadB,'Case ID participates in automatic restore lookup')
      assert.equal(loadB.result.local?.snapshot??null,null,'Case A saved state is not restored into case B sharing folder')
      assert.equal(loadB.result.remote?.snapshot??null,null,'Shared copy also excludes case A')
      assert.equal(counts('agent:create'),0,'Same-folder case transition never imports an Agent')
      const crypto=require('node:crypto'),path=require('node:path')
      const corruptId=crypto.createHash('sha256').update(JSON.stringify(['case-workspace',null,chosenDir,'corrupt'])).digest('hex').slice(0,16)
      const corruptPath=path.join(app.getPath('userData'),'workspaces',corruptId+'.json')
      fs.writeFileSync(corruptPath,'{invalid-json')
      await clickTask('corrupt');await wait(()=>calls.some(c=>c.channel==='workspace:autoLoad'&&c.args[0].caseId==='corrupt'&&c.result?.ok===false),'Corrupt restore result')
      await wait(()=>calls.some(c=>c.channel==='dialog:message'&&String(c.args[1]).includes('작업환경')),'Restore failure is visible after leaving todos')
      assert.equal((await selected()).corrupt,undefined,'Failed restore does not save task selection')
      fs.unlinkSync(corruptPath)
      await clickTask('corrupt');await wait(async()=> (await selected()).corrupt==='task-corrupt','Retry after repairing corrupt saved state')
      assert.equal(calls.filter(c=>c.channel==='workspace:autoLoad'&&c.args[0].caseId==='corrupt').length,2,'Failed restore is retryable')
      freshTitle='서버에서 방금 수정된 최신 검토 업무'
      await clickTask('a','AI에게 다음 행동 제안받기')
      await wait(()=>evaluate(`!!document.querySelector('[aria-label="다음 행동 제안"]') && document.querySelector('.agent-composer textarea')?.value.includes('첨부한 할일')`),'Opt-in proposal draft')
      await wait(()=>counts('agent:create')>0,'Explicit proposal native Agent creation')
      assert.equal(counts('agent:create'),1,'Explicit AI proposal creates one Agent')
      assert.equal(counts('agent:send'),0,'Proposal preparation still requires explicit send')
      assert.equal(counts('todo:create'),0,'Proposal display cannot create task')
      assert.equal(await evaluate(`document.querySelector('[aria-label="다음 행동 제안"]').textContent.includes(${JSON.stringify(freshTitle)})`),true,'Proposal uses freshly fetched task title')
      await wait(()=>evaluate(`!!document.querySelector('.agent-send-btn:not([disabled])')`),'Proposal prompt ready')
      await evaluate(`smoke.click('.agent-send-btn')`)
      await wait(()=>counts('agent:send')===1,'Explicit proposal prompt sent')
      const sent=calls.filter(c=>c.channel==='agent:send').at(-1).args[0]
      assert.match(sent.input.attachments[0].text,/\[next-action:/,'Proposal marker travels in attachment')
      assert.ok(sent.input.attachments[0].text.includes(freshTitle),'Marker draft contains freshest task data')
      const sessionId=sent.sessionId,messageId='proposal-response'
      for(const event of [{type:'message:user',sessionId,text:sent.input.text,attachments:sent.input.attachments},{type:'message:assistant_start',sessionId,messageId},{type:'message:assistant_delta',sessionId,messageId,text:'다음 행동: 계좌내역 누락 월을 한 장으로 정리하기\n원문 날짜를 먼저 확인하세요.'},{type:'message:assistant_done',sessionId,messageId}])win.webContents.send('agent:event',event)
      await wait(()=>evaluate(`document.querySelector('[aria-label="다음 행동 제안"] input')?.value==='계좌내역 누락 월을 한 장으로 정리하기'`),'Bound assistant suggestion appears')
      assert.equal(counts('todo:create'),0,'Receiving AI suggestion still does not mutate task')
      await capture()
      win.setSize(600,900);await evaluate(`new Promise(r=>setTimeout(r,100))`)
      fs.writeFileSync(screenshot.replace('.png','-narrow.png'),(await win.webContents.capturePage()).toPNG())
      await evaluate(`{const input=document.querySelector('[aria-label="다음 행동 제안"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'직접 검토한 후속 업무');input.dispatchEvent(new Event('input',{bubbles:true}));}`)
      await evaluate(`smoke.textButton('후속 할일로 저장',document.querySelector('[aria-label="다음 행동 제안"]'))`)
      await wait(()=>counts('todo:create')===1,'User adopts edited proposal')
      const createdTask=calls.find(c=>c.channel==='todo:create').args[0]
      assert.equal(createdTask.caseId,'a','Proposal retains original case ID')
      assert.equal(createdTask.title,'직접 검토한 후속 업무','Only explicit edited proposal is stored')
      assert.equal(createdTask.parentId,undefined,'Different deliverable is an independent follow-up')
      assert.equal(createdTask.dueDate,undefined,'AI does not invent deadlines')
      assert.deepEqual([...new Set(unexpected)],[])
      assert.deepEqual(rendererErrors,[])
      console.log('CASE_APP_RESULT '+JSON.stringify({checks:31,ipcCalls:calls.length,rendererErrors,screenshot,isolatedAutomaticPersistence:true}))
      app.exit(0)
    } catch (error) {
      await capture()
      console.error(error)
      console.error('CASE_APP_DEBUG ' + JSON.stringify({ unexpected, rendererErrors, calls: calls.map(({ channel }) => channel), dom: win ? await evaluate('document.body.innerText').catch(() => '') : '' }))
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
  console.log(result.output.split('\n').filter((line) => line.includes('CASE_APP_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
