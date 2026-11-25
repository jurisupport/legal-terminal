import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { utils as cfbUtils, write as writeCfb } from 'cfb'
import { createHwpxFromMarkdown } from '../src/main/hwpxExport.ts'

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
const bulk = ['준비서면 쟁점 정리', '제출 서류 최종안 검토', '발송할 안내 메일 작성'].join('\n')

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
    const task = { id, cwd: workspace, title, agent, status, order, due, approval: status === 'awaiting_approval' ? 'required' : 'none',
      depends_on: id.startsWith('waiting-') ? ['hold'] : [], createdAt: new Date().toISOString() }
    const front = Object.entries(task).filter(([, v]) => v !== undefined).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\n')
    await fs.writeFile(path.join(board, id + '.md'), '---\n' + front + '\n---\n' + title)
    await fs.writeFile(path.join(agentDir, agent + '.md'), '---\nname: ' + agent + '\ndescription: 검수 담당\n---\n요청한 업무를 검토합니다.\n')
  }
  await fs.writeFile(path.join(board, 'approve-a.report.md'), '## 결론\n검토용 보고서입니다.\n## 산출물 경로\n- 초안.md\n- 검토서.pdf\n- 검토의견.hwpx\n- 참고자료.docx\n')
  await fs.writeFile(path.join(board, 'approve-b.report.md'), '## 첨부 파일\n- 누락된 검토서.pdf\n')
  await fs.writeFile(path.join(board, 'approve-c.report.md'), '## 쇼츠 최종안\n제목과 썸네일을 함께 검토해 주세요.')
  await fs.writeFile(path.join(board, 'approve-a.review.md'), '준법감시 검토 완료')
  await fs.writeFile(path.join(workspace, '초안.md'), '## 발송 전 검토본\n\n안내 메일을 발송하기 전에 대상자와 첨부 목록을 확인해 주세요.')
  await fs.writeFile(path.join(workspace, '검토의견.hwpx'), createHwpxFromMarkdown(
    '# 검토의견\n\n## 검토 사항\n\n발송 전 첨부 목록과 회신 기한을 확인합니다.', '검토의견'))
  const word = cfbUtils.cfb_new()
  for (const [name, xml] of [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>참고자료의 첨부 순서를 검토합니다.</w:t></w:r></w:p></w:body></w:document>']
  ]) cfbUtils.cfb_add(word,name,Buffer.from(xml))
  await fs.writeFile(path.join(workspace, '참고자료.docx'), writeCfb(word, {type:'buffer',fileType:'zip'}))
  await fs.writeFile(path.join(formerBoard, '_배분기'), formerOwner)
  const deskReport = '## 이전 기기의 보고서\n\n사건 일정 정리를 마쳤습니다.'
  const deskReceipt = {state:'unread',digest:createHash('sha256').update(deskReport).digest('hex')}
  await fs.writeFile(path.join(formerBoard,'desk-report.md'), `---\nid: desk-report\ntitle: 이전 기기의 보고서\ncwd: '.'\nstatus: done\napproval: none\nreportReceipt: ${JSON.stringify(deskReceipt)}\n---\n사건 일정 점검`)
  await fs.writeFile(path.join(formerBoard,'desk-report.report.md'),deskReport)
  const oldTitle = '쥬리서포트 할일 점검하기'
  await fs.writeFile(path.join(formerBoard, 'legacy-todos.md'),
    `---\nid: legacy-todos\ntitle: ${oldTitle}\ncwd: '.'\napproval: required\nstatus: blocked\n---\n${oldTitle}`)
  await fs.writeFile(path.join(formerBoard, 'legacy-todos.report.md'), '## 결재 필요\n\nmcp__jurisupport__list_todos')
  const mcpTitle = '쥬리서포트 할일을 정리한다'
  const mcpLog = ['수행 시작 · 기본 에이전트', '결재 필요 · mcp__jurisupport__list_todos', '권한 확인 또는 추가 답변 필요']
    .map(text => ({ at: new Date().toISOString(), text }))
  await fs.writeFile(path.join(formerBoard, 'legacy-mcp.md'),
    `---\nid: legacy-mcp\ntitle: ${mcpTitle}\ncwd: '.'\napproval: none\nstatus: blocked\nlog: ${JSON.stringify(mcpLog)}\n---\n${mcpTitle}\n\n추가 지시\n권한 부여할테니 진행해`)
  await fs.writeFile(path.join(formerBoard, 'legacy-mcp.report.md'), '## 결재 필요\n\nmcp__jurisupport__list_todos')
  const legacyTitle = '할일 정리부터 하자.'
  const sourceHtml = '진행중사건목록_20261117.html'
  const sourceNote = '남은과제_체크리스트.md'
  const sourceChecklist = '남은과제_체크리스트_20261112.html'
  const referenceEntries = [sourceHtml, sourceChecklist, sourceNote, '_업무지시/_보고서양식.md', sourceHtml]
    .map(name => ({ at:new Date().toISOString(), text:'파일 읽음 · ' + name }))
  referenceEntries.push({at:new Date().toISOString(), text:'결재 필요 · Bash(cd /test/board-sessions && python3 -I -c "print(0)" 진행중사건목록_20261117.html)'})
  await fs.writeFile(path.join(formerBoard, 'legacy-organize.md'),
    `---\nid: legacy-organize\ntitle: ${legacyTitle}\ncwd: '.'\napproval: required\nstatus: blocked\nlog: ${JSON.stringify(referenceEntries)}\n---\n${legacyTitle}`)
  await fs.writeFile(path.join(formerBoard, 'legacy-organize.report.md'), '## 결재 필요\n\nBash(cd /test/board-sessions && python3 -I -c "print(0)" 진행중사건목록_20261117.html)')
  await fs.writeFile(path.join(formerBoardWorkspace,sourceHtml),
    '\uFEFF<!doctype html>\r\n<html lang="ko"><meta charset="utf-8"><h1>진행 중인 검토 사건</h1><p>참고 목록 7건</p>' +
    '<script>document.documentElement.dataset.fixtureExecuted = "yes"</script>' +
    '<img src="https://board-fixture.invalid/image.png"><a href="https://board-fixture.invalid/next">외부 안내 페이지</a></html>\r\n')
  await fs.writeFile(path.join(formerBoardWorkspace,sourceChecklist), '<!doctype html><meta charset="utf-8"><h1>남은 과제 목록</h1>')
  await fs.writeFile(path.join(formerBoardWorkspace,sourceNote), '\uFEFF## 다음 확인 사항\r\n\r\n첨부 자료와 일정 검토\r\n')
  await fs.writeFile(path.join(formerBoard, 'uncertain-parent.md'),
    "---\nid: uncertain-parent\ntitle: 외부 실행 확인 원 지시\ncwd: '.'\nstatus: blocked\napproval: required\nafter_approval: 합성 발송\n---\n앞선 기기의 처리 결과 확인")
  await fs.writeFile(path.join(formerBoard, 'uncertain-child.md'),
    "---\nid: uncertain-child\ntitle: 발송 여부 확인 건\ncwd: '.'\nstatus: blocked\nparentId: uncertain-parent\n---\n합성 발송")
  for (const [id, title, status] of [['legacy-blocked','이전 장치 보류 건','blocked'], ['legacy-approval','이전 장치 결재 건','awaiting_approval']]) {
    await fs.writeFile(path.join(formerBoard, id + '.md'), `---\nid: ${id}\ntitle: ${title}\ncwd: '.'\nstatus: ${status}\n---\n${title}의 원래 본문`)
    await fs.writeFile(path.join(formerBoard, id + '.report.md'), title + ' 보고서 원문')
    await fs.writeFile(path.join(formerBoard, id + '.review.md'), title + ' 검토 원문')
  }
}

// Run built main, preload, renderer and storage. The provider returns synthetic reports.
function run({ root, workspace, board, temp, home, profile, screenshot, bulk, formerBoardWorkspace, formerBoard, formerOwner }) {
  const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const downloads = path.join(temp, 'downloads')
  fs.mkdirSync(downloads,{recursive:true})
  app.setPath('downloads', downloads)
  let saveRequest = null
  dialog.showSaveDialog = async (parent, options) => {
    assert.ok(saveRequest, 'only explicitly requested downloads can open a save dialog')
    assert.equal(parent, win)
    assert.equal(path.basename(options.defaultPath), saveRequest.name)
    const { destination, cancel } = saveRequest
    saveRequest = null
    return { canceled:cancel, filePath:cancel ? '' : destination }
  }
  const external = []
  shell.openExternal = async url => { external.push(url) }
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
  const originalTodos = JSON.stringify(todoRows)
  const toolsCalled = []
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.jurisupport.com/mcp')
    assert.equal(options.headers.Authorization, 'Bearer ui-test-only')
    const rpc = JSON.parse(options.body)
    const respond = (result, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
      status, headers: { 'mcp-session-id': 'test-session' }
    })
    if (rpc.method === 'initialize' || rpc.method === 'notifications/initialized') return respond({})
    assert.equal(rpc.method, 'tools/call')
    toolsCalled.push(rpc.params.name)
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
  let holdFollowup = false
  let finishFollowup
  const followupGate = new Promise(resolve => { finishFollowup = resolve })
  const childTitle = '제출기한 확인 메모'
  const childBody = childTitle + '\n이전 검토 결과를 바탕으로 확인할 일정을 정리해 주세요.'
  const sourceFinding = '원 보고서의 검토 사항은 송달일 대조입니다.'
  const childFinding = '송달일부터 제출기한까지의 일정 확인을 별도 업무로 정리했습니다.'
  const queries = []
  const serverTools = new WeakMap()
  require.cache[sdkId].exports = { ...sdk, createSdkMcpServer(config) {
    const server = sdk.createSdkMcpServer(config)
    serverTools.set(server, config.tools)
    return server
  }, query({ options, prompt }) {
    assert.ok(options.cwd.startsWith(temp + path.sep))
    queries.push({ prompt, agent: options.agent })
    return { close() {}, async *[Symbol.asyncIterator]() {
      await gate
      if (holdFollowup) await followupGate
      let result = '## 결론\n합성 수행 보고서'
      if (prompt.includes('쥬리서포트 할일을 정리한다')) {
        const list = serverTools.get(options.mcpServers.jurisupport).find(tool => tool.name === 'list_tasks')
        const rows = JSON.stringify((await list.handler({})).content)
        assert.match(rows, /A 준비서면 제출/)
        assert.doesNotMatch(rows, /E 별건 메모 검토/)
        result = '담당자가 조회한 할일 · A 준비서면 제출'
      } else if (prompt.includes(childTitle)) result = '## 추가 업무 결과\n' + childFinding
      else if (prompt.includes('준비서면 쟁점 정리')) result += '\n' + sourceFinding + '\n\n## 산출물 경로\n- 검토의견.hwpx\n- 초안.md'
      yield { type:'result', subtype:'success', is_error:false, result }
    } }
  } }

  const history = [{ drafts: workspace, name: '시안 검증 사건', ts: Date.now() }]
  const sessions = new Map()
  let pickedFolder = workspace
  const boardMutations = []
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (key, handler) => register(key, async (event, ...args) => {
    if (['workBoard:updateTask', 'workBoard:removeTask', 'workBoard:takeOwnership', 'workBoard:addFollowUp', 'workBoard:decide'].includes(key)) boardMutations.push({key, args})
    if (key === 'window:new') {
      assert.equal(args[0]?.tabs?.length, 1)
      const viewerFiles = ['검토서.pdf','검토의견.hwpx','참고자료.docx'].map(name=>path.join(workspace,name))
      viewerFiles.push(path.join(formerBoardWorkspace,'진행중사건목록_20261117.html'))
      assert.ok(viewerFiles.some(p => fs.realpathSync(args[0].tabs[0].path) === fs.realpathSync(p)))
      return handler(event, ...args)
    }
    if (key.startsWith('workBoard:') || key.startsWith('workspace:') || ['app:info', 'tabs:ready', 'app:setWindowTitle', 'window:forceClose'].includes(key)) return handler(event, ...args)
    if (key === 'fs:readText' && [path.join(workspace, '초안.md'),path.join(formerBoardWorkspace,'진행중사건목록_20261117.html')].includes(args[0])) return handler(event, ...args)
    if (key === 'fs:readBytes' && args[0] === path.join(workspace, '검토서.pdf')) return handler(event, ...args)
    if (key === 'fs:readHwpMarkdown' && args[0] === path.join(workspace, '검토의견.hwpx')) return handler(event, ...args)
    if (key === 'fs:readDocxText' && args[0] === path.join(workspace, '참고자료.docx')) return handler(event, ...args)
    if (key === 'fs:stat' && ['초안.md','검토서.pdf','검토의견.hwpx','참고자료.docx','누락된 검토서.pdf'].some(name => args[0] === path.join(workspace,name))) return handler(event, ...args)
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
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (request, reply) => {
    if (request.url.startsWith('https://board-fixture.invalid/')) external.push(request.url)
    reply({ cancel:true })
  }))
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
  const snap = w => evaluate(`window.lt.workBoard.snapshot(${JSON.stringify(w)})`)
  const navBadge = label => evaluate(`Number([...document.querySelectorAll('.work-board-window .work-board-links button')]
    .find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('span')?.textContent || 0)`)
  const manifest = tasks => tasks.map(t=>[t.id,t.status,t.parentId ?? null,t.reportReceipt ?? null,t.followUp ?? null]).sort(([a],[b])=>a.localeCompare(b))
  const receiptState = path.join(temp,'receipts-on-restart.json')
  ;(async () => {
    await ready
    if (process.env.LT_TEST_RECEIPT_RESTART === '1') {
      const expected = JSON.parse(fs.readFileSync(receiptState,'utf8'))
      for (const [folder, tasks] of expected) {
        const loaded = await evaluate(`window.lt.workBoard.open(${JSON.stringify(folder)})`)
        assert.deepEqual(manifest(loaded.tasks),tasks,'persisted tasks/receipts and no new follow-up after restart')
      }
      const restoredBoard = await snap(workspace)
      const child = restoredBoard.tasks.find(t=>t.title===childTitle)
      const source = restoredBoard.tasks.find(t=>t.id===child?.followUp?.id)
      assert.ok(source && child.reportReceipt.state==='read' && source.reportReceipt.state==='read')
      const restoredDetail = await evaluate(`window.lt.workBoard.detail(${JSON.stringify(workspace)},${JSON.stringify(child.id)})`)
      assert.ok(restoredDetail.report.includes(childFinding) && child.followUp.report.includes(sourceFinding),'independent reports and context survive restart')
      assert.equal(queries.length,0,'restart does not execute a received report')
      assert.deepEqual(toolsCalled,[],'restart does not re-read or mutate source tasks')
      console.log('PASS 새 앱 프로세스 · 보고서 확인 기록 복구 · 추가 실행 없음')
      app.exit(0)
      return
    }
    const paper = new BrowserWindow({show:false})
    try {
      await paper.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<html lang="ko"><meta charset="utf-8"><h1>안내 메일 검토서</h1><p>문서번호 REVIEW-017</p><p>첨부 목록 확인 후 발송 일정을 결정해 주세요.</p></html>'))
      fs.writeFileSync(path.join(workspace,'검토서.pdf'), await paper.webContents.printToPDF({pageSize:'A4'}))
    } finally { paper.destroy() }
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
    await wait(async () => (await navBadge('결재함')) === 3,'approval header badge')
    // Departments are the user's own: a new board shows none until the user creates one.
    assert.equal(await evaluate("document.querySelector('.wb-org').textContent.includes('아직 부서가 없습니다')"), true)
    await click('.wb-org button', '부서 관리')
    await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b => b.textContent.includes('부서 추가'))"), 'department editor')
    await click('.wb-dialog button', '취소')
    await evaluate(`window.lt.workBoard.saveTeams(${JSON.stringify(workspace)}, [{name:'송무팀',color:'#376ac6',agents:[]}])`)
    await wait(() => evaluate("[...document.querySelectorAll('.wb-org .wb-org-lead')].some(el => el.textContent.includes('부서장 · 앱 기본 지침'))"), 'department head row')
    // The editor offers rules, the head's extra guide, per-tool levels and warning lines; bash can only ask or stay off.
    await click('.wb-org button', '부서 관리')
    await wait(() => evaluate("!!document.querySelector('.wb-dialog [aria-label=\"송무팀 도구 권한\"]')"), 'department tool levels')
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([...document.querySelectorAll('.wb-dialog [aria-label=\"송무팀 도구 권한\"] select')].map(s => [...s.options].map(o => o.value)))")),
      [['allow', 'off'], ['allow', 'off'], ['allow', 'off'], ['ask', 'off'], ['ask', 'off']])
    assert.equal(await evaluate("[...document.querySelectorAll('.wb-dialog label')].some(l => l.textContent.startsWith('부서 규칙')) && [...document.querySelectorAll('.wb-dialog label')].some(l => l.textContent.startsWith('월간 경고선'))"), true)
    fs.writeFileSync(screenshot.replace(/board\.png$/, 'departments.png'), (await win.webContents.capturePage()).toPNG())
    await click('.wb-dialog button', '취소')
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    await click('.wb-stat', '기한 임박')
    await wait(() => evaluate("document.querySelectorAll('.wb-card').length === 2"), 'filter due cards')
    await click('.work-board-window .work-board-links button', '결재함')
    await click('.wb-page .wb-card', '안내 메일 발송 설계')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('준법감시 검토 완료')"), 'report and review')
    const decisionReason = '검토서의 첨부 목록을 보완해 주세요.'
    await evaluate(`(() => {
      const input = document.querySelector('.wb-dialog .wb-form textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, ${JSON.stringify(decisionReason)})
      input.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
    const cardIntact = async () => {
      const state = await evaluate(`(() => {
        const dialog = document.querySelector('.wb-dialog[open]')
        return { title:dialog?.getAttribute('aria-label'), reason:dialog?.querySelector('.wb-form textarea')?.value,
          actions:[...dialog?.querySelectorAll('.wb-form button') || []].filter(b=>!b.disabled).map(b=>b.textContent.trim()) }
      })()`)
      assert.equal(state.title, '안내 메일 발송 설계')
      assert.equal(state.reason, decisionReason)
      for (const label of ['최종안 승인','반려','수정 요청']) assert.ok(state.actions.includes(label), label)
    }
    await click('.wb-target-documents button', '초안.md 열기')
    await wait(() => evaluate("document.querySelector('.wb-artifact h2')?.textContent === '발송 전 검토본'"), 'read rendered Markdown draft')
    await cardIntact()
    fs.writeFileSync(path.join(path.dirname(screenshot),'approval-target-documents.png'), (await win.webContents.capturePage()).toPNG())
    const pdfRendered = `!!document.querySelector('.pdf-page canvas') &&
      document.querySelector('.textLayer')?.dataset.pdfPath?.normalize('NFC') === ${JSON.stringify(path.join(workspace,'검토서.pdf').normalize('NFC'))} &&
      document.querySelector('.textLayer')?.textContent.includes('REVIEW-017')`
    for (const [filename, rendered] of [
      ['검토서.pdf',pdfRendered],
      ['검토의견.hwpx', "document.querySelector('.shell-doconly pre')?.textContent.includes('발송 전 첨부 목록과 회신 기한을 확인합니다.')"],
      ['참고자료.docx', "document.querySelector('.shell-doconly pre')?.textContent.includes('참고자료의 첨부 순서를 검토합니다.')"]
    ]) {
      await click('.wb-target-documents button', filename + ' 열기')
      let viewer
      await wait(() => {
        viewer = BrowserWindow.getAllWindows().find(w => w !== win)
        return viewer && viewer.webContents.getURL().includes('#docOnly')
      }, 'separate viewer for ' + filename)
      await wait(() => viewer.webContents.executeJavaScript(rendered), 'actual document contents: ' + filename)
      await viewer.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const extension = path.extname(filename).slice(1)
      fs.writeFileSync(path.join(path.dirname(screenshot),'approval-' + extension + '-viewer.png'), (await viewer.webContents.capturePage()).toPNG())
      await cardIntact()
      viewer.close()
      await wait(() => viewer.isDestroyed(), 'detached viewer closed: ' + filename)
      await cardIntact()
    }
    const [reviewWidth, reviewHeight] = win.getContentSize()
    win.setContentSize(reviewWidth, Math.max(950,reviewHeight))
    await evaluate(`(async () => {
      document.querySelector('.wb-dialog').scrollTop = 0
      const button = [...document.querySelectorAll('.wb-dialog .wb-form button')].find(b=>b.textContent.trim()==='최종안 승인')
      button.scrollIntoView({block:'nearest'})
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })()`)
    fs.writeFileSync(path.join(path.dirname(screenshot),'approval-after-reading.png'), (await win.webContents.capturePage()).toPNG())
    win.setContentSize(reviewWidth,reviewHeight)
    await click('.wb-dialog button', '반려')
    await wait(async () => {
      const snap = await evaluate(`window.lt.workBoard.snapshot(${JSON.stringify(workspace)})`)
      return snap.tasks.some(t => t.id === 'approve-a' && t.status === 'rejected' && t.log.some(entry=>entry.text.includes(decisionReason)))
    }, 'reject with the reason entered before opening documents')
    await wait(async () => (await navBadge('결재함')) === 2,'decision decrements approval badge')
    await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'rejected card closed')
    await click('.wb-page .wb-card', '판결 보도자료 초안')
    await click('.wb-target-documents button', '누락된 검토서.pdf 열기')
    await wait(() => evaluate("document.querySelector('.wb-target-documents [role=alert]')?.textContent.includes('「누락된 검토서.pdf」 파일을 찾을 수 없습니다.')"), 'named missing attachment error')
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'missing file does not open an empty viewer')
    assert.equal(await evaluate("document.querySelector('.wb-dialog[open]').getAttribute('aria-label')"), '판결 보도자료 초안')
    await click('.wb-dialog button', '닫기')
    console.log('PASS 결재 대상 문서 · Markdown 본문 · PDF/HWPX/DOCX 문서 창 · 누락 오류 · 반려 사유 유지')
    await evaluate("document.querySelector('.work-board-window button[aria-label=\"작업 공간으로 돌아가기\"]').click()")
    await evaluate(`(() => { const input = [...document.querySelectorAll('.agent-composer textarea')].find(el=>el.offsetWidth)
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, ${JSON.stringify(bulk)})
      input.dispatchEvent(new Event('input', {bubbles:true})) })()`)
    // "부서에 맡기기" sends the whole text as one instruction and waits for a department or the chief of staff.
    await click('.agent-composer button', '부서에 맡기기')
    await wait(() => evaluate("document.querySelectorAll('.wb-dialog .wb-draft').length === 1"), 'one department instruction')
    assert.equal(await evaluate("document.querySelector('.wb-dialog .wb-draft textarea').value"), bulk.trim())
    assert.equal(await evaluate("document.querySelector('.wb-dialog .wb-primary').disabled"), true, 'a department must be chosen')
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([...[...document.querySelectorAll('.wb-draft label')].find(el=>el.textContent.trim().startsWith('담당')).querySelector('select').options].map(o=>o.value).filter(v=>v==='chief'||v.startsWith('team:')))")),
      ['chief', 'team:송무팀'])
    await click('.wb-dialog button', '닫기')
    await evaluate("document.querySelector('.work-board-window button[aria-label=\"작업 공간으로 돌아가기\"]').click()")
    await click('.agent-composer button', '일괄 지시')
    await visible('.wb-dialog textarea')
    assert.equal(await evaluate("document.querySelector('.wb-dialog textarea').value"), bulk)
    await click('.wb-dialog button', '지시 내용 확인')
    assert.equal(await evaluate("document.querySelectorAll('.wb-draft').length"), 3)
    await evaluate(`(() => {
      const drafts = [...document.querySelectorAll('.wb-draft')]
      const field = (d,label) => [...d.querySelectorAll('label')].find(el=>el.textContent.trim().startsWith(label)).querySelector('select')
      const set = (select,value) => { select.value=value; select.dispatchEvent(new Event('change',{bubbles:true})) }
      for (const draft of drafts) {
        const choice = field(draft,'업무 결과')
        if (!choice.offsetWidth || choice.value !== 'report') throw Error('새 지시는 보이는 업무 결과 선택란에서 보고서 받기로 시작해야 합니다.')
      }
      set(field(drafts[0],'담당'),'compliance')
      set(field(drafts[1],'업무 결과'),'final')
      set(field(drafts[2],'업무 결과'),'action')
    })()`)
    await wait(() => evaluate("document.querySelector('.wb-dialog .wb-primary').disabled"), 'action requires a defined follow-up')
    await evaluate(`(() => {
      const field = [...document.querySelectorAll('.wb-draft label')].find(el=>el.textContent.trim().startsWith('승인 후 실행할 지시')).querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field, '검토된 합성 안내 메일을 발송해 주세요.')
      field.dispatchEvent(new Event('input',{bubbles:true}))
      const tools = [...document.querySelectorAll('.wb-draft label')].find(el=>el.textContent.trim().startsWith('승인 후 허용할 도구')).querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(tools, 'mcp__fixture_mail__send_message')
      tools.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
    await click('.wb-dialog button', '3건 등록')
    await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'three instructions submitted')
    release()
    await wait(() => fs.readdirSync(board).filter(s=>/\.report\.md$/.test(s) && fs.readFileSync(path.join(board,s),'utf8').includes('합성 수행 보고서')).length === 7, 'seven reports persisted')
    assert.ok(queries.find(q=>q.agent === 'compliance' && q.prompt.includes('준비서면 쟁점 정리')))
    const [reportTitle, finalTitle, actionTitle] = bulk.split('\n')
    const row = async title => (await snap(workspace)).tasks.find(t=>t.title===title)
    await wait(async () => (await row(reportTitle))?.reportReceipt?.state==='unread' &&
      (await row(finalTitle))?.status==='awaiting_approval' && (await row(actionTitle))?.status==='awaiting_approval', 'three requested delivery modes')
    await wait(async () => await navBadge('결재함') === 4 && await navBadge('보고서함') === 5, 'report and approval badges count independent queues')
    await click('.work-board-window .work-board-links button','보고서함')
    await wait(() => evaluate(`document.querySelector('.wb-page')?.innerText.includes(${JSON.stringify(reportTitle)})`),'report inbox available')
    assert.ok(!await evaluate(`document.querySelector('.wb-page').innerText.includes(${JSON.stringify(actionTitle)})`))
    await click('.wb-page .wb-card',reportTitle)
    await click('.wb-dialog button','검토의견.hwpx 열기')
    let reportWindow
    await wait(async () => {
      reportWindow = BrowserWindow.getAllWindows().find(w => w !== win)
      return reportWindow?.webContents.getURL().includes('#docOnly') &&
        await reportWindow.webContents.executeJavaScript("document.querySelector('.shell-doconly pre')?.textContent.includes('발송 전 첨부 목록과 회신 기한을 확인합니다.')")
    },'real office document opens from report inbox')
    reportWindow.close()
    await wait(() => reportWindow.isDestroyed(),'office document closed')
    assert.equal(await evaluate("document.querySelector('.wb-dialog[open]')?.getAttribute('aria-label')"),reportTitle)
    assert.equal((await row(reportTitle)).reportReceipt.state,'unread','opening a document does not acknowledge receipt')
    const source = await row(reportTitle)
    const sourceReportFile = path.join(board,source.id + '.report.md')
    const sourceReport = fs.readFileSync(sourceReportFile,'utf8')
    const beforeFollowup = (await snap(workspace)).tasks.length
    await click('.wb-dialog button','추가 업무 지시')
    const followForm = 'dialog[open][aria-label="추가 업무 지시"]'
    await visible(followForm + ' textarea')
    await evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(followForm)})
      const options = form.querySelector('details.wb-draft-options')
      if (!options || options.open || !options.querySelector('summary')?.textContent.includes('보고서 받기')) throw Error('후속 지시의 기본값은 보고서 받기입니다.')
      const input = form.querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(childBody)})
      input.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
    await wait(() => evaluate(`[...document.querySelectorAll(${JSON.stringify(followForm + ' button')})].some(b => !b.disabled && b.textContent.includes('추가 지시 등록'))`),'additional instruction ready')
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(path.dirname(screenshot),'followup-entry.png'),(await win.webContents.capturePage()).toPNG())
    await evaluate(`(() => {
      const submit = [...document.querySelectorAll(${JSON.stringify(followForm + ' button')})].find(b=>b.textContent.includes('추가 지시 등록'))
      submit.click()
      submit.click()
    })()`)
    await wait(() => evaluate(`!document.querySelector(${JSON.stringify(followForm)})`),'extra instruction registered')
    await wait(async () => (await row(childTitle))?.reportReceipt?.state==='unread','separate job produces its own report')
    const childTask = await row(childTitle)
    const registration = boardMutations.find(m=>m.key==='workBoard:addFollowUp')
    assert.ok(registration)
    assert.equal(await evaluate(`window.lt.workBoard.addFollowUp(...${JSON.stringify(registration.args)})`),childTask.id,'replayed registration returns original child')
    assert.equal((await snap(workspace)).tasks.length,beforeFollowup + 1,'double click and replay create a single task')
    assert.equal(childTask.body,childBody)
    assert.equal(childTask.approval,'none')
    assert.ok(!childTask.parentId && !childTask.after_approval && !childTask.allowed_tools?.length && !childTask.depends_on?.length)
    assert.deepEqual(childTask.followUp,{id:source.id, title:source.title, body:source.body, report:sourceReport})
    assert.equal(childTask.cwd,source.cwd)
    assert.deepEqual((await row(reportTitle)).reportReceipt,source.reportReceipt,'creation leaves unread source receipt intact')
    assert.equal(fs.readFileSync(sourceReportFile,'utf8'),sourceReport)
    const runs = queries.filter(q=>q.prompt.includes(childTitle))
    assert.equal(runs.length,1)
    assert.ok(runs[0].prompt.includes(sourceFinding) && runs[0].prompt.includes(source.title) && runs[0].prompt.includes(childBody))
    assert.ok(!runs[0].prompt.includes('12월 블로그·쇼츠 편집 캘린더'),'unrelated workspace instructions stay outside follow-up context')
    await click('.wb-followups button',childTitle)
    await visible('dialog[aria-label="' + childTitle + '"][open]')
    await wait(()=>evaluate(`document.querySelector('.wb-report-preview')?.innerText.includes(${JSON.stringify(childFinding)})`),'child shows only own result')
    assert.ok(!await evaluate(`document.querySelector('.wb-report-preview').innerText.includes(${JSON.stringify(sourceFinding)})`))
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(path.dirname(screenshot),'followup-result.png'),(await win.webContents.capturePage()).toPNG())
    await click('.wb-dialog button','원 지시 · ' + reportTitle)
    await wait(()=>evaluate(`document.querySelector('.wb-report-preview')?.innerText.includes(${JSON.stringify(sourceFinding)})`),'return to original report')
    assert.equal((await row(reportTitle)).reportReceipt.state,'unread')
    await evaluate(`(async () => {
      const linked = document.querySelector('.wb-dialog .wb-followups')
      linked.scrollIntoView({block:'nearest'})
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    })()`)
    fs.writeFileSync(path.join(path.dirname(screenshot),'followup-linked-report.png'),(await win.webContents.capturePage()).toPNG())
    await click('.wb-followups button',childTitle)
    await confirmReceipt(workspace,childTask.id)
    assert.equal((await row(reportTitle)).reportReceipt.state,'unread','receiving child does not receive source')
    await click('.wb-dialog button','원 지시 · ' + reportTitle)
    await confirmReceipt(workspace,(await row(reportTitle)).id)
    await wait(async () => await navBadge('결재함') === 4 && await navBadge('보고서함') === 4, 'ack reduces only report badge')
    await dismissReceipt()
    await click('.work-board-window .work-board-links button','결재함')
    assert.ok(!await evaluate(`document.querySelector('.wb-page').innerText.includes(${JSON.stringify(reportTitle)})`))
    await click('.wb-page .wb-card',finalTitle)
    await click('.wb-dialog button','최종안 승인')
    await wait(async () => (await row(finalTitle)).status==='done','final document approved')
    const finalId = (await row(finalTitle)).id
    assert.ok(!(await snap(workspace)).tasks.some(t=>t.parentId===finalId),'final document approval does not perform an external action')
    await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'final decision closed')
    await click('.wb-page .wb-card',actionTitle)
    await visible('.wb-dialog[open]')
    const actionId = (await row(actionTitle)).id
    assert.ok(!(await snap(workspace)).tasks.some(t=>t.parentId===actionId),'execution waits for explicit authorization')
    await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='승인하고 발송 요청' && !b.disabled)"), 'decision names the follow-up')
    await wait(async () => await navBadge('결재함') === 3,'approval badges settle after final decision')
    await evaluate("document.querySelector('.wb-dialog .wb-primary').scrollIntoView({block:'nearest'})")
    fs.writeFileSync(path.join(path.dirname(screenshot),'delivery-action-decision.png'),(await win.webContents.capturePage()).toPNG())
    holdFollowup = true
    await click('.wb-dialog button','승인하고 발송 요청')
    await wait(async () => (await row(actionTitle)).status === 'approved' &&
      (await snap(workspace)).tasks.some(t=>t.parentId===actionId && t.status==='running'),'authorization requests execution, not completion')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.innerText.includes('승인됨 · 실행 결과 대기')"), 'action waiting state visible')
    fs.writeFileSync(path.join(path.dirname(screenshot),'delivery-execution-requested.png'),(await win.webContents.capturePage()).toPNG())
    holdFollowup = false
    finishFollowup()
    await wait(async () => (await row(actionTitle)).status==='done','authorized synthetic follow-up finished')
    assert.deepEqual((await snap(workspace)).tasks.filter(t=>t.parentId===actionId).map(t=>t.status),['done'],'exactly one authorized follow-up')
    assert.equal(await evaluate("document.querySelector('.wb-dialog[open]')?.getAttribute('aria-label')"),actionTitle,'external decision remains available for following its execution')
    await dismissReceipt()
    await click('.work-board-window .work-board-links button', '일일 보고')
    await click('.wb-page button', '오늘 보고서 저장')
    await wait(() => fs.existsSync(path.join(board,'_일일보고')) && fs.readdirSync(path.join(board,'_일일보고')).some(name=>name.endsWith('.html')), 'daily HTML')
    const providerRuns = queries.length
    async function dismissReceipt() {
      if (await evaluate("!!document.querySelector('.wb-dialog[open]')")) await click('.wb-dialog button','닫기')
      await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"),'receipt detail closed')
    }
    async function confirmReceipt(folder,id) {
      const before = (await snap(folder)).tasks
      const executions = queries.length
      const reads = toolsCalled.length
      await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='보고서 확인' && !b.disabled)"),'receipt acknowledgement available')
      const buttons = await evaluate("[...document.querySelectorAll('.wb-dialog button')].map(b=>b.textContent.trim())")
      assert.ok(!buttons.some(b=>['승인','최종안 승인','반려','수정 요청'].includes(b) || b.startsWith('승인하고')), 'reports are acknowledged, never approved')
      await click('.wb-dialog button','보고서 확인')
      await wait(async () => (await snap(folder)).tasks.find(t=>t.id===id)?.reportReceipt?.state==='read','acknowledgement persisted')
      const after = (await snap(folder)).tasks
      assert.deepEqual(after.map(t=>t.id).sort(), before.map(t=>t.id).sort(), 'receipt does not create any task')
      assert.ok(!after.some(t=>t.parentId===id) && after.find(t=>t.id===id).status==='done')
      assert.equal(queries.length,executions)
      assert.equal(toolsCalled.length,reads,'no source operation during receipt')
    }
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
      await click('.wb-dialog button', '지시 내용 확인')
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
      assert.ok(await evaluate("[...document.querySelectorAll('.wb-draft label')].find(el=>el.textContent.trim().startsWith('업무 결과'))?.querySelector('select')?.value === 'report'"),'native todo review defaults to report only')
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
      await click('.work-board-window .work-board-links button', expectedStatus === 'done' ? '보고서함' : '업무 보드')
      await click('.wb-card', title)
      const report = fs.readFileSync(path.join(board, task.id + '.report.md'), 'utf8')
      if (expectedStatus === 'blocked') {
        await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('권한')"), 'read failure displayed')
      } else {
        await wait(() => evaluate("!!document.querySelector('.wb-dialog .wb-todo-report')?.textContent.trim()"), 'report rendered')
        assert.equal(task.reportReceipt?.state,'unread')
        assert.equal(task.approval,'none')
        assert.ok(await evaluate("!!document.querySelector('.wb-report-preview .wb-todo-report')"), 'report body is directly readable without attachments')
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
      if (expectedStatus === 'done') {
        if (choice === 'case:case-a') {
          await wait(async () => await navBadge('보고서함') === (await snap(workspace)).tasks.filter(t=>t.reportReceipt?.state==='unread').length, 'inbox badge settled')
          const [width,height] = win.getContentSize()
          win.setContentSize(width,Math.max(height,950))
          await evaluate(`(async () => {
            document.querySelector('.wb-dialog').scrollTop = 0
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
          })()`)
          fs.writeFileSync(path.join(path.dirname(screenshot),'report-receipt.png'),(await win.webContents.capturePage()).toPNG())
          win.setContentSize(width,height)
        }
        await confirmReceipt(workspace,task.id)
      }
      await dismissReceipt()
      if (expectedStatus === 'done') await click('.work-board-window .work-board-links button','업무 보드')
      return report
    }
    const scoped = await review('사건 미완료 목록', 'case:case-a', 'done')
    for (const value of ['미완료 할일 3건', '기한 초과 1건', '기한 임박 2건', '담당자 미지정 1건', 'A 준비서면 제출', 'B 의뢰인 면담', 'D 자정 후 기한']) assert.ok(scoped.includes(value), value)
    const midnightRow = scoped.split('\n').find(line => line.includes('D 자정 후 기한'))
    assert.ok(midnightRow.includes(today) && !midnightRow.includes('기한 초과'), 'UTC 15:30 belongs to today in Seoul')
    assert.doesNotMatch(scoped, /별건 메모|종료한 지시|F 기한 없는 점검/)
    const all = await review('전체 미완료 목록', 'all', 'done')
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
    const empty = await review('빈 사건 확인', 'pinned', 'done')
    assert.match(empty, /미완료 할일 0건/)
    await click('.wb-card', '연결 확인')
    await wait(() => evaluate("document.querySelector('.wb-recovery')?.innerText.includes('할일을 다시 조회하세요')"), 'linked case already has a scope')
    assert.ok(await evaluate("document.querySelector('.wb-recovery').textContent.includes('case-a') && !document.querySelector('.wb-recovery select')"))
    assert.ok(await evaluate("[...document.querySelectorAll('.wb-recovery button')].some(b=>b.textContent.trim()==='할일 다시 조회' && !b.disabled)"))
    await click('.wb-dialog button', '닫기')
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
    await click('.work-board-window .work-board-links button','보고서함')
    await click('.wb-page .wb-card','이전 기기의 보고서')
    await confirmReceipt(formerBoardWorkspace,'desk-report')
    assert.equal((await shared()).readOnly,true,'shared report receipt does not move execution ownership')
    assert.equal(fs.readFileSync(path.join(formerBoard,'_배분기'),'utf8'),formerOwner)
    await dismissReceipt()
    await click('.work-board-window .work-board-links button','업무 보드')
    await click('.wb-card', '이전 장치 결재 건')
    await wait(() => evaluate("document.querySelector('.wb-dialog')?.textContent.includes('결재 건 보고서 원문')"), 'read original report')
    assert.equal(await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='최종안 승인' && !b.disabled)"), false)
    await click('.wb-dialog button', '닫기')
    await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'close read-only detail')
    await click('.wb-card', '이전 장치 보류 건')
    await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='이 PC에서 관리')"), 'read-only recovery offers management')
    assert.ok(!await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.trim()==='다시 실행' && !b.disabled)"))
    await click('.wb-dialog button', '닫기')
    await click('.work-board button', '이 PC에서 관리')
    const confirmDialog = name => 'dialog[aria-label="' + name + '"] button'
    await visible('dialog[aria-label="관리 기기 변경"]')
    fs.writeFileSync(path.join(path.dirname(screenshot), 'handoff.png'), (await win.webContents.capturePage()).toPNG())
    assert.equal(fs.readFileSync(path.join(formerBoard,'_배분기'),'utf8'), formerOwner)
    await click(confirmDialog('관리 기기 변경'), '관리 기기 변경')
    await wait(async () => !(await shared()).readOnly, 'new owner accepted')
    assert.notEqual(fs.readFileSync(path.join(formerBoard,'_배분기'),'utf8'), formerOwner)
    await click('.wb-card', '외부 실행 확인 원 지시')
    await wait(() => evaluate("document.querySelector('.wb-recovery')?.innerText.includes('승인 후 실행 결과를 확인하세요')"), 'parent directs the owner to its unresolved action')
    await click('.wb-recovery button', '발송 여부 확인 건 · 결과 확인')
    await visible('dialog[aria-label="발송 여부 확인 건"][open]')
    await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>b.textContent.includes('미실행 확인'))"), 'uncertain child offers reconciliation')
    const reconcileActions = await evaluate("[...document.querySelectorAll('.wb-dialog button')].filter(b=>b.textContent.includes('미실행 확인') || b.textContent.includes('실행 확인 · 완료 처리')).map(b=>b.disabled)")
    assert.deepEqual(reconcileActions,[true,true], 'uncertain external outcome requires a reason before choosing either result')
    assert.ok(!await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(b=>['다시 실행','할일 다시 조회'].includes(b.textContent.trim()))"), 'no repeat execution of uncertain side effects')
    await evaluate(`(() => {
      const input = document.querySelector('.wb-dialog textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'합성 발송 기록에서 미실행 확인')
      input.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
    await click('.wb-dialog button','미실행 확인 · 결재함으로')
    await wait(async () => {
      const {tasks} = await shared()
      return tasks.some(t=>t.id==='uncertain-child' && t.status==='rejected') &&
        tasks.some(t=>t.id==='uncertain-parent' && t.status==='awaiting_approval')
    }, 'uncertain action goes to approval without executing')
    await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'reconciliation closed')
    await click('.wb-card', '이전 장치 보류 건')
    await wait(() => evaluate("[...document.querySelectorAll('.wb-recovery button')].some(b=>b.textContent.trim()==='다시 실행' && !b.disabled)"), 'ordinary instruction has a retry')
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
    await click('.wb-dialog button', '최종안 승인')
    await wait(async () => (await shared()).tasks.some(t=>t.id==='legacy-approval' && ['approved','done'].includes(t.status)), 'new owner can approve')
    assert.equal(queries.length, providerRuns, 'takeover does not execute approved or blocked work again')
    // A synced pre-native todo card has a permission marker but no business report.
    listMode = 'rows'
    async function saveFromCard(selector, buttonText, source, cancel = false) {
      const name = path.basename(source)
      const destination = path.join(downloads, name)
      const original = fs.readFileSync(source)
      saveRequest = {name,destination,cancel}
      await click(selector, buttonText)
      await wait(() => !saveRequest, 'native save dialog: ' + name)
      if (cancel) {
        await wait(() => evaluate("document.querySelector('.wb-dialog')?.innerText.includes('다운로드를 취소했습니다.')"), 'cancel acknowledged')
        assert.equal(fs.existsSync(destination),false,'cancel creates no file')
      } else {
        await wait(() => fs.existsSync(destination) && fs.readFileSync(destination).equals(original), 'download preserves bytes: ' + name)
      }
    }
    async function verifyReadReferences(oldTitle) {
      const htmlName = '진행중사건목록_20261117.html'
      const mdName = '남은과제_체크리스트.md'
      const section = '.wb-reference-documents'
      await visible(section)
      const referenceText = await evaluate("document.querySelector('.wb-reference-documents').innerText")
      for (const name of [htmlName, mdName, '남은과제_체크리스트_20261112.html']) assert.ok(referenceText.includes(name), name)
      assert.ok(!referenceText.includes('_보고서양식') && !referenceText.includes('_업무지시'))
      assert.equal(await evaluate("document.querySelectorAll('.wb-reference-documents button[aria-pressed]').length"),3,'only three distinct business source files')
      assert.ok(await evaluate("document.querySelector('.wb-dialog section') === document.querySelector('.wb-recovery')"), 'recovery action is above references')
      assert.ok(!await evaluate("document.querySelector('.wb-dialog').innerText.includes('Bash(')"), 'raw command hidden by default')
      fs.writeFileSync(path.join(path.dirname(screenshot),'legacy-reference-documents.png'), (await win.webContents.capturePage()).toPNG())
      assert.equal(await evaluate("!!document.querySelector('.wb-target-documents, .wb-reference-documents .wb-artifact')"),false,'sources appear as unopened references')
      const headings = await evaluate("[...document.querySelectorAll('.wb-dialog summary')].map(el=>el.textContent.trim())")
      assert.ok(headings.includes('도구 권한 기록 (1)') && headings.includes('결재 이력 (0)'), 'a denied tool is not an approval')

      const source = path.join(formerBoardWorkspace,htmlName)
      const downloadButton = name => section + ' button[aria-label="' + name + ' 다운로드"]'
      await saveFromCard(downloadButton(htmlName),'',source,true)
      await saveFromCard(downloadButton(htmlName),'',source)
      await click(section + ' button',htmlName + ' 열기')
      let viewer
      await wait(() => {
        viewer = BrowserWindow.getAllWindows().find(w=>w!==win)
        return viewer?.webContents.getURL().endsWith('#docOnly/board-html')
      }, 'offline HTML reference viewer')
      await wait(() => viewer.webContents.executeJavaScript("document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('참고 목록 7건')"), 'original HTML content')
      const viewed = await viewer.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector('iframe')
        const doc = frame.contentDocument
        const link = [...doc.querySelectorAll('a')].find(a => a.textContent.includes('외부 안내 페이지'))
        link?.click()
        return { script:doc.documentElement.dataset.fixtureExecuted || '', scriptsAllowed:frame.sandbox.contains('allow-scripts'),
          browserButton:[...document.querySelectorAll('button')].some(b=>b.textContent.includes('브라우저로 열기')) }
      })()`)
      assert.deepEqual(viewed,{script:'',scriptsAllowed:false,browserButton:false})
      assert.ok(await viewer.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('참고 목록 7건')))))"))
      assert.deepEqual(external,[],'no external load, link opening, or navigation from an HTML reference')
      fs.writeFileSync(path.join(path.dirname(screenshot),'reference-html-viewer.png'), (await viewer.webContents.capturePage()).toPNG())
      viewer.close()
      await wait(() => viewer.isDestroyed(),'HTML viewer closed')
      assert.equal(await evaluate("document.querySelector('.wb-dialog[open]').getAttribute('aria-label')"),oldTitle)
      await click(section + ' button',mdName + ' 열기')
      await wait(() => evaluate("document.querySelector('.wb-reference-documents .wb-artifact')?.textContent.includes('첨부 자료와 일정 검토')"),'open Markdown source')
      await saveFromCard(downloadButton(mdName),'',path.join(formerBoardWorkspace,mdName))
    }
    for (const [id,oldTitle] of [['legacy-todos','쥬리서포트 할일 점검하기'], ['legacy-organize','할일 정리부터 하자.']]) {
      const readsBeforeRetry = taskReads.length
      await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'previous approval dialog closed')
      await click('.wb-card', oldTitle)
      await visible('dialog[aria-label="' + oldTitle + '"][open]')
      const action = '.wb-recovery button'
      await wait(() => evaluate("document.querySelector('.wb-recovery')?.innerText.includes('조회할 할일을 선택하세요')"), 'unbound recovery prompts for scope')
      await visible('.wb-recovery option[value="case:case-a"]')
      assert.equal(await evaluate("document.querySelector('.wb-dialog section') === document.querySelector('.wb-recovery')"),true)
      assert.equal(await evaluate("!!document.querySelector('.wb-dialog .wb-report-preview')"),false,'no placeholder report above recovery')
      const diagnostic = id === 'legacy-todos' ? 'mcp__jurisupport__list_todos' : 'Bash('
      assert.ok(await evaluate(`[...document.querySelectorAll('.wb-dialog details:not([open])')].some(el=>el.textContent.includes(${JSON.stringify(diagnostic)}))`), 'stopped tool details initially collapsed')
      const closedSummaries = await evaluate("[...document.querySelectorAll('.wb-dialog details:not([open]) > summary')].map(el=>el.textContent.trim())")
      assert.ok(closedSummaries.includes('중단 사유 자세히') && closedSummaries.includes('메모 추가'), 'diagnostic and optional memo initially collapsed')
      assert.ok(await evaluate("!!document.querySelector('.wb-recovery details:not([open]) textarea')"), 'optional memo initially collapsed')
      assert.equal(await evaluate("[...document.querySelectorAll('.wb-recovery .wb-primary')].map(b=>b.textContent.trim()).join()"),'할일 다시 조회','one primary retry action')
      assert.equal(await evaluate("document.querySelector('.wb-recovery select').value"), '')
      assert.ok(await evaluate("!document.querySelector('.wb-recovery .wb-primary').disabled"))
      assert.ok(!await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(el=>['현재 보고서로 결재 요청','최종안 승인','보고서 확인','보고서 다운로드'].includes(el.textContent.trim()))"))
      if (id === 'legacy-organize') await verifyReadReferences(oldTitle)
      else fs.writeFileSync(path.join(path.dirname(screenshot), 'legacy-todo-blocked.png'), (await win.webContents.capturePage()).toPNG())
      await click(action, '할일 다시 조회')
      assert.ok(await evaluate("document.activeElement === document.querySelector('.wb-recovery select:invalid')"), 'required selector receives focus')
      assert.equal(taskReads.length, readsBeforeRetry, 'invalid submit causes no lookup')
      assert.equal((await shared()).tasks.find(t=>t.id===id).status,'blocked')
      await evaluate(`(() => {
        window.recoveryDialog = document.querySelector('.wb-dialog[open]')
        const scope = document.querySelector('.wb-recovery select')
        scope.value = 'case:case-a'; scope.dispatchEvent(new Event('change', {bubbles:true}))
      })()`)
      await wait(() => evaluate("document.querySelector('.wb-recovery')?.innerText.includes('할일을 다시 조회하세요')"), 'scope confirmed; same retry button')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      if (id === 'legacy-organize') fs.writeFileSync(path.join(path.dirname(screenshot), 'recovery-scope-ready.png'), (await win.webContents.capturePage()).toPNG())
      assert.equal(taskReads.length, readsBeforeRetry, 'selecting scope does not start lookup')
      await click(action, '할일 다시 조회')
      const oldTask = async () => (await shared()).tasks.find(t=>t.id===id)
      await wait(async () => (await oldTask())?.reportReceipt?.state==='unread', 'native retry delivers unread report')
      assert.deepEqual(taskReads.slice(readsBeforeRetry), [{ type:'todo', includeClosed:false, fields:'compact', page:1, limit:100, caseId:'case-a' }])
      assert.equal(queries.length, providerRuns, 'no generic agent for the original Korean request')
      await wait(() => evaluate("document.querySelector('.wb-report-preview table')?.textContent.includes('A 준비서면 제출')"), 'report appears without closing or reopening')
      assert.ok(await evaluate("document.querySelector('.wb-dialog[open]') === window.recoveryDialog"), 'same open dialog now shows report')
      assert.ok(!await evaluate("!!document.querySelector('.wb-recovery')"), 'retry controls clear on success')
      const result = await evaluate("document.querySelector('.wb-report-preview').innerText")
      assert.match(result,/미완료 할일 3건/)
      assert.doesNotMatch(result,/mcp__jurisupport__list_todos|E 별건/)
      const refreshedReport = fs.readFileSync(path.join(formerBoard,id + '.report.md'),'utf8')
      assert.match(refreshedReport,/미완료 할일 3건/)
      assert.doesNotMatch(refreshedReport,/mcp__jurisupport__list_todos/)
      assert.equal(await evaluate(`(() => {
        const preview = document.querySelector('.wb-dialog .wb-report-preview')
        const folds = [...document.querySelectorAll('.wb-dialog details')].filter(el => /^(진행 로그|지시 본문|결재 이력)/.test(el.querySelector('summary')?.textContent.trim()))
        return folds.length === 3 && folds.every(el => !el.open && !!(preview.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
      })()`),true,'report precedes collapsed logs, instructions and decisions')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const reportScreenshot = id === 'legacy-todos' ? 'legacy-todo-report.png' : 'recovery-report-ready.png'
      fs.writeFileSync(path.join(path.dirname(screenshot), reportScreenshot), (await win.webContents.capturePage()).toPNG())
      if (id === 'legacy-todos') {
        await saveFromCard('.wb-report-preview button','보고서 다운로드',path.join(formerBoard,id + '.report.md'))
      }
      await confirmReceipt(formerBoardWorkspace,id)
      await dismissReceipt()
    }
    await click('.wb-card', '쥬리서포트 할일을 정리한다')
    await visible('.wb-recovery option[value="case:case-a"]')
    assert.equal(await evaluate("document.querySelector('.wb-recovery select').value"), '')
    assert.equal(await evaluate("!!document.querySelector('.wb-recovery textarea')"), false)
    const readsBeforeGrant = taskReads.length
    assert.ok(await evaluate("document.querySelector('.wb-recovery button[type=submit]').disabled"))
    assert.equal(taskReads.length, readsBeforeGrant)
    await evaluate(`(() => {
      const scope = document.querySelector('.wb-recovery select')
      scope.value = 'case:case-a'; scope.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await wait(() => evaluate("!document.querySelector('.wb-recovery button[type=submit]').disabled"), 'grant becomes available for selected scope')
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(path.dirname(screenshot), 'mcp-read-permission.png'), (await win.webContents.capturePage()).toPNG())
    await click('.wb-recovery button', '조회 허용하고 다시 실행')
    await wait(() => evaluate("document.querySelector('.wb-report-preview')?.innerText.includes('담당자가 조회한 할일 · A 준비서면 제출')"), 'agent receives scoped MCP results and delivers report in same card')
    assert.ok(await evaluate("[...document.querySelectorAll('.wb-detail-history details')].some(d=>d.querySelector('summary')?.textContent.startsWith('도구 권한 기록') && d.textContent.includes('JuriSupport 할일 조회 허용'))"))
    const grants = boardMutations.filter(m=>m.key==='workBoard:decide' && m.args[2]==='allowTodoRead')
    assert.equal(grants.length, 1)
    assert.deepEqual(grants[0].args.slice(0,4), [formerBoardWorkspace, 'legacy-mcp', 'allowTodoRead', ''])
    assert.ok(grants[0].args[4])
    assert.deepEqual(grants[0].args[5], {kind:'case',caseId:'case-a'})
    assert.deepEqual(taskReads.slice(readsBeforeGrant).map(args=>args.caseId), ['case-a'])
    await dismissReceipt()
    console.log('PASS 기존 MCP 권한 요청 · 조회 범위 선택 · 담당자 수행 · 같은 카드에 보고서 도착')
    const savedBoards = []
    for (const folder of [workspace,formerBoardWorkspace]) savedBoards.push([folder,manifest((await snap(folder)).tasks)])
    fs.writeFileSync(receiptState,JSON.stringify(savedBoards))
    assert.equal(JSON.stringify(todoRows),originalTodos)
    assert.ok(toolsCalled.every(name => name === 'list_tasks'),'entire review is read-only')
    console.log('PASS 원 보고서 → 추가 업무 지시 → 독립 보고서 · 양방향 탐색 · 원문·확인 상태 유지')
    console.log('PASS 보고서함 · 기본 전달 · 수신 확인 · 최종안 승인 · 승인 후 실행 구분')
    console.log('PASS 기존 할일 지시 2건 · 차단 사유 · 원본 참고 파일 열람/저장/취소 · 재수행 · 보고서 열람/저장/확인')
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
  const launch = extraEnv => new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [entry, '--disable-background-networking', '--user-data-dir=' + profile], { env:{...env,...extraEnv}, stdio:'inherit' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 65_000)
    child.on('error', reject)
    child.on('exit', (code, signal) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(Error('UI test exited ' + (signal || code))) })
  })
  await launch({ LT_TEST_RECEIPT_RESTART:'0' })
  await launch({ LT_TEST_RECEIPT_RESTART:'1' })
  assert.ok((await fs.stat(screenshot)).size > 10000)
} finally { await fs.rm(temp, {recursive:true, force:true}) }
