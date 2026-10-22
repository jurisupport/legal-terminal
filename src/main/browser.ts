import { app, BrowserWindow, WebContentsView, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Server } from 'node:http'
import type { BrowserApi, BrowserCommand, BrowserFrame, BrowserLocation, BrowserQuality, BrowserState } from '../shared/browser'
import { getAgentBrowserContext } from './agent/agent-service'
import { configureBrowserAgentBridge } from './browserAgentBridge'
import { getSettings } from './settings'
import { rfsForwardLocalPort } from './remoteFs'
import { connectRemoteBrowser } from './browserRemote'
import runtimeSource from './browser/runtime.cjs.txt?raw'

type PageState = Pick<BrowserState, 'url' | 'title' | 'tabs' | 'activeTabId' | 'downloadPath'>
interface Controller {
  state(): PageState | Promise<PageState>
  command(command: Record<string, unknown>): Promise<unknown>
  frame(options: { quality: BrowserQuality; etag?: string }): Promise<{ data: Buffer; width: number; height: number; etag: string }>
  close(): void | Promise<void>
}
interface Runtime {
  safeUrl(value: unknown): string
  validateCommand(command: unknown): Record<string, unknown>
  runPageCommand(send: (method: string, params?: Record<string, unknown>) => Promise<any>, command: Record<string, unknown>): Promise<unknown>
  createHttpServer(options: { controller: Controller; token: string }): Promise<{ server: Server; port: number; setReadOnly(value: boolean): void }>
}
// This is the same bundled, dependency-free runtime sent to the SSH host.
const bundled = { exports: {} as Runtime }
new Function('require', 'module', 'exports', runtimeSource)(createRequire(__filename), bundled, bundled.exports)
const runtime = bundled.exports

interface Binding { location: BrowserLocation; profileId?: string }
interface Slot {
  id: string
  agentSessionId: string
  owner: BrowserWindow
  binding: Binding
  profileLabel?: string
  port: number
  token: string
  downloadPath: string
  startedAt: number
  connected: boolean
  controller?: Controller
  server?: Server
  localBounds?: Electron.Rectangle
  views?: Map<string, WebContentsView>
  activeTabId?: string
  ownerClosed?: () => void
  closed?: boolean
  forward?: Awaited<ReturnType<typeof rfsForwardLocalPort>>
  remote?: Awaited<ReturnType<typeof connectRemoteBrowser>>
}

const slots = new Map<string, Slot>()
const bindings = new Map<string, Binding>()
const opening = new Map<string, Promise<Slot>>()
let loaded: Promise<void> | undefined
let saving = Promise.resolve()
const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32)
const slotId = (agentId: string, binding: Binding): string => hash(JSON.stringify([agentId, binding.location, binding.profileId]))
const bindingFile = (): string => join(app.getPath('userData'), 'browser-bindings.json')

async function loadBindings(): Promise<void> {
  loaded ??= readFile(bindingFile(), 'utf8').then(text => {
    const records: unknown = JSON.parse(text)
    if (!records || typeof records !== 'object' || Array.isArray(records)) return
    for (const [id, value] of Object.entries(records)) {
      if (id.length > 200 || !value || typeof value !== 'object') continue
      const entry = value as Binding
      if (entry.location === 'local' || (entry.location === 'remote' && typeof entry.profileId === 'string')) bindings.set(id, entry)
    }
  }).catch(() => {})
  await loaded
}

function saveBindings(): Promise<void> {
  saving = saving.catch(() => {}).then(async () => {
    const path = bindingFile()
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(path + '.tmp', JSON.stringify(Object.fromEntries(bindings)), { mode: 0o600 })
    await rename(path + '.tmp', path)
  })
  return saving
}

function displayViews(slot: Slot): void {
  for (const [id, view] of slot.views ?? []) {
    if (view.webContents.isDestroyed()) continue
    const visible = id === slot.activeTabId && Boolean(slot.localBounds) && !slot.owner.isDestroyed()
    if (visible) view.setBounds(slot.localBounds!)
    view.setVisible(visible)
  }
}

async function createLocal(slot: Slot): Promise<void> {
  slot.views = new Map()
  let closing = false
  await mkdir(slot.downloadPath, { recursive: true })
  const addTab = (url: string): WebContentsView => {
    runtime.safeUrl(url)
    const view = new WebContentsView({ webPreferences: {
      partition: `persist:lt-browser-${hash(slot.agentSessionId)}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false
    } })
    const wc = view.webContents
    const id = String(wc.id)
    slot.views!.set(id, view)
    slot.activeTabId = id
    slot.owner.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    displayViews(slot)
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    wc.session.setPermissionCheckHandler(() => false)
    wc.on('will-navigate', (event, target) => { try { runtime.safeUrl(target) } catch { event.preventDefault() } })
    wc.on('will-redirect', (event, target) => { try { runtime.safeUrl(target) } catch { event.preventDefault() } })
    wc.on('will-attach-webview', event => event.preventDefault())
    wc.setWindowOpenHandler(details => {
      try { runtime.safeUrl(details.url) } catch { return { action: 'deny' } }
      return { action: 'allow', createWindow: () => addTab(details.url).webContents }
    })
    wc.debugger.attach('1.3')
    wc.once('destroyed', () => {
      if (!slot.owner.isDestroyed()) slot.owner.contentView.removeChildView(view)
      slot.views?.delete(id)
      if (slot.activeTabId === id) slot.activeTabId = slot.views?.keys().next().value
      if (!closing && !slot.owner.isDestroyed() && slot.views?.size === 0) addTab('about:blank')
      displayViews(slot)
    })
    void wc.loadURL(url).catch(() => {})
    return view
  }
  const first = addTab('about:blank')
  const browserSession = first.webContents.session
  const onDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
    const name = basename(item.getFilename()).replace(/[\x00-\x1f]/g, '_') || 'download'
    item.setSavePath(join(slot.downloadPath, `${Date.now()}-${name}`))
  }
  browserSession.on('will-download', onDownload)
  const active = (): WebContentsView => {
    const view = slot.views?.get(slot.activeTabId ?? '')
    if (!view || view.webContents.isDestroyed()) throw new Error('열린 브라우저 탭이 없습니다.')
    return view
  }
  const controller: Controller = {
    state() {
      const tabs = [...slot.views!.entries()].filter(([, view]) => !view.webContents.isDestroyed()).map(([id, view]) => ({ id, title: view.webContents.getTitle(), url: view.webContents.getURL() }))
      const tab = tabs.find(tab => tab.id === slot.activeTabId)
      return { tabs, activeTabId: tab?.id ?? '', url: tab?.url ?? 'about:blank', title: tab?.title ?? '', downloadPath: slot.downloadPath }
    },
    async command(input) {
      const command = runtime.validateCommand(input)
      if (command.action === 'new_tab') addTab(runtime.safeUrl(command.url))
      else if (command.action === 'switch_tab') {
        if (!slot.views!.has(String(command.tabId))) throw new Error('브라우저 탭이 닫혔습니다.')
        slot.activeTabId = String(command.tabId); displayViews(slot)
      } else if (command.action === 'close_tab') {
        const view = slot.views!.get(String(command.tabId))
        if (!view) throw new Error('브라우저 탭이 닫혔습니다.')
        const wc = view.webContents
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error): void => {
            clearTimeout(timer)
            wc.removeListener('destroyed', completed)
            wc.removeListener('will-prevent-unload', completed)
            if (error) reject(error); else resolve()
          }
          const completed = (): void => finish()
          const timer = setTimeout(() => finish(new Error('브라우저 탭 닫기 시간이 초과되었습니다.')), 15000)
          wc.once('destroyed', completed)
          wc.once('will-prevent-unload', completed)
          try { wc.close({ waitForBeforeUnload: true }) } catch (error) { finish(error as Error) }
        })
      } else {
        const wc = active().webContents
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
        const result = await runtime.runPageCommand((method, params) => wc.debugger.sendCommand(method, params), command)
        if (command.action === 'read') return result
      }
      return controller.state()
    },
    async frame({ quality }) {
      const view = active()
      const captured = await view.webContents.capturePage()
      const size = captured.getSize()
      const width = quality === 'saver' ? 960 : 1440
      const data = (size.width > width ? captured.resize({ width }) : captured).toJPEG(quality === 'saver' ? 35 : 65)
      return { data, width: view.getBounds().width, height: view.getBounds().height, etag: hash(data.toString('base64')) }
    },
    close() {
      closing = true
      browserSession.removeListener('will-download', onDownload)
      for (const view of [...slot.views!.values()]) {
        if (!slot.owner.isDestroyed()) slot.owner.contentView.removeChildView(view)
        if (!view.webContents.isDestroyed()) view.webContents.close()
      }
      slot.views!.clear()
    }
  }
  slot.controller = controller
  const listening = await runtime.createHttpServer({ controller, token: slot.token })
  slot.port = listening.port
  slot.server = listening.server
}

async function request(slot: Slot, path: string, data?: unknown, headers?: Record<string, string>): Promise<Response> {
  if (slot.remote && !slot.remote.tunnel.isAlive()) { slot.connected = false; throw new Error('원격 브라우저 연결이 끊겼습니다. 다시 연결해 주세요.') }
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${slot.port}${path}`, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${slot.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    })
  } catch (error) { slot.connected = false; throw error }
  slot.connected = true
  if (!response.ok && response.status !== 304) throw new Error((await response.text()).slice(0, 1000) || `브라우저 요청 실패 (${response.status})`)
  return response
}

function wrapState(slot: Slot, state: PageState): BrowserState {
  return { ...state, id: slot.id, agentSessionId: slot.agentSessionId, location: slot.binding.location, profileLabel: slot.profileLabel,
    connected: slot.connected, traffic: { ...(slot.remote?.tunnel.traffic() ?? { receivedBytes: 0, sentBytes: 0 }), startedAt: slot.startedAt } }
}

async function state(slot: Slot): Promise<BrowserState> {
  return wrapState(slot, slot.controller ? await slot.controller.state() : await (await request(slot, '/state')).json() as PageState)
}

function detach(slot: Slot): void {
  if (slot.closed) return
  slot.closed = true
  if (slots.get(slot.id) === slot) slots.delete(slot.id)
  if (slot.ownerClosed) slot.owner.removeListener('closed', slot.ownerClosed)
  slot.forward?.close()
  slot.remote?.tunnel.close()
  void slot.controller?.close()
  slot.server?.closeAllConnections()
  slot.server?.close()
}

function watchOwner(slot: Slot): void {
  slot.ownerClosed = () => detach(slot)
  slot.owner.once('closed', slot.ownerClosed)
}

async function ensureSlot(agentId: string, binding: Binding, owner: BrowserWindow): Promise<Slot> {
  const id = slotId(agentId, binding)
  const existing = slots.get(id)
  if (existing && !existing.closed && (existing.controller || (existing.connected && existing.remote?.tunnel.isAlive()))) {
    if (existing.controller && !existing.server?.listening) {
      const listening = await runtime.createHttpServer({ controller: existing.controller, token: existing.token })
      existing.port = listening.port; existing.server = listening.server
    }
    existing.connected = true
    if (existing.owner !== owner) {
      if (existing.ownerClosed) existing.owner.removeListener('closed', existing.ownerClosed)
      existing.localBounds = undefined
      for (const view of existing.views?.values() ?? []) { if (!existing.owner.isDestroyed()) existing.owner.contentView.removeChildView(view); owner.contentView.addChildView(view) }
      existing.owner = owner; watchOwner(existing); displayViews(existing)
    }
    return existing
  }
  if (opening.has(id)) return opening.get(id)!
  if (existing) detach(existing)
  const pending = (async () => {
    const slot: Slot = { id, agentSessionId: agentId, owner, binding, port: 0, token: randomBytes(32).toString('hex'),
      downloadPath: join(app.getPath('downloads'), 'legal-terminal', hash(agentId)), startedAt: Date.now(), connected: true }
    try {
      if (binding.location === 'local') await createLocal(slot)
      else {
        const profile = (await getSettings()).sshProfiles?.find(profile => profile.id === binding.profileId)
        if (!profile) throw new Error('저장된 원격 서버 연결을 찾을 수 없습니다.')
        slot.profileLabel = profile.label
        slot.remote = await connectRemoteBrowser(profile.id, id, runtimeSource)
        slot.port = slot.remote.tunnel.port; slot.token = slot.remote.token; slot.downloadPath = slot.remote.downloadPath
      }
      if (owner.isDestroyed()) throw new Error('브라우저를 연 창이 닫혔습니다.')
      slots.set(id, slot)
      watchOwner(slot)
      return slot
    } catch (error) { detach(slot); throw error }
  })()
  opening.set(id, pending)
  try { return await pending } finally { opening.delete(id) }
}

function trustedOwner(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame) throw new Error('앱 화면에서만 브라우저를 사용할 수 있습니다.')
  return owner
}

function owned(event: IpcMainInvokeEvent, id: string): Slot {
  const owner = trustedOwner(event)
  const slot = slots.get(id)
  if (!slot || slot.owner !== owner) throw new Error('브라우저 연결을 다시 열어 주세요.')
  getAgentBrowserContext(slot.agentSessionId, event.sender.id)
  return slot
}

export function registerBrowserIpc(ipcMain: IpcMain): void {
  configureBrowserAgentBridge(async agentId => {
    await loadBindings()
    const binding = bindings.get(agentId)
    if (!binding) return
    const context = getAgentBrowserContext(agentId)
    if (binding.location === 'remote' && context.source === 'ssh') {
      const profile = (await getSettings()).sshProfiles?.find(p => p.id === binding.profileId)
      if (!profile || profile.host !== context.ssh?.host || profile.user !== context.ssh?.user ||
          (profile.port ?? 22) !== (context.ssh?.port ?? 22) || (profile.identityFile ?? '') !== (context.ssh?.identityFile ?? '')) {
        throw new Error('브라우저의 원격 서버가 현재 대화와 다릅니다. 실행 위치를 다시 선택해 주세요.')
      }
    }
    const windows = BrowserWindow.getAllWindows()
    const owner = slots.get(slotId(agentId, binding))?.owner ?? windows.find(window => {
      try { getAgentBrowserContext(agentId, window.webContents.id); return true } catch { return false }
    })
    if (!owner) throw new Error('브라우저를 사용할 앱 화면이 없습니다.')
    const slot = await ensureSlot(agentId, binding, owner)
    await (await request(slot, '/policy', { readOnly: context.permissionMode === 'plan' || context.permissionMode === 'dontAsk' })).arrayBuffer()
    let port = slot.port
    if (context.source === 'ssh') {
      if (slot.remote) port = slot.remote.port
      else {
        if (!slot.forward?.isAlive()) {
          slot.forward?.close()
          const profile = (await getSettings()).sshProfiles?.find(p => p.host === context.ssh?.host && p.user === context.ssh.user && (p.port ?? 22) === (context.ssh.port ?? 22) && (p.identityFile ?? '') === (context.ssh.identityFile ?? ''))
          if (!profile) throw new Error('이 대화의 원격 서버 연결을 찾을 수 없습니다.')
          slot.forward = await rfsForwardLocalPort(profile.id, slot.port)
        }
        port = slot.forward.port
      }
    }
    return { url: `http://127.0.0.1:${port}/mcp`, token: slot.token, location: binding.location }
  })
  ipcMain.handle('browser:open', async (event, input: Parameters<BrowserApi['open']>[0]) => {
    const owner = trustedOwner(event)
    if (!input || typeof input.agentSessionId !== 'string' || !['local', 'remote'].includes(input.location)) throw new Error('브라우저 실행 위치를 선택해 주세요.')
    const context = getAgentBrowserContext(input.agentSessionId, event.sender.id)
    const binding: Binding = { location: input.location, ...(input.location === 'remote' ? { profileId: input.profileId } : {}) }
    if (binding.location === 'remote') {
      const profile = (await getSettings()).sshProfiles?.find(p => p.id === binding.profileId)
      if (!profile || (context.source === 'ssh' && (profile.host !== context.ssh?.host || profile.user !== context.ssh?.user || (profile.port ?? 22) !== (context.ssh?.port ?? 22)))) throw new Error('이 대화의 원격 서버를 선택해 주세요.')
    }
    await loadBindings()
    const previous = bindings.get(input.agentSessionId)
    if (context.busy && (!previous || slotId(input.agentSessionId, previous) !== slotId(input.agentSessionId, binding))) throw new Error('AI 작업이 끝난 뒤 브라우저 실행 위치를 바꿔 주세요.')
    const slot = await ensureSlot(input.agentSessionId, binding, owner)
    for (const other of slots.values()) if (other.agentSessionId === input.agentSessionId && other !== slot) { other.localBounds = undefined; displayViews(other) }
    bindings.set(input.agentSessionId, binding)
    await saveBindings()
    return state(slot)
  })
  ipcMain.handle('browser:state', (event, id: string) => state(owned(event, id)))
  ipcMain.handle('browser:command', async (event, id: string, command: BrowserCommand) => {
    const slot = owned(event, id)
    runtime.validateCommand(command)
    await (await request(slot, '/command', command)).arrayBuffer()
    return state(slot)
  })
  ipcMain.handle('browser:frame', async (event, id: string, quality: BrowserQuality, etag?: string): Promise<BrowserFrame> => {
    const slot = owned(event, id)
    if (!['saver', 'standard'].includes(quality) || (etag !== undefined && (typeof etag !== 'string' || etag.length > 200))) throw new Error('화면 전송 설정이 올바르지 않습니다.')
    if (slot.controller) {
      const frame = await slot.controller.frame({ quality, etag })
      return { width: frame.width, height: frame.height, etag: frame.etag,
        dataUrl: frame.etag === etag ? undefined : `data:image/jpeg;base64,${frame.data.toString('base64')}`, state: await state(slot) }
    }
    const response = await request(slot, `/frame?quality=${quality}`, undefined, etag ? { 'If-None-Match': etag } : undefined)
    const bytes = response.status === 304 ? undefined : Buffer.from(await response.arrayBuffer())
    if (bytes && bytes.length > 8 * 1024 * 1024) throw new Error('브라우저 화면 응답이 너무 큽니다.')
    return { dataUrl: bytes ? `data:image/jpeg;base64,${bytes.toString('base64')}` : undefined,
      etag: response.headers.get('etag') ?? etag, width: Number(response.headers.get('x-browser-width')) || 1280,
      height: Number(response.headers.get('x-browser-height')) || 800, state: await state(slot) }
  })
  ipcMain.handle('browser:bounds', (event, id: string, bounds: Electron.Rectangle | null) => {
    const slot = owned(event, id)
    if (!slot.views) return
    if (bounds !== null) {
      const [width, height] = slot.owner.getContentSize()
      if (!bounds || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k as keyof Electron.Rectangle])) || bounds.width < 1 || bounds.height < 1 || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > width + 2 || bounds.y + bounds.height > height + 2) throw new Error('브라우저 화면 영역이 올바르지 않습니다.')
      slot.localBounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
    } else slot.localBounds = undefined
    displayViews(slot)
  })
  ipcMain.handle('browser:close', async (event, id: string) => {
    const slot = owned(event, id)
    if (getAgentBrowserContext(slot.agentSessionId, event.sender.id).busy) throw new Error('AI 작업이 끝난 뒤 브라우저를 종료해 주세요.')
    if (slot.remote) await (await request(slot, '/shutdown', {})).arrayBuffer()
    detach(slot)
    if (slotId(slot.agentSessionId, bindings.get(slot.agentSessionId) ?? { location: 'local' }) === id) bindings.delete(slot.agentSessionId)
    await saveBindings()
  })
}

export function disposeBrowsers(): void {
  for (const slot of [...slots.values()]) detach(slot)
  configureBrowserAgentBridge(undefined)
}
