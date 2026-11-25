import { kstDateKey } from './todoSummary.ts'
import type { BoardTask } from './workBoard'

export function isBoardRunning(task: Pick<BoardTask, 'status'>): boolean {
  return task.status === 'running' || task.status === 'delegated' || task.status === 'in_review'
}

export function isBoardDueSoon(task: Pick<BoardTask, 'due' | 'status'>, now = new Date()): boolean {
  if (['approved', 'rejected', 'done', 'failed'].includes(task.status)) return false
  const today = kstDateKey(now)
  const due = kstDateKey(task.due)
  if (!due || !today) return false
  const days = (Date.parse(due) - Date.parse(today)) / 86_400_000
  return days >= 0 && days <= 3
}
