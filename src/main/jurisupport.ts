import { safeStorage } from 'electron'
import { getSettings, setSettings } from './settings'
import {
  normalizeCase,
  normalizeCaseList,
  type JsCase,
  type JsParty
} from './jurisupportNormalize'

export type { JsCase, JsHearing, JsParty } from './jurisupportNormalize'

// JuriSupport 본체(jurisupport3) MCP over HTTP 클라이언트.
// 프로토콜: POST /mcp 로 initialize → notifications/initialized → tools/call.
// 응답은 SSE 한 건("event: message\ndata: {json}"), result.content[0].text = JSON 문자열.
const MCP_URL = 'https://api.jurisupport.com/mcp'

let sessionId: string | null = null
let toolQueue: Promise<void> = Promise.resolve()

const CASES_PAGE_LIMIT = 100
const CASES_MAX_PAGES = 20
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
  let enc: string
  if (token && safeStorage.isEncryptionAvailable()) {
    enc = 'v1:' + safeStorage.encryptString(token).toString('base64')
  } else {
    enc = 'plain:' + token
  }
  await setSettings({ jurisupportTokenEnc: token ? enc : undefined })
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

// 같은 MCP 세션에 동시 tools/call이 겹치면 서버/세션 타이밍에 따라 간헐 실패할 수 있어 순차화한다.
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const previous = toolQueue
  let release: () => void = () => {}
  toolQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await callToolNow(name, args)
  } finally {
    release()
  }
}

export interface JsTodoProgress {
  id?: string
  text: string
  createdAt?: string
  source?: 'manual' | 'terminal' | 'jurisupport' | string
  terminalId?: string
  cwd?: string
}
export interface JsTodo {
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
  page?: number
  limit?: number
  search?: string
  status?: string
  caseId?: string
  includeArchived?: boolean
}
export interface TodoMutationInput {
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

function toMcpDateTime(value?: string | null): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 0, 0).toISOString()
  }
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
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
  if (!id && !title) return null

  return {
    id: id ?? title ?? '',
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

function caseKey(c: JsCase): string {
  return [c.id, c.caseNumber, c.court, c.caseName].filter(Boolean).join('\0')
}

function todoKey(todo: JsTodo): string {
  return [todo.id, todo.title, todo.caseId, todo.caseNumber].filter(Boolean).join('\0')
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
  try {
    const c = await getCase(id)
    todoCaseCache.set(id, c)
    return c
  } catch (error) {
    console.warn('[jurisupport] failed to enrich todo case', error)
    todoCaseCache.set(id, null)
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

function taskListArgs(params: ListTodosParams): Record<string, unknown> {
  return compactRecord({
    type: 'todo',
    page: params.page,
    limit: params.limit,
    search: params.search,
    caseId: params.caseId,
    status: toJuriTaskStatus(params.status)
  })
}

function createTaskArgs(input: TodoMutationInput): Record<string, unknown> {
  return compactRecord({
    title: input.title,
    type: 'todo',
    content: mergeCaseInfoWithNotes(input),
    dueDate: toMcpDateTime(input.dueDate),
    caseId: input.caseId,
    priority: normalizePriority(input.priority)
  })
}

function updateTaskArgs(input: TodoMutationInput): Record<string, unknown> {
  return compactRecord({
    title: input.title,
    content: mergeCaseInfoWithNotes(input),
    dueDate: toMcpDateTime(input.dueDate),
    priority: normalizePriority(input.priority)
  })
}

type CaseListQuery = Omit<ListCasesParams, 'refresh'>

const caseListCache = new Map<string, { fetchedAt: number; cases: JsCase[] }>()
const caseListInflight = new Map<string, Promise<JsCase[]>>()

function clearJuriSupportCaches(): void {
  todoCaseCache.clear()
  caseListCache.clear()
  caseListInflight.clear()
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

async function listCasePage(params: ListCasesParams): Promise<JsCase[]> {
  return normalizeCaseList(await callTool('list_cases', params as Record<string, unknown>))
}

async function listCasesFresh(params: CaseListQuery): Promise<JsCase[]> {
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

export async function listCases(params: ListCasesParams = {}): Promise<JsCase[]> {
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

async function listTodoPage(params: ListTodosParams): Promise<JsTodo[]> {
  return enrichTodos(normalizeTodoList(await callTool('list_tasks', taskListArgs(params))))
}

export async function listTodos(params: ListTodosParams = {}): Promise<JsTodo[]> {
  const { page, limit, ...filters } = params
  const hasExplicitPaging = page !== undefined || limit !== undefined

  if (hasExplicitPaging) {
    return listTodoPage({
      page: page ?? 1,
      limit: limit ?? TODOS_PAGE_LIMIT,
      ...filters
    })
  }

  const todos: JsTodo[] = []
  const seen = new Set<string>()

  for (let pageNo = 1; pageNo <= TODOS_MAX_PAGES; pageNo++) {
    let pageTodos: JsTodo[]
    try {
      pageTodos = await listTodoPage({ page: pageNo, limit: TODOS_PAGE_LIMIT, ...filters })
    } catch (error) {
      if (pageNo === 1) throw error
      console.warn('[jurisupport] stopped paginating list_tasks', error)
      break
    }

    if (pageTodos.length === 0) break

    let added = 0
    for (const todo of pageTodos) {
      const key = todoKey(todo)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      todos.push(todo)
      added++
    }

    if (added === 0 || pageTodos.length < TODOS_PAGE_LIMIT) break
  }

  return todos
}

export async function getTodo(id: string): Promise<JsTodo | null> {
  return normalizeTodo(await callTool('get_task', { id }))
}

export async function createTodo(input: TodoMutationInput): Promise<JsTodo | null> {
  const todo = normalizeTodo(await callTool('create_task', createTaskArgs(input)))
  const status = toJuriTaskStatus(input.status)
  if (todo?.id && status && status !== 'pending') return updateTodo(todo.id, { status })
  return todo
}

export async function updateTodo(id: string, patch: TodoMutationInput): Promise<JsTodo | null> {
  const status = toJuriTaskStatus(patch.status)
  const updateArgs = compactRecord({ id, ...updateTaskArgs(patch) })
  let todo: JsTodo | null = null

  if (Object.keys(updateArgs).length > 1) {
    todo = normalizeTodo(await callTool('update_task', updateArgs))
  }
  if (status) {
    todo = normalizeTodo(await callTool('update_task_status', { id, status })) ?? todo
  }

  return todo ?? getTodo(id)
}

export async function completeTodo(
  id: string,
  progressText?: string,
  context?: TodoTerminalContext
): Promise<JsTodo | null> {
  let todo: JsTodo | null = null
  if (progressText?.trim()) {
    todo = await appendTodoProgress(id, progressText.trim(), context)
  }
  return normalizeTodo(await callTool('update_task_status', { id, status: 'completed' })) ?? todo
}

export async function archiveTodo(id: string): Promise<JsTodo | null> {
  return normalizeTodo(await callTool('update_task_status', { id, status: 'closed' }))
}

export async function appendTodoProgress(
  id: string,
  text: string,
  context?: TodoTerminalContext
): Promise<JsTodo | null> {
  const todo = await getTodo(id)
  const content = appendProgressContent(todo?.notes, text, context)
  return normalizeTodo(await callTool('update_task', { id, content }))
}

function ymd(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function resolveDueDate(value?: string): string | undefined {
  if (!value) return undefined
  const lower = value.toLocaleLowerCase('ko-KR')
  const d = new Date()
  if (lower === 'today' || lower === '오늘') return toMcpDateTime(ymd(d))
  if (lower === 'tomorrow' || lower === '내일') {
    d.setDate(d.getDate() + 1)
    return toMcpDateTime(ymd(d))
  }
  return toMcpDateTime(value)
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
