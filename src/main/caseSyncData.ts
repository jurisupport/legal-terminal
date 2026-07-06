// 사건→폴더 지정(jsPairings) 동기화 순수 로직 — electron 의존이 없어 scripts/verify-case-sync.mjs에서 직접 검증한다.
//
// 배경: 사건별 폴더 지정이 기기별 userData(cases.json)에만 저장되면 다른 컴퓨터에서
// 같은 사건을 열 때 폴더를 처음부터 다시 지정해야 한다. 세션 인덱스와 같은 방식으로
// 각 호스트의 ~/.claude/legal-terminal-cases.json 을 그 호스트 폴더 지정의 원본으로 삼고,
// SSH로 접속하는 앱이 자기 항목을 밀어 넣은(푸시) 뒤 병합 결과를 받아(풀) 로컬에 합친다.
//
// 키 규칙(렌더러와 동일): 이 기기 사건은 '<caseId>', 원격 사건은 'remote:<프로필id>:<caseId>'.
// 원격 사건의 경로 값은 ssh://<프로필id>/<경로> URI — 프로필 id는 기기마다 달라
// 호스트 파일에는 plain 경로로 저장하고, 풀 때 자기 프로필 id로 URI를 되만든다.

export const CASE_PAIRING_FILE_VERSION = 1
export const MAX_CASE_PAIRING_ENTRIES = 1500

export interface CasePairingRecord {
  key: string
  drafts: string
  records?: string
  updatedAt: string // ISO — 병합 기준
}

export function isCasePairingRecord(value: unknown): value is CasePairingRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CasePairingRecord>
  return (
    typeof v.key === 'string' &&
    typeof v.drafts === 'string' &&
    typeof v.updatedAt === 'string' &&
    (v.records === undefined || typeof v.records === 'string')
  )
}

// 병합 규칙: updatedAt이 새로운 쪽이 이긴다. records만 옛 항목에서 보충하되
// 폴더(drafts)가 같을 때만 — 다른 폴더의 소송기록이 새 지정에 붙는 것을 막는다.
// 원격 병합 스크립트(remoteCaseMergeCommand)의 python 구현과 규칙이 같아야 한다.
export function mergeCasePair(a: CasePairingRecord, b: CasePairingRecord): CasePairingRecord {
  const [newer, older] = a.updatedAt >= b.updatedAt ? [a, b] : [b, a]
  const merged: CasePairingRecord = { ...newer }
  if (!merged.records && older.records && older.drafts === merged.drafts)
    merged.records = older.records
  return merged
}

export interface MergeCaseResult {
  entries: CasePairingRecord[]
  changed: boolean
}

export function mergeCaseEntries(
  current: CasePairingRecord[],
  incoming: CasePairingRecord[]
): MergeCaseResult {
  const byKey = new Map(current.map((entry) => [entry.key, entry]))
  let changed = false
  for (const inc of incoming) {
    const prev = byKey.get(inc.key)
    const merged = prev ? mergeCasePair(prev, inc) : inc
    if (!prev || JSON.stringify(prev) !== JSON.stringify(merged)) {
      byKey.set(inc.key, merged)
      changed = true
    }
  }
  const entries = [...byKey.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
  return { entries, changed }
}

// ssh://<프로필id>/<경로> URI 또는 plain 절대경로를 원격 호스트 기준 plain 경로로.
// 이 프로필의 경로가 아니면(다른 프로필 URI·상대경로 등) undefined.
function remotePlainPath(value: string | undefined, profileId: string): string | undefined {
  if (!value) return undefined
  const prefix = `ssh://${profileId}/`
  if (value.startsWith(prefix)) return value.slice(prefix.length - 1)
  if (value.startsWith('/')) return value
  return undefined
}

// 이 기기의 remote:<프로필id>:<caseId> 항목을 호스트 파일 기준(local) 형태로 변환.
// 해당 프로필 항목이 아니거나 경로를 plain으로 바꿀 수 없으면 null.
export function toRemoteLocalCaseForm(
  rec: CasePairingRecord,
  profileId: string
): CasePairingRecord | null {
  const prefix = `remote:${profileId}:`
  if (!rec.key.startsWith(prefix)) return null
  const caseId = rec.key.slice(prefix.length)
  if (!caseId || caseId.startsWith('remote:')) return null
  const drafts = remotePlainPath(rec.drafts, profileId)
  if (!drafts) return null
  return { ...rec, key: caseId, drafts, records: remotePlainPath(rec.records, profileId) }
}

// 호스트 파일의 local 항목을 이 기기 기준 remote:<프로필id>:<caseId> 항목으로 되돌린다.
// 호스트가 또 다른 호스트에 대해 지정한 항목(remote:… 키)은 무시한다.
export function fromRemoteLocalCaseForm(
  rec: CasePairingRecord,
  profileId: string
): CasePairingRecord | null {
  if (rec.key.startsWith('remote:')) return null
  if (!rec.drafts.startsWith('/')) return null // 윈도우 경로 등은 ssh:// 스킴으로 표현 불가
  return {
    ...rec,
    key: `remote:${profileId}:${rec.key}`,
    drafts: `ssh://${profileId}${rec.drafts}`,
    records: rec.records?.startsWith('/') ? `ssh://${profileId}${rec.records}` : undefined
  }
}

// 구버전 cases.json의 jsPairings를 공유 파일 항목으로 — 시각이 없으므로 가장 오래된
// 시각을 부여해, 어느 기기에서든 새로 저장·동기화된 항목이 항상 이기게 한다.
export const LEGACY_PAIRING_UPDATED_AT = '1970-01-01T00:00:00.000Z'

export function legacyJsPairingsToRecords(
  jsPairings: Record<string, { drafts: string; records?: string }>
): CasePairingRecord[] {
  return Object.entries(jsPairings).flatMap(([key, p]) =>
    key && p?.drafts
      ? [{ key, drafts: p.drafts, records: p.records, updatedAt: LEGACY_PAIRING_UPDATED_AT }]
      : []
  )
}

function parseEntries(text: string): CasePairingRecord[] | null {
  try {
    const parsed = JSON.parse(text) as { entries?: unknown }
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isCasePairingRecord) : []
  } catch {
    return null
  }
}

export function parseCasePairingFileText(text: string): CasePairingRecord[] {
  const direct = parseEntries(text)
  if (direct) return direct
  // 비원자 쓰기가 겹치면 유효한 JSON 뒤에 이전 내용 조각이 남을 수 있다 — 세션 인덱스와 동일 복구.
  const end = text.indexOf('\n}')
  if (end > 0) {
    const salvaged = parseEntries(text.slice(0, end + 2))
    if (salvaged) return salvaged
  }
  return []
}
