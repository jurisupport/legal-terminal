export { boardDocumentPaths, boardReferencePaths, isBoardDocumentPath } from './workBoardDocuments.ts'
// 'delegated': a department head assigned members' sub-cards and waits for their reports.
export type BoardStatus = 'queued' | 'running' | 'delegated' | 'blocked' | 'reported' | 'in_review' | 'awaiting_approval' | 'approved' | 'rejected' | 'done' | 'failed'
export type BoardTodoScope = { kind: 'case'; caseId: string } | { kind: 'all' }

function todoReviewText(input: string): string {
  return input.normalize('NFC').replace(/\s+/gu, '').replace(/[.!?。]+$/u, '')
}

// Match standalone requests so an instruction to change a task is never reduced to a report.
export function isBoardTodoReview(input: string): boolean {
  const text = todoReviewText(input)
  const request = text.replace(/^(?:(?:쥬리서포트|주리서포트|jurisupport)(?:에등록된|에있는|에서|의)?|먼저|우선|일단|전체|모든|이사건|현재사건|이번사건|미완료|남은|등록된|앱의|앱에등록된)*/iu, '')
  if (!request.startsWith('할일')) return false
  const action = request.replace(/^할일(?:목록)?(?:을|를|부터)?(?:먼저|좀)?/u, '')
  if (!action) return /전체|모든/u.test(text.slice(0, text.indexOf('할일')))
  if (/^(?:보여줘|보여주세요)$/u.test(action)) return true
  const intent = /^(?:검토|점검|확인|조회|정리|요약)(.*)$/u.exec(action)
  if (!intent) return false
  const ending = intent[1].replace(/^(?:부터)?(?:먼저|우선)?/u, '')
  return /^(?:하기|하자|하죠|합시다|할까요|요청|부탁(?:해|합니다|드립니다)?|해(?:보자|봅시다|줘요?|주세요|주십시오|주실래요)?)?$/u.test(ending)
}

// An unbound board cannot infer which case an explicitly case-scoped instruction refers to.
export function requestsCurrentBoardCase(input: string): boolean {
  return /(?:이|현재|이번)사건/u.test(todoReviewText(input))
}

export interface BoardDraft {
  todoScope?: BoardTodoScope
  title: string
  body: string
  agent?: string
  /** A department instruction. Its head splits the work into member sub-cards and combines their reports. */
  team?: string
  /** Left to the chief of staff, who picks the departments, orders them and combines their reports. */
  chief?: true
  due?: string
  review_agent?: string
  approval?: 'required' | 'none'
  depends_on?: string[]
  after_approval?: string
  allowed_tools?: string[]
}
export interface BoardTask extends BoardDraft {
  id: string
  cwd: string
  status: BoardStatus
  order: number
  createdAt: string
  updatedAt: string
  attempts: number
  followUp?: { id: string; title: string; body: string; report?: string }
  reportReceipt?: { state: 'unread' | 'read'; digest: string }
  editedNeedsRun?: true
  log: { at: string; text: string }[]
  sessionId?: string
  parentId?: string
  /** The department instruction that delegated this member sub-card. */
  delegatedBy?: string
  /** The chief-of-staff instruction that routed this department instruction. */
  routedBy?: string
  /** The department routine that created this card. */
  routine?: string
  /** Estimated spend in USD of this card's own sessions. A department instruction adds its members' cards. */
  cost?: number
}
export interface BoardSettings {
  concurrency: number
  restart: 'requeue' | 'resume'
  maxReviews: number
  dailyTime: string
}
/** Per-tool permission for a department: allow runs without approval (read-only tools only), ask goes to the approval inbox, off refuses. */
export type BoardToolLevel = 'allow' | 'ask' | 'off'
/** Tools a department can open. Only read-only tools may be allowed without approval. */
export const boardDepartmentTools = [
  { key: 'korean-law', label: 'korean-law 법령·판례 조회', readOnly: true },
  { key: 'legal-books', label: 'legal-books 법률서적 검색', readOnly: true },
  { key: 'lbox', label: 'lbox 판례 검색·전문 조회', readOnly: true },
  { key: 'bash', label: '작업 폴더 명령 실행', readOnly: false },
  { key: 'mcp', label: '등록된 외부 MCP 도구', readOnly: false }
] as const
export type BoardDepartmentToolKey = typeof boardDepartmentTools[number]['key']
/**
 * An office-wide department. The app's built-in head instructions split the work; `leadGuide` adds to them.
 * `rules` is shared by every member and prepended to their own instructions.
 */
export interface BoardTeam {
  name: string
  color: string
  agents: string[]
  description?: string
  rules?: string
  leadGuide?: string
  tools?: Partial<Record<BoardDepartmentToolKey, BoardToolLevel>>
  /** Warning lines in USD. Crossing one records a warning; the work continues. */
  warnInstructionUsd?: number
  warnMonthlyUsd?: number
  /** A hard stop for one instruction in USD, including its members. Reaching it stops the work for review. */
  stopInstructionUsd?: number
  /** Work the department does on a schedule. Each run becomes an ordinary card on the given board. */
  routines?: BoardRoutine[]
}
/** A scheduled department instruction, created as a card at `time` (Korea time) on the board for `workspace`. */
export interface BoardRoutine {
  id: string
  title: string
  body: string
  time: string
  days: 'daily' | 'weekdays'
  workspace: string
  approval?: 'required' | 'none'
  todoScope?: BoardTodoScope
}
export const maxDepartmentRoutines = 5

/** Whether the routine should have produced today's card by `now`, given the date it last ran. */
export function boardRoutineDue(routine: Pick<BoardRoutine, 'time' | 'days'>, lastDate: string | undefined, now = new Date()): string | undefined {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(routine.time)) return
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? ''
  const today = `${part('year')}-${part('month')}-${part('day')}`
  if (lastDate === today || (routine.days === 'weekdays' && ['Sat', 'Sun'].includes(part('weekday')))) return
  return now.getTime() >= Date.parse(`${today}T${routine.time}:00+09:00`) ? today : undefined
}
export interface BoardAgent { name: string; description: string }
/** A saved version of the office departments, newest first. */
export interface BoardTeamVersion { id: string; at: string; teams: number }
export interface BoardDepartments {
  /** Where the office departments live, e.g. ~/.legal-terminal/departments on the machine that runs them. */
  home: string
  history: BoardTeamVersion[]
  /** This month's recorded spend per department in USD. */
  usage: Record<string, number>
  /** Departments still kept in this board's legacy teams.yaml, offered once while the office has none. */
  legacy: BoardTeam[]
  /** Descriptions that overlap and may make the wrong department or member be chosen. */
  overlaps: string[]
}
export interface BoardSnapshot {
  todoCaseIds?: string[]
  workspace?: string
  warnings?: string[]
  readOnly?: boolean
  ownerRevision?: string
  tasks: BoardTask[]
  settings: BoardSettings
  teams: BoardTeam[]
  departments?: BoardDepartments
  agents: BoardAgent[]
  folder: string
}
export type BoardDecision = 'acknowledge' | 'allowTodoRead' | 'retryReport' | 'approve' | 'reject' | 'revise' | 'retry' | 'complete' | 'submit'
export interface BoardApi {
  open(workspace: string, folder?: string): Promise<BoardSnapshot>
  snapshot(workspace: string): Promise<BoardSnapshot>
  takeOwnership(workspace: string, expectedOwner: string): Promise<void>
  updateTask(workspace: string, id: string, draft: BoardDraft, revision: string): Promise<void>
  removeTask(workspace: string, id: string, revision: string): Promise<void>
  addFollowUp(workspace: string, sourceId: string, draft: BoardDraft, requestId: string, expectedRevision: string): Promise<string>
  add(workspace: string, drafts: BoardDraft[], batchId?: string): Promise<void>
  decide(workspace: string, id: string, action: BoardDecision, reason?: string, expectedRevision?: string, todoScope?: BoardTodoScope): Promise<void>
  reorder(workspace: string, ids: string[]): Promise<void>
  configure(workspace: string, patch: Partial<BoardSettings>): Promise<void>
  saveTeams(workspace: string, teams: BoardTeam[]): Promise<void>
  restoreTeams(workspace: string, versionId: string): Promise<void>
  importLegacyTeams(workspace: string): Promise<void>
  suggestedTeams(workspace: string): Promise<{ teams: BoardTeam[]; missing: string[] }>
  detail(workspace: string, id: string): Promise<{report: string; review: string}>
  documentPath(workspace: string, id: string, path: string): Promise<string>
  downloadDocument(workspace: string, id: string, path: string): Promise<boolean>
  downloadReport(workspace: string, id: string): Promise<boolean>
  documentText(workspace: string, id: string, path: string, offset?: number): Promise<{text: string; nextOffset: number | null; size: number}>
  daily(workspace: string): Promise<string>
  onChange(listener: (workspace: string, message?: string) => void): () => void
  counts(inbox?: 'approvals' | 'reports'): Promise<Record<string, number>>
}

type BoardResultFields = Pick<BoardDraft, 'approval' | 'after_approval'>
type BoardInboxFields = BoardResultFields & Pick<BoardTask, 'status' | 'parentId' | 'delegatedBy' | 'routedBy'>

export function boardDelegates(task: Pick<BoardTask, 'id'>, tasks: readonly BoardTask[]): BoardTask[] {
  return tasks.filter(candidate => candidate.delegatedBy === task.id)
}

/** Department instructions the chief of staff routed from this instruction. */
export function boardRouted(task: Pick<BoardTask, 'id'>, tasks: readonly BoardTask[]): BoardTask[] {
  return tasks.filter(candidate => candidate.routedBy === task.id)
}

/** Cards that report to this one instead of the lawyer: member sub-cards and routed department instructions. */
export function boardChildren(task: Pick<BoardTask, 'id'>, tasks: readonly BoardTask[]): BoardTask[] {
  return tasks.filter(candidate => candidate.delegatedBy === task.id || candidate.routedBy === task.id)
}

export function isBoardDepartmentTask(task: Pick<BoardTask, 'team' | 'parentId' | 'delegatedBy'>): boolean {
  return !!task.team && !task.parentId && !task.delegatedBy
}

export function isBoardChiefTask(task: Pick<BoardTask, 'chief' | 'parentId' | 'delegatedBy' | 'routedBy'>): boolean {
  return !!task.chief && !task.parentId && !task.delegatedBy && !task.routedBy
}

export function boardRequestsTodoRead(task: BoardTask): boolean {
  if (task.status !== 'blocked' || task.parentId || task.editedNeedsRun || isBoardTodoReview(task.body) ||
      task.log.at(-1)?.text !== '권한 확인 또는 추가 답변 필요') return false
  // Older sessions requested list_todos through the board's external-tool bridge.
  let request: string | undefined
  for (let i = task.log.length - 2; i >= 0; i--) {
    const { text } = task.log[i]
    if (text.startsWith('검토 시작 · ') || text === 'JuriSupport 할일 점검 시작') return false
    if (text.startsWith('수행 시작 · ')) return /^결재 필요 · mcp__jurisupport__list_(?:tasks|todos)$/.test(request ?? '')
    if (!request && text.startsWith('결재 필요 · ')) request = text
  }
  return false
}

export function boardResultKind(task: BoardResultFields): 'report' | 'final' | 'action' {
  if (task.after_approval?.trim()) return 'action'
  return task.approval === 'required' ? 'final' : 'report'
}

// Member sub-cards report to their department head, and routed departments to the chief of staff, not to the lawyer's inboxes.
export function isBoardReport(task: BoardInboxFields): boolean {
  return task.status === 'done' && !task.parentId && !task.delegatedBy && !task.routedBy && boardResultKind(task) === 'report'
}

export function isBoardDecisionPending(task: BoardInboxFields): boolean {
  return task.status === 'awaiting_approval' && !task.parentId && !task.delegatedBy && !task.routedBy && boardResultKind(task) !== 'report'
}

export function canRetryAsReport(task: BoardTask, tasks: readonly BoardTask[]): boolean {
  return !task.parentId && isBoardTodoReview(task.body) && boardResultKind(task) === 'final' &&
    !task.allowed_tools?.length && ['blocked', 'failed', 'rejected', 'awaiting_approval'].includes(task.status) &&
    !tasks.some(other => other.parentId === task.id)
}

export function boardMutationIssue(task: BoardTask, tasks: readonly BoardTask[], action: 'update' | 'remove'): string | undefined {
  if (task.status === 'running' || task.status === 'in_review') return '수행 또는 검토가 끝난 뒤 변경할 수 있습니다.'
  if (boardDelegates(task, tasks).length) {
    return action === 'remove' ? '부서원 하위 업무를 먼저 삭제해 주세요.' : '부서원에게 배분한 지시는 수정할 수 없습니다. 추가 업무 지시를 이용해 주세요.'
  }
  if (boardRouted(task, tasks).length) {
    return action === 'remove' ? '비서실장이 배분한 부서 업무를 먼저 삭제해 주세요.' : '부서에 배분한 지시는 수정할 수 없습니다. 추가 업무 지시를 이용해 주세요.'
  }
  if (task.routedBy && action === 'remove') {
    const chief = tasks.find(candidate => candidate.id === task.routedBy)
    if (chief && ['running', 'in_review'].includes(chief.status)) return '비서실장이 취합을 마친 뒤 삭제할 수 있습니다.'
  }
  if (task.delegatedBy && action === 'remove') {
    const head = tasks.find(candidate => candidate.id === task.delegatedBy)
    if (head && ['running', 'in_review'].includes(head.status)) return '부서장이 취합을 마친 뒤 삭제할 수 있습니다.'
  }
  if (task.status === 'approved') return '승인 후 실행 결과를 확인한 뒤 변경할 수 있습니다.'
  if (task.parentId) {
    if (action === 'update') return '승인 후 실행 지시는 결재된 내용을 유지합니다.'
    const parent = tasks.find(candidate => candidate.id === task.parentId)
    if (!['done', 'rejected'].includes(task.status) || (parent && !['done', 'rejected'].includes(parent.status))) {
      return '승인 후 실행 결과와 원 지시의 처리가 끝난 뒤 삭제할 수 있습니다.'
    }
  }
  if (tasks.some(candidate => candidate.parentId === task.id)) {
    return action === 'remove' ? '연결된 승인 후 실행 지시를 먼저 확인하고 삭제해 주세요.' : '승인 후 실행 기록이 연결된 원 지시는 수정할 수 없습니다.'
  }
  const dependents = tasks.filter(candidate => candidate.depends_on?.includes(task.id))
  if (action === 'remove' && dependents.length) return '다른 지시의 선행 업무로 지정되어 있습니다.'
  if (task.status === 'done' && dependents.some(candidate => candidate.status !== 'queued')) {
    return '이 결과를 사용한 후속 지시가 있어 다시 수행하도록 변경할 수 없습니다.'
  }
}

// A blocked run can save its diagnostic in the report file without producing a work result.
export function boardReportAvailable(report: string): boolean {
  const text = report.trim()
  if (!text || /^## 할 일 조회 확인 필요(?:\s|$)/u.test(text) ||
      text.startsWith('JuriSupport 계정 또는 연결 사건을 확인할 수 없어 보고서 저장을 보류했습니다.')) return false
  if (text === '결재 필요') return false
  const notice = /^## 결재 필요[ \t]*(?:\r?\n|$)/u.exec(text)
  if (!notice) return true
  const details = text.slice(notice[0].length).trim()
  if (/^(?:Bash\s*\(|mcp__[\w.-]+__[\w.-]+(?:\s|$)|실행 결과 확인 필요 · )/u.test(details)) return false
  return /^#{1,6} [^\n]+\r?\n+\s*[^#\s]/mu.test(details)
}

export function boardFollowUpContext(task: BoardTask, detail: { report: string }): NonNullable<BoardTask['followUp']> {
  const source = { id: task.id, title: task.title, body: task.body }
  return !task.editedNeedsRun && boardReportAvailable(detail.report) ? { ...source, report: detail.report } : source
}

export function boardFollowUpRevision(task: BoardTask, detail: { report: string }): string {
  // Queue order, receipt and progress updates do not change the source material the user saw.
  return JSON.stringify(boardFollowUpContext(task, detail))
}

export function boardRevision(task: BoardTask, detail?: { report: string; review: string }): string {
  return JSON.stringify([
    Object.entries(task).filter(([,value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)),
    detail?.report, detail?.review
  ])
}

/** Total estimated spend of an instruction, including routed departments and member sub-cards. */
export function boardInstructionCost(task: Pick<BoardTask, 'id' | 'cost'>, tasks: readonly BoardTask[]): number {
  const total = (task.cost ?? 0) + boardChildren(task, tasks).reduce((sum, child) => sum + boardInstructionCost(child, tasks), 0)
  return Math.round(total * 10_000) / 10_000
}

export function formatUsd(value: number): string {
  return '$' + (value < 1 ? value.toFixed(3) : value.toFixed(2))
}

function descriptionWords(text: string): Set<string> {
  return new Set(text.normalize('NFC').toLowerCase().split(/[\s,·/()\[\]]+/u).filter(word => word.length > 1))
}

/** Two descriptions overlap when one contains the other or most of their words are shared. */
export function descriptionsOverlap(a: string, b: string): boolean {
  const x = a.trim(), y = b.trim()
  if (!x || !y) return false
  if (x === y || x.includes(y) || y.includes(x)) return true
  const left = descriptionWords(x), right = descriptionWords(y)
  if (!left.size || !right.size) return false
  const shared = [...left].filter(word => right.has(word)).length
  return shared / Math.min(left.size, right.size) >= 0.6
}
