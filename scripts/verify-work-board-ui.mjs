import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lt-board-ui-')))
const screenshot = path.join(root, 'output/work-board/board.png')
const workspace = path.join(temp, '시안 검증 사건')
const board = path.join(workspace, '_업무지시')
const home = path.join(temp, 'home')
const agentDir = path.join(home, '.claude/agents')
const profile = path.join(temp, 'profile')
const bulk = ['준비서면 쟁점 정리', '제출 서류 목록 작성', '계약 변경 사항 요약'].join('\n')

async function seed() {
  for (const dir of [board, profile, agentDir, path.dirname(screenshot)]) await fs.mkdir(dir, { recursive: true })
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
  const fixtures = [
    ['waiting-a', '12월 블로그·쇼츠 편집 캘린더', 'content-planner', 'queued'],
    ['waiting-b', '검색광고 키워드 구조 설계', 'search-ads', 'queued'],
    ['waiting-c', '기업 자문 제안서 초안', 'proposal', 'queued'],
    ['waiting-d', '블로그 주제 겹침 점검', 'seo', 'queued'],
    ['active-a', '용역계약서 위임 조항 검토', 'contract-review', 'queued', today],
    ['active-b', '모집 광고 문안 5안', 'ad-creative', 'queued'],
    ['active-c', '카드뉴스 구성안', 'sns-curator', 'queued'],
    ['active-d', '광고 문안 준법 검토', 'compliance', 'queued'],
    ['hold', '모집 사건 FAQ 수정', 'platform-manager', 'blocked'],
    ['approve-a', '안내 메일 발송 설계', 'newsletter', 'awaiting_approval', today],
    ['approve-b', '판결 보도자료 초안', 'pr', 'awaiting_approval'],
    ['approve-c', '쇼츠 제목·썸네일 3안', 'youtube-optimizer', 'awaiting_approval'],
    ['done-a', '기록 1쪽 요약', 'exec-summary', 'done'],
    ['done-b', 'AI 검색 인용 점검', 'ai-search', 'done']
  ]
  for (const [order, [id, title, agent, status, due]] of fixtures.entries()) {
    const task = { id, cwd: workspace, title, agent, status, order, due, approval: 'required',
      depends_on: id.startsWith('waiting-') ? ['hold'] : [], createdAt: new Date().toISOString() }
    const front = Object.entries(task).filter(([, v]) => v !== undefined).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\n')
    await fs.writeFile(path.join(board, id + '.md'), '---\n' + front + '\n---\n' + title)
    await fs.writeFile(path.join(agentDir, agent + '.md'), '---\nname: ' + agent + '\ndescription: 검수 담당\n---\n요청한 업무를 검토합니다.\n')
  }
  await fs.writeFile(path.join(board, 'approve-a.report.md'), '## 결론\n검토용 보고서입니다.\n## 산출물 경로\n- 초안.md\n')
  await fs.writeFile(path.join(board, 'approve-a.review.md'), '준법감시 검토 완료')
  await fs.writeFile(path.join(workspace, '초안.md'), '발송 전 검토본')
}

// Run built main, preload, renderer and storage. The provider returns synthetic reports.
function run({ root, workspace, board, temp, home, profile, screenshot, bulk }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  app.setPath('home', home)
  app.setPath('userData', profile)
  BrowserWindow.prototype.show = BrowserWindow.prototype.maximize = function () {}
  global.fetch = async () => { throw Error('Network disabled by UI test') }

  const projectRequire = require('node:module').createRequire(path.join(root, 'package.json'))
  const sdkId = projectRequire.resolve('@anthropic-ai/claude-agent-sdk')
  const sdk = projectRequire(sdkId)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const queries = []
  require.cache[sdkId].exports = { ...sdk, query({ options, prompt }) {
    assert.ok(options.cwd.startsWith(temp + path.sep))
    queries.push({ prompt, agent: options.agent })
    return { close() {}, async *[Symbol.asyncIterator]() {
      await gate
      yield { type: 'result', subtype: 'success', is_error: false, result: '## 결론\n합성 수행 보고서' }
    } }
  } }

  const history = [{ drafts: workspace, name: '시안 검증 사건', ts: Date.now() }]
  const sessions = new Map()
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (key, handler) => register(key, async (event, ...args) => {
    if (key.startsWith('workBoard:') || key.startsWith('workspace:') || ['app:info', 'tabs:ready', 'app:setWindowTitle'].includes(key)) return handler(event, ...args)
    if (key === 'fs:readText' && args[0] === path.join(workspace, '초안.md')) return handler(event, ...args)
    if (key === 'settings:get') return { draftsRoot: workspace, sshProfiles: [], agentDefaultProvider: 'claude' }
    if (key === 'case:history' || key === 'case:addHistory') return history
    if (key === 'app:generalChatDirectory') return path.join(home, '일반 대화')
    if (key === 'js:hasToken') return false
    if (key === 'js:tokenStatus') return { hasToken: false }
    if (key === 'js:listCases') return { ok: true, cases: [] }
    if (key === 'todo:list') return { ok: true, todos: [] }
    if (key === 'dialog:pickFolder') return { path: workspace, name: '시안 검증 사건' }
    if (key === 'agent:create') {
      const options = args[0]
      sessions.set(options.id, options)
      setTimeout(() => event.sender.send('agent:event', { type:'auth:status', sessionId:options.id, state:'authenticated' }), 30)
      return { ok: true, sessionId: options.id }
    }
    if (key === 'agent:snapshot') return { ok: true, session: sessions.get(args[0]) }
    if (key === 'agent:models') return { ok: true, models: [] }
    if (key === 'fs:listDocumentDrafts') return { ok: true, entries: [] }
    if (['fs:list', 'fs:listPdfs', 'sessions:list', 'projects:list'].includes(key)) return []
    return null
  })
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_, reply) => reply({ cancel: true })))
  let win
  const ready = new Promise(resolve => app.once('browser-window-created', (_, window) => {
    win = window
    window.setContentSize(1280, 800)
    window.webContents.once('did-finish-load', resolve)
  }))
  require(path.join(root, 'out/main/index.js'))
  const evaluate = expression => win.webContents.executeJavaScript(expression, true)
  async function wait(check, label) {
    for (let i = 0; i < 160; i++) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 75))
    }
    throw Error('Timed out: ' + label)
  }
  const visible = selector => wait(() => evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'), selector)
  const click = (selector, label) => evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(el => el.offsetWidth && !el.disabled)
    const button = buttons.find(el => el.textContent.includes(${JSON.stringify(label)}))
    if (!button) throw Error('Missing enabled button: ' + ${JSON.stringify(label)})
    button.click()
  })()`)
  ;(async () => {
    await ready
    await visible('.case-sidebar-case')
    await click('.case-sidebar-case', '시안 검증 사건')
    await visible('.case-sidebar-group.active .case-sidebar-new-task')
    await evaluate("document.querySelector('.case-sidebar-group.active .case-sidebar-new-task').click()")
    await wait(() => [...sessions.values()].some(agent => agent.cwd === workspace), 'active case agent')
    await click('.work-board-links button', '업무 보드')
    await wait(() => evaluate("document.querySelectorAll('.wb-lane').length === 5"), 'five kanban lanes')
    assert.equal(await evaluate("document.querySelector('[aria-label=\"업무 보드 작업 폴더\"]').value"), workspace)
    await evaluate(`window.lt.workBoard.configure(${JSON.stringify(workspace)}, {concurrency:4})`)
    await wait(() => queries.length === 4, 'four independent provider sessions')
    await wait(() => evaluate("JSON.stringify([...document.querySelectorAll('.wb-stat strong')].map(el=>el.textContent)) === '[\"4\",\"3\",\"2\",\"0\"]'"), 'summary counts')
    await wait(() => evaluate("document.querySelector('.work-board-window .work-board-links span')?.textContent === '3'"), 'header badge')
    assert.equal(await evaluate("document.querySelectorAll('.wb-org .wb-team').length"), 6)
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    await click('.wb-stat', '기한 임박')
    await wait(() => evaluate("document.querySelectorAll('.wb-card').length === 2"), 'filter due cards')
    await click('.work-board-window .work-board-links button', '결재함')
    await click('.wb-page .wb-card', '안내 메일 발송 설계')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('준법감시 검토 완료')"), 'report and review')
    await click('.wb-dialog button', '초안.md 열기')
    await wait(() => evaluate("document.querySelector('.wb-artifact')?.textContent.includes('발송 전 검토본')"), 'open draft inline')
    await click('.wb-dialog button', '승인')
    await wait(() => evaluate("document.querySelector('.work-board-window .work-board-links span')?.textContent === '2'"), 'approval decrements global badge')
    await evaluate("document.querySelector('.work-board-window button[aria-label=\"작업 공간으로 돌아가기\"]').click()")
    await evaluate(`(() => { const input = [...document.querySelectorAll('.agent-composer textarea')].find(el=>el.offsetWidth)
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, ${JSON.stringify(bulk)})
      input.dispatchEvent(new Event('input', {bubbles:true})) })()`)
    await click('.agent-composer button', '일괄 지시')
    await visible('.wb-dialog textarea')
    assert.equal(await evaluate("document.querySelector('.wb-dialog textarea').value"), bulk)
    await click('.wb-dialog button', '지시별 담당 지정')
    assert.equal(await evaluate("document.querySelectorAll('.wb-draft').length"), 3)
    await evaluate("const field = document.querySelector('.wb-draft select'); field.value = 'compliance'; field.dispatchEvent(new Event('change', {bubbles:true}))")
    await click('.wb-dialog button', '3건 등록')
    await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'three instructions submitted')
    release()
    await wait(() => fs.readdirSync(board).filter(s=>/\.report\.md$/.test(s)).length === 8, 'seven reports persisted')
    assert.ok(queries.find(q=>q.agent === 'compliance' && q.prompt.includes('준비서면 쟁점 정리')))
    await click('.work-board-window .work-board-links button', '일일 보고')
    await click('.wb-page button', '오늘 보고서 저장')
    await wait(() => fs.existsSync(path.join(board,'_일일보고')) && fs.readdirSync(path.join(board,'_일일보고')).some(name=>name.endsWith('.html')), 'daily HTML')
    console.log('PASS 업무 보드 · 실제 IPC · 결재 · 일괄 입력 3건 · 보고 저장 · ' + screenshot)
    app.exit(0)
  })().catch(async error => {
    console.error(error, await evaluate('document.body.innerText.slice(-4000)').catch(()=>'')); app.exit(1)
  })
}

try {
  await seed()
  await fs.mkdir(path.join(home, '일반 대화'))
  const entry = path.join(temp, 'ui.cjs')
  await fs.writeFile(entry, '(' + run.toString() + ')(' + JSON.stringify({ root, temp, home, profile, workspace, board, screenshot, bulk }) + ')')
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|LEGAL_TERMINAL_CHECK_UPDATE_IN_DEV)/.test(key)) delete env[key]
  await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [entry, '--disable-background-networking', '--user-data-dir=' + profile], { env, stdio:'inherit' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 65_000)
    child.on('error', reject)
    child.on('exit', (code, signal) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(Error('UI test exited ' + (signal || code))) })
  })
  assert.ok((await fs.stat(screenshot)).size > 10000)
} finally { await fs.rm(temp, {recursive:true, force:true}) }
