import { safeStorage } from 'electron'
import { getSettings, setSettings } from './settings'

// JuriSupport 본체(jurisupport3) MCP over HTTP 클라이언트.
// 프로토콜: POST /mcp 로 initialize → notifications/initialized → tools/call.
// 응답은 SSE 한 건("event: message\ndata: {json}"), result.content[0].text = JSON 문자열.
const MCP_URL = 'https://api.jurisupport.com/mcp'

let sessionId: string | null = null

const CASES_PAGE_LIMIT = 100
const CASES_MAX_PAGES = 20

// ── 토큰 저장/조회 (safeStorage 암호화, 불가 시 평문 폴백) ──
export async function setToken(token: string): Promise<void> {
  let enc: string
  if (token && safeStorage.isEncryptionAvailable()) {
    enc = 'v1:' + safeStorage.encryptString(token).toString('base64')
  } else {
    enc = 'plain:' + token
  }
  await setSettings({ jurisupportTokenEnc: token ? enc : undefined })
  sessionId = null // 토큰 바뀌면 세션 무효화
}

async function getToken(): Promise<string | null> {
  const enc = (await getSettings()).jurisupportTokenEnc
  if (!enc) return null
  if (enc.startsWith('v1:')) {
    try {
      return safeStorage.decryptString(Buffer.from(enc.slice(3), 'base64'))
    } catch {
      return null
    }
  }
  if (enc.startsWith('plain:')) return enc.slice(6)
  return null
}

export async function hasToken(): Promise<boolean> {
  return !!(await getToken())
}

// ── 저수준 HTTP ──
async function rawPost(
  token: string,
  body: unknown,
  sid?: string | null
): Promise<{ status: number; sid: string | null; text: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  if (sid) headers['mcp-session-id'] = sid
  // 타임아웃: SSE 응답이 늦거나 스트림이 닫히지 않으면 무한 대기(사건목록 '불러오는 중' 멈춤) → 중단.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    return { status: res.status, sid: res.headers.get('mcp-session-id'), text }
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('JuriSupport 응답 시간 초과 (네트워크 확인 후 ↻ 다시 시도)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// SSE/JSON 응답에서 JSON-RPC 객체 추출
function parseRpc(text: string): { result?: unknown; error?: { code: number; message: string } } | null {
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data:'))
  const raw = dataLine ? dataLine.slice(5).trim() : text
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function ensureSession(token: string): Promise<string> {
  const init = await rawPost(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'legal-terminal', version: '0.0.1' }
    }
  })
  if (!init.sid) {
    const err = parseRpc(init.text)
    throw new Error('MCP 초기화 실패: ' + (err?.error?.message ?? `HTTP ${init.status}`))
  }
  await rawPost(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid)
  return init.sid
}

// 도구 호출. 세션 만료 시 1회 재수립 후 재시도.
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = await getToken()
  if (!token) throw new Error('JuriSupport 토큰이 설정되지 않았습니다.')
  if (!sessionId) sessionId = await ensureSession(token)

  const call = (): Promise<{ status: number; sid: string | null; text: string }> =>
    rawPost(
      token,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
      sessionId
    )

  let resp = await call()
  let rpc = parseRpc(resp.text)
  if (rpc?.error && /session/i.test(rpc.error.message || '')) {
    sessionId = await ensureSession(token)
    resp = await call()
    rpc = parseRpc(resp.text)
  }
  if (rpc?.error) throw new Error(rpc.error.message)
  // MCP 도구 결과: result.content[0].text = JSON 문자열
  const result = rpc?.result as { content?: { type: string; text: string }[] } | undefined
  const textPart = result?.content?.find((c) => c.type === 'text')?.text
  if (textPart) {
    try {
      return JSON.parse(textPart)
    } catch {
      return textPart
    }
  }
  return rpc?.result
}

export interface JsParty {
  role: string // client | opponent
  position: string | null
  party: { name: string; type: string; phone?: string | null }
}
export interface JsHearing {
  type: string
  dateTime: string
  location?: string | null
  note?: string | null
  status?: string
}
export interface JsCase {
  id: string
  caseNumber: string | null
  caseName: string | null
  court: string | null
  division: string | null
  caseType: string | null
  status: string
  parties: JsParty[]
  hearings: JsHearing[]
  updatedAt?: string
  _count?: { parties: number; hearings: number; progresses: number; documents: number }
}

export interface ListCasesParams {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseType?: string
}

function normalizeCaseList(r: unknown): JsCase[] {
  if (Array.isArray(r)) return r as JsCase[]
  if (!r || typeof r !== 'object') return []

  const obj = r as Record<string, unknown>
  for (const key of ['cases', 'items', 'data', 'results']) {
    const value = obj[key]
    if (Array.isArray(value)) return value as JsCase[]
  }
  return []
}

function caseKey(c: JsCase): string {
  return [c.id, c.caseNumber, c.court, c.caseName].filter(Boolean).join('\0')
}

async function listCasePage(params: ListCasesParams): Promise<JsCase[]> {
  return normalizeCaseList(await callTool('list_cases', params as Record<string, unknown>))
}

export async function listCases(params: ListCasesParams = {}): Promise<JsCase[]> {
  const { page, limit, ...filters } = params
  const hasExplicitPaging = page !== undefined || limit !== undefined

  if (hasExplicitPaging) {
    return listCasePage({
      page: page ?? 1,
      limit: limit ?? CASES_PAGE_LIMIT,
      ...filters
    })
  }

  const cases: JsCase[] = []
  const seen = new Set<string>()

  for (let pageNo = 1; pageNo <= CASES_MAX_PAGES; pageNo++) {
    let pageCases: JsCase[]
    try {
      pageCases = await listCasePage({ page: pageNo, limit: CASES_PAGE_LIMIT, ...filters })
    } catch (error) {
      if (pageNo === 1) throw error
      console.warn('[jurisupport] stopped paginating list_cases', error)
      break
    }

    if (pageCases.length === 0) break

    let added = 0
    for (const c of pageCases) {
      const key = caseKey(c)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      cases.push(c)
      added++
    }

    if (added === 0 || pageCases.length < CASES_PAGE_LIMIT) break
  }

  return cases
}

export async function getCase(id: string): Promise<JsCase | null> {
  const r = await callTool('get_case', { id })
  return (r as JsCase) ?? null
}
