// 사건별 에이전트 작업 이력(세션 인덱스 → 사건 매칭) 순수 로직.
// electron 의존이 없어 scripts/verify-case-activity.mjs에서 직접 검증한다.

export function pathLeaf(path?: string): string | undefined {
  if (!path) return undefined
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean
}

export function comparablePath(path?: string): string {
  if (!path) return ''
  const clean = path.trim().replace(/[\\/]+$/, '') || '/'
  return clean.normalize('NFKC')
}

export function searchNorm(value?: string): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
}

export interface CaseActivityCaseRef {
  id: string
  caseNumber?: string | null
  caseName?: string | null
}

export interface CaseActivityQuery {
  cases: CaseActivityCaseRef[]
  limitPerCase?: number
}

export interface CaseSessionSummary {
  sessionId: string
  title?: string
  mtime: number
  cwd?: string
  profileId?: string
  sshLabel?: string
  workSummary?: string
  workSummaryAt?: number
}

export interface CaseActivity {
  sessions: CaseSessionSummary[]
  lastActivity: number
  total: number
}

// SessionMeta 중 매칭·표시에 쓰는 부분집합 (verify 스크립트에서 만들기 쉽게 분리)
export interface CaseActivityMetaLike {
  sessionId: string
  cwd: string
  updatedAt: string
  mtime?: number
  title?: string
  transcriptTitle?: string
  generatedTitle?: string
  caseNumber?: string
  caseName?: string
  folderName?: string
  profileId?: string
  sshLabel?: string
  workSummary?: string
  workSummaryAt?: number
  // transcript 스캔에서 온 합성 메타 — 사건 pairing 폴더와 이름이 같으면 매칭을 허용한다.
  // (스캔 cwd는 심링크가 풀린 실제 경로라 pairing 경로와 문자열이 다를 수 있다)
  matchByFolder?: boolean
}

export type JsPairingMap = Record<string, { drafts: string; records?: string }>

const DEFAULT_LIMIT_PER_CASE = 3

// 원격 pairing 값: "ssh://<profileId>/<절대경로>"
function parseRemoteDrafts(drafts: string): { profileId: string; path: string } | undefined {
  const m = /^ssh:\/\/([^/]+)(\/.*)$/.exec(drafts)
  return m ? { profileId: m[1], path: m[2] } : undefined
}

interface CaseMatcher {
  id: string
  caseNo: string // searchNorm 적용
  localDrafts: string // comparablePath 적용
  localDraftsLeaf: string // searchNorm 적용한 pairing 폴더명 (matchByFolder 항목용)
  remote?: { profileId: string; path: string; leaf: string }
}

function buildMatcher(c: CaseActivityCaseRef, pairings: JsPairingMap): CaseMatcher {
  const local = pairings[c.id]?.drafts
  let remote: CaseMatcher['remote']
  for (const [key, p] of Object.entries(pairings)) {
    if (!key.startsWith('remote:') || !key.endsWith(`:${c.id}`)) continue
    const parsed = parseRemoteDrafts(p.drafts)
    if (parsed) {
      remote = {
        profileId: parsed.profileId,
        path: comparablePath(parsed.path),
        leaf: searchNorm(pathLeaf(parsed.path))
      }
    }
  }
  return {
    id: c.id,
    caseNo: searchNorm(c.caseNumber ?? undefined),
    localDrafts: comparablePath(local),
    localDraftsLeaf: searchNorm(pathLeaf(local)),
    remote
  }
}

// 대시보드 대량 매칭 규칙 — matchIndexedSession(단일 사건 검색)보다 보수적:
// a) 사건번호 정규화 일치  b) cwd↔pairing 일치(단, 서로 다른 사건번호면 제외)
// 사건명('손해배상(기)'·'사기' 등)은 유형명이라 여러 사건이 공유하므로 완전일치라도 쓰지 않고,
// folderName 부분일치도 오탐이 많아 쓰지 않는다.
function metaMatchesCase(meta: CaseActivityMetaLike, m: CaseMatcher): boolean {
  const metaNo = searchNorm(meta.caseNumber)
  if (m.caseNo && metaNo && metaNo === m.caseNo) return true
  if (metaNo && m.caseNo && metaNo !== m.caseNo) return false
  const cwd = comparablePath(meta.cwd)
  if (m.localDrafts && cwd === m.localDrafts && !meta.profileId) return true
  if (m.remote && meta.profileId === m.remote.profileId && cwd === m.remote.path) return true
  // 스캔 합성 메타: cwd가 심링크 풀린 경로라 문자열이 달라도, pairing 폴더명과
  // 정확히 같으면 매칭 (폴더명은 사건별로 고유하게 짓는 관행이라 완전일치만 허용)
  if (meta.matchByFolder) {
    const leaf = searchNorm(pathLeaf(meta.cwd))
    if (leaf.length >= 2) {
      if (m.localDraftsLeaf && leaf === m.localDraftsLeaf && !meta.profileId) return true
      if (m.remote && meta.profileId === m.remote.profileId && leaf === m.remote.leaf) return true
    }
  }
  return false
}

function metaMtime(meta: CaseActivityMetaLike): number {
  if (typeof meta.mtime === 'number' && meta.mtime > 0) return meta.mtime
  const parsed = Date.parse(meta.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

// 구버전 인덱스에는 내부 태그 원문이 제목으로 남아 있을 수 있다 — 대시보드에선 폴더명 폴백이 낫다.
export function cleanTitle(title?: string): string | undefined {
  if (!title) return undefined
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>|<system-reminder>/.test(title))
    return undefined
  return title
}

function toSummary(meta: CaseActivityMetaLike): CaseSessionSummary {
  return {
    sessionId: meta.sessionId,
    title:
      cleanTitle(meta.generatedTitle) ||
      cleanTitle(meta.transcriptTitle) ||
      cleanTitle(meta.title) ||
      pathLeaf(meta.folderName || meta.cwd),
    mtime: metaMtime(meta),
    cwd: meta.cwd,
    profileId: meta.profileId,
    sshLabel: meta.sshLabel,
    workSummary: meta.workSummary,
    workSummaryAt: meta.workSummaryAt
  }
}

export function buildCaseActivity(
  entries: CaseActivityMetaLike[],
  pairings: JsPairingMap,
  q: CaseActivityQuery
): Record<string, CaseActivity> {
  const limit = Math.max(1, q.limitPerCase ?? DEFAULT_LIMIT_PER_CASE)
  const out: Record<string, CaseActivity> = {}
  for (const c of q.cases) {
    const matcher = buildMatcher(c, pairings)
    const matched = entries.filter((meta) => metaMatchesCase(meta, matcher))
    if (!matched.length) continue
    matched.sort((a, b) => metaMtime(b) - metaMtime(a))
    out[c.id] = {
      sessions: matched.slice(0, limit).map(toSummary),
      lastActivity: metaMtime(matched[0]),
      total: matched.length
    }
  }
  return out
}

export interface FolderActivity {
  key: string
  folderName: string
  cwd: string
  profileId?: string
  sshLabel?: string
  sessions: CaseSessionSummary[]
  lastActivity: number
  total: number
}

// 어떤 사건에도 매칭되지 않은 세션을 폴더(cwd)별로 묶는다 — "사건 미연결 폴더 작업" 섹션용.
export function buildFolderActivity(
  entries: CaseActivityMetaLike[],
  pairings: JsPairingMap,
  q: CaseActivityQuery
): FolderActivity[] {
  const limit = Math.max(1, q.limitPerCase ?? DEFAULT_LIMIT_PER_CASE)
  const matchers = q.cases.map((c) => buildMatcher(c, pairings))
  const leftovers = entries.filter((meta) => !matchers.some((m) => metaMatchesCase(meta, m)))
  const groups = new Map<string, CaseActivityMetaLike[]>()
  for (const meta of leftovers) {
    const key = `${meta.profileId ?? 'local'}:${comparablePath(meta.cwd)}`
    const list = groups.get(key)
    if (list) list.push(meta)
    else groups.set(key, [meta])
  }
  const out: FolderActivity[] = []
  for (const [key, metas] of groups) {
    metas.sort((a, b) => metaMtime(b) - metaMtime(a))
    const head = metas[0]
    out.push({
      key,
      folderName: head.folderName || pathLeaf(head.cwd) || head.cwd,
      cwd: head.cwd,
      profileId: head.profileId,
      sshLabel: head.sshLabel,
      sessions: metas.slice(0, limit).map(toSummary),
      lastActivity: metaMtime(head),
      total: metas.length
    })
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}
