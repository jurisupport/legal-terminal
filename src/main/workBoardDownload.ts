import { app, dialog, type BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { WorkBoard } from './workBoard'
import { boardReportAvailable } from '../shared/workBoard'
import { withBoardDocumentFile } from './workBoardDocumentText'

type Source = {path:string; report?:string}

async function inspect(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function inside(root: string, path: string) {
  const rel = relative(root,path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

async function destination(path: string, source: Source, board: WorkBoard) {
  if (!isAbsolute(path)) throw new Error('다운로드할 로컬 파일 위치를 선택해 주세요.')
  const parent = await realpath(dirname(path))
  const target = join(parent,basename(path))
  const boardDir = board.folder.startsWith('ssh://') ? undefined : await realpath(board.folder)
  const privateDir = join(await realpath(app.getPath('userData')),'work-boards')
  if ((boardDir && inside(boardDir,target)) || inside(privateDir,target)) throw new Error('보드 기록 폴더 밖의 저장 위치를 선택해 주세요.')
  for (let dir = parent; ; dir = dirname(dir)) {
    if (await inspect(join(dir,'_배분기'))) throw new Error('보드 기록 폴더 밖의 저장 위치를 선택해 주세요.')
    if (dirname(dir) === dir) break
  }
  const stat = await inspect(target)
  if (stat && !stat.isFile()) throw new Error('다운로드 위치로 일반 파일을 선택해 주세요.')
  if (stat && !source.path.startsWith('ssh://')) {
    const original = await lstat(source.path)
    if (original.dev === stat.dev && original.ino === stat.ino) throw new Error('원본과 다른 저장 위치를 선택해 주세요.')
  }
  return {target,stat}
}

function sameFileVersion(a: Awaited<ReturnType<typeof inspect>>, b: Awaited<ReturnType<typeof inspect>>) {
  return a?.ino === b?.ino && a?.dev === b?.dev && a?.size === b?.size &&
    a?.ctimeMs === b?.ctimeMs && a?.mtimeMs === b?.mtimeMs
}

async function publishNew(temporary: string, target: string) {
  try { await link(temporary,target); return }
  catch (error) {
    if (!['ENOTSUP','EOPNOTSUPP','ENOSYS','EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
  }
  // On volumes without hard links, reserve the new name exclusively before publishing the completed file.
  const reservation = await open(target,'wx',0o600)
  const empty = await reservation.stat().finally(() => reservation.close())
  const stillReserved = async () => sameFileVersion(empty,await inspect(target))
  try {
    // Windows needs the reservation handle closed before replacing its directory entry.
    if (!await stillReserved()) throw new Error('저장 위치에 다른 파일이 생겼습니다. 다시 선택해 주세요.')
    await rename(temporary,target)
  } catch (error) {
    if (await stillReserved()) await unlink(target)
    throw error
  }
}

async function download(board: WorkBoard, parent: BrowserWindow, resolveSource: () => Promise<Source>): Promise<boolean> {
  const original = await resolveSource()
  const choice = await dialog.showSaveDialog(parent,{
    title:'다운로드', defaultPath:join(app.getPath('downloads'),basename(original.path)),
    properties:['showOverwriteConfirmation']
  })
  if (choice.canceled || !choice.filePath) return false

  const verifySource = async () => {
    const current = await resolveSource()
    if (current.path !== original.path || current.report !== original.report) throw new Error('결재 대상이 변경되었습니다. 다시 확인해 주세요.')
  }
  await verifySource()
  const selected = await destination(choice.filePath,original,board)
  const temporary = join(dirname(selected.target),'.legal-download-' + randomUUID() + '.tmp')
  const file = await open(temporary,'wx',0o600)
  try {
    try {
      const reportHash = original.report === undefined ? undefined : createHash('sha256')
      await withBoardDocumentFile(original.path,async (size,read) => {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('원본 파일 크기를 확인해 주세요.')
        const buffer = Buffer.allocUnsafe(Math.min(size,256 * 1024))
        for (let position = 0; position < size;) {
          const chunk = buffer.subarray(0,Math.min(buffer.length,size-position))
          const count = await read(chunk,position)
          if (count <= 0) throw new Error('전송 중 원본이 변경되었습니다. 다시 다운로드해 주세요.')
          const bytes = chunk.subarray(0,count)
          reportHash?.update(bytes)
          await file.writeFile(bytes)
          position += count
        }
      })
      if (reportHash && reportHash.digest('hex') !== createHash('sha256').update(original.report!).digest('hex')) {
        throw new Error('보고서 원본이 변경되었습니다. 다시 확인해 주세요.')
      }
      await file.sync()
    } finally { await file.close() }

    await verifySource()
    const current = await destination(choice.filePath,original,board)
    const before = selected.stat, after = current.stat
    if (current.target !== selected.target || !sameFileVersion(before,after)) {
      throw new Error('저장할 파일이 변경되었습니다. 위치를 다시 선택해 주세요.')
    }
    if (after && original.path.startsWith('ssh://') && basename(selected.target).normalize('NFC').toLowerCase() === basename(original.path).normalize('NFC').toLowerCase()) {
      // A local mount can be the very same directory served over SFTP, under a different absolute path.
      const {rfsBoardStat} = await import('./remoteFs')
      const probe = original.path.slice(0,original.path.lastIndexOf('/') + 1) + basename(temporary)
      if (await rfsBoardStat(probe)) throw new Error('원본과 다른 저장 위치를 선택해 주세요.')
    }
    if (after) await rename(temporary,selected.target)
    else await publishNew(temporary,selected.target)
    return true
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
}

export function downloadBoardDocument(board: WorkBoard, id: string, path: string, parent: BrowserWindow): Promise<boolean> {
  return download(board,parent,async () => ({path:await board.documentPath(id,path)}))
}

export function downloadBoardReport(board: WorkBoard, id: string, parent: BrowserWindow): Promise<boolean> {
  return download(board,parent,async () => {
    const task = (await board.snapshot()).tasks.find(item => item.id === id)
    const {report} = await board.detail(id)
    if (!task || task.editedNeedsRun || !boardReportAvailable(report)) throw new Error('다운로드할 현재 업무 보고서가 없습니다.')
    const path = board.folder.startsWith('ssh://') ? board.folder.replace(/\/$/,'') + '/' + id + '.report.md' : join(board.folder,id + '.report.md')
    return {path,report}
  })
}
