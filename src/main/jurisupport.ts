import { app, safeStorage } from 'electron'
import { readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { getSettings, setSettings } from './settings'
import { imageInfo } from './imageSize'
import type { HwpxOfficeInfo } from './hwpxExport'
import {
  normalizeCase,
  normalizeCaseList,
  type JsCase,
  type JsParty
} from './jurisupportNormalize'
import { parseRpc } from './mcpResponse'
import { kstDateKey, setTodoDate } from '../shared/todoSummary'

export type { JsCase, JsHearing, JsParty } from './jurisupportNormalize'

// JuriSupport 본체(jurisupport3) MCP over HTTP 클라이언트.
// 프로토콜: POST /mcp 로 initialize → notifications/initialized → tools/call.
// 응답은 SSE 한 건("event: message\ndata: {json}"), result.content[0].text = JSON 문자열.
const MCP_URL = 'https://api.jurisupport.com/mcp'

const agentAccountListeners = new Set<() => void>()
export function onAgentMcpAccountChange(listener: () => void): () => void {
  agentAccountListeners.add(listener)
  return () => { agentAccountListeners.delete(listener) }
}
export function agentMcpAccountEpoch(): number { return accountEpoch }
let accountEpoch = 0
let sessionId: string | null = null
let toolQueue: Promise<void> = Promise.resolve()

const CASES_PAGE_LIMIT = 50
const CASES_MAX_PAGES = 40
const CASE_LIST_CACHE_TTL_MS = 10 * 60_000
const TODOS_PAGE_LIMIT = 100
const TODOS_MAX_PAGES = 20

type JuriTaskStatus = 'pending' | 'in_progress' | 'completed' | 'closed'

const JURI_TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'closed'])
const CASE_INFO_HEADER = '[사건 정보]'
const PROGRESS_HEADER = '[진행 기록]'
const todoCaseCache = new Map<string, JsCase | null>()

// ── 토큰 저장/조회 (safeStorage 암호화, 불가 시 평문 폴백) ──
export async function setToken(token: string): Promise<void> {
  accountEpoch++
  for (const listener of agentAccountListeners) listener()
  let enc: string
  if (token && safeStorage.isEncryptionAvailable()) {
    enc = 'v1:' + safeStorage.encryptString(token).toString('base64')
  } else {
    enc = 'plain:' + token
  }
  await setSettings({ jurisupportTokenEnc: token ? enc : undefined })
  accountEpoch++ // Requests begun during credential persistence also belong to the old account.
  sessionId = null // 토큰 바뀌면 세션 무효화
  toolQueue = Promise.resolve()
  clearJuriSupportCaches()
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

/** Main-process only; never expose this connection through IPC or renderer state. */
export async function getAgentMcpConnection(): Promise<{ token: string; epoch: number; tools: string[] } | null> {
  const epoch = accountEpoch
  const token = await getToken()
  if (!token) return null
  if (/[\x00-\x1f\x7f]/.test(token)) throw new Error('JuriSupport 토큰 형식을 확인해 주세요.')
  try {
    const tools = await listMcpTools()
    if (epoch !== accountEpoch) throw new Error('JuriSupport 계정이 변경되었습니다.')
    return { token, epoch, tools: tools.map((tool) => tool.name) }
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).split(token).join('[token redacted]'))
  }
}

export async function hasToken(): Promise<boolean> {
  return !!(await getToken())
}

// 토큰 상태 구분 — 'locked'는 토큰이 저장돼 있지만 복호화가 안 되는 경우다.
// (무서명 배포라 앱 업데이트 후 macOS 키체인이 Safe Storage 접근을 거부하면 발생)
// 이때는 "미설정"이 아니라 "토큰을 다시 붙여넣어 주세요"를 안내해야 한다.
export type JsTokenStatus = 'ok' | 'missing' | 'locked'

export async function tokenStatus(): Promise<JsTokenStatus> {
  const enc = (await getSettings()).jurisupportTokenEnc
  if (!enc) return 'missing'
  return (await getToken()) ? 'ok' : 'locked'
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

// 도구 호출 본체. 세션 만료 시 1회 재수립 후 재시도.
async function callToolNow(name: string, args: Record<string, unknown>): Promise<unknown> {
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
  if (!rpc) throw new Error(`JuriSupport 응답을 해석하지 못했습니다. (HTTP ${resp.status})`)
  if (rpc?.error) throw new Error(rpc.error.message)
  // MCP 도구 결과: result.content[0].text = JSON 문자열
  if (!('result' in rpc)) {
    throw new Error(`JuriSupport 응답에 result가 없습니다. (HTTP ${resp.status})`)
  }
  const result = rpc.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined
  const textPart = result?.content?.find((c) => c.type === 'text')?.text
  if (result?.isError) throw new Error(textPart || 'JuriSupport 도구 호출 실패')
  if (textPart) {
    try {
      return JSON.parse(textPart)
    } catch {
      return textPart
    }
  }
  return rpc?.result
}

type McpToolInfo = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }

// MCP 서버가 제공하는 도구 목록. 사무실 프로필과 지원 필드 탐색에 쓴다.
async function listMcpToolsNow(): Promise<McpToolInfo[]> {
  const token = await getToken()
  if (!token) throw new Error('JuriSupport 토큰이 설정되지 않았습니다.')
  if (!sessionId) sessionId = await ensureSession(token)

  const call = (): Promise<{ status: number; sid: string | null; text: string }> =>
    rawPost(token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sessionId)

  let resp = await call()
  let rpc = parseRpc(resp.text)
  if (rpc?.error && /session/i.test(rpc.error.message || '')) {
    sessionId = await ensureSession(token)
    resp = await call()
    rpc = parseRpc(resp.text)
  }
  if (!rpc || rpc.error || !('result' in rpc)) {
    throw new Error(rpc?.error?.message ?? `JuriSupport tools/list 실패 (HTTP ${resp.status})`)
  }
  const tools = (rpc.result as { tools?: McpToolInfo[] })?.tools
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t): t is McpToolInfo => typeof t?.name === 'string')
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

// 같은 MCP 세션에 동시 요청이 겹치면 서버/세션 타이밍에 따라 간헐 실패할 수 있어 순차화한다.
async function enqueueMcp<T>(run: () => Promise<T>): Promise<T> {
  const previous = toolQueue
  let release: () => void = () => {}
  toolQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
  }
}

async function callTool(name: string, args: Record<string, unknown>, epoch = accountEpoch): Promise<unknown> {
  return enqueueMcp(async () => {
    if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
    const result = await callToolNow(name, args)
    if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
    return result
  })
}

async function listMcpTools(): Promise<McpToolInfo[]> {
  return enqueueMcp(listMcpToolsNow)
}

export interface JsTodoProgress {
  id?: string
  text: string
  createdAt?: string
  source?: 'manual' | 'terminal' | 'jurisupport' | string
  terminalId?: string
  cwd?: string
}
export interface TodoEvidence {
  kind: 'document' | 'progress' | 'event' | 'file'
  id?: string
  uri?: string
  label: string
  occurredAt?: string
  reason?: string
  status: 'candidate' | 'confirmed' | 'dismissed'
}
export interface TodoStatusOptions {
  childDispositions?: { id: string; action: 'complete' | 'close' | 'keep'; reason?: string }[]
  version?: number
}
export interface CaseTaskDisposition {
  id: string
  action: 'complete' | 'close' | 'keep' | 'transfer'
  targetCaseId?: string
  reason?: string
  version?: number
}
export interface CaseClosurePreview {
  id: string
  version: number
  status: string
  engagementStatus: string
  tasks: JsTodo[]
  blocked: boolean
}
export interface TodoCapabilities {
  queryFields: string[]
  createFields: string[]
  updateFields: string[]
  statusFields: string[]
  evidenceSuggestions: boolean
  caseClosure: boolean
  caseEngagement: boolean
}
export interface JsTodo {
  type?: 'todo' | 'memo'
  reviewAt?: string | null
  parentId?: string | null
  children?: { id: string; title: string; status: string }[]
  evidence?: TodoEvidence[]
  version?: number
  id: string
  title: string
  status: string
  priority?: string | null
  dueDate?: string | null
  caseId?: string | null
  court?: string | null
  caseNumber?: string | null
  caseName?: string | null
  client?: string | null
  opponent?: string | null
  partyNames?: string | null
  notes?: string | null
  progress?: JsTodoProgress[]
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}
export interface ListTodosParams {
  openOnly?: boolean
  enrichCaseDetails?: boolean
  type?: 'todo' | 'memo'
  fields?: 'compact' | 'full'
  dueBefore?: string
  dueAfter?: string
  hasDueDate?: boolean
  updatedBefore?: string
  sortBy?: 'dueDate' | 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
  includeClosed?: boolean
  page?: number
  limit?: number
  search?: string
  status?: string
  caseId?: string
  includeArchived?: boolean
}
export interface TodoMutationInput extends TodoStatusOptions {
  type?: 'todo' | 'memo'
  reviewAt?: string | null
  parentId?: string | null
  evidence?: TodoEvidence[]
  title?: string
  status?: string
  priority?: string
  dueDate?: string | null
  caseId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  notes?: string
}
export interface TodoTerminalContext {
  contextKind?: 'case' | 'global' | 'folder'
  terminalId?: string
  cwd?: string
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
}
export interface TodoTerminalResult {
  ok: boolean
  message: string
  changed?: boolean
  todo?: JsTodo | null
  todos?: JsTodo[]
}

export interface ListCasesParams {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseType?: string
  refresh?: boolean
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === '') continue
    out[key] = value
  }
  return out
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function toUiTodoStatus(value?: string): JuriTaskStatus {
  if (value === 'open') return 'pending'
  if (value === 'done') return 'completed'
  if (value === 'archived') return 'closed'
  return JURI_TASK_STATUSES.has(value ?? '') ? (value as JuriTaskStatus) : 'pending'
}

function toJuriTaskStatus(value?: string): JuriTaskStatus | undefined {
  if (!value || value === 'all') return undefined
  if (value === 'open') return 'pending'
  if (value === 'done') return 'completed'
  if (value === 'archived') return 'closed'
  return JURI_TASK_STATUSES.has(value) ? (value as JuriTaskStatus) : undefined
}

function normalizePriority(value?: string): 'low' | 'medium' | 'high' | undefined {
  if (!value) return undefined
  if (value === 'normal') return 'medium'
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return undefined
}

function toMcpDateTime(value?: string | null): string | null | undefined {
  if (value === null) return null
  if (value === undefined || value === '') return undefined
  if (!kstDateKey(value)) throw new Error('날짜를 확인해 주세요.')
  if (value.length === 10) return setTodoDate(undefined, value)
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`).toISOString()
}

function formatProgressStamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseCaseInfoFromContent(content?: string | null): Partial<JsTodo> {
  if (!content) return {}
  const lines = content.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim() === CASE_INFO_HEADER)
  if (headerIndex < 0) return {}

  const info: Partial<JsTodo> = {}
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim()
    if (!trimmed) break
    if (/^\[[^\]]+\]$/.test(trimmed)) break
    const match = trimmed.match(/^([^:：]+)[:：]\s*(.+)$/)
    if (!match) continue
    const label = match[1].trim()
    const value = match[2].trim()
    if (!value) continue
    if (label === '법원') info.court = value
    else if (label === '사건번호') info.caseNumber = value
    else if (label === '사건명') info.caseName = value
    else if (label === '의뢰인') info.client = value
    else if (label === '상대방' || label === '상대') info.opponent = value
    else if (label === '당사자') info.partyNames = value
  }
  return info
}

function caseInfoLines(input: Partial<TodoMutationInput> | TodoTerminalContext | undefined): string[] {
  if (!input) return []
  const partyNames = input.partyNames ?? [input.client, input.opponent].filter(Boolean).join(' / ')
  return [
    input.court && `법원: ${input.court}`,
    input.caseNumber && `사건번호: ${input.caseNumber}`,
    input.caseName && `사건명: ${input.caseName}`,
    input.client && `의뢰인: ${input.client}`,
    input.opponent && `상대방: ${input.opponent}`,
    partyNames && `당사자: ${partyNames}`
  ].filter((line): line is string => !!line)
}

function buildCaseInfoContent(input: Partial<TodoMutationInput> | TodoTerminalContext | undefined): string | undefined {
  const lines = caseInfoLines(input)
  return lines.length ? `${CASE_INFO_HEADER}\n${lines.join('\n')}` : undefined
}

function mergeCaseInfoWithNotes(input: TodoMutationInput): string | undefined {
  const notes = input.notes?.trim()
  if (notes?.includes(CASE_INFO_HEADER)) return notes
  const info = buildCaseInfoContent(input)
  return [info, notes].filter(Boolean).join('\n\n') || undefined
}

function ensureCaseInfoContent(
  existingContent: string | null | undefined,
  context?: TodoTerminalContext
): string {
  const current = (existingContent ?? '').trim()
  if (current.includes(CASE_INFO_HEADER)) return current
  const info = buildCaseInfoContent(context)
  if (!info) return current
  return current ? `${info}\n\n${current}` : info
}

function extractProgressFromContent(content?: string | null): JsTodoProgress[] | undefined {
  if (!content) return undefined
  const lines = content.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim() === PROGRESS_HEADER)
  if (headerIndex < 0) return undefined

  const out: JsTodoProgress[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^\[([^\]]+)\]\s*(.+)$/)
    if (match) out.push({ createdAt: match[1], text: match[2], source: 'terminal' })
    else out.push({ text: trimmed, source: 'terminal' })
  }
  return out.length ? out : undefined
}

function appendProgressContent(
  existingContent: string | null | undefined,
  text: string,
  context?: TodoTerminalContext
): string {
  const current = ensureCaseInfoContent(existingContent, context).trimEnd()
  const suffixParts = [context?.terminalId, context?.cwd].filter(Boolean)
  const suffix = suffixParts.length ? ` (${suffixParts.join(' / ')})` : ''
  const line = `[${formatProgressStamp()}] ${text}${suffix}`
  if (!current) return `${PROGRESS_HEADER}\n${line}`
  if (current.includes(PROGRESS_HEADER)) return `${current}\n${line}`
  return `${current}\n\n${PROGRESS_HEADER}\n${line}`
}

function normalizeProgressList(value: unknown): JsTodoProgress[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: JsTodoProgress[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      out.push({ text: item })
      continue
    }
    const obj = asObject(item)
    if (!obj) continue
    const text = stringFrom(obj.text) ?? stringFrom(obj.content) ?? stringFrom(obj.memo) ?? stringFrom(obj.note)
    if (!text) continue
    out.push({
      id: stringFrom(obj.id),
      text,
      createdAt: stringFrom(obj.createdAt) ?? stringFrom(obj.created_at),
      source: stringFrom(obj.source),
      terminalId: stringFrom(obj.terminalId) ?? stringFrom(obj.terminal_id),
      cwd: stringFrom(obj.cwd)
    })
  }
  return out
}

function normalizeTodoFields(value: Record<string, unknown>): JsTodo | null {
  const nestedCase = asObject(value.case) ?? asObject(value.jsCase)
  const nestedClient = asObject(value.client)
  const nestedOpponent = asObject(value.opponent)
  const nestedParty = asObject(value.party)
  const content =
    stringFrom(value.content) ??
    stringFrom(value.notes) ??
    stringFrom(value.memo) ??
    stringFrom(value.description) ??
    null
  const contentCaseInfo = parseCaseInfoFromContent(content)
  const id = stringFrom(value.id) ?? stringFrom(value.todoId) ?? stringFrom(value.taskId)
  const title =
    stringFrom(value.title) ??
    stringFrom(value.name) ??
    stringFrom(value.content) ??
    stringFrom(value.summary) ??
    stringFrom(value.text)
  if (!id) return null

  return {
    id,
    type: value.type === 'memo' ? 'memo' : 'todo',
    reviewAt: stringFrom(value.reviewAt) ?? null,
    parentId: stringFrom(value.parentId) ?? null,
    children: Array.isArray(value.openDescendants ?? value.children) ? ((value.openDescendants ?? value.children) as unknown[]).flatMap((child) => {
      const c = asObject(child)
      return c && stringFrom(c.id) ? [{ id: String(c.id), title: stringFrom(c.title) ?? '(제목 없음)', status: toUiTodoStatus(stringFrom(c.status)) }] : []
    }) : undefined,
    evidence: normalizeEvidence(value.evidence),
    version: typeof value.version === 'number' ? value.version : undefined,
    title: title ?? '(제목 없음)',
    status: toUiTodoStatus(
      stringFrom(value.status) ?? (value.completedAt || value.completed_at ? 'completed' : 'pending')
    ),
    priority: stringFrom(value.priority) ?? null,
    dueDate:
      stringFrom(value.dueDate) ??
      stringFrom(value.due_date) ??
      stringFrom(value.deadline) ??
      stringFrom(value.dueAt) ??
      stringFrom(value.due_at) ??
      null,
    caseId:
      stringFrom(value.caseId) ??
      stringFrom(value.case_id) ??
      stringFrom(value.jsId) ??
      stringFrom(nestedCase?.id) ??
      null,
    court:
      stringFrom(value.court) ??
      stringFrom(value.courtName) ??
      stringFrom(value.court_name) ??
      stringFrom(nestedCase?.court) ??
      stringFrom(nestedCase?.courtName) ??
      contentCaseInfo.court ??
      null,
    caseNumber:
      stringFrom(value.caseNumber) ??
      stringFrom(value.case_number) ??
      stringFrom(nestedCase?.caseNumber) ??
      stringFrom(nestedCase?.case_number) ??
      contentCaseInfo.caseNumber ??
      null,
    caseName:
      stringFrom(value.caseName) ??
      stringFrom(value.case_name) ??
      stringFrom(nestedCase?.caseName) ??
      stringFrom(nestedCase?.case_name) ??
      contentCaseInfo.caseName ??
      null,
    client:
      stringFrom(value.client) ??
      stringFrom(value.clientName) ??
      stringFrom(value.client_name) ??
      stringFrom(nestedClient?.name) ??
      stringFrom(nestedCase?.client) ??
      contentCaseInfo.client ??
      null,
    opponent:
      stringFrom(value.opponent) ??
      stringFrom(value.opponentName) ??
      stringFrom(value.opponent_name) ??
      stringFrom(nestedOpponent?.name) ??
      contentCaseInfo.opponent ??
      null,
    partyNames:
      stringFrom(value.partyNames) ??
      stringFrom(value.party_names) ??
      stringFrom(nestedParty?.name) ??
      contentCaseInfo.partyNames ??
      null,
    notes: content,
    progress:
      normalizeProgressList(value.progress) ??
      normalizeProgressList(value.logs) ??
      normalizeProgressList(value.histories) ??
      extractProgressFromContent(content) ??
      undefined,
    createdAt: stringFrom(value.createdAt) ?? stringFrom(value.created_at),
    updatedAt: stringFrom(value.updatedAt) ?? stringFrom(value.updated_at),
    completedAt: stringFrom(value.completedAt) ?? stringFrom(value.completed_at) ?? null
  }
}

function normalizeTodo(r: unknown): JsTodo | null {
  const obj = asObject(r)
  if (!obj) return null
  for (const key of ['todo', 'item', 'data', 'result']) {
    const nested = asObject(obj[key])
    if (nested && (typeof nested.id === 'string' || typeof nested.title === 'string')) {
      return normalizeTodoFields(nested)
    }
  }
  return normalizeTodoFields(obj)
}

function normalizeTodoList(r: unknown): JsTodo[] {
  if (Array.isArray(r)) return r.map(normalizeTodo).filter((todo): todo is JsTodo => todo !== null)
  const obj = asObject(r)
  if (!obj) return []

  for (const key of ['todos', 'tasks', 'items', 'data', 'results']) {
    const value = obj[key]
    if (Array.isArray(value)) return value.map(normalizeTodo).filter((todo): todo is JsTodo => todo !== null)
    const nested = asObject(value)
    if (nested) {
      for (const nestedKey of ['todos', 'tasks', 'items', 'results']) {
        const nestedValue = nested[nestedKey]
        if (Array.isArray(nestedValue)) {
          return nestedValue.map(normalizeTodo).filter((todo): todo is JsTodo => todo !== null)
        }
      }
    }
  }

  const single = normalizeTodo(r)
  return single ? [single] : []
}

function partyNamesFromCase(c: JsCase, role: string): string {
  return c.parties
    .filter((p) => p.role === role)
    .map((p) => p.party.name)
    .filter(Boolean)
    .join(', ')
}

async function getCaseCached(id: string): Promise<JsCase | null> {
  if (todoCaseCache.has(id)) return todoCaseCache.get(id) ?? null
  const epoch = accountEpoch
  try {
    const c = await getCase(id)
    if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다.')
    todoCaseCache.set(id, c)
    return c
  } catch (error) {
    console.warn('[jurisupport] failed to enrich todo case', error)
    if (epoch === accountEpoch) todoCaseCache.set(id, null)
    return null
  }
}

async function enrichTodos(todos: JsTodo[]): Promise<JsTodo[]> {
  const out: JsTodo[] = []
  for (const todo of todos) {
    const caseId = todo.caseId
    if (!caseId || (todo.court && todo.partyNames)) {
      out.push(todo)
      continue
    }

    const c = await getCaseCached(caseId)
    if (!c) {
      out.push(todo)
      continue
    }

    const client = partyNamesFromCase(c, 'client')
    const opponent = partyNamesFromCase(c, 'opponent')
    const partyNames = [client, opponent].filter(Boolean).join(' / ')
    out.push({
      ...todo,
      court: todo.court ?? c.court ?? null,
      caseNumber: todo.caseNumber ?? c.caseNumber ?? null,
      caseName: todo.caseName ?? c.caseName ?? null,
      client: todo.client ?? (client || null),
      opponent: todo.opponent ?? (opponent || null),
      partyNames: todo.partyNames ?? (partyNames || null)
    })
  }
  return out
}

let todoCapabilityRequest: Promise<TodoCapabilities> | null = null
export function todoCapabilities(): Promise<TodoCapabilities> {
  if (!todoCapabilityRequest) {
    const epoch = accountEpoch
    const request = listMcpTools().then((tools) => {
      if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다.')
      const fields = (name: string): string[] => Object.keys(tools.find((t) => t.name === name)?.inputSchema?.properties ?? {})
      const writable = (name: string): string[] => {
        const available = fields(name)
        // Old MCP advertised priority while the API discarded it.
        return available.includes('reviewAt') ? available : available.filter((field) => field !== 'priority')
      }
      return {
        queryFields: fields('list_tasks'), createFields: writable('create_task'), updateFields: writable('update_task'),
        statusFields: fields('update_task_status'),
        evidenceSuggestions: tools.some((t) => t.name === 'get_task_evidence_suggestions'),
        caseClosure: tools.some((t) => t.name === 'get_case_closure_preview') && ['taskDispositions', 'version'].every((field) => fields('update_case_status').includes(field)),
        caseEngagement: ['engagementStatus', 'taskDispositions', 'version'].every((field) => fields('update_case').includes(field))
      }
    }).catch((error) => {
      if (todoCapabilityRequest === request) todoCapabilityRequest = null
      throw error
    })
    todoCapabilityRequest = request
  }
  return todoCapabilityRequest
}

async function taskListArgs(params: ListTodosParams): Promise<Record<string, unknown>> {
  const args = compactRecord({ type: params.type ?? 'todo', page: params.page, limit: params.limit, search: params.search, caseId: params.caseId, status: toJuriTaskStatus(params.status) })
  const extras = compactRecord({ fields: params.fields, dueBefore: params.dueBefore, dueAfter: params.dueAfter, hasDueDate: params.hasDueDate, updatedBefore: params.updatedBefore, sortBy: params.sortBy, sortOrder: params.sortOrder, includeClosed: params.includeClosed ?? params.includeArchived })
  if (Object.keys(extras).length) {
    // Optional query hints are omitted for legacy servers; full-list local classification remains available.
    const capabilities = await todoCapabilities().catch(() => null)
    for (const [field, value] of Object.entries(extras)) {
      if (capabilities?.queryFields.includes(field)) args[field] = value
      else if (['dueBefore', 'dueAfter', 'hasDueDate', 'updatedBefore'].includes(field)) throw new Error(`서버가 ${field} 조회 조건을 지원하지 않습니다. 열린 할일의 화면 필터를 사용해 주세요.`)
    }
  }
  return args
}

async function taskWriteArgs(input: TodoMutationInput, create: boolean): Promise<Record<string, unknown>> {
  const args = compactRecord({ title: input.title, content: mergeCaseInfoWithNotes(input), dueDate: toMcpDateTime(input.dueDate), type: create ? input.type ?? 'todo' : input.type, caseId: create ? input.caseId : undefined })
  if (input.notes !== undefined && !mergeCaseInfoWithNotes(input)) args.content = ''
  const extras = compactRecord({ reviewAt: toMcpDateTime(input.reviewAt), parentId: input.parentId, evidence: input.evidence, priority: input.priority === undefined ? undefined : normalizePriority(input.priority), version: input.version })
  if (input.priority !== undefined && !normalizePriority(input.priority)) throw new Error('중요도를 확인해 주세요.')
  if (Object.keys(extras).length || (!create && input.type)) {
    const capabilities = await todoCapabilities()
    const fields = create ? capabilities.createFields : capabilities.updateFields
    for (const [field, value] of Object.entries(extras)) {
      // ponytail: legacy MCP cannot enforce versions; server upgrade restores optimistic writes.
      if (field === 'version' && !fields.includes(field)) continue
      if (!fields.includes(field)) throw new Error(`서버가 ${field} 저장을 지원하지 않습니다. 서버 업데이트 후 다시 시도해 주세요.`)
      args[field] = value
    }
    if (!create && input.type && !fields.includes('type')) throw new Error('서버가 메모 유형 변경을 지원하지 않습니다.')
  }
  return args
}

function normalizeEvidence(value: unknown): TodoEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const e = asObject(entry)
    if (!e || !['document', 'progress', 'event', 'file'].includes(String(e.kind)) || !stringFrom(e.label) || !['candidate', 'confirmed', 'dismissed'].includes(String(e.status))) return []
    return [{ kind: e.kind as TodoEvidence['kind'], label: String(e.label), status: e.status as TodoEvidence['status'], id: stringFrom(e.id), uri: stringFrom(e.uri), occurredAt: stringFrom(e.occurredAt), reason: stringFrom(e.reason) }]
  })
}

type CaseListQuery = Omit<ListCasesParams, 'refresh'>

const caseListCache = new Map<string, { fetchedAt: number; cases: JsCase[] }>()
const caseListInflight = new Map<string, Promise<JsCase[]>>()

function clearJuriSupportCaches(): void {
  todoCapabilityRequest = null
  todoListInflight.clear()
  todoCaseCache.clear()
  caseListCache.clear()
  caseListInflight.clear()
  officeInflight = null
  // 계정이 바뀌면 이전 사무실 정보(로고·연락처)를 쓰면 안 된다.
  rm(officeCachePath(), { force: true }).catch(() => {})
}

function caseListCacheKey(params: CaseListQuery): string {
  return JSON.stringify(
    compactRecord({
      page: params.page,
      limit: params.limit,
      search: params.search?.trim(),
      status: params.status,
      caseType: params.caseType
    })
  )
}

async function listCasePage(params: ListCasesParams, strict = false): Promise<JsCase[]> {
  const raw = await callTool('list_cases', params as Record<string, unknown>)
  const cases = normalizeCaseList(raw)
  if (strict) {
    const keys = ['cases', 'caseList', 'case_list', 'items', 'data', 'results']
    const object = asObject(raw)
    const containers = [object, ...keys.map((key) => asObject(object?.[key]))]
    const rows = [raw, ...containers.flatMap((container) => container ? keys.map((key) => container[key]) : [])].find(Array.isArray)
    if (!rows || object?.error || object?.success === false || !Array.isArray(cases) || rows.length !== cases.length || cases.some((c) => !c.id)) {
      throw new Error('사건 목록 응답을 확인할 수 없습니다. 전체 조회를 다시 시도해 주세요.')
    }
  }
  return cases
}

async function listCasesFresh(params: CaseListQuery): Promise<JsCase[]> {
  const { page, limit, ...filters } = params
  if (page !== undefined || limit !== undefined) {
    return listCasePage({ page: page ?? 1, limit: limit ?? CASES_PAGE_LIMIT, ...filters })
  }
  const cases = new Map<string, JsCase>()
  for (let pageNo = 1; pageNo <= CASES_MAX_PAGES; pageNo++) {
    const pageCases = await listCasePage({ page: pageNo, limit: CASES_PAGE_LIMIT, ...filters }, true)
    const previousSize = cases.size
    for (const c of pageCases) cases.set(c.id, c)
    if (pageCases.length && cases.size === previousSize) throw new Error('사건 조회 페이지가 반복되었습니다. 전체 조회를 다시 시도해 주세요.')
    if (pageCases.length < CASES_PAGE_LIMIT) return [...cases.values()]
  }
  throw new Error('사건 전체 조회 상한에 도달했습니다. 전체 목록을 확인할 수 없습니다.')
}

export interface JsHearingSummary { todayCount: number; weekCount: number; fetchedAt: string }
export async function hearingSummary(): Promise<JsHearingSummary> {
  const epoch = accountEpoch
  const raw = await callTool('get_dashboard', {}, epoch)
  const response = asObject(raw)
  const dashboard = asObject(response?.data) ?? response
  const stats = asObject(dashboard?.stats)
  const todayCount = stats?.todayHearingsCount
  const weekCount = stats?.upcomingHearingsCount
  if (response?.success === false || response?.error ||
      stats?.hearingWindowDays !== 7 ||
      stats?.hearingTimezone !== 'Asia/Seoul' ||
      typeof todayCount !== 'number' || !Number.isSafeInteger(todayCount) || todayCount < 0 ||
      typeof weekCount !== 'number' || !Number.isSafeInteger(weekCount) || weekCount < todayCount) {
    throw new Error('서버에서 한국 시간 기준 오늘·7일 기일 집계를 확인할 수 없습니다. 서버 업데이트 후 다시 조회해 주세요.')
  }
  if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
  return { todayCount, weekCount, fetchedAt: new Date().toISOString() }
}

export async function listCases(params: ListCasesParams = {}): Promise<JsCase[]> {
  const epoch = accountEpoch
  const { refresh, ...query } = params
  const key = caseListCacheKey(query)
  const cached = caseListCache.get(key)
  if (!refresh && cached && Date.now() - cached.fetchedAt < CASE_LIST_CACHE_TTL_MS) {
    return cached.cases
  }

  if (!refresh) {
    const inflight = caseListInflight.get(key)
    if (inflight) return inflight
  }

  const request = listCasesFresh(query)
    .then((cases) => {
      if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
      caseListCache.set(key, { fetchedAt: Date.now(), cases })
      return cases
    })
    .finally(() => {
      if (caseListInflight.get(key) === request) caseListInflight.delete(key)
    })
  caseListInflight.set(key, request)
  return request
}

export async function getCase(id: string): Promise<JsCase | null> {
  const r = await callTool('get_case', { id })
  const obj = asObject(r)
  if (obj) {
    for (const key of ['case', 'item', 'data', 'result']) {
      const nested = normalizeCase(obj[key])
      if (nested) return nested
    }
  }
  return normalizeCase(r)
}

interface TodoPage { todos: JsTodo[]; total?: number; totalPages?: number; hasNext?: boolean }
function normalizeTodoPage(raw: unknown): TodoPage {
  const obj = asObject(raw)
  const data = asObject(obj?.data)
  const recognized = Array.isArray(raw) || [obj, data].some((container) => container && ['todos', 'tasks', 'items', 'data', 'results'].some((key) => Array.isArray(container[key])))
  if (!recognized || obj?.error || obj?.success === false) throw new Error('할일 목록 응답을 확인할 수 없습니다.')
  const containers = [asObject(obj?.pagination), asObject(obj?.meta), asObject(data?.pagination), asObject(data?.meta), obj, data].filter(Boolean) as Record<string, unknown>[]
  const number = (...keys: string[]): number | undefined => {
    for (const container of containers) for (const key of keys) if (typeof container[key] === 'number' && Number.isFinite(container[key]) && Number(container[key]) >= 0) return Number(container[key])
    return undefined
  }
  const hasNext = containers.map((c) => c.hasNext ?? c.hasNextPage).find((value) => typeof value === 'boolean') as boolean | undefined
  const todos = normalizeTodoList(raw)
  const arrays = [raw, ...[obj, data].flatMap((c) => c ? ['todos', 'tasks', 'items', 'data', 'results'].map((key) => c[key]) : [])].filter(Array.isArray)
  if (arrays[0] && arrays[0].length !== todos.length) throw new Error('식별자가 없는 할일 응답입니다. 다시 조회해 주세요.')
  return { todos, total: number('total', 'totalCount'), totalPages: number('totalPages', 'pageCount'), hasNext }
}
async function listTodoPage(params: ListTodosParams): Promise<TodoPage> {
  return normalizeTodoPage(await callTool('list_tasks', await taskListArgs(params)))
}
async function listTodoStatus(params: ListTodosParams): Promise<JsTodo[]> {
  if (params.page !== undefined || params.limit !== undefined) return (await listTodoPage({ ...params, page: params.page ?? 1, limit: params.limit ?? TODOS_PAGE_LIMIT })).todos
  const todos = new Map<string, JsTodo>()
  let expectedTotal: number | undefined
  for (let page = 1; page <= TODOS_MAX_PAGES; page++) {
    const result = await listTodoPage({ ...params, page, limit: TODOS_PAGE_LIMIT })
    const before = todos.size
    for (const todo of result.todos) todos.set(todo.id, todo)
    if (result.total !== undefined) expectedTotal = result.total
    if (result.todos.length && todos.size === before) throw new Error('할일 조회 페이지가 반복되었습니다. 전체 조회를 다시 시도해 주세요.')
    const complete = result.hasNext === false || (result.totalPages !== undefined && page >= result.totalPages) || (expectedTotal !== undefined && todos.size >= expectedTotal)
    const more = result.hasNext === true || (result.totalPages !== undefined && page < result.totalPages) || (expectedTotal !== undefined && todos.size < expectedTotal)
    if (complete) {
      if (expectedTotal !== undefined && todos.size < expectedTotal) throw new Error('할일 일부가 누락되었습니다. 전체 조회를 다시 시도해 주세요.')
      return [...todos.values()]
    }
    if (!result.todos.length && more) throw new Error('할일 일부가 누락되었습니다. 전체 조회를 다시 시도해 주세요.')
    if (!more && result.todos.length < TODOS_PAGE_LIMIT) return [...todos.values()]
  }
  throw new Error('할일 전체 조회 상한에 도달했습니다. 전체 건수를 확인할 수 없습니다.')
}
const todoListInflight = new Map<string, Promise<JsTodo[]>>()
export function listTodos(params: ListTodosParams = {}): Promise<JsTodo[]> {
  const key = JSON.stringify(params)
  const existing = todoListInflight.get(key)
  if (existing) return existing
  const epoch = accountEpoch
  const request = (async () => {
    const statuses = params.openOnly ? ['pending', 'in_progress'] : (params.includeClosed ?? params.includeArchived) && (!params.status || params.status === 'all') && params.page === undefined && params.limit === undefined ? ['pending', 'in_progress', 'completed', 'closed'] : [params.status]
    const unique = new Map<string, JsTodo>()
    for (const status of statuses) {
      for (const todo of await listTodoStatus({ ...params, status })) {
        if (todo.type !== (params.type ?? 'todo')) continue
        if (params.openOnly && !['pending', 'in_progress'].includes(todo.status)) continue
        if ((params.includeClosed ?? params.includeArchived) === false && todo.status === 'closed' && toJuriTaskStatus(params.status) !== 'closed') continue
        unique.set(todo.id, todo)
      }
    }
    if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
    const result = [...unique.values()]
    const enriched = params.enrichCaseDetails === false ? result : await enrichTodos(result)
    if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
    return enriched
  })().finally(() => { if (todoListInflight.get(key) === request) todoListInflight.delete(key) })
  todoListInflight.set(key, request)
  return request
}

export async function getTodo(id: string): Promise<JsTodo | null> {
  return normalizeTodo(await callTool('get_task', { id }))
}

export async function createTodo(input: TodoMutationInput): Promise<JsTodo | null> {
  const epoch = accountEpoch
  const todo = normalizeTodo(await callTool('create_task', await taskWriteArgs(input, true), epoch))
  const status = toJuriTaskStatus(input.status)
  if (todo?.id && status && status !== 'pending') return changeTodoStatus(todo.id, status, undefined, epoch)
  return todo
}

export async function updateTodo(id: string, patch: TodoMutationInput): Promise<JsTodo | null> {
  const epoch = accountEpoch
  const status = toJuriTaskStatus(patch.status)
  const updateArgs = { id, ...await taskWriteArgs(patch, false) }
  let todo: JsTodo | null = null

  if (Object.keys(updateArgs).some((key) => key !== 'id' && key !== 'version')) {
    todo = normalizeTodo(await callTool('update_task', updateArgs, epoch))
  }
  if (status) {
    todo = await changeTodoStatus(id, status, { ...patch, version: todo?.version ?? patch.version }, epoch) ?? todo
  }

  return todo ?? getTodo(id)
}

export async function completeTodo(
  id: string,
  progressText?: string,
  context?: TodoTerminalContext,
  options?: TodoStatusOptions
): Promise<JsTodo | null> {
  const epoch = accountEpoch
  let todo: JsTodo | null = null
  if (progressText?.trim()) {
    todo = await appendTodoProgress(id, progressText.trim(), context)
  }
  return await changeTodoStatus(id, 'completed', { ...options, version: todo?.version ?? options?.version }, epoch) ?? todo
}

export async function archiveTodo(id: string, options?: TodoStatusOptions): Promise<JsTodo | null> {
  return changeTodoStatus(id, 'closed', options)
}
async function changeTodoStatus(id: string, status: JuriTaskStatus, options?: TodoStatusOptions, epoch = accountEpoch): Promise<JsTodo | null> {
  const args = compactRecord({ id, status, childDispositions: options?.childDispositions, version: options?.version })
  if (options?.childDispositions || options?.version !== undefined) {
    const capabilities = await todoCapabilities()
    if (args.version !== undefined && !capabilities.statusFields.includes('version')) delete args.version
    if (args.childDispositions !== undefined && !capabilities.statusFields.includes('childDispositions')) throw new Error('서버가 하위 할일 처리 결정을 지원하지 않습니다.')
  }
  return normalizeTodo(await callTool('update_task_status', args, epoch))
}
export async function todoEvidenceSuggestions(id: string): Promise<TodoEvidence[]> {
  const epoch = accountEpoch
  if (!(await todoCapabilities()).evidenceSuggestions) throw new Error('서버가 완료 근거 조회를 지원하지 않습니다.')
  const result = await callTool('get_task_evidence_suggestions', { id }, epoch)
  const data = asObject(result)?.data
  if (!Array.isArray(data)) throw new Error('완료 근거 응답을 확인할 수 없습니다.')
  return normalizeEvidence(data).map((entry) => ({ ...entry, status: 'candidate' }))
}
export async function caseClosurePreview(id: string): Promise<CaseClosurePreview> {
  const epoch = accountEpoch
  if (!(await todoCapabilities()).caseClosure) throw new Error('서버가 사건 종료 검토를 지원하지 않습니다.')
  const result = await callTool('get_case_closure_preview', { id }, epoch)
  const obj = asObject(result)
  const data = asObject(obj?.data) ?? obj
  const raw = data?.tasks ?? data?.todos ?? data?.openTasks
  if (!Array.isArray(raw)) throw new Error('사건 종료 검토 목록을 확인할 수 없습니다.')
  if (typeof data?.version !== 'number') throw new Error('사건 버전을 확인할 수 없습니다.')
  return { id, version: data.version, status: String(data.status ?? ''), engagementStatus: String(data.engagementStatus ?? 'unknown'), tasks: normalizeTodoList(raw), blocked: data.blocked === true }
}
export async function updateCaseStatus(id: string, status: string, taskDispositions?: CaseTaskDisposition[], version?: number): Promise<JsCase | null> {
  const epoch = accountEpoch
  if (!(await todoCapabilities()).caseClosure) throw new Error('서버가 사건 종료 검토를 지원하지 않습니다.')
  const result = await callTool('update_case_status', compactRecord({ id, status, taskDispositions, version }), epoch)
  clearJuriSupportCaches()
  return normalizeCase(asObject(result)?.data ?? result)
}
export async function updateCaseEngagement(id: string, engagementStatus: string, taskDispositions?: CaseTaskDisposition[], version?: number): Promise<JsCase | null> {
  const epoch = accountEpoch
  if (!(await todoCapabilities()).caseEngagement) throw new Error('서버가 수임 상태 변경을 지원하지 않습니다.')
  const result = await callTool('update_case', compactRecord({ id, engagementStatus, taskDispositions, version }), epoch)
  clearJuriSupportCaches()
  return normalizeCase(asObject(result)?.data ?? result)
}

export async function appendTodoProgress(
  id: string,
  text: string,
  context?: TodoTerminalContext
): Promise<JsTodo | null> {
  const epoch = accountEpoch
  const todo = await getTodo(id)
  if (!todo) throw new Error('할일 원문을 확인할 수 없습니다. 다시 조회해 주세요.')
  if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
  if (todo.version === undefined || !(await todoCapabilities()).updateFields.includes('version')) throw new Error('진행 기록을 안전하게 추가하려면 서버 업데이트가 필요합니다.')
  if (epoch !== accountEpoch) throw new Error('계정이 변경되었습니다. 다시 조회해 주세요.')
  const content = appendProgressContent(todo.notes, text, context)
  return updateTodo(id, { notes: content, version: todo.version })
}

function resolveDueDate(value?: string): string | undefined {
  if (!value) return undefined
  const lower = value.toLocaleLowerCase('ko-KR')
  if (lower === 'today' || lower === '오늘') return toMcpDateTime(kstDateKey(new Date())) ?? undefined
  if (lower === 'tomorrow' || lower === '내일') return toMcpDateTime(kstDateKey(Date.now() + 86_400_000)) ?? undefined
  return toMcpDateTime(value) ?? undefined
}

function parseBodyOptions(text: string): { body: string; options: Record<string, string> } {
  const options: Record<string, string> = {}
  const words: string[] = []
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const match = word.match(/^(due|priority|status|case|caseId):(.+)$/i)
    if (match) options[match[1].toLocaleLowerCase('en-US')] = match[2]
    else words.push(word)
  }
  return { body: words.join(' ').trim(), options }
}

function terminalCasePatch(context?: TodoTerminalContext): TodoMutationInput {
  return compactRecord({
    court: context?.court,
    caseNumber: context?.caseNumber,
    caseName: context?.caseName,
    client: context?.client,
    opponent: context?.opponent,
    partyNames: context?.partyNames
  }) as TodoMutationInput
}

function todoStatusLabel(status?: string): string {
  return (
    {
      open: '예정',
      in_progress: '진행중',
      done: '완료',
      archived: '종료',
      pending: '예정',
      completed: '완료',
      closed: '종료'
    }[status ?? ''] ?? status ?? ''
  )
}

function todoLabel(todo: JsTodo): string {
  const bits = [
    `#${todo.id}`,
    todo.status && `[${todoStatusLabel(todo.status)}]`,
    todo.dueDate && `~${todo.dueDate}`,
    todo.caseNumber,
    todo.title
  ]
  return bits.filter(Boolean).join(' ')
}

function todoHelp(): string {
  return [
    '[todo] 사용법',
    '  todo list [검색어]',
    '  todo add <내용> [due:오늘|내일|YYYY-MM-DD] [priority:high]',
    '  todo log <id> <오늘 진행한 내용>',
    '  todo done <id> [완료 메모]',
    '  todo open <id>',
    '  todo close <id>'
  ].join('\n')
}

export async function applyTodoTerminalCommand(
  rawCommand: string,
  context?: TodoTerminalContext
): Promise<TodoTerminalResult> {
  const raw = rawCommand.trim()
  if (!/^todo(?:\s|$)/i.test(raw)) return { ok: false, message: '[todo] todo 명령이 아닙니다.' }
  const rest = raw.replace(/^todo(?:\s+|$)/i, '').trim()
  if (!rest || rest === 'help') return { ok: true, message: todoHelp() }

  const [command = '', ...parts] = rest.split(/\s+/)
  const tail = parts.join(' ').trim()
  const cmd = command.toLocaleLowerCase('en-US')

  if (cmd === 'list' || cmd === 'ls') {
    const todos = await listTodos({ search: tail || undefined, includeArchived: false })
    const lines = todos.slice(0, 12).map((todo) => `  ${todoLabel(todo)}`)
    const suffix = todos.length > 12 ? `\n  ...외 ${todos.length - 12}개` : ''
    return {
      ok: true,
      todos,
      message: todos.length ? `[todo] ${todos.length}개\n${lines.join('\n')}${suffix}` : '[todo] 할일이 없습니다.'
    }
  }

  if (cmd === 'add' || cmd === 'new') {
    const parsed = parseBodyOptions(tail)
    if (!parsed.body) return { ok: false, message: '[todo] 추가할 내용을 입력해 주세요.' }
    const todo = await createTodo({
      ...terminalCasePatch(context),
      title: parsed.body,
      dueDate: resolveDueDate(parsed.options.due),
      priority: parsed.options.priority,
      status: parsed.options.status
    })
    return { ok: true, changed: true, todo, message: `[todo] 추가: ${todo ? todoLabel(todo) : parsed.body}` }
  }

  if (cmd === 'log') {
    const [id = '', ...memoParts] = parts
    const text = memoParts.join(' ').trim()
    if (!id || !text) return { ok: false, message: '[todo] 사용법: todo log <id> <진행 내용>' }
    const todo = await appendTodoProgress(id, text, context)
    return { ok: true, changed: true, todo, message: `[todo] 진행 기록: ${todo ? todoLabel(todo) : `#${id}`}` }
  }

  if (cmd === 'done' || cmd === 'complete') {
    const [id = '', ...memoParts] = parts
    if (!id) return { ok: false, message: '[todo] 사용법: todo done <id> [완료 메모]' }
    const todo = await completeTodo(id, memoParts.join(' ').trim() || undefined, context)
    return { ok: true, changed: true, todo, message: `[todo] 완료: ${todo ? todoLabel(todo) : `#${id}`}` }
  }

  if (cmd === 'open' || cmd === 'reopen') {
    const [id = ''] = parts
    if (!id) return { ok: false, message: '[todo] 사용법: todo open <id>' }
    const todo = await updateTodo(id, { status: 'pending' })
    return { ok: true, changed: true, todo, message: `[todo] 예정으로 변경: ${todo ? todoLabel(todo) : `#${id}`}` }
  }

  if (cmd === 'archive' || cmd === 'close') {
    const [id = ''] = parts
    if (!id) return { ok: false, message: '[todo] 사용법: todo close <id>' }
    const todo = await archiveTodo(id)
    return { ok: true, changed: true, todo, message: `[todo] 종료: ${todo ? todoLabel(todo) : `#${id}`}` }
  }

  return { ok: false, message: todoHelp() }
}

// ── 사무실 프로필 (hwpx 푸터용 로고·연락처) ──────────────────────────────
// JuriSupport 계정에 등록한 사무실 정보를 가져와 법원제출문서 푸터에 넣는다.
// 서버 도구 이름이 확정돼 있지 않아 tools/list로 탐색한 뒤 프로필류 도구를 호출한다.

export interface JsOfficeProfile {
  officeName?: string
  phone?: string
  fax?: string
  email?: string
  address?: string
  /** 계정에 별도 푸터가 등록돼 있으면 표 대신 이 텍스트를 쓴다 */
  footerText?: string
  logoUrl?: string
  sourceTool?: string
}

export interface JsOfficeLogo {
  mime: 'image/png' | 'image/jpeg'
  base64: string
  width: number
  height: number
}

export interface JsOfficeInfo {
  profile: JsOfficeProfile
  logo?: JsOfficeLogo
  fetchedAt: string
}

// 서버에 get_office_profile이 생긴 뒤로는 조회가 가볍다(tools/list + 호출 1회).
// 웹 /company 설정에서 바꾼 정보가 곧 반영되도록 짧게 잡고, 실패 시엔 이전 캐시를 쓴다.
const OFFICE_CACHE_TTL_MS = 10 * 60_000
const OFFICE_TOOL_CANDIDATES = [
  'get_office_profile',
  'get_office',
  'get_my_office',
  'get_firm_profile',
  'get_firm',
  'get_my_profile',
  'get_profile',
  'get_user_profile',
  'get_member_profile',
  'get_lawyer_profile',
  'get_account',
  'get_me',
  'whoami',
  'get_letterhead',
  'get_document_footer'
]
const OFFICE_TOOL_RE = /(office|firm|profile|account|letterhead|lawyer|member)/i
const OFFICE_TOOL_EXCLUDE_RE =
  /(case|task|todo|hearing|schedule|client|party|list_|create|update|delete|search|upload|set_)/i

const OFFICE_FIELD_ALIASES: Record<Exclude<keyof JsOfficeProfile, 'sourceTool'>, string[]> = {
  officeName: [
    'officename',
    'firmname',
    'lawfirmname',
    'lawfirm',
    'companyname',
    'organization',
    'organizationname',
    'orgname'
  ],
  phone: ['phone', 'phonenumber', 'tel', 'telephone', 'officephone', 'contactphone'],
  fax: ['fax', 'faxnumber', 'officefax'],
  email: ['email', 'contactemail', 'officeemail'],
  address: ['address', 'officeaddress', 'addr', 'roadaddress', 'fulladdress'],
  footerText: ['footertext', 'documentfooter', 'docfooter', 'footer', 'letterheadfooter'],
  logoUrl: ['logourl', 'logoimageurl', 'logoimage', 'logo', 'logopath', 'logodataurl']
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// 응답 형태를 모르는 채로 중첩 객체를 훑어 별칭 필드를 수집한다.
function collectOfficeFields(value: unknown, depth = 0, parentKey = ''): JsOfficeProfile {
  const out: JsOfficeProfile = {}
  const obj = asObject(value)
  if (!obj || depth > 4) return out
  for (const [key, raw] of Object.entries(obj)) {
    const nk = normalizeKey(key)
    if (typeof raw === 'string' && raw.trim()) {
      for (const [field, aliases] of Object.entries(OFFICE_FIELD_ALIASES)) {
        const f = field as keyof typeof OFFICE_FIELD_ALIASES
        if (!out[f] && aliases.includes(nk)) out[f] = raw.trim()
      }
      // 'name'은 사무실류 부모 객체 안에서만 상호로 인정 (변호사 개인 이름과 혼동 방지)
      if (!out.officeName && nk === 'name' && /(office|firm|company|org)/.test(normalizeKey(parentKey))) {
        out.officeName = raw.trim()
      }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = collectOfficeFields(raw, depth + 1, key)
      for (const [field, v] of Object.entries(nested)) {
        const f = field as keyof JsOfficeProfile
        if (!out[f] && v) out[f] = v
      }
    }
  }
  return out
}

function officeProfileHasData(profile: JsOfficeProfile): boolean {
  return !!(
    profile.officeName ||
    profile.phone ||
    profile.fax ||
    profile.email ||
    profile.address ||
    profile.footerText ||
    profile.logoUrl
  )
}

async function fetchOfficeLogo(url: string): Promise<JsOfficeLogo | null> {
  try {
    let buf: Buffer
    if (url.startsWith('data:')) {
      const m = url.match(/^data:image\/(?:png|jpe?g);base64,(.+)$/i)
      if (!m) return null
      buf = Buffer.from(m[1], 'base64')
    } else if (/^https?:\/\//i.test(url)) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10000)
      try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (!res.ok) return null
        const bytes = await res.arrayBuffer()
        if (bytes.byteLength > 3 * 1024 * 1024) return null
        buf = Buffer.from(bytes)
      } finally {
        clearTimeout(timer)
      }
    } else {
      return null
    }
    const info = imageInfo(buf)
    if (!info || info.width <= 0 || info.height <= 0) return null
    return { mime: info.mime, base64: buf.toString('base64'), width: info.width, height: info.height }
  } catch (error) {
    console.warn('[jurisupport] 로고 다운로드 실패', error)
    return null
  }
}

function officeCachePath(): string {
  return join(app.getPath('userData'), 'jurisupport-office.json')
}

async function readOfficeCache(): Promise<JsOfficeInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(officeCachePath(), 'utf8')) as JsOfficeInfo
    return parsed && typeof parsed === 'object' && parsed.profile ? parsed : null
  } catch {
    return null
  }
}

async function fetchOfficeInfoFresh(): Promise<JsOfficeInfo | null> {
  const tools = await listMcpTools()
  const names = tools.map((t) => t.name)
  const discovered = names.filter(
    (name) =>
      !OFFICE_TOOL_CANDIDATES.includes(name) &&
      OFFICE_TOOL_RE.test(name) &&
      !OFFICE_TOOL_EXCLUDE_RE.test(name) &&
      /^(get|fetch|read|my|show)[_a-z]/i.test(name)
  )
  const ordered = [...OFFICE_TOOL_CANDIDATES.filter((name) => names.includes(name)), ...discovered]
  if (ordered.length === 0) {
    console.warn('[jurisupport] 사무실 프로필 도구를 찾지 못했습니다. 사용 가능:', names.join(', '))
    return null
  }

  for (const name of ordered) {
    try {
      const result = await callTool(name, {})
      const profile = collectOfficeFields(result)
      if (!officeProfileHasData(profile)) continue
      profile.sourceTool = name
      const logo = profile.logoUrl ? await fetchOfficeLogo(profile.logoUrl) : null
      return { profile, logo: logo ?? undefined, fetchedAt: new Date().toISOString() }
    } catch (error) {
      console.warn(`[jurisupport] ${name} 호출 실패`, error)
    }
  }
  return null
}

let officeInflight: Promise<JsOfficeInfo | null> | null = null

/** 사무실 프로필 조회 — 24시간 캐시, 실패 시 이전 캐시 반환 */
export async function getOfficeInfo(refresh = false): Promise<JsOfficeInfo | null> {
  const cached = await readOfficeCache()
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt || '') < OFFICE_CACHE_TTL_MS) {
    return cached
  }
  if (!(await hasToken())) return cached

  if (!officeInflight) {
    officeInflight = fetchOfficeInfoFresh()
      .then(async (fresh) => {
        if (fresh) await writeFile(officeCachePath(), JSON.stringify(fresh, null, 2), 'utf8')
        return fresh
      })
      .catch((error) => {
        console.warn('[jurisupport] 사무실 프로필 조회 실패', error)
        return null
      })
      .finally(() => {
        officeInflight = null
      })
  }
  return (await officeInflight) ?? cached
}

function trimmed(value?: string): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

/** 설정에 입력한 로고 파일을 읽어 hwpx용으로 변환 (PNG/JPEG만) */
async function manualLogo(logoPath?: string): Promise<HwpxOfficeInfo['logo']> {
  const path = trimmed(logoPath)
  if (!path) return undefined
  try {
    const data = await readFile(path)
    const info = imageInfo(data)
    if (!info || info.width <= 0 || info.height <= 0) {
      console.warn('[jurisupport] 로고 파일이 PNG/JPEG가 아닙니다:', path)
      return undefined
    }
    return { data, mime: info.mime, width: info.width, height: info.height }
  } catch (error) {
    console.warn('[jurisupport] 로고 파일을 읽지 못했습니다:', path, error)
    return undefined
  }
}

/** hwpx 내보내기용 사무실 정보 — 설정에서 직접 입력한 값이 JuriSupport 계정 정보보다 우선.
 *  네트워크가 늦으면 제한 시간 안에 캐시로 대체한다. */
export async function officeInfoForHwpx(timeoutMs = 6000): Promise<HwpxOfficeInfo | undefined> {
  const manual = (await getSettings()).officeProfile ?? {}

  let info: JsOfficeInfo | null = null
  try {
    info = await Promise.race([
      getOfficeInfo(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref())
    ])
  } catch {
    info = null
  }
  if (!info) info = await readOfficeCache()

  const profile = info?.profile ?? {}
  const jsLogo = info?.logo
  const logo =
    (await manualLogo(manual.logoPath)) ??
    (jsLogo
      ? {
          data: Buffer.from(jsLogo.base64, 'base64'),
          mime: jsLogo.mime,
          width: jsLogo.width,
          height: jsLogo.height
        }
      : undefined)

  const merged: HwpxOfficeInfo = {
    officeName: manual.hideOfficeName
      ? undefined
      : trimmed(manual.officeName) ?? trimmed(profile.officeName),
    phone: trimmed(manual.phone) ?? trimmed(profile.phone),
    fax: trimmed(manual.fax) ?? trimmed(profile.fax),
    email: trimmed(manual.email) ?? trimmed(profile.email),
    address: trimmed(manual.address) ?? trimmed(profile.address),
    footerText: trimmed(manual.footerText) ?? trimmed(profile.footerText),
    logo
  }
  const hasData =
    merged.officeName ||
    merged.phone ||
    merged.fax ||
    merged.email ||
    merged.address ||
    merged.footerText ||
    merged.logo
  return hasData ? merged : undefined
}
