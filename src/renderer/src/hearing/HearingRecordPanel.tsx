import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { JsHearing } from '../env'
import { isCommittedEnter, isImeComposing } from '../ime'

type SpeakerRole = 'court' | 'plaintiff' | 'defendant' | 'preparation' | 'other'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type JsSyncStatus = 'idle' | 'syncing' | 'synced' | 'error'
type LoadState = 'idle' | 'loading' | 'error'

export interface HearingRecordCase {
  jsId?: string
  court?: string
  division?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  memo?: string
  title?: string
}

interface HearingSpeaker {
  id: string
  label: string
  role: SpeakerRole
  shortcut?: string
}

interface HearingRequest {
  id: string
  text: string
  spoken: boolean
  spokenAt?: string
  result?: string
}

interface HearingEntry {
  id: string
  speakerId: string
  text: string
  createdAt: string
  important?: boolean
}

interface HearingResult {
  status?: string
  nextDate?: string
  courtOrder?: string
  opponentSubmission?: string
  nextActions?: string[]
}

interface HearingRecordTemplate {
  id: string
  label: string
  hint: string
  speakers: HearingSpeaker[]
}

interface HearingRecordData {
  version: 1
  id: string
  case: HearingRecordCase
  hearing?: JsHearing
  speakers: HearingSpeaker[]
  activeSpeakerId: string
  requests: HearingRequest[]
  entries: HearingEntry[]
  result: HearingResult
  createdAt: string
  updatedAt: string
  jsSync?: {
    syncedAt: string
    todoId?: string
  }
}

interface SavedRecordSummary {
  path: string
  title: string
  subtitle: string
  updatedAt: string
  synced: boolean
  data: HearingRecordData
}

const withSequentialShortcuts = (speakers: HearingSpeaker[]): HearingSpeaker[] =>
  speakers.map((speaker, index) => ({ ...speaker, shortcut: index < 9 ? String(index + 1) : undefined }))

export interface HearingRecordPanelProps {
  draftsDir?: string
  initialCase?: HearingRecordCase
  initialHearing?: JsHearing
  initialPath?: string
  visible?: boolean
  onSavedPath?: (path: string, title: string) => void
  onOpenReport?: (path: string, title: string) => void
  onSummarizeReport?: (path: string, title: string) => void
}

const CIVIL_TRIAL_SPEAKERS: HearingSpeaker[] = withSequentialShortcuts([
  { id: 'court', label: '재판부', role: 'court' },
  { id: 'plaintiff', label: '원고', role: 'plaintiff' },
  { id: 'defendant', label: '피고', role: 'defendant' }
])

const CRIMINAL_TRIAL_SPEAKERS: HearingSpeaker[] = withSequentialShortcuts([
  { id: 'court', label: '재판부', role: 'court' },
  { id: 'counsel', label: '변호인', role: 'defendant' },
  { id: 'prosecutor', label: '검사', role: 'plaintiff' },
  { id: 'accused', label: '피고인', role: 'defendant' }
])

const DEFAULT_SPEAKERS = CIVIL_TRIAL_SPEAKERS

const RESULT_OPTIONS = ['변론종결', '속행', '추후지정', '선고기일', '조정회부']

const RECORD_TEMPLATES: HearingRecordTemplate[] = [
  {
    id: 'civil-trial',
    label: '민사/행정/가사',
    hint: '재판부/원고/피고',
    speakers: CIVIL_TRIAL_SPEAKERS
  },
  {
    id: 'criminal-trial',
    label: '형사',
    hint: '재판부/변호인/검사/피고인',
    speakers: CRIMINAL_TRIAL_SPEAKERS
  },
  {
    id: 'investigation',
    label: '조사',
    hint: '수사관/피의자/변호인/고소인/고소대리인',
    speakers: withSequentialShortcuts([
      { id: 'investigator', label: '수사관', role: 'court' },
      { id: 'suspect', label: '피의자', role: 'defendant' },
      { id: 'counsel', label: '변호인', role: 'preparation' },
      { id: 'complainant', label: '고소인', role: 'plaintiff' },
      { id: 'complainant-counsel', label: '고소대리인', role: 'preparation' }
    ])
  },
  {
    id: 'meeting',
    label: '조정·면담',
    hint: '직접 입력',
    speakers: []
  }
]

const newId = (prefix: string): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const pad2 = (value: number): string => String(value).padStart(2, '0')

function pathJoin(base: string, child: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`
}

function dateFromHearing(hearing?: JsHearing): Date {
  const d = hearing?.dateTime ? new Date(hearing.dateTime) : new Date()
  return Number.isNaN(d.getTime()) ? new Date() : d
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function hm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function safeFilePart(value?: string | null): string {
  const cleaned = (value ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '')
    .trim()
  return cleaned || 'hearing'
}

function hearingDateLabel(hearing?: JsHearing): string {
  const d = dateFromHearing(hearing)
  return `${ymd(d)} ${hm(d)}`
}

export function buildHearingRecordDir(draftsDir: string): string {
  return pathJoin(draftsDir, '.hearings')
}

export function buildHearingRecordPath(
  draftsDir: string,
  caseContext?: HearingRecordCase,
  hearing?: JsHearing
): string {
  const dir = buildHearingRecordDir(draftsDir)
  const date = ymd(dateFromHearing(hearing))
  const caseNo = safeFilePart(caseContext?.caseNumber || caseContext?.title)
  return pathJoin(dir, `${date}_${caseNo}.hearing.json`)
}

// 열기 시점의 날짜로 만든 경로에 기록이 없으면, 같은 사건의 가장 최근 기록을 이어서 연다.
// (기록 파일명이 날짜 기준이라 다음 날 열면 빈 기록이 새로 만들어지던 문제 방지)
export async function resolveHearingRecordPath(
  draftsDir: string,
  caseContext?: HearingRecordCase,
  hearing?: JsHearing
): Promise<string> {
  const preferred = buildHearingRecordPath(draftsDir, caseContext, hearing)
  // ponytail: 원격 최근 기록 탐색은 탭 생성을 SSH 왕복만큼 막는다. 필요하면 탭을 연 뒤 비동기로 탐색한다.
  if (draftsDir.startsWith('ssh://')) return preferred
  const stat = await window.lt.fs
    .stat(preferred)
    .catch(() => ({ ok: false as const, error: 'stat failed' }))
  if (stat.ok && !stat.isDir) return preferred
  try {
    const suffix = `_${safeFilePart(caseContext?.caseNumber || caseContext?.title)}.hearing.json`
    const entries = await window.lt.fs.list(buildHearingRecordDir(draftsDir))
    const latest = entries
      .filter((entry) => !entry.isDir && entry.name.endsWith(suffix))
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || b.name.localeCompare(a.name))[0]
    if (latest) return latest.path
  } catch {
    // 기록 폴더가 없거나 목록을 못 읽으면 새 기록 경로로 진행한다.
  }
  return preferred
}

function buildHearingReportPath(
  draftsDir: string | undefined,
  record: HearingRecordData,
  recordPath?: string
): string {
  if (recordPath?.endsWith('.hearing.json')) {
    return recordPath.replace(/\.hearing\.json$/, '.report.md')
  }
  if (!draftsDir) throw new Error('사건 폴더가 없어 보고서 경로를 만들 수 없습니다.')
  const dir = buildHearingRecordDir(draftsDir)
  const date = ymd(dateFromHearing(record.hearing))
  const caseNo = safeFilePart(record.case.caseNumber || record.case.title)
  return pathJoin(dir, `${date}_${caseNo}.report.md`)
}

export function buildHearingRecordTitle(
  caseContext?: HearingRecordCase,
  hearing?: JsHearing
): string {
  const caseLabel = [caseContext?.caseNumber, caseContext?.caseName].filter(Boolean).join(' ')
  return `기일기록 · ${caseLabel || caseContext?.title || hearingDateLabel(hearing)}`
}

function caseSubtitle(caseContext?: HearingRecordCase, hearing?: JsHearing): string {
  return [
    caseContext?.court,
    caseContext?.division,
    hearingDateLabel(hearing),
    hearing?.location
  ]
    .filter(Boolean)
    .join(' · ')
}

function resolveSpeakerPreset(speakers: HearingSpeaker[] = DEFAULT_SPEAKERS): HearingSpeaker[] {
  return withSequentialShortcuts(speakers)
}

function createInitialRecord(
  initialCase?: HearingRecordCase,
  initialHearing?: JsHearing
): HearingRecordData {
  const now = new Date().toISOString()
  const hearing = initialHearing ?? { type: 'hearing', dateTime: now }
  const speakers = resolveSpeakerPreset(RECORD_TEMPLATES[0]?.speakers)
  return {
    version: 1,
    id: newId('hearing'),
    case: initialCase ?? {},
    hearing,
    speakers,
    activeSpeakerId: speakers[0]?.id ?? '',
    requests: [],
    entries: [],
    result: { nextActions: [] },
    createdAt: now,
    updatedAt: now
  }
}

function normalizeSpeakerId(id: string | undefined): string {
  return id === 'delegate' ? 'preparation' : (id ?? '')
}

function normalizeSpeakerRole(role: string | undefined): SpeakerRole {
  if (role === 'court' || role === 'plaintiff' || role === 'defendant' || role === 'preparation') {
    return role
  }
  return 'other'
}

function normalizeSpeakers(value: unknown): HearingSpeaker[] {
  if (!Array.isArray(value)) return resolveSpeakerPreset(RECORD_TEMPLATES[0]?.speakers)
  const seenIds = new Set<string>()
  const speakers = value
    .filter((item): item is Partial<HearingSpeaker> => !!item && typeof item === 'object')
    .flatMap((speaker): HearingSpeaker[] => {
      const id = normalizeSpeakerId(speaker.id)
      if (!id || !speaker.label || seenIds.has(id)) return []
      seenIds.add(id)
      return [{ id, label: speaker.label, role: normalizeSpeakerRole(speaker.role) }]
    })
  return withSequentialShortcuts(speakers)
}

function sanitizeRecord(
  value: unknown,
  initialCase?: HearingRecordCase,
  initialHearing?: JsHearing
): HearingRecordData {
  const base = createInitialRecord(initialCase, initialHearing)
  if (!value || typeof value !== 'object') return base
  const raw = value as Partial<HearingRecordData>
  const caseContext = { ...base.case, ...(raw.case && typeof raw.case === 'object' ? raw.case : {}) }
  const speakers = normalizeSpeakers(raw.speakers)
  const rawActiveSpeakerId = normalizeSpeakerId(raw.activeSpeakerId)
  const activeSpeakerId = speakers.some((speaker) => speaker.id === rawActiveSpeakerId)
    ? rawActiveSpeakerId
    : speakers[0]?.id || 'court'
  return {
    version: 1,
    id: typeof raw.id === 'string' ? raw.id : base.id,
    case: caseContext,
    hearing: raw.hearing ?? base.hearing,
    speakers,
    activeSpeakerId,
    requests: Array.isArray(raw.requests) ? raw.requests : [],
    entries: Array.isArray(raw.entries)
      ? raw.entries.map((entry) => ({
          ...entry,
          speakerId: normalizeSpeakerId(entry.speakerId)
        }))
      : [],
    result: raw.result && typeof raw.result === 'object' ? raw.result : base.result,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    jsSync: raw.jsSync
  }
}

function roleClass(role?: SpeakerRole): string {
  return role ? `speaker-${role}` : 'speaker-other'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return hm(d)
}

function buildReport(record: HearingRecordData): string {
  const speakerMap = new Map(record.speakers.map((speaker) => [speaker.id, speaker]))
  const caseLine = [record.case.court, record.case.division, record.case.caseNumber, record.case.caseName]
    .filter(Boolean)
    .join(' · ')
  const parties = [
    record.case.client && `의뢰인: ${record.case.client}`,
    record.case.opponent && `상대방: ${record.case.opponent}`,
    !record.case.client && !record.case.opponent && record.case.partyNames
      ? `당사자: ${record.case.partyNames}`
      : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const caseMemo = record.case.memo?.trim()
  const requests = record.requests.length
    ? record.requests
        .map((request) => {
          const mark = request.spoken ? '완료' : '미완료'
          return `- [${mark}] ${request.text}${request.result ? `\n  - 결과: ${request.result}` : ''}`
        })
        .join('\n')
    : '- 기록 없음'
  const entries = record.entries.length
    ? record.entries
        .map((entry) => {
          const speaker = speakerMap.get(entry.speakerId)
          return `- ${formatTime(entry.createdAt)} ${speaker?.label ?? '사전준비'}: ${entry.text}`
        })
        .join('\n')
    : '- 기록 없음'
  const nextActions = record.result.nextActions?.length
    ? record.result.nextActions.map((item) => `- ${item}`).join('\n')
    : '- 없음'

  return [
    '# 기일 결과 보고',
    '',
    '## 1. 사건',
    caseLine || record.case.title || '사건 정보 없음',
    parties,
    caseMemo ? `메모:\n${caseMemo}` : undefined,
    '',
    '## 2. 기일',
    `- 일시: ${hearingDateLabel(record.hearing)}`,
    record.hearing?.location ? `- 장소: ${record.hearing.location}` : undefined,
    record.hearing?.note ? `- 기일: ${record.hearing.note}` : undefined,
    '',
    '## 3. 당일 요청사항',
    requests,
    '',
    '## 4. 진행 메모',
    entries,
    '',
    '## 5. 결과',
    record.result.status ? `- 결과: ${record.result.status}` : '- 결과: 미입력',
    record.result.nextDate ? `- 다음 일정: ${record.result.nextDate}` : undefined,
    record.result.courtOrder ? `- 재판부 지시: ${record.result.courtOrder}` : undefined,
    record.result.opponentSubmission
      ? `- 상대방 제출/주장: ${record.result.opponentSubmission}`
      : undefined,
    '',
    '## 6. 후속 조치',
    nextActions,
    ''
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

export default function HearingRecordPanel({
  draftsDir,
  initialCase,
  initialHearing,
  initialPath,
  visible = true,
  onSavedPath,
  onOpenReport,
  onSummarizeReport
}: HearingRecordPanelProps): JSX.Element {
  const [record, setRecord] = useState<HearingRecordData>(() =>
    createInitialRecord(initialCase, initialHearing)
  )
  const [recordPath, setRecordPath] = useState(initialPath)
  const [draft, setDraft] = useState('')
  const [requestDraft, setRequestDraft] = useState('')
  const [speakerFormOpen, setSpeakerFormOpen] = useState(false)
  const [speakerLabelDraft, setSpeakerLabelDraft] = useState('')
  const [speakerFormMessage, setSpeakerFormMessage] = useState('')
  const [readerOpen, setReaderOpen] = useState(false)
  const [savedRecords, setSavedRecords] = useState<SavedRecordSummary[] | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState('')
  const [jsStatus, setJsStatus] = useState<JsSyncStatus>('idle')
  const [jsMessage, setJsMessage] = useState('')
  const loadStateRef = useRef<LoadState>(initialPath ? 'loading' : 'idle')
  const [loadState, setLoadState] = useState<LoadState>(loadStateRef.current)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<number | null>(null)
  const loadedPathRef = useRef<string | undefined>(undefined)
  const latestRecordRef = useRef(record)
  const hasContentRef = useRef(false)
  const lastSavedSourceStampRef = useRef('')
  // onSavedPath는 부모가 인라인으로 넘겨 렌더마다 바뀌므로 ref로 받아
  // saveRecord/flushAutoSave의 useCallback 재생성(→ 렌더마다 저장 루프)을 막는다.
  const onSavedPathRef = useRef(onSavedPath)
  onSavedPathRef.current = onSavedPath

  const updateLoadState = useCallback((state: LoadState): void => {
    loadStateRef.current = state
    setLoadState(state)
  }, [])

  const speakers = record.speakers
  const activeSpeaker =
    speakers.find((speaker) => speaker.id === record.activeSpeakerId) ?? speakers[0]
  const recordTitle = buildHearingRecordTitle(record.case, record.hearing)
  const subtitle = caseSubtitle(record.case, record.hearing)
  const hasContent =
    record.entries.length > 0 ||
    record.requests.length > 0 ||
    !!record.result.status ||
    !!record.result.courtOrder ||
    !!record.result.opponentSubmission ||
    !!record.result.nextDate ||
    !!record.result.nextActions?.length

  useEffect(() => {
    latestRecordRef.current = record
  }, [record])

  useEffect(() => {
    hasContentRef.current = hasContent
  }, [hasContent])

  const focusInput = useCallback((): void => {
    if (!visible) return
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [visible])

  const touch = useCallback((updater: (current: HearingRecordData) => HearingRecordData): void => {
    setRecord((current) => ({ ...updater(current), updatedAt: new Date().toISOString() }))
  }, [])

  const ensureRecordDir = useCallback(async (): Promise<string> => {
    if (!draftsDir) throw new Error('사건 폴더가 없어 저장할 수 없습니다.')
    const dir = buildHearingRecordDir(draftsDir)
    const stat = await window.lt.fs.stat(dir).catch(() => ({ ok: false as const, error: 'stat failed' }))
    if (stat.ok && stat.isDir) return dir
    const made = await window.lt.fs.mkdir(draftsDir, '.hearings')
    if (made.ok && made.path) return made.path
    const retry = await window.lt.fs.stat(dir).catch(() => ({ ok: false as const, error: 'stat failed' }))
    if (retry.ok && retry.isDir) return dir
    throw new Error(made.error || '기일 기록 폴더를 만들 수 없습니다.')
  }, [draftsDir])

  const saveRecord = useCallback(
    async (targetRecord = latestRecordRef.current): Promise<string> => {
      setSaveStatus('saving')
      setSaveMessage('자동저장 중')
      try {
        if (loadStateRef.current !== 'idle') {
          throw new Error(
            loadStateRef.current === 'loading'
              ? '기록을 불러오는 중입니다. 잠시 후 다시 시도하세요.'
              : "기록을 불러오지 못해 저장을 차단했습니다. '다시 불러오기' 또는 '새 기록'을 사용하세요."
          )
        }
        let nextPath = recordPath
        if (!nextPath) {
          await ensureRecordDir()
          nextPath = buildHearingRecordPath(draftsDir as string, targetRecord.case, targetRecord.hearing)
        } else if (draftsDir) {
          await ensureRecordDir()
        }
        const payload: HearingRecordData = {
          ...targetRecord,
          updatedAt: new Date().toISOString()
        }
        const result = await window.lt.fs.writeText(nextPath, JSON.stringify(payload, null, 2))
        if (!result.ok) throw new Error(result.error || '저장 실패')
        lastSavedSourceStampRef.current = targetRecord.updatedAt
        setRecordPath(nextPath)
        setSaveStatus('saved')
        setSaveMessage('자동저장됨')
        setLastSavedAt(new Date().toISOString())
        onSavedPathRef.current?.(nextPath, buildHearingRecordTitle(payload.case, payload.hearing))
        return nextPath
      } catch (error) {
        setSaveStatus('error')
        setSaveMessage(error instanceof Error ? error.message : String(error))
        throw error
      }
    },
    [draftsDir, ensureRecordDir, recordPath]
  )

  const loadFromPath = useCallback(
    async (path: string): Promise<void> => {
      updateLoadState('loading')
      const stat = await window.lt.fs
        .stat(path)
        .catch(() => ({ ok: false as const, error: 'stat failed' }))
      if (!stat.ok) {
        // 파일이 아직 없다 → 새 기록으로 시작
        loadedPathRef.current = path
        lastSavedSourceStampRef.current = ''
        setRecord(createInitialRecord(initialCase, initialHearing))
        setRecordPath(path)
        updateLoadState('idle')
        setSaveStatus('idle')
        setSaveMessage('새 기록 · 입력하면 자동저장')
        return
      }
      try {
        const read = await window.lt.fs.readText(path)
        const parsed = JSON.parse(read.text) as unknown
        const next = sanitizeRecord(parsed, initialCase, initialHearing)
        lastSavedSourceStampRef.current = next.updatedAt
        setRecord(next)
        setRecordPath(path)
        loadedPathRef.current = path
        updateLoadState('idle')
        setSaveStatus('saved')
        setSaveMessage('불러옴')
        setLastSavedAt(next.updatedAt)
        onSavedPathRef.current?.(path, buildHearingRecordTitle(next.case, next.hearing))
      } catch (error) {
        // 파일은 있는데 읽기/파싱에 실패 — 빈 기록으로 덮어쓰지 않도록 저장을 막는다.
        loadedPathRef.current = path
        setRecordPath(path)
        updateLoadState('error')
        setSaveStatus('error')
        setSaveMessage(
          `기록을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    [initialCase, initialHearing, updateLoadState]
  )

  useEffect(() => {
    if (!initialPath || loadedPathRef.current === initialPath) return
    void loadFromPath(initialPath)
  }, [initialPath, loadFromPath])

  useEffect(() => {
    if (initialPath || loadedPathRef.current) return
    setRecord(createInitialRecord(initialCase, initialHearing))
    setRecordPath(undefined)
  }, [initialCase, initialHearing, initialPath])

  useEffect(() => {
    if (visible) focusInput()
  }, [focusInput, visible])

  useEffect(() => {
    if (loadState !== 'idle') return
    if (!hasContent || (!draftsDir && !recordPath)) return
    if (lastSavedSourceStampRef.current === record.updatedAt) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    setSaveStatus('idle')
    setSaveMessage('자동저장 대기')
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void saveRecord(latestRecordRef.current).catch(() => {})
    }, 900)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [draftsDir, hasContent, loadState, record, recordPath, saveRecord])

  const flushAutoSave = useCallback((): void => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (loadStateRef.current !== 'idle') return
    if (!hasContentRef.current || (!draftsDir && !recordPath)) return
    // 변경 없으면 다시 쓰지 않는다 (렌더마다 flush가 호출되어도 무해하도록)
    if (lastSavedSourceStampRef.current === latestRecordRef.current.updatedAt) return
    void saveRecord(latestRecordRef.current).catch(() => {})
  }, [draftsDir, recordPath, saveRecord])

  useEffect(() => {
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') flushAutoSave()
    }
    window.addEventListener('beforeunload', flushAutoSave)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('beforeunload', flushAutoSave)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      flushAutoSave()
    }
  }, [flushAutoSave])

  // 이어서 열린 이전 기록 대신 오늘 날짜의 새 기록을 시작한다.
  // 같은 날짜의 기록이 이미 있으면 덮어쓰지 않도록 -2, -3… 순번을 붙인다.
  const startNewRecord = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const next = createInitialRecord(initialCase, initialHearing)
    let nextPath: string | undefined
    if (draftsDir) {
      const dir = buildHearingRecordDir(draftsDir)
      const date = ymd(dateFromHearing(next.hearing))
      const caseNo = safeFilePart(next.case.caseNumber || next.case.title)
      nextPath = pathJoin(dir, `${date}_${caseNo}.hearing.json`)
      for (let seq = 2; seq <= 99; seq += 1) {
        const stat = await window.lt.fs
          .stat(nextPath)
          .catch(() => ({ ok: false as const, error: 'stat failed' }))
        if (!stat.ok) break
        nextPath = pathJoin(dir, `${date}-${seq}_${caseNo}.hearing.json`)
      }
    }
    lastSavedSourceStampRef.current = ''
    if (nextPath) loadedPathRef.current = nextPath
    setRecord(next)
    setRecordPath(nextPath)
    updateLoadState('idle')
    setSaveStatus('idle')
    setSaveMessage('새 기록 · 입력하면 자동저장')
    setLastSavedAt('')
    setJsStatus('idle')
    setJsMessage('')
    if (nextPath) {
      onSavedPathRef.current?.(nextPath, buildHearingRecordTitle(next.case, next.hearing))
    }
    focusInput()
  }, [draftsDir, focusInput, initialCase, initialHearing, updateLoadState])

  const setActiveSpeaker = (speakerId: string): void => {
    touch((current) => ({ ...current, activeSpeakerId: speakerId }))
    focusInput()
  }

  const cycleSpeaker = (direction: 1 | -1): void => {
    if (speakers.length === 0) return
    const currentIndex = Math.max(0, speakers.findIndex((speaker) => speaker.id === record.activeSpeakerId))
    const nextIndex = (currentIndex + direction + speakers.length) % speakers.length
    setActiveSpeaker(speakers[nextIndex].id)
  }

  const speakerByShortcut = (shortcut: string): HearingSpeaker | undefined =>
    speakers.find((speaker) => speaker.shortcut === shortcut)

  const applyTemplate = (template: HearingRecordTemplate): void => {
    const presetSpeakers = resolveSpeakerPreset(template.speakers)
    touch((current) => {
      return {
        ...current,
        speakers: presetSpeakers,
        activeSpeakerId: presetSpeakers[0]?.id ?? ''
      }
    })
    setSpeakerFormOpen(presetSpeakers.length === 0)
    setSpeakerFormMessage('')
    setSaveMessage(`${template.label} 템플릿 추가됨`)
    focusInput()
  }

  const addCustomSpeaker = (): void => {
    const label = speakerLabelDraft.trim()
    if (!label) {
      setSpeakerFormMessage('대화자명을 입력하세요.')
      return
    }
    const speaker: HearingSpeaker = { id: newId('speaker'), label, role: 'other' }
    touch((current) => ({
      ...current,
      speakers: withSequentialShortcuts([...current.speakers, speaker]),
      activeSpeakerId: speaker.id
    }))
    setSpeakerLabelDraft('')
    setSpeakerFormMessage('')
    focusInput()
  }

  const moveSpeaker = (speakerId: string, direction: 1 | -1): void => {
    touch((current) => {
      const index = current.speakers.findIndex((speaker) => speaker.id === speakerId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= current.speakers.length) return current
      const speakers = [...current.speakers]
      const currentSpeaker = speakers[index]
      speakers[index] = speakers[nextIndex]
      speakers[nextIndex] = currentSpeaker
      return { ...current, speakers: withSequentialShortcuts(speakers) }
    })
    focusInput()
  }

  const removeSpeaker = (speakerId: string): void => {
    touch((current) => {
      const index = current.speakers.findIndex((speaker) => speaker.id === speakerId)
      if (index < 0) return current
      const speakers = withSequentialShortcuts(current.speakers.filter((speaker) => speaker.id !== speakerId))
      const hasActiveSpeaker = speakers.some((speaker) => speaker.id === current.activeSpeakerId)
      const activeSpeakerId =
        current.activeSpeakerId === speakerId || !hasActiveSpeaker
          ? speakers[index]?.id ?? speakers[index - 1]?.id ?? speakers[0]?.id ?? ''
          : current.activeSpeakerId
      return { ...current, speakers, activeSpeakerId }
    })
    focusInput()
  }

  const addRequest = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    touch((current) => ({
      ...current,
      requests: [
        ...current.requests,
        { id: newId('request'), text: trimmed, spoken: false }
      ]
    }))
    setRequestDraft('')
    focusInput()
  }

  const updateRequest = (id: string, patch: Partial<HearingRequest>): void => {
    touch((current) => ({
      ...current,
      requests: current.requests.map((request) =>
        request.id === id ? { ...request, ...patch } : request
      )
    }))
  }

  const toggleRequestSpoken = (id: string): void => {
    const request = record.requests.find((item) => item.id === id)
    if (!request) return
    updateRequest(id, {
      spoken: !request.spoken,
      spokenAt: request.spoken ? undefined : new Date().toISOString()
    })
    focusInput()
  }

  const markNextRequestSpoken = (): void => {
    const next = record.requests.find((request) => !request.spoken)
    if (next) toggleRequestSpoken(next.id)
  }

  const setResultPatch = (patch: Partial<HearingResult>): void => {
    touch((current) => ({ ...current, result: { ...current.result, ...patch } }))
  }

  const addNextAction = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    touch((current) => ({
      ...current,
      result: {
        ...current.result,
        nextActions: [...(current.result.nextActions ?? []), trimmed]
      }
    }))
  }

  const removeNextAction = (index: number): void => {
    touch((current) => ({
      ...current,
      result: {
        ...current.result,
        nextActions: (current.result.nextActions ?? []).filter((_, i) => i !== index)
      }
    }))
  }

  const submitDraft = (): void => {
    const raw = draft.trim()
    if (!raw) return
    const escaped = raw.startsWith('\\')
    const body = escaped ? raw.slice(1).trimStart() : raw
    const requestCommand = escaped ? null : body.match(/^!\s*(.+)$/)
    if (requestCommand) {
      addRequest(requestCommand[1])
      setDraft('')
      return
    }
    const resultCommand = escaped ? null : body.match(/^#\s*(.+)$/)
    if (resultCommand) {
      setResultPatch({ status: resultCommand[1].trim() })
      setDraft('')
      focusInput()
      return
    }
    const todoCommand = escaped ? null : body.match(/^todo\s+(.+)$/i)
    if (todoCommand) {
      addNextAction(todoCommand[1])
      setDraft('')
      focusInput()
      return
    }

    const prefix = escaped ? null : body.match(/^([1-9])\s+([\s\S]+)$/)
    const prefixedSpeaker = prefix ? speakerByShortcut(prefix[1]) : undefined
    if (!prefixedSpeaker && !record.activeSpeakerId && speakers.length === 0) {
      setSpeakerFormOpen(true)
      setSpeakerFormMessage('대화자를 먼저 추가하세요.')
      return
    }
    const speakerId = prefixedSpeaker?.id ?? record.activeSpeakerId
    const text = (prefix && prefixedSpeaker ? prefix[2] : body).trim()
    if (!text) return
    const entry: HearingEntry = {
      id: newId('entry'),
      speakerId,
      text,
      createdAt: new Date().toISOString(),
      important: text.startsWith('*')
    }
    touch((current) => ({
      ...current,
      activeSpeakerId: speakerId,
      entries: [...current.entries, entry]
    }))
    setDraft('')
    focusInput()
  }

  const editLastEntry = (): void => {
    const last = record.entries[record.entries.length - 1]
    if (!last) return
    touch((current) => ({
      ...current,
      activeSpeakerId: last.speakerId,
      entries: current.entries.slice(0, -1)
    }))
    setDraft(last.text)
    focusInput()
  }

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeComposing(event)) return
    const currentDraft = event.currentTarget.value
    const shortcut = /^[1-9]$/.test(event.key) ? event.key : ''
    if ((event.ctrlKey || event.metaKey) && shortcut) {
      const speaker = speakerByShortcut(shortcut)
      if (speaker) {
        event.preventDefault()
        setActiveSpeaker(speaker.id)
      }
      return
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && shortcut && currentDraft.length === 0) {
      const speaker = speakerByShortcut(shortcut)
      if (speaker) {
        event.preventDefault()
        setActiveSpeaker(speaker.id)
      }
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      cycleSpeaker(event.shiftKey ? -1 : 1)
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      markNextRequestSpoken()
      return
    }
    if (event.key === 'ArrowUp' && currentDraft.length === 0) {
      event.preventDefault()
      editLastEntry()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitDraft()
    }
  }

  const loadSavedRecords = useCallback(async (): Promise<void> => {
    if (!draftsDir) {
      setSavedRecords([])
      return
    }
    try {
      const dir = buildHearingRecordDir(draftsDir)
      const stat = await window.lt.fs.stat(dir)
      if (!stat.ok || !stat.isDir) {
        setSavedRecords([])
        return
      }
      const entries = await window.lt.fs.list(dir)
      const records = await Promise.all(
        entries
          .filter((entry) => !entry.isDir && entry.name.endsWith('.hearing.json'))
          .map(async (entry): Promise<SavedRecordSummary | null> => {
            try {
              const read = await window.lt.fs.readText(entry.path)
              const data = sanitizeRecord(JSON.parse(read.text))
              return {
                path: entry.path,
                title: buildHearingRecordTitle(data.case, data.hearing),
                subtitle: caseSubtitle(data.case, data.hearing),
                updatedAt: data.updatedAt,
                synced: !!data.jsSync?.syncedAt,
                data
              }
            } catch {
              return null
            }
          })
      )
      setSavedRecords(
        records
          .filter((item): item is SavedRecordSummary => !!item)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      )
    } catch {
      setSavedRecords([])
    }
  }, [draftsDir])

  const toggleReader = (): void => {
    const next = !readerOpen
    setReaderOpen(next)
    if (next) void loadSavedRecords()
  }

  const writeReport = async (): Promise<{ path: string; title: string }> => {
    const path = await saveRecord()
    const reportPath = buildHearingReportPath(draftsDir, record, path)
    const result = await window.lt.fs.writeText(reportPath, buildReport(record))
    if (!result.ok) throw new Error(result.error || '보고서 저장 실패')
    return {
      path: reportPath,
      title: reportPath.split(/[\\/]/).pop() || '기일 결과 보고.md'
    }
  }

  const generateReport = async (): Promise<void> => {
    try {
      const report = await writeReport()
      onOpenReport?.(report.path, report.title)
      setSaveStatus('saved')
      setSaveMessage('보고서 생성됨')
    } catch (error) {
      setSaveStatus('error')
      setSaveMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const summarizeReport = async (): Promise<void> => {
    try {
      const report = await writeReport()
      onOpenReport?.(report.path, report.title)
      onSummarizeReport?.(report.path, report.title)
      setSaveStatus('saved')
      setSaveMessage('Claude에 정리 요청함')
    } catch (error) {
      setSaveStatus('error')
      setSaveMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const syncToJuriSupport = async (): Promise<void> => {
    setJsStatus('syncing')
    setJsMessage('JuriSupport 할일 생성 중')
    try {
      await saveRecord()
      const title = [
        '[기일기록]',
        ymd(dateFromHearing(record.hearing)),
        record.case.caseNumber,
        record.case.caseName
      ]
        .filter(Boolean)
        .join(' ')
      const result = await window.lt.todo.create({
        title,
        status: 'completed',
        caseId: record.case.jsId,
        court: record.case.court,
        caseNumber: record.case.caseNumber,
        caseName: record.case.caseName,
        client: record.case.client,
        opponent: record.case.opponent,
        partyNames: record.case.partyNames,
        notes: buildReport(record)
      })
      if (!result.ok) throw new Error(result.error || 'JuriSupport 반영 실패')
      const syncedAt = new Date().toISOString()
      touch((current) => ({
        ...current,
        jsSync: { syncedAt, todoId: result.todo?.id }
      }))
      setJsStatus('synced')
      setJsMessage(result.todo?.id ? `JuriSupport 할일 #${result.todo.id} 생성됨` : 'JuriSupport 할일로 반영됨')
    } catch (error) {
      setJsStatus('error')
      setJsMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const sortedEntries = useMemo(() => record.entries, [record.entries])
  const caseMemo = record.case.memo?.trim()

  return (
    <div className="hearing-panel">
      <div className="hearing-head">
        <div className="hearing-head-main">
          <div className="hearing-title">{recordTitle}</div>
          <div className="hearing-subtitle">{subtitle || '사건 정보를 불러오면 기일 메타가 표시됩니다.'}</div>
        </div>
        <div className="hearing-actions">
          <button
            className="hearing-small-btn"
            title="오늘 날짜로 새 기일 기록 시작"
            onClick={() => void startNewRecord()}
          >
            새 기록
          </button>
          <button className="hearing-small-btn" onClick={toggleReader}>
            읽기
          </button>
          <button className="hearing-small-btn" onClick={() => void saveRecord().catch(() => {})}>
            저장
          </button>
          <button className="hearing-primary-btn" onClick={() => void generateReport()}>
            보고서
          </button>
          <button
            className="hearing-small-btn"
            title="보고서를 저장한 뒤 Claude Agent에 정리 요청"
            onClick={() => void summarizeReport()}
          >
            Claude 정리
          </button>
          <button
            className="hearing-small-btn"
            title="보고서 내용을 JuriSupport 사건의 완료된 할일로 생성"
            onClick={() => void syncToJuriSupport()}
          >
            JS 반영
          </button>
        </div>
      </div>

      {(saveMessage || jsMessage || recordPath) && (
        <div className="hearing-status-row">
          <span className={`hearing-save-status st-${saveStatus}`}>{saveMessage || '대기'}</span>
          {loadState === 'error' && recordPath && (
            <button className="hearing-small-btn" onClick={() => void loadFromPath(recordPath)}>
              다시 불러오기
            </button>
          )}
          {lastSavedAt && <span>{formatTime(lastSavedAt)} 저장</span>}
          {recordPath && <span className="hearing-path">{recordPath}</span>}
          {jsMessage && <span className={`hearing-js-status st-${jsStatus}`}>{jsMessage}</span>}
        </div>
      )}

      {readerOpen && (
        <div className="hearing-reader">
          <div className="hearing-reader-head">
            <strong>저장된 기일 기록</strong>
            <button className="hearing-small-btn" onClick={() => void loadSavedRecords()}>
              새로고침
            </button>
          </div>
          {savedRecords === null ? (
            <p className="muted small">불러오는 중...</p>
          ) : savedRecords.length === 0 ? (
            <p className="muted small">저장된 기록이 없습니다.</p>
          ) : (
            <div className="hearing-reader-list">
              {savedRecords.map((item) => (
                <button
                  key={item.path}
                  className="hearing-reader-item"
                  onClick={() => {
                    loadedPathRef.current = item.path
                    lastSavedSourceStampRef.current = item.data.updatedAt
                    updateLoadState('idle')
                    setRecord(item.data)
                    setRecordPath(item.path)
                    setReaderOpen(false)
                    setSaveStatus('saved')
                    setSaveMessage('불러옴')
                    setLastSavedAt(item.data.updatedAt)
                    onSavedPath?.(item.path, item.title)
                    focusInput()
                  }}
                >
                  <span>{item.title}</span>
                  <small>
                    {item.subtitle || item.path}
                    {item.synced ? ' · JS 반영됨' : ''}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="hearing-body">
        {caseMemo && (
          <section className="hearing-section hearing-case-memo">
            <div className="hearing-section-head">
              <span>사건 메모</span>
            </div>
            <div className="hearing-case-memo-text">{caseMemo}</div>
          </section>
        )}

        <section className="hearing-section">
          <div className="hearing-section-head">
            <span>템플릿</span>
            <small>대상</small>
          </div>
          <div className="hearing-template-list">
            {RECORD_TEMPLATES.map((template) => (
              <button
                key={template.id}
                className="hearing-template-btn"
                onClick={() => applyTemplate(template)}
              >
                <span>{template.label}</span>
                <small>{template.hint}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="hearing-section">
          <div className="hearing-section-head">
            <span>오늘 요청할 사항</span>
            <small>Ctrl+Enter: 다음 항목 말함</small>
          </div>
          <div className="hearing-request-add">
            <input
              value={requestDraft}
              onChange={(event) => setRequestDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isCommittedEnter(event)) {
                  event.preventDefault()
                  addRequest(requestDraft)
                }
              }}
              placeholder="요청사항 입력"
            />
            <button className="hearing-small-btn" onClick={() => addRequest(requestDraft)}>
              추가
            </button>
          </div>
          {record.requests.length === 0 ? (
            <p className="muted small hearing-empty-line">요청사항을 추가하거나 입력창에서 ! 요청사항을 입력하세요.</p>
          ) : (
            <div className="hearing-request-list">
              {record.requests.map((request) => (
                <div key={request.id} className={`hearing-request ${request.spoken ? 'done' : ''}`}>
                  <button className="hearing-check" onClick={() => toggleRequestSpoken(request.id)}>
                    {request.spoken ? '✓' : ''}
                  </button>
                  <input
                    value={request.text}
                    onChange={(event) => updateRequest(request.id, { text: event.target.value })}
                  />
                  <input
                    value={request.result ?? ''}
                    onChange={(event) => updateRequest(request.id, { result: event.target.value })}
                    placeholder="결과"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="hearing-section hearing-log-section">
          <div className="hearing-section-head">
            <span>진행 메모</span>
            <small>Enter 저장 · Tab 화자 전환 · ↑ 직전 수정</small>
          </div>
          <div className="hearing-log">
            {sortedEntries.length === 0 ? (
              <p className="muted small hearing-empty-line">화자 버튼 또는 숫자키를 누르고 바로 입력하세요.</p>
            ) : (
              sortedEntries.map((entry) => {
                const speaker = speakers.find((item) => item.id === entry.speakerId)
                return (
                  <div key={entry.id} className={`hearing-message ${roleClass(speaker?.role)}`}>
                    <div className="hearing-message-meta">
                      <span>{formatTime(entry.createdAt)}</span>
                      <strong>{speaker?.label ?? '사전준비'}</strong>
                    </div>
                    <div className="hearing-message-bubble">{entry.text}</div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="hearing-section">
          <div className="hearing-section-head">
            <span>결과</span>
          </div>
          <div className="hearing-result-grid">
            <div className="hearing-result-options">
              {RESULT_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={`hearing-result-chip ${record.result.status === option ? 'on' : ''}`}
                  onClick={() => setResultPatch({ status: option })}
                >
                  {option}
                </button>
              ))}
            </div>
            <input
              value={record.result.nextDate ?? ''}
              onChange={(event) => setResultPatch({ nextDate: event.target.value })}
              placeholder="다음 일정"
            />
            <textarea
              value={record.result.courtOrder ?? ''}
              onChange={(event) => setResultPatch({ courtOrder: event.target.value })}
              placeholder="재판부 지시"
            />
            <textarea
              value={record.result.opponentSubmission ?? ''}
              onChange={(event) => setResultPatch({ opponentSubmission: event.target.value })}
              placeholder="상대방 제출/주장"
            />
            <div className="hearing-next-actions">
              {(record.result.nextActions ?? []).map((action, index) => (
                <span key={`${action}-${index}`} className="hearing-next-action">
                  {action}
                  <button onClick={() => removeNextAction(index)}>×</button>
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="hearing-composer">
        <div className="hearing-speaker-pick">
          <label className={`hearing-current-speaker ${roleClass(activeSpeaker?.role)}`}>
            <span className="sr-only">화자</span>
            <select
              value={record.activeSpeakerId}
              title="화자 선택"
              disabled={speakers.length === 0}
              onChange={(event) => setActiveSpeaker(event.target.value)}
            >
              {speakers.length === 0 ? (
                <option value="">대화자 없음</option>
              ) : (
                speakers.map((speaker) => (
                  <option key={speaker.id} value={speaker.id}>
                    {speaker.shortcut ? `${speaker.shortcut}. ` : ''}
                    {speaker.label}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            className="hearing-small-btn"
            title="대화자 추가"
            onClick={() => {
              setSpeakerFormOpen((open) => !open)
              setSpeakerFormMessage('')
            }}
          >
            추가
          </button>
        </div>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          placeholder="메모 입력 · 숫자만 누르면 화자 전환 · \\1 처럼 시작하면 숫자도 그대로 입력"
        />
        <button className="hearing-primary-btn" onClick={submitDraft}>
          입력
        </button>
        {speakerFormOpen && (
          <div className="hearing-speaker-form">
            <input
              value={speakerLabelDraft}
              onChange={(event) => setSpeakerLabelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isCommittedEnter(event)) {
                  event.preventDefault()
                  addCustomSpeaker()
                }
              }}
              placeholder="대화자명"
            />
            <button className="hearing-primary-btn" onClick={addCustomSpeaker}>
              추가
            </button>
            {speakerFormMessage && <small>{speakerFormMessage}</small>}
            {speakers.length > 0 && (
              <div className="hearing-speaker-list">
                {speakers.map((speaker, index) => (
                  <div key={speaker.id} className="hearing-speaker-row">
                    <span>
                      {speaker.shortcut ? `${speaker.shortcut}. ` : ''}
                      {speaker.label}
                    </span>
                    <button disabled={index === 0} onClick={() => moveSpeaker(speaker.id, -1)}>
                      ↑
                    </button>
                    <button
                      disabled={index === speakers.length - 1}
                      onClick={() => moveSpeaker(speaker.id, 1)}
                    >
                      ↓
                    </button>
                    <button onClick={() => removeSpeaker(speaker.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
