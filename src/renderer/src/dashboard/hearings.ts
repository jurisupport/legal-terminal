import type { JsCase, JsHearing } from '../env'

const HEARING_TYPE_KO: Record<string, string> = {
  ruling: '선고',
  hearing: '변론기일',
  preparation: '변론준비',
  mediation: '조정',
  other: '기일'
}

const INACTIVE_HEARING_STATUSES = new Set([
  'changed',
  'rescheduled',
  'superseded',
  'cancelled',
  'canceled',
  'postponed',
  '변경',
  '기일변경',
  '취소',
  '취소됨',
  '연기',
  '연기됨'
])

export function isActiveHearing(h: JsHearing): boolean {
  const status = h.status?.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '')
  return !status || !INACTIVE_HEARING_STATUSES.has(status)
}

function isCriminalCase(c: JsCase): boolean {
  return c.caseType === 'criminal'
}

function hearingTypeLabel(c: JsCase, h: JsHearing): string | null {
  if (h.type === 'trial') return isCriminalCase(c) ? '공판' : '변론기일'
  return HEARING_TYPE_KO[h.type] ?? null
}

function normalizeGenericNote(c: JsCase, note: string): string {
  if (!isCriminalCase(c) && (note === '공판' || note === '공판기일')) return '변론기일'
  return note
}

export function formatHearingLabel(
  c: JsCase,
  h: JsHearing,
  options: { locationFirst?: boolean } = {}
): string {
  const note = h.note?.trim()
  if (note) return normalizeGenericNote(c, note)
  const location = h.location?.trim()
  if (options.locationFirst && location) return location
  return hearingTypeLabel(c, h) ?? location ?? h.type
}
