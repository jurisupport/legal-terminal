import { app, BrowserWindow, nativeImage, type IpcMain } from 'electron'
import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'fs/promises'
import { basename, isAbsolute, join, posix } from 'path'
import { isRemote, parseRemote, rfsReadBytes, rfsStat } from './remoteFs'

/** Native drags carry files, not our HTML MIME data. Unique copies preserve source
 * identity for internal drops and keep external moves from deleting originals. */
export function registerFileDragIpc(ipcMain: IpcMain, iconPath: () => string | undefined): void {
  type Prepared = { id: string; entries: { source: string; file: string }[] }
  const prepared = new Map<string, { owner: number; value: Prepared }>()
  const cached = new Map<number, { key: string; value: Prepared }>()
  let stagingRoot: Promise<string> | undefined
  const root = (): Promise<string> => stagingRoot ??= (async () => {
    const base = join(app.getPath('temp'), 'legal-terminal-file-drags')
    await mkdir(base, { recursive: true, mode: 0o700 })
    // Keep files after drop/quit: browsers can read them later. Only age out old
    // sessions when starting a new one (native drag has no completion callback).
    for (const name of await readdir(base)) {
      if (!name.startsWith('session-')) continue
      const path = join(base, name)
      try {
        if (Date.now() - (await stat(path)).mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          await rm(path, { recursive: true, force: true })
        }
      } catch { /* Another application window/process may have cleaned it. */ }
    }
    return realpath(await mkdtemp(join(base, 'session-')))
  })()

  ipcMain.handle('fs:prepareDrag', async (event, input: unknown) => {
    try {
      if (!Array.isArray(input) || !input.length || input.some((p) =>
        typeof p !== 'string' || p.includes('\0') || (!isRemote(p) && !isAbsolute(p)))) {
        throw new Error('드래그할 파일 경로가 올바르지 않습니다.')
      }
      const sources = [...new Set(input as string[])]
      const versions = await Promise.all(sources.map(async (source) => {
        const info = isRemote(source) ? await rfsStat(source) : await stat(source)
        const directory = 'isDir' in info ? info.isDir : info.isDirectory()
        if (directory) throw new Error('폴더는 앱 안에서 이동하거나 다운로드 메뉴를 이용해 주세요.')
        return [source, info.size, info.mtimeMs, 'ctimeMs' in info ? info.ctimeMs : null]
      }))
      const key = JSON.stringify(versions)
      const previous = cached.get(event.sender.id)
      if (previous?.key === key && (await Promise.all(previous.value.entries.map(async ({ file }) =>
        stat(file).then(() => true, () => false)))).every(Boolean)) {
        return { ok: true, ...previous.value }
      }
      const dir = await mkdtemp(join(await root(), 'drag-'))
      try {
        const entries: Prepared['entries'] = []
        for (const [index, source] of sources.entries()) {
          const name = isRemote(source) ? posix.basename(parseRemote(source).path) : basename(source)
          if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error('파일 이름이 올바르지 않습니다.')
          // Separate parents preserve identical filenames in a multi-file drag.
          const parent = join(dir, String(index))
          await mkdir(parent)
          const file = join(parent, name)
          if (isRemote(source)) await writeFile(file, await rfsReadBytes(source), { mode: 0o600 })
          else await copyFile(source, file, constants.COPYFILE_FICLONE)
          entries.push({ source, file: await realpath(file) })
        }
        if (event.sender.isDestroyed()) throw new Error('파일을 요청한 창이 닫혔습니다.')
        const value = { id: randomUUID(), entries }
        prepared.set(value.id, { owner: event.sender.id, value })
        cached.set(event.sender.id, { key, value })
        return { ok: true, ...value }
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw error
      }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.on('fs:startDrag', (event, id: unknown) => {
    try {
      const item = typeof id === 'string' ? prepared.get(id) : undefined
      if (!item || item.owner !== event.sender.id) throw new Error('파일을 다시 선택한 뒤 드래그해 주세요.')
      const path = iconPath()
      const icon = path ? nativeImage.createFromPath(path).resize({ width: 32, height: 32 }) : nativeImage.createEmpty()
      if (icon.isEmpty()) throw new Error('드래그 아이콘을 불러올 수 없습니다.')
      const files = item.value.entries.map(({ file }) => file)
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('fs:dragPrepared', item.value.entries)
      }
      event.sender.startDrag({ file: files[0], files, icon })
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send('fs:dragError', String(error))
    }
  })
}
