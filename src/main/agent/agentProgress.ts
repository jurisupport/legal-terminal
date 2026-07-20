export function codexWorkStepStatus(value: unknown): 'running' | 'done' | 'error' | 'cancelled' {
  if (value === 'pendingInit' || value === 'running' || value === 'inProgress') return 'running'
  if (value === 'interrupted') return 'cancelled'
  if (value === 'errored' || value === 'notFound' || value === 'failed' || value === 'declined') return 'error'
  return 'done'
}

export function codexTurnRunStatus(value: unknown, activeWork: number): 'working' | 'done' | 'error' {
  if (value === 'failed') return 'error'
  return activeWork > 0 ? 'working' : 'done'
}
