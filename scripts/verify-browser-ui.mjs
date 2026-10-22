// Real renderer/preload with isolated IPC fixtures; no provider, SSH server, or external website is contacted.
// Run after npm run build. Screenshots are saved for visual layout review.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-browser-ui-'))
const screenshotDir = path.join(root, 'output/playwright/browser')
await fs.mkdir(screenshotDir, { recursive: true })

function runApp({ root, temp, screenshotDir, provider, mode, remote }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const calls = [], errors = [], unexpected = [], agents = new Map(), browsers = new Map()
  let frameFailure = false, unchangedFrame = false, frameRequests = 0, failLocation = '', stateFailure = false
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
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
  const settings = { sshProfiles: remote ? [phoneProfile] : [], caseOpenTarget: remote ? 'remote:phone-host' : 'local', notifyDone: false, agentDefaultProvider: provider }
  let releaseSettings
  const settingsReady = new Promise(resolve => { releaseSettings = resolve })
  app.setPath('userData', path.join(temp, 'profile'))
  app.setPath('home', homeDir)
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.maximize = function () {}
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
    if (channel === 'js:upcomingHearings') return { ok: true, hearings: [], complete: true }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'todo:list') return { ok: true, todos: [] }
    if (channel === 'todo:capabilities') return { ok: true, capabilities: {} }
    if (['fs:list', 'fs:listPdfs', 'sessions:list', 'projects:list'].includes(channel)) return []
    if (channel === 'fs:loadDocumentDraft') return { ok: true, draft: null }
    if (channel === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (channel === 'fs:stat') return { ok: true, isDir: true, size: 0 }
    if (channel === 'fs:readText') return { ext: 'rst', kind: 'text', text: '질문과 함께 확인할 참고 문서입니다.' }
    if (['case:getPairing', 'case:getJsPairing', 'sessions:current'].includes(channel)) return null
    if (channel === 'sessions:remember') return { ok: true }
    if (channel === 'workspace:autoList') return { ok: true, snapshots: [] }
    if (channel === 'workspace:autoLoad') return { ok: true, remote: { ok: true, snapshot: remote && args[0].cwd === remoteCwd ? mobileSnapshot : null } }
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
    if (channel === 'browser:open') {
      const input = args[0], id = input.agentSessionId + ':' + input.location
      if (input.location === failLocation) throw Error('테스트 실행 위치 연결 실패')
      if (!browsers.has(id)) browsers.set(id, { id, agentSessionId: input.agentSessionId, location: input.location, profileLabel: '테스트 서버', url: 'https://example.com', title: '브라우저 테스트', tabs: [{id:'tab1',title:'테스트 페이지',url:'https://example.com'}], activeTabId:'tab1', downloadPath:'/home/test/Downloads', traffic:{receivedBytes:0,sentBytes:0,startedAt:Date.now()}, connected:true })
      return browsers.get(id)
    }
    if (channel === 'browser:frame') {
      frameRequests++
      await pause(80)
      if (frameFailure) throw Error('테스트 연결 끊김')
      const state = browsers.get(args[0]); state.traffic.receivedBytes += 12000; state.traffic.sentBytes += 90
      return { state, width:1280, height:800, etag:'test'+frameRequests, dataUrl:unchangedFrame ? undefined : 'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#ffffff"/><rect x="0" y="0" width="1280" height="64" fill="#e8edf6"/><text x="60" y="43" fill="#243c60" font-size="24">Example Research</text><text x="70" y="170" font-size="42" fill="#142b46">Browse with Claude</text><text x="70" y="230" font-size="24" fill="#536174">This is a remote browser fixture.</text><rect x="70" y="290" width="720" height="50" rx="8" fill="#edf1f7"/><text x="90" y="322" font-size="20" fill="#737d88">Search documents</text></svg>').toString('base64') }
    }
    if (channel === 'browser:state') { if (stateFailure) throw Error('테스트 상태 조회 실패'); return browsers.get(args[0]) }
    if (channel === 'browser:command') { browsers.get(args[0]).traffic.sentBytes += 100; return browsers.get(args[0]) }
    if (channel === 'browser:bounds') return
    if (channel === 'browser:close') { browsers.delete(args[0]); return }
    unexpected.push(channel)
    throw Error(`Unexpected IPC: ${channel}`)
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })))
  let win
  const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => {
    win = window
    win.webContents.setZoomFactor(1)
    win.setContentSize(1440, 940)
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
    win.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  for (const channel of ['open','state','command','frame','bounds','close']) { ipcMain.removeHandler('browser:'+channel); ipcMain.handle('browser:'+channel, () => {}) }
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw Error(`Timed out: ${label}`)
  }
  const capture = async name => fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  ;(async () => {
    try {
      await ready
      releaseSettings()
      await wait(() => evaluate("!!document.querySelector('.agent-panel[data-visible=true] .agent-browser-toggle')"), 'agent available')
      await evaluate("window.bp = () => document.querySelector('.browser-workspace .agent-browser'); window.bb = text => [...bp().querySelectorAll('button')].find(b => b.textContent === text); window.openBrowser = () => document.querySelector('.agent-panel[data-visible=true] .agent-browser-toggle').click(); window.closeBrowserTab = () => bp().closest('.work-pane').querySelector('.tab.active .tab-close').click(); openBrowser()")
      await wait(() => evaluate("!!bp()?.querySelector('img')"), 'remote frame')
      assert.equal(calls.find(c=>c.channel==='browser:open').args[0].location,'remote')
      assert.equal(calls.find(c=>c.channel==='browser:frame').args[1],'saver')
      assert.ok(await evaluate("bp().textContent.includes('이번 연결 전송량 11.8 KB')"))
      assert.ok(await evaluate("getComputedStyle(document.querySelector('.agent-panel[data-visible=true] .agent-head-actions')).display!=='none'"))
      assert.ok(await evaluate("!!document.querySelector('.agent-panel[data-visible=true] .agent-composer textarea').offsetParent"))
      await pause(1100)
      assert.equal(frameRequests,1,'saver does not request every second')
      await evaluate("bb('자동 수신 중지').click()")
      await pause(100)
      const pausedAt=frameRequests, pausedCalls=calls.length
      await pause(2200)
      assert.equal(frameRequests,pausedAt,'pause stops frame requests')
      assert.equal(calls.slice(pausedCalls).filter(c=>c.channel==='browser:state').length,0,'pause does not poll state')
      await evaluate("bb('화면 받기').click()")
      await wait(()=>frameRequests===pausedAt+1,'manual frame while paused')
      await pause(100)
      const previousImage=await evaluate("bp().querySelector('img').src")
      unchangedFrame=true
      const beforeManual=frameRequests
      await evaluate("bb('화면 받기').click();bb('화면 받기').click()")
      await pause(180)
      assert.equal(frameRequests,beforeManual+1,'manual requests cannot overlap')
      assert.equal(await evaluate("bp().querySelector('img').src"),previousImage,'unchanged frame keeps previous image')
      unchangedFrame=false
      await evaluate(`(() => { const el=bp().querySelector('textarea'); el.focus(); el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); el.value='ㅎ'; el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ㅎ'})); el.value='한글'; el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'한글'})); el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한글'})); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`)
      await wait(()=>calls.some(c=>c.channel==='browser:command'&&c.args[1].text==='한글'),'IME complete text')
      assert.deepEqual(calls.filter(c=>c.channel==='browser:command'&&c.args[1].action==='type').map(c=>c.args[1].text),['한글'])
      await evaluate(`(() => { const el=bp().querySelector('textarea'); const data=new DataTransfer(); data.setData('text/plain','붙여넣기'); el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})); el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Backspace',code:'Backspace'})); el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'a',code:'KeyA',metaKey:true})); const img=bp().querySelector('img'),rect=img.getBoundingClientRect(); img.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2})); })()`)
      await wait(()=>calls.some(c=>c.channel==='browser:command'&&c.args[1].action==='click'),'image click mapped')
      assert.ok(calls.some(c=>c.channel==='browser:command'&&c.args[1].text==='붙여넣기'))
      assert.ok(calls.some(c=>c.channel==='browser:command'&&c.args[1].key==='Backspace'))
      assert.ok(calls.some(c=>c.channel==='browser:command'&&c.args[1].key==='a'&&c.args[1].modifiers===4))
      const mapped=calls.find(c=>c.channel==='browser:command'&&c.args[1].action==='click').args[1]; assert.ok(Math.abs(mapped.x-640)<=1 && Math.abs(mapped.y-400)<=1); assert.equal(mapped.button,'left'); assert.equal(mapped.clickCount,1)
      await capture('browser-workspace-remote')
      const workspaceLayout=await evaluate(`(() => { const browser=bp().closest('.work-pane'), agent=document.querySelector('.agent-panel[data-visible=true]'), composer=agent.querySelector('.agent-composer'); return {browserSide:browser.dataset.workSide,agentSide:agent.closest('.work-pane').dataset.workSide,nested:!!bp().closest('.agent-panel'),hasTab:!!browser.querySelector('.tab.active .tab-close'),composerVisible:!!composer.offsetParent} })()`)
      assert.equal(workspaceLayout.nested,false,'browser is not nested in agent')
      assert.equal(workspaceLayout.hasTab,true,'browser has ordinary workspace tab')
      assert.notEqual(workspaceLayout.browserSide,workspaceLayout.agentSide,'browser opens opposite the agent')
      assert.equal(workspaceLayout.composerVisible,true,'composer stays available in other pane')
      win.setContentSize(980,760)
      await pause(150)
      assert.ok(await evaluate("bp().querySelector('.agent-browser-viewport').getBoundingClientRect().height>120"),'narrow view has usable image area')
      assert.equal(await evaluate("bp().scrollWidth>bp().clientWidth"),false,'narrow controls do not overflow')
      await capture('browser-workspace-narrow')
      win.setContentSize(1440,940)
      await pause(100)
      const frameBefore=frameRequests
      await pause(2200)
      assert.equal(frameRequests,frameBefore,'no traffic from local rate display timer')
      assert.ok(await evaluate("bp().textContent.includes('현재 0 B/초')"),'idle transfer rate returns to zero')
      await evaluate(`(() => { const input=bp().querySelector('[aria-label="웹 주소"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'example.org'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await evaluate("bp().querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
      await wait(()=>calls.some(c=>c.channel==='browser:command'&&c.args[1].url==='https://example.org'),'bare domain uses HTTPS')
      frameFailure=true
      await evaluate("bb('자동 수신 재개').click()")
      await wait(()=>evaluate("!!bp().querySelector('[role=alert]')"),'frame error shown')
      const failedAt=frameRequests
      await pause(2200)
      assert.equal(frameRequests,failedAt,'error stops polling')
      assert.equal(await evaluate("bp().querySelector('[aria-label=\"브라우저 실행 위치\"]').value"),'remote','no fallback on error')
      frameFailure=false
      await evaluate("bb('다시 연결').click()")
      await wait(()=>evaluate("!!bp().querySelector('img')&&!bp().querySelector('[role=alert]')"),'reconnect remote')
      await evaluate("bb('자동 수신 중지').click()")
      const layout=await evaluate(`(() => { const browser=bp().getBoundingClientRect(),view=bp().querySelector('.agent-browser-viewport').getBoundingClientRect(),composer=document.querySelector('.agent-panel[data-visible=true] .agent-composer').getBoundingClientRect(); return {viewHeight:view.height,left:browser.left,right:browser.right,composerLeft:composer.left,composerRight:composer.right,overflow:bp().scrollWidth>bp().clientWidth} })()`)
      assert.ok(layout.viewHeight>150,JSON.stringify(layout)); assert.ok(layout.right<=layout.composerLeft || layout.left>=layout.composerRight,JSON.stringify(layout)); assert.equal(layout.overflow,false)
      const browserTitle=await evaluate("bp().closest('.work-pane').querySelector('.tab.active .tab-title').textContent")
      const remoteSessionId=calls.find(c=>c.channel==='browser:open').args[0].agentSessionId+':remote'
      await evaluate("bb('자동 수신 재개').click()")
      win.webContents.send('tabs:receive',{kind:'doc',tab:{id:'browser-note',title:'참고 메모',kind:'file',path:'ssh://phone-host/home/lawyer/legal-terminal-general/browser-note.txt',side:workspaceLayout.browserSide}})
      await wait(()=>evaluate("!!bp() && !bp().checkVisibility({checkVisibilityCSS:true})"),'browser remains mounted behind another workspace tab')
      await pause(150)
      const inactiveAt=frameRequests
      await pause(2200)
      assert.equal(frameRequests,inactiveAt,'inactive workspace tab stops remote frames')
      await evaluate(`([...document.querySelectorAll('.work-${workspaceLayout.browserSide} .tab-title')].find(el=>el.textContent===${JSON.stringify(browserTitle)})).click()`)
      await wait(()=>evaluate("bp()?.checkVisibility({checkVisibilityCSS:true}) && !!bp().querySelector('img')"),'workspace tab restores browser')
      assert.ok(browsers.has(remoteSessionId),'tab switch retains browser session')
      await evaluate("bb('자동 수신 중지').click()")
      await evaluate(`(() => { const select=bp().querySelector('[aria-label="화면 전송 품질"]'); select.value='standard'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await pause(100)
      const movePausedAt=frameRequests
      await evaluate("bp().closest('.work-pane').querySelector('[title=\"문서를 오른쪽으로 이동\"]').click()")
      await wait(()=>evaluate("bp()?.closest('.work-pane').dataset.workSide==='right' && !bb('브라우저 종료').disabled"),'browser moves to right workspace pane')
      assert.equal(await evaluate("!!bb('자동 수신 재개')"),true,'moving preserves paused state')
      assert.equal(await evaluate("bp().querySelector('[aria-label=\"화면 전송 품질\"]').value"),'standard','moving preserves quality')
      await pause(2200)
      assert.equal(frameRequests,movePausedAt,'moving paused tab sends no frames')
      await evaluate("bp().closest('.work-pane').querySelector('[title=\"문서를 왼쪽으로 이동\"]').click()")
      await wait(()=>evaluate("bp()?.closest('.work-pane').dataset.workSide==='left' && !bb('브라우저 종료').disabled"),'browser moves back to left workspace pane')
      assert.equal(await evaluate("!!bb('자동 수신 재개')"),true,'pause persists on return')
      await evaluate("closeBrowserTab()")
      await wait(()=>evaluate("!bp()"),'workspace X closes browser UI')
      assert.equal(calls.filter(c=>c.channel==='browser:close').length,0,'closing workspace tab retains session')
      const hiddenAt=frameRequests
      await pause(2200)
      assert.equal(frameRequests,hiddenAt)
      await evaluate("openBrowser()")
      await wait(()=>evaluate("!!bp() && !bb('브라우저 종료').disabled"),'reopen activates same session')
      assert.ok(browsers.has(remoteSessionId),'reopening retains remote session state')
      failLocation='local'
      await evaluate(`(() => { const el=bp().querySelector('[aria-label="브라우저 실행 위치"]'); el.value='local'; el.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await wait(()=>evaluate("!!bp().querySelector('[role=alert]')"),'failed location switch')
      assert.ok([...browsers.values()].some(state=>state.location==='remote'),'previous session retained')
      failLocation=''
      await evaluate("bb('다시 연결').click()")
      await wait(()=>calls.some(c=>c.channel==='browser:bounds'&&c.args[1]?.width>0),'native view bounds')
      const boundsBeforeModal=calls.filter(c=>c.channel==='browser:bounds').length
      await evaluate(`window.browserFixtureModal=document.createElement('div'); browserFixtureModal.className='modal-overlay'; browserFixtureModal.textContent='테스트 창'; browserFixtureModal.style.cssText='position:fixed;inset:0'; document.body.appendChild(browserFixtureModal)`)
      await wait(()=>calls.filter(c=>c.channel==='browser:bounds').length>boundsBeforeModal&&calls.filter(c=>c.channel==='browser:bounds').at(-1).args[1]===null,'native browser hidden for modal')
      await evaluate("browserFixtureModal.remove()")
      await wait(()=>calls.filter(c=>c.channel==='browser:bounds').at(-1).args[1]?.width>0,'native browser restored after modal')
      assert.ok(await evaluate("bp().textContent.includes('내 PC의 인터넷 연결')"))
      assert.equal(await evaluate("bp().textContent.includes('이번 연결 전송량')"),false)
      await evaluate("closeBrowserTab()")
      await wait(()=>calls.some(c=>c.channel==='browser:bounds'&&c.args[1]===null),'native view hidden')
      assert.equal(calls.filter(c=>c.channel==='browser:close').length,0)
      await evaluate("openBrowser()")
      await wait(()=>evaluate("!!bp() && !bb('브라우저 종료').disabled"),'reopen retained local browser')
      stateFailure=true
      await wait(()=>evaluate("!!bp()?.querySelector('[role=alert]')"),'local state error')
      stateFailure=false
      failLocation='local'
      await evaluate("bb('다시 연결').click()")
      await wait(()=>evaluate("!!bp()?.querySelector('[role=alert]') && !bb('다시 연결').disabled"),'local reconnect fails')
      assert.equal(await evaluate("bb('브라우저 종료').disabled"),false,'failed reconnect retains explicit close')
      failLocation=''
      await evaluate("bb('다시 연결').click()")
      await wait(()=>evaluate("!!bp() && !bp().querySelector('[role=alert]') && !bb('브라우저 종료').disabled"),'reopen local')
      await evaluate("bb('브라우저 종료').click()")
      await wait(()=>calls.some(c=>c.channel==='browser:close'),'explicit terminate')
      await wait(()=>evaluate("!bp()"),'panel closes after termination response')
      assert.deepEqual(unexpected,[]); assert.deepEqual(errors,[])
      console.log('PASS: remote default, visible chat composer, 2 s saver, pause/manual/no state poll, IME/paste/modifier/click mapping, hide vs terminate, native bounds, truthful traffic labels, idle rate decay, bare domain HTTPS, opposite workspace tab/narrow layout, unchanged frames, no overlaps, error/reconnect/location recovery, modal bounds, close after failed reconnect, inactive workspace tab pauses transfer, workspace X preserves session, moving left/right preserves pause and quality. Screenshots: '+screenshotDir)
      app.exit(0)
    } catch (error) { await capture('failure').catch(()=>{}); console.error(error); console.error(JSON.stringify({errors,unexpected,dom:await evaluate('document.body.innerText').catch(()=>''),screenshotDir})); app.exit(1) }
  })()
}

const entry = path.join(temp, 'main.cjs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  await fs.writeFile(entry, `(${runApp.toString()})(${JSON.stringify({ root, temp, screenshotDir, remote: true, provider: 'claude', mode: '' })})`)
  const code = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [entry], { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0, 'browser UI verification')
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
