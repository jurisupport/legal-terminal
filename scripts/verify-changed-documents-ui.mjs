// Run after npm run build. Actual renderer/preload; synthetic events and in-memory files only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'changed-documents-ui-'))
const output = path.join(root, 'output/playwright/changed-documents')
await fs.mkdir(output, { recursive: true })
const channels = [...new Set((await fs.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g).map((match) => match[1]))]

async function electronCheck({ root, temp, output, channels }) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  const paths = ['/synthetic/작성/검토.md', '/synthetic/자료/검토.md', '/synthetic/증거.txt']
  const files = new Map([[paths[0], '검토 문장 최종'], [paths[1], '자료 문장 수정'], [paths[2], '증거 문장 수정']])
  const calls = []
  let confirm = false
  let created = false
  const settings = { sshProfiles: [], draftsRoot: '/synthetic', notificationSound: 'none' }
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    calls.push({ channel, args })
    if (channel === 'caseManagement:get') return { ok: true, state: { generation: 'fixture', revision: 0, ui: { selectedTaskByCase: {}, focus: null, previousFocus: null, recovery: { caseId: null, seenCaseIds: [] } } } }
    if (channel === 'setup:status') return { items: [], ready: true }
    if (channel === 'settings:get' || channel === 'settings:set') return settings
    if (channel === 'app:info') return { platform: process.platform, version: 'UI fixture', homeDirectory: '/synthetic' }
    if (channel === 'dialog:message') return args[0] === 'confirm' ? confirm : undefined
    if (channel === 'fs:readText') {
      if (!files.has(args[0])) throw Error('Unexpected fixture read: ' + args[0])
      const text = files.get(args[0])
      return { kind: 'text', ext: path.extname(args[0]), text, size: Buffer.byteLength(text), mtimeMs: 1 }
    }
    if (channel === 'fs:writeText') {
      if (!files.has(args[0].path)) throw Error('Unexpected fixture write: ' + args[0].path)
      files.set(args[0].path, args[0].content)
      return { ok: true, stat: { size: Buffer.byteLength(args[0].content), mtimeMs: 2 } }
    }
    if (channel === 'fs:loadDocumentDraft') return { ok: true }
    if (channel === 'fs:stat') return { ok: true, isDir: !files.has(args[0]), size: files.has(args[0]) ? Buffer.byteLength(files.get(args[0])) : 0, mtimeMs: 1 }
    if (['fs:list', 'fs:listPdfs', 'case:history', 'case:addHistory', 'sessions:list', 'sessions:byFolder', 'sessions:workLog'].includes(channel)) return []
    if (channel === 'sessions:byCase') return {}
    if (channel === 'sessions:transcript' || channel === 'sessions:current') return null
    if (channel === 'js:hasToken') return false
    if (channel === 'js:tokenStatus' || channel === 'dictation:keyStatus') return 'missing'
    if (channel === 'js:listCases') return { ok: true, cases: [] }
    if (channel === 'js:listHearings') return { ok: true, hearings: [] }
    if (channel === 'js:hearingSummary') return { ok: true, summary: { todayCount: 0, weekCount: 0 } }
    if (channel === 'agent:create') created = true
    if (channel === 'agent:models') return { ok: true, models: [] }
    if (channel === 'agent:snapshot') return { ok: true, snapshot: { events: [] } }
    if (channel.startsWith('case:get')) return undefined
    if (channel.startsWith('todo:')) return { ok: true, todos: [] }
    return { ok: true }
  })
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob):/.test(details.url) }))
  const w = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const consoleErrors = []
  w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message) })
  const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = (code) => w.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const wait = async (condition, label) => {
    for (let i = 0; i < 120; i++) {
      if (await run(`return (${condition})`)) return
      await pause()
    }
    throw Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-3000)')}`)
  }
  const event = async (data) => { w.webContents.send('agent:event', { sessionId: 'fixture-agent', ...data }); await pause() }
  const applied = (proposalId, filePath, oldString, newString) => event({ type: 'diff:applied', proposalId, filePath, oldString, newString })
  const screenshot = async (name) => {
    await run('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await pause(120);
    fs.writeFileSync(path.join(output, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  }
  const writes = () => calls.filter(c => c.channel === 'fs:writeText')
  const confirmations = () => calls.filter(c => c.channel === 'dialog:message' && c.args[0] === 'confirm')
  try {
    await w.loadFile(path.join(root, 'out/renderer/index.html'))
    await wait("!!document.querySelector('.case-sidebar-trigger')", 'App ready')
    await run(`
      window.checks = [];
      window.check = (condition, label) => { if (!condition) throw Error(label); window.checks.push(label) };
      window.visible = (selector) => [...document.querySelectorAll(selector)].filter(el => el.checkVisibility({ checkVisibilityCSS: true }));
      window.rows = () => [...document.querySelectorAll('.agent-changed-documents li')];
      window.row = (path) => rows().find(el => el.querySelector('.agent-changed-document-name').title.startsWith(path+'\\n'));
      window.button = (parent, label) => [...parent.querySelectorAll('button')].find(el => el.textContent.trim() === label);
      window.click = (el) => { if (!el || el.disabled) throw Error('Missing or disabled control'); el.click() };
    `)
    w.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'fixture-agent', kind: 'agent', agentProvider: 'claude', title: '합성 사건 서면 검토', cwd: '/synthetic', side: 'right', createdAt: Date.now() } })
    for (let i = 0; i < 120 && !created; i++) await pause()
    if (!created) throw Error('Fixture agent did not mount')
    await event({ type: 'message:user', messageId: 'turn-one', text: '세 문서의 문장을 정리해줘.' })
    await event({ type: 'status', status: 'working' })
    await event({ type: 'diff:proposed', proposal: { proposalId: 'unapplied', filePath: '/synthetic/미적용.md', oldString: '전', newString: '후' } })
    await run(`check(!document.querySelector('.agent-changed-documents'), 'Unapplied proposal is excluded from changed documents')`)
    await event({ type: 'diff:proposed', proposal: { proposalId: 'first-edit', filePath: paths[0], oldString: '검토 문장 원본', newString: '검토 문장 중간' } })
    await applied('first-edit', paths[0], '검토 문장 원본', '검토 문장 중간')
    await applied('second-edit', paths[0], '검토 문장 중간', '검토 문장 최종')
    await applied('other-review', paths[1], '자료 문장 원본', '자료 문장 수정')
    await event({ type: 'diff:applied', proposalId: 'evidence', filePath: paths[2], gitDiff: { diff: '@@ -1 +1 @@\n-증거 문장 원본\n+증거 문장 수정\n' } })
    await wait('rows().length === 3', 'Three applied documents')
    await run(`
      check(rows().length === 3, 'Repeated changes to one path are grouped once');
      check(rows().filter(el => el.querySelector('strong').textContent === '검토.md').length === 2, 'Same basename from different directories remains separate');
      check(rows().map(el => button(el, '되돌리기')).filter(Boolean).every(el => el.disabled), 'Revert is disabled while agent works');
      check(!button(row(${JSON.stringify(paths[2])}), '되돌리기'), 'Patch-only Codex change does not expose unsupported automatic revert');
      check(!document.querySelector('.agent-changed-documents').textContent.includes('미적용.md'), 'Proposals stay out of the applied list');
    `)
    await event({ type: 'queue:added', queueId: 'followup', text: '그 다음 검토 문장을 더 짧게 해줘.' })
    await run(`check(rows().length === 3, 'Queued follow-up does not clear current task changes')`)
    await event({ type: 'message:assistant_start', messageId: 'response' })
    await event({ type: 'message:assistant_delta', messageId: 'response', text: '변경 문서 목록에서 비교하거나 원문을 열어 확인할 수 있습니다.\n\n' + '검토 문장과 증거 문장을 확인했습니다.\n\n'.repeat(35) })
    await event({ type: 'message:assistant_done', messageId: 'response' })
    await event({ type: 'status', status: 'done' })
    await run(`
      check(rows().map(el => button(el, '되돌리기')).filter(Boolean).every(el => !el.disabled), 'Revert becomes available after task completion');
      click(row(${JSON.stringify(paths[0])}).querySelector('.agent-changed-document-name'));
    `)
    await wait("visible('.doc-content .agent-diff-grid').length > 0", 'Click filename opens comparison')
    await run(`
      const text = visible('.doc-content .agent-diff-view')[0].textContent;
      check(text.includes('검토 문장 원본') && text.includes('검토 문장 중간') && text.includes('검토 문장 최종'), 'Comparison retains both sequential edits');
      const panel = document.querySelector('.agent-changed-documents');
      const top = panel.getBoundingClientRect().top;
      const timeline = visible('.agent-timeline')[0];
      check(timeline.scrollHeight > timeline.clientHeight, 'Synthetic timeline can scroll');
      timeline.scrollTop = 0; timeline.dispatchEvent(new Event('scroll', {bubbles:true}));
      check(panel.getBoundingClientRect().top === top, 'Changed-document summary stays above scrolling timeline');
    `)
    await run(`click(row(${JSON.stringify(paths[2])}).querySelector('.agent-changed-document-name'))`)
    await wait("visible('.doc-content .agent-diff-view').some(el => el.textContent.includes('증거 문장 수정'))", 'Codex patch comparison')
    await run(`
      const text = visible('.doc-content .agent-diff-view')[0].textContent;
      check(text.includes('증거 문장 원본') && text.includes('증거 문장 수정'), 'Patch-only Codex change opens a rendered before/after comparison');
      click(row(${JSON.stringify(paths[0])}).querySelector('.agent-changed-document-name'));
    `)
    await wait("visible('.doc-content .agent-diff-view').some(el => el.textContent.includes('검토 문장 최종'))", 'Return to merged comparison')
    await screenshot('changed-documents-desktop')
    w.setSize(800, 800)
    await pause(250)
    await run(`
      const panel = document.querySelector('.agent-changed-documents');
      const bounds = panel.getBoundingClientRect();
      check(bounds.left >= 0 && bounds.right <= innerWidth && panel.scrollWidth <= panel.clientWidth + 1, 'Narrow summary fits its panel without horizontal overflow');
      for (const el of rows()) {
        const name = el.querySelector('.agent-changed-document-name').getBoundingClientRect();
        const actions = el.querySelector('.agent-card-actions').getBoundingClientRect();
        check(name.right <= actions.left + 1 || name.bottom <= actions.top + 1, 'Narrow filename and actions do not overlap');
      }
    `)
    await screenshot('changed-documents-narrow')
    await run(`click(document.querySelector('.agent-changed-documents summary'))`)
    await wait("!document.querySelector('.agent-changed-documents').open", 'Native details folds')
    await wait("visible('.agent-changed-document-name').length === 0", 'Folded rows are hidden');
    await run(`check(visible('.agent-changed-document-name').length === 0, 'Folded summary hides file rows')`)
    await screenshot('changed-documents-folded')
    await run(`click(document.querySelector('.agent-changed-documents summary'))`)
    w.setSize(1440, 1000)
    await pause(250)
    await run(`click(button(row(${JSON.stringify(paths[1])}), '문서 열기'))`)
    await wait("visible('.cm-content').some(el => el.textContent.includes('자료 문장 수정'))", 'Open exact document')
    await run(`check(visible('.cm-content').some(el => el.textContent.includes('자료 문장 수정')), 'Document-open selects the correct same-basename path')`)

    const beforeReject = confirmations().length
    await run(`click(button(row(${JSON.stringify(paths[1])}), '되돌리기'))`)
    for (let i = 0; i < 100 && confirmations().length === beforeReject; i++) await pause()
    if (confirmations().length !== beforeReject + 1 || writes().length !== 0) throw Error('Rejected confirmation must not write a file')
    await run(`check(row(${JSON.stringify(paths[1])}).querySelector('.agent-changed-document-status').textContent === '적용됨', 'Rejecting confirmation leaves file and applied status intact')`)
    confirm = true
    await run(`click(button(row(${JSON.stringify(paths[0])}), '되돌리기'))`)
    await wait(`row(${JSON.stringify(paths[0])}).querySelector('.agent-changed-document-status').textContent === '되돌림'`, 'Revert row state')
    if (writes().length !== 1 || writes()[0].args[0].path !== paths[0] || files.get(paths[0]) !== '검토 문장 원본') throw Error('Merged per-file revert must restore the original in reverse edit order')
    if (files.get(paths[1]) !== '자료 문장 수정' || files.get(paths[2]) !== '증거 문장 수정') throw Error('Revert modified another file')
    await run(`
      check(!button(row(${JSON.stringify(paths[0])}), '되돌리기'), 'Reverted row removes its revert action');
      check(rows().length === 3, 'Reverted document remains in this task list');
      check(true, 'Per-file revert restores original text and leaves other files unchanged');
    `)
    await screenshot('changed-documents-reverted')
    await run(`click(document.querySelector('.agent-changed-documents summary'))`)
    await event({ type: 'message:user', messageId: 'turn-two', text: '검토 문장 하나만 다시 수정해줘.' })
    await run(`check(!document.querySelector('.agent-changed-documents'), 'New user turn starts an empty current-task list')`)
    files.set(paths[0], '두 번째 작업 결과')
    await applied('first-edit', paths[0], '검토 문장 원본', '두 번째 작업 결과')
    await wait('rows().length === 1', 'Next turn only its changed file')
    await run(`
      check(document.querySelector('.agent-changed-documents').open, 'New task summary opens even when previous task was folded');
      const prior = document.getElementById('agent-change-fixture-agent-turn-one:diff:first-edit');
      const current = document.getElementById('agent-change-fixture-agent-turn-two:diff:first-edit');
      check(!!prior && !!current && prior !== current, 'Same proposal and path in different turns keep separate timeline records');
      check(!!prior.querySelector('.reverted') && !!current.querySelector('.applied'), 'Previous task stays reverted while current task is applied');
      click(row(${JSON.stringify(paths[0])}).querySelector('.agent-changed-document-name'));
    `)
    await wait("visible('.doc-content .agent-diff-view').some(el => el.textContent.includes('두 번째 작업 결과'))", 'New turn comparison')
    await run(`check(!visible('.doc-content .agent-diff-view')[0].textContent.includes('검토 문장 중간'), 'New task comparison excludes previous task edits')`)
    await screenshot('changed-documents-next-turn')
    if (consoleErrors.length) throw Error('Renderer errors: ' + consoleErrors.join('\n'))
    const result = { checks: await run('return window.checks'), consoleErrors, writes: writes().map(c => c.args[0]), screenshots: ['desktop', 'narrow', 'folded', 'reverted', 'next-turn'].map(name => path.join(output, `changed-documents-${name}.png`)) }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('CHANGED_DOCUMENTS_UI_RESULT ' + JSON.stringify(result))
    app.exit(0)
  } catch (error) {
    await screenshot('failure').catch(() => {})
    console.error(error)
    console.error(JSON.stringify({ consoleErrors, calls: [...new Set(calls.map(c => c.channel))] }))
    app.exit(1)
  }
}

await fs.writeFile(path.join(temp, 'main.cjs'), `(${electronCheck.toString()})(${JSON.stringify({ root, temp, output, channels })}).catch(error => { console.error(error); require('electron').app.exit(1) })`)
const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : ''))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('UI smoke check timed out\n' + output)) }, 60_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('CHANGED_DOCUMENTS_UI_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
