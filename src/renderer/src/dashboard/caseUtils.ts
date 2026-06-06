import type { JsCase, JsParty } from '../env'
import { formatHearingLabel } from './hearings'

export const caseWebUrl = (id: string): string => `https://jurisupport.com/cases/${id}`

export function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function nextHearing(c: JsCase): { when: string; note: string } | null {
  if (!c.hearings?.length) return null
  const now = Date.now()
  const sorted = [...c.hearings].sort(
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
