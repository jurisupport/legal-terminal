// 문서 사진 네 꼭짓점 보정 — 원본 디코딩(HEIC)과 결과 저장(보정이미지/ + 꼭짓점 JSON).
// 이미지 계산 자체는 렌더러(viewer/docWarp.ts)가 한다.
import { app, type IpcMain } from 'electron'
import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix } from 'path'
import { promisify } from 'util'
import { isRemote, makeRemote, parseRemote, rfsMkdir, rfsReadBytes, rfsWriteBytes } from './remoteFs'

const run = promisify(execFile)
export const DOC_WARP_DIR = '보정이미지'
const HEIF_RE = /\.(heic|heif)$/i

function checkPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || (!isRemote(value) && !isAbsolute(value))) {
    throw new Error('이미지 경로가 올바르지 않습니다.')
  }
  return value
}

function parentOf(path: string): string {
  if (!isRemote(path)) return dirname(path)
  const { profileId, path: p } = parseRemote(path)
  return makeRemote(profileId, posix.dirname(p))
}

function childOf(dir: string, name: string): string {
  if (!isRemote(dir)) return join(dir, name)
  const { profileId, path } = parseRemote(dir)
  return makeRemote(profileId, posix.join(path, name))
}

const nameOf = (path: string): string => (isRemote(path) ? posix.basename(parseRemote(path).path) : basename(path))

/** 파일 이름에 쓸 수 없는 글자만 바꾼다. 한글·괄호는 그대로 둔다 */
export function safeOutputName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120)
  return cleaned || '보정이미지'
}

export const sidecarName = (sourcePath: string): string => `${nameOf(sourcePath)}.꼭짓점.json`

/** HEIC는 Chromium이 못 읽으므로 macOS sips로 JPEG 변환(회전 정보 유지). 나머지는 그대로 */
async function decodeForCanvas(path: string, bytes: Buffer): Promise<{ bytes: Buffer; converted: boolean }> {
  if (!HEIF_RE.test(path)) return { bytes, converted: false }
  if (process.platform !== 'darwin') {
    throw new Error('이 컴퓨터에서는 HEIC 사진을 열 수 없습니다. 휴대폰에서 JPG로 보내거나 macOS에서 열어 주세요.')
  }
  const dir = await mkdtemp(join(app.getPath('temp'), 'legal-terminal-docwarp-'))
  try {
    const input = join(dir, `source${extname(path).toLowerCase()}`)
    const output = join(dir, 'decoded.jpg')
    await writeFile(input, bytes)
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', input, '--out', output], { timeout: 60_000 })
    return { bytes: await readFile(output), converted: true }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function ensureDir(parent: string, name: string): Promise<string> {
  const dir = childOf(parent, name)
  if (isRemote(parent)) {
    await rfsMkdir(parent, name).catch((e: unknown) => {
      // 이미 있으면 그대로 쓴다 (SFTP는 EEXIST 대신 일반 실패를 돌려준다)
      if (!/exist|failure/i.test(String(e))) throw e
    })
  } else {
    await mkdir(dir, { recursive: true })
  }
  return dir
}

async function writeBytes(dir: string, name: string, data: Buffer): Promise<string> {
  if (isRemote(dir)) return rfsWriteBytes(dir, name, data)
  const full = join(dir, name)
  await writeFile(full, data)
  return full
}

export interface DocWarpSaveInput {
  sourcePath: string
  outputs: { name: string; data: Uint8Array }[]
  sidecar: string
}

export function registerDocWarpIpc(ipcMain: IpcMain, readBytes: (path: string) => Promise<Buffer>): void {
  ipcMain.handle('docwarp:decode', async (_e, value: unknown) => {
    const path = checkPath(value)
    const decoded = await decodeForCanvas(path, await readBytes(path))
    const b = decoded.bytes
    return { bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), converted: decoded.converted }
  })

  ipcMain.handle('docwarp:loadSidecar', async (_e, value: unknown) => {
    const path = checkPath(value)
    const file = childOf(childOf(parentOf(path), DOC_WARP_DIR), sidecarName(path))
    try {
      const buf = isRemote(file) ? await rfsReadBytes(file, undefined, { fresh: true }) : await readFile(file)
      return buf.toString('utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('docwarp:save', async (_e, input: DocWarpSaveInput) => {
    const source = checkPath(input?.sourcePath)
    if (!Array.isArray(input.outputs) || !input.outputs.length || input.outputs.length > 20) throw new Error('저장할 이미지가 없습니다.')
    if (typeof input.sidecar !== 'string' || input.sidecar.length > 1_000_000) throw new Error('꼭짓점 정보가 올바르지 않습니다.')
    const dir = await ensureDir(parentOf(source), DOC_WARP_DIR)
    const used = new Set<string>()
    const written: string[] = []
    for (const out of input.outputs) {
      if (!(out?.data instanceof Uint8Array) || out.data.byteLength === 0) throw new Error('보정 이미지가 비어 있습니다.')
      let name = `${safeOutputName(out.name)}.jpg`
      for (let i = 2; used.has(name); i++) name = `${safeOutputName(out.name)}_${i}.jpg`
      used.add(name)
      written.push(await writeBytes(dir, name, Buffer.from(out.data)))
    }
    const sidecar = await writeBytes(dir, sidecarName(source), Buffer.from(input.sidecar, 'utf8'))
    return { dir, files: written, sidecar }
  })
}
