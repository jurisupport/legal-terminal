import type { CaseActivity, FolderActivity, JsCase } from '../env'

// 세션 인덱스는 로컬 파일 1회 읽기라 저렴하지만, 카드 rerender마다 IPC가 나가지 않게 짧은 TTL을 둔다.
const CASE_ACTIVITY_TTL_MS = 60_000

let cached: { fetchedAt: number; key: string; activity: Record<string, CaseActivity> } | null = null
let inflight: { key: string; promise: Promise<Record<string, CaseActivity>> } | null = null

function activityKey(cases: JsCase[]): string {
  return cases
    .map((c) => c.id)
    .sort()
    .join(',')
}

let folderCached: { fetchedAt: number; key: string; folders: FolderActivity[] } | null = null
let folderInflight: { key: string; promise: Promise<FolderActivity[]> } | null = null

export function invalidateCaseActivity(): void {
  cached = null
  inflight = null
  folderCached = null
  folderInflight = null
}

// 어떤 사건에도 안 붙은 세션의 폴더별 그룹 (같은 TTL)
export function loadFolderActivity(cases: JsCase[]): Promise<FolderActivity[]> {
  const key = activityKey(cases)
  if (folderCached && folderCached.key === key && Date.now() - folderCached.fetchedAt < CASE_ACTIVITY_TTL_MS) {
    return Promise.resolve(folderCached.folders)
  }
  if (folderInflight?.key === key) return folderInflight.promise

  const promise = window.lt.sessions
    .byFolder({
      cases: cases.map((c) => ({ id: c.id, caseNumber: c.caseNumber, caseName: c.caseName }))
    })
    .then((folders) => {
      folderCached = { fetchedAt: Date.now(), key, folders }
      return folders
    })
    .catch(() => [] as FolderActivity[])
    .finally(() => {
      if (folderInflight?.promise === promise) folderInflight = null
    })
  folderInflight = { key, promise }
  return promise
}

// 보이는 사건 전체를 IPC 1회로 조회한다.
export function loadCaseActivity(cases: JsCase[]): Promise<Record<string, CaseActivity>> {
  if (!cases.length) return Promise.resolve({})
  const key = activityKey(cases)
  if (cached && cached.key === key && Date.now() - cached.fetchedAt < CASE_ACTIVITY_TTL_MS) {
    return Promise.resolve(cached.activity)
  }
  if (inflight?.key === key) return inflight.promise

  const promise = window.lt.sessions
    .byCase({
      cases: cases.map((c) => ({ id: c.id, caseNumber: c.caseNumber, caseName: c.caseName }))
    })
    .then((activity) => {
      cached = { fetchedAt: Date.now(), key, activity }
      return activity
    })
    .catch(() => ({}) as Record<string, CaseActivity>)
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { key, promise }
  return promise
}
