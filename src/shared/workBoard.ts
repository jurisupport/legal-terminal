export { boardDocumentPaths, isBoardDocumentPath } from './workBoardDocuments.ts'
export type BoardStatus = 'queued' | 'running' | 'blocked' | 'reported' | 'in_review' | 'awaiting_approval' | 'approved' | 'rejected' | 'done' | 'failed'
export type BoardTodoScope = { kind: 'case'; caseId: string } | { kind: 'all' }

function todoReviewText(input: string): string {
  return input.normalize('NFC').replace(/\s+/gu, '').replace(/[.!?。]+$/u, '')
}

// Match standalone requests so an instruction to change a task is never reduced to a report.
export function isBoardTodoReview(input: string): boolean {
  const text = todoReviewText(input)
  const request = text.replace(/^(?:(?:쥬리서포트|주리서포트|jurisupport)(?:에등록된|에있는|에서|의)?|전체|모든|이사건|현재사건|이번사건|미완료|남은|등록된|앱의|앱에등록된)*/iu, '')
  if (!request.startsWith('할일')) return false
  const action = request.replace(/^할일(?:목록)?(?:을|를)?/u, '')
  if (!action) return /전체|모든/u.test(text.slice(0, text.indexOf('할일')))
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
  editedNeedsRun?: true
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
  ownerRevision?: string
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
  takeOwnership(workspace: string, expectedOwner: string): Promise<void>
  updateTask(workspace: string, id: string, draft: BoardDraft, revision: string): Promise<void>
  removeTask(workspace: string, id: string, revision: string): Promise<void>
  add(workspace: string, drafts: BoardDraft[], batchId?: string): Promise<void>
  decide(workspace: string, id: string, action: BoardDecision, reason?: string, expectedRevision?: string, todoScope?: BoardTodoScope): Promise<void>
  reorder(workspace: string, ids: string[]): Promise<void>
  configure(workspace: string, patch: Partial<BoardSettings>): Promise<void>
  detail(workspace: string, id: string): Promise<{report: string; review: string}>
  documentPath(workspace: string, id: string, path: string): Promise<string>
  documentText(workspace: string, id: string, path: string, offset?: number): Promise<{text: string; nextOffset: number | null; size: number}>
  daily(workspace: string): Promise<string>
  onChange(listener: (workspace: string, message?: string) => void): () => void
  counts(): Promise<Record<string, number>>
}

export function boardMutationIssue(task: BoardTask, tasks: readonly BoardTask[], action: 'update' | 'remove'): string | undefined {
  if (task.status === 'running' || task.status === 'in_review') return '수행 또는 검토가 끝난 뒤 변경할 수 있습니다.'
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
  return /^#{1,6} [^\n]+\r?\n+\s*[^#\s]/mu.test(text.slice(notice[0].length))
}

export function boardRevision(task: BoardTask, detail?: { report: string; review: string }): string {
  return JSON.stringify([
    Object.entries(task).filter(([,value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)),
    detail?.report, detail?.review
  ])
}
