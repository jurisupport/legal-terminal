import { app, BrowserWindow, shell, ipcMain, dialog, screen, session, Menu, clipboard, Notification, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { join, basename, dirname, extname, isAbsolute, resolve, sep, posix } from 'path'
import { readdir, readFile, stat, writeFile, copyFile, rm, mkdir, rename, cp } from 'fs/promises'
import { existsSync, watch, type Dirent, type FSWatcher } from 'fs'
import { fileURLToPath } from 'url'
import { inflateRawSync } from 'zlib'
import { getSettings, setSettings, type Settings } from './settings'
import { checkUpdate, compareVersions, fetchLatestRelease } from './update'
import { promptBundledSkillInstall } from './skillInstall'
import { imageInfo } from './imageSize'
import { keyStatus as dictationKeyStatus, setKey as setDictationKey, transcribe as transcribeDictation } from './dictation'
import {
  getPairing,
  setPairing,
  listHistory,
  addHistory,
  getJsPairing,
  setJsPairing
} from './caseStore'
import * as js from './jurisupport'
import {
  clearRemoteDirCache as clearRemotePickerDirCache,
  invalidateRemoteDirCacheForProfile,
  listRemoteDir,
  searchRemoteDirs,
  testSshConnection
} from './ssh'
import { remoteRcloneInfo, runRemoteSync, cancelSync, type RemoteSyncOpts } from './sync'
import { disposeSshControlMasters } from './sshOptions'
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
  clearRemoteDirCache as clearRemoteFsDirCache,
  disposeRemote,
  type RfsReadProgress
} from './remoteFs'
import type { SshProfile } from './settings'
import {
  currentSession,
  ensureRemoteCasePairingFresh,
  listFolderActivity,
  listSessions,
  listSessionsByCase,
  listWorkLog,
  readSessionTranscript,
  rememberSessionMeta,
  scheduleCasePairingPush,
  type SessionSearchContext
} from './sessions'
import type { CaseActivityQuery } from './caseActivityData'
import { extractHwpMarkdown, extractHwpText } from './hwpText'
import { createHwpxFromMarkdown } from './hwpxExport'
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
  loadAutomaticWorkspace,
  listWorkspaceSnapshots,
  loadWorkspaceSnapshot,
  saveAutomaticWorkspace,
  saveWorkspaceSnapshot,
  type AutomaticWorkspaceLocation,
  type WorkspaceSnapshot
} from './workspace'
import { disposeAgentSessions, registerAgentIpc } from './agent/agent-service'

let mainWindow: BrowserWindow | null = null
let updateCheckStarted = false
const dockBounceByWindow = new Map<number, number>()
// 터미널/에이전트별 OS 네이티브 알림 — 같은 터미널의 새 알림이 이전 것을 대체한다
const nativeNotifications = new Map<string, Notification>()
const forceClosingWindowIds = new Set<number>()
const GITHUB_PROJECT_URL = 'https://github.com/jurisupport/legal-terminal'
const DEFAULT_WINDOW_TITLE = 'legal-terminal'
let lastDownloadDir: string | undefined

function getAppIconPath(): string | undefined {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

function applyDockIcon(): void {
  const iconPath = getAppIconPath()
  if (iconPath && process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath)
}

async function checkForUpdates(win: BrowserWindow): Promise<void> {
  try {
    const release = await fetchLatestRelease()
    const latestVersion = release.tag_name?.replace(/^v/i, '')
    if (!latestVersion || compareVersions(latestVersion, app.getVersion()) <= 0) return

    const settings = await getSettings()
    if (settings.ignoredUpdateVersion === latestVersion) return

    const detail = [
      `현재 버전은 ${app.getVersion()}입니다.`,
      'GitHub 페이지에서 운영체제에 맞는 최신 설치 파일을 내려받아 업데이트해 주세요.'
    ].join('\n')

    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'legal-terminal 업데이트',
      message: `새 버전 ${latestVersion}을 사용할 수 있습니다.`,
      detail,
      buttons: ['GitHub 페이지 열기', '나중에', '이번 버전 다시 알리지 않기'],
      defaultId: 0,
      cancelId: 1
    })

    if (result.response === 0) {
      await shell.openExternal(GITHUB_PROJECT_URL)
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
    title: DEFAULT_WINDOW_TITLE,
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (setMain) mainWindow = win

  let closeGuardReady = false
  let lastRendererRecoveryAt = 0
  let rendererRecoveryRequested = false
  let unresponsiveDialogOpen = false

  win.on('focus', () => stopWindowAttention(win))
  win.on('close', (event) => {
    if (!closeGuardReady || forceClosingWindowIds.has(win.id) || win.webContents.isDestroyed()) return
    event.preventDefault()
    win.webContents.send('app:closeWindowRequested')
  })
  win.on('closed', () => {
    stopWindowAttention(win)
    forceClosingWindowIds.delete(win.id)
    if (mainWindow === win) mainWindow = null
  })

  // 입력란 우클릭 메뉴 — Electron은 기본 컨텍스트 메뉴가 없어 우클릭 붙여넣기가 안 된다.
  // (터미널처럼 렌더러가 contextmenu를 preventDefault한 곳에서는 이 이벤트가 오지 않는다.)
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', label: '실행 취소' },
          { type: 'separator' },
          { role: 'cut', label: '잘라내기' },
          { role: 'copy', label: '복사' },
          { role: 'paste', label: '붙여넣기' },
          { type: 'separator' },
          { role: 'selectAll', label: '모두 선택' }
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy', label: '복사' }]
        : []
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
  })

  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const isW = key === 'w' || input.code === 'KeyW'
    const closeTab =
      input.type === 'keyDown' &&
      process.platform === 'darwin' &&
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      isW
    const closeCaseTab =
      input.type === 'keyDown' &&
      (process.platform === 'darwin' ? input.meta && !input.control : input.control) &&
      (process.platform === 'darwin' ? !input.alt && input.shift : input.shift || input.alt) &&
      isW
    if (!closeTab && !closeCaseTab) return
    event.preventDefault()
    win.webContents.send(closeCaseTab ? 'app:closeActiveCaseTab' : 'app:closeActiveTab')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || forceClosingWindowIds.has(win.id)) return
    if (rendererRecoveryRequested) {
      rendererRecoveryRequested = false
      closeGuardReady = false
      lastRendererRecoveryAt = Date.now()
      win.webContents.reload()
      return
    }
    console.error(`[renderer] process gone: ${details.reason} (${details.exitCode})`)
    closeGuardReady = false

    const now = Date.now()
    if (now - lastRendererRecoveryAt >= 30_000) {
      lastRendererRecoveryAt = now
      win.webContents.reload()
      return
    }

    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'legal-terminal 화면 오류',
        message: '화면을 다시 불러오지 못했습니다.',
        detail: 'Renderer가 반복해서 종료되었습니다. 다시 시도하거나 창을 닫아 주세요.',
        buttons: ['다시 불러오기', '창 닫기'],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) {
          lastRendererRecoveryAt = Date.now()
          win.webContents.reload()
        } else {
          forceClosingWindowIds.add(win.id)
          win.close()
        }
      })
  })

  win.webContents.on('unresponsive', () => {
    if (unresponsiveDialogOpen || win.isDestroyed()) return
    unresponsiveDialogOpen = true
    console.error('[renderer] unresponsive')
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'legal-terminal 화면 멈춤',
        message: '화면이 응답하지 않습니다.',
        detail: '작업이 오래 걸리는 중일 수 있습니다. 잠시 기다리거나 화면을 다시 불러오세요.',
        buttons: ['기다리기', '다시 불러오기'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        unresponsiveDialogOpen = false
        if (response !== 1 || win.isDestroyed() || win.webContents.isDestroyed()) return
        closeGuardReady = false
        rendererRecoveryRequested = true
        win.webContents.forcefullyCrashRenderer()
      })
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
    if (setMain && !detached) {
      scheduleUpdateCheck(win)
      // 업데이트 대화상자와 겹치지 않게 잠시 뒤 번들 스킬 설치를 물어본다.
      setTimeout(() => {
        if (!win.isDestroyed()) void promptBundledSkillInstall(win)
      }, 8000)
    }
  }
  win.on('ready-to-show', revealWindow)
  win.webContents.on('did-finish-load', () => {
    closeGuardReady = true
    setTimeout(revealWindow, 0)
  })
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

interface TabPayload {
  kind?: 'doc' | 'terminal'
  path?: string
  title?: string
  side?: 'left' | 'right'
  tab?: unknown
}
interface NewWindowOptions {
  tabs?: TabPayload[]
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

// 새 창 (새 작업환경)
ipcMain.handle('window:new', (_e, opts?: NewWindowOptions) => {
  const win = createWindow(false)
  const tabs = Array.isArray(opts?.tabs) ? opts.tabs.filter(Boolean) : []
  if (tabs.length) pendingReceive.set(win.webContents.id, tabs)
})

ipcMain.handle('window:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win && !win.isDestroyed()) win.close()
})

ipcMain.handle('window:forceClose', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isDestroyed()) return
  forceClosingWindowIds.add(win.id)
  win.close()
})

ipcMain.on('app:requestAttention', (e, payload?: { reason?: 'done' | 'question' }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) requestWindowAttention(win, payload?.reason)
})

const nativeNotifyKey = (winId: number, termId: string): string => `${winId}:${termId}`

const dismissNativeNotification = (winId: number, termId: string): void => {
  const key = nativeNotifyKey(winId, termId)
  nativeNotifications.get(key)?.close()
  nativeNotifications.delete(key)
}

// OS 네이티브 알림(알림 센터). silent:false로 두어 소리·표시 여부를 OS(집중 모드 포함)가 결정한다.
ipcMain.on(
  'app:notify',
  (e, payload: { termId: string; title: string; body: string; urgency: 'done' | 'question' }) => {
    if (!Notification.isSupported()) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    const winId = win.id
    dismissNativeNotification(winId, payload.termId)
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
      urgency: payload.urgency === 'question' ? 'critical' : 'normal'
    })
    notification.on('click', () => {
      nativeNotifications.delete(nativeNotifyKey(winId, payload.termId))
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('app:notifyActivate', payload.termId)
    })
    notification.on('close', () => nativeNotifications.delete(nativeNotifyKey(winId, payload.termId)))
    nativeNotifications.set(nativeNotifyKey(winId, payload.termId), notification)
    notification.show()
  }
)

ipcMain.on('app:dismissNotify', (e, payload: { termId: string }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) dismissNativeNotification(win.id, payload.termId)
})

// 독 배지 숫자(미확인 완료/질문 개수). 창별 개수를 합산한다. macOS·Linux에서만 동작.
const badgeCountByWindow = new Map<number, number>()
ipcMain.on('app:setBadgeCount', (e, count: number) => {
  if (process.platform === 'win32') return
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isDestroyed()) return
  badgeCountByWindow.set(win.id, Number.isFinite(count) && count > 0 ? Math.floor(count) : 0)
  for (const id of badgeCountByWindow.keys()) {
    const target = BrowserWindow.fromId(id)
    if (!target || target.isDestroyed()) badgeCountByWindow.delete(id)
  }
  let total = 0
  for (const value of badgeCountByWindow.values()) total += value
  app.setBadgeCount(total)
})

ipcMain.handle('app:setWindowTitle', (e, title: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isDestroyed()) return
  const nextTitle = typeof title === 'string' && title.trim() ? title.trim() : DEFAULT_WINDOW_TITLE
  win.setTitle(nextTitle)
})

// 문서 전용(찢어낸) 창 등에서 'Claude에 물어보기' → 메인 창의 활성 터미널로 전달
ipcMain.handle('claude:ask', (_e, payload: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude:incoming', payload)
    mainWindow.focus()
  }
})

// ── 탭 드래그(창 간 이동/찢기) 조율 ──

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
ipcMain.handle('app:openHtml', async (_e, path: string) => {
  if (typeof path !== 'string' || !isAbsolute(path) || !/\.html?$/i.test(path)) {
    throw new Error('로컬 HTML 파일만 브라우저로 열 수 있습니다.')
  }
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
})

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
}))

// ── 수동 업데이트 확인 (설정화면) ──
ipcMain.handle('update:check', () => checkUpdate())

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

// 서면 푸터 로고 이미지 선택 — PNG/JPEG 검사까지 해서 경로를 돌려준다
ipcMain.handle('dialog:pickOfficeLogo', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const od: Electron.OpenDialogOptions = {
    title: '사무실 로고 이미지 선택 (PNG/JPEG)',
    properties: ['openFile'],
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg'] }]
  }
  const r = win ? await dialog.showOpenDialog(win, od) : await dialog.showOpenDialog(od)
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  try {
    const info = imageInfo(await readFile(path))
    if (!info) return { error: 'PNG 또는 JPEG 파일이 아닙니다.' }
    if ((await stat(path)).size > 3 * 1024 * 1024) return { error: '3MB 이하 이미지만 사용할 수 있습니다.' }
    return { path, name: basename(path), width: info.width, height: info.height }
  } catch {
    return { error: '이미지 파일을 읽지 못했습니다.' }
  }
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
ipcMain.handle('js:tokenStatus', () => js.tokenStatus())
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
ipcMain.handle('todo:list', async (_e, params: Record<string, unknown>) => {
  try {
    return { ok: true, todos: await js.listTodos(params ?? {}) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:get', async (_e, id: string) => {
  try {
    return { ok: true, todo: await js.getTodo(id) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:create', async (_e, input: js.TodoMutationInput) => {
  try {
    return { ok: true, todo: await js.createTodo(input) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:update', async (_e, p: { id: string; patch: js.TodoMutationInput }) => {
  try {
    return { ok: true, todo: await js.updateTodo(p.id, p.patch) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:complete', async (_e, p: { id: string; progressText?: string; context?: js.TodoTerminalContext }) => {
  try {
    return { ok: true, todo: await js.completeTodo(p.id, p.progressText, p.context) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:archive', async (_e, id: string) => {
  try {
    return { ok: true, todo: await js.archiveTodo(id) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:appendProgress', async (_e, p: { id: string; text: string; context?: js.TodoTerminalContext }) => {
  try {
    return { ok: true, todo: await js.appendTodoProgress(p.id, p.text, p.context) }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
})
ipcMain.handle('todo:applyTerminalCommand', async (_e, p: { command: string; context?: js.TodoTerminalContext }) => {
  try {
    return await js.applyTodoTerminalCommand(p.command, p.context)
  } catch (e) {
    return { ok: false, message: '[todo] 오류: ' + String(e instanceof Error ? e.message : e) }
  }
})

// ── SSH IPC ──
// 원격 디렉터리 목록 (사건 폴더 선택용). 키/agent 인증일 때만 성공(아니면 ok:false).
ipcMain.handle('ssh:listDir', (_e, p: { profile: SshProfile; path: string; refresh?: boolean }) =>
  listRemoteDir(p.profile, p.path, { refresh: !!p.refresh })
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
ipcMain.handle('ssh:test', (_e, profile: SshProfile) => testSshConnection(profile))
ipcMain.handle('ssh:clearDirCache', () => {
  clearRemotePickerDirCache()
  clearRemoteFsDirCache()
  return { ok: true }
})

// ── rclone 동기화 IPC (클라우드 경유: 맥에서 rclone 실행) ──
ipcMain.handle('sync:remoteInfo', (_e, profile: SshProfile) => remoteRcloneInfo(profile))
ipcMain.handle('sync:run', (e, opts: RemoteSyncOpts) => runRemoteSync(opts, e.sender))
ipcMain.on('sync:cancel', () => cancelSync())

// 사건 cwd의 현재 claude 세션 제목(transcript ai-title). since 이후 세션만.
ipcMain.handle('sessions:current', (_e, p: { cwd: string; since?: number; ssh?: SshProfile }) =>
  currentSession(p.cwd, p.since ?? 0, p.ssh)
)
ipcMain.handle(
  'sessions:list',
  (_e, p: { cwd: string; ssh?: SshProfile; context?: SessionSearchContext; limit?: number }) => {
    const limit = Number.isFinite(p.limit)
      ? Math.min(Math.max(Math.trunc(p.limit as number), 1), 1000)
      : 40
    return listSessions(p.cwd, limit, p.ssh, p.context)
  }
)
ipcMain.handle('sessions:transcript', (_e, p: { sessionId: string; ssh?: SshProfile }) =>
  readSessionTranscript(p.sessionId, p.ssh)
)
ipcMain.handle('sessions:remember', (_e, p: Parameters<typeof rememberSessionMeta>[0]) =>
  rememberSessionMeta(p)
)
// 사건 대시보드: 세션 인덱스를 사건별로 그룹핑한 최근 작업 이력
ipcMain.handle('sessions:byCase', (_e, q: CaseActivityQuery) => listSessionsByCase(q))
// 날짜별 작업일지: 최근 세션 전체 목록
ipcMain.handle('sessions:workLog', (_e, p: { days?: number } | undefined) => listWorkLog(p?.days))
// 사건 미연결 폴더 작업 그룹
ipcMain.handle('sessions:byFolder', (_e, q: CaseActivityQuery) => listFolderActivity(q))

// ── 작업환경 저장/복원 IPC ──
ipcMain.handle('workspace:save', (_e, snapshot: WorkspaceSnapshot) =>
  saveWorkspaceSnapshot(snapshot)
)
ipcMain.handle('workspace:list', () => listWorkspaceSnapshots())
ipcMain.handle('workspace:load', (_e, id?: string) => loadWorkspaceSnapshot(id))
ipcMain.handle(
  'workspace:autoSave',
  (_e, p: { snapshot: WorkspaceSnapshot; location: AutomaticWorkspaceLocation }) =>
    saveAutomaticWorkspace(p.snapshot, p.location)
)
ipcMain.handle('workspace:autoLoad', (_e, location: AutomaticWorkspaceLocation) =>
  loadAutomaticWorkspace(location)
)
ipcMain.handle('workspace:exportFile', async (e, snapshot: WorkspaceSnapshot) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = win
    ? await dialog.showSaveDialog(win, {
        title: '작업환경 내보내기',
        buttonLabel: '내보내기',
        defaultPath: 'legal-terminal-workspace.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        title: '작업환경 내보내기',
        buttonLabel: '내보내기',
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
        buttonLabel: '불러오기',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    : await dialog.showOpenDialog({
        title: '작업환경 가져오기',
        buttonLabel: '불러오기',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
  if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true, snapshot: null }
  return loadWorkspaceSnapshot(r.filePaths[0])
})

// ── 설정 IPC ──
const publicSettings = ({ jurisupportTokenEnc: _js, openaiApiKeyEnc: _openai, ...settings }: Settings) => settings
ipcMain.handle('settings:get', async () => publicSettings(await getSettings()))
ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
  const { jurisupportTokenEnc: _js, openaiApiKeyEnc: _openai, ...safePatch } = patch
  return publicSettings(await setSettings(safePatch))
})
ipcMain.handle('dictation:keyStatus', () => dictationKeyStatus())
ipcMain.handle('dictation:setKey', (_e, key: string) => setDictationKey(key))
ipcMain.handle('dictation:transcribe', (_e, input: { audio: Uint8Array; mimeType: string; context?: {
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  speaker?: string
} }) => transcribeDictation(input))

// ── 사건 페어링·히스토리 IPC ──
ipcMain.handle('case:getPairing', (_e, drafts: string) => getPairing(drafts))
ipcMain.handle('case:setPairing', (_e, p: { drafts: string; records: string }) =>
  setPairing(p.drafts, p.records)
)
ipcMain.handle('case:getJsPairing', async (_e, id: string) => {
  // 원격 사건이면 그 호스트와 먼저 동기화 — 다른 기기에서 지정한 폴더가 바로 보이게.
  await ensureRemoteCasePairingFresh(id)
  return getJsPairing(id)
})
ipcMain.handle('case:setJsPairing', async (_e, p: { id: string; drafts: string; records?: string }) => {
  await setJsPairing(p.id, { drafts: p.drafts, records: p.records })
  void scheduleCasePairingPush(p.id)
})
ipcMain.handle('case:history', () => listHistory())
ipcMain.handle('case:addHistory', (_e, entry: { drafts: string; records?: string; name: string }) =>
  addHistory(entry)
)

// ── 파일시스템 IPC (탐색기) ──
const TEXT_EXT = new Set([
  '.md', '.mdx', '.txt', '.json', '.csv', '.log', '.yml', '.yaml', '.html', '.htm', '.xml',
  '.js', '.ts', '.tsx', '.css', '.py', '.sh', '.ini', '.toml'
])
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2MB 초과 텍스트는 잘라서 안내
const DOCUMENT_DRAFT_DIR = 'document-drafts'
const DOCUMENT_DRAFT_HISTORY_VERSION = 1
const DOCUMENT_DRAFT_HISTORY_LIMIT = 50
const DOCUMENT_DRAFT_HISTORY_COALESCE_MS = 30_000
const LOCAL_CLOUD_READ_TIMEOUT_MS = 45_000
const LOCAL_CLOUD_HYDRATE_TIMEOUT_MS = 180_000
const LOCAL_CLOUD_FOLDER_HYDRATE_TIMEOUT_MS = 8_000
const LOCAL_CLOUD_FOLDER_HYDRATE_KICK_MS = 2_000
const localPrefetching = new Set<string>()
const localPrefetchedAt = new Map<string, number>()
const fsWatchers = new Map<
  string,
  { watcher: FSWatcher; timer?: NodeJS.Timeout; sender: WebContents }
>()

interface DocumentDraftInput {
  path?: string
  draftId?: string
}

interface DocumentDraftSaveInput extends DocumentDraftInput {
  title?: string
  content: string
}

interface DocumentDraftEntry {
  key: string
  path?: string
  draftId?: string
  title: string
  content: string
  savedAt: string
}

interface DocumentDraftHistoryEntry {
  id: string
  key: string
  path?: string
  draftId?: string
  title: string
  content: string
  savedAt: string
}

function closeFsWatcher(key: string): void {
  const item = fsWatchers.get(key)
  if (!item) return
  if (item.timer) clearTimeout(item.timer)
  item.watcher.close()
  fsWatchers.delete(key)
}

function closeFsWatchersForSender(sender: WebContents): void {
  for (const [key, item] of fsWatchers) {
    if (item.sender.id === sender.id) closeFsWatcher(key)
  }
}

function startFsWatcher(sender: WebContents, id: string, dir: string): void {
  if (!id || !dir || isRemote(dir)) return
  const key = `${sender.id}:${id}`
  closeFsWatcher(key)

  const sendChanged = (eventType?: string, filename?: string | Buffer | null): void => {
    const item = fsWatchers.get(key)
    if (!item) return
    if (item.timer) clearTimeout(item.timer)
    const changedPath = filename ? join(dir, filename.toString()) : undefined
    item.timer = setTimeout(() => {
      if (!sender.isDestroyed()) sender.send('fs:changed', { id, dir, path: changedPath, eventType })
    }, 150)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(dir, { recursive: true }, sendChanged)
  } catch {
    try {
      watcher = watch(dir, sendChanged)
    } catch {
      return
    }
  }

  fsWatchers.set(key, { watcher, sender })
  watcher.on('error', () => closeFsWatcher(key))
  sender.once('destroyed', () => closeFsWatchersForSender(sender))
}

interface FileSignature {
  size: number
  mtimeMs?: number
}

function fileSignatureOf(value: { size: number; mtimeMs?: number }): FileSignature {
  return { size: value.size, mtimeMs: value.mtimeMs }
}

function sameFileSignature(a?: FileSignature, b?: FileSignature): boolean {
  if (!a || !b) return false
  return a.size === b.size && Math.abs((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) < 1
}

async function statFileSignature(filePath: string): Promise<FileSignature> {
  if (isRemote(filePath)) return fileSignatureOf(await rfsStat(filePath))
  return fileSignatureOf(await stat(filePath))
}

function documentDraftRoot(): string {
  return join(app.getPath('userData'), DOCUMENT_DRAFT_DIR)
}

function documentDraftKey(input: DocumentDraftInput): string {
  const source = input.path ? `path:${input.path}` : `draft:${input.draftId ?? 'untitled'}`
  return createHash('sha256').update(source).digest('hex')
}

function documentDraftPath(input: DocumentDraftInput): string {
  return join(documentDraftRoot(), `${documentDraftKey(input)}.json`)
}

function documentDraftHistoryPath(input: DocumentDraftInput): string {
  return join(documentDraftRoot(), `${documentDraftKey(input)}.history.json`)
}

function normalizeDocumentDraft(raw: unknown, key: string): DocumentDraftEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<DocumentDraftEntry>
  if (typeof item.content !== 'string') return null
  return {
    key,
    path: typeof item.path === 'string' ? item.path : undefined,
    draftId: typeof item.draftId === 'string' ? item.draftId : undefined,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : '무제.md',
    content: item.content,
    savedAt: typeof item.savedAt === 'string' ? item.savedAt : new Date(0).toISOString()
  }
}

function documentDraftHistoryEntryId(savedAt: string, content: string): string {
  return createHash('sha1').update(`${savedAt}\0${content}`).digest('hex').slice(0, 16)
}

function documentDraftToHistoryEntry(entry: DocumentDraftEntry): DocumentDraftHistoryEntry {
  return {
    id: documentDraftHistoryEntryId(entry.savedAt, entry.content),
    key: entry.key,
    path: entry.path,
    draftId: entry.draftId,
    title: entry.title,
    content: entry.content,
    savedAt: entry.savedAt
  }
}

function normalizeDocumentDraftHistoryEntry(raw: unknown, key: string): DocumentDraftHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<DocumentDraftHistoryEntry>
  if (typeof item.content !== 'string') return null
  const savedAt = typeof item.savedAt === 'string' ? item.savedAt : new Date(0).toISOString()
  return {
    id:
      typeof item.id === 'string' && item.id
        ? item.id
        : documentDraftHistoryEntryId(savedAt, item.content),
    key,
    path: typeof item.path === 'string' ? item.path : undefined,
    draftId: typeof item.draftId === 'string' ? item.draftId : undefined,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : '무제.md',
    content: item.content,
    savedAt
  }
}

async function readDocumentDraftHistory(input: DocumentDraftInput): Promise<DocumentDraftHistoryEntry[]> {
  try {
    const key = documentDraftKey(input)
    const raw = JSON.parse(await readFile(documentDraftHistoryPath(input), 'utf8')) as unknown
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
        ? (raw as { entries: unknown[] }).entries
        : []
    return entries
      .map((entry) => normalizeDocumentDraftHistoryEntry(entry, key))
      .filter((entry): entry is DocumentDraftHistoryEntry => !!entry)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, DOCUMENT_DRAFT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

async function writeDocumentDraftHistory(
  input: DocumentDraftInput,
  entries: DocumentDraftHistoryEntry[]
): Promise<void> {
  const root = documentDraftRoot()
  await mkdir(root, { recursive: true })
  const file = documentDraftHistoryPath(input)
  const tmp = join(root, `.${documentDraftKey(input)}.history.${Date.now()}.tmp`)
  await writeFile(
    tmp,
    JSON.stringify({ version: DOCUMENT_DRAFT_HISTORY_VERSION, entries }, null, 2),
    'utf8'
  )
  await rename(tmp, file)
}

async function appendDocumentDraftHistory(entry: DocumentDraftEntry): Promise<void> {
  const input: DocumentDraftInput = { path: entry.path, draftId: entry.draftId }
  const nextEntry = documentDraftToHistoryEntry(entry)
  const history = await readDocumentDraftHistory(input)
  const head = history[0]
  const rest = history.slice(1)
  let entries: DocumentDraftHistoryEntry[]

  if (!head) {
    entries = [nextEntry]
  } else if (
    head.content === nextEntry.content ||
    Date.parse(nextEntry.savedAt) - Date.parse(head.savedAt) < DOCUMENT_DRAFT_HISTORY_COALESCE_MS
  ) {
    entries = [nextEntry, ...rest]
  } else {
    entries = [nextEntry, ...history]
  }

  await writeDocumentDraftHistory(input, entries.slice(0, DOCUMENT_DRAFT_HISTORY_LIMIT))
}

async function addDocumentDraftHistory(input: DocumentDraftSaveInput): Promise<DocumentDraftHistoryEntry> {
  const entry = documentDraftToHistoryEntry({
    key: documentDraftKey(input),
    path: input.path,
    draftId: input.draftId,
    title: input.title?.trim() || (input.path ? basename(input.path) : '무제.md'),
    content: input.content,
    savedAt: new Date().toISOString()
  })
  const history = await readDocumentDraftHistory(input)
  const entries = [
    entry,
    ...history.filter((item) => item.title !== entry.title || item.content !== entry.content)
  ]
  await writeDocumentDraftHistory(input, entries.slice(0, DOCUMENT_DRAFT_HISTORY_LIMIT))
  return entry
}

async function saveDocumentDraft(input: DocumentDraftSaveInput): Promise<DocumentDraftEntry> {
  const key = documentDraftKey(input)
  const entry: DocumentDraftEntry = {
    key,
    path: input.path,
    draftId: input.draftId,
    title: input.title?.trim() || (input.path ? basename(input.path) : '무제.md'),
    content: input.content,
    savedAt: new Date().toISOString()
  }
  const root = documentDraftRoot()
  await mkdir(root, { recursive: true })
  const file = join(root, `${key}.json`)
  const tmp = join(root, `.${key}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(entry), 'utf8')
  await rename(tmp, file)
  await appendDocumentDraftHistory(entry).catch(() => {})
  return entry
}

async function loadDocumentDraft(input: DocumentDraftInput): Promise<DocumentDraftEntry | null> {
  try {
    const key = documentDraftKey(input)
    const raw = JSON.parse(await readFile(documentDraftPath(input), 'utf8')) as unknown
    return normalizeDocumentDraft(raw, key)
  } catch {
    return null
  }
}

async function deleteDocumentDraft(input: DocumentDraftInput): Promise<void> {
  await rm(documentDraftPath(input), { force: true })
}

async function listDocumentDrafts(): Promise<DocumentDraftEntry[]> {
  try {
    const root = documentDraftRoot()
    const files = await readdir(root, { withFileTypes: true })
    const drafts = await Promise.all(
      files
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.history.json'))
        .map(async (entry) => {
          const key = entry.name.slice(0, -'.json'.length)
          try {
            const raw = JSON.parse(await readFile(join(root, entry.name), 'utf8')) as unknown
            return normalizeDocumentDraft(raw, key)
          } catch {
            return null
          }
        })
    )
    return drafts
      .filter((entry): entry is DocumentDraftEntry => !!entry)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return []
  }
}

async function listDocumentDraftHistory(input: DocumentDraftInput): Promise<DocumentDraftHistoryEntry[]> {
  const latest = await loadDocumentDraft(input)
  const history = await readDocumentDraftHistory(input)
  const merged: DocumentDraftHistoryEntry[] = []
  const seen = new Set<string>()
  const push = (entry: DocumentDraftHistoryEntry): void => {
    const dedupeKey = `${entry.savedAt}\0${entry.content}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    merged.push(entry)
  }

  if (latest) push(documentDraftToHistoryEntry(latest))
  history.forEach(push)
  return merged.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, DOCUMENT_DRAFT_HISTORY_LIMIT)
}

interface ZipEntry {
  name: string
  compression: number
  compressedSize: number
  localHeaderOffset: number
}

function findZipEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('DOCX ZIP 중앙 디렉터리를 찾지 못했습니다.')
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findZipEndOfCentralDirectory(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break
    const compression = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, compression, compressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`DOCX 항목을 읽지 못했습니다: ${entry.name}`)
  }
  const nameLength = buf.readUInt16LE(offset + 26)
  const extraLength = buf.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.compression === 0) return Buffer.from(data)
  if (entry.compression === 8) return inflateRawSync(data)
  throw new Error(`지원하지 않는 DOCX 압축 방식입니다: ${entry.compression}`)
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
      entity.toLowerCase()
    ] ?? match
  })
}

function extractDocxText(buf: Buffer): string {
  const entries = readZipEntries(buf)
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml')
  if (!documentEntry) throw new Error('DOCX 본문(word/document.xml)을 찾지 못했습니다.')
  const xml = readZipEntry(buf, documentEntry).toString('utf8')
  const out: string[] = []
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:tc>|<\/w:p>/g
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(xml))) {
    if (match[1] !== undefined) out.push(decodeXmlEntities(match[1]))
    else if (match[0].startsWith('<w:tab') || match[0] === '</w:tc>') out.push('\t')
    else out.push('\n')
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

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

function invalidateRemotePickerCache(uri: string): void {
  if (!isRemote(uri)) return
  const { profileId, path } = parseRemote(uri)
  invalidateRemoteDirCacheForProfile(profileId, path)
}

function invalidateRemotePickerParentCache(uri: string): void {
  if (!isRemote(uri)) return
  const { profileId, path } = parseRemote(uri)
  invalidateRemoteDirCacheForProfile(profileId, posix.dirname(path))
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

async function getDownloadDefaultDir(): Promise<string> {
  const candidate = lastDownloadDir ?? (await getSettings()).lastDownloadDir
  if (candidate) {
    try {
      const st = await stat(candidate)
      if (st.isDirectory()) return candidate
    } catch {
      /* 설정에 남은 폴더가 사라졌으면 기본 다운로드 폴더로 되돌린다. */
    }
  }
  return app.getPath('downloads')
}

function rememberDownloadDir(dir: string): void {
  lastDownloadDir = dir
  void setSettings({ lastDownloadDir: dir }).catch(() => {})
}

interface AutoDownloadRecordsResult {
  ok: boolean
  path?: string
  count?: number
  downloaded?: number
  skipped?: number
  failed?: number
  inProgress?: boolean
  error?: string
}

const recordsAutoDownloadInFlight = new Map<string, Promise<AutoDownloadRecordsResult>>()

interface AutoRecordDownloadFile {
  source: string
  destPath: string
  label: string
}

function safeLocalPathSegment(value: string, fallback = 'download'): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return (cleaned || fallback).slice(0, 120)
}

function autoRecordsCacheDir(sourceUri: string): string {
  const { path } = parseRemote(sourceUri)
  const leaf = safeLocalPathSegment(posix.basename(path) || '소송기록', '소송기록')
  const hash = createHash('sha1').update(sourceUri.normalize('NFC')).digest('hex').slice(0, 10)
  return join(app.getPath('downloads'), 'legal-terminal', '소송기록', `${leaf}-${hash}`)
}

function localPathForRemoteRecord(destRoot: string, sourceUri: string, fileUri: string): string {
  const source = parseRemote(sourceUri)
  const file = parseRemote(fileUri)
  const sourceRoot = source.path.replace(/\/+$/, '') || '/'
  const rel =
    source.profileId === file.profileId && file.path.startsWith(sourceRoot + '/')
      ? file.path.slice(sourceRoot.length + 1)
      : posix.basename(file.path)
  const parts = rel.split('/').filter(Boolean).map((p) => safeLocalPathSegment(p))
  return join(destRoot, ...(parts.length ? parts : [safeLocalPathSegment(posix.basename(file.path))]))
}

async function hasUsableLocalCopy(path: string): Promise<boolean> {
  try {
    const st = await stat(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

async function writeRecordCopy(dest: string, data: Buffer): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.${basename(dest)}.${Date.now()}.tmp`)
  await writeFile(tmp, data)
  await rename(tmp, dest)
}

async function autoDownloadRemoteRecords(
  sourceUri: string,
  sender?: WebContents
): Promise<AutoDownloadRecordsResult> {
  if (!isRemote(sourceUri)) {
    return { ok: false, error: '원격 소송기록 폴더만 자동 다운로드할 수 있습니다.' }
  }
  const key = sourceUri.normalize('NFC')
  const destRoot = autoRecordsCacheDir(sourceUri)
  if (recordsAutoDownloadInFlight.has(key)) {
    return { ok: true, path: destRoot, inProgress: true, downloaded: 0, skipped: 0 }
  }

  const task = (async (): Promise<AutoDownloadRecordsResult> => {
    await mkdir(destRoot, { recursive: true })
    const files = await rfsListPdfs(sourceUri)
    const progressBase: DownloadProgressBase | undefined = sender
      ? {
          id: createDownloadId(),
          source: sourceUri,
          name: `${remoteBasename(sourceUri)} 소송기록`,
          isDir: true
        }
      : undefined
    const emitProgress = (update: DownloadProgressUpdate): void => {
      if (!sender || !progressBase) return
      sendDownloadProgress(sender, progressBase, update)
    }
    const pending: AutoRecordDownloadFile[] = []
    let downloaded = 0
    let skipped = 0
    let failed = 0
    for (const file of files) {
      const dest = localPathForRemoteRecord(destRoot, sourceUri, file.path)
      if (await hasUsableLocalCopy(dest)) {
        skipped += 1
        continue
      }
      pending.push({ source: file.path, destPath: dest, label: file.name })
    }

    if (pending.length === 0) {
      return {
        ok: true,
        path: destRoot,
        count: files.length,
        downloaded,
        skipped,
        failed
      }
    }

    emitProgress({
      phase: 'preparing',
      totalFiles: pending.length,
      completedFiles: 0,
      destPath: destRoot
    })

    let completedFiles = 0
    for (const file of pending) {
      emitProgress({
        phase: 'downloading',
        totalFiles: pending.length,
        completedFiles,
        currentFile: file.label,
        destPath: destRoot
      })
      try {
        await writeRecordCopy(
          file.destPath,
          await rfsReadBytes(file.source, (progress) =>
            emitProgress({
              phase: 'downloading',
              totalFiles: pending.length,
              completedFiles,
              currentFile: file.label,
              destPath: destRoot,
              totalBytes: progress.totalBytes,
              downloadedBytes: progress.downloadedBytes
            })
          )
        )
        downloaded += 1
      } catch {
        failed += 1
      } finally {
        completedFiles += 1
        emitProgress({
          phase: 'downloading',
          totalFiles: pending.length,
          completedFiles,
          currentFile: file.label,
          destPath: destRoot
        })
      }
    }

    if (failed > 0) {
      emitProgress({
        phase: 'error',
        totalFiles: pending.length,
        completedFiles,
        destPath: destRoot,
        error: `소송기록 PDF ${failed}개를 다운로드하지 못했습니다.`
      })
    } else {
      emitProgress({
        phase: 'done',
        totalFiles: pending.length,
        completedFiles,
        destPath: destRoot
      })
    }

    return {
      ok: failed === 0 || downloaded > 0 || skipped > 0,
      path: destRoot,
      count: files.length,
      downloaded,
      skipped,
      failed,
      error: failed > 0 ? `소송기록 PDF ${failed}개를 다운로드하지 못했습니다.` : undefined
    }
  })()

  recordsAutoDownloadInFlight.set(key, task)
  try {
    return await task
  } finally {
    recordsAutoDownloadInFlight.delete(key)
  }
}

type DownloadProgressPhase = 'preparing' | 'downloading' | 'done' | 'error'

interface RemoteDownloadPlanFile {
  source: string
  destPath: string
  label: string
}

interface RemoteDownloadPlan {
  dirs: string[]
  files: RemoteDownloadPlanFile[]
}

interface DownloadProgressBase {
  id: string
  source: string
  name: string
  isDir: boolean
}

interface DownloadProgressUpdate {
  phase: DownloadProgressPhase
  totalFiles?: number
  completedFiles?: number
  totalBytes?: number
  downloadedBytes?: number
  currentFile?: string
  destPath?: string
  error?: string
}

function createDownloadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sendDownloadProgress(
  sender: WebContents,
  base: DownloadProgressBase,
  update: DownloadProgressUpdate
): void {
  if (sender.isDestroyed()) return
  sender.send('fs:downloadProgress', {
    ...base,
    totalFiles: 0,
    completedFiles: 0,
    ...update
  })
}

async function readRemoteBytesWithProgress(sender: WebContents, filePath: string): Promise<Buffer> {
  const base: DownloadProgressBase = {
    id: createDownloadId(),
    source: filePath,
    name: remoteBasename(filePath),
    isDir: false
  }
  let started = false
  let sentBytes = 0
  const onProgress = (progress: RfsReadProgress): void => {
    started = true
    sentBytes = Math.max(sentBytes, progress.downloadedBytes)
    sendDownloadProgress(sender, base, {
      phase: 'downloading',
      totalFiles: 1,
      completedFiles: 0,
      currentFile: base.name,
      totalBytes: progress.totalBytes,
      downloadedBytes: sentBytes
    })
  }
  try {
    const buf = await rfsReadBytes(filePath, onProgress)
    if (started) {
      sendDownloadProgress(sender, base, {
        phase: 'done',
        totalFiles: 1,
        completedFiles: 1,
        currentFile: base.name,
        totalBytes: buf.byteLength,
        downloadedBytes: buf.byteLength
      })
    }
    return buf
  } catch (error) {
    if (started) {
      sendDownloadProgress(sender, base, {
        phase: 'error',
        error: String(error),
        totalFiles: 1,
        completedFiles: 0,
        currentFile: base.name,
        downloadedBytes: sentBytes
      })
    }
    throw error
  }
}

async function collectRemoteDownloadPlan(srcUri: string, destPath: string): Promise<RemoteDownloadPlan> {
  const st = await rfsStat(srcUri)
  if (!st.isDir) {
    return {
      dirs: [],
      files: [{ source: srcUri, destPath, label: remoteBasename(srcUri) }]
    }
  }

  const plan: RemoteDownloadPlan = { dirs: [destPath], files: [] }
  await collectRemoteFolderDownloadPlan(srcUri, destPath, '', plan)
  return plan
}

async function collectRemoteFolderDownloadPlan(
  srcUri: string,
  destPath: string,
  relativeDir: string,
  plan: RemoteDownloadPlan
): Promise<void> {
  for (const entry of await rfsList(srcUri)) {
    const childDest = join(destPath, entry.name)
    const childLabel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isDir) {
      plan.dirs.push(childDest)
      await collectRemoteFolderDownloadPlan(entry.path, childDest, childLabel, plan)
    } else {
      plan.files.push({ source: entry.path, destPath: childDest, label: childLabel })
    }
  }
}

async function downloadRemoteToLocalWithProgress(
  srcUri: string,
  destPath: string,
  onProgress: (update: DownloadProgressUpdate) => void
): Promise<number> {
  const plan = await collectRemoteDownloadPlan(srcUri, destPath)
  return downloadRemotePlanWithProgress(plan, destPath, onProgress)
}

async function downloadRemotePlanWithProgress(
  plan: RemoteDownloadPlan,
  destPath: string,
  onProgress: (update: DownloadProgressUpdate) => void
): Promise<number> {
  const totalFiles = plan.files.length
  onProgress({ phase: 'downloading', totalFiles, completedFiles: 0, destPath })

  for (const dir of plan.dirs) await mkdir(dir, { recursive: true })

  let completedFiles = 0
  for (const file of plan.files) {
    onProgress({
      phase: 'downloading',
      totalFiles,
      completedFiles,
      currentFile: file.label,
      destPath
    })
    await mkdir(dirname(file.destPath), { recursive: true })
    await writeFile(
      file.destPath,
      await rfsReadBytes(file.source, (progress) =>
        onProgress({
          phase: 'downloading',
          totalFiles,
          completedFiles,
          currentFile: file.label,
          destPath,
          totalBytes: progress.totalBytes,
          downloadedBytes: progress.downloadedBytes
        })
      )
    )
    completedFiles += 1
    onProgress({
      phase: 'downloading',
      totalFiles,
      completedFiles,
      currentFile: file.label,
      destPath
    })
  }

  return totalFiles
}

ipcMain.handle('fs:mkdir', async (_e, p: { dir: string; name: string }) => {
  try {
    if (isRemote(p.dir)) {
      await rfsMkdir(p.dir, p.name)
      invalidateRemotePickerCache(p.dir)
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
    if (isRemote(p)) {
      await rfsDelete(p)
      invalidateRemotePickerParentCache(p)
      invalidateRemotePickerCache(p)
    } else await rm(p, { recursive: true, force: true })
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
    if (isRemote(p.path)) {
      const result = await rfsRename(p.path, name)
      if (result.ok) {
        invalidateRemotePickerParentCache(p.path)
        invalidateRemotePickerCache(p.path)
        if (result.path) invalidateRemotePickerCache(result.path)
      }
      return result
    }
    const dest = join(dirname(p.path), name)
    if (dest === p.path) return { ok: true, path: p.path }
    if (existsSync(dest)) return { ok: false, error: '같은 이름이 이미 있습니다.' }
    await rename(p.path, dest)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:list', async (_e, dirPath: string, opts?: { refresh?: boolean }) => {
  if (isRemote(dirPath)) return rfsList(dirPath, { refresh: !!opts?.refresh })
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

ipcMain.on('fs:watch', (e, p: { id: string; dir: string }) => {
  startFsWatcher(e.sender, p.id, p.dir)
})

ipcMain.on('fs:unwatch', (e, id: string) => {
  closeFsWatcher(`${e.sender.id}:${id}`)
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

// 스크린샷 등 경로 없는 클립보드 이미지를 임시 파일로 저장해 첨부 가능한 경로로 만든다
ipcMain.handle('fs:saveClipboardImage', async (_e, p: { data: Uint8Array; mimeType?: string }) => {
  const data = Buffer.from(p.data)
  if (data.byteLength === 0) throw new Error('클립보드 이미지 데이터가 비어 있습니다.')
  const extByMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
  }
  const ext = extByMime[(p.mimeType ?? '').toLowerCase()] ?? 'png'
  const dir = join(app.getPath('temp'), 'legal-terminal-clipboard')
  await mkdir(dir, { recursive: true })
  const stamp = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const name = `클립보드이미지-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${Math.random().toString(36).slice(2, 6)}.${ext}`
  const filePath = join(dir, name)
  await writeFile(filePath, data)
  return { path: filePath }
})

ipcMain.handle('fs:readBytes', async (event, filePath: string) => {
  try {
    const buf = isRemote(filePath)
      ? await readRemoteBytesWithProgress(event.sender, filePath)
      : await readLocalBytes(filePath)
    // 렌더러로 ArrayBuffer 전달 (pdf.js 입력용)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${isRemote(filePath) ? '원격 파일 읽기 실패' : '파일 읽기 실패'}: ${msg}`)
  }
})

// HWP/HWPX 텍스트만 추출 — 이미지/표 등 서식은 무시하고 본문 텍스트만
ipcMain.handle('fs:readHwpText', async (event, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  try {
    const buf = isRemote(filePath)
      ? await readRemoteBytesWithProgress(event.sender, filePath)
      : await readLocalBytes(filePath)
    return { ok: true, text: extractHwpText(buf, ext) }
  } catch (e) {
    return { ok: false, text: '', error: 'HWP/HWPX 파싱 실패: ' + String(e) }
  }
})

// HWP/HWPX 본문과 표를 Markdown으로 추출
ipcMain.handle('fs:readHwpMarkdown', async (event, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  try {
    const buf = isRemote(filePath)
      ? await readRemoteBytesWithProgress(event.sender, filePath)
      : await readLocalBytes(filePath)
    return { ok: true, markdown: extractHwpMarkdown(buf, ext) }
  } catch (e) {
    return { ok: false, markdown: '', error: 'HWP/HWPX Markdown 추출 실패: ' + String(e) }
  }
})

ipcMain.handle('fs:readDocxText', async (event, filePath: string) => {
  try {
    const buf = isRemote(filePath)
      ? await readRemoteBytesWithProgress(event.sender, filePath)
      : await readLocalBytes(filePath)
    return { ok: true, text: extractDocxText(buf) }
  } catch (e) {
    return { ok: false, text: '', error: 'DOCX 텍스트 추출 실패: ' + String(e) }
  }
})

ipcMain.handle('fs:saveDocumentDraft', async (_e, input: DocumentDraftSaveInput) => {
  try {
    const entry = await saveDocumentDraft(input)
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:addDocumentDraftHistory', async (_e, input: DocumentDraftSaveInput) => {
  try {
    const entry = await addDocumentDraftHistory(input)
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:loadDocumentDraft', async (_e, input: DocumentDraftInput) => {
  try {
    return { ok: true, draft: await loadDocumentDraft(input) }
  } catch (e) {
    return { ok: false, draft: null, error: String(e) }
  }
})

ipcMain.handle('fs:listDocumentDrafts', async () => {
  try {
    return { ok: true, drafts: await listDocumentDrafts() }
  } catch (e) {
    return { ok: false, drafts: [], error: String(e) }
  }
})

ipcMain.handle('fs:listDocumentDraftHistory', async (_e, input: DocumentDraftInput) => {
  try {
    return { ok: true, history: await listDocumentDraftHistory(input) }
  } catch (e) {
    return { ok: false, history: [], error: String(e) }
  }
})

ipcMain.handle('fs:deleteDocumentDraft', async (_e, input: DocumentDraftInput) => {
  try {
    await deleteDocumentDraft(input)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// 트리 내부 이동 (탐색기 드래그앤드롭) — 같은 드라이브면 rename, 아니면 복사 후 삭제
ipcMain.handle('fs:move', async (_e, p: { src: string; destDir: string }) => {
  try {
    if (isRemote(p.src) || isRemote(p.destDir)) {
      const result = await rfsMove(p.src, p.destDir)
      if (result.ok) {
        invalidateRemotePickerParentCache(p.src)
        invalidateRemotePickerCache(p.src)
        invalidateRemotePickerCache(p.destDir)
        if (result.path) invalidateRemotePickerCache(result.path)
      }
      return result
    }
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
  if (remote && copied.length > 0) invalidateRemotePickerCache(p.destDir)
  return { copied }
})

ipcMain.handle('fs:download', async (event, input: string | string[]) => {
  if (!mainWindow) return { ok: false, error: '메인 창을 찾을 수 없습니다.' }
  const sources = [
    ...new Set(
      (Array.isArray(input) ? input : [input]).filter(
        (source): source is string => typeof source === 'string' && source.length > 0
      )
    )
  ]
  if (sources.length === 0) return { ok: false, error: '다운로드할 항목이 없습니다.' }
  if (sources.length > 1) {
    if (!sources.every(isRemote)) {
      return { ok: false, error: '여러 항목 다운로드는 원격 파일과 폴더만 지원합니다.' }
    }
    const progressBase: DownloadProgressBase = {
      id: createDownloadId(),
      source: sources[0],
      name: `선택한 ${sources.length}개 항목`,
      isDir: true
    }
    try {
      const defaultDownloadDir = await getDownloadDefaultDir()
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '선택한 항목 다운로드 위치',
        defaultPath: defaultDownloadDir,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      const destDir = result.filePaths[0]
      rememberDownloadDir(destDir)
      sendDownloadProgress(event.sender, progressBase, { phase: 'preparing', destPath: destDir })
      const plans = await Promise.all(
        sources.map((source) => collectRemoteDownloadPlan(source, join(destDir, remoteBasename(source))))
      )
      const plan: RemoteDownloadPlan = {
        dirs: [...new Set(plans.flatMap((item) => item.dirs))],
        files: plans.flatMap((item) => item.files)
      }
      const count = await downloadRemotePlanWithProgress(plan, destDir, (update) =>
        sendDownloadProgress(event.sender, progressBase, update)
      )
      sendDownloadProgress(event.sender, progressBase, {
        phase: 'done',
        totalFiles: count,
        completedFiles: count,
        destPath: destDir
      })
      return { ok: true, path: destDir, count }
    } catch (error) {
      sendDownloadProgress(event.sender, progressBase, { phase: 'error', error: String(error) })
      return { ok: false, error: String(error) }
    }
  }
  const source = sources[0]
  if (!isRemote(source)) {
    // 로컬 파일(자동 다운로드된 소송기록 캐시 등)은 '원하는 위치에 사본 저장'으로 동작한다.
    try {
      const st = await stat(source)
      if (st.isDirectory()) return { ok: false, error: '로컬 폴더는 사본 저장을 지원하지 않습니다.' }
      const r = await dialog.showSaveDialog(mainWindow, {
        title: '내 컴퓨터에 저장',
        defaultPath: join(await getDownloadDefaultDir(), basename(source))
      })
      if (r.canceled || !r.filePath) return { ok: true, canceled: true }
      rememberDownloadDir(dirname(r.filePath))
      await copyFile(source, r.filePath)
      shell.showItemInFolder(r.filePath)
      return { ok: true, path: r.filePath, count: 1 }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }
  let progressBase: DownloadProgressBase | undefined
  try {
    const st = await rfsStat(source)
    const name = remoteBasename(source)
    progressBase = { id: createDownloadId(), source, name, isDir: st.isDir }
    const defaultDownloadDir = await getDownloadDefaultDir()
    if (st.isDir) {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '원격 폴더 다운로드 위치',
        defaultPath: defaultDownloadDir,
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true }
      const selectedDir = r.filePaths[0]
      rememberDownloadDir(selectedDir)
      const path = join(selectedDir, name)
      sendDownloadProgress(event.sender, progressBase, { phase: 'preparing', destPath: path })
      const count = await downloadRemoteToLocalWithProgress(source, path, (update) =>
        sendDownloadProgress(event.sender, progressBase as DownloadProgressBase, update)
      )
      sendDownloadProgress(event.sender, progressBase, {
        phase: 'done',
        totalFiles: count,
        completedFiles: count,
        destPath: path
      })
      return { ok: true, path, count }
    }
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '원격 파일 다운로드',
      defaultPath: join(defaultDownloadDir, name)
    })
    if (r.canceled || !r.filePath) return { ok: true, canceled: true }
    rememberDownloadDir(dirname(r.filePath))
    sendDownloadProgress(event.sender, progressBase, {
      phase: 'downloading',
      totalFiles: 1,
      completedFiles: 0,
      currentFile: name,
      destPath: r.filePath
    })
    const count = await downloadRemoteToLocalWithProgress(source, r.filePath, (update) =>
      sendDownloadProgress(event.sender, progressBase as DownloadProgressBase, update)
    )
    sendDownloadProgress(event.sender, progressBase, {
      phase: 'done',
      totalFiles: count,
      completedFiles: count,
      currentFile: name,
      destPath: r.filePath
    })
    return { ok: true, path: r.filePath, count }
  } catch (error) {
    if (progressBase) {
      sendDownloadProgress(event.sender, progressBase, {
        phase: 'error',
        error: String(error)
      })
    }
    return { ok: false, error: String(error) }
  }
})

ipcMain.handle('fs:autoDownloadRecords', async (event, source: string) => {
  try {
    return await autoDownloadRemoteRecords(source)
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
      displayHeaderFooter: false,
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

// 마크다운 → HWPX (DOCX/PDF 중간 변환 없이 HWPX ZIP/XML 직접 생성)
ipcMain.handle(
  'export:mdToHwpx',
  async (e, p: { markdown: string; title?: string; defaultPath?: string }) => {
    const parentWindow = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    if (!parentWindow || parentWindow.isDestroyed()) return { ok: false }
    const r = await dialog.showSaveDialog(parentWindow, {
      defaultPath: p.defaultPath,
      filters: [{ name: 'HWPX', extensions: ['hwpx'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false }
    try {
      const title = p.title?.trim() || basename(r.filePath).replace(/\.[^.]+$/, '') || '문서'
      // JuriSupport 계정의 사무실 정보(로고·연락처·별도 푸터)를 표준 서식 푸터에 넣는다.
      // 미등록·오프라인이면 쪽번호만 있는 푸터로 내보낸다.
      const office = await js.officeInfoForHwpx().catch(() => undefined)
      await writeFile(r.filePath, createHwpxFromMarkdown(p.markdown, title, office))
      return { ok: true, path: r.filePath, officeFooter: !!office }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }
)

// 다른 이름으로 저장 (새 문서)
ipcMain.handle('fs:saveAs', async (_e, p: { content: string; defaultPath?: string }) => {
  if (!mainWindow) return { ok: false }
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: p.defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false }
  try {
    await writeFile(r.filePath, p.content, 'utf8')
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:writeText', async (_e, p: { path: string; content: string; expected?: FileSignature }) => {
  try {
    if (p.expected) {
      const current = await statFileSignature(p.path)
      if (!sameFileSignature(current, p.expected)) {
        return {
          ok: false,
          conflict: true,
          stat: current,
          error: '파일이 외부에서 변경되어 저장을 중단했습니다.'
        }
      }
    }
    if (isRemote(p.path)) await rfsWriteText(p.path, p.content)
    else await writeFile(p.path, p.content, 'utf8')
    return { ok: true, stat: await statFileSignature(p.path).catch(() => undefined) }
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

ipcMain.handle('fs:readText', async (event, filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  if (isRemote(filePath)) {
    const st = await rfsStat(filePath)
    if (!TEXT_EXT.has(ext)) return { ext, kind: 'binary' as const, text: '', size: st.size, mtimeMs: st.mtimeMs }
    const buf = await readRemoteBytesWithProgress(event.sender, filePath)
    const decoded = decodeTextBuffer(buf, MAX_TEXT_BYTES)
    return {
      ext,
      kind: 'text' as const,
      text: decoded.text,
      size: st.size,
      mtimeMs: st.mtimeMs,
      truncated: decoded.truncated
    }
  }
  const info = await stat(filePath)
  if (!TEXT_EXT.has(ext)) {
    return { ext, kind: 'binary' as const, text: '', size: info.size, mtimeMs: info.mtimeMs }
  }
  const buf = await readLocalBytes(filePath)
  const decoded = decodeTextBuffer(buf, MAX_TEXT_BYTES)
  return {
    ext,
    kind: 'text' as const,
    text: decoded.text,
    size: info.size,
    mtimeMs: info.mtimeMs,
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
  disposeSshControlMasters()
})

app.whenReady().then(() => {
  // Windows 토스트 알림에는 AppUserModelID가 필요하다 (electron-builder appId와 일치).
  if (process.platform === 'win32') app.setAppUserModelId('kr.lawpid.legalterminal')
  applyDockIcon()
  // 기본 메뉴 제거 — 기본 메뉴가 Ctrl+W를 '창 닫기'에 바인딩해 터미널 Ctrl+W가 창을 닫는 문제 방지.
  // 단 macOS는 메뉴가 아예 없으면 Cmd+C/V 같은 편집 단축키 자체가 죽으므로(설정창 토큰
  // 붙여넣기 불가) 편집 롤과 화면 복구용 reload만 둔다 — 여기에는 Cmd+W 바인딩이 없다.
  // (메뉴바는 autoHideMenuBar로 이미 숨겨져 있어 UX 변화 없음. Ctrl+W는 렌더러에서 탭 닫기로 처리.)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: '보기', submenu: [{ role: 'reload', label: '화면 다시 불러오기' }] }
      ])
    )
  } else {
    Menu.setApplicationMenu(null)
  }
  const isAppWindow = (webContents: WebContents | null): boolean =>
    !!webContents && BrowserWindow.getAllWindows().some((win) => win.webContents.id === webContents.id)
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && details.isMainFrame && isAppWindow(webContents)
  )
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : []
    callback(
      permission === 'media' &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === 'audio') &&
        isAppWindow(webContents)
    )
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
