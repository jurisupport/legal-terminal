import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
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
  await fs.writeFile(path.join(board, 'approve-a.report.md'), '## 결론\n검토용 보고서입니다.\n## 산출물 경로\n- 초안.md\n- 검토서.pdf\n- 검토의견.hwpx\n- 참고자료.docx\n')
  await fs.writeFile(path.join(board, 'approve-b.report.md'), '## 첨부 파일\n- 누락된 검토서.pdf\n')
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
  const oldTitle = '쥬리서포트 할일 점검하기'
  await fs.writeFile(path.join(formerBoard, 'legacy-todos.md'),
    `---\nid: legacy-todos\ntitle: ${oldTitle}\ncwd: '.'\napproval: required\nstatus: blocked\n---\n${oldTitle}`)
  await fs.writeFile(path.join(formerBoard, 'legacy-todos.report.md'), '## 결재 필요\n\nmcp__jurisupport__list_todos')
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
  fs.mkdirSync(downloads)
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
  ;(async () => {
    await ready
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
    await wait(() => evaluate("document.querySelector('.work-board-window .work-board-links span')?.textContent === '3'"), 'header badge')
    assert.equal(await evaluate("document.querySelectorAll('.wb-org .wb-team').length"), 6)
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
      for (const label of ['승인','반려','수정 지시']) assert.ok(state.actions.includes(label), label)
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
      const button = [...document.querySelectorAll('.wb-dialog .wb-form button')].find(b=>b.textContent.trim()==='승인')
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
    await wait(() => evaluate("document.querySelector('.work-board-window .work-board-links span')?.textContent === '2'"), 'decision decrements global badge')
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
    await click('.agent-composer button', '일괄 지시')
    await visible('.wb-dialog textarea')
    assert.equal(await evaluate("document.querySelector('.wb-dialog textarea').value"), bulk)
    await click('.wb-dialog button', '지시별 담당 지정')
    assert.equal(await evaluate("document.querySelectorAll('.wb-draft').length"), 3)
    await evaluate("const field = document.querySelector('.wb-draft select'); field.value = 'compliance'; field.dispatchEvent(new Event('change', {bubbles:true}))")
    await click('.wb-dialog button', '3건 등록')
    await wait(() => evaluate("!document.querySelector('.wb-dialog')"), 'three instructions submitted')
    release()
    await wait(() => fs.readdirSync(board).filter(s=>/\.report\.md$/.test(s)).length === 9, 'seven reports persisted')
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
        assert.ok(await evaluate("!!document.querySelector('.wb-target-documents.wb-report-preview .wb-todo-report')"), 'report is the approval target when there are no attachments')
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
      assert.match(await evaluate("document.querySelector('.wb-block-reason > p').textContent"), /터미널 명령이 차단.+조회 범위/)
      fs.writeFileSync(path.join(path.dirname(screenshot),'legacy-reference-documents.png'), (await win.webContents.capturePage()).toPNG())
      assert.equal(await evaluate("!!document.querySelector('.wb-target-documents, .wb-reference-documents .wb-artifact')"),false,'sources appear as unopened references')
      const headings = await evaluate("[...document.querySelectorAll('.wb-dialog summary')].map(el=>el.textContent.trim())")
      assert.ok(headings.includes('도구 권한 기록 (1)') && headings.includes('결재 이력 (0)'), 'a denied tool is not an approval')
      assert.equal(await evaluate("!!document.querySelector('.wb-dialog .wb-block-reason details:not([open])')"),true)
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
      await wait(() => evaluate("document.querySelector('.wb-dialog .wb-report-preview')?.textContent.includes('아직 결재할 업무 보고서가 없습니다.')"), 'legacy card has no reviewable report')
      const reason = await evaluate("document.querySelector('.wb-dialog .wb-block-reason')?.innerText || ''")
      if (id === 'legacy-todos') assert.match(reason, /할일 목록 조회 단계에서 멈췄습니다/)
      else await verifyReadReferences(oldTitle)
      assert.equal(await evaluate("document.querySelector('.wb-dialog .wb-report-preview').textContent.includes('list_todos')"), false)
      assert.equal(await evaluate("[...document.querySelectorAll('.wb-dialog button')].some(el=>['현재 보고서로 결재 요청','승인','보고서 다운로드'].includes(el.textContent.trim()))"), false)
      await visible('.wb-dialog option[value="case:case-a"]')
      assert.equal(await evaluate("document.querySelector('.wb-dialog option[value=all]').parentElement.value"), '')
      assert.equal(await evaluate("[...document.querySelectorAll('.wb-dialog button')].find(el=>el.textContent.includes('다시 대기열에 넣기')).disabled"), true)
      await evaluate(`(() => { const scope = document.querySelector('.wb-dialog option[value="case:case-a"]').parentElement
        scope.value = 'case:case-a'; scope.dispatchEvent(new Event('change', {bubbles:true})) })()`)
      await wait(() => evaluate("[...document.querySelectorAll('.wb-dialog button')].some(el=>el.textContent.includes('다시 대기열에 넣기') && !el.disabled)"), 'retry enabled for the selected case')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      if (id === 'legacy-todos') fs.writeFileSync(path.join(path.dirname(screenshot), 'legacy-todo-blocked.png'), (await win.webContents.capturePage()).toPNG())
      assert.equal(taskReads.length, readsBeforeRetry, 'reading the marker or selecting a scope does not fetch tasks')
      await click('.wb-dialog button', '다시 대기열에 넣기')
      const oldTask = async () => (await shared()).tasks.find(t=>t.id===id)
      await wait(async () => (await oldTask())?.status==='awaiting_approval', 'native retry generated report pending approval')
      assert.deepEqual(taskReads.slice(readsBeforeRetry), [{ type:'todo', includeClosed:false, fields:'compact', page:1, limit:100, caseId:'case-a' }])
      assert.equal(queries.length, providerRuns, 'no generic agent for the original Korean request')
      await wait(() => evaluate("!document.querySelector('.wb-dialog[open]')"), 'retry dialog closed')
      await click('.wb-card', oldTitle)
      await wait(() => evaluate("document.querySelector('.wb-report-preview table')?.textContent.includes('A 준비서면 제출')"), 'completed real report displayed on reopening')
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
      if (id === 'legacy-todos') fs.writeFileSync(path.join(path.dirname(screenshot), 'legacy-todo-report.png'), (await win.webContents.capturePage()).toPNG())
      if (id === 'legacy-todos') {
        await saveFromCard('.wb-report-preview button','보고서 다운로드',path.join(formerBoard,id + '.report.md'))
      }
      await click('.wb-dialog button', '승인')
      await wait(async () => ['approved','done'].includes((await oldTask())?.status), 'legacy native report approved after successful lookup')
    }
    console.log('PASS 기존 할일 지시 2건 · 차단 사유 · 원본 참고 파일 열람/저장/취소 · 재수행 · 보고서 열람/저장/결재')
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
