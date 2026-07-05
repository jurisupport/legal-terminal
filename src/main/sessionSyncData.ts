// 세션 인덱스 동기화 순수 로직 — electron 의존이 없어 scripts/verify-session-sync.mjs에서 직접 검증한다.
//
// 배경: 세션 메타(생성 제목·작업 요약·사건 연결)가 기기별 userData에만 저장되면
// 다른 컴퓨터에서 같은 SSH 호스트에 붙었을 때 지난 세션이 제목·사건 연결 없이 보인다.
// 각 호스트의 ~/.claude/legal-terminal-sessions.json 을 그 호스트 세션 메타의 원본으로 삼고,
// SSH로 접속하는 앱이 자기 항목을 밀어 넣은(푸시) 뒤 병합 결과를 받아(풀) 로컬 인덱스에 합친다.

export interface SessionMetaRecord {
  key: string
  sourceKey: string
  sessionId: string
  cwd: string
  updatedAt: string
  searchText: string
  [field: string]: unknown
}

export function isSessionMetaRecord(value: unknown): value is SessionMetaRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SessionMetaRecord>
  return (
    typeof v.key === 'string' &&
    typeof v.sourceKey === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.updatedAt === 'string' &&
    typeof v.searchText === 'string'
  )
}

// buildSessionMeta와 원격 풀 항목이 같은 규칙으로 검색 텍스트를 만들도록 필드 목록을 한 곳에 둔다.
const SEARCH_TEXT_FIELDS = [
  'sessionId',
  'title',
  'transcriptTitle',
  'generatedTitle',
  'displayTitle',
  'caseNumber',
  'caseName',
  'court',
  'client',
  'folderName',
  'cwd',
  'recordsFolder',
  'profileId',
  'sshLabel'
] as const

export function computeSearchText(meta: Record<string, unknown>): string {
  const ssh = meta.ssh as { host?: unknown; user?: unknown } | undefined
  return [...SEARCH_TEXT_FIELDS.map((field) => meta[field]), ssh?.host, ssh?.user]
    .filter(
      (part): part is string | number =>
        (typeof part === 'string' || typeof part === 'number') && String(part).trim().length > 0
    )
    .map((part) => String(part).normalize('NFKC').toLowerCase())
    .join(' ')
}

function emptyish(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

// 병합 규칙: updatedAt이 새로운 쪽을 기본으로 하되, 빠진 필드는 옛 항목에서 채운다.
// (한 기기는 생성 제목만, 다른 기기는 작업 요약만 아는 경우 둘 다 보존)
// 원격 병합 스크립트(remoteIndexMergeCommand)의 python 구현과 규칙이 같아야 한다.
export function mergeMetaPair(a: SessionMetaRecord, b: SessionMetaRecord): SessionMetaRecord {
  const [newer, older] = a.updatedAt >= b.updatedAt ? [a, b] : [b, a]
  const merged: SessionMetaRecord = { ...newer }
  for (const [field, value] of Object.entries(older)) {
    if (emptyish(merged[field]) && !emptyish(value)) merged[field] = value
  }
  return merged
}

export interface MergeMetaResult {
  entries: SessionMetaRecord[]
  changed: boolean
}

// incoming을 current에 key 단위로 병합. changed는 저장이 필요한지 판단용.
export function mergeMetaEntries(
  current: SessionMetaRecord[],
  incoming: SessionMetaRecord[]
): MergeMetaResult {
  const byKey = new Map(current.map((entry) => [entry.key, entry]))
  let changed = false
  for (const inc of incoming) {
    const prev = byKey.get(inc.key)
    const merged = prev ? mergeMetaPair(prev, inc) : inc
    if (!prev || JSON.stringify(prev) !== JSON.stringify(merged)) {
      byKey.set(inc.key, merged)
      changed = true
    }
  }
  const entries = [...byKey.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
  return { entries, changed }
}

// 원격 호스트 파일에는 그 호스트 기준(local) 형태로 저장한다.
// ssh 접속 정보·프로필 id·라벨은 기기마다 달라 의미가 없으므로 뺀다.
export function toRemoteLocalForm(meta: SessionMetaRecord): SessionMetaRecord {
  const { ssh: _ssh, profileId: _profileId, sshLabel: _sshLabel, ...rest } = meta
  const remote: SessionMetaRecord = {
    ...(rest as SessionMetaRecord),
    key: `local:${meta.sessionId}`,
    sourceKey: 'local'
  }
  remote.searchText = computeSearchText(remote)
  return remote
}

export interface RemotePullContext {
  sourceKey: string // 이 앱 기준 원격 소스 키 (ssh:user@host:port)
  ssh: Record<string, unknown> // 저장할 접속 정보 (host/user/port/identityFile)
  profileId?: string
  sshLabel?: string
}

// 원격 파일의 local 항목을 이 앱 기준(ssh:…) 항목으로 되돌린다.
// 원격 호스트가 또 다른 호스트에 SSH로 붙어 만든 항목(sourceKey ssh:…)은 무시한다.
export function fromRemoteLocalForm(
  meta: SessionMetaRecord,
  ctx: RemotePullContext
): SessionMetaRecord | null {
  if (meta.sourceKey !== 'local') return null
  const pulled: SessionMetaRecord = {
    ...meta,
    key: `${ctx.sourceKey}:${meta.sessionId}`,
    sourceKey: ctx.sourceKey,
    ssh: ctx.ssh,
    profileId: ctx.profileId,
    sshLabel: ctx.sshLabel
  }
  pulled.searchText = computeSearchText(pulled)
  return pulled
}
