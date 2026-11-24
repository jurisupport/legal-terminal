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
const formerBoardWorkspace = path.join(temp, '공유 보드 검증 사건')
const formerBoard = path.join(formerBoardWorkspace, '_업무지시')
const formerOwner = 'fb202658-7bf0-4d44-9d8f-a5ab203dce1d'
const home = path.join(temp, 'home')
const agentDir = path.join(home, '.claude/agents')
const profile = path.join(temp, 'profile')
const bulk = ['준비서면 쟁점 정리', '제출 서류 목록 작성', '계약 변경 사항 요약'].join('\n')

async function seed() {
  for (const dir of [board, formerBoard, profile, agentDir, path.dirname(screenshot)]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ jurisupportTokenEnc: 'plain:ui-test-only' }))
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
  await fs.writeFile(path.join(formerBoard, '_배분기'), formerOwner)
  for (const [id, title, status] of [['legacy-blocked','이전 장치 보류 건','blocked'], ['legacy-approval','이전 장치 결재 건','awaiting_approval']]) {
    await fs.writeFile(path.join(formerBoard, id + '.md'), `---\nid: ${id}\ntitle: ${title}\ncwd: '.'\nstatus: ${status}\n---\n${title}의 원래 본문`)
    await fs.writeFile(path.join(formerBoard, id + '.report.md'), title + ' 보고서 원문')
    await fs.writeFile(path.join(formerBoard, id + '.review.md'), title + ' 검토 원문')
  }
}

// Run built main, preload, renderer and storage. The provider returns synthetic reports.
function run({ root, workspace, board, temp, home, profile, screenshot, bulk, formerBoardWorkspace, formerBoard, formerOwner }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  app.setPath('home', home)
  app.setPath('userData', profile)
  BrowserWindow.prototype.show = BrowserWindow.prototype.maximize = function () {}
  let listMode = 'rows'
  const taskReads = []
  const cases = [{ id: 'case-a', caseName: '검토 대상 사건' }, { id: 'case-b', caseName: '다른 사건' }]
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10)
  const todoRows = [
    { id: 'A', title: 'A 준비서면 제출', caseId: 'case-a', type: 'todo', status: 'pending', dueDate: yesterday, assigneeId: null },
    { id: 'B', title: 'B 의뢰인 면담', caseId: 'case-a', type: 'todo', status: 'in_progress', dueDate: today, assigneeName: '박담당' },
    { id: 'C', title: 'C 종료한 지시', caseId: 'case-a', type: 'todo', status: 'completed' },
    { id: 'D', title: 'D 자정 후 기한', caseId: 'case-a', type: 'todo', status: 'pending', dueDate: yesterday + 'T15:30:00Z', assigneeName: '김담당' },
    { id: 'E', title: 'E 별건 메모 검토', caseId: 'case-b', type: 'todo', status: 'pending', dueDate: today, assigneeName: '박담당' },
    { id: 'F', title: 'F 기한 없는 점검', caseId: 'case-b', type: 'todo', status: 'pending', dueDate: null, reviewAt: today, assigneeName: '[김담당](https://example.invalid)' }
  ]
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.jurisupport.com/mcp')
    assert.equal(options.headers.Authorization, 'Bearer ui-test-only')
    const rpc = JSON.parse(options.body)
    const respond = (result, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
      status, headers: { 'mcp-session-id': 'test-session' }
    })
    if (rpc.method === 'initialize' || rpc.method === 'notifications/initialized') return respond({})
    assert.equal(rpc.method, 'tools/call')
    assert.equal(rpc.params.name, 'list_tasks')
    const args = rpc.params.arguments
    taskReads.push(args)
    if (listMode === 'denied') return respond({}, 403)
    // Return a second case and a closed row even for a scoped request, as a legacy endpoint might.
    const rows = listMode === 'empty' ? [] : todoRows
    return respond({ content: [{ type: 'text', text: JSON.stringify({ tasks: rows, hasNext: false, total: rows.length }) }] })
  }

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
  let pickedFolder = workspace
  const boardMutations = []
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (key, handler) => register(key, async (event, ...args) => {
    if (['workBoard:updateTask', 'workBoard:removeTask', 'workBoard:takeOwnership'].includes(key)) boardMutations.push({key, args})
    if (key.startsWith('workBoard:') || key.startsWith('workspace:') || ['app:info', 'tabs:ready', 'app:setWindowTitle'].includes(key)) return handler(event, ...args)
    if (key === 'fs:readText' && args[0] === path.join(workspace, '초안.md')) return handler(event, ...args)
    if (key === 'settings:get') return { draftsRoot: workspace, sshProfiles: [], agentDefaultProvider: 'claude' }
    if (key === 'case:history' || key === 'case:addHistory') return history
    if (key === 'app:generalChatDirectory') return path.join(home, '일반 대화')
    if (key === 'js:hasToken') return false
    if (key === 'js:tokenStatus') return { hasToken: false }
    if (key === 'js:listCases') return { ok: true, cases: args[0]?.refresh ? cases : [] }
    if (key === 'todo:list') return { ok: true, todos: [] }
    if (key === 'dialog:pickFolder') return { path: pickedFolder, name: path.basename(pickedFolder) }
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
  const click = (selector, label) => wait(() => evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(el => el.offsetWidth && !el.disabled)
    const button = buttons.find(el => el.textContent.includes(${JSON.stringify(label)}))
    if (!button) return false
    button.click()
    return true
  })()`), 'enabled ' + label)
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
    const providerRuns = queries.length
    async function review(title, choice, expectedStatus) {
      const before = taskReads.length
      await click('.work-board-window button', '일괄 지시')
      await visible('.wb-dialog textarea')
      const inputText = (selector, value) => evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      await inputText('.wb-dialog textarea', '할일 검토')
      await click('.wb-dialog button', '지시별 담당 지정')
      const notice = "document.querySelector('.wb-dialog .wb-primary').parentElement.textContent.includes('이 보드 폴더에 보고서로 저장')"
      if (choice === 'pinned') {
        await wait(() => evaluate("document.querySelector('.wb-draft')?.textContent.includes('할일 검토 범위 · case-a')"), 'linked case is fixed')
        assert.equal(await evaluate("!!document.querySelector('.wb-draft option[value=all]')"), false)
        assert.equal(await evaluate(notice), false)
      } else {
        await visible('.wb-draft option[value="case:case-a"]')
        const scope = `document.querySelector('.wb-draft option[value="all"]').parentElement`
        assert.equal(await evaluate(scope + '.value'), 'all')
        assert.equal(await evaluate(notice), true)
        if (choice !== 'all') {
          await evaluate(`(() => { const select = ${scope}; select.value = ${JSON.stringify(choice)}
            select.dispatchEvent(new Event('change', {bubbles:true})) })()`)
          assert.equal(await evaluate(notice), false)
        }
      }
      assert.equal(await evaluate("document.querySelector('.wb-dialog .wb-primary').disabled"), false)
      await inputText('.wb-draft input', title)
      assert.equal(taskReads.length, before, 'reads start only on registration')
      await click('.wb-dialog button', '1건 등록')
      await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'save ' + title)
      let task
      await wait(async () => {
        const snap = await evaluate(`window.lt.workBoard.snapshot(${JSON.stringify(workspace)})`)
        task = snap.tasks.find(t => t.title === title)
        return task?.status === expectedStatus
      }, title + ' ' + expectedStatus)
      assert.equal(task.body, '할일 검토')
      assert.ok(!task.agent && !task.review_agent, 'default worker, no review agent')
      assert.equal(queries.length, providerRuns, 'native report requires no model invocation')
      const reads = taskReads.slice(before)
      assert.deepEqual(reads, [{ page: 1, limit: 100, type: 'todo', includeClosed: false, fields: 'compact',
        ...(choice === 'all' ? {} : { caseId: 'case-a' }) }])
      await click('.work-board-window .work-board-links button', '업무 보드')
      await click('.wb-card', title)
      const report = fs.readFileSync(path.join(board, task.id + '.report.md'), 'utf8')
      if (expectedStatus === 'blocked') {
        await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('권한')"), 'read failure displayed')
      } else {
        await wait(() => evaluate("!!document.querySelector('.wb-dialog .wb-todo-report')?.textContent.trim()"), 'report rendered')
        const text = await evaluate("document.querySelector('.wb-todo-report').innerText")
        if (listMode === 'empty') assert.match(text, /미완료 할일 0건/)
        else {
          assert.ok(text.includes('D 자정 후 기한'))
          assert.ok(await evaluate("!!document.querySelector('.wb-todo-report table')"), 'report uses accessible tables')
          assert.equal(await evaluate("document.querySelectorAll('.wb-todo-report a, .wb-todo-report img').length"), 0, 'todo fields cannot introduce links or images')
          if (choice === 'case:case-a') {
            await evaluate(`(async () => {
              document.querySelector('.wb-todo-report').closest('section').scrollIntoView({block:'start'})
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            })()`)
            assert.ok(await evaluate(`[...document.querySelectorAll('.wb-todo-report table')].every(table =>
              table.clientWidth <= table.parentElement.clientWidth + 1 ||
              ['auto','scroll'].includes(getComputedStyle(table.parentElement).overflowX))`), 'wide report tables can scroll')
            fs.writeFileSync(path.join(path.dirname(screenshot), 'todo-review.png'), (await win.webContents.capturePage()).toPNG())
          }
        }
      }
      await click('.wb-dialog button', '닫기')
      return report
    }
    const scoped = await review('사건 미완료 목록', 'case:case-a', 'awaiting_approval')
    for (const value of ['미완료 할일 3건', '기한 초과 1건', '기한 임박 2건', '담당자 미지정 1건', 'A 준비서면 제출', 'B 의뢰인 면담', 'D 자정 후 기한']) assert.ok(scoped.includes(value), value)
    const midnightRow = scoped.split('\n').find(line => line.includes('D 자정 후 기한'))
    assert.ok(midnightRow.includes(today) && !midnightRow.includes('기한 초과'), 'UTC 15:30 belongs to today in Seoul')
    assert.doesNotMatch(scoped, /별건 메모|종료한 지시|F 기한 없는 점검/)
    const all = await review('전체 미완료 목록', 'all', 'awaiting_approval')
    assert.ok(all.includes('미완료 할일 5건') && all.includes(todoRows[4].title))
    for (const label of ['기한 없음 1건', '재확인일 도래 1건', 'F 기한 없는 점검']) assert.ok(all.includes(label), label)
    listMode = 'denied'
    const denied = await review('연결 확인', 'case:case-a', 'blocked')
    assert.match(denied, /권한/)
    assert.doesNotMatch(denied, /미완료 할일 0건|ui-test-only/)
    listMode = 'empty'
    fs.writeFileSync(path.join(home, '.claude', 'legal-terminal-cases.json'), JSON.stringify({
      version: 1, entries: [{ key: 'case-a', drafts: workspace, updatedAt: new Date().toISOString() }]
    }))
    await evaluate("document.querySelector('.work-board-window button[aria-label=\"작업 공간으로 돌아가기\"]').click()")
    await click('.work-board-links button', '업무 보드')
    await wait(() => evaluate("document.querySelectorAll('.wb-lane').length === 5"), 'reopen board with linked case')
    const empty = await review('빈 사건 확인', 'pinned', 'awaiting_approval')
    assert.match(empty, /미완료 할일 0건/)
    // This folder came from a different workstation. Its original owner has stopped.
    pickedFolder = formerBoardWorkspace
    await evaluate(`(() => {
      const select = document.querySelector('[aria-label="업무 보드 작업 폴더"]')
      select.value = ''
      select.dispatchEvent(new Event('change', {bubbles:true}))
    })()`)
    await wait(() => evaluate("document.querySelector('.work-board')?.textContent.includes('이 PC에서 관리')"), 'read-only shared board')
    const shared = () => evaluate(`window.lt.workBoard.snapshot(${JSON.stringify(formerBoardWorkspace)})`)
    assert.equal((await shared()).readOnly, true)
    await click('.wb-card', '이전 장치 결재 건')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('결재 건 보고서 원문')"), 'read original report')
    assert.equal(await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='승인' && !b.disabled)"), false)
    await click('.wb-dialog button', '닫기')
    await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'close read-only detail')
    await click('.work-board button', '이 PC에서 관리')
    const confirmDialog = name => 'dialog[aria-label="' + name + '"] button'
    await visible('dialog[aria-label="관리 기기 변경"]')
    fs.writeFileSync(path.join(path.dirname(screenshot), 'handoff.png'), (await win.webContents.capturePage()).toPNG())
    assert.equal(fs.readFileSync(path.join(formerBoard,'_배분기'),'utf8'), formerOwner)
    await click(confirmDialog('관리 기기 변경'), '관리 기기 변경')
    await wait(async () => !(await shared()).readOnly, 'new owner accepted')
    assert.notEqual(fs.readFileSync(path.join(formerBoard,'_배분기'),'utf8'), formerOwner)
    await click('.wb-card', '이전 장치 보류 건')
    await click('.wb-dialog button', '지시 수정')
    const editForm = 'dialog[aria-label="지시 수정"]'
    await visible(editForm)
    await evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(editForm)})
      for (const [label, text] of [['제목','인수 후 변경한 지시'], ['지시 본문','변경 내용을 보존합니다.']]) {
        const input = [...form.querySelectorAll('label')].find(el=>el.textContent.trim().startsWith(label)).querySelector('input,textarea')
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,text)
        input.dispatchEvent(new Event('input',{bubbles:true}))
      }
    })()`)
    await click(confirmDialog('지시 수정'), '변경 저장')
    await wait(async () => (await shared()).tasks.some(t=>t.id==='legacy-blocked' && t.title==='인수 후 변경한 지시' && t.body==='변경 내용을 보존합니다.' && t.status==='blocked'), 'edited instruction waits for explicit retry')
    const update = boardMutations.find(m=>m.key==='workBoard:updateTask')
    assert.ok(update?.args[3], 'editor supplies reviewed revision')
    const conflict = await evaluate(`window.lt.workBoard.updateTask(...${JSON.stringify(update.args)}).then(() => '', error => error.message)`)
    assert.match(conflict, /변경되었/, 'an outdated editor cannot overwrite the saved change')
    const closeDetails = async () => {
      if (await evaluate("!!document.querySelector('.wb-dialog[open]')")) await click('.wb-dialog[open] button', '닫기')
      await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'detail closed')
    }
    await closeDetails()
    await click('.wb-card', '인수 후 변경한 지시')
    await click('.wb-dialog button', '지시 삭제')
    await visible('dialog[aria-label="지시 삭제"]')
    await click(confirmDialog('지시 삭제'), '취소')
    assert.ok((await shared()).tasks.some(t=>t.id==='legacy-blocked'), 'cancelling deletion preserves the task')
    await closeDetails()
    await click('.wb-card', '인수 후 변경한 지시')
    await click('.wb-dialog button', '지시 삭제')
    await click(confirmDialog('지시 삭제'), '삭제 확인')
    await wait(async () => !(await shared()).tasks.some(t=>t.id==='legacy-blocked'), 'confirmed removal persisted')
    for (const name of ['legacy-blocked.md','legacy-blocked.report.md','legacy-blocked.review.md']) {
      assert.equal(fs.existsSync(path.join(formerBoard,name)), false, name + ' removed from active board')
    }
    const archive = path.join(formerBoard, '_보관')
    const archived = fs.readdirSync(archive, {recursive:true}).filter(name=>name.endsWith('.md')).map(name=>fs.readFileSync(path.join(archive,name),'utf8'))
    for (const evidence of ['이전 장치 보류 건 보고서 원문','이전 장치 보류 건 검토 원문','변경 내용을 보존합니다.']) {
      assert.ok(archived.some(text=>text.includes(evidence)), 'original and edited content remain recoverable')
    }
    assert.equal(fs.readFileSync(path.join(formerBoard,'legacy-approval.report.md'),'utf8'), '이전 장치 결재 건 보고서 원문')
    await click('.wb-card', '이전 장치 결재 건')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('결재 건 검토 원문')"), 'new owner reviews prior report')
    await click('.wb-dialog button', '승인')
    await wait(async () => (await shared()).tasks.some(t=>t.id==='legacy-approval' && ['approved','done'].includes(t.status)), 'new owner can approve')
    assert.equal(queries.length, providerRuns, 'takeover does not execute approved or blocked work again')
    console.log('PASS 이전 장치 보드 · 읽기 전용 조회 · 관리 인수 · 수정 충돌 차단 · 삭제 확인 · 새 기기 결재')
    console.log('PASS 할일 검토 · 사건 범위 · 전체 선택 · 조회 권한 거부 · 실제 0건')
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
  await fs.writeFile(entry, '(' + run.toString() + ')(' + JSON.stringify({ root, temp, home, profile, workspace, board, screenshot, bulk, formerBoardWorkspace, formerBoard, formerOwner }) + ')')
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
