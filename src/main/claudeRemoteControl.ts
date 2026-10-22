import { BrowserWindow, WebContentsView, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeClaudeRemoteControlUrl, type ClaudeRemoteControlApi } from '../shared/claudeRemoteControl'

interface Slot {
  key: string
  owner: BrowserWindow
  view: WebContentsView
  popups: Set<BrowserWindow>
  url?: string
  loading?: Promise<void>
  closed: boolean
  ownerClosed: () => void
}

const slots = new Map<string, Slot>()
const preferences: Electron.WebPreferences = {
  partition: 'persist:lt-claude-remote-control', sandbox: true, contextIsolation: true,
  nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false
}

function trustedOwner(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (owner && !owner.isDestroyed() && owner.webContents === event.sender && event.senderFrame === event.sender.mainFrame) {
    try {
      const expected = new URL(process.env['ELECTRON_RENDERER_URL'] || pathToFileURL(join(__dirname, '../renderer/index.html')).href)
      const actual = new URL(event.sender.getURL())
      actual.hash = expected.hash = ''
      actual.search = expected.search = ''
      if (actual.href === expected.href) return owner
    } catch { /* An empty or invalid renderer URL is not an app window. */ }
  }
  throw new Error('앱 화면에서만 리모트 컨트롤을 열 수 있습니다.')
}

function slotKey(owner: BrowserWindow, id: unknown): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(id)) throw new Error('리모트 컨트롤 연결 정보가 올바르지 않습니다.')
  return `${owner.id}:${id}`
}

function safeNavigation(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
  } catch { return false }
}

function detach(slot: Slot): void {
  if (slot.closed) return
  slot.closed = true
  if (slots.get(slot.key) === slot) slots.delete(slot.key)
  slot.owner.removeListener('closed', slot.ownerClosed)
  for (const popup of slot.popups) if (!popup.isDestroyed()) popup.destroy()
  slot.popups.clear()
  if (!slot.owner.isDestroyed()) slot.owner.contentView.removeChildView(slot.view)
  const contents = slot.view.webContents
  try { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }) }
  catch (error) { if (!contents.isDestroyed()) throw error }
}

function secureContents(slot: Slot, contents: WebContents): void {
  contents.on('will-navigate', (event, url) => { if (!safeNavigation(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!safeNavigation(url)) event.preventDefault() })
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(details => {
    if (slot.closed || !safeNavigation(details.url)) return { action: 'deny' }
    return { action: 'allow', createWindow: () => {
      if (slot.closed || slot.owner.isDestroyed()) throw new Error('리모트 컨트롤 탭이 닫혔습니다.')
      const popup = new BrowserWindow({ parent: slot.owner, width: 900, height: 760, webPreferences: preferences })
      slot.popups.add(popup)
      popup.once('closed', () => slot.popups.delete(popup))
      secureContents(slot, popup.webContents)
      return popup.webContents
    } }
  })
}

function createSlot(owner: BrowserWindow, key: string): Slot {
  const view = new WebContentsView({ webPreferences: preferences })
  const slot: Slot = { key, owner, view, popups: new Set(), closed: false, ownerClosed: () => detach(slot) }
  view.setVisible(false)
  try {
    owner.contentView.addChildView(view)
    secureContents(slot, view.webContents)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.once('destroyed', () => detach(slot))
    owner.once('closed', slot.ownerClosed)
    slots.set(key, slot)
    return slot
  } catch (error) { detach(slot); throw error }
}

export function registerClaudeRemoteControlIpc(ipcMain: IpcMain): void {
  ipcMain.handle('claudeRemoteControl:open', async (event, input: Parameters<ClaudeRemoteControlApi['open']>[0]) => {
    const owner = trustedOwner(event)
    const key = slotKey(owner, input?.id)
    const url = normalizeClaudeRemoteControlUrl(input?.url)
    const slot = slots.get(key) ?? createSlot(owner, key)
    if (slot.url === url) return slot.loading
    const pending = (slot.loading ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (slot.closed) throw new Error('리모트 컨트롤 탭이 닫혔습니다.')
      await slot.view.webContents.loadURL(url)
      if (slot.closed) throw new Error('리모트 컨트롤 탭이 닫혔습니다.')
    })
    slot.url = url
    slot.loading = pending
    try { await pending } catch (error) {
      if (slot.loading === pending) detach(slot)
      throw new Error(`Claude 리모트 컨트롤을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    } finally { if (slot.loading === pending) slot.loading = undefined }
  })
  ipcMain.handle('claudeRemoteControl:bounds', (event, id: string, bounds: Parameters<ClaudeRemoteControlApi['bounds']>[1]) => {
    const owner = trustedOwner(event)
    const slot = slots.get(slotKey(owner, id))
    if (!slot) return
    if (bounds === null) { slot.view.setVisible(false); return }
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(value => typeof value === 'number' && Number.isFinite(value)) ||
        bounds.width < 0 || bounds.height < 0) throw new Error('리모트 컨트롤 화면 크기가 올바르지 않습니다.')
    const [width, height] = owner.getContentSize()
    const x = Math.min(width, Math.max(0, Math.floor(bounds.x)))
    const y = Math.min(height, Math.max(0, Math.floor(bounds.y)))
    const clipped = { x, y, width: Math.max(0, Math.min(width, Math.ceil(bounds.x + bounds.width)) - x),
      height: Math.max(0, Math.min(height, Math.ceil(bounds.y + bounds.height)) - y) }
    slot.view.setBounds(clipped)
    slot.view.setVisible(clipped.width > 0 && clipped.height > 0)
  })
  ipcMain.handle('claudeRemoteControl:close', (event, id: string) => {
    const owner = trustedOwner(event)
    const slot = slots.get(slotKey(owner, id))
    if (slot) detach(slot)
  })
}

export function disposeClaudeRemoteControls(): void {
  for (const slot of [...slots.values()]) detach(slot)
}
