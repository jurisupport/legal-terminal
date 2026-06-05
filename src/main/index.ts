import { app, BrowserWindow, shell, ipcMain, dialog, screen, Menu, clipboard } from 'electron'
import { spawn } from 'child_process'
import { request } from 'https'
import { join, basename, dirname, extname, resolve, sep, posix } from 'path'
import { readdir, readFile, stat, writeFile, copyFile, rm, mkdir, rename, cp } from 'fs/promises'
import { existsSync, type Dirent } from 'fs'
import { fileURLToPath } from 'url'
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
import { listRemoteDir, searchRemoteDirs } from './ssh'
import { remoteRcloneInfo, runRemoteSync, cancelSync, type RemoteSyncOpts } from './sync'
import {
  isRemote,
  parseRemote,
  makeRemote,
  rfsList,
  rfsListPdfs,
  rfsReadBytes,
  rfsWriteText,
  rfsWriteBytes,
  rfsMkdir,
  rfsCreateFile,
  rfsMove,
  rfsRename,
  rfsStat,
  rfsDelete,
  disposeRemote
} from './remoteFs'
import type { SshProfile } from './settings'
import {
  currentSession,
  listSessions,
  readSessionTranscript,
  rememberSessionMeta,
  type SessionSearchContext
} from './sessions'
import { extractHwpText } from './hwpText'
import {
  createPty,
  writePty,
  resizePty,
  detachPty,
  killPty,
  killAllPty,
  type CreatePtyOptions
} from './pty/claude-pty'
import { decodeTextBuffer } from './textEncoding'
import {
  listWorkspaceSnapshots,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type WorkspaceSnapshot
} from './workspace'
import { disposeAgentSessions, registerAgentIpc } from './agent/agent-service'

let mainWindow: BrowserWindow | null = null
let updateCheckStarted = false
const dockBounceByWindow = new Map<number, number>()

interface GitHubReleaseAsset {
  name?: string
  browser_download_url?: string
}

interface GitHubRelease {
  tag_name?: string
  html_url?: string
  assets?: GitHubReleaseAsset[]
}

function parseVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    })
}

function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a)
  const right = parseVersionParts(b)
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function preferredUpdateAssetNames(): string[] {
  if (process.platform === 'win32') {
    return ['legal-terminal-Setup.exe']
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return ['legal-terminal-mac-arm64.dmg', 'legal-terminal-mac-arm64.zip']
    }

    return ['legal-terminal-mac-x64.zip', 'legal-terminal-mac-x64.dmg']
  }

  return []
}

function fetchLatestRelease(): Promise<GitHubRelease> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      'https://api.github.com/repos/jurisupport/legal-terminal/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'legal-terminal-update-check'
        },
        timeout: 8000
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub release check failed: HTTP ${res.statusCode ?? 'unknown'}`))
            return
          }

          try {
            resolvePromise(JSON.parse(body) as GitHubRelease)
          } catch (error) {
            reject(error)
          }
        })
      }
    )

    req.on('timeout', () => req.destroy(new Error('GitHub release check timed out')))
    req.on('error', reject)
    req.end()
  })
}

function updateDownloadUrl(release: GitHubRelease): string | null {
  const assets = Array.isArray(release.assets) ? release.assets : []
  for (const name of preferredUpdateAssetNames()) {
    const asset = assets.find((candidate) => candidate.name === name)
    if (asset?.browser_download_url) return asset.browser_download_url
  }

  return release.html_url ?? null
}

async function checkForUpdates(win: BrowserWindow): Promise<void> {
  try {
    const release = await fetchLatestRelease()
    const latestVersion = release.tag_name?.replace(/^v/i, '')
    if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) return

    const settings = await getSettings()
    if (settings.ignoredUpdateVersion === latestVersion) return

    const url = updateDownloadUrl(release)
    if (!url) return

    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'legal-terminal 업데이트',
      message: `새 버전 ${latestVersion}을 사용할 수 있습니다.`,
      detail: `현재 버전은 ${app.getVersion()}입니다. 최신 설치 파일을 다운로드할까요?`,
      buttons: ['다운로드', '나중에', '이번 버전 다시 알리지 않기'],
      defaultId: 0,
      cancelId: 1
    })

    if (result.response === 0) {
      await shell.openExternal(url)
    } else if (result.response === 2) {
      await setSettings({ ignoredUpdateVersion: latestVersion })
    }
  } catch (error) {
    console.warn('[update] update check failed', error)
  }
}

function scheduleUpdateCheck(win: BrowserWindow): void {
  if (updateCheckStarted) return
  if (!app.isPackaged && process.env['LEGAL_TERMINAL_CHECK_UPDATE_IN_DEV'] !== '1') return

  updateCheckStarted = true
  setTimeout(() => {
    if (!win.isDestroyed()) void checkForUpdates(win)
  }, 4000)
}

function stopWindowAttention(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.flashFrame(false)
  const bounceId = dockBounceByWindow.get(win.id)
  if (bounceId !== undefined && process.platform === 'darwin' && app.dock) {
    app.dock.cancelBounce(bounceId)
  }
  dockBounceByWindow.delete(win.id)
}

function requestWindowAttention(win: BrowserWindow, reason?: 'done' | 'question'): void {
  if (win.isDestroyed() || win.isFocused()) return

  if (process.platform === 'darwin' && app.dock) {
    if (!dockBounceByWindow.has(win.id)) {
      const type = reason === 'question' ? 'critical' : 'informational'
      dockBounceByWindow.set(win.id, app.dock.bounce(type))
    }
    return
  }

  win.flashFrame(true)
}

function createWindow(setMain = true, opts?: { docOnly?: boolean; termOnly?: boolean }): BrowserWindow {
  const docOnly = !!opts?.docOnly
  const termOnly = !!opts?.termOnly
  const detached = docOnly || termOnly
  // 찢어낸 창은 최대화하지 않고 적당한 크기로, 커서 근처에 띄운다.
  let pos: { x?: number; y?: number } = {}
  if (detached) {
    try {
      const p = screen.getCursorScreenPoint()
      pos = { x: Math.max(0, p.x - 300), y: Math.max(0, p.y - 30) }
    } catch {
      /* 커서 위치 실패 시 기본 위치 */
    }
  }
  const win = new BrowserWindow({
    // 기준 설계 해상도 1920×1080(전체 창은 최대화), 찢어낸 창은 1000×820
    width: detached ? 1000 : 1920,
    height: detached ? 820 : 1080,
    minWidth: detached ? 560 : 1280,
    minHeight: detached ? 400 : 800,
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

  win.on('focus', () => stopWindowAttention(win))
  win.on('closed', () => {
    stopWindowAttention(win)
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const closeTab =
      input.type === 'keyDown' &&
      process.platform === 'darwin' &&
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      key === 'w'
    if (!closeTab) return
    event.preventDefault()
    win.webContents.send('app:closeActiveTab')
  })

  let revealed = false
  const revealWindow = (): void => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    if (!detached) win.maximize()
    win.show()
    win.moveTop()
    win.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
    if (setMain && !detached) scheduleUpdateCheck(win)
  }
  win.on('ready-to-show', revealWindow)
  win.webContents.once('did-finish-load', () => setTimeout(revealWindow, 0))
  setTimeout(revealWindow, 3000)

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite: dev 서버 URL 또는 빌드된 index.html 로드
  // 전용 창은 해시로 렌더러에 알림 (문서만 / 터미널만)
  const hash = docOnly ? 'docOnly' : termOnly ? 'termOnly' : ''
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

ipcMain.handle('window:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win && !win.isDestroyed()) win.close()
})

ipcMain.on('app:requestAttention', (e, payload?: { reason?: 'done' | 'question' }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) requestWindowAttention(win, payload?.reason)
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
  kind?: 'doc' | 'terminal'
  path?: string
  title?: string
  side?: 'left' | 'right'
  tab?: unknown
}
interface TabMoveResult {
  action: 'moved' | 'none'
  removeSource?: boolean
}
interface TabDropTarget {
  side?: 'left' | 'right'
}
let pendingTabDrag: {
  payload: TabPayload
  sourceWindowId: number | null
  completed?: TabMoveResult
} | null = null
// 새 창은 렌더러가 준비되기 전이라 페이로드를 큐잉했다가 'tabs:ready' 때 전달.
const pendingReceive = new Map<number, TabPayload[]>()

ipcMain.handle('tabs:beginDrag', (e, payload: TabPayload) => {
  pendingTabDrag = { payload, sourceWindowId: BrowserWindow.fromWebContents(e.sender)?.id ?? null }
})

ipcMain.handle('tabs:dropOnTabBar', (e, target: TabDropTarget): TabMoveResult => {
  const drag = pendingTabDrag
  if (!drag) return { action: 'none' }
  const targetWindow = BrowserWindow.fromWebContents(e.sender)
  if (!targetWindow) return { action: 'none' }
  const payload = withPayloadSide(drag.payload, target.side)
  if (targetWindow.id === drag.sourceWindowId) {
    if (!target.side || target.side === payloadSide(drag.payload)) return { action: 'none' }
    targetWindow.webContents.send('tabs:receive', payload)
    drag.completed = { action: 'moved', removeSource: false }
    return drag.completed
  }
  targetWindow.webContents.send('tabs:receive', payload)
  targetWindow.focus()
  drag.completed = { action: 'moved', removeSource: true }
  return drag.completed
})

// 렌더러 마운트 완료 신호 → 큐에 쌓인 탭 전달
ipcMain.handle('tabs:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const q = pendingReceive.get(e.sender.id) ?? (win ? pendingReceive.get(win.id) : undefined)
  if (q) {
    for (const p of q) e.sender.send('tabs:receive', p)
    pendingReceive.delete(e.sender.id)
    if (win) pendingReceive.delete(win.id)
  }
})

// 화면좌표 pt가 해당 창의 지정 탭바 위인지 렌더러에 물어 판정.
// (window.screenX/Y + getBoundingClientRect = 스크린 좌표, zoom=1에서 DIP와 일치)
async function tabDropTarget(
  win: BrowserWindow,
  pt: { x: number; y: number },
  selector: string
): Promise<TabDropTarget | null> {
  const safeSelector = JSON.stringify(selector)
  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        for (const el of document.querySelectorAll(${safeSelector})) {
          const r = el.getBoundingClientRect();
          const x = window.screenX + r.left, y = window.screenY + r.top;
          if (${pt.x} < x || ${pt.x} > x + r.width || ${pt.y} < y || ${pt.y} > y + r.height) continue;
          const pane = el.closest('.work-pane, .term-col, .body-col');
          const side =
            el.getAttribute('data-drop-side') ||
            (pane?.classList.contains('work-left') ? 'left' : undefined) ||
            (pane?.classList.contains('work-right') ? 'right' : undefined) ||
            (pane?.classList.contains('term-col') ? 'right' : undefined) ||
            (pane?.classList.contains('body-col') ? 'left' : undefined);
          return { side };
        }
        return null;
      })()`
    )
  } catch {
    return null
  }
}

const payloadSide = (payload: TabPayload): 'left' | 'right' | undefined => {
  if (payload.kind === 'terminal' && payload.tab && typeof payload.tab === 'object') {
    const side = (payload.tab as { side?: unknown }).side
    return side === 'left' || side === 'right' ? side : undefined
  }
  if (payload.kind === 'doc' && payload.tab && typeof payload.tab === 'object') {
    const side = (payload.tab as { side?: unknown }).side
    if (side === 'left' || side === 'right') return side
  }
  return payload.side
}

const withPayloadSide = (payload: TabPayload, side?: 'left' | 'right'): TabPayload => {
  if (!side) return payload
  if (payload.kind === 'terminal' && payload.tab && typeof payload.tab === 'object') {
    return { ...payload, tab: { ...(payload.tab as Record<string, unknown>), side } }
  }
  if (payload.kind === 'doc' && payload.tab && typeof payload.tab === 'object') {
    return { ...payload, side, tab: { ...(payload.tab as Record<string, unknown>), side } }
  }
  return { ...payload, side }
}

ipcMain.handle('tabs:endDrag', async (): Promise<TabMoveResult> => {
  const drag = pendingTabDrag
  pendingTabDrag = null
  if (!drag) return { action: 'none' }
  if (drag.completed) return drag.completed
  const pt = screen.getCursorScreenPoint()
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const kind = drag.payload.kind ?? 'doc'
  const targetSelector = '.work-pane > .tabs, .term-col > .tabs, .body-col > .tabs'
  // 1) 어떤 창의 같은 종류 탭바 위에서 놓였는가?
  for (const w of wins) {
    const target = await tabDropTarget(w, pt, targetSelector)
    if (target) {
      const payload = withPayloadSide(drag.payload, target.side)
      if (w.id === drag.sourceWindowId) {
        // 같은 창의 같은 쪽 탭바 = 재정렬(렌더러 onDrop이 처리), 찢기 아님.
        if (!target.side || target.side === payloadSide(drag.payload)) return { action: 'none' }
        // 같은 창의 반대쪽 탭바 = 기존 탭의 side만 갱신.
        w.webContents.send('tabs:receive', payload)
        return { action: 'moved', removeSource: false }
      }
      // 다른 창 탭바 = 그 창으로 이동(merge)
      w.webContents.send('tabs:receive', payload)
      w.focus()
      return { action: 'moved', removeSource: true }
    }
  }
  // 2) 탭바 밖(본문/창 밖 등)에서 놓임 → 새 전용 창으로 찢기
  const win = createWindow(false, kind === 'terminal' ? { termOnly: true } : { docOnly: true })
  pendingReceive.set(win.webContents.id, [drag.payload])
  return { action: 'moved', removeSource: true }
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
ipcMain.handle(
  'ssh:searchDirs',
  (_e, p: { profile: SshProfile; path: string; query: string; maxDepth?: number; limit?: number }) =>
    searchRemoteDirs(p.profile, p.path, {
      query: p.query,
      maxDepth: p.maxDepth,
      limit: p.limit
    })
)

// ── rclone 동기화 IPC (클라우드 경유: 맥에서 rclone 실행) ──
ipcMain.handle('sync:remoteInfo', (_e, profile: SshProfile) => remoteRcloneInfo(profile))
ipcMain.handle('sync:run', (e, opts: RemoteSyncOpts) => runRemoteSync(opts, e.sender))
ipcMain.on('sync:cancel', () => cancelSync())

// 사건 cwd의 현재 claude 세션 제목(transcript ai-title). since 이후 세션만.
ipcMain.handle('sessions:current', (_e, p: { cwd: string; since?: number; ssh?: SshProfile }) =>
  currentSession(p.cwd, p.since ?? 0, p.ssh)
)
ipcMain.handle('sessions:list', (_e, p: { cwd: string; ssh?: SshProfile; context?: SessionSearchContext }) =>
  listSessions(p.cwd, 40, p.ssh, p.context)
)
ipcMain.handle('sessions:transcript', (_e, p: { sessionId: string; ssh?: SshProfile }) =>
  readSessionTranscript(p.sessionId, p.ssh)
)
ipcMain.handle('sessions:remember', (_e, p: Parameters<typeof rememberSessionMeta>[0]) =>
  rememberSessionMeta(p)
)

// ── 작업환경 저장/복원 IPC ──
ipcMain.handle('workspace:save', (_e, snapshot: WorkspaceSnapshot) =>
  saveWorkspaceSnapshot(snapshot)
)
ipcMain.handle('workspace:list', () => listWorkspaceSnapshots())
ipcMain.handle('workspace:load', (_e, id?: string) => loadWorkspaceSnapshot(id))
ipcMain.handle('workspace:exportFile', async (e, snapshot: WorkspaceSnapshot) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = win
    ? await dialog.showSaveDialog(win, {
        title: '작업환경 내보내기',
        defaultPath: 'legal-terminal-workspace.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        title: '작업환경 내보내기',
        defaultPath: 'legal-terminal-workspace.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
  if (r.canceled || !r.filePath) return { ok: false, canceled: true }
  return saveWorkspaceSnapshot(snapshot, r.filePath)
})
ipcMain.handle('workspace:importFile', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = win
    ? await dialog.showOpenDialog(win, {
        title: '작업환경 가져오기',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    : await dialog.showOpenDialog({
        title: '작업환경 가져오기',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
  if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true, snapshot: null }
  return loadWorkspaceSnapshot(r.filePaths[0])
})

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
const LOCAL_CLOUD_READ_TIMEOUT_MS = 45_000
const LOCAL_CLOUD_HYDRATE_TIMEOUT_MS = 180_000
const LOCAL_CLOUD_FOLDER_HYDRATE_TIMEOUT_MS = 8_000
const LOCAL_CLOUD_FOLDER_HYDRATE_KICK_MS = 2_000
const localPrefetching = new Set<string>()
const localPrefetchedAt = new Map<string, number>()

function isLikelyLocalOneDrivePath(filePath: string): boolean {
  if (process.platform !== 'darwin') return false
  const p = filePath.replace(/\\/g, '/')
  return p.includes('/OneDrive/') || p.includes('/Library/CloudStorage/OneDrive')
}

function oneDriveCliPath(): string | undefined {
  const appPath = '/Applications/OneDrive.app/Contents/MacOS/OneDrive'
  return existsSync(appPath) ? appPath : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readViaCat(filePath: string, timeoutMs: number, collect = true): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const errs: Buffer[] = []
    const proc = spawn('/bin/cat', [filePath], {
      stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true
    })
    let settled = false
    const finish = (err?: Error, buf?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(buf ?? Buffer.alloc(0))
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(new Error('OneDrive 파일 다운로드 대기 시간이 초과되었습니다.'))
    }, timeoutMs)
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (collect) chunks.push(chunk)
    })
    proc.stderr?.on('data', (chunk: Buffer) => errs.push(chunk))
    proc.on('error', (err) => finish(err))
    proc.on('close', (code) => {
      if (code === 0) {
        finish(undefined, collect ? Buffer.concat(chunks) : Buffer.alloc(0))
        return
      }
      const msg = Buffer.concat(errs).toString('utf8').trim()
      finish(new Error(msg || `/bin/cat 종료 코드 ${code}`))
    })
  })
}

async function runQuiet(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(new Error(`${command} timed out`))
    }, timeoutMs)
    proc.on('error', finish)
    proc.on('close', () => finish())
  })
}

async function hydrateLocalCloudFile(filePath: string, timeoutMs = LOCAL_CLOUD_HYDRATE_TIMEOUT_MS): Promise<void> {
  try {
    await readViaCat(filePath, 5_000, false)
    return
  } catch {
    /* 파일 내용이 아직 로컬에 없으면 아래에서 다운로드를 트리거한다. */
  }

  const oneDrive = oneDriveCliPath()
  if (oneDrive) {
    void runQuiet('open', ['-ga', 'OneDrive'], 10_000).catch(() => {})
    void runQuiet(oneDrive, ['/pin', filePath], 15_000).catch(() => {})
  }
  void runQuiet('fileproviderctl', ['materialize', filePath], 10_000).catch(() => {})
  void runQuiet('brctl', ['download', filePath], 10_000).catch(() => {})

  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await readViaCat(filePath, 5_000, false)
      return
    } catch (e) {
      lastErr = e
      await delay(1500)
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '알 수 없는 오류')
  throw new Error(
    `OneDrive 파일 자동 다운로드가 시간 내 완료되지 않았습니다: ${filePath}\n맥 OneDrive 로그인/네트워크 상태를 확인한 뒤 다시 여세요. (${msg})`
  )
}

function hasVisibleDirEntry(entries: Dirent[]): boolean {
  return entries.some((entry) => !entry.name.startsWith('.'))
}

async function hydrateLocalCloudFolder(dirPath: string): Promise<void> {
  if (!isLikelyLocalOneDrivePath(dirPath)) return

  const oneDrive = oneDriveCliPath()
  const kicks: Promise<void>[] = []
  if (oneDrive) {
    void runQuiet('open', ['-ga', 'OneDrive'], 10_000).catch(() => {})
    kicks.push(runQuiet(oneDrive, ['/pin', dirPath], 15_000).catch(() => {}))
  }
  kicks.push(runQuiet('fileproviderctl', ['materialize', dirPath], 15_000).catch(() => {}))
  kicks.push(runQuiet('brctl', ['download', dirPath], 15_000).catch(() => {}))

  await Promise.race([Promise.allSettled(kicks), delay(LOCAL_CLOUD_FOLDER_HYDRATE_KICK_MS)])

  const deadline = Date.now() + LOCAL_CLOUD_FOLDER_HYDRATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      if (hasVisibleDirEntry(entries)) return
    } catch {
      return
    }
    await delay(750)
  }
}

async function readLocalDirEntries(dirPath: string): Promise<Dirent[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  if (!isLikelyLocalOneDrivePath(dirPath) || hasVisibleDirEntry(entries)) return entries

  await hydrateLocalCloudFolder(dirPath)
  try {
    const hydrated = await readdir(dirPath, { withFileTypes: true })
    return hydrated.length >= entries.length ? hydrated : entries
  } catch {
    return entries
  }
}

async function readLocalBytes(filePath: string): Promise<Buffer> {
  if (!isLikelyLocalOneDrivePath(filePath)) return await readFile(filePath)
  try {
    const buf = await readViaCat(filePath, LOCAL_CLOUD_READ_TIMEOUT_MS)
    localPrefetchedAt.set(filePath, Date.now())
    return buf
  } catch (firstErr) {
    const first = firstErr instanceof Error ? firstErr.message : String(firstErr)
    if (/No such file|not a directory|Permission denied|Is a directory/i.test(first)) {
      throw firstErr
    }
    await hydrateLocalCloudFile(filePath)
    try {
      const buf = await readViaCat(filePath, LOCAL_CLOUD_READ_TIMEOUT_MS)
      localPrefetchedAt.set(filePath, Date.now())
      return buf
    } catch (retryErr) {
      const retry = retryErr instanceof Error ? retryErr.message : String(retryErr)
      throw new Error(`OneDrive 파일 읽기 실패: ${retry}\n초기 읽기 오류: ${first}`)
    }
  }
}

function prefetchLocalCloudFiles(paths: string[]): void {
  const now = Date.now()
  const targets = paths
    .filter((p) => {
      const prefetchedAt = localPrefetchedAt.get(p) ?? 0
      return isLikelyLocalOneDrivePath(p) && !localPrefetching.has(p) && now - prefetchedAt > 10 * 60_000
    })
    .slice(0, 80)
  if (targets.length === 0) return
  for (const path of targets) localPrefetching.add(path)
  void (async () => {
    for (const path of targets) {
      try {
        await hydrateLocalCloudFile(path, 120_000)
        localPrefetchedAt.set(path, Date.now())
      } catch {
        /* 선다운로드 실패는 실제 열기 시 명확히 다시 보고한다. */
      } finally {
        localPrefetching.delete(path)
      }
    }
  })()
}

function readBplistInt(buf: Buffer, offset: number, size: number): number {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + buf[offset + i]
  return value
}

function parseBplistStrings(buf: Buffer): string[] {
  if (buf.length < 40 || buf.subarray(0, 8).toString('ascii') !== 'bplist00') return []
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const objectCount = Number(trailer.readBigUInt64BE(8))
  const topObject = Number(trailer.readBigUInt64BE(16))
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24))
  if (!offsetSize || !refSize || objectCount <= 0 || objectCount > 100_000) return []
  const offsets: number[] = []
  for (let i = 0; i < objectCount; i++) {
    offsets.push(readBplistInt(buf, offsetTableOffset + i * offsetSize, offsetSize))
  }

  const readLength = (offset: number, low: number): { length: number; offset: number } => {
    if (low < 0xf) return { length: low, offset }
    const marker = buf[offset]
    const intSize = 1 << (marker & 0x0f)
    return { length: readBplistInt(buf, offset + 1, intSize), offset: offset + 1 + intSize }
  }

  const readObject = (index: number, seen = new Set<number>()): unknown => {
    if (index < 0 || index >= offsets.length || seen.has(index)) return null
    seen.add(index)
    let offset = offsets[index]
    const marker = buf[offset++]
    const high = marker >> 4
    const low = marker & 0x0f
    if (high === 0x5) {
      const lengthInfo = readLength(offset, low)
      return buf.subarray(lengthInfo.offset, lengthInfo.offset + lengthInfo.length).toString('utf8')
    }
    if (high === 0x6) {
      const lengthInfo = readLength(offset, low)
      return Buffer.from(buf.subarray(lengthInfo.offset, lengthInfo.offset + lengthInfo.length * 2))
        .swap16()
        .toString('utf16le')
    }
    if (high === 0xa) {
      const lengthInfo = readLength(offset, low)
      const out: unknown[] = []
      for (let i = 0; i < lengthInfo.length; i++) {
        const ref = readBplistInt(buf, lengthInfo.offset + i * refSize, refSize)
        out.push(readObject(ref, new Set(seen)))
      }
      return out
    }
    if (high === 0xd) {
      const lengthInfo = readLength(offset, low)
      const keysStart = lengthInfo.offset
      const valuesStart = keysStart + lengthInfo.length * refSize
      const out: Record<string, unknown> = {}
      for (let i = 0; i < lengthInfo.length; i++) {
        const keyRef = readBplistInt(buf, keysStart + i * refSize, refSize)
        const valueRef = readBplistInt(buf, valuesStart + i * refSize, refSize)
        const key = readObject(keyRef, new Set(seen))
        if (typeof key === 'string') out[key] = readObject(valueRef, new Set(seen))
      }
      return out
    }
    return null
  }

  const strings: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(readObject(topObject))
  return strings
}

function decodeClipboardBuffer(buf: Buffer): string[] {
  const bplistStrings = parseBplistStrings(buf)
  const texts = [
    buf.toString('utf8'),
    buf.includes(0) ? buf.toString('utf16le') : ''
  ].filter(Boolean)
  return [...bplistStrings, ...texts]
}

function filePathFromClipboardToken(token: string): string | null {
  let value = token.trim()
  if (!value || value === 'copy' || value === 'cut') return null
  value = value.replace(/[;,]+$/, '').trim()
  value = value.replace(/^['"]|['"]$/g, '')
  if (!value) return null
  try {
    if (/^file:/i.test(value)) return fileURLToPath(value)
  } catch {
    return null
  }
  if (/^\/.+/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return value
  }
  return null
}

function extractClipboardPathsFromText(text: string): string[] {
  const paths: string[] = []
  const push = (value: string | null): void => {
    if (value && existsSync(value)) paths.push(value)
  }
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\0/g, '\n')
  for (const line of normalized.split('\n')) push(filePathFromClipboardToken(line))

  const embedded =
    normalized.match(
      /file:\/\/[^\s<>"']+|\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library)\/[^\n\r\t<>"']+|[A-Za-z]:\\[^\n\r\t<>"']+|\\\\[^\n\r\t<>"']+/g
    ) ?? []
  for (const token of embedded) push(filePathFromClipboardToken(token))
  return paths
}

function parseCfHdrop(buf: Buffer): string[] {
  if (buf.length < 20) return []
  const offset = buf.readUInt32LE(0)
  const wide = buf.readUInt32LE(16) !== 0
  if (offset < 20 || offset >= buf.length) return []
  const text = wide ? buf.subarray(offset).toString('utf16le') : buf.subarray(offset).toString('latin1')
  return text.split('\0').filter((p) => p && existsSync(p))
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const key = resolve(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

function readClipboardFilePaths(): { paths: string[]; formats: string[] } {
  const formats = clipboard.availableFormats('clipboard')
  const paths: string[] = []
  const readTextFormat = (format: string): void => {
    try {
      const text = clipboard.read(format)
      paths.push(...extractClipboardPathsFromText(text))
    } catch {
      try {
        const buf = clipboard.readBuffer(format)
        for (const text of decodeClipboardBuffer(buf)) paths.push(...extractClipboardPathsFromText(text))
      } catch {
        /* 일부 플랫폼 포맷은 Electron에서 읽기 실패할 수 있다. */
      }
    }
  }

  try {
    const bookmark = clipboard.readBookmark()
    paths.push(...extractClipboardPathsFromText(bookmark.url))
  } catch {
    /* macOS/Windows 북마크가 없는 경우 */
  }

  for (const format of formats) {
    if (format === 'CF_HDROP') {
      try {
        paths.push(...parseCfHdrop(clipboard.readBuffer(format)))
      } catch {
        /* ignore */
      }
      continue
    }
    if (/^(FileNameW|FileName|NSFilenamesPboardType|public\.file-url|text\/uri-list|x-special\/gnome-copied-files)$/i.test(format)) {
      readTextFormat(format)
    }
  }
  paths.push(...extractClipboardPathsFromText(clipboard.readText('clipboard')))
  return { paths: uniquePaths(paths), formats }
}

function remoteChild(parentUri: string, name: string): string {
  const { profileId, path } = parseRemote(parentUri)
  return makeRemote(profileId, posix.join(path, name))
}

async function ensureRemoteChildDir(parentUri: string, name: string): Promise<string> {
  const child = remoteChild(parentUri, name)
  try {
    const st = await rfsStat(child)
    if (!st.isDir) throw new Error('같은 이름의 파일이 이미 있습니다: ' + name)
    return child
  } catch (e) {
    if (String(e).includes('같은 이름의 파일')) throw e
    await rfsMkdir(parentUri, name)
    return child
  }
}

async function copyLocalPathInto(destDir: string, src: string): Promise<string> {
  const st = await stat(src)
  const dest = join(destDir, basename(src))
  if (st.isDirectory()) await cp(src, dest, { recursive: true })
  else await copyFile(src, dest)
  return dest
}

async function uploadLocalPathIntoRemote(destDir: string, src: string): Promise<string> {
  const st = await stat(src)
  if (!st.isDirectory()) {
    const buf = await readFile(src)
    return await rfsWriteBytes(destDir, basename(src), buf)
  }
  const dir = await ensureRemoteChildDir(destDir, basename(src))
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    await uploadLocalPathIntoRemote(dir, join(src, entry.name))
  }
  return dir
}

function remoteBasename(uri: string): string {
  const { path } = parseRemote(uri)
  return posix.basename(path) || 'download'
}

async function downloadRemoteToLocal(srcUri: string, destPath: string): Promise<number> {
  const st = await rfsStat(srcUri)
  if (!st.isDir) {
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, await rfsReadBytes(srcUri))
    return 1
  }
  await mkdir(destPath, { recursive: true })
  let count = 0
  for (const entry of await rfsList(srcUri)) {
    count += await downloadRemoteToLocal(entry.path, join(destPath, entry.name))
  }
  return count
}

ipcMain.handle('fs:mkdir', async (_e, p: { dir: string; name: string }) => {
  try {
    if (isRemote(p.dir)) {
      await rfsMkdir(p.dir, p.name)
      return { ok: true, path: remoteChild(p.dir, p.name) }
    }
    const path = join(p.dir, p.name)
    await mkdir(path)
    return { ok: true, path }
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

ipcMain.handle('fs:rename', async (_e, p: { path: string; name: string }) => {
  try {
    const name = p.name.trim()
    if (!name) return { ok: false, error: '이름을 입력하세요.' }
    if (/[\\/]/.test(name)) return { ok: false, error: '이름에 경로 구분자를 사용할 수 없습니다.' }
    if (isRemote(p.path)) return await rfsRename(p.path, name)
    const dest = join(dirname(p.path), name)
    if (dest === p.path) return { ok: true, path: p.path }
    if (existsSync(dest)) return { ok: false, error: '같은 이름이 이미 있습니다.' }
    await rename(p.path, dest)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:list', async (_e, dirPath: string) => {
  if (isRemote(dirPath)) return rfsList(dirPath)
  const entries = await readLocalDirEntries(dirPath)
  const visible = entries.filter((e) => !e.name.startsWith('.'))
  const out = await Promise.all(
    visible.map(async (e) => {
      const path = join(dirPath, e.name)
      const st = await stat(path)
      return { name: e.name, path, isDir: e.isDirectory(), mtimeMs: st.mtimeMs }
    })
  )
  prefetchLocalCloudFiles(out.filter((e) => !e.isDir).map((e) => e.path))
  return out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko') : a.isDir ? -1 : 1
  )
})

// 폴더(하위 포함)의 모든 PDF 수집 — 전자소송기록 폴더 분류용
async function walkPdfs(dir: string, out: { name: string; path: string }[]): Promise<void> {
  const entries = await readLocalDirEntries(dir)
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
    prefetchLocalCloudFiles(out.map((p) => p.path))
  } catch {
    /* 폴더 없음/권한 무시 */
  }
  return out
})

ipcMain.handle('fs:clipboardFiles', async () => readClipboardFilePaths())

ipcMain.handle('fs:readBytes', async (_e, filePath: string) => {
  try {
    const buf = isRemote(filePath) ? await rfsReadBytes(filePath) : await readLocalBytes(filePath)
    // 렌더러로 ArrayBuffer 전달 (pdf.js 입력용)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${isRemote(filePath) ? '원격 파일 읽기 실패' : '파일 읽기 실패'}: ${msg}`)
  }
})

// HWP/HWPX 텍스트만 추출 — 이미지/표 등 서식은 무시하고 본문 텍스트만
ipcMain.handle('fs:readHwpText', async (_e, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  try {
    const buf = isRemote(filePath) ? await rfsReadBytes(filePath) : await readLocalBytes(filePath)
    return { ok: true, text: extractHwpText(buf, ext) }
  } catch (e) {
    return { ok: false, text: '', error: 'HWP/HWPX 파싱 실패: ' + String(e) }
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
      copied.push(remote ? await uploadLocalPathIntoRemote(p.destDir, src) : await copyLocalPathInto(p.destDir, src))
    } catch {
      /* 개별 실패 무시 */
    }
  }
  return { copied }
})

ipcMain.handle('fs:download', async (_e, source: string) => {
  if (!mainWindow) return { ok: false, error: '메인 창을 찾을 수 없습니다.' }
  if (!isRemote(source)) return { ok: false, error: '원격 경로만 다운로드할 수 있습니다.' }
  try {
    const st = await rfsStat(source)
    const name = remoteBasename(source)
    if (st.isDir) {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '원격 폴더 다운로드 위치',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true }
      const path = join(r.filePaths[0], name)
      const count = await downloadRemoteToLocal(source, path)
      return { ok: true, path, count }
    }
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '원격 파일 다운로드',
      defaultPath: join(app.getPath('downloads'), name)
    })
    if (r.canceled || !r.filePath) return { ok: true, canceled: true }
    const count = await downloadRemoteToLocal(source, r.filePath)
    return { ok: true, path: r.filePath, count }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// 마크다운(HTML) → PDF (Electron 내장 printToPDF, 외부 의존성 없음)
ipcMain.handle('export:mdToPdf', async (e, p: { html: string; defaultPath?: string }) => {
  const parentWindow = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
  if (!parentWindow || parentWindow.isDestroyed()) return { ok: false }
  const r = await dialog.showSaveDialog(parentWindow, {
    defaultPath: p.defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false }
  const tmp = join(app.getPath('temp'), `lt-print-${Date.now()}.html`)
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true }
  })
  try {
    await writeFile(tmp, p.html, 'utf8')
    await printWindow.loadFile(tmp)
    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    await writeFile(r.filePath, pdf)
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
    printWindow.destroy()
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

ipcMain.handle('fs:stat', async (_e, filePath: string) => {
  try {
    if (isRemote(filePath)) {
      const st = await rfsStat(filePath)
      return { ok: true, ...st }
    }
    const st = await stat(filePath)
    return { ok: true, size: st.size, isDir: st.isDirectory(), mtimeMs: st.mtimeMs }
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
    const decoded = decodeTextBuffer(buf, MAX_TEXT_BYTES)
    return {
      ext,
      kind: 'text' as const,
      text: decoded.text,
      size: st.size,
      truncated: decoded.truncated
    }
  }
  const info = await stat(filePath)
  if (!TEXT_EXT.has(ext)) {
    return { ext, kind: 'binary' as const, text: '', size: info.size }
  }
  const buf = await readLocalBytes(filePath)
  const decoded = decodeTextBuffer(buf, MAX_TEXT_BYTES)
  return {
    ext,
    kind: 'text' as const,
    text: decoded.text,
    size: info.size,
    truncated: decoded.truncated
  }
})

// ── PTY (터미널) IPC ──
registerAgentIpc(ipcMain)

ipcMain.handle('pty:create', (e, opts: CreatePtyOptions) => {
  createPty(opts, e.sender)
})
ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) => writePty(id, data))
ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
  resizePty(id, cols, rows)
)
ipcMain.on('pty:detach', (e, { id }: { id: string }) => detachPty(id, e.sender))
ipcMain.on('pty:kill', (_e, { id }: { id: string }) => killPty(id))

app.on('before-quit', () => {
  disposeAgentSessions()
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
