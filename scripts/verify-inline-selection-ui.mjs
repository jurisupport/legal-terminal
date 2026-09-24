// Run after npm run build. Real renderer/preload; synthetic PDF and stubbed IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-selection-ui-'))
const output = path.join(root, 'output/playwright/inline-selection')
await fs.mkdir(output, { recursive: true })
await fs.rm(path.join(output, 'failure.png'), { force: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', ...[4, 6].flatMap((content, i) => {
  const text = `BT /F1 18 Tf 60 720 Td (Synthetic selected contract page ${i + 1}.) Tj ET\n`
  return [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents ${content} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}endstream`]
}), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
let pdf = '%PDF-1.4\n'
const offsets = [0]
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` }
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

async function electronCheck({ root, temp, output, channels, pdf }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const fixtureChecks = []
  const calls = [], created = new Map(), blockedRequests = []
  const profile = { id: 'fixture-ssh', label: '합성 원격', host: 'example.invalid', user: 'test' }
  const settings = { draftsRoot: '/synthetic', agentDefaultProvider: 'codex', sshProfiles: [profile], notificationSound: 'none', notifyDone: false }
  let failure = false, sendRelease, holdSend = false, createRelease, holdCreate = false
  for (const channel of channels) ipcMain.handle(channel, async (ipc, ...args) => {
    calls.push({ channel, args })
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'UI fixture', homeDirectory: '/synthetic' }
    if (channel === 'dialog:message') return args[0] === 'confirm'
    if (channel === 'fs:readText') {
      const text = '첫 번째 선택 문장입니다.\n두 번째 선택 문장입니다.\n\n' + '스크롤을 확인할 합성 문단입니다.\n\n'.repeat(70)
      return { kind: 'text', ext: '.md', text, size: Buffer.byteLength(text), mtimeMs: 1 }
    }
    if (channel === 'fs:loadDocumentDraft') return { ok: true }
    if (channel === 'fs:readBytes') return Uint8Array.from(Buffer.from(pdf, 'base64')).buffer
    if (channel === 'fs:stat') return { ok: true, isDir: !/\.[a-z]+$/.test(args[0]), size: 100, mtimeMs: 1 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:create') {
      created.set(args[0].id, args[0])
      if (holdCreate) await new Promise(resolve => { createRelease = resolve })
      ipc.sender.send('agent:event', { type: 'auth:status', sessionId: args[0].id, state: 'authenticated' })
      return { ok: true }
    }
    if (channel === 'agent:send') {
      if (holdSend) await new Promise(resolve => { sendRelease = resolve })
      if (failure) return { ok: false, error: '합성 전송 실패' }
      const { sessionId, input } = args[0]
      ipc.sender.send('agent:event', input.delivery === 'queue' ? { type: 'queue:added', sessionId, queueId: `queue-${calls.length}`, text: input.text, attachments: input.attachments } : { type: 'message:user', sessionId, messageId: `user-${calls.length}`, text: input.text, attachments: input.attachments })
      return { ok: true }
    }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const blocked = !/^(file|data|blob):/.test(request.url)
    if (blocked) blockedRequests.push(request.url)
    callback({ cancel: blocked })
  })
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const consoleErrors = []
  w.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message) })
  const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async (condition, label) => {
    for (let i = 0; i < 160; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-3000)')}`)
  }
  const screenshot = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await pause(100)
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage()).toPNG())
  }
  const event = async (id, data) => { w.webContents.send('agent:event', { sessionId: id, ...data }); await pause() }
  const sends = () => calls.filter(call => call.channel === 'agent:send').map(call => call.args[0])
  const add = async (id, title, cwd, side = 'right', remote = false) => {
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id, kind: 'agent', agentProvider: id === 'a2' ? 'codex' : 'claude', title, cwd, side, caseName: cwd === '/synthetic/a' ? '인용 사건' : '다른 사건', createdAt: Date.now(), ...(remote ? { ssh: { host: profile.host, user: profile.user }, profileId: profile.id, sshLabel: profile.label } : {}) } })
    for (let i = 0; i < 160 && !created.has(id); i++) await pause()
    if (!created.has(id)) throw Error('Agent failed to mount: ' + id)
    await pause()
  }
  const openPdf = async (id = 'fixture-pdf', source = '/synthetic/a/계약서.pdf') => {
    w.webContents.send('tabs:receive', { kind: 'document', tab: { id, kind: 'pdf', path: source, title: '계약서.pdf', side: 'left' } })
    await wait("visible('.textLayer span').length > 0", 'PDF loaded')
    await run(`const page = visible('.pdf-page-input')[0]; if (page.value !== '2') click(visible('.pdf-toolbar [title="다음 페이지"]')[0])`)
    await wait("visible('.textLayer[data-pdf-page=\"2\"] span').length > 0", 'PDF page two')
  }
  const selectText = async () => {
    await pause(200)
    await run(`
      document.activeElement?.blur(); visible('.pdf-canvas-wrap')[0].focus();
      const span = visible('.textLayer span')[0], range = document.createRange(); range.selectNodeContents(span);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    `)
    await wait("visible('.sel-actions button').some(button => button.textContent.includes('이 부분에 지시'))", 'Selection action')
  }
  const open = async (keyboard = false) => {
    await selectText()
    await run(keyboard ? `document.dispatchEvent(new KeyboardEvent('keydown', {key:'j',${keyboard === 'meta' ? 'metaKey' : 'ctrlKey'}:true,bubbles:true,cancelable:true}))` : `click(visible('.sel-actions button').find(button => button.textContent.includes('이 부분에 지시')))`)
    await wait("!!popup()", 'Inline popup')
    await pause()
  }
  const fill = text => run(`setValue(popup().querySelector('textarea'), ${JSON.stringify(text)})`)
  const enter = () => run(`popup().querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}))`)
  const close = () => run(`click(popup().querySelector('[aria-label="지시창 닫기"]'))`)
  const choose = id => run(`setValue(popup().querySelector('select'), ${JSON.stringify(id)})`)
  const tab = (name, close = false) => run(`const tab = visible('.work-pane[data-work-side="right"] .tab').find(el => el.querySelector('.tab-title')?.textContent.includes(${JSON.stringify(name)})); click(${close ? "tab?.querySelector('.tab-close')" : 'tab'})`)
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-tabs-trigger')", 'App ready')
    await run(`
      window.checks = [];
      window.check = (value, message) => { if (!value) throw Error(message); checks.push(message) };
      window.visible = selector => [...document.querySelectorAll(selector)].filter(el => el.checkVisibility({checkVisibilityCSS:true}));
      window.popup = () => document.querySelector('.inline-selection-command');
      window.click = el => { if (!el || el.disabled) throw Error('Missing/disabled control'); el.click() };
      window.setValue = (el,value) => { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input',{bubbles:true})) };
      window.draft = id => document.querySelector('[data-term-id="'+id+'"] .agent-composer textarea');
    `)
    await add('other', '타 사건 Agent', '/synthetic/b')
    await add('a-left', '같은 쪽 Agent', '/synthetic/a', 'left')
    await add('a2', '검토 Agent 둘', '/synthetic/a')
    await add('a1', '검토 Agent 하나', '/synthetic/a')
    await openPdf()
    await run(`click(visible('.pdf-toolbar [title="100%로"]')[0])`)
    await pause(200)
    await run(`
      setValue(draft('a1'), '오른쪽에 작성 중인 초안');
      setValue(draft('a2'), '둘의 작성 중 초안');
      const transfer = new DataTransfer(); transfer.setData('application/x-lt-path', '/synthetic/a/보존할첨부.md');
      document.querySelector('[data-term-id="a1"] .agent-panel').dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true}));
    `)
    await wait("document.querySelector('[data-term-id=\"a1\"] .agent-attachments.pending')?.textContent.includes('보존할첨부.md')", 'Normal draft attachment')
    await open()
    await run(`
      check(popup().getAttribute('role') === 'dialog', 'Selection opens accessible inline command');
      check(popup().textContent.includes('계약서.pdf · PDF 2쪽') && popup().querySelector('.inline-selection-source').title.includes('인용 사건') && popup().querySelector('select').title.includes('인용 사건'), 'Popup identifies captured document page and case');
      const values = [...popup().querySelector('select').options].map(option=>option.value);
      check(values.includes('a1') && values.includes('a2') && !values.includes('other') && !values.includes('a-left'), 'Only same-case opposite-pane agent sessions are selectable');
      check(popup().querySelector('select').value === 'a1', 'Opening captures active eligible target');
      check(!popup().querySelector('.inline-selection-complete'), 'Empty instruction has no unsolicited completion');
    `)
    await run(`
      const source = CSS.highlights.get('inline-command-source');
      check(source?.size === 1 && [...source][0].toString().includes('page 2'), 'PDF source stays highlighted while the inline input has focus');
      window.pdfSelectedText=[...source][0].toString();
      check(document.activeElement === popup().querySelector('textarea'), 'Opening focuses the compact inline input');
      const textarea = popup().querySelector('textarea');
      check(textarea.rows === 2 && parseFloat(getComputedStyle(textarea).borderTopWidth) === 0, 'Compact instruction uses two rows without an input border');
      check(!!popup().querySelector('.inline-selection-head select'), 'Target session select sits in the compact header');
      const pane = document.querySelector('.work-pane[data-work-side="left"]').getBoundingClientRect();
      const bounds = popup().getBoundingClientRect(), selected = [...source][0].getBoundingClientRect();
      check(bounds.left >= pane.left && bounds.right <= pane.right, 'Desktop popup stays within original document pane');
      check(bounds.top >= selected.bottom && bounds.top - selected.bottom < 24, 'Popup attaches just below the selected source');
      window.beforeScroll = {popupTop:bounds.top, anchorBottom:selected.bottom};
      const wrap=visible('.pdf-canvas-wrap')[0];
      check(wrap.scrollHeight > wrap.clientHeight + 24, 'PDF fixture provides a real scrollable viewport');
      wrap.scrollTop += 24;
    `)
    await pause(200)
    await run(`
      const selected=[...CSS.highlights.get('inline-command-source')][0].getBoundingClientRect();
      const top=popup().getBoundingClientRect().top;
      check(Math.abs((top-beforeScroll.popupTop)-(selected.bottom-beforeScroll.anchorBottom)) < 3 && top < beforeScroll.popupTop-10, 'Inline popup follows the original PDF selection while scrolling');
      visible('.pdf-canvas-wrap')[0].scrollTop=0;
    `)
    for (const [prefix, complete] of [['반박','반박 논점과 필요한 증거를 정리해줘'], ['요약','요약해서 쟁점과 사실을 나눠줘'], ['인용','인용할 수 있게 서면 문장으로 다듬어줘']]) {
      await fill(prefix)
      await wait("!!popup().querySelector('.inline-selection-complete')", 'Default completion '+prefix)
      await run(`
        check(popup().querySelector('.inline-selection-ghost').textContent === ${JSON.stringify(complete)}, 'Empty session offers default '+${JSON.stringify(prefix)}+' completion');
        popup().querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
      `)
      await pause()
      await run(`check(popup().querySelector('textarea').value === ${JSON.stringify(complete)}, 'Tab accepts default '+${JSON.stringify(prefix)}+' instruction')`)
    }
    await fill('')
    await pause()
    await run(`check(!popup().querySelector('.inline-selection-complete'), 'Clearing input removes default completion')`)
    await fill('반박')
    await screenshot('inline-command-default-completion')
    await fill('반박 근거를 확인해줘.')
    await run(`check(CSS.highlights.get('inline-command-source')?.size === 1, 'Typing keeps captured source highlighting')`)
    await screenshot('inline-command-desktop')
    w.setSize(800, 800); await pause(200)
    await wait("CSS.highlights.get('inline-command-source')?.size===1 && ![...CSS.highlights.get('inline-command-source')][0].collapsed && [...CSS.highlights.get('inline-command-source')][0].toString()===window.pdfSelectedText",'PDF highlight reconnects after resize')
    await run(`
      check([...CSS.highlights.get('inline-command-source')][0].toString()===window.pdfSelectedText && ![...CSS.highlights.get('inline-command-source')][0].collapsed,'Resizing PDF preserves exact selected-text highlight');
      const rect = popup().getBoundingClientRect();
      check(rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, 'Narrow popup stays inside viewport');
      check(popup().scrollWidth <= popup().clientWidth + 1, 'Narrow popup has no horizontal overflow');
      const pane=document.querySelector('.work-pane[data-work-side="left"]').getBoundingClientRect();
      check(rect.left >= pane.left && rect.right <= pane.right, 'Narrow popup remains inside original source pane');
    `)
    await screenshot('inline-command-narrow')
    w.setSize(1440, 1000); await pause(150)
    await tab('검토 Agent 둘')
    await run(`
      check(popup().querySelector('select').value === 'a1', 'Switching active agent does not redirect captured target');
      click(visible('.pdf-toolbar [title="이전 페이지"]')[0]);
    `)
    await wait("visible('.pdf-page-input')[0].value === '1' && visible('.textLayer[data-pdf-page=\"1\"] span').length>0", 'Navigate source after capture')
    await run(`
      const range=[...(CSS.highlights.get('inline-command-source')??[])][0];
      check(!range || range.collapsed || !visible('.textLayer')[0].contains(range.startContainer),'Navigating away does not attach page-two highlight to page one');
    `)
    holdSend = true
    await run(`const el=popup().querySelector('textarea'); for(let i=0;i<3;i++) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    for(let i=0;i<120&&!sendRelease;i++) await pause()
    assertFixture(sends().length === 1 && !!sendRelease, 'Rapid Enter sends exactly one inline request')
    const first = sends()[0]
    assertFixture(first.sessionId === 'a1' && first.input.text === '반박 근거를 확인해줘.', 'Captured session receives exact inline instruction')
    assertFixture(first.input.attachments.length === 1 && first.input.attachments[0].source.range.startPage === 2 && first.input.attachments[0].source.text.includes('page 2') && first.input.attachments[0].source.path === '/synthetic/a/계약서.pdf', 'Captured PDF source survives page/target navigation')
    holdSend = false; sendRelease(); await wait('!popup()', 'Successful send closes popup')
    await run(`
      check(!CSS.highlights.has('inline-command-source'), 'Successful send clears source highlight');
      check(visible('.pdf-page-input')[0].value === '1', 'Send does not change current source viewer page');
      check(draft('a1').value === '오른쪽에 작성 중인 초안', 'Inline send preserves normal composer text');
      check(document.querySelector('[data-term-id="a1"] .agent-attachments.pending').textContent.includes('보존할첨부.md'), 'Inline send preserves normal pending attachments');
    `)
    await open(true)
    await fill('반박')
    await wait("!!popup().querySelector('.inline-selection-complete')", 'Actual session-history completion')
    await run(`
      check(popup().querySelector('.inline-selection-ghost').textContent === '반박 근거를 확인해줘.', 'Selected session history takes priority over matching default instruction');
      const el=popup().querySelector('textarea');
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    `)
    await pause()
    const beforeIme=sends().length
    await run(`const el=popup().querySelector('textarea'); for(const key of ['Tab','Enter']) el.dispatchEvent(new KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true})); check(el.value === '반박','IME Tab does not accept completion'); el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`)
    await pause()
    assertFixture(sends().length===beforeIme, 'IME Enter does not send')
    await choose('a2'); await pause()
    await run(`check(popup().querySelector('.inline-selection-ghost').textContent === '반박 논점과 필요한 증거를 정리해줘', 'Another session uses its default instead of first session history')`)
    await choose('a1'); await pause()
    await run(`const el=popup().querySelector('textarea'); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));`)
    await pause()
    await run(`check(popup().querySelector('textarea').value === '반박 근거를 확인해줘.', 'Tab accepts selected session history')`)
    await fill('줄바꿈'); await run(`popup().querySelector('textarea').focus(); popup().querySelector('textarea').setSelectionRange(3,3)`)
    await run(`const event=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}); popup().querySelector('textarea').dispatchEvent(event);check(!event.defaultPrevented,'ShiftEnter leaves native newline insertion enabled')`)
    await w.webContents.insertText('\n')
    await wait("popup().querySelector('textarea').value.includes('\\n')", 'ShiftEnter newline')
    assertFixture(sends().length===beforeIme, 'ShiftEnter inserts newline without sending')
    failure=true; await fill('실패하면 보존할 입력'); await enter()
    await wait("popup()?.querySelector('[role=alert]')?.textContent.includes('합성 전송 실패')", 'Server failure visible')
    await run(`check(popup().querySelector('textarea').value==='실패하면 보존할 입력','Server failure preserves instruction and popup'); check(document.activeElement===popup().querySelector('textarea'),'Failed send returns focus to inline input')`)
    await screenshot('inline-command-error')
    failure=false; await event('a1',{type:'status',status:'working'})
    await run(`const right=draft('a1');right.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));right.focus();right.setSelectionRange(right.value.length,right.value.length)`)
    await w.webContents.insertText(' · 직접 추가한 지시')
    await pause(100)
    await run(`check(document.activeElement===draft('a1') && draft('a1').value.endsWith(' · 직접 추가한 지시'),'Working Agent accepts explicit normal-composer focus and native input while inline popup is open')`)
    await fill('작업 중 추가 확인'); await enter(); await wait('!popup()','Queued send closes popup')
    await run(`check(draft('a1').value.endsWith(' · 직접 추가한 지시'),'Queued inline send preserves manually edited working composer')`)
    assertFixture(sends().at(-1).input.delivery==='queue', 'Working agent receives queued inline delivery')
    await event('a1',{type:'status',status:'idle'})
    await open('meta'); await choose('a2'); await event('a2',{type:'auth:status',state:'unauthenticated'}); await fill('인증 확인'); const beforeAuth=sends().length; await enter()
    await wait("popup()?.querySelector('[role=alert]')?.textContent.includes('로그인')", 'Auth error')
    assertFixture(sends().length===beforeAuth,'Unauthenticated agent cannot receive inline request')
    await event('a2',{type:'auth:status',state:'authenticated'}); await fill('선택한 둘에 지시'); await enter(); await wait('!popup()','Selected alternate target send'); assertFixture(sends().at(-1).sessionId==='a2','Explicit selector sends to the chosen same-case Agent')
    await open(); await fill('사건 변경 중 보존할 입력')
    await add('other2','타 사건 Agent 둘','/synthetic/b')
    const beforeCase=sends().length; await enter()
    await wait("popup()?.querySelector('[role=alert]')?.textContent.includes('사건으로 돌아와')", 'Wrong active case error')
    assertFixture(sends().length===beforeCase,'Changing active case prevents sending')
    await run(`check(popup().querySelector('textarea').value==='사건 변경 중 보존할 입력','Wrong-case error retains inline text'); click(document.querySelector('.case-tabs-trigger'))`)
    await run(`click([...document.querySelectorAll('.case-tab-row')].find(el=>el.textContent.includes('인용 사건')))`)
    await close(); await tab('검토 Agent 하나'); await open()
    await fill('닫힌 대상 입력'); await tab('검토 Agent 하나',true)
    await wait("popup()?.querySelector('select').selectedOptions[0].textContent.includes('닫혔습니다')", 'Closed target visible')
    await run(`check(popup().querySelector('textarea').value==='닫힌 대상 입력' && popup().querySelector('.inline-selection-actions > button:last-child').disabled,'Closed target keeps text and does not silently fallback')`)
    holdCreate=true
    await choose('__new__'); await wait("popup().querySelector('select').value!=='a1' && popup().querySelector('select').value!=='__new__'", 'New session selected')
    const newId=await run("return popup().querySelector('select').value")
    await pause(200)
    await run(`check(document.activeElement===popup().querySelector('textarea'),'Choosing a new session keeps typing in the inline popup'); check(draft('a2').value==='둘의 작성 중 초안','Creating another session preserves existing normal composer draft')`)
    for(let i=0;i<120&&!createRelease;i++) await pause()
    assertFixture(created.get(newId)?.provider==='codex' && created.get(newId)?.cwd==='/synthetic/a','New local session uses existing default provider and captured case')
    const beforeCreate=sends().length; await enter(); await pause(150)
    assertFixture(sends().length===beforeCreate,'Inline submission waits for actual agent creation')
    holdCreate=false; createRelease(); await wait('!popup() || !!popup().querySelector("[role=alert]")','Creation settles safely')
    if (await run('return !!popup()')) {
      await run(`check(popup().querySelector('[role=alert]').textContent.includes('상태 확인 중') && popup().querySelector('textarea').value==='닫힌 대상 입력','Authentication readiness race keeps instruction for retry')`)
      await pause(100); await enter()
    }
    await wait('!popup()','Prepared new session send succeeds')
    assertFixture(sends().at(-1).sessionId===newId,'Prepared new session receives preserved inline input')
    // Remove the remaining eligible targets: opening another selection creates one automatically.
    await tab('검토 Agent 둘',true)
    await run(`const active=visible('.work-pane[data-work-side="right"] .tab.active')[0]; click(active.querySelector('.tab-close'))`)
    const beforeAuto=created.size; await open()
    await wait("popup().querySelector('select').value!==''",'Auto-created target')
    const autoId=await run("return popup().querySelector('select').value")
    assertFixture(created.size===beforeAuto+1 && created.get(autoId)?.provider==='codex','No eligible session automatically creates default local Agent')
    await pause(200); await run(`check(document.activeElement===popup().querySelector('textarea'),'Automatically created agent leaves focus on inline input')`)
    await close()
    await add('remote-old','원격 기존 Agent','/cases/remote','right',true)
    await openPdf('remote-pdf','ssh://fixture-ssh/cases/remote/계약서.pdf')
    await tab('원격 기존 Agent',true)
    const beforeRemote=created.size; await open(); const remoteId=await run("return popup().querySelector('select').value")
    for(let i=0;i<120&&!created.has(remoteId);i++) await pause()
    assertFixture(created.size===beforeRemote+1 && created.get(remoteId)?.provider==='codex' && created.get(remoteId)?.source==='ssh' && created.get(remoteId)?.cwd==='/cases/remote' && created.get(remoteId)?.ssh.host===profile.host,'No eligible remote session retains its SSH profile and case directory')
    await fill('원격 선택 부분 확인'); await enter(); await wait('!popup()','Remote inline send')
    assertFixture(sends().at(-1).sessionId===remoteId && sends().at(-1).input.attachments[0].source.path.startsWith('ssh://fixture-ssh/'),'Remote inline request preserves original source URI')
    await screenshot('inline-command-remote')
    const markdownPath='ssh://fixture-ssh/cases/remote/검토.md'
    w.webContents.send('tabs:receive',{kind:'document',tab:{id:'fixture-markdown',kind:'mdview',path:markdownPath,title:'검토.md',side:'left'}})
    await wait("visible('.cm-line').some(el=>el.textContent.includes('두 번째 선택'))",'Markdown renderer loaded')
    await run(`visible('.cm-content')[0].focus()`)
    await pause(150)
    await run(`
      const content=visible('.cm-content')[0];
      content.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',code:'Home',ctrlKey:true,bubbles:true,cancelable:true}));
      for(let i=0;i<2;i++)content.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',shiftKey:true,bubbles:true,cancelable:true}));
    `)
    await wait("visible('.sel-actions button').some(el=>el.textContent.includes('이 부분에 지시'))",'Markdown selection action')
    await run(`click(visible('.sel-actions button').find(el=>el.textContent.includes('이 부분에 지시')))`)
    await wait('!!popup()','Markdown inline command')
    await pause(150)
    await run(`
      const highlight=CSS.highlights.get('inline-command-source');
      check(highlight?.size===1 && [...highlight][0].toString().includes('첫 번째 선택') && [...highlight][0].toString().includes('두 번째 선택'), 'Real multi-line Markdown selection remains highlighted with input focus');
      check(popup().textContent.includes('검토.md'), 'Markdown popup shows correct original document');
      const bounds=popup().getBoundingClientRect(),source=[...highlight][0].getBoundingClientRect();
      check(bounds.top>=source.bottom && bounds.top-source.bottom<24,'Markdown popup starts below final selected line');
      window.markdownBefore={top:bounds.top,bottom:source.bottom};
      const scroller=visible('.cm-scroller')[0];check(scroller.scrollHeight>scroller.clientHeight+20,'Markdown fixture is scrollable');scroller.scrollTop=20;
    `)
    await pause(200)
    await run(`
      const source=[...CSS.highlights.get('inline-command-source')][0].getBoundingClientRect();
      const top=popup().getBoundingClientRect().top;
      check(top<markdownBefore.top-10 && Math.abs((top-markdownBefore.top)-(source.bottom-markdownBefore.bottom))<3,'Markdown popup follows source while scrolling');
    `)
    await fill('요약')
    await screenshot('inline-command-markdown')
    await close();await wait('!popup()','Explicitly close Markdown command')
    await run(`check(!CSS.highlights.has('inline-command-source'),'Closing inline command removes saved source highlight')`)
    if(consoleErrors.length) throw Error('Renderer console errors: '+consoleErrors.join('\n'))
    const result={checks:[...await run('return checks'),...fixtureChecks],consoleErrors,sends:sends().map(item=>({sessionId:item.sessionId,text:item.input.text,delivery:item.input.delivery})),blockedRequests,screenshots:fs.readdirSync(output).filter(name=>name.startsWith('inline-command-')&&name.endsWith('.png')).map(name=>path.join(output,name))}
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)); console.log('INLINE_SELECTION_UI_RESULT '+JSON.stringify(result)); app.exit(0)
  } catch(error) {
    await screenshot('failure').catch(()=>{}); console.error(error); console.error(JSON.stringify({consoleErrors,selection:await run('return {text:String(getSelection()),active:document.activeElement?.outerHTML.slice(0,200),actions:document.querySelector(".sel-actions")?.outerHTML}'),sends:sends(),created:[...created.keys()]})); app.exit(1)
  }
  function assertFixture(value,message) { if(!value)throw Error(message);fixtureChecks.push(message) }
}
// Main-process assertions share the renderer report without exposing test APIs in preload.
const mainSource=electronCheck.toString()
await fs.writeFile(path.join(temp,'main.cjs'),`(${mainSource})(${JSON.stringify({root,temp,output,channels,pdf:Buffer.from(pdf).toString('base64')})}).catch(error=>{console.error(error);require('electron').app.exit(1)})`)
const electron=process.platform==='darwin'?path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):path.join(root,'node_modules/electron/dist/electron'+(process.platform==='win32'?'.exe':''))
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
try {
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(electron,[path.join(temp,'main.cjs')],{env});let output=''
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject)
    const timeout=setTimeout(()=>{child.kill();reject(Error('Inline UI timeout\n'+output))},90_000)
    child.on('exit',code=>{clearTimeout(timeout);resolve({code,output})})
  })
  assert.equal(result.code,0,result.output)
  console.log(result.output.split('\n').filter(line=>line.includes('INLINE_SELECTION_UI_RESULT')).join('\n'))
} finally { await fs.rm(temp,{recursive:true,force:true}) }
