export type BoardStatus = 'queued' | 'running' | 'blocked' | 'reported' | 'in_review' | 'awaiting_approval' | 'approved' | 'rejected' | 'done' | 'failed'
export interface BoardDraft {
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
  decide(workspace: string, id: string, action: BoardDecision, reason?: string, expectedRevision?: string): Promise<void>
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
