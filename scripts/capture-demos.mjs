// README 데모 GIF/mp4 자동 캡처.
//
//   npm run build && node scripts/capture-demos.mjs [--only <name,...>] [--skip-agent]
//
// 의존성: playwright-core(미포함 시 `npm i --no-save playwright-core`), ffmpeg(homebrew)
//
// - scripts/demo-bootstrap으로 앱을 띄워 userData를 임시 폴더로 분리하고, JuriSupport·할일·최근 사건은
//   가상 데이터로 대체한다. 실사용 설정·SSH 프로필·사건 목록은 화면에 나오지 않는다.
// - mock 사건(scripts/demo-fixtures)만 조작하며, 화면에 보이는 홈·임시 경로와 계정 사용량은 가린다.
// - agent·inline-edit·project-ai 장면은 실제 Claude를 호출한다(--skip-agent로 제외). 응답 대기 구간은 빨리 감는다.
// - 결과: screenshots/demo-*.gif, screenshots/hero.mp4, screenshots/project-ai-workspace.png
// - 종료 후 fixture 원복, 데모 작업환경 스냅샷·세션 인덱스·Claude 대화 기록에서 데모 흔적을 제거한다.
import { _electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(repo, 'scripts', 'demo-fixtures')
const fixtureCase = path.join(fixtures, '2026가단12345_임대차보증금')
const fixtureCase2 = path.join(fixtures, '2026카단50123_채권가압류')
const fixtureFolder = path.join(fixtures, '공통자료_임대차분쟁')
const draftFile = path.join(fixtureCase, '준비서면_2026-07-11.md')
const outDir = path.join(repo, 'screenshots')
const work = path.join(await fs.realpath(os.tmpdir()), 'lt-demo-capture')
const framesRoot = path.join(work, 'frames')
const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const FRAME_MS = 110
const WIN = { width: 1280, height: 800 }

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1].split(',') : null
})()
const skipAgent = process.argv.includes('--skip-agent')
const AGENT_SCENES = new Set(['agent-panel', 'inline-edit', 'project-ai'])

let eapp = null
let page = null
let rec = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function prepareApp() {
  // 부트스트랩을 임시 앱 폴더로 복사한다. 번들 스킬 경로(app.getAppPath()/resources)는 심볼릭 링크로 연결.
  const appDir = path.join(work, 'app')
  await fs.rm(appDir, { recursive: true, force: true })
  await fs.mkdir(appDir, { recursive: true })
  for (const f of ['package.json', 'main.cjs']) {
    await fs.copyFile(path.join(repo, 'scripts', 'demo-bootstrap', f), path.join(appDir, f))
  }
  await fs.symlink(path.join(repo, 'resources'), path.join(appDir, 'resources'))
  await fs.rm(path.join(work, 'profile'), { recursive: true, force: true })
  return appDir
}

async function launch() {
  const appDir = await prepareApp()
  const env = {
    ...process.env,
    LT_DEMO_REPO: repo,
    LT_DEMO_PROFILE: path.join(work, 'profile'),
    LT_DEMO_CASES: JSON.stringify([{ drafts: fixtureCase2, name: path.basename(fixtureCase2) }])
  }
  delete env.ELECTRON_RUN_AS_NODE
  eapp = await _electron.launch({ executablePath: electronBin, args: [appDir], env })
  page = await eapp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await sleep(2500)
  // 항상 maximize되므로 캡처용 고정 크기로 되돌린다 (setViewportSize 금지 — 리사이즈 로직을 얼림).
  await eapp.evaluate(({ BrowserWindow }, win) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setBounds({ x: 60, y: 60, width: win.width, height: win.height })
  }, WIN)
  await sleep(800)
}

async function setOpenDialog(openPath) {
  // 내보내기는 mock 사건 폴더로 저장해 파일트리에 결과가 보이게 한다 (종료 후 삭제).
  await eapp.evaluate(({ dialog }, { openPath, saveDir }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openPath] })
    dialog.showOpenDialogSync = () => [openPath]
    let n = 0
    dialog.showSaveDialog = async (...args) => {
      const opts = args.find((a) => a && typeof a === 'object' && ('defaultPath' in a || 'filters' in a)) || {}
      const base = opts.defaultPath ? String(opts.defaultPath).split('/').pop() : `export-${++n}.hwpx`
      return { canceled: false, filePath: `${saveDir}/${base}` }
    }
  }, { openPath, saveDir: fixtureCase })
}

// 공개 README 캡처이므로 홈·임시 경로를 데모용 표기로 치환하고 계정 사용량은 숨긴다.
async function injectOverlay() {
  await page.evaluate(({ fixtures, work }) => {
    if (!window.__demoMasker) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rules = [
        [new RegExp(esc(work) + '/profile/project-workspaces/[\\w-]+', 'g'), '~/legal-terminal/프로젝트 작업폴더'],
        [new RegExp('(/private)?' + esc(work.replace(/^\/private/, '')) + '[^\\s]*', 'g'), '~/legal-terminal'],
        [new RegExp(esc(fixtures), 'g'), '~/사건'],
        [/\/Users\/[^/\s]+/g, '~']
      ]
      const scrub = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const v = node.nodeValue
          if (!v || !(v.includes('/Users/') || v.includes('/var/folders/'))) continue
          node.nodeValue = rules.reduce((s, [re, to]) => s.replace(re, to), v)
        }
        for (const el of document.querySelectorAll('[title*="/Users/"], [title*="/var/folders/"]')) {
          el.title = rules.reduce((s, [re, to]) => s.replace(re, to), el.title)
        }
        for (const el of document.querySelectorAll('.agent-usage-bar span')) {
          if (/한도|Fable|초과|갱신/.test(el.textContent || '')) el.style.display = 'none'
        }
        for (const el of document.querySelectorAll('.agent-tool-row')) {
          if (el.querySelector('.agent-tool-name')?.textContent?.trim() === 'Rate limit') el.style.display = 'none'
        }
      }
      window.__demoMasker = setInterval(scrub, 150)
      scrub()
    }
    if (!document.getElementById('__demo_cursor')) {
      const d = document.createElement('div')
      d.id = '__demo_cursor'
      Object.assign(d.style, {
        position: 'fixed', left: '640px', top: '400px', width: '20px', height: '20px',
        borderRadius: '50%', background: 'rgba(124,58,237,.30)', border: '2px solid rgba(124,58,237,.95)',
        boxShadow: '0 0 10px rgba(124,58,237,.5)', zIndex: 2147483647, pointerEvents: 'none',
        transition: 'left .5s cubic-bezier(.3,.8,.3,1), top .5s cubic-bezier(.3,.8,.3,1), transform .12s ease',
        transform: 'translate(-50%,-50%)'
      })
      document.body.appendChild(d)
    }
  }, { fixtures, work })
}

async function moveCursor(x, y, settle = 620) {
  await page.evaluate(([x, y]) => {
    const d = document.getElementById('__demo_cursor')
    if (d) { d.style.left = x + 'px'; d.style.top = y + 'px' }
  }, [x, y])
  await sleep(settle)
}

async function pressCursor(down) {
  await page.evaluate((down) => {
    const d = document.getElementById('__demo_cursor')
    if (d) d.style.transform = down ? 'translate(-50%,-50%) scale(.65)' : 'translate(-50%,-50%)'
  }, down)
}

async function clickLoc(locator, { pause = 350 } = {}) {
  const loc = typeof locator === 'string' ? page.locator(locator).first() : locator
  await loc.waitFor({ state: 'visible', timeout: 15000 })
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  if (!box || box.width < 4 || box.height < 4) throw new Error('suspicious bounding box for click target')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await moveCursor(x, y)
  await pressCursor(true)
  await page.mouse.click(x, y)
  await sleep(140)
  await pressCursor(false)
  await sleep(pause)
}

async function typeInto(locator, text, { delay = 28, pause = 400 } = {}) {
  await clickLoc(locator, { pause: 200 })
  await page.keyboard.type(text, { delay })
  await sleep(pause)
}

// 줄 안 텍스트의 시작·끝 좌표 (CodeMirror .cm-line 기준)
async function lineTextBounds(line) {
  return line.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const nodes = []
    let node
    while ((node = walker.nextNode())) if (node.textContent.trim()) nodes.push(node)
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const r = document.createRange()
    r.setStart(first, 0)
    r.setEnd(first, 1)
    const a = r.getBoundingClientRect()
    r.setStart(last, last.textContent.length)
    r.setEnd(last, last.textContent.length)
    const b = r.getBoundingClientRect()
    return { start: { x: a.left + 1, y: a.top + a.height / 2 }, end: { x: b.left - 1, y: b.top + b.height / 2 } }
  })
}

// 녹화: 프레임마다 실제 경과 시간을 기록하고, speed > 1 구간은 그만큼 빨리 감아 인코딩한다.
async function startRec(name) {
  const dir = path.join(framesRoot, name)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const state = { name, dir, frames: [], stop: false, speed: 1 }
  state.loop = (async () => {
    while (!state.stop) {
      const t = Date.now()
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 92 })
        const file = `f${String(state.frames.length).padStart(5, '0')}.jpg`
        await fs.writeFile(path.join(dir, file), buf)
        state.frames.push({ file, t, speed: state.speed })
      } catch { /* 캡처 실패 프레임은 건너뜀 */ }
      const dt = Date.now() - t
      await sleep(Math.max(10, FRAME_MS * state.speed - dt))
    }
  })()
  rec = state
  await sleep(400)
}

const fastForward = (speed) => { if (rec) rec.speed = speed }

async function stopRec() {
  const state = rec
  rec = null
  state.stop = true
  await state.loop
  const { frames } = state
  const lines = []
  let total = 0
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1]?.t ?? frames[i].t + FRAME_MS
    const d = Math.max(0.02, (next - frames[i].t) / 1000 / frames[i].speed)
    total += d
    lines.push(`file '${path.join(state.dir, frames[i].file)}'`, `duration ${d.toFixed(3)}`)
  }
  if (frames.length) lines.push(`file '${path.join(state.dir, frames[frames.length - 1].file)}'`)
  await fs.writeFile(path.join(state.dir, 'frames.txt'), lines.join('\n'))
  console.log(`[rec] ${state.name}: ${frames.length} frames → ${total.toFixed(1)}s`)
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

async function encode(name, { gifWidth = 960 } = {}) {
  const input = ['-f', 'concat', '-safe', '0', '-i', path.join(framesRoot, name, 'frames.txt')]
  ffmpeg([...input, '-vf', `fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, path.join(outDir, `demo-${name}.gif`)])
  ffmpeg([...input, '-vf', 'fps=24,scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', path.join(work, `${name}.mp4`)])
}

async function waitAgentIdle(scope, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  await sleep(3000)
  while (Date.now() < deadline) {
    const busy = await page.locator(`${scope} .agent-status-line:visible`).first().isVisible().catch(() => false)
    const asking = await page.locator(`${scope} .agent-panel button:visible`, { hasText: '허용' }).first().isVisible().catch(() => false)
    if (!busy || asking) return
    await sleep(800)
  }
  throw new Error('Agent 응답 대기 시간 초과')
}

// ── 시나리오 ──────────────────────────────────────────────

async function scOpenCase() {
  await startRec('open-case')
  await sleep(1200)
  await doOpenCase()
  await sleep(2500)
  await stopRec()
}

async function doOpenCase() {
  await setOpenDialog(fixtureCase)
  await clickLoc(page.locator('button', { hasText: '새 사건 추가' }).first())
  const launcher = page.locator('.modal.new-case-launcher')
  await launcher.waitFor({ state: 'visible', timeout: 10000 })
  await sleep(500)
  await clickLoc(launcher.locator('.new-case-row', { hasText: '작성서류 폴더' }), { pause: 1500 })
  // 사건 사이드바에 열린 사건이 생기면 파일 탐색기로 전환
  await clickLoc(page.locator('.side-view-switch button', { hasText: '파일' }).first(), { pause: 600 })
  await page.waitForSelector('.tree-row[data-entry-name*="준비서면"]', { timeout: 20000 })
}

async function scRecordSideBySide() {
  await startRec('record-drafting')
  await sleep(600)
  await clickLoc(page.locator('.tree-row[data-entry-name*="준비서면"]').first(), { pause: 1400 })
  const expanded = await page.locator('.tree-row[data-entry-name*="임대차계약서"]').first().isVisible().catch(() => false)
  if (!expanded) await clickLoc(page.locator('.tree-row[data-entry-name="기록"]').first(), { pause: 700 })
  await clickLoc(page.locator('.tree-row[data-entry-name*="임대차계약서"]').first(), { pause: 1600 })
  // 활성 탭(PDF)을 오른쪽 패널로 → md와 나란히
  await clickLoc(page.locator('[data-work-side="left"] button[title*="오른쪽으로 이동"]').first(), { pause: 1500 })
  const next = page.locator('[data-work-side="right"] button[title="다음 페이지"]').first()
  if (await next.isVisible().catch(() => false)) await clickLoc(next, { pause: 1300 })
  // 좌측 md 에디터의 특정 문단 끝에 커서를 놓고 이어 쓰기 (파일은 캡처 후 원복)
  const anchor = page.locator('[data-work-side="left"] .cm-line', { hasText: '체결하였습니다' }).first()
  await anchor.waitFor({ state: 'visible', timeout: 10000 })
  const { end } = await lineTextBounds(anchor)
  await moveCursor(end.x, end.y)
  await page.mouse.click(end.x + 1, end.y)
  await sleep(500)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('한편 위 계약서 제3조 단서에 의하면 통상의 사용에 따른 자연적 마모는 원상회복 의무에서 제외됩니다(갑 제1호증 제3조).', { delay: 26 })
  await sleep(1000)
  await page.keyboard.press('Meta+s')
  await sleep(1200)
  await stopRec()
}

async function scLivePreview() {
  await startRec('live-preview')
  await sleep(500)
  const left = page.locator('[data-work-side="left"]')
  await clickLoc(left.locator('.tab', { hasText: '준비서면' }).first(), { pause: 800 })
  await clickLoc(left.locator('button[title*="원본"]').first(), { pause: 1800 })
  await clickLoc(left.locator('button[title*="라이브 프리뷰"]').first(), { pause: 2200 })
  await sleep(800)
  await stopRec()
}

async function scHwpxExport() {
  await startRec('hwpx-export')
  await sleep(500)
  const left = page.locator('[data-work-side="left"]')
  await clickLoc(left.locator('.tab', { hasText: '준비서면' }).first(), { pause: 600 })
  await clickLoc(left.locator('button[title="HWPX로 내보내기"]').first(), { pause: 800 })
  // 사건 폴더로 저장되므로 파일트리에 .hwpx가 나타난다 → 클릭해 앱 내 뷰어로 확인
  const hwpxRow = page.locator('.tree-row[data-entry-name$=".hwpx"]').first()
  const appeared = await hwpxRow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  if (appeared) {
    await sleep(800)
    await clickLoc(hwpxRow, { pause: 2500 })
    // 다음 장면을 위해 서면 탭으로 복귀
    await clickLoc(left.locator('.tab', { hasText: '준비서면' }).first(), { pause: 600 })
  } else {
    await sleep(3000)
  }
  await sleep(800)
  await stopRec()
}

async function scAgentPanel() {
  await startRec('agent-panel')
  await sleep(500)
  await clickLoc(page.locator('[data-work-side="right"] button.tab-add[title="새 Agent"]').first(), { pause: 1500 })
  const composer = page.locator('.work-right .agent-composer textarea:visible').first()
  await composer.waitFor({ state: 'visible', timeout: 15000 })
  await clickLoc(composer, { pause: 300 })
  // @멘션으로 서면 파일 첨부 (메뉴 항목은 onMouseDown이라 키보드로 선택)
  await page.keyboard.type('@준비서면', { delay: 60 })
  await sleep(1200)
  await page.keyboard.press('Enter')
  await sleep(400)
  await page.keyboard.type(' 초안을 검토해서 보완할 점 두 가지만 한국어로 짧게 제안해줘. 파일은 고치지 마.', { delay: 30 })
  await sleep(600)
  await page.keyboard.press('Enter')
  await sleep(2500)
  fastForward(4)
  await waitAgentIdle('.work-right')
  fastForward(1)
  await sleep(3500)
  await stopRec()
}

async function scInlineEdit() {
  await startRec('inline-edit')
  await sleep(500)
  // 서면의 한 문단을 드래그해 선택 → ⌘J로 바로 지시
  const line = page.locator('[data-work-side="left"] .cm-line', { hasText: '갱신하지 않겠다는' }).first()
  await line.scrollIntoViewIfNeeded()
  await sleep(600)
  const { start, end } = await lineTextBounds(line)
  await moveCursor(start.x, start.y)
  await page.mouse.move(start.x, start.y)
  await pressCursor(true)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    const x = start.x + ((end.x - start.x) * i) / 12
    const y = start.y + ((end.y - start.y) * i) / 12
    await page.mouse.move(x, y)
    await moveCursor(x, y, 70)
  }
  await page.mouse.up()
  await pressCursor(false)
  await sleep(1300)
  await page.keyboard.press('Meta+j')
  await page.locator('.inline-selection-command textarea').waitFor({ state: 'visible', timeout: 8000 })
  await sleep(700)
  await page.keyboard.type('두 문장으로 나눠 읽기 쉽게 고쳐서 파일에 반영해줘.', { delay: 32 })
  await sleep(700)
  await page.keyboard.press('Enter')
  await sleep(1500)
  fastForward(4)
  // 수정 권한 요청(변경 전/후 비교)이 뜨면 허용
  const allow = page.locator('.work-right .agent-panel button:visible', { hasText: '허용' }).first()
  await allow.waitFor({ state: 'visible', timeout: 180000 })
  fastForward(1)
  await sleep(2200)
  await clickLoc(allow, { pause: 600 })
  fastForward(4)
  await page.locator('.work-right .agent-changed-documents:visible').first().waitFor({ state: 'visible', timeout: 120000 })
  await waitAgentIdle('.work-right')
  fastForward(1)
  await sleep(1500)
  // 이번 작업 변경 문서 → 변경 비교 열기
  await clickLoc(page.locator('.work-right .agent-changed-document-name:visible').first(), { pause: 3000 })
  await stopRec()
}

async function scProjectAi() {
  await setOpenDialog(fixtureFolder)
  await startRec('project-ai')
  await sleep(600)
  await clickLoc(page.locator('button', { hasText: '프로젝트 관리' }).first(), { pause: 1200 })
  await clickLoc(page.locator('.project-dashboard button', { hasText: '새 프로젝트' }).first(), { pause: 900 })
  await typeInto(page.locator('[name="name"]'), '김민준 임대차보증금 회수')
  await typeInto(page.locator('[name="goal"]'), '보증금 3억 원 회수: 본안과 가압류를 함께 관리', { delay: 22 })
  await typeInto(page.locator('[name="nextAction"]'), '원상회복 쟁점 근거 정리 후 준비서면 보완', { delay: 22 })
  const options = page.locator('.project-case-option')
  for (let i = 0; i < Math.min(2, await options.count()); i++) await clickLoc(options.nth(i), { pause: 400 })
  await clickLoc(page.locator('.project-dashboard button', { hasText: '폴더 추가' }).first(), { pause: 1500 })
  await clickLoc(page.locator('.project-dashboard button', { hasText: '프로젝트 만들기' }).first(), { pause: 1500 })
  await clickLoc(page.locator('[aria-label="프로젝트 AI 작업"]').first(), { pause: 2500 })
  const composer = page.locator('.work-right .agent-composer textarea:visible').first()
  await typeInto(composer, '연결된 사건과 참고 폴더 파일만 읽고, 원상회복 쟁점에 쓸 근거를 파일명별로 짧게 정리해줘. 진행 설명도 한국어로 해줘.', { delay: 22, pause: 500 })
  await page.keyboard.press('Enter')
  await sleep(2500)
  fastForward(5)
  await waitAgentIdle('.work-right', 240000)
  fastForward(1)
  await sleep(4000)
  await page.screenshot({ path: path.join(outDir, 'project-ai-workspace.png') })
  await stopRec()
}

// ── 정리 ──────────────────────────────────────────────────

async function cleanupTraces() {
  const marker = fixtures
  const home = os.homedir()
  // 세션 인덱스·사건 저장소: 데모 사건 항목 제거
  const edits = [
    { file: path.join(home, 'Library/Application Support/legal-terminal/cases.json'), kind: 'cases' },
    { file: path.join(home, '.claude/legal-terminal-cases.json'), kind: 'cases' },
    { file: path.join(home, '.claude/legal-terminal-sessions.json'), kind: 'sessions' }
  ]
  const touchesDemo = (e) => { const s = JSON.stringify(e); return s.includes(marker) || s.includes(work) }
  for (const { file, kind } of edits) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      let touched = false
      const scrub = (arr) => {
        if (!Array.isArray(arr)) return arr
        const kept = arr.filter((e) => !touchesDemo(e))
        if (kept.length !== arr.length) touched = true
        return kept
      }
      const scrubMap = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
        for (const k of Object.keys(obj)) {
          if (k.includes(marker) || k.includes(work) || touchesDemo(obj[k])) { delete obj[k]; touched = true }
        }
      }
      if (kind === 'cases') {
        data.recent = scrub(data.recent)
        data.entries = scrub(data.entries)
        scrubMap(data.pairings)
      } else {
        data.sessions = Array.isArray(data.sessions) ? scrub(data.sessions) : data.sessions
        data.entries = Array.isArray(data.entries) ? scrub(data.entries) : data.entries
        scrubMap(Array.isArray(data.sessions) ? null : data.sessions)
      }
      if (touched) {
        const tmp = `${file}.tmp-demo`
        await fs.writeFile(tmp, JSON.stringify(data))
        await fs.rename(tmp, file)
        console.log(`[cleanup] scrubbed ${file}`)
      }
    } catch { /* 파일 없음/파싱 실패는 무시 */ }
  }
  // 작업환경 자동 저장 스냅샷: 데모 사건을 가리키는 파일 제거
  const wsDir = path.join(home, '.claude/legal-terminal-workspaces')
  for (const f of await fs.readdir(wsDir).catch(() => [])) {
    const p = path.join(wsDir, f)
    const text = await fs.readFile(p, 'utf8').catch(() => '')
    if (text.includes(marker) || text.includes(work)) {
      await fs.rm(p, { force: true })
      console.log(`[cleanup] removed workspace snapshot ${f}`)
    }
  }
  // Claude Code 대화 기록: 데모 폴더·임시 프로젝트 작업폴더의 기록 제거
  const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
  const prefixes = [encode(fixtures), encode(work)]
  const projectsDir = path.join(home, '.claude/projects')
  for (const d of await fs.readdir(projectsDir).catch(() => [])) {
    if (prefixes.some((p) => d.startsWith(p))) {
      await fs.rm(path.join(projectsDir, d), { recursive: true, force: true })
      console.log(`[cleanup] removed transcripts ${d}`)
    }
  }
}

async function quitApp() {
  try {
    await eapp.evaluate(({ app }) => app.exit(0))
  } catch { /* 이미 종료됨 */ }
  try { await eapp.close() } catch { /* noop */ }
}

// ── 메인 ──────────────────────────────────────────────────

const scenarios = [
  ['open-case', scOpenCase],
  ['record-drafting', scRecordSideBySide],
  ['live-preview', scLivePreview],
  ['hwpx-export', scHwpxExport],
  ['agent-panel', scAgentPanel],
  ['inline-edit', scInlineEdit],
  ['project-ai', scProjectAi]
].filter(([name]) => (!only || only.includes(name)) && !(skipAgent && AGENT_SCENES.has(name)))

const draftBackup = await fs.readFile(draftFile, 'utf8')
await fs.mkdir(framesRoot, { recursive: true })
await fs.mkdir(outDir, { recursive: true })

// mock PDF는 *.pdf gitignore 정책(의뢰인 보호)상 커밋되지 않으므로 없으면 즉석 생성
const samplePdf = path.join(fixtureCase, '기록', '갑제1호증_임대차계약서.pdf')
if (!(await fs.stat(samplePdf).catch(() => null))) {
  console.log('[fixture] 샘플 PDF 생성 중...')
  const r = spawnSync(electronBin, [path.join(repo, 'scripts/generate-demo-pdfs.mjs')], {
    stdio: 'inherit',
    timeout: 60000,
    env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e })()
  })
  if (r.status !== 0) throw new Error('샘플 PDF 생성 실패')
}

try {
  await launch()
  await injectOverlay()
  const debugShot = path.join(work, 'debug-initial.png')
  await page.screenshot({ path: debugShot })
  console.log('[debug] initial screenshot:', debugShot)

  // open-case를 건너뛰는 부분 실행이면 녹화 없이 사건만 열어 둔다
  if (!scenarios.some(([name]) => name === 'open-case')) {
    console.log('[setup] 사건 열기 (무녹화)')
    await doOpenCase()
    await sleep(1000)
    // 이후 시나리오는 준비서면이 열려 있다고 가정하므로 record-drafting 없이 돌 때는 미리 연다
    if (!scenarios.some(([name]) => name === 'record-drafting')) {
      await clickLoc(page.locator('.tree-row[data-entry-name*="준비서면"]').first(), { pause: 1200 })
    }
  }

  for (const [name, fn] of scenarios) {
    console.log(`[scenario] ${name}`)
    await injectOverlay()
    await fn()
  }
} catch (e) {
  if (page) await page.screenshot({ path: path.join(work, 'debug-failure.png') }).catch(() => {})
  console.error('[error]', e.message, '→', path.join(work, 'debug-failure.png'))
  if (rec) { rec.stop = true; await rec.loop }
  process.exitCode = 1
} finally {
  await quitApp()
  await cleanupTraces()
  // 데모 중 에디터 자동저장·Agent 수정으로 fixture가 바뀌었으므로 원복 + 내보낸 hwpx 제거
  await fs.writeFile(draftFile, draftBackup)
  for (const f of await fs.readdir(fixtureCase)) {
    if (f.endsWith('.hwpx') || f.includes('.claude-draft')) await fs.rm(path.join(fixtureCase, f), { force: true })
  }
}

if (process.exitCode) process.exit()

console.log('[encode] gif/mp4 생성 중...')
const encoded = []
for (const [name] of scenarios) {
  try {
    await encode(name)
    encoded.push(name)
  } catch (e) {
    console.error(`[encode] ${name} 실패:`, e.message)
  }
}
const heroParts = ['open-case', 'record-drafting', 'live-preview', 'hwpx-export', 'agent-panel', 'inline-edit', 'project-ai']
const haveAll = (await Promise.all(heroParts.map((n) => fs.stat(path.join(work, `${n}.mp4`)).then(() => true, () => false)))).every(Boolean)
if (haveAll && encoded.length) {
  const listFile = path.join(work, 'concat.txt')
  await fs.writeFile(listFile, heroParts.map((n) => `file '${path.join(work, `${n}.mp4`)}'`).join('\n'))
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', path.join(outDir, 'hero.mp4')])
  console.log('[done] screenshots/hero.mp4 + demo-*.gif')
} else {
  console.log('[done] 부분 인코딩:', encoded.join(', '))
}
