// Run after npm run build. Real renderer, isolated profile, synthetic IPC only.
// The standalone work log: filters, summary, chat/board rows, detail with the day's instructions and files.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'work-log-ui-'))
const output = path.join(root, 'output/playwright/work-log')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map(match => match[1]))]

async function checkWorkLog({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  app.setPath('userData', path.join(temp, 'profile'))
  const errors = [], opened = [], departmentCalls = [], boardAdds = [], workLogCalls = []
  let holdWorkLog = null
  let markRendererReady
  const rendererReady = new Promise(resolve => { markRendererReady = resolve })
  const noon = new Date().setHours(12, 0, 0, 0)
  const D = 86_400_000
  const key = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const epoch = ms => new Date(ms).setHours(0, 0, 0, 0)
  const days = [
    { date: key(noon), epoch: epoch(noon), items: [
      { sessionId: 'chat-1', cwd: '/cases/김손해배상', caseNumber: '2026가합10234', caseName: '김○○ 손해배상', who: '일반 대화', count: 3,
        firstText: '상대방 준비서면 반박 포인트 정리해 줘', firstTs: noon - 40 * 60_000, lastTs: noon - 8 * 60_000,
        workSummary: '상대방 주장 4개를 쟁점별로 나누고 반박 초안을 작성함', files: [{ path: '/cases/김손해배상/반박초안.md', kind: 'write' }, { path: '/cases/김손해배상/쟁점정리.md', kind: 'edit' }],
        status: 'unfinished', statusReason: '사용자가 중지함', costUsd: 0.84,
        departments: ['송무팀'], departmentSource: 'suggested', departmentReason: '반박서면 작성' },
      { sessionId: 'chief-s', cwd: '/cases/박임대차', caseNumber: '2026가단55012', caseName: '박○○ 임대차보증금', sshLabel: '사무실 서버', profileId: 'office', who: '업무 보드 · 자동 배분(비서실장)', count: 3,
        title: '임차권 신청', firstText: '임차권등기명령 관련 판례 조사 후 신청서 작성', firstTs: noon - 3 * 3600_000, lastTs: noon - 2 * 3600_000,
        workSummary: '판례 6건 조사 후 신청서 초안 완성', files: [{ path: '/cases/박임대차/임차권등기명령신청서.hwpx', kind: 'write' }], departments: ['조사부', '작성부'], departmentSource: 'card',
        status: 'pending', costUsd: 1.92,
        board: { workspace: 'ssh://office/cases/박임대차', cardId: 'root', children: [
          { cardId: 'c1', who: '조사부 부서장', title: '판례 조사', status: 'done', costUsd: 0.61 },
          { cardId: 'c2', who: '작성부 부서원 · law', title: '신청서 작성', status: 'done', costUsd: 0.98 }
        ] } },
      { sessionId: 'chat-2', cwd: '/cases/공사대금', folderName: '공사대금', who: '일반 대화', count: 1, firstText: '감정서 쟁점 표로 정리해 줘',
        lastTs: noon - 4 * 3600_000, status: 'running', departments: ['조사부'], departmentSource: 'suggested', departmentReason: '감정서 조사' }
    ] },
    { date: key(noon - D), epoch: epoch(noon - D), items: [
      { sessionId: 'chat-3', cwd: '/cases/공사대금', folderName: '공사대금', who: '일반 대화', count: 2, firstText: '항소이유서 목차 잡아 줘',
        firstTs: noon - D - 45 * 60_000, lastTs: noon - D, status: 'done', costUsd: 0.67, departments: ['송무팀'], departmentSource: 'direct' }
    ] }
  ]
  const transcript = { sessionId: 'chat-1', model: 'claude-fixture', mtime: noon, messages: [
    { id: 'u0', role: 'user', text: '어제 한 지시', timestamp: noon - D },
    { id: 'u1', role: 'user', text: '상대방 준비서면 반박 포인트 정리해 줘', timestamp: noon - 40 * 60_000 },
    { id: 'a1', role: 'assistant', text: '정리했습니다.', timestamp: noon - 39 * 60_000 },
    { id: 'u2', role: 'user', text: '2번 쟁점은 판례로 보강해 줘', timestamp: noon - 30 * 60_000 }
  ] }
  const settings = { sshProfiles: [{ id: 'office', label: '사무실 서버', host: 'office.invalid', user: 'fixture' }], notifyDone: false, agentDefaultProvider: 'claude' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    if (channel === 'tabs:ready') { markRendererReady(); return }
    if (channel === 'sessions:workLog') {
      workLogCalls.push(args[0] ?? {})
      return !args[0]?.quick && holdWorkLog ? holdWorkLog.then(() => days) : days
    }
    if (channel === 'sessions:workLogDepartments') return [{ name: '송무팀', color: '#4f8ef7', description: '소송 서면' }, { name: '조사부', color: '#e8a64a' }, { name: '작성부', color: '#4ec9b0' }]
    if (channel === 'sessions:setDepartment') { departmentCalls.push(args[0]); return { ok: true } }
    if (channel === 'workBoard:open' || channel === 'workBoard:snapshot') return {
      workspace: args[0], tasks: [], settings: { concurrency: 1, restart: 'requeue', maxReviews: 2, dailyTime: '18:00' },
      teams: [{ name: '송무팀', color: '#4f8ef7', agents: [] }, { name: '조사부', color: '#e8a64a', agents: [] }],
      departments: { home: '/office', history: [], usage: {}, legacy: [], overlaps: [] }, agents: [], folder: args[0] + '/_업무지시'
    }
    if (channel === 'workBoard:add') { boardAdds.push(args); return 'added' }
    if (channel === 'sessions:transcript') return args[0]?.sessionId === 'chat-1' ? transcript : null
    if (channel === 'window:new') { opened.push(args[0]); return }
    if (channel === 'workBoard:counts') return {}
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'Work log fixture', homeDirectory: '/synthetic' }
    if (channel === 'app:generalChatDirectory') return ''
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  w.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = code => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const pause = () => new Promise(resolve => setTimeout(resolve, 60))
  const wait = async (condition, label = condition) => {
    for (let i = 0; i < 150; i++) { if (await run(`return (${condition})`)) return; await pause() }
    throw Error('Timed out: ' + label)
  }
  const click = (selector, text) => run(`const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.includes(${JSON.stringify(text)}));
    if (!el) throw Error('missing ' + ${JSON.stringify(selector + ' ' + text)}); el.click()`)
  const capture = async name => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage()).toPNG())
  }
  const rows = () => run(`return document.querySelectorAll('.work-log-window .wlog-row').length`)
  const summary = () => run(`return Object.fromEntries([...document.querySelectorAll('.wlog-summary > div')].map(d => [d.querySelector('span').textContent, d.querySelector('b').textContent]))`)
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await rendererReady
    await wait("[...document.querySelectorAll('.work-board-links button')].some(b => b.textContent === '작업일지')", 'work log button')
    await click('.work-board-links button', '작업일지')
    await wait("document.querySelectorAll('.work-log-window[open] .wlog-row').length > 0", 'work log rows')

    // A first open draws from what the app already kept for remote servers, then waits for the fresh scan.
    assert.ok(workLogCalls.some(call => call.quick === true), 'first open asks for the quick result')
    assert.ok(workLogCalls.some(call => !call.quick), 'and the fresh one')

    await wait("!document.querySelector('.wlog-refreshing')", 'first refresh done')
    const caseFilterTop = await run(`return document.querySelector('.wlog-case-filter').getBoundingClientRect().top`)

    // Today by default: three rows, the board instruction counted with its two sub-cards.
    assert.equal(await rows(), 3)
    assert.deepEqual(await summary(), { 세션: '5개', 완료: '0건', '하다 만 일': '1건', '결재 대기': '1건', 비용: '$2.76' })
    const chatRow = await run(`return [...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('반박 포인트')).innerText`)
    for (const text of ['11:20–11:52', '32분', '2026가합10234', '로컬', '일반 대화', '외 지시 2건', '반박초안.md', '작성', '쟁점정리.md', '수정', '하다 만 일', '사용자가 중지함', '$0.84']) assert.ok(chatRow.includes(text), 'chat row shows ' + text)
    const boardRow = await run(`return [...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('임차권등기명령')).innerText`)
    for (const text of ['SSH · 사무실 서버', '업무 보드 · 자동 배분(비서실장)', '조사부', '작성부', '조사부 부서장', '작성부 부서원 · law', '결재 대기', '$1.92']) assert.ok(boardRow.includes(text), 'board row shows ' + text)
    assert.ok(!boardRow.includes('외 지시'), 'a board row does not count instructions like a chat')
    await capture('today')

    await click('.wlog-chip', '하다 만 일')
    await wait("document.querySelectorAll('.wlog-row').length === 1", 'status filter')
    await click('.wlog-chip', '전체')
    await click('.wlog-chip', '최근 30일')
    await wait("document.querySelectorAll('.wlog-row').length === 4", 'month period')
    assert.ok(await run(`return document.querySelector('.wlog-full-list').innerText.includes('어제')`))
    await run(`const select = document.querySelector('.wlog-case-filter select'); select.value = '공사대금'; select.dispatchEvent(new Event('change', { bubbles: true }))`)
    await wait("document.querySelectorAll('.wlog-row').length === 2", 'case filter')
    await run(`const select = document.querySelector('.wlog-case-filter select'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }))`)
    await wait("document.querySelectorAll('.wlog-row').length === 4", 'case filter cleared')

    // Detail: only that day's instructions, with the files and a way to open them.
    await click('.wlog-row', '반박 포인트')
    await wait("document.querySelectorAll('.wlog-detail ol li').length === 2", 'detail instructions')
    const detail = await run(`return document.querySelector('.wlog-detail').innerText`)
    assert.ok(!detail.includes('어제 한 지시'), 'other days are left out')
    for (const text of ['2번 쟁점은 판례로 보강해 줘', '반박초안.md', '/cases/김손해배상/쟁점정리.md', 'claude-fixture', '$0.84', '세션 이어서 열기']) assert.ok(detail.includes(text), 'detail shows ' + text)
    await capture('detail-chat')
    await click('.wlog-detail-files button', '열기')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(opened.at(-1)?.tabs?.[0]?.path, '/cases/김손해배상/반박초안.md')

    await click('.wlog-row', '임차권등기명령')
    await wait("document.querySelector('.wlog-detail')?.innerText.includes('하위 업무')", 'board detail')
    const boardDetail = await run(`return document.querySelector('.wlog-detail').innerText`)
    for (const text of ['카드 담당', '판례 조사', '신청서 작성', '업무 보드에서 보기']) assert.ok(boardDetail.includes(text), 'board detail shows ' + text)
    await click('.wlog-detail-files button', '열기')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(opened.at(-1)?.tabs?.[0]?.path, 'ssh://office/cases/박임대차/임차권등기명령신청서.hwpx', 'remote files open through the SSH profile')
    await capture('detail-board')

    // Departments: a suggestion is confirmed in place, filters count suggestions only when asked, people change it in the detail.
    await click('.wlog-chip', '오늘')
    await wait("document.querySelectorAll('.wlog-row').length === 3", 'back to today')
    const rowText = text => run(`return [...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes(${JSON.stringify(text)})).innerText`)
    assert.ok((await rowText('반박 포인트')).includes('송무팀 추천'))
    assert.ok((await rowText('임차권등기명령')).includes('카드 담당'))
    await run(`[...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('반박 포인트')).querySelector('.wlog-mini.primary').click()`)
    await wait(`[...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('반박 포인트')).innerText.includes('추천 확정')`, 'confirmed in place')
    assert.deepEqual(JSON.parse(JSON.stringify(departmentCalls.at(-1))), { sessionId: 'chat-1', cwd: '/cases/김손해배상', department: '송무팀', source: 'confirmed' })
    await click('[aria-label="부서"] .wlog-chip', '조사부')
    await wait("document.querySelectorAll('.wlog-row').length === 2", 'department filter with suggestions')
    await run(`document.querySelector('.wlog-toggle input').click()`)
    await wait("document.querySelectorAll('.wlog-row').length === 1", 'suggestions left out')
    await click('[aria-label="부서"] .wlog-chip', '부서 없음·미확정')
    await wait("document.querySelectorAll('.wlog-row').length === 1 && document.querySelector('.wlog-row').innerText.includes('감정서')", 'unconfirmed counted as none')
    await run(`document.querySelector('.wlog-toggle input').click()`)
    await click('[aria-label="부서"] .wlog-chip', '전체')
    await wait("document.querySelectorAll('.wlog-row').length === 3", 'all departments')

    await click('.wlog-row', '감정서 쟁점')
    await wait("document.querySelector('.wlog-detail')?.innerText.includes('추천 이유: 감정서 조사')", 'suggestion detail')
    assert.ok(await run(`return [...document.querySelectorAll('.wlog-detail-dept-actions button')].some(b => b.textContent === '조사부으로 확정')`))
    await run(`const select = document.querySelector('.wlog-detail-dept-actions select'); select.value = '작성부'; select.dispatchEvent(new Event('change', { bubbles: true }))`)
    await wait(`${'[...document.querySelectorAll(".wlog-row")]'}.find(r => r.textContent.includes('감정서')).innerText.includes('직접 지정')`, 'changed to direct')
    assert.deepEqual(JSON.parse(JSON.stringify(departmentCalls.at(-1))), { sessionId: 'chat-2', cwd: '/cases/공사대금', department: '작성부', source: 'direct' })
    await click('.wlog-detail-dept-actions button', '해당 부서 없음')
    await wait(`[...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('감정서')).innerText.includes('부서 없음')`, 'set to none')
    assert.equal(departmentCalls.at(-1).source, 'none')
    await capture('departments')

    // Handing unfinished work to its department opens the board form with the drafted instruction and that department.
    await run(`[...document.querySelectorAll('.wlog-row')].find(r => r.textContent.includes('반박 포인트')).querySelector('.wlog-state .wlog-mini.primary').click()`)
    await wait("!document.querySelector('.work-log-window') && !!document.querySelector('.work-board-window[open] .wb-draft textarea')", 'board form opened')
    const draft = await run(`return document.querySelector('.wb-draft textarea').value`)
    for (const text of ['이어서 처리: 상대방 준비서면 반박 포인트 정리해 줘', '사용자가 중지함', '/cases/김손해배상/반박초안.md', 'chat-1']) assert.ok(draft.includes(text), 'handoff draft has ' + text)
    assert.equal(await run(`return [...document.querySelectorAll('.wb-draft label')].find(el => el.textContent.trim().startsWith('담당')).querySelector('select').value`), 'team:송무팀')
    await capture('handoff-form')
    await run(`[...document.querySelectorAll('.wb-dialog button')].find(b => b.textContent.includes('건 등록')).click()`)
    await wait(`${JSON.stringify(true)}`)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(boardAdds.at(-1)?.[0], '/cases/김손해배상')
    assert.equal(boardAdds.at(-1)?.[1]?.[0]?.team, '송무팀')
    await run(`document.querySelector('.work-board-window button[aria-label="작업 공간으로 돌아가기"]').click()`)
    // Reopening shows the last result at once while the fresh scan is still out, then drops the notice.
    const callsBefore = workLogCalls.length
    let release
    holdWorkLog = new Promise(resolve => { release = resolve })
    await click('.work-board-links button', '작업일지')
    await wait("document.querySelectorAll('.work-log-window[open] .wlog-row').length > 0 && !!document.querySelector('.wlog-refreshing')", 'work log reopened from memory')
    assert.ok(!(await run(`return document.body.innerText.includes('작업 기록을 모으는 중')`)), 'no empty loading state on reopen')
    assert.equal(await run(`return document.querySelector('.wlog-case-filter').getBoundingClientRect().top`), caseFilterTop, 'the notice does not push the filters around')
    assert.ok(workLogCalls.slice(callsBefore).every(call => !call.quick), 'reopen goes straight to the fresh scan')
    await capture('reopen-refreshing')
    release()
    holdWorkLog = null
    await wait("!document.querySelector('.wlog-refreshing')", 'refresh notice cleared')

    // Narrow window: rows stack and nothing scrolls sideways.
    w.setContentSize(820, 900)
    await wait('innerWidth === 820')
    await pause()
    assert.ok(await run(`const list = document.querySelector('.wlog-full-list'); return list.scrollWidth <= list.clientWidth + 1`), 'no sideways scroll when narrow')
    await capture('narrow')
    w.setContentSize(1440, 960)

    await click('.work-log-window > header > button', '작업 공간')
    await wait("!document.querySelector('.work-log-window')", 'closed')
    if (errors.length) throw Error('Renderer errors: ' + errors.join('\n'))
    console.log('PASS 작업일지 · 오늘·상태·기간·사건 필터 · 요약 숫자 · 일반 대화/업무 보드 묶음 · 상세(그날 지시·파일 열기·원격 경로) · 부서 추천 확정·필터·변경·해당 없음 · 이어서 맡기기 · 다시 열면 즉시 표시 · 좁은 창')
    app.exit(0)
  } catch (error) {
    await capture('failure').catch(() => {})
    console.error(error)
    console.error(JSON.stringify({ errors, dom: await run('return document.body.innerText.slice(-2000)').catch(() => '') }))
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${checkWorkLog.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let log = ''
    child.stdout.on('data', data => { log += data })
    child.stderr.on('data', data => { log += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Work log check timed out\n' + log)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output: log }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.startsWith('PASS')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
