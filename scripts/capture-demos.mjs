// README 데모 GIF/mp4 자동 캡처.
//
//   npm run build && node scripts/capture-demos.mjs [--only <name,...>] [--skip-agent]
//
// 의존성: playwright-core(미포함 시 `npm i --no-save playwright-core`), ffmpeg(homebrew)
//
// - Playwright로 dev 인스턴스를 띄워 mock 사건(scripts/demo-fixtures)만 조작한다.
// - 실사용 데이터(최근 사건, SSH 프로필명)는 CSS로 가린 뒤 녹화한다.
// - 결과: screenshots/demo-*.gif, screenshots/hero.mp4
// - 종료 후 cases.json recent / 세션 인덱스에서 mock 사건 흔적을 제거한다.
import { _electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureCase = path.join(repo, 'scripts', 'demo-fixtures', '2026가단12345_임대차보증금')
const outDir = path.join(repo, 'screenshots')
const work = path.join(os.tmpdir(), 'lt-demo-capture')
const framesRoot = path.join(work, 'frames')
const FRAME_MS = 110
const WIN = { width: 1280, height: 800 }

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1].split(',') : null
})()
const skipAgent = process.argv.includes('--skip-agent')

// 실사용 데이터 마스킹: 공개 README용 캡처이므로 mock 사건 외 정보는 전부 숨긴다.
const MASK_CSS = `
  .recent-list li.recent-item { display: none !important; }
  .new-case-recent { display: none !important; }
  .modal.conn-menu button.conn-row:not(:first-of-type) { display: none !important; }
  #__demo_cursor { }
`

let eapp = null
let page = null
let rec = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  eapp = await _electron.launch({
    executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [repo],
    env
  })
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

async function patchDialogs() {
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
  }, { openPath: fixtureCase, saveDir: fixtureCase })
}

// 화면에 노출되는 실제 홈 경로를 데모용 표기로 치환 (공개 README 캡처이므로)
async function startPathMasker() {
  await page.evaluate(() => {
    if (window.__demoMasker) return
    const scrub = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.includes('/Users/')) {
          node.nodeValue = node.nodeValue
            .replace(/\/Users\/[^/\s]+\/Documents\/korean-legal-terminal\/scripts\/demo-fixtures/g, '~/사건')
            .replace(/\/Users\/[^/\s]+/g, '~')
        }
      }
    }
    window.__demoMasker = setInterval(scrub, 400)
    scrub()
  })
}

async function injectOverlay() {
  await page.evaluate((css) => {
    if (!document.getElementById('__demo_mask')) {
      const s = document.createElement('style')
      s.id = '__demo_mask'
      s.textContent = css
      document.head.appendChild(s)
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
  }, MASK_CSS)
}

async function moveCursor(x, y, settle = 620) {
  await page.evaluate(([x, y]) => {
    const d = document.getElementById('__demo_cursor')
    if (d) { d.style.left = x + 'px'; d.style.top = y + 'px' }
  }, [x, y])
  await sleep(settle)
}

async function clickLoc(locator, { pause = 350 } = {}) {
  const loc = typeof locator === 'string' ? page.locator(locator).first() : locator
  await loc.waitFor({ state: 'visible', timeout: 15000 })
  const box = await loc.boundingBox()
  if (!box || box.width < 4 || box.height < 4) throw new Error('suspicious bounding box for click target')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await moveCursor(x, y)
  await page.evaluate(() => {
    const d = document.getElementById('__demo_cursor')
    if (d) d.style.transform = 'translate(-50%,-50%) scale(.65)'
  })
  await page.mouse.click(x, y)
  await sleep(140)
  await page.evaluate(() => {
    const d = document.getElementById('__demo_cursor')
    if (d) d.style.transform = 'translate(-50%,-50%)'
  })
  await sleep(pause)
}

async function startRec(name) {
  const dir = path.join(framesRoot, name)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const state = { name, dir, i: 0, stop: false, t0: Date.now() }
  state.loop = (async () => {
    while (!state.stop) {
      const t = Date.now()
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 92 })
        await fs.writeFile(path.join(dir, `f${String(state.i++).padStart(5, '0')}.jpg`), buf)
      } catch { /* 캡처 실패 프레임은 건너뜀 */ }
      const dt = Date.now() - t
      await sleep(Math.max(10, FRAME_MS - dt))
    }
  })()
  rec = state
  await sleep(400)
}

async function stopRec() {
  const state = rec
  rec = null
  state.stop = true
  await state.loop
  const elapsed = Date.now() - state.t0
  await fs.writeFile(path.join(state.dir, 'meta.json'), JSON.stringify({ frames: state.i, elapsedMs: elapsed }))
  console.log(`[rec] ${state.name}: ${state.i} frames / ${(elapsed / 1000).toFixed(1)}s`)
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

async function encode(name, { gifWidth = 960 } = {}) {
  const dir = path.join(framesRoot, name)
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
  const fps = Math.max(2, meta.frames / (meta.elapsedMs / 1000)).toFixed(3)
  const input = ['-framerate', fps, '-i', path.join(dir, 'f%05d.jpg')]
  ffmpeg([...input, '-vf', `fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, path.join(outDir, `demo-${name}.gif`)])
  ffmpeg([...input, '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-r', '24', path.join(work, `${name}.mp4`)])
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
  // 런처 진입점은 화면 상태에 따라 다르므로 폴백 순서로 시도
  const launchers = ['button.case-tabs-add', '.activitybar-bottom button.activity-item[title*="새 사건"]']
  let opened = false
  for (const sel of launchers) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      await clickLoc(sel)
      opened = true
      break
    }
  }
  if (!opened) throw new Error('새 사건 런처 버튼을 찾지 못함')
  const launcher = page.locator('.modal.new-case-launcher')
  await launcher.waitFor({ state: 'visible', timeout: 10000 })
  await clickLoc(launcher.locator('.new-case-row', { hasText: '작성서류 폴더' }))
  // SSH 프로필이 있으면 접속 메뉴가 뜬다 → "이 컴퓨터 (로컬)"
  const connLocal = page.locator('.modal.conn-menu button.conn-row', { hasText: '이 컴퓨터' })
  if (await connLocal.first().isVisible({ timeout: 2500 }).catch(() => false)) {
    await clickLoc(connLocal.first())
  }
  // dialog 패치로 mock 사건 폴더가 즉시 선택됨 → 파일트리 로드 대기
  await page.waitForSelector('.tree-row[data-entry-name*="준비서면"]', { timeout: 20000 })
}

async function scRecordSideBySide() {
  await startRec('record-drafting')
  await sleep(600)
  await clickLoc(page.locator('.tree-row[data-entry-name*="준비서면"]').first(), { pause: 1400 })
  const recordsFolder = page.locator('.tree-row[data-entry-name="기록"]').first()
  if (await recordsFolder.isVisible().catch(() => false)) {
    const expanded = await page.locator('.tree-row[data-entry-name*="임대차계약서"]').first().isVisible().catch(() => false)
    if (!expanded) await clickLoc(recordsFolder, { pause: 700 })
  }
  await clickLoc(page.locator('.tree-row[data-entry-name*="임대차계약서"]').first(), { pause: 1600 })
  // 활성 탭(PDF)을 오른쪽 패널로 → md와 나란히
  await clickLoc(page.locator('[data-work-side="left"] button.tab-add[title*="오른쪽으로 이동"]').first(), { pause: 1500 })
  // PDF 다음 페이지 넘기기
  const next = page.locator('[data-work-side="right"] .pdf-toolbar button.tb-btn[title*="다음"]').first()
  if (await next.isVisible().catch(() => false)) await clickLoc(next, { pause: 1300 })
  // 좌측 md 에디터의 특정 문단 "끝 글자" 좌표를 구해 커서를 논리적 문단 끝에 놓고 이어 쓰기 (파일은 캡처 후 원복)
  const anchor = page.locator('[data-work-side="left"] .cm-line', { hasText: '체결하였습니다' }).first()
  await anchor.waitFor({ state: 'visible', timeout: 10000 })
  const endPt = await anchor.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let last = null
    let node
    while ((node = walker.nextNode())) if (node.textContent.trim()) last = node
    const r = document.createRange()
    r.setStart(last, last.textContent.length)
    r.setEnd(last, last.textContent.length)
    const rr = r.getBoundingClientRect()
    return { x: rr.left + 1, y: rr.top + rr.height / 2 }
  })
  await moveCursor(endPt.x, endPt.y)
  await page.mouse.click(endPt.x, endPt.y)
  await sleep(500)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('한편 위 계약서 제3조 단서에 의하면 통상의 사용에 따른 자연적 마모는 원상회복 의무에서 제외됩니다(갑 제1호증 제3조).', { delay: 26 })
  await sleep(1800)
  await stopRec()
}

async function scLivePreview() {
  await startRec('live-preview')
  await sleep(500)
  const left = page.locator('[data-work-side="left"]')
  await clickLoc(left.locator('.tab', { hasText: '준비서면' }).first(), { pause: 800 })
  const srcBtn = left.locator('button.tb-btn[title*="원본"]').first()
  const fmtBtn = left.locator('button.tb-btn[title*="라이브 프리뷰"]').first()
  if (await srcBtn.isVisible().catch(() => false)) await clickLoc(srcBtn, { pause: 1800 })
  if (await fmtBtn.isVisible().catch(() => false)) await clickLoc(fmtBtn, { pause: 2200 })
  await sleep(1000)
  await stopRec()
}

async function scHwpxExport() {
  await startRec('hwpx-export')
  await sleep(500)
  const left = page.locator('[data-work-side="left"]')
  await clickLoc(left.locator('.tab', { hasText: '준비서면' }).first(), { pause: 600 })
  await clickLoc(left.locator('button.tb-btn', { hasText: 'HWPX' }).first(), { pause: 800 })
  // 사건 폴더로 저장되므로 파일트리에 .hwpx가 나타난다 → 클릭해 앱 내 뷰어로 확인
  const hwpxRow = page.locator('.tree-row[data-entry-name$=".hwpx"]').first()
  const appeared = await hwpxRow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  if (appeared) {
    await sleep(800)
    await clickLoc(hwpxRow, { pause: 2500 })
  } else {
    await sleep(3000)
  }
  await sleep(1200)
  await stopRec()
}

async function scAgentPanel() {
  await startRec('agent-panel')
  await sleep(500)
  // 우측 패널에 새 Agent 탭
  const plusA = page.locator('button.tab-add', { hasText: '＋A' }).first()
  const emptyBtn = page.locator('button', { hasText: '이 사건에서 Agent 열기' }).first()
  if (await plusA.isVisible().catch(() => false)) await clickLoc(plusA, { pause: 1500 })
  else await clickLoc(emptyBtn, { pause: 1500 })
  await startPathMasker()
  const composer = page.locator('.agent-composer textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 15000 })
  await clickLoc(composer, { pause: 300 })
  // @멘션으로 서면 파일 첨부 (메뉴 항목은 onMouseDown이라 키보드로 선택)
  await page.keyboard.type('@준비서면', { delay: 60 })
  await sleep(1200)
  await page.keyboard.press('Enter')
  await sleep(400)
  await page.keyboard.type(' 초안을 검토해서 보완할 점 두 가지만 짧게 제안해줘.', { delay: 30 })
  await sleep(600)
  await page.keyboard.press('Enter')
  // 스트리밍 응답 대기 (최대 45초): 상태줄이 사라지거나 타임아웃까지 녹화
  const deadline = Date.now() + 45000
  await sleep(4000)
  while (Date.now() < deadline) {
    const busy = await page.locator('.agent-status-line').first().isVisible().catch(() => false)
    if (!busy) break
    await sleep(1000)
  }
  await sleep(2500)
  await stopRec()
}

// ── 정리 ──────────────────────────────────────────────────

async function cleanupTraces() {
  const marker = 'demo-fixtures'
  const edits = [
    { file: path.join(os.homedir(), 'Library/Application Support/legal-terminal/cases.json'), kind: 'cases' },
    { file: path.join(os.homedir(), '.claude/legal-terminal-cases.json'), kind: 'cases' },
    { file: path.join(os.homedir(), '.claude/legal-terminal-sessions.json'), kind: 'sessions' }
  ]
  for (const { file, kind } of edits) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      let touched = false
      const scrub = (arr) => {
        if (!Array.isArray(arr)) return arr
        const kept = arr.filter((e) => !JSON.stringify(e).includes(marker))
        if (kept.length !== arr.length) touched = true
        return kept
      }
      if (kind === 'cases') {
        data.recent = scrub(data.recent)
        data.entries = scrub(data.entries)
        if (data.pairings && typeof data.pairings === 'object') {
          for (const k of Object.keys(data.pairings)) {
            if (k.includes(marker) || String(data.pairings[k]).includes(marker)) {
              delete data.pairings[k]
              touched = true
            }
          }
        }
      } else {
        data.sessions = scrub(data.sessions)
        data.entries = scrub(data.entries)
      }
      if (touched) {
        const tmp = `${file}.tmp-demo`
        await fs.writeFile(tmp, JSON.stringify(data))
        await fs.rename(tmp, file)
        console.log(`[cleanup] scrubbed ${file}`)
      }
    } catch { /* 파일 없음/파싱 실패는 무시 */ }
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
  ['agent-panel', scAgentPanel]
]

const draftBackup = await fs.readFile(path.join(fixtureCase, '준비서면_2026-07-11.md'), 'utf8')
await fs.mkdir(framesRoot, { recursive: true })
await fs.mkdir(outDir, { recursive: true })

// mock PDF는 *.pdf gitignore 정책(의뢰인 보호)상 커밋되지 않으므로 없으면 즉석 생성
const samplePdf = path.join(fixtureCase, '기록', '갑제1호증_임대차계약서.pdf')
if (!(await fs.stat(samplePdf).catch(() => null))) {
  console.log('[fixture] 샘플 PDF 생성 중...')
  const r = spawnSync(
    path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    [path.join(repo, 'scripts/generate-demo-pdfs.mjs')],
    { stdio: 'inherit', env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e })() }
  )
  if (r.status !== 0) throw new Error('샘플 PDF 생성 실패')
}

try {
  await launch()
  await patchDialogs()
  await injectOverlay()
  const debugShot = path.join(work, 'debug-initial.png')
  await page.screenshot({ path: debugShot })
  console.log('[debug] initial screenshot:', debugShot)

  // open-case를 건너뛰는 부분 실행이면 녹화 없이 사건만 열어 둔다
  if (only && !only.includes('open-case')) {
    console.log('[setup] 사건 열기 (무녹화)')
    await doOpenCase()
    await sleep(1000)
    // 이후 시나리오는 준비서면이 열려 있다고 가정하므로 record-drafting 없이 돌 때는 미리 연다
    if (!only.includes('record-drafting')) {
      await clickLoc(page.locator('.tree-row[data-entry-name*="준비서면"]').first(), { pause: 1200 })
    }
  }

  for (const [name, fn] of scenarios) {
    if (only && !only.includes(name)) continue
    if (skipAgent && name === 'agent-panel') continue
    console.log(`[scenario] ${name}`)
    await injectOverlay()
    await fn()
  }
} finally {
  await quitApp()
  await cleanupTraces()
  // 데모 중 에디터 자동저장으로 fixture가 바뀌었을 수 있으므로 원복 + 내보낸 hwpx 제거
  await fs.writeFile(path.join(fixtureCase, '준비서면_2026-07-11.md'), draftBackup)
  for (const f of await fs.readdir(fixtureCase)) {
    if (f.endsWith('.hwpx') || f.includes('.claude-draft')) await fs.rm(path.join(fixtureCase, f), { force: true })
  }
}

console.log('[encode] gif/mp4 생성 중...')
const encoded = []
for (const [name] of scenarios) {
  if (only && !only.includes(name)) continue
  if (skipAgent && name === 'agent-panel') continue
  try {
    await encode(name)
    encoded.push(name)
  } catch (e) {
    console.error(`[encode] ${name} 실패:`, e.message)
  }
}
if (!only && encoded.length === scenarios.length - (skipAgent ? 1 : 0)) {
  const listFile = path.join(work, 'concat.txt')
  await fs.writeFile(listFile, encoded.map((n) => `file '${path.join(work, `${n}.mp4`)}'`).join('\n'))
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', path.join(outDir, 'hero.mp4')])
  console.log('[done] screenshots/hero.mp4 + demo-*.gif')
} else {
  console.log('[done] 부분 인코딩:', encoded.join(', '))
}
