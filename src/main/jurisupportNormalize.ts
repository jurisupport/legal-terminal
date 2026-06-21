export interface JsParty {
  role: string
  position: string | null
  party: { name: string; type: string; phone?: string | null }
}

export interface JsHearing {
  type: string
  dateTime: string
  location?: string | null
  note?: string | null
  status?: string
}

export interface JsCase {
  id: string
  caseNumber: string | null
  caseName: string | null
  court: string | null
  division: string | null
  caseType: string | null
  status: string
  memo?: string | null
  parties: JsParty[]
  hearings: JsHearing[]
  updatedAt?: string
  _count?: { parties: number; hearings: number; progresses: number; documents: number }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringFrom(obj[key])
    if (value) return value
  }
  return undefined
}

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = obj[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function normalizeParty(value: unknown): JsParty | null {
  const obj = asObject(value)
  if (!obj) return null
  const party = asObject(obj.party) ?? asObject(obj.person) ?? asObject(obj.client) ?? asObject(obj.opponent)
  const name =
    firstString(obj, ['partyName', 'party_name', 'name']) ??
    (party ? firstString(party, ['name', 'partyName', 'party_name']) : undefined)
  if (!name) return null
  return {
    ...(obj as unknown as JsParty),
    role: firstString(obj, ['role', 'partyRole', 'party_role']) ?? 'party',
    position: firstString(obj, ['position', 'partyPosition', 'party_position']) ?? null,
    party: {
      ...(party as { name: string; type: string; phone?: string | null } | null),
      name,
      type:
        (party ? firstString(party, ['type', 'partyType', 'party_type']) : undefined) ??
        firstString(obj, ['partyType', 'party_type', 'type']) ??
        'person',
      phone:
        (party ? firstString(party, ['phone', 'phoneNumber', 'phone_number']) : undefined) ??
        firstString(obj, ['phone', 'phoneNumber', 'phone_number']) ??
        null
    }
  }
}

function normalizeParties(value: unknown[]): JsParty[] {
  return value.map(normalizeParty).filter((party): party is JsParty => party !== null)
}

function normalizeHearing(value: unknown): JsHearing | null {
  const obj = asObject(value)
  if (!obj) return null
  const date = firstString(obj, [
    'dateTime',
    'date_time',
    'datetime',
    'scheduledAt',
    'scheduled_at',
    'startAt',
    'start_at',
    'hearingDateTime',
    'hearing_date_time',
    'hearingDate',
    'hearing_date',
    'date'
  ])
  if (!date) return null
  return {
    ...(obj as unknown as JsHearing),
    type: firstString(obj, ['type', 'kind', 'hearingType', 'hearing_type']) ?? 'hearing',
    dateTime: date,
    location:
      firstString(obj, ['location', 'place', 'courtroom', 'courtRoom', 'court_room']) ?? null,
    note: firstString(obj, ['note', 'memo', 'description', 'name', 'title']) ?? null,
    status: firstString(obj, ['status'])
  }
}

function normalizeHearings(value: unknown[]): JsHearing[] {
  return value.map(normalizeHearing).filter((hearing): hearing is JsHearing => hearing !== null)
}

function normalizeCount(value: unknown): JsCase['_count'] | undefined {
  const obj = asObject(value)
  if (!obj) return undefined
  return {
    parties: numberFrom(obj.parties) ?? numberFrom(obj.party_count) ?? 0,
    hearings: numberFrom(obj.hearings) ?? numberFrom(obj.hearing_count) ?? 0,
    progresses: numberFrom(obj.progresses) ?? numberFrom(obj.progress_count) ?? 0,
    documents: numberFrom(obj.documents) ?? numberFrom(obj.document_count) ?? 0
  }
}

export function normalizeCase(value: unknown): JsCase | null {
  const obj = asObject(value)
  if (!obj) return null
  const id = firstString(obj, ['id', 'caseId', 'case_id'])
  if (!id) {
    for (const key of ['case', 'item', 'data', 'result']) {
      const nested = normalizeCase(obj[key])
      if (nested) return nested
    }
    return null
  }
  return {
    ...(obj as unknown as JsCase),
    id,
    caseNumber: firstString(obj, ['caseNumber', 'case_number', 'number']) ?? null,
    caseName: firstString(obj, ['caseName', 'case_name', 'name', 'title']) ?? null,
    court: firstString(obj, ['court', 'courtName', 'court_name']) ?? null,
    division: firstString(obj, ['division', 'divisionName', 'division_name']) ?? null,
    caseType: firstString(obj, ['caseType', 'case_type', 'type']) ?? null,
    status: firstString(obj, ['status']) ?? 'active',
    memo: firstString(obj, ['memo', 'notes', 'description', 'content']) ?? null,
    parties: normalizeParties(firstArray(obj, ['parties', 'caseParties', 'case_parties'])),
    hearings: normalizeHearings(
      firstArray(obj, [
        'hearings',
        'hearingList',
        'hearing_list',
        'schedules',
        'scheduleList',
        'schedule_list',
        'appointments',
        'trials'
      ])
    ),
    updatedAt: firstString(obj, ['updatedAt', 'updated_at']),
    _count:
      normalizeCount(obj._count) ??
      normalizeCount(obj.count) ??
      normalizeCount(obj.counts)
  }
}

function normalizeCases(value: unknown): JsCase[] {
  return Array.isArray(value)
    ? value.map(normalizeCase).filter((item): item is JsCase => item !== null)
    : []
}

export function normalizeCaseList(r: unknown): JsCase[] {
  if (Array.isArray(r)) return normalizeCases(r)
  const obj = asObject(r)
  if (!obj) return []

  for (const key of ['cases', 'caseList', 'case_list', 'items', 'data', 'results']) {
    const value = obj[key]
    if (Array.isArray(value)) return normalizeCases(value)
    const nested = asObject(value)
    if (!nested) continue
    for (const nestedKey of ['cases', 'caseList', 'case_list', 'items', 'data', 'results']) {
      const nestedValue = nested[nestedKey]
      if (Array.isArray(nestedValue)) return normalizeCases(nestedValue)
    }
  }
  return []
}
