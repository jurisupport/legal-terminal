import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

const pageBytes = 256 * 1024
const extensions = new Set(['.md', '.mdx', '.markdown', '.txt', '.csv', '.json'])
const invalidOffset = () => new Error('문서를 읽을 위치가 올바르지 않습니다.')
type ReadBytes = (buffer: Buffer, position: number) => Promise<number>

async function readPage(size: number, offset: number, readBytes: ReadBytes) {
  if (!Number.isSafeInteger(size) || offset > size) throw invalidOffset()
  async function bytes(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const count = await readBytes(buffer.subarray(done), position + done)
      if (!count) throw new Error('읽는 동안 문서가 변경되었습니다. 다시 열어 주세요.')
      done += count
    }
    return buffer
  }

  // One byte of lookahead distinguishes an exact UTF-8 boundary from a split code point.
  const page = await bytes(offset, Math.min(pageBytes + 1, size - offset))
  const header = offset === 0 ? page : await bytes(0, Math.min(3, size))
  const le = header[0] === 0xff && header[1] === 0xfe
  const be = header[0] === 0xfe && header[1] === 0xff
  const utf8Bom = header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf
  const bomLength = le || be ? 2 : utf8Bom ? 3 : 0
  if ((offset > 0 && offset < bomLength) || ((le || be) && offset % 2 !== 0)) throw invalidOffset()

  let end = Math.min(pageBytes, page.length)
  if (page.length > end) {
    if (le || be) {
      const unit = le ? page.readUInt16LE(end - 2) : page.readUInt16BE(end - 2)
      if (unit >= 0xd800 && unit <= 0xdbff) end -= 2
    } else {
      for (let i = 0; i < 3 && (page[end] & 0xc0) === 0x80; i++) end--
    }
  }
  const start = offset === 0 ? bomLength : 0
  let text: string
  try {
    const decoder = new TextDecoder(le ? 'utf-16le' : be ? 'utf-16be' : 'utf-8', {fatal: true, ignoreBOM: true})
    text = decoder.decode(page.subarray(start, end))
  } catch {
    throw new Error('텍스트 인코딩이나 읽기 위치를 확인해 주세요.')
  }
  if (text.includes('\0')) throw new Error('일반 텍스트 문서가 아닙니다.')
  return {text, size, nextOffset: offset + end < size ? offset + end : null}
}

/** Operate on one verified, read-only handle without buffering the whole document. */
export async function withBoardDocumentFile<T>(path: string, consume: (size: number, read: ReadBytes) => Promise<T>): Promise<T> {
  if (path.startsWith('ssh://')) {
    const {rfsWithBoardDocument} = await import('./remoteFs')
    return rfsWithBoardDocument(path, consume)
  }
  if (!isAbsolute(path)) throw new Error('문서의 절대 경로를 확인해 주세요.')
  const initial = await lstat(path)
  if (!initial.isFile()) throw new Error('일반 파일만 읽을 수 있습니다.')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.ino !== initial.ino || before.dev !== initial.dev || await realpath(path) !== path) {
      throw new Error('문서 위치가 변경되었습니다. 다시 열어 주세요.')
    }
    const result = await consume(before.size, async (buffer, position) =>
      (await file.read(buffer, 0, buffer.length, position)).bytesRead)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('읽는 동안 문서가 변경되었습니다. 다시 열어 주세요.')
    return result
  } finally { await file.close() }
}

/** The caller re-resolves the selected board artifact on each page request. Offsets are file bytes. */
export async function readBoardDocumentText(path: string, offset: number): Promise<{text: string; nextOffset: number | null; size: number}> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidOffset()
  if (!extensions.has(extname(path).toLowerCase())) throw new Error('텍스트 문서 형식을 확인해 주세요.')
  return withBoardDocumentFile(path, (size, read) => readPage(size, offset, read))
}
