import { app, nativeImage, type IpcMain, type Session, type WebContents } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'fs/promises'
import { isAbsolute, join, posix, resolve } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { getSettings } from './settings'
import { isRemote, makeRemote, parseRemote, rfsDownloadToFile, rfsMkdir, rfsReadBytes, rfsRealpath, rfsStat, rfsWriteBytes } from './remoteFs'
import { mediaMimeType, type MediaChange, type MediaOpenInput, type MediaSnapshot, type MediaVersion } from '../shared/media'

export const MEDIA_SCHEME = {
  scheme: 'lt-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}
const MAX_CACHE_BYTES = 2 * 1024 ** 3
const MAX_CAPTURE_BYTES = 5 * 1024 ** 2
const EPHEMERAL_GRACE_MS = 10_000
type Signature = { size: number; mtimeMs: number }
interface Record extends MediaVersion { signature: string; file: string; ephemeral: boolean; accessedAt: number; observedAt: number }
interface Transfer {
  controller: AbortController
  consumers: Map<string, { sender: WebContents; requestId: string }>
  promise: Promise<Record>
  downloadedBytes: number
  totalBytes: number
  record?: Record
  lastProgress?: number
}
const records = new Map<string, Record>()
const tokens = new Map<string, { owner: number; record: Record }>()
const requests = new Map<string, AbortController>()
const transfers = new Map<string, Transfer>()
const watchedSenders = new Set<number>()
let loaded: Promise<void> | undefined
let reservedBytes = 0
let metadataQueue: Promise<unknown> = Promise.resolve()
let cleanupTimer: ReturnType<typeof setTimeout> | undefined
const cacheRoot = (): string => join(app.getPath('userData'), 'media-review')
const filesRoot = (): string => join(cacheRoot(), 'files')
const signature = (s: Signature): string => `${s.size}:${s.mtimeMs}`
const recordKey = (path: string, version: string): string => `${path}\0${version}`
const fileName = (path: string, version: string): string => createHash('sha256').update(recordKey(path, version)).digest('hex') + '.media'
const filePath = (record: Record): string => join(filesRoot(), record.file)

// ponytail: only metadata is serialized; separate transfers stream concurrently. Use a database if the index grows beyond a few thousand reviews.
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = metadataQueue.then(fn)
  metadataQueue = next.catch(() => {})
  return next
}

function sourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('미디어 경로가 올바르지 않습니다.')
  if (isRemote(value)) {
    const remote = parseRemote(value)
    if (!remote.profileId || !remote.path.startsWith('/')) throw new Error('원격 미디어 경로가 올바르지 않습니다.')
    return makeRemote(remote.profileId, posix.normalize(remote.path))
  }
  if (!isAbsolute(value)) throw new Error('미디어는 절대 경로로 열어야 합니다.')
  return resolve(value)
}

async function sourceStat(path: string): Promise<Signature> {
  const info = isRemote(path) ? await rfsStat(path) : await stat(path).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs, isDir: !s.isFile() }))
  if (info.isDir || !Number.isSafeInteger(info.size) || info.size <= 0) throw new Error('비어 있지 않은 일반 미디어 파일만 열 수 있습니다.')
  return { size: info.size, mtimeMs: info.mtimeMs ?? 0 }
}

function publicVersion(record: Record): MediaVersion {
  return { versionId: record.versionId, sourcePath: record.sourcePath, size: record.size, mimeType: record.mimeType, mtimeMs: record.mtimeMs, createdAt: record.createdAt }
}

async function flushIndex(): Promise<void> {
  const temporary = join(cacheRoot(), 'index.json.tmp')
  const remotePersistent = (await getSettings()).remoteFileCache === true
  await writeFile(temporary, JSON.stringify({ version: 1, records: [...records.values()].filter((r) => !r.ephemeral && (!isRemote(r.sourcePath) || remotePersistent)) }), { mode: 0o600 })
  await rename(temporary, join(cacheRoot(), 'index.json'))
}

function ensureLoaded(): Promise<void> {
  loaded ??= (async () => {
    await mkdir(filesRoot(), { recursive: true, mode: 0o700 })
    const index = await readFile(join(cacheRoot(), 'index.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    if (index?.version === 1 && Array.isArray(index.records)) {
      for (const value of index.records) {
        if (!value || typeof value.sourcePath !== 'string' || !/^[a-f0-9]{64}$/.test(value.versionId) ||
          value.file !== fileName(value.sourcePath, value.versionId) || value.mimeType !== mediaMimeType(value.sourcePath) ||
          !Number.isSafeInteger(value.size) || value.size <= 0 || !Number.isFinite(value.createdAt) ||
          !Number.isFinite(value.mtimeMs) || typeof value.signature !== 'string' || value.ephemeral) continue
        const exists = await stat(filePath(value)).then((s) => s.isFile() && s.size === value.size).catch(() => false)
        if (exists) records.set(recordKey(value.sourcePath, value.versionId), { ...value, accessedAt: Number(value.accessedAt) || value.createdAt, observedAt: Number(value.observedAt) || value.createdAt })
      }
    }
    const known = new Set([...records.values()].map((r) => r.file))
    for (const file of await readdir(filesRoot())) {
      if ((/^[a-f0-9]{64}\.media$/.test(file) && !known.has(file)) || /^[a-f0-9-]+\.part$/.test(file)) {
        await rm(join(filesRoot(), file), { force: true })
      }
    }
  })()
  return loaded
}

function protectedRecords(): Set<Record> {
  const protectedSet = new Set([...tokens.values()].map((t) => t.record))
  for (const transfer of transfers.values()) if (transfer.record) protectedSet.add(transfer.record)
  for (const current of [...protectedSet]) {
    const previous = [...records.values()].filter((r) => r.sourcePath === current.sourcePath && r.observedAt < current.observedAt)
      .sort((a, b) => b.observedAt - a.observedAt)[0]
    if (previous) protectedSet.add(previous)
  }
  return protectedSet
}

async function prune(requiredBytes = 0): Promise<void> {
  const protectedSet = protectedRecords()
  let used = [...records.values()].reduce((sum, r) => sum + r.size, 0) + reservedBytes
  const remotePersistent = (await getSettings()).remoteFileCache === true
  for (const record of [...records.values()].sort((a, b) => a.accessedAt - b.accessedAt)) {
    if (protectedSet.has(record)) continue
    const expires = record.ephemeral || (isRemote(record.sourcePath) && !remotePersistent)
    if (used + requiredBytes <= MAX_CACHE_BYTES && (!expires || Date.now() - record.accessedAt < EPHEMERAL_GRACE_MS)) continue
    await rm(filePath(record), { force: true })
    records.delete(recordKey(record.sourcePath, record.versionId))
    used -= record.size
  }
  if (used + requiredBytes > MAX_CACHE_BYTES) throw new Error('미디어 저장 공간(2GiB)이 부족합니다. 열려 있는 영상 탭을 닫고 다시 시도하세요.')
}

async function localSnapshot(path: string, destination: string, before: Signature, transfer: Transfer): Promise<{ sha256: string } & Signature> {
  const original = await stat(path)
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.length
    if (size > before.size) { done(new Error('복사 중 원본 미디어가 변경되었습니다.')); return }
    hash.update(chunk)
    reportProgress(transfer, size, before.size)
    done(null, chunk)
  } })
  await pipeline(createReadStream(path), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: transfer.controller.signal })
  const after = await stat(path)
  if (size !== before.size || signature(before) !== signature(after) || original.ino !== after.ino || original.ctimeMs !== after.ctimeMs) {
    throw new Error('복사 중 원본 미디어가 변경되었습니다. 렌더링 완료 후 다시 여세요.')
  }
  return { size, mtimeMs: before.mtimeMs, sha256: hash.digest('hex') }
}

function reportProgress(transfer: Transfer, downloadedBytes: number, totalBytes: number): void {
  transfer.downloadedBytes = downloadedBytes
  transfer.totalBytes = totalBytes
  if (downloadedBytes !== 0 && downloadedBytes !== totalBytes && Date.now() - (transfer.lastProgress ?? 0) < 100) return
  transfer.lastProgress = Date.now()
  for (const { sender, requestId } of transfer.consumers.values()) {
    if (!sender.isDestroyed()) sender.send('media:progress', { requestId, downloadedBytes, totalBytes })
  }
}

async function download(path: string, before: Signature, transfer: Transfer): Promise<Record> {
  const temporary = join(filesRoot(), randomUUID() + '.part')
  let reserved = false
  try {
    await serialized(async () => {
      await prune(before.size)
      const disk = await statfs(filesRoot()).catch(() => undefined)
      if (disk && disk.bavail * disk.bsize < before.size + reservedBytes) throw new Error('디스크 여유 공간이 부족합니다.')
      reservedBytes += before.size
      reserved = true
    })
    transfer.controller.signal.throwIfAborted()
    const result = isRemote(path)
      ? await rfsDownloadToFile(path, temporary, { signal: transfer.controller.signal, onProgress: (p) => reportProgress(transfer, p.downloadedBytes, p.totalBytes ?? before.size) })
      : await localSnapshot(path, temporary, before, transfer)
    if (signature(result) !== signature(before)) throw new Error('전송 중 원본 미디어가 변경되었습니다. 다시 시도하세요.')
    transfer.controller.signal.throwIfAborted()
    return await serialized(async () => {
      transfer.controller.signal.throwIfAborted()
      const key = recordKey(path, result.sha256)
      let observedAt = Date.now()
      for (const record of records.values()) if (record.sourcePath === path) observedAt = Math.max(observedAt, record.observedAt + 1)
      const existing = records.get(key)
      if (existing) {
        // The body may have been evicted externally; the verified new copy also repairs corruption.
        await rename(temporary, filePath(existing))
        reservedBytes -= before.size
        reserved = false
        existing.signature = signature(result)
        existing.mtimeMs = result.mtimeMs
        existing.accessedAt = Date.now()
        existing.observedAt = observedAt
        transfer.record = existing
        await flushIndex()
        return existing
      }
      const record: Record = {
        versionId: result.sha256, sourcePath: path, size: result.size, mimeType: mediaMimeType(path)!,
        mtimeMs: result.mtimeMs, createdAt: Date.now(), accessedAt: Date.now(), observedAt, signature: signature(result),
        file: fileName(path, result.sha256), ephemeral: isRemote(path) && (await getSettings()).remoteFileCache !== true
      }
      await rename(temporary, filePath(record))
      records.set(key, record)
      reservedBytes -= before.size
      reserved = false
      transfer.record = record
      await flushIndex()
      return record
    })
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
    if (reserved) await serialized(async () => { reservedBytes -= before.size })
  }
}

function pin(sender: WebContents, record: Record): MediaSnapshot {
  if (sender.isDestroyed()) throw new Error('미디어 탭이 닫혔습니다.')
  const token = randomUUID()
  tokens.set(token, { owner: sender.id, record })
  record.accessedAt = Date.now()
  return { ...publicVersion(record), token, url: `lt-media://snapshot/${token}` }
}

async function openMedia(sender: WebContents, input: MediaOpenInput): Promise<MediaSnapshot> {
  const path = sourcePath(input?.path)
  if (!mediaMimeType(path)) throw new Error('지원하는 미디어 확장자가 아닙니다.')
  if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200) throw new Error('미디어 요청 ID가 올바르지 않습니다.')
  if (input.versionId !== undefined && !/^[a-f0-9]{64}$/.test(input.versionId)) throw new Error('미디어 버전이 올바르지 않습니다.')
  const requestKey = `${sender.id}:${input.requestId}`
  if (requests.has(requestKey)) throw new Error('동일한 미디어 요청이 이미 진행 중입니다.')
  const controller = new AbortController()
  requests.set(requestKey, controller)
  try {
    await ensureLoaded()
    controller.signal.throwIfAborted()
    if (input.versionId) {
      return await serialized(async () => {
        controller.signal.throwIfAborted()
        const record = records.get(recordKey(path, input.versionId!))
        if (!record || !(await stat(filePath(record)).then((s) => s.size === record.size).catch(() => false))) {
          throw new Error('이 미디어 버전은 만료되었습니다. 현재 원본을 별도로 열어 주세요.')
        }
        return pin(sender, record)
      })
    }
    let before: Signature
    try { before = await sourceStat(path) } catch (error) {
      if (input.force) throw error
      return await serialized(async () => {
        controller.signal.throwIfAborted()
        const previous = [...records.values()].filter((r) => r.sourcePath === path).sort((a, b) => b.observedAt - a.observedAt)[0]
        if (!previous || !(await stat(filePath(previous)).then((s) => s.size === previous.size).catch(() => false))) throw error
        return pin(sender, previous)
      })
    }
    controller.signal.throwIfAborted()
    if (!input.force) {
      const cached = await serialized(async () => {
        controller.signal.throwIfAborted()
        const record = [...records.values()].filter((r) => r.sourcePath === path && r.signature === signature(before)).sort((a, b) => b.observedAt - a.observedAt)[0]
        return record && await stat(filePath(record)).then((s) => s.size === record.size).catch(() => false) ? pin(sender, record) : undefined
      })
      if (cached) return cached
    }
    const transferKey = `${path}\0${signature(before)}\0${!!input.force}`
    let transfer = transfers.get(transferKey)
    if (!transfer || transfer.controller.signal.aborted) {
      transfer = { controller: new AbortController(), consumers: new Map(), promise: undefined!, downloadedBytes: 0, totalBytes: before.size }
      transfers.set(transferKey, transfer)
      const current = transfer
      transfer.promise = download(path, before, transfer).finally(() => { if (!current.consumers.size && transfers.get(transferKey) === current) transfers.delete(transferKey) })
    }
    const current = transfer
    current.consumers.set(requestKey, { sender, requestId: input.requestId })
    reportProgress(current, current.downloadedBytes, current.totalBytes)
    return await new Promise<MediaSnapshot>((resolveOpen, rejectOpen) => {
      const leave = (): void => {
        controller.signal.removeEventListener('abort', cancel)
        current.consumers.delete(requestKey)
        if (!current.consumers.size) {
          current.controller.abort()
          if (transfers.get(transferKey) === current) transfers.delete(transferKey)
        }
      }
      const cancel = (): void => { leave(); rejectOpen(new Error('미디어 전송을 취소했습니다.')) }
      controller.signal.addEventListener('abort', cancel, { once: true })
      if (controller.signal.aborted) cancel()
      void current.promise.then(async (record) => {
        if (controller.signal.aborted) return
        try {
          const snapshot = await serialized(async () => { controller.signal.throwIfAborted(); return pin(sender, record) })
          leave()
          resolveOpen(snapshot)
        } catch (error) { leave(); rejectOpen(error) }
      }, (error) => { leave(); rejectOpen(error) })
    })
  } finally { requests.delete(requestKey) }
}

async function releaseOwner(owner: number, token?: string): Promise<void> {
  for (const [id, value] of tokens) if (value.owner === owner && (!token || token === id)) {
    value.record.accessedAt = Date.now()
    tokens.delete(id)
  }
  await ensureLoaded()
  await serialized(async () => { await prune(); await flushIndex() })
  // Leave enough time for a moved/detached tab to obtain its own token.
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined
    void serialized(async () => { await prune(); await flushIndex() }).catch(() => {})
  }, EPHEMERAL_GRACE_MS + 20)
  cleanupTimer.unref?.()
}

function tokenFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'lt-media:' || url.host !== 'snapshot' || url.search || url.hash || url.username || url.password) return undefined
    return /^\/[a-f0-9-]{36}$/.test(url.pathname) ? url.pathname.slice(1) : undefined
  } catch { return undefined }
}

function byteRange(value: string | null, size: number): { start: number; end: number } | undefined {
  if (!value) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return undefined
  if ([match[1], match[2]].some((part) => part && !Number.isSafeInteger(Number(part)))) return undefined
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size || (!match[1] && Number(match[2]) <= 0)) return undefined
  return { start, end }
}

export function registerMediaProtocol(ses: Session): void {
  // A capability token also belongs to its window; another window must open its own review.
  ses.webRequest.onBeforeRequest({ urls: ['lt-media://*/*'] }, (details, callback) => {
    const token = tokenFromUrl(details.url)
    const capability = token && tokens.get(token)
    callback({ cancel: !capability || capability.owner !== details.webContentsId || !!details.frame?.parent })
  })
  ses.protocol.handle(MEDIA_SCHEME.scheme, async (request) => {
    const token = tokenFromUrl(request.url)
    const capability = token && tokens.get(token)
    if (!capability) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const record = capability.record
    const range = byteRange(request.headers.get('range'), record.size)
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${record.size}` } })
    const headers: { [name: string]: string } = {
      'Content-Type': record.mimeType, 'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    }
    const partial = !!request.headers.get('range')
    if (partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${record.size}`
    try {
      const info = await stat(filePath(record))
      if (!info.isFile() || info.size !== record.size) return new Response(null, { status: 410 })
      const stream = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(filePath(record), { start: range.start, end: range.end }))
      return new Response(stream as ReadableStream<Uint8Array> | null, { status: partial ? 206 : 200, headers })
    } catch { return new Response(null, { status: 410 }) }
  })
}

function childPath(directory: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') || posix.isAbsolute(relative) || relative.split('/').includes('..') || /^[a-z]+:/i.test(relative)) {
    throw new Error('완료 영상 경로는 프로젝트 내부의 상대 경로여야 합니다.')
  }
  return isRemote(directory) ? makeRemote(parseRemote(directory).profileId, posix.join(parseRemote(directory).path, relative)) : join(directory, relative)
}

async function checkMedia(input: { path: string; versionId: string; projectDir?: string }): Promise<MediaChange> {
  const path = sourcePath(input.path)
  await ensureLoaded()
  const record = records.get(recordKey(path, input.versionId))
  if (!record) return { changed: true, completed: false }
  const current = await sourceStat(path).catch(() => undefined)
  const changed = !!current && signature(current) !== record.signature
  if (!input.projectDir) return { changed, completed: false }
  const directory = sourcePath(input.projectDir)
  const manifestPath = childPath(directory, '.legal-terminal/media.json')
  try {
    const metadata = isRemote(manifestPath) ? await rfsStat(manifestPath) : await stat(manifestPath)
    if (metadata.size > 64 * 1024) return { changed, completed: false }
    const raw = isRemote(manifestPath) ? await rfsReadBytes(manifestPath) : await readFile(manifestPath)
    const manifest = JSON.parse(raw.toString('utf8'))
    const done = manifest?.completed
    if (manifest.version !== 1 || !['ffmpeg', 'remotion'].includes(manifest.engine) || !done || typeof done.version !== 'string' || !done.version || typeof done.path !== 'string' || !Number.isFinite(Date.parse(done.completedAt))) {
      return { changed, completed: false }
    }
    const completedPath = childPath(directory, done.path)
    if (!mediaMimeType(completedPath) || completedPath === path) return { changed, completed: false }
    const actual = isRemote(completedPath) ? await rfsRealpath(completedPath) : await realpath(completedPath)
    const root = isRemote(directory) ? await rfsRealpath(directory) : await realpath(directory)
    if (!actual.startsWith(root.replace(/[\\/]+$/, '') + (!isRemote(directory) && process.platform === 'win32' ? '\\' : '/'))) return { changed, completed: false }
    const completedStat = await sourceStat(completedPath)
    const completionTime = Date.parse(done.completedAt)
    // A stale success marker cannot bless a newer file that is still being rendered.
    const newerLocalCompletion = isRemote(directory) || completionTime >= (record.observedAt ?? record.createdAt)
    const completed = newerLocalCompletion && completionTime + 1 >= completedStat.mtimeMs && completionTime > record.mtimeMs
    return completed ? { changed: true, completed: true, path: completedPath } : { changed, completed: false }
  } catch { return { changed, completed: false } }
}

async function saveCapture(input: { bytes: Uint8Array; targetDir?: string }): Promise<{ path: string }> {
  if (!(input?.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CAPTURE_BYTES) throw new Error('캡처는 5MiB 이하 이미지여야 합니다.')
  const bytes = Buffer.from(input.bytes)
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if ((!png && !jpeg) || nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('올바른 PNG 또는 JPEG 캡처가 아닙니다.')
  const name = `${randomUUID()}.${png ? 'png' : 'jpg'}`
  const target = input.targetDir ? sourcePath(input.targetDir) : app.getPath('userData')
  if (isRemote(target)) {
    let directory = target
    const root = (await rfsRealpath(target)).replace(/\/+$/, '') + '/'
    for (const part of ['.legal-terminal', 'media-context']) {
      const next = childPath(directory, part)
      const info = await rfsStat(next).catch(() => undefined)
      if (info && !info.isDir) throw new Error('캡처 저장 위치가 폴더가 아닙니다.')
      if (!info) await rfsMkdir(directory, part).catch(async (error) => { if (!(await rfsStat(next)).isDir) throw error })
      if (!(await rfsRealpath(next)).startsWith(root)) throw new Error('캡처 저장 폴더가 프로젝트 외부를 가리킵니다.')
      directory = next
    }
    const path = await rfsWriteBytes(directory, name, bytes)
    const uploaded = await rfsStat(path)
    if (uploaded.size !== bytes.length || uploaded.isDir) throw new Error('원격 캡처 업로드 확인에 실패했습니다.')
    return { path }
  }
  const directory = childPath(target, '.legal-terminal/media-context')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = (await realpath(target)).replace(/[\\/]+$/, '') + (process.platform === 'win32' ? '\\' : '/')
  if (!(await realpath(directory)).startsWith(root)) throw new Error('캡처 저장 폴더가 프로젝트 외부를 가리킵니다.')
  const path = join(directory, name)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { path }
}

export function registerMediaIpc(ipc: IpcMain): void {
  ipc.handle('media:open', (event, input: MediaOpenInput) => {
    const sender = event.sender
    if (event.senderFrame && event.senderFrame !== sender.mainFrame) throw new Error('미디어는 앱 창에서만 열 수 있습니다.')
    if (!watchedSenders.has(sender.id)) {
      watchedSenders.add(sender.id)
      sender.once('destroyed', () => {
        for (const [key, controller] of requests) if (key.startsWith(`${sender.id}:`)) controller.abort()
        watchedSenders.delete(sender.id)
        void releaseOwner(sender.id).catch(() => {})
      })
    }
    return openMedia(sender, input)
  })
  ipc.handle('media:release', (event, token: string) => releaseOwner(event.sender.id, token))
  ipc.handle('media:cancel', (event, requestId: string) => { requests.get(`${event.sender.id}:${requestId}`)?.abort() })
  ipc.handle('media:versions', async (_event, value: string) => {
    const path = sourcePath(value)
    await ensureLoaded()
    return [...records.values()].filter((r) => r.sourcePath === path).sort((a, b) => b.createdAt - a.createdAt).map(publicVersion)
  })
  ipc.handle('media:check', (_event, input) => checkMedia(input))
  ipc.handle('media:saveCapture', (_event, input) => saveCapture(input))
  app.once('before-quit', () => {
    if (cleanupTimer) clearTimeout(cleanupTimer)
    for (const controller of requests.values()) controller.abort()
    tokens.clear()
    for (const record of records.values()) record.accessedAt = 0
    void ensureLoaded().then(() => serialized(async () => { await prune(); await flushIndex() })).catch(() => {})
  })
}
