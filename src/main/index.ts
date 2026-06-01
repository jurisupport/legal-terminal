import { app, BrowserWindow, shell, ipcMain, dialog, screen, Menu } from 'electron'
import { join, basename, extname, resolve, sep } from 'path'
import { readdir, readFile, stat, writeFile, copyFile, rm, mkdir, rename, cp } from 'fs/promises'
import { existsSync } from 'fs'
import { getSettings, setSettings, type Settings } from './settings'
import {
  getPairing,
  setPairing,
  listHistory,
  addHistory,
  getJsPairing,
  setJsPairing
} from './caseStore'
import * as js from './jurisupport'
import { listRemoteDir } from './ssh'
import { remoteRcloneInfo, runRemoteSync, cancelSync, type RemoteSyncOpts } from './sync'
import {
  isRemote,
  rfsList,
  rfsListPdfs,
  rfsReadBytes,
  rfsWriteText,
  rfsWriteBytes,
  rfsMkdir,
  rfsCreateFile,
  rfsMove,
  rfsStat,
  rfsDelete,
  disposeRemote
} from './remoteFs'
import type { SshProfile } from './settings'
import { currentSession, listSessions } from './sessions'
import { parse as parseHwp } from 'hwp.js'
import {
  createPty,
  writePty,
  resizePty,
  killPty,
  killAllPty,
  type CreatePtyOptions
} from './pty/claude-pty'

let mainWindow: BrowserWindow | null = null

function createWindow(setMain = true, opts?: { docOnly?: boolean }): BrowserWindow {
  const docOnly = !!opts?.docOnly
  // 문서 전용(찢어낸) 창은 최대화하지 않고 적당한 크기로, 커서 근처에 띄운다.
  let pos: { x?: number; y?: number } = {}
  if (docOnly) {
    try {
      const p = screen.getCursorScreenPoint()
      pos = { x: Math.max(0, p.x - 300), y: Math.max(0, p.y - 30) }
    } catch {
      /* 커서 위치 실패 시 기본 위치 */
    }
  }
  const win = new BrowserWindow({
    // 기준 설계 해상도 1920×1080(전체 창은 최대화), 문서 전용 창은 1000×820
    width: docOnly ? 1000 : 1920,
    height: docOnly ? 820 : 1080,
    minWidth: docOnly ? 560 : 1280,
    minHeight: docOnly ? 400 : 800,
    ...pos,
    show: false,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    title: 'legal-terminal',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (setMain) mainWindow = win

  win.on('ready-to-show', () => {
    if (!docOnly) win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite: dev 서버 URL 또는 빌드된 index.html 로드
  // 문서 전용 창은 #docOnly 해시로 렌더러에 알림 (터미널·탐색기 없이 문서만)
  const hash = opts?.docOnly ? 'docOnly' : ''
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? `#${hash}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
  return win
}

// 새 창 (새 작업환경)
ipcMain.handle('window:new', () => {
  createWindow(false)
})

// 문서 전용(찢어낸) 창 등에서 'Claude에 물어보기' → 메인 창의 활성 터미널로 전달
ipcMain.handle('claude:ask', (_e, payload: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude:incoming', payload)
    mainWindow.focus()
  }
})

// ── 탭 드래그(창 간 이동/찢기) 조율 ──
interface TabPayload {
  path: string
  title: string
}
let pendingTabDrag: { payload: TabPayload; sourceId: number } | null = null
// 새 창은 렌더러가 준비되기 전이라 페이로드를 큐잉했다가 'tabs:ready' 때 전달.
const pendingReceive = new Map<number, TabPayload[]>()

ipcMain.handle('tabs:beginDrag', (e, payload: TabPayload) => {
  pendingTabDrag = { payload, sourceId: e.sender.id }
})

// 렌더러 마운트 완료 신호 → 큐에 쌓인 탭 전달
ipcMain.handle('tabs:ready', (e) => {
  const q = pendingReceive.get(e.sender.id)
  if (q) {
    for (const p of q) e.sender.send('tabs:receive', p)
    pendingReceive.delete(e.sender.id)
  }
})

// 화면좌표 pt가 해당 창의 '문서 탭바'(.body-col > .tabs) 위인지 렌더러에 물어 판정.
// (window.screenX/Y + getBoundingClientRect = 스크린 좌표, zoom=1에서 DIP와 일치)
async function isOverDocTabBar(win: BrowserWindow, pt: { x: number; y: number }): Promise<boolean> {
  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('.body-col > .tabs');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x = window.screenX + r.left, y = window.screenY + r.top;
        return ${pt.x} >= x && ${pt.x} <= x + r.width && ${pt.y} >= y && ${pt.y} <= y + r.height;
      })()`
    )
  } catch {
    return false
  }
}

ipcMain.handle('tabs:endDrag', async () => {
  const drag = pendingTabDrag
  pendingTabDrag = null
  if (!drag) return { action: 'none' }
  const pt = screen.getCursorScreenPoint()
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  // 1) 어떤 창의 문서 탭바 위에서 놓였는가?
  for (const w of wins) {
    if (await isOverDocTabBar(w, pt)) {
      // 같은 창 탭바 = 재정렬(렌더러 onDrop이 처리), 찢기 아님
      if (w.id === drag.sourceId) return { action: 'none' }
      // 다른 창 탭바 = 그 창으로 이동(merge)
      w.webContents.send('tabs:receive', drag.payload)
      w.focus()
      return { action: 'moved' }
    }
  }
  // 2) 탭바 밖(본문/창 밖 등)에서 놓임 → 새 문서 전용 창으로 찢기
  const win = createWindow(false, { docOnly: true })
  pendingReceive.set(win.id, [drag.payload])
  return { action: 'moved' }
})

// 앱 정보 핑 (preload 브리지 동작 확인용)
ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url))

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
}))

// ── 폴더 선택 다이얼로그 ──
// 부모 창을 넘기지 않아 '비모달'로 띄운다 → 다이얼로그를 연 채 터미널에 입력 가능
// (소송기록 폴더 고를 때 사건번호를 claude에 물어보는 등).
ipcMain.handle('dialog:pickFolder', async (e, opts?: { title?: string; defaultPath?: string }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const od: Electron.OpenDialogOptions = {
    title: opts?.title ?? '폴더 선택',
    defaultPath: opts?.defaultPath,
    properties: ['openDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, od) : await dialog.showOpenDialog(od)
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  return { path, name: basename(path) }
})

// (구) 사건 폴더 직접 선택 — 설정 기반 흐름으로 대체 예정이나 호환 유지 (비모달)
ipcMain.handle('dialog:openCase', async () => {
  const r = await dialog.showOpenDialog({
    title: '사건 폴더 선택',
    properties: ['openDirectory']
  })
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  return { path, name: basename(path) }
})

// ── JuriSupport(본체) MCP IPC ──
ipcMain.handle('js:setToken', (_e, token: string) => js.setToken(token))
ipcMain.handle('js:hasToken', () => js.hasToken())
ipcMain.handle('js:listCases', async (_e, params: Record<string, unknown>) => {
  try {
    return { ok: true, cases: await js.listCases(params ?? {}) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('js:getCase', async (_e, id: string) => {
  try {
    return { ok: true, case: await js.getCase(id) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})

// ── SSH IPC ──
// 원격 디렉터리 목록 (사건 폴더 선택용). 키/agent 인증일 때만 성공(아니면 ok:false).
ipcMain.handle('ssh:listDir', (_e, p: { profile: SshProfile; path: string }) =>
  listRemoteDir(p.profile, p.path)
)

// ── rclone 동기화 IPC (클라우드 경유: 맥에서 rclone 실행) ──
ipcMain.handle('sync:remoteInfo', (_e, profile: SshProfile) => remoteRcloneInfo(profile))
ipcMain.handle('sync:run', (e, opts: RemoteSyncOpts) => runRemoteSync(opts, e.sender))
ipcMain.on('sync:cancel', () => cancelSync())

// 사건 cwd의 현재 claude 세션 제목(transcript ai-title). since 이후 세션만.
ipcMain.handle('sessions:current', (_e, p: { cwd: string; since?: number; ssh?: SshProfile }) =>
  currentSession(p.cwd, p.since ?? 0, p.ssh)
)
ipcMain.handle('sessions:list', (_e, p: { cwd: string; ssh?: SshProfile }) =>
  listSessions(p.cwd, 40, p.ssh)
)

// ── 설정 IPC ──
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => setSettings(patch))

// ── 사건 페어링·히스토리 IPC ──
ipcMain.handle('case:getPairing', (_e, drafts: string) => getPairing(drafts))
ipcMain.handle('case:setPairing', (_e, p: { drafts: string; records: string }) =>
  setPairing(p.drafts, p.records)
)
ipcMain.handle('case:getJsPairing', (_e, id: string) => getJsPairing(id))
ipcMain.handle('case:setJsPairing', (_e, p: { id: string; drafts: string; records?: string }) =>
  setJsPairing(p.id, { drafts: p.drafts, records: p.records })
)
ipcMain.handle('case:history', () => listHistory())
ipcMain.handle('case:addHistory', (_e, entry: { drafts: string; records?: string; name: string }) =>
  addHistory(entry)
)

// ── 파일시스템 IPC (탐색기) ──
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.csv', '.log', '.yml', '.yaml', '.html', '.htm', '.xml',
  '.js', '.ts', '.tsx', '.css', '.py', '.sh', '.ini', '.toml'
])
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2MB 초과 텍스트는 잘라서 안내

ipcMain.handle('fs:mkdir', async (_e, p: { dir: string; name: string }) => {
  try {
    if (isRemote(p.dir)) await rfsMkdir(p.dir, p.name)
    else await mkdir(join(p.dir, p.name))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// 새 파일 생성 (이름 충돌 시 " (n)" 붙임), 빈 내용. 경로 반환.
ipcMain.handle('fs:createFile', async (_e, p: { dir: string; name: string; content?: string }) => {
  try {
    if (isRemote(p.dir)) {
      const path = await rfsCreateFile(p.dir, p.name, p.content ?? '')
      return { ok: true, path }
    }
    const ext = extname(p.name)
    const base = p.name.slice(0, p.name.length - ext.length)
    let name = p.name
    let full = join(p.dir, name)
    let i = 1
    while (existsSync(full)) {
      name = `${base} (${i})${ext}`
      full = join(p.dir, name)
      i++
    }
    await writeFile(full, p.content ?? '', 'utf8')
    return { ok: true, path: full }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// 파일/폴더 삭제 (폴더는 재귀). 로컬·원격 공통.
ipcMain.handle('fs:delete', async (_e, p: string) => {
  try {
    if (isRemote(p)) await rfsDelete(p)
    else await rm(p, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:list', async (_e, dirPath: string) => {
  if (isRemote(dirPath)) return rfsList(dirPath)
  const entries = await readdir(dirPath, { withFileTypes: true })
  const visible = entries.filter((e) => !e.name.startsWith('.'))
  const out = await Promise.all(
    visible.map(async (e) => {
      const path = join(dirPath, e.name)
      const st = await stat(path)
      return { name: e.name, path, isDir: e.isDirectory(), mtimeMs: st.mtimeMs }
    })
  )
  return out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
  )
})

// 폴더(하위 포함)의 모든 PDF 수집 — 전자소송기록 폴더 분류용
async function walkPdfs(dir: string, out: { name: string; path: string }[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walkPdfs(full, out)
    else if (e.name.toLowerCase().endsWith('.pdf')) out.push({ name: e.name, path: full })
  }
}
ipcMain.handle('fs:listPdfs', async (_e, dir: string) => {
  if (isRemote(dir)) {
    try {
      return await rfsListPdfs(dir)
    } catch {
      return []
    }
  }
  const out: { name: string; path: string }[] = []
  try {
    await walkPdfs(dir, out)
  } catch {
    /* 폴더 없음/권한 무시 */
  }
  return out
})

ipcMain.handle('fs:readBytes', async (_e, filePath: string) => {
  const buf = isRemote(filePath) ? await rfsReadBytes(filePath) : await readFile(filePath)
  // 렌더러로 ArrayBuffer 전달 (pdf.js 입력용)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

// HWP(.hwp, HWP5) 텍스트만 추출 — 이미지/표 등 서식은 무시하고 본문 텍스트만
ipcMain.handle('fs:readHwpText', async (_e, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.hwpx') {
    return { ok: false, text: '', error: 'HWPX 형식은 아직 지원하지 않습니다 (.hwp만 지원).' }
  }
  try {
    const buf = isRemote(filePath) ? await rfsReadBytes(filePath) : await readFile(filePath)
    const doc = parseHwp(buf as unknown as Parameters<typeof parseHwp>[0])
    const lines: string[] = []
    for (const section of doc.sections) {
      for (const para of section.content) {
        let line = ''
        for (const ch of para.content) {
          if ((ch.type as number) === 0 && typeof ch.value === 'string') line += ch.value
        }
        lines.push(line)
      }
    }
    return { ok: true, text: lines.join('\n').replace(/\n{3,}/g, '\n\n') }
  } catch (e) {
    return { ok: false, text: '', error: 'HWP 파싱 실패: ' + String(e) }
  }
})

// 트리 내부 이동 (탐색기 드래그앤드롭) — 같은 드라이브면 rename, 아니면 복사 후 삭제
ipcMain.handle('fs:move', async (_e, p: { src: string; destDir: string }) => {
  try {
    if (isRemote(p.src) || isRemote(p.destDir)) return await rfsMove(p.src, p.destDir)
    const srcRes = resolve(p.src)
    const dest = join(p.destDir, basename(p.src))
    const destRes = resolve(dest)
    if (destRes === srcRes) return { ok: true, path: dest } // 제자리 = 무동작
    // 폴더를 자기 자신의 하위로 이동 금지
    if (destRes.startsWith(srcRes + sep)) {
      return { ok: false, error: '폴더를 자기 하위로 이동할 수 없습니다.' }
    }
    if (existsSync(dest)) return { ok: false, error: '같은 이름이 이미 있습니다.' }
    try {
      await rename(p.src, dest)
    } catch (err) {
      // 드라이브가 다른 경우(EXDEV) 등 → 복사 후 원본 삭제
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await cp(p.src, dest, { recursive: true })
        await rm(p.src, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// 외부 파일을 폴더로 복사 (탐색기 드래그앤드롭)
ipcMain.handle('fs:copyInto', async (_e, p: { destDir: string; srcPaths: string[] }) => {
  const copied: string[] = []
  const remote = isRemote(p.destDir)
  for (const src of p.srcPaths) {
    try {
      if (remote) {
        const buf = await readFile(src) // 로컬 원본을 읽어 원격으로 업로드
        copied.push(await rfsWriteBytes(p.destDir, basename(src), buf))
      } else {
        const dest = join(p.destDir, basename(src))
        await copyFile(src, dest)
        copied.push(dest)
      }
    } catch {
      /* 개별 실패 무시 */
    }
  }
  return { copied }
})

// 마크다운(HTML) → PDF (Electron 내장 printToPDF, 외부 의존성 없음)
ipcMain.handle('export:mdToPdf', async (_e, p: { html: string; defaultPath?: string }) => {
  if (!mainWindow) return { ok: false }
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: p.defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false }
  const tmp = join(app.getPath('temp'), `lt-print-${Date.now()}.html`)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true }
  })
  try {
    await writeFile(tmp, p.html, 'utf8')
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    await writeFile(r.filePath, pdf)
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
    win.destroy()
    rm(tmp, { force: true }).catch(() => {})
  }
})

// 다른 이름으로 저장 (새 문서)
ipcMain.handle('fs:saveAs', async (_e, p: { content: string; defaultPath?: string }) => {
  if (!mainWindow) return { ok: false }
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: p.defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false }
  try {
    await writeFile(r.filePath, p.content, 'utf8')
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:writeText', async (_e, p: { path: string; content: string }) => {
  try {
    if (isRemote(p.path)) await rfsWriteText(p.path, p.content)
    else await writeFile(p.path, p.content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:readText', async (_e, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  if (isRemote(filePath)) {
    const st = await rfsStat(filePath)
    if (!TEXT_EXT.has(ext)) return { ext, kind: 'binary' as const, text: '', size: st.size }
    const buf = await rfsReadBytes(filePath)
    return {
      ext,
      kind: 'text' as const,
      text: buf.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
      size: st.size,
      truncated: buf.length > MAX_TEXT_BYTES
    }
  }
  const info = await stat(filePath)
  if (!TEXT_EXT.has(ext)) {
    return { ext, kind: 'binary' as const, text: '', size: info.size }
  }
  const buf = await readFile(filePath)
  const truncated = buf.length > MAX_TEXT_BYTES
  return {
    ext,
    kind: 'text' as const,
    text: buf.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
    size: info.size,
    truncated
  }
})

// ── PTY (터미널) IPC ──
ipcMain.handle('pty:create', (e, opts: CreatePtyOptions) => {
  createPty(opts, e.sender)
})
ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) => writePty(id, data))
ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
  resizePty(id, cols, rows)
)
ipcMain.on('pty:kill', (_e, { id }: { id: string }) => killPty(id))

app.on('before-quit', () => {
  killAllPty()
  disposeRemote()
})

app.whenReady().then(() => {
  // 기본 메뉴 제거 — 기본 메뉴가 Ctrl+W를 '창 닫기'에 바인딩해 터미널 Ctrl+W가 창을 닫는 문제 방지.
  // (메뉴바는 autoHideMenuBar로 이미 숨겨져 있어 UX 변화 없음. Ctrl+W는 렌더러에서 탭 닫기로 처리.)
  Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
