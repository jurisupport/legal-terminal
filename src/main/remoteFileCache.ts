import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getSettings } from './settings'

const CACHE_VERSION = 1
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FILE_CACHE_BYTES = 256 * 1024 * 1024

interface RemoteFileCacheRecord {
  file: string
  size: number
  ts: number
}

interface RemoteFileCacheIndex {
  version?: number
  records?: Record<string, RemoteFileCacheRecord>
}

let loaded = false
let records = new Map<string, RemoteFileCacheRecord>()
let writeTimer: ReturnType<typeof setTimeout> | undefined

function cacheRoot(): string {
  return join(app.getPath('userData'), 'remote-file-cache')
}

function indexPath(): string {
  return join(cacheRoot(), 'index.json')
}

function namespacedKey(namespace: string, cacheKey: string): string {
  return `${namespace}\0${cacheKey}`
}

function cacheFilePath(relativePath: string): string {
  return join(cacheRoot(), relativePath)
}

function cacheFileRelativePath(id: string): string {
  const hash = createHash('sha256').update(id).digest('hex')
  return join('files', hash.slice(0, 2), hash)
}

async function enabled(): Promise<boolean> {
  return (await getSettings()).remoteFileCache === true
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await readFile(indexPath(), 'utf8')) as RemoteFileCacheIndex
    if (raw.version !== CACHE_VERSION || !raw.records || typeof raw.records !== 'object') return
    records = new Map(
      Object.entries(raw.records).filter(
        (item): item is [string, RemoteFileCacheRecord] =>
          typeof item[0] === 'string' &&
          !!item[1] &&
          typeof item[1].file === 'string' &&
          typeof item[1].size === 'number' &&
          typeof item[1].ts === 'number'
      )
    )
  } catch {
    records = new Map()
  }
}

async function flush(): Promise<void> {
  await ensureLoaded()
  const file = indexPath()
  if (records.size === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${Date.now()}.tmp`
  const body: RemoteFileCacheIndex = {
    version: CACHE_VERSION,
    records: Object.fromEntries(records)
  }
  await writeFile(tmp, JSON.stringify(body), 'utf8')
  await rename(tmp, file)
}

function scheduleFlush(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    void flush().catch(() => {})
  }, 500)
}

export async function readRemoteFileCache(namespace: string, cacheKey: string): Promise<Buffer | undefined> {
  if (!(await enabled())) return undefined
  await ensureLoaded()
  const id = namespacedKey(namespace, cacheKey)
  const record = records.get(id)
  if (!record) return undefined
  if (Date.now() - record.ts > DISK_CACHE_TTL_MS) {
    records.delete(id)
    void rm(cacheFilePath(record.file), { force: true }).catch(() => {})
    scheduleFlush()
    return undefined
  }
  try {
    return await readFile(cacheFilePath(record.file))
  } catch {
    records.delete(id)
    scheduleFlush()
    return undefined
  }
}

export function rememberRemoteFileCache(namespace: string, cacheKey: string, data: Buffer): void {
  void (async () => {
    if (!(await enabled())) return
    await ensureLoaded()
    const id = namespacedKey(namespace, cacheKey)
    if (data.byteLength > MAX_FILE_CACHE_BYTES) {
      const previous = records.get(id)
      if (previous) {
        records.delete(id)
        void rm(cacheFilePath(previous.file), { force: true }).catch(() => {})
        scheduleFlush()
      }
      return
    }
    const relative = cacheFileRelativePath(id)
    const file = cacheFilePath(relative)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${Date.now()}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, file)
    records.set(id, { file: relative, size: data.byteLength, ts: Date.now() })
    scheduleFlush()
  })().catch(() => {})
}

export function invalidateRemoteFileCache(
  namespace: string,
  predicate: (cacheKey: string, record: RemoteFileCacheRecord) => boolean
): void {
  void (async () => {
    await ensureLoaded()
    const prefix = `${namespace}\0`
    let changed = false
    for (const [id, record] of records) {
      if (!id.startsWith(prefix)) continue
      if (!predicate(id.slice(prefix.length), record)) continue
      records.delete(id)
      changed = true
      void rm(cacheFilePath(record.file), { force: true }).catch(() => {})
    }
    if (changed) scheduleFlush()
  })().catch(() => {})
}
