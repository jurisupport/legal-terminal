import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

export interface CaseEntry {
  drafts: string
  records?: string
  name: string
  ts: number
}
interface Store {
  pairings: Record<string, string> // 작성서류 폴더 → 소송기록 폴더
  recent: CaseEntry[]
  // JuriSupport 사건 id → 로컬 폴더 매핑 (대시보드에서 한 번 지정하면 기억)
  jsPairings?: Record<string, { drafts: string; records?: string }>
}

function storeFile(): string {
  return join(app.getPath('userData'), 'cases.json')
}
async function load(): Promise<Store> {
  try {
    const s = JSON.parse(await readFile(storeFile(), 'utf8')) as Partial<Store>
    return { pairings: s.pairings ?? {}, recent: s.recent ?? [], jsPairings: s.jsPairings ?? {} }
  } catch {
    return { pairings: {}, recent: [], jsPairings: {} }
  }
}
async function save(s: Store): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(storeFile(), JSON.stringify(s, null, 2), 'utf8')
}

export async function getPairing(drafts: string): Promise<string | undefined> {
  return (await load()).pairings[drafts]
}
export async function setPairing(drafts: string, records: string): Promise<void> {
  const s = await load()
  s.pairings[drafts] = records
  await save(s)
}
export async function getJsPairing(
  id: string
): Promise<{ drafts: string; records?: string } | undefined> {
  return (await load()).jsPairings?.[id]
}
export async function setJsPairing(
  id: string,
  p: { drafts: string; records?: string }
): Promise<void> {
  const s = await load()
  s.jsPairings = s.jsPairings ?? {}
  s.jsPairings[id] = p
  await save(s)
}
export async function listHistory(): Promise<CaseEntry[]> {
  return (await load()).recent
}
export async function addHistory(e: {
  drafts: string
  records?: string
  name: string
}): Promise<CaseEntry[]> {
  const s = await load()
  s.recent = s.recent.filter((x) => x.drafts !== e.drafts)
  s.recent.unshift({ drafts: e.drafts, records: e.records, name: e.name, ts: Date.now() })
  s.recent = s.recent.slice(0, 20)
  await save(s)
  return s.recent
}
