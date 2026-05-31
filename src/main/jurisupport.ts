import { safeStorage } from 'electron'
import { getSettings, setSettings } from './settings'

// JuriSupport 본체(jurisupport3) MCP over HTTP 클라이언트.
// 프로토콜: POST /mcp 로 initialize → notifications/initialized → tools/call.
// 응답은 SSE 한 건("event: message\ndata: {json}"), result.content[0].text = JSON 문자열.
const MCP_URL = 'https://api.jurisupport.com/mcp'

let sessionId: string | null = null

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
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, sid: res.headers.get('mcp-session-id'), text }
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

export async function listCases(params: {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseType?: string
}): Promise<JsCase[]> {
  const r = await callTool('list_cases', { page: 1, limit: 50, ...params })
  return Array.isArray(r) ? (r as JsCase[]) : []
}

export async function getCase(id: string): Promise<JsCase | null> {
  const r = await callTool('get_case', { id })
  return (r as JsCase) ?? null
}
