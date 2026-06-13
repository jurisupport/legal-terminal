import type { JsCase } from '../env'

const CASE_LIST_CACHE_TTL_MS = 10 * 60_000

export interface CaseListParams {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseType?: string
  refresh?: boolean
}

type CaseListQuery = Omit<CaseListParams, 'refresh'>
type CaseListResult = { ok: boolean; cases?: JsCase[]; error?: string }

const caseListCache = new Map<string, { fetchedAt: number; cases: JsCase[] }>()
const caseListInflight = new Map<string, Promise<CaseListResult>>()

function compactQuery(params: CaseListQuery = {}): CaseListQuery {
  return {
    ...(params.page !== undefined ? { page: params.page } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.search?.trim() ? { search: params.search.trim() } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.caseType ? { caseType: params.caseType } : {})
  }
}

function cacheKey(params: CaseListQuery = {}): string {
  return JSON.stringify(compactQuery(params))
}

export function readCachedCaseList(params: CaseListQuery = {}): JsCase[] | undefined {
  const cached = caseListCache.get(cacheKey(params))
  if (!cached || Date.now() - cached.fetchedAt >= CASE_LIST_CACHE_TTL_MS) return undefined
  return cached.cases
}

export function clearCaseListCache(): void {
  caseListCache.clear()
  caseListInflight.clear()
}

export function listCasesCached(params: CaseListParams = {}): Promise<CaseListResult> {
  const { refresh, ...query } = params
  const key = cacheKey(query)
  const cached = caseListCache.get(key)
  if (!refresh && cached && Date.now() - cached.fetchedAt < CASE_LIST_CACHE_TTL_MS) {
    return Promise.resolve({ ok: true, cases: cached.cases })
  }

  if (!refresh) {
    const inflight = caseListInflight.get(key)
    if (inflight) return inflight
  }

  const request = window.lt.js
    .listCases({ ...compactQuery(query), ...(refresh ? { refresh: true } : {}) })
    .then((result) => {
      if (result.ok) {
        caseListCache.set(key, { fetchedAt: Date.now(), cases: result.cases ?? [] })
      }
      return result
    })
    .finally(() => {
      if (caseListInflight.get(key) === request) caseListInflight.delete(key)
    })
  caseListInflight.set(key, request)
  return request
}
