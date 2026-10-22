import { BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { getSettings } from './settings'
import { buildSshArgs } from './sshOptions'
import { isRemote, parseRemote } from './remoteFs'
import runtimeSource from './remotion-preview/runtime.cjs.txt?raw'
import playerSource from './remotion-preview/player.tsx.txt?raw'
import type { RemotionBridge, RemotionPreviewOptions, RemotionPreviewResult, RemotionPreviewSelection } from '../shared/remotionPreview'

interface RuntimeMessage {
  type: 'ready' | 'built' | 'selection'
  token: string
  port?: number
  requestId?: string
  config: RemotionBridge
  component: string
  version: string
  selection?: { frame: number; startFrame: number; endFrame?: number; rect: Electron.Rectangle }
}
interface PreviewSession {
  id: string
  ownerId: number
  projectDir: string
  entryPoint: string
  compositionId?: string
  window: BrowserWindow
  child?: ChildProcessWithoutNullStreams
  tunnel?: ChildProcessWithoutNullStreams
  url?: string
  closing: boolean
}
const sessions = new Map<string, PreviewSession>()
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(error => error ? reject(error) : resolvePort(port))
    })
  })
}

function stopChild(child?: ChildProcessWithoutNullStreams): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  // EOF also reaches the remote process, which removes its own temporary bundle.
  child.stdin.end()
  const graceful = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }, 2_000)
  const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 30_000)
  graceful.unref(); force.unref()
  child.once('exit', () => { clearTimeout(graceful); clearTimeout(force) })
}

export function closeRemotionPreview(sessionId: string, ownerId?: number): void {
  const session = sessions.get(sessionId)
  if (!session || (ownerId !== undefined && session.ownerId !== ownerId)) return
  session.closing = true
  sessions.delete(sessionId)
  stopChild(session.child)
  // The forwarding process owns no remote server; terminating it cannot kill a user's other SSH work.
  session.tunnel?.kill()
  if (!session.window.isDestroyed()) session.window.destroy()
}

export function disposeRemotionPreviews(): void {
  for (const id of [...sessions.keys()]) closeRemotionPreview(id)
}

export function validRemotionSelection(message: RuntimeMessage): boolean {
  const { selection, config, version, component } = message
  if (!selection || !config || !/^[a-f0-9]{64}$/.test(version) || typeof component !== 'string' || component.length > 4096 || component.includes('\0')) return false
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.compositionId) || !Number.isFinite(config.fps) || config.fps <= 0 || config.fps > 240 || !Number.isSafeInteger(config.durationInFrames) || config.durationInFrames <= 0 || config.durationInFrames > 10_000_000) return false
  if (![selection.frame, selection.startFrame].every(frame => Number.isInteger(frame) && frame >= 0 && frame < config.durationInFrames)) return false
  if (selection.endFrame !== undefined && (!Number.isInteger(selection.endFrame) || selection.endFrame <= selection.startFrame || selection.endFrame > config.durationInFrames)) return false
  return Boolean(selection.rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(selection.rect[key as keyof Electron.Rectangle]) && selection.rect[key as keyof Electron.Rectangle] >= 0) && selection.rect.width >= 1 && selection.rect.height >= 1)
}

/** Only the owning trusted app renderer receives the selected frame and captured image. */
export async function openRemotionPreview(
  options: RemotionPreviewOptions,
  owner: BrowserWindow,
  onSelection: (selection: RemotionPreviewSelection) => void
): Promise<RemotionPreviewResult> {
  if (!options || typeof options.projectDir !== 'string' || !options.projectDir.trim() || /[\0\r\n]/.test(options.projectDir)) return { ok: false, error: 'Remotion 프로젝트 폴더를 지정하세요.' }
  if (options.entryPoint !== undefined && (typeof options.entryPoint !== 'string' || /[\0\r\n]/.test(options.entryPoint))) return { ok: false, error: '미리보기 설정 경로가 올바르지 않습니다.' }
  if (options.frame !== undefined && (!Number.isSafeInteger(options.frame) || options.frame < 0 || options.frame > 10_000_000)) return { ok: false, error: '미리보기 프레임이 올바르지 않습니다.' }
  const remote = isRemote(options.projectDir)
  if (!remote && !isAbsolute(options.projectDir)) return { ok: false, error: '프로젝트의 절대 경로를 지정하세요.' }
  const projectDir = remote ? options.projectDir.replace(/\/$/, '') : resolve(options.projectDir)
  const previous = [...sessions.values()].find(session => session.ownerId === owner.webContents.id && session.projectDir === projectDir && session.entryPoint === (options.entryPoint ?? '.legal-terminal/remotion.json'))
  if (previous && !previous.window.isDestroyed()) {
    if (options.compositionId && previous.compositionId && options.compositionId !== previous.compositionId) return { ok: false, error: '이전 선택과 프로젝트의 composition이 다릅니다.' }
    if (options.frame !== undefined && previous.url) await previous.window.loadURL(`${previous.url}?frame=${options.frame}`)
    previous.window.show(); previous.window.focus()
    return { ok: true, sessionId: previous.id }
  }
  const id = randomUUID()
  const token = randomUUID().replace(/-/g, '')
  const win = new BrowserWindow({
    width: 1000, height: 900, minWidth: 580, minHeight: 650,
    title: 'Remotion 미리보기', parent: owner, show: false, backgroundColor: '#14171d',
    webPreferences: { partition: `lt-remotion-${id}`, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, navigateOnDragDrop: false, backgroundThrottling: false }
  })
  const session: PreviewSession = { id, ownerId: owner.webContents.id, projectDir, entryPoint: options.entryPoint ?? '.legal-terminal/remotion.json', window: win, closing: false }
  sessions.set(id, session)
  const close = (): void => closeRemotionPreview(id)
  owner.webContents.once('destroyed', close)
  win.once('closed', () => { owner.webContents.removeListener('destroyed', close); close() })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.session.on('will-download', event => event.preventDefault())
  const allowedUrl = (url: string): boolean => {
    if (!session.url) return false
    try { const candidate = new URL(url); const allowed = new URL(session.url); return candidate.origin === allowed.origin && candidate.pathname === allowed.pathname } catch { return false }
  }
  win.webContents.on('will-navigate', (event, url) => { if (!allowedUrl(url)) event.preventDefault() })
  win.webContents.on('will-redirect', (event, url) => { if (!allowedUrl(url)) event.preventDefault() })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html lang="ko"><body style="background:#14171d;color:#eee;font:16px system-ui;padding:32px">Remotion 프로젝트를 준비하는 중…<p>창을 닫으면 준비가 취소됩니다.</p></body></html>'))
    win.show()
    const localPort = remote ? await availablePort() : undefined
    const parsed = remote ? parseRemote(projectDir) : undefined
    const profile = parsed ? (await getSettings()).sshProfiles?.find(candidate => candidate.id === parsed.profileId) : undefined
    if (parsed && (!profile || parsed.path === '/')) throw new Error('SSH 프로필과 Remotion 프로젝트 폴더를 확인하세요.')
    if (session.closing) throw new Error('미리보기가 취소되었습니다.')
    const child = profile
      ? spawn('ssh', [...buildSshArgs(profile, { usage: 'interactive', batchMode: true }), `node -e ${shellQuote(runtimeSource)}`], { windowsHide: true })
      : spawn(process.execPath, ['-e', runtimeSource], { cwd: projectDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    session.child = child
    child.stdin.on('error', () => {})
    let output = ''
    let errors = ''
    let capturePending = false
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-6000) })
    const ready = await new Promise<RuntimeMessage>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Remotion 준비 시간이 초과되었습니다. 프로젝트 설정과 설치된 패키지를 확인하세요.')), 180_000)
      const finish = (error?: Error, message?: RuntimeMessage): void => { clearTimeout(timeout); error ? reject(error) : resolveReady(message!) }
      child.once('error', error => finish(error))
      child.once('exit', code => {
        finish(new Error(errors.trim() || `Remotion 미리보기가 종료되었습니다 (${code ?? 'signal'}).`))
        if (!session.closing) close()
      })
      child.stdout.on('data', data => {
        output += data.toString()
        if (output.length > 1_000_000) { output = ''; return }
        let end: number
        while ((end = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, end); output = output.slice(end + 1)
          if (!line.startsWith('LT_REMOTION ')) continue
          let message: RuntimeMessage
          try { message = JSON.parse(line.slice(12)) } catch { continue }
          if (message.token !== token) continue
          if (message.type === 'built' || message.type === 'ready') session.compositionId = message.config?.compositionId
          if (message.type === 'ready') { finish(undefined, message); continue }
          if (message.type !== 'selection' || !message.requestId || session.closing) continue
          const reply = (error?: string): void => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'selection-result', requestId: message.requestId, ...(error ? { error } : {}) }) + '\n') }
          if (capturePending || !validRemotionSelection(message) || !allowedUrl(win.webContents.getURL())) { reply('미리보기 선택을 확인할 수 없습니다.'); continue }
          capturePending = true
          void (async () => {
            const selection = message.selection!
            const [width, height] = win.getContentSize()
            const rect = { x: Math.floor(selection.rect.x), y: Math.floor(selection.rect.y), width: Math.ceil(selection.rect.width), height: Math.ceil(selection.rect.height) }
            if (rect.x + rect.width > width || rect.y + rect.height > height || rect.width * rect.height > 16_000_000) throw new Error('선택 화면이 미리보기 창을 벗어났습니다. 창을 넓힌 후 다시 첨부하세요.')
            const capture = await win.webContents.capturePage(rect)
            if (capture.isEmpty()) throw new Error('화면을 캡처할 수 없습니다.')
            const size = capture.getSize()
            const resized = Math.max(size.width, size.height) > 1920 ? capture.resize({ ...(size.width >= size.height ? { width: 1920 } : { height: 1920 }) }) : capture
            const jpeg = resized.toJPEG(90)
            if (jpeg.length > 5 * 1024 * 1024) throw new Error('화면 캡처가 너무 큽니다. 미리보기 창을 줄여 다시 첨부하세요.')
            const captureDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
            if (captureDataUrl.length > 7 * 1024 * 1024) throw new Error('화면 캡처가 너무 큽니다. 미리보기 창을 줄여 다시 첨부하세요.')
            if (session.closing || owner.isDestroyed()) throw new Error('작업 창이 닫혔습니다.')
            // component comes only from the project process; resolve it below the original project URI.
            const parts = message.component.replace(/\\/g, '/').split('/')
            if (parts.some(part => part === '..' || part === '') || message.component.startsWith('/')) throw new Error('컴포넌트 경로가 올바르지 않습니다.')
            onSelection({ sessionId: id, projectDir, sourcePath: remote ? `${projectDir}/${parts.join('/')}` : resolve(projectDir, ...parts), compositionId: message.config.compositionId, frame: selection.frame, fps: message.config.fps, durationInFrames: message.config.durationInFrames, startFrame: selection.startFrame, ...(selection.endFrame === undefined ? {} : { endFrame: selection.endFrame }), version: message.version, captureDataUrl })
            owner.show(); owner.focus()
            reply()
          })().catch(error => reply(error instanceof Error ? error.message : String(error))).finally(() => { capturePending = false })
        }
      })
      child.stdin.write(JSON.stringify({ projectDir: parsed?.path ?? projectDir, entryPoint: options.entryPoint, frame: options.frame, token, localPort, playerSource }) + '\n')
    })
    if (session.closing) throw new Error('미리보기가 취소되었습니다.')
    if (!Number.isInteger(ready.port) || ready.port! < 1 || ready.port! > 65535) throw new Error('미리보기 포트가 올바르지 않습니다.')
    if (options.compositionId && options.compositionId !== ready.config.compositionId) throw new Error('이전 선택과 프로젝트의 composition이 다릅니다. 미리보기 설정을 확인하세요.')
    const port = localPort ?? ready.port!
    session.url = `http://127.0.0.1:${port}/${token}/`
    if (profile) {
      const args = buildSshArgs(profile, { usage: 'interactive', batchMode: true })
      args.splice(args.length - 1, 0, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${ready.port}`)
      const tunnel = spawn('ssh', args, { windowsHide: true })
      session.tunnel = tunnel
      tunnel.stdin.on('error', () => {})
      let tunnelError = ''
      tunnel.stderr.on('data', data => { tunnelError = (tunnelError + data.toString()).slice(-3000) })
      tunnel.on('error', error => { tunnelError = error.message; close() })
      tunnel.on('exit', () => { if (!session.closing) close() })
      let connected = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (session.closing) throw new Error(tunnelError || 'SSH 미리보기 연결이 종료되었습니다.')
        try { const response = await fetch(session.url, { signal: AbortSignal.timeout(1000) }); if (response.ok) { connected = true; break } } catch { /* Tunnel is still connecting. */ }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
      if (!connected) throw new Error(tunnelError || 'SSH 미리보기 연결 시간이 초과되었습니다.')
    }
    if (session.closing) throw new Error('미리보기가 취소되었습니다.')
    await win.loadURL(session.url)
    win.focus()
    return { ok: true, sessionId: id }
  } catch (error) {
    close()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
