import { app } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getSettings } from './settings'

const CACHE_VERSION = 1
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface DiskCacheRecord {
  cwd?: string
  entries: unknown[]
  ts: number
}

interface DiskCacheFile {
  version?: number
  records?: Record<string, DiskCacheRecord>
}

let loaded = false
let records = new Map<string, DiskCacheRecord>()
let writeTimer: ReturnType<typeof setTimeout> | undefined

function cachePath(): string {
  return join(app.getPath('userData'), 'remote-dir-list-cache.json')
}

function key(namespace: string, cacheKey: string): string {
  return `${namespace}\0${cacheKey}`
}

function cloneEntries<T>(entries: T[]): T[] {
  return entries.map((entry) =>
    entry && typeof entry === 'object' ? ({ ...(entry as Record<string, unknown>) } as T) : entry
  )
}

async function diskCacheEnabled(): Promise<boolean> {
  return (await getSettings()).remoteDirectoryCache === true
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await readFile(cachePath(), 'utf8')) as DiskCacheFile
    if (raw.version !== CACHE_VERSION || !raw.records || typeof raw.records !== 'object') return
    records = new Map(
      Object.entries(raw.records).filter(
        (item): item is [string, DiskCacheRecord] =>
          typeof item[0] === 'string' &&
          !!item[1] &&
          typeof item[1].ts === 'number' &&
          Array.isArray(item[1].entries)
      )
    )
  } catch {
    records = new Map()
  }
}

async function flush(): Promise<void> {
  await ensureLoaded()
  const file = cachePath()
  if (records.size === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${Date.now()}.tmp`
  const body: DiskCacheFile = {
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

export async function readRemoteDirListCache<T>(
  namespace: string,
  cacheKey: string
): Promise<{ cwd?: string; entries: T[]; ts: number } | undefined> {
  if (!(await diskCacheEnabled())) return undefined
  await ensureLoaded()
  const id = key(namespace, cacheKey)
  const record = records.get(id)
  if (!record) return undefined
  if (Date.now() - record.ts > DISK_CACHE_TTL_MS) {
    records.delete(id)
    scheduleFlush()
    return undefined
  }
  return {
    cwd: record.cwd,
    entries: cloneEntries(record.entries as T[]),
    ts: record.ts
  }
}

export function rememberRemoteDirListCache<T>(
  namespace: string,
  cacheKey: string,
  record: { cwd?: string; entries: T[]; ts?: number }
): void {
  void (async () => {
    if (!(await diskCacheEnabled())) return
    await ensureLoaded()
    records.set(key(namespace, cacheKey), {
      cwd: record.cwd,
      entries: cloneEntries(record.entries),
      ts: record.ts ?? Date.now()
    })
    scheduleFlush()
  })().catch(() => {})
}

export function invalidateRemoteDirListCache(
  namespace: string,
  predicate: (cacheKey: string, record: DiskCacheRecord) => boolean
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
    }
    if (changed) scheduleFlush()
  })().catch(() => {})
}
