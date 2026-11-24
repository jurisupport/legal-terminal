import { app, BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkBoard } from './workBoard'
import { downloadBoardDocument, downloadBoardReport } from './workBoardDownload'
import { readBoardDocumentText } from './workBoardDocumentText'
import { boardTodoCaseIds } from './workBoardScope'
import { isRemote, makeRemote, parseRemote, rfsRealpath } from './remoteFs'
import type { BoardDecision, BoardDraft, BoardSettings, BoardTodoScope } from '../shared/workBoard'

export function registerWorkBoards(): () => void {
  const privateDir = join(app.getPath('userData'), 'work-boards')
  const registry = join(privateDir, 'folders.json')
  const folders = new Map<string, string>()
  const boards = new Map<string, WorkBoard>()
  const pending = new Map<string, Promise<WorkBoard>>()
  let owner = false
  let closing = false
  let saving = Promise.resolve()
  const ready = (async () => {
    try {
      const entries: unknown = JSON.parse(await readFile(registry, 'utf8'))
      if (!Array.isArray(entries)) throw Error('업무 보드 폴더 목록을 읽을 수 없습니다.')
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || entry.some(x => typeof x !== 'string')) throw Error('업무 보드 폴더 기록이 손상되었습니다.')
        folders.set(entry[0], entry[1])
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  })()
  const persist = () => {
    const next = saving.then(async () => {
      await mkdir(privateDir, { recursive: true })
      await writeFile(registry + '.tmp', JSON.stringify([...folders]), { mode: 0o600 })
      await rename(registry + '.tmp', registry)
    })
    saving = next.catch(() => {})
    return next
  }
  const aliases = new Map<string, string>()
  const workspaceAliases = (key: string) => [...aliases].filter(([, value]) => value === key).map(([path]) => path)
  async function pathKey(value: string, existing: boolean) {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw Error('작업 폴더를 선택하세요.')
    const cached = existing && aliases.get(value)
    if (cached) return cached
    if (isRemote(value)) {
      const { profileId, path } = parseRemote(value)
      if (!profileId) throw Error('SSH 프로필을 선택하세요.')
      const normalized = makeRemote(profileId, posix.resolve('/', path))
      if (!existing) return normalized
      const canonical = await rfsRealpath(normalized)
      aliases.set(value, canonical)
      aliases.set(canonical, canonical)
      return canonical
    }
    if (!isAbsolute(value)) throw Error('업무 폴더는 절대 경로를 사용하세요.')
    if (existing) {
      const canonical = await realpath(value)
      aliases.set(value, canonical)
      return canonical
    }
    try { return await realpath(value) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return join(value, '.')
    }
  }
  async function open(workspace: string, selected?: string): Promise<WorkBoard> {
    await ready
    if (!owner && !closing) owner = app.requestSingleInstanceLock()
    if (!owner || closing) throw Error('업무 보드를 실행 중인 앱 창에서 열어 주세요.')
    const key = await pathKey(workspace, true)
    const previous = pending.get(key)
    if (previous) {
      if (!selected) return previous
      await previous
      return open(key, selected)
    }
    const operation = (async () => {
      const old = folders.get(key)
      const folder = selected ? await pathKey(selected, false) : old || (isRemote(key) ? key.replace(/\/$/, '') + '/_업무지시' : join(key, '_업무지시'))
      if (key === folder) throw Error('지시서를 보관할 별도 폴더를 선택하세요.')
      if ([...folders].some(([k, v]) => k !== key && v === folder)) throw Error('다른 작업 폴더에서 사용하는 업무지시 폴더입니다.')
      let active = boards.get(key)
      if (active && old === folder) return active
      if (active || (old && old !== folder)) {
        if (!active) throw Error('기존 업무 보드를 먼저 여세요.')
        const snapshot = await active.snapshot()
        if (snapshot.tasks.some(t => !['done', 'rejected', 'failed'].includes(t.status))) throw Error('진행 중인 지시를 마친 뒤 폴더를 변경하세요.')
      }
      const board = new WorkBoard(key, folder, privateDir, (message) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('workBoard:changed', key, message)
        }
        if (message && Notification.isSupported()) new Notification({ title: '업무 보드', body: message }).show()
      }, () => workspaceAliases(key))
      try {
        if (closing) throw Error('앱을 종료하고 있습니다.')
        folders.set(key, folder)
        await board.start()
        if (closing) throw Error('앱을 종료하고 있습니다.')
        if (old !== folder) await persist()
      } catch (e) {
        board.stop()
        if (old) folders.set(key, old)
        else folders.delete(key)
        throw e
      }
      active?.stop()
      boards.set(key, board)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('workBoard:changed', key)
      }
      return board
    })()
    pending.set(key, operation)
    try { return await operation } finally { pending.delete(key) }
  }
  function trusted(event: IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(event.sender)
    const frame = event.senderFrame
    const expected = process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href
    if (!frame || frame !== event.sender.mainFrame || !win ||
        frame.url.split(/[?#]/)[0].replace(/\/$/, '') !== expected.split(/[?#]/)[0].replace(/\/$/, '')) throw Error('업무 보드는 앱 창에서만 사용할 수 있습니다.')
    return win
  }
  function handle<A extends unknown[]>(name: string, fn: (...args: A) => unknown) {
    ipcMain.handle('workBoard:' + name, (event, ...args) => { trusted(event); return fn(...args as A) })
  }
  async function snapshot(w: string, folder?: string) {
    const data = await (await open(w, folder)).snapshot()
    const workspace = data.workspace || w
    try {
      const todoCaseIds = await boardTodoCaseIds(workspace, workspaceAliases(workspace))
      return { ...data, todoCaseIds }
    } catch {
      return { ...data, warnings: [...(data.warnings ?? []), '사건 폴더 연결 정보를 확인할 수 없어 할일 조회가 제한됩니다.'] }
    }
  }
  handle('open', snapshot)
  handle('snapshot', (w: string) => snapshot(w))
  handle('takeOwnership', async (w: string, expectedOwner: string) => (await open(w)).takeOwnership(expectedOwner))
  handle('updateTask', async (w: string, id: string, draft: BoardDraft, revision: string) => (await open(w)).updateTask(id, draft, revision))
  handle('removeTask', async (w: string, id: string, revision: string) => (await open(w)).removeTask(id, revision))
  handle('add', async (w: string, drafts: BoardDraft[], batchId?: string) => (await open(w)).add(drafts, batchId))
  handle('decide', async (w: string, id: string, action: BoardDecision, reason?: string, expectedRevision?: string, todoScope?: BoardTodoScope) => (await open(w)).decide(id, action, reason, expectedRevision, todoScope))
  handle('reorder', async (w: string, ids: string[]) => (await open(w)).reorder(ids))
  handle('configure', async (w: string, patch: Partial<BoardSettings>) => (await open(w)).configure(patch))
  handle('detail', async (w: string, id: string) => (await open(w)).detail(id))
  handle('documentPath', async (w: string, id: string, path: string) => (await open(w)).documentPath(id, path))
  handle('documentText', async (w: string, id: string, path: string, offset: number = 0) =>
    readBoardDocumentText(await (await open(w)).documentPath(id, path), offset))
  ipcMain.handle('workBoard:downloadDocument', async (event, w: string, id: string, path: string) => {
    const win = trusted(event)
    return downloadBoardDocument(await open(w), id, path, win)
  })
  ipcMain.handle('workBoard:downloadReport', async (event, w: string, id: string) => {
    const win = trusted(event)
    return downloadBoardReport(await open(w), id, win)
  })
  handle('daily', async (w: string) => (await open(w)).daily())
  handle('counts', (inbox?: 'approvals' | 'reports') => Object.fromEntries(
    [...boards].map(([workspace, board]) => [workspace, inbox === 'reports' ? board.unreadReportCount() : board.approvalCount()])
  ))
  // Restore independently of the selected window so queued work survives an app restart.
  const restoring = new Set<string>()
  async function restore() {
    for (const workspace of folders.keys()) {
      if (closing) return
      if (boards.has(workspace) || restoring.has(workspace)) continue
      restoring.add(workspace)
      void open(workspace).catch(e => console.warn('[work-board] 보드 복원 대기', String(e))).finally(() => restoring.delete(workspace))
    }
  }
  void ready.then(restore).catch(e => console.error('[work-board]', e))
  const retry = setInterval(() => { void ready.then(restore).catch(() => {}) }, 60_000)
  return () => {
    closing = true
    clearInterval(retry)
    for (const board of boards.values()) board.stop()
  }
}
