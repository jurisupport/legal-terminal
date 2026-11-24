export type BoardStatus = 'queued' | 'running' | 'blocked' | 'reported' | 'in_review' | 'awaiting_approval' | 'approved' | 'rejected' | 'done' | 'failed'
export type BoardTodoScope = { kind: 'case'; caseId: string } | { kind: 'all' }

function todoReviewText(input: string): string {
  return input.normalize('NFC').replace(/\s+/gu, '').replace(/[.!?。]+$/u, '')
}

// Match standalone requests so an instruction to change a task is never reduced to a report.
export function isBoardTodoReview(input: string): boolean {
  const text = todoReviewText(input)
  const request = text.replace(/^(?:전체|모든|이사건|현재사건|이번사건|미완료|남은|등록된|앱의|앱에등록된)*/u, '')
  if (!request.startsWith('할일')) return false
  const action = request.replace(/^할일(?:목록)?(?:을|를)?/u, '')
  if (!action) return /^(?:전체|모든)/u.test(text)
  return /^(?:검토|점검|확인|조회|정리|요약)(?:하기|요청|부탁(?:해|합니다|드립니다)?|해(?:줘요?|주세요|주십시오|주실래요)?)?$/u.test(action) ||
    /^(?:보여줘|보여주세요)$/u.test(action)
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
  log: { at: string; text: string }[]
  sessionId?: string
  parentId?: string
}
export interface BoardSettings {
  concurrency: number
  restart: 'requeue' | 'resume'
  maxReviews: number
  dailyTime: string
}
export interface BoardTeam { name: string; color: string; agents: string[] }
export interface BoardAgent { name: string; description: string }
export interface BoardSnapshot {
  todoCaseIds?: string[]
  workspace?: string
  warnings?: string[]
  readOnly?: boolean
  tasks: BoardTask[]
  settings: BoardSettings
  teams: BoardTeam[]
  agents: BoardAgent[]
  folder: string
}
export type BoardDecision = 'approve' | 'reject' | 'revise' | 'retry' | 'complete' | 'submit'
export interface BoardApi {
  open(workspace: string, folder?: string): Promise<BoardSnapshot>
  snapshot(workspace: string): Promise<BoardSnapshot>
  add(workspace: string, drafts: BoardDraft[], batchId?: string): Promise<void>
  decide(workspace: string, id: string, action: BoardDecision, reason?: string, expectedRevision?: string, todoScope?: BoardTodoScope): Promise<void>
  reorder(workspace: string, ids: string[]): Promise<void>
  configure(workspace: string, patch: Partial<BoardSettings>): Promise<void>
  detail(workspace: string, id: string): Promise<{report: string; review: string}>
  daily(workspace: string): Promise<string>
  onChange(listener: (workspace: string, message?: string) => void): () => void
  counts(): Promise<Record<string, number>>
}

export function boardRevision(task: BoardTask, detail?: { report: string; review: string }): string {
  return JSON.stringify([
    Object.entries(task).filter(([,value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)),
    detail?.report, detail?.review
  ])
}
