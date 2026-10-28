// Run after npm run build. Real renderer, isolated profile, synthetic IPC only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-interaction-'))
const output = path.join(root, 'output/playwright/agent-interaction')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function checkInteraction({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const errors = [], answers = [], documentReads = [], externalLinks = []
  let markRendererReady
  const rendererReady = new Promise(resolve => { markRendererReady = resolve })
  const settings = { sshProfiles: [], notifyDone: false, agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    if (channel === 'tabs:ready') { markRendererReady(); return }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Interaction fixture', homeDirectory: '/synthetic' }
    if (channel === 'app:generalChatDirectory') return ''
    if (channel === 'fs:readText') { documentReads.push(args[0]); return { kind: 'text', ext: '.md', text: '# 계약서\n\n검토할 문서입니다.', size: 60, mtimeMs: 0 } }
    if (channel === 'app:openExternal') { externalLinks.push(args[0]); return }
    if (channel === 'fs:stat') return { ok: true, isDir: !String(args[0]).endsWith('.md'), size: 60, mtimeMs: 0 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel === 'agent:answerDialog') {
      answers.push(args[0])
      w.webContents.send('agent:event', { type: 'dialog:resolved', ...args[0] })
      w.webContents.send('agent:event', { type: 'status', sessionId: args[0].sessionId, status: 'working' })
      return { ok: true }
    }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  w.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const pause = () => new Promise(resolve => setTimeout(resolve, 60))
  const wait = async condition => {
    for (let i = 0; i < 120; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error('Timed out: ' + condition)
  }
  const check = (value, message) => { if (!value) throw Error(message) }
  const capture = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const bounds = await run("const r = document.querySelector('.agent-panel[data-visible=true]').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }")
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage(bounds)).toPNG())
  }
  const send = event => w.webContents.send('agent:event', { sessionId: 'interaction-agent', ...event })
  const question = (dialogId, multiSelect = false, count = 1) => {
    send({ type: 'dialog:request', dialog: { dialogId, title: '검토 방향', questions: Array.from({ length: count }, (_, index) => ({
      id: `q-${index}`, header: index ? '출력 형식' : '검토 범위', question: index ? '어떤 형식으로 정리할까요?' : '어떤 범위로 검토할까요?', multiSelect,
      options: [{ id: 'summary', label: '핵심 쟁점 먼저', description: '주요 쟁점과 확인할 자료를 간결하게 정리합니다.' },
        { id: 'detail', label: '전체 기록 검토', description: '기록 전체를 읽고 쟁점별 근거를 정리합니다.' }]
    })) } })
    send({ type: 'status', status: 'waiting_user' })
  }
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await rendererReady
    await wait("!!document.querySelector('.case-sidebar-trigger')")
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'interaction-agent', kind: 'agent', agentProvider: 'claude', title: '에이전트 표시 검증', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    await wait("!!document.querySelector('.agent-panel[data-visible=true] .agent-composer')")
    send({ type: 'auth:status', state: 'authenticated' })
    send({ type: 'message:user', messageId: 'user', text: '기록을 검토하고 필요한 사항은 선택지로 물어봐 주세요.' })
    send({ type: 'status', status: 'working' })
    await wait("!!document.querySelector('.agent-status-line.working')")
    await capture('thinking')
    question('single')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await capture('question')
    check(await run("return !!document.querySelector('.agent-status-indicator svg')"), 'active work needs a visible thinking indicator')
    check(await run("return !!document.querySelector('.agent-status-jump')"), 'pending choices need a shortcut outside the scrolling conversation')
    await run("document.querySelector('.agent-option').click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[0].answers['어떤 범위로 검토할까요?'] === '핵심 쟁점 먼저', 'single choice must submit immediately')
    check(await run("return document.querySelector('.agent-option').getAttribute('aria-pressed') === 'true'"), 'resolved choices must retain their selected appearance')

    // Multiple questions collect all answers; multiple selection waits for explicit send.
    question('multiple-questions', false, 2)
    await wait("document.querySelectorAll('.agent-card.dialog.waiting .agent-question').length === 2")
    await run("document.querySelector('.agent-card.dialog.waiting .agent-option').click()")
    check(answers.length === 1, 'an incomplete multi-question answer must not submit')
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-question')[1].querySelectorAll('.agent-option')[1].click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(Object.keys(answers[1].answers).length === 2, 'all question answers must be delivered')
    question('multi-select', true)
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-option').forEach(button => button.click())")
    check(answers.length === 2, 'multiple selection must wait for send')
    await run("document.querySelector('.agent-card.dialog.waiting .agent-dialog-actions button').click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[2].answers['어떤 범위로 검토할까요?'] === '핵심 쟁점 먼저, 전체 기록 검토', 'all selected choices must be delivered')
    question('freeform')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run(`const input = document.querySelector('.agent-card.dialog.waiting input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '입증 자료부터 정리해 주세요.');
      input.dispatchEvent(new Event('input', { bubbles: true }));`)
    await pause()
    await run("document.querySelector('.agent-card.dialog.waiting input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))")
    check(answers.length === 3, 'Korean IME composition must not submit')
    await run("document.querySelector('.agent-card.dialog.waiting input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[3].response === '입증 자료부터 정리해 주세요.', 'freeform answer must be delivered')
    question('cancel')
    await wait("!!document.querySelector('.agent-card.dialog.waiting')")
    await run("document.querySelectorAll('.agent-card.dialog.waiting .agent-dialog-actions button')[1].click()")
    await wait("!document.querySelector('.agent-card.dialog.waiting')")
    check(answers[4].cancelled === true, 'cancel must preserve the dialog cancellation path')
    send({ type: 'status', status: 'done' })
    await wait("!document.querySelector('.agent-status-line')")
    send({ type: 'status', status: 'working' })
    await wait("!!document.querySelector('.agent-status-line.working')")
    check(await run("return document.querySelector('.agent-status-text').textContent.includes('생각 중')"), 'working without a running tool shows thinking')
    send({ type: 'tool:start', toolId: 'read', name: 'Read', inputPreview: '{"file_path":"/synthetic/기록.pdf"}' })
    await wait("document.querySelector('.agent-status-text').textContent.includes('도구 실행 중')")
    send({ type: 'tool:done', toolId: 'read', outputPreview: '자료 확인 완료' })
    send({ type: 'message:assistant_delta', messageId: 'reply', text: '검토할 자료를 확인했습니다.' })
    await wait("document.querySelector('.agent-status-text').textContent.includes('답변 작성 중')")
    send({ type: 'message:assistant_done', messageId: 'reply' })
    question('narrow', true)
    w.setContentSize(900, 760)
    await wait('innerWidth === 900')
    check(await run("const p = document.querySelector('.agent-panel[data-visible=true]'); return p.scrollWidth <= p.clientWidth + 1"), 'narrow panels must not overflow')
    await run("document.querySelector('.agent-timeline').scrollTop = 0; document.querySelector('.agent-status-jump').click()")
    await wait("(() => { const r = document.querySelector('.agent-card.dialog.waiting').getBoundingClientRect(); const p = document.querySelector('.agent-timeline').getBoundingClientRect(); return r.bottom <= p.bottom + 1 && r.top >= p.top - 1 })()")
    check(await run("return document.querySelector('.agent-card.dialog.waiting .agent-option') === document.activeElement"), 'jump must focus the first choice')
    await capture('narrow-question')
    send({ type: 'status', status: 'error' })
    await wait("!document.querySelector('.agent-status-line')")
    send({ type: 'message:user', messageId: 'progress-user', text: '관련 판례를 확인하고 검토 결과를 정리해 주세요.' })
    send({ type: 'status', status: 'working' })
    send({ type: 'tool:start', toolId: 'described-shell', name: 'Bash', inputPreview: '{}' })
    const command = 'python /synthetic/scan.py --all'
    const description = 'Searching case records for precedents'
    send({ type: 'tool:input', toolId: 'described-shell', inputPreview: JSON.stringify({ command, description }), description })
    await wait("document.querySelector('.agent-status-tool')?.textContent.includes('명령 실행')")
    send({ type: 'tool:done', toolId: 'described-shell', outputPreview: 'RAW_PROCESS_OUTPUT' })
    send({ type: 'tool:start', toolId: 'described-agent', name: 'Agent', inputPreview: '{"description":"최초 검토 작업","prompt":"RAW_AGENT_PROMPT"}' })
    send({ type: 'process:event', processId: 'described-agent', title: '도구 · Agent', toolName: 'Agent', text: 'Comparing facts from three precedents', status: 'running' })
    send({ type: 'process:event', processId: 'progress-summary', title: '도구 요약', text: 'Found three relevant precedents', status: 'done' })
    await wait("Array.from(document.querySelectorAll('.agent-tool-row.running .agent-tool-name')).some(el => el.textContent === '하위 작업')")
    check(await run("return Array.from(document.querySelectorAll('.agent-tool-line')).every(el => !/Searching case|Comparing facts|Found three/.test(el.textContent + el.title))"), 'English summaries stay out of collapsed rows and tooltips')
    check(await run("const flag = Array.from(document.querySelectorAll('.agent-tool-flag')).find(el => el.textContent === '실행 중'); return flag && flag.getBoundingClientRect().height < 30"), 'running status must stay on one line in a narrow panel')
    check(await run("return !document.querySelector('.agent-panel[data-visible=true]').textContent.includes('RAW_PROCESS_OUTPUT') && !document.querySelector('.agent-panel[data-visible=true]').textContent.includes('python /synthetic') && !document.querySelector('.agent-panel[data-visible=true]').textContent.includes('RAW_AGENT_PROMPT')"), 'commands and raw output stay collapsed')
    check(await run("const p = document.querySelector('.agent-panel[data-visible=true]'); return p.scrollWidth <= p.clientWidth + 1"), 'progress descriptions must fit a narrow panel')
    await capture('progress-descriptions')
    await run("Array.from(document.querySelectorAll('.agent-tool-line')).find(el => el.textContent.includes('명령 실행')).click()")
    await wait("Array.from(document.querySelectorAll('.agent-tool-details')).some(el => el.textContent.includes('RAW_PROCESS_OUTPUT') && el.textContent.includes('python /synthetic'))")
    check(await run("return Array.from(document.querySelectorAll('.agent-tool-details')).some(el => el.textContent.includes('Searching case records for precedents'))"), 'original tool description stays available')
    await run("Array.from(document.querySelectorAll('.agent-tool-line')).find(el => el.textContent.includes('하위 작업')).click(); Array.from(document.querySelectorAll('.agent-tool-line')).find(el => el.textContent.includes('도구 요약')).click()")
    await wait("Array.from(document.querySelectorAll('.agent-tool-details')).some(el => el.textContent.includes('Comparing facts from three precedents')) && Array.from(document.querySelectorAll('.agent-tool-details')).some(el => el.textContent.includes('Found three relevant precedents'))")
    await capture('progress-details')
    send({ type: 'process:event', processId: 'described-agent', title: '도구 · Agent', toolName: 'Agent', status: 'done' })
    send({ type: 'message:user', messageId: 'system-log-user', text: '테스트 세션이야.' })
    send({ type: 'process:event', processId: 'remote-connection', title: '원격 연결됨', text: '원격 컴퓨터에 연결했습니다.', status: 'done' })
    send({ type: 'process:event', processId: 'hook-0', title: 'Hook · SessionStart:startup', text: 'SessionStart', status: 'running' })
    send({ type: 'status', status: 'working' })
    await wait("!!document.querySelector('.agent-system-log')")
    check(await run("return document.querySelector('.agent-status-text').textContent.includes('생각 중') && !document.querySelector('.agent-status-tool')"), 'normal hooks must not impersonate active user tool work')
    for (const [index, name] of ['SessionStart:startup', 'SessionStart:startup', 'UserPromptSubmit', 'Stop', 'Stop'].entries()) {
      send({ type: 'process:event', processId: `hook-${index}`, title: `Hook · ${name}`, text: `RAW_HOOK_OUTPUT_${index}`, status: 'success' })
    }
    send({ type: 'process:event', processId: 'system-limit', title: 'Rate limit', text: 'allowed', status: 'allowed' })
    send({ type: 'message:assistant_delta', messageId: 'test-reply', text: '알겠습니다. 테스트 세션으로 진행할게요.' })
    send({ type: 'message:assistant_done', messageId: 'test-reply' })
    send({ type: 'status', status: 'done' })
    await wait("document.querySelector('.agent-system-log summary')?.textContent === '시스템 기록 6개'")
    check(await run("const log = document.querySelector('.agent-system-log'); const visible = document.querySelector('.agent-panel[data-visible=true]').innerText; return !log.open && !visible.includes('RAW_HOOK_OUTPUT') && !visible.includes('SessionStart:startup') && !visible.includes('allowed') && visible.includes('테스트 세션으로 진행할게요')"), 'the reported remote transcript must show the reply and one collapsed diagnostic group')
    await capture('system-logs-collapsed')
    await run("document.querySelector('.agent-system-log summary').click(); document.querySelector('.agent-system-log .agent-tool-line').click()")
    await wait("document.querySelector('.agent-system-log').innerText.includes('RAW_HOOK_OUTPUT_0')")
    check(await run("return document.querySelector('.agent-system-log').innerText.includes('Hook · SessionStart:startup')"), 'original hook names and output must remain inspectable')
    await capture('system-logs-expanded')
    await run("document.querySelector('.agent-system-log summary').click()")
    send({ type: 'process:event', processId: 'hook-0', title: 'Hook · SessionStart:startup', text: 'RAW_HOOK_FAILURE', status: 'error' })
    send({ type: 'process:event', processId: 'system-limit', title: 'Rate limit', text: 'allowed_warning', status: 'allowed_warning' })
    await wait("Array.from(document.querySelectorAll('.agent-tools > .agent-tool-row.warning')).some(row => row.innerText.includes('사용 한도에 가까워졌습니다'))")
    check(await run("return Array.from(document.querySelectorAll('.agent-tools > .agent-tool-row.error')).some(row => row.innerText.includes('자동 처리 오류')) && document.querySelector('.agent-system-log summary').textContent === '시스템 기록 4개'"), 'failures and usage warnings must leave the collapsed group immediately')
    send({ type: 'process:event', processId: 'system-limit', title: 'Rate limit', text: 'rejected', status: 'rejected' })
    await wait("Array.from(document.querySelectorAll('.agent-tools > .agent-tool-row.error')).some(row => row.innerText.includes('사용 한도에 도달했습니다'))")
    check(await run("const p = document.querySelector('.agent-panel[data-visible=true]'); return p.scrollWidth <= p.clientWidth + 1"), 'system warnings must fit a narrow panel')
    await capture('system-logs-action-needed')
    send({ type: 'message:assistant_delta', messageId: 'document-links', text: '[내부 문서](<file:///synthetic/준비%20서면.md>) · [웹 문서](https://example.com/docs)' })
    send({ type: 'message:assistant_done', messageId: 'document-links' })
    await wait("!!document.querySelector('#agent-message-interaction-agent-document-links [data-agent-file]')")
    await run("document.querySelector('#agent-message-interaction-agent-document-links [data-agent-file]').click()")
    for (let i = 0; i < 120 && !documentReads.includes('/synthetic/준비 서면.md'); i++) await pause()
    check(documentReads.includes('/synthetic/준비 서면.md'), 'assistant document link must reach the real App document reader')
    check(externalLinks.length === 0, 'internal document links must not reach the OS URL handler')
    await run("document.querySelector('#agent-message-interaction-agent-document-links a[href^=https]').click()")
    for (let i = 0; i < 120 && !externalLinks.length; i++) await pause()
    check(externalLinks[0] === 'https://example.com/docs', 'web links must keep their external route')
    send({ type: 'plan:proposed', planId: 'linked-plan', markdown: '[계획 참고 문서](./계획.md)' })
    await wait("!!document.querySelector('.agent-card.plan [data-agent-file]')")
    await run("document.querySelector('.agent-card.plan [data-agent-file]').click()")
    for (let i = 0; i < 120 && !documentReads.includes('/synthetic/계획.md'); i++) await pause()
    check(documentReads.includes('/synthetic/계획.md'), 'plan links must resolve against the agent workspace')
    send({ type: 'message:assistant_delta', messageId: 'inline-file', text: '결과 파일: ' + String.fromCharCode(96) + '/synthetic/분석_gemini-3.8-flash.md' + String.fromCharCode(96) })
    send({ type: 'message:assistant_done', messageId: 'inline-file' })
    await wait("!!document.querySelector('#agent-message-interaction-agent-inline-file [data-agent-file] code')")
    await run("document.querySelector('#agent-message-interaction-agent-inline-file [data-agent-file] code').click()")
    for (let i = 0; i < 120 && !documentReads.includes('/synthetic/분석_gemini-3.8-flash.md'); i++) await pause()
    check(documentReads.includes('/synthetic/분석_gemini-3.8-flash.md'), 'inline-code result path must open the App document reader')
    check(errors.length === 0, errors.join('\n'))
    console.log('Agent interaction: thinking/tool/response states, choices, freeform, IME, cancel, jump, narrow layout, SDK descriptions, raw-detail disclosure and document/web links passed')
    app.exit(0)
  } catch (error) {
    await capture('failure').catch(() => {})
    console.error(error)
    app.exit(1)
  }
}
await fs.writeFile(path.join(temp, 'main.cjs'), `(${checkInteraction.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Agent interaction check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
