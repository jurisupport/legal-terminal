import type { JsCase, JsParty } from '../env'
import { formatHearingLabel, isActiveHearing } from './hearings'

export const caseWebUrl = (id: string): string => `https://jurisupport.com/cases/${id}`

export function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// 상대시각 라벨: 방금 / N분 전 / N시간 전 / N일 전 / M.D
export function agoLabel(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '방금'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}일 전`
  const d = new Date(ms)
  return `${d.getMonth() + 1}.${d.getDate()}`
}

export function nextHearing(c: JsCase): { when: string; note: string } | null {
  const activeHearings = (c.hearings ?? []).filter(isActiveHearing)
  if (!activeHearings.length) return null
  const now = Date.now()
  const sorted = activeHearings.sort(
    (a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
  )
  const h = sorted.find((x) => new Date(x.dateTime).getTime() >= now) ?? sorted[sorted.length - 1]
  return { when: fmtDate(h.dateTime), note: formatHearingLabel(c, h, { locationFirst: true }) }
}

export function partyNames(parties: JsParty[], role: string): string {
  return parties
    .filter((p) => p.role === role)
    .map((p) => p.party.name)
    .join(', ')
}
