export interface AgentRateLimitUsageView {
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  utilization?: number
  remainingPercent?: number
  resetsAt?: number
  isUsingOverage?: boolean
  updatedAt: number
}

const resetTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

export function percentText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

export function rateLimitTypeLabel(value: string | undefined): string {
  if (value === 'five_hour') return '5시간 한도'
  if (value === 'seven_day') return '7일 한도'
  if (value === 'seven_day_opus') return '7일 Opus'
  if (value === 'seven_day_sonnet') return '7일 Sonnet'
  if (value === 'overage') return '초과 사용'
  return '한도'
}

export function rateLimitLabel(value: AgentRateLimitUsageView): string {
  const reset = resetTimeText(value.resetsAt)
  const remaining =
    value.remainingPercent === undefined ? rateLimitStatusText(value) : `잔여 ${percentText(value.remainingPercent)}`
  return `${rateLimitTypeLabel(value.rateLimitType)} ${remaining}${reset ? ` · ${reset}` : ''}`
}

export function rateLimitStatusText(value: AgentRateLimitUsageView): string {
  if (value.rateLimitType === 'overage') {
    if (value.isUsingOverage) return '사용 중'
    if (value.status === 'rejected') return '불가'
    if (value.status === 'allowed_warning') return '주의'
    if (value.status === 'allowed') return '가능'
  }
  if (value.status === 'rejected') return '소진'
  if (value.status === 'allowed_warning') return '주의'
  return '잔여율 미제공'
}

export function showRateLimitInBar(value: AgentRateLimitUsageView): boolean {
  if (value.rateLimitType !== 'overage') return true
  return value.isUsingOverage === true || value.status === 'rejected' || value.status === 'allowed_warning'
}

export function rateLimitTone(value: AgentRateLimitUsageView): '' | 'warn' | 'error' {
  if (value.status === 'rejected') return 'error'
  if (value.status === 'allowed_warning') return 'warn'
  return ''
}

export function resetTimeText(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return `갱신 ${resetTimeFormatter.format(new Date(value))}`
}
