import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import {
  emptyCaseStore,
  parseCaseStoreText,
  type CaseEntry,
  type CaseStore
} from './caseStoreData'

function storeFile(): string {
  return join(app.getPath('userData'), 'cases.json')
}
async function load(): Promise<CaseStore> {
  try {
    return parseCaseStoreText(await readFile(storeFile(), 'utf8'))
  } catch {
    return emptyCaseStore()
  }
}

async function writeStore(s: CaseStore): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const file = storeFile()
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
  await rename(tmp, file)
}

let storeQueue: Promise<unknown> = Promise.resolve()

async function readStore(): Promise<CaseStore> {
  await storeQueue.catch(() => undefined)
  return load()
}

async function updateStore<T>(fn: (s: CaseStore) => T | Promise<T>): Promise<T> {
  const run = storeQueue.catch(() => undefined).then(async () => {
    const s = await load()
    const result = await fn(s)
    await writeStore(s)
    return result
  })
  storeQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function getPairing(drafts: string): Promise<string | undefined> {
  return (await readStore()).pairings[drafts]
}
export async function setPairing(drafts: string, records: string): Promise<void> {
  await updateStore((s) => {
    s.pairings[drafts] = records
  })
}
export async function getJsPairing(
  id: string
): Promise<{ drafts: string; records?: string } | undefined> {
  return (await readStore()).jsPairings[id]
}
export async function setJsPairing(
  id: string,
  p: { drafts: string; records?: string }
): Promise<void> {
  await updateStore((s) => {
    s.jsPairings[id] = p
  })
}
export async function listHistory(): Promise<CaseEntry[]> {
  return (await readStore()).recent
}
export async function addHistory(e: {
  drafts: string
  records?: string
  name: string
}): Promise<CaseEntry[]> {
  return updateStore((s) => {
    s.recent = s.recent.filter((x) => x.drafts !== e.drafts)
    s.recent.unshift({ drafts: e.drafts, records: e.records, name: e.name, ts: Date.now() })
    s.recent = s.recent.slice(0, 20)
    return s.recent
  })
}
