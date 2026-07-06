import { app } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import {
  emptyCaseStore,
  parseCaseStoreText,
  type CaseEntry,
  type CaseStore
} from './caseStoreData'
import {
  CASE_PAIRING_FILE_VERSION,
  MAX_CASE_PAIRING_ENTRIES,
  legacyJsPairingsToRecords,
  mergeCaseEntries,
  parseCasePairingFileText,
  type CasePairingRecord
} from './caseSyncData'

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

// ── 사건→폴더 지정(jsPairings) — 기기 공유 경로(~/.claude)에 둔다 ─────────────
// 세션 인덱스와 같은 이유: 이 호스트에서 직접 실행한 앱과 다른 컴퓨터에서 SSH로
// 접속한 앱(원격 동기화 스크립트)이 같은 파일을 보게 해, 한 번 지정한 폴더가
// 모든 기기에서 공유되도록 한다. 병합 규칙은 caseSyncData 참고.

function casePairingPath(): string {
  return join(homedir(), '.claude', 'legal-terminal-cases.json')
}

// 읽기-수정-쓰기를 프로세스 안에서 직렬화 — 이관·원격 풀·저장이 동시에 돌 때
// 늦게 끝난 쪽이 옛 스냅샷 기준으로 저장해 지정이 유실되는 것을 막는다.
let pairingChain: Promise<unknown> = Promise.resolve()

function withPairingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = pairingChain.then(fn, fn)
  pairingChain = run.catch(() => undefined)
  return run
}

async function readPairingFile(): Promise<CasePairingRecord[]> {
  try {
    return parseCasePairingFileText(await readFile(casePairingPath(), 'utf8'))
  } catch {
    return []
  }
}

async function writePairingFile(entries: CasePairingRecord[]): Promise<void> {
  const file = casePairingPath()
  await mkdir(dirname(file), { recursive: true })
  const sorted = [...entries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CASE_PAIRING_ENTRIES)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(
    tmp,
    JSON.stringify({ version: CASE_PAIRING_FILE_VERSION, entries: sorted }, null, 2),
    'utf8'
  )
  await rename(tmp, file)
}

// 구버전(cases.json 내 jsPairings)을 공유 파일로 병합 — 프로세스당 1회.
// 구 항목은 지우지 않고 매 실행 재병합한다(멱등·가장 오래된 시각이라 새 저장이 항상 이김)
// — 공유 파일이 유실돼도 자가 복구된다.
let legacyPairingMergePromise: Promise<void> | null = null

function mergeLegacyPairingsOnce(): Promise<void> {
  if (!legacyPairingMergePromise) {
    legacyPairingMergePromise = withPairingLock(async () => {
      const legacy = legacyJsPairingsToRecords((await load()).jsPairings)
      if (!legacy.length) return
      const current = await readPairingFile()
      const { entries, changed } = mergeCaseEntries(current, legacy)
      if (changed) await writePairingFile(entries)
    })
  }
  return legacyPairingMergePromise
}

async function readPairingRecords(): Promise<CasePairingRecord[]> {
  await mergeLegacyPairingsOnce().catch(() => {})
  return readPairingFile()
}

export async function getJsPairing(
  id: string
): Promise<{ drafts: string; records?: string } | undefined> {
  const entry = (await readPairingRecords()).find((e) => e.key === id)
  return entry ? { drafts: entry.drafts, records: entry.records } : undefined
}
export async function allJsPairings(): Promise<
  Record<string, { drafts: string; records?: string }>
> {
  const out: Record<string, { drafts: string; records?: string }> = {}
  for (const e of await readPairingRecords()) out[e.key] = { drafts: e.drafts, records: e.records }
  return out
}
export async function setJsPairing(
  id: string,
  p: { drafts: string; records?: string }
): Promise<void> {
  await mergeLegacyPairingsOnce().catch(() => {})
  await withPairingLock(async () => {
    const entries = await readPairingFile()
    // 사용자의 직접 지정은 병합 없이 그대로 저장 — 항상 최신 시각이라 다른 기기에서도 이긴다.
    const next: CasePairingRecord = {
      key: id,
      drafts: p.drafts,
      records: p.records,
      updatedAt: new Date().toISOString()
    }
    await writePairingFile([next, ...entries.filter((e) => e.key !== id)])
  })
}

// 원격 동기화(sessions.ts)용: 전체 항목 읽기 + 풀 항목 병합 저장.
export async function allCasePairingRecords(): Promise<CasePairingRecord[]> {
  return readPairingRecords()
}
export async function mergeCasePairingRecords(incoming: CasePairingRecord[]): Promise<void> {
  if (!incoming.length) return
  await mergeLegacyPairingsOnce().catch(() => {})
  await withPairingLock(async () => {
    const current = await readPairingFile()
    const { entries, changed } = mergeCaseEntries(current, incoming)
    if (changed) await writePairingFile(entries)
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
