import { useEffect, useRef, useState, type ReactNode } from 'react'
import Terminal from './terminal/Terminal'
import FileTree, { LT_PATH, sortEntries, type SortMode } from './filetree/FileTree'
import PdfViewer from './viewer/PdfViewer'
import RecordViewer from './viewer/RecordViewer'
import { parseRecordFiles, type ParsedRecord, type OutlineItem } from './viewer/recordOutline'
import {
  IconExplorer,
  IconCases,
  IconViewer,
  IconSettings,
  IconNewFile,
  IconNewFolder,
  IconSync,
  IconWorkspace,
  IconSearch,
  IconSave
} from './icons/Icons'
import MarkdownEditor, { type MarkdownDocumentPayload } from './editor/MarkdownEditor'
import FindBar from './search/FindBar'
import CasesDashboard from './dashboard/CasesDashboard'
import UpcomingHearings from './dashboard/UpcomingHearings'
import type {
  AppSettings,
  JsCase,
  SshConn,
  SshProfile,
  RemoteEntry,
  TabPayload,
  WorkspaceDocTabPayload,
  WorkspaceEntry,
  WorkspaceLoadResult,
  WorkspaceSnapshot
} from './env'

type Mode = 'explorer' | 'cases' | 'viewer'
type DockSide = 'left' | 'right'

interface ActivityItem {
  id: Mode
  label: string
  Icon: (props: { size?: number }) => JSX.Element
}
const ACTIVITY: ActivityItem[] = [
  { id: 'explorer', label: '탐색기', Icon: IconExplorer },
  { id: 'cases', label: '사건', Icon: IconCases },
  { id: 'viewer', label: '기록뷰어', Icon: IconViewer }
]

const SORT_OPTIONS: { value: SortMode; label: string; title: string }[] = [
  { value: 'name-asc', label: '가나다↑', title: '가나다순' },
  { value: 'name-desc', label: '가나다↓', title: '가나다 역순' },
  { value: 'mtime-desc', label: '수정↓', title: '최근 수정순' },
  { value: 'mtime-asc', label: '수정↑', title: '오래된 수정순' }
]

const CASE_OPEN_LOCAL = 'local'
const CASE_OPEN_REMOTE_PREFIX = 'remote:'
const SETTINGS_UPDATED_EVENT = 'lt:settings-updated'
const DEFAULT_TERM_FONT_SIZE = 13
const DEFAULT_MD_FONT_SIZE = 14
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"
const DEFAULT_NOTIFICATION_SOUND: NotificationSound = 'chime'
const DEFAULT_NOTIFICATION_VOLUME = 85

const MD_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '기본값 (D2Coding 고정폭)', value: '' },
  { label: '맑은 고딕 / Segoe UI', value: "'Malgun Gothic', 'Segoe UI', system-ui, sans-serif" },
  {
    label: 'Apple SD Gothic Neo',
    value: "'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif"
  },
  {
    label: 'Noto Sans KR',
    value: "'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif"
  },
  { label: '나눔고딕', value: "'Nanum Gothic', 'Malgun Gothic', system-ui, sans-serif" },
  { label: 'Cascadia Mono / Consolas', value: "'Cascadia Mono', Consolas, 'D2Coding', monospace" }
]

type NotificationSound = 'chime' | 'ding' | 'success' | 'bell' | 'none'

const NOTIFICATION_SOUND_OPTIONS: { label: string; value: NotificationSound }[] = [
  { label: '기본 차임', value: 'chime' },
  { label: '맑은 딩', value: 'ding' },
  { label: '완료 상승음', value: 'success' },
  { label: '강한 벨', value: 'bell' },
  { label: '소리 끔', value: 'none' }
]

interface NotificationTone {
  frequency: number
  start: number
  duration: number
  type?: OscillatorType
  gain?: number
}

const NOTIFICATION_TONES: Record<Exclude<NotificationSound, 'none'>, NotificationTone[]> = {
  chime: [
    { frequency: 880, start: 0, duration: 0.13, gain: 0.18 },
    { frequency: 1320, start: 0.12, duration: 0.17, gain: 0.16 }
  ],
  ding: [{ frequency: 1046.5, start: 0, duration: 0.24, gain: 0.19 }],
  success: [
    { frequency: 659.25, start: 0, duration: 0.11, gain: 0.16 },
    { frequency: 880, start: 0.1, duration: 0.12, gain: 0.17 },
    { frequency: 1174.66, start: 0.21, duration: 0.18, gain: 0.16 }
  ],
  bell: [
    { frequency: 740, start: 0, duration: 0.18, type: 'triangle', gain: 0.23 },
    { frequency: 1480, start: 0.02, duration: 0.14, type: 'sine', gain: 0.11 }
  ]
}

const normalizePasteForPty = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r')

const remoteCaseOpenTarget = (profileId: string): string => `${CASE_OPEN_REMOTE_PREFIX}${profileId}`
const caseOpenProfileId = (target?: string): string | undefined =>
  target?.startsWith(CASE_OPEN_REMOTE_PREFIX) ? target.slice(CASE_OPEN_REMOTE_PREFIX.length) : undefined
const resolveCaseOpenTarget = (target: string | undefined, profiles: SshProfile[]): string => {
  const profileId = caseOpenProfileId(target)
  return profileId && profiles.some((p) => p.id === profileId)
    ? remoteCaseOpenTarget(profileId)
    : CASE_OPEN_LOCAL
}
const clampFontSize = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed))
}
const resolveNotificationSound = (value?: string): NotificationSound =>
  NOTIFICATION_SOUND_OPTIONS.some((option) => option.value === value)
    ? (value as NotificationSound)
    : DEFAULT_NOTIFICATION_SOUND
const clampNotificationVolume = (
  value: string | number | undefined,
  fallback = DEFAULT_NOTIFICATION_VOLUME
): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '')
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(100, Math.max(0, Math.round(parsed)))
}
const emitSettingsUpdated = (settings: AppSettings): void => {
  window.dispatchEvent(new CustomEvent<AppSettings>(SETTINGS_UPDATED_EVENT, { detail: settings }))
}

const sshConnFromProfile = (profile: SshProfile): SshConn => ({
  host: profile.host,
  user: profile.user,
  port: profile.port,
  identityFile: profile.identityFile
})

interface DocTab {
  id: string
  title: string
  kind: 'welcome' | 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'csv' | 'settings'
  path?: string
  side?: DockSide
}
/**
 * 터미널 1개 = 사건 1개.
 * cwd = 작성서류 폴더(claude 작업·탐색기 기준). recordsFolder = 소송기록 폴더(뷰어 기준, 별도 지정).
 */
interface TermTab {
  id: string
  title: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string // 페어링으로 추천된 소송기록 폴더 (사용자가 '열기' 눌러야 적용)
  autoClaude?: boolean // 사건 열기 = claude 자동 실행, + 새 터미널 = 빈 셸
  // JuriSupport 사건에서 연 세션의 메타 (자동 명명·사건별 필터용)
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  sessionTitle?: string // claude 세션 제목(ai-title) — transcript에서 자동 반영
  renamed?: boolean // 사용자가 직접 이름 변경 → 자동 반영 중단
  createdAt?: number // 세션 시작 시각 — 이 이후의 transcript만 현재 세션으로 매칭
  resumeSessionId?: string // 과거 세션 이어서 열기
  ssh?: SshConn // 주어지면 원격(SSH) 사건 — cwd는 원격 경로, claude도 원격에서 실행
  sshLabel?: string // 접속 프로필 이름 (탭 툴팁/표시용)
  profileId?: string // 원격 파일 패널 라우팅용 (ssh://<profileId>/<경로>)
  side?: DockSide
}

type WorkTabKind = 'doc' | 'terminal'
type WorkTabKey = `${WorkTabKind}:${string}`

const docSide = (tab?: DocTab): DockSide => tab?.side ?? 'left'
const termSide = (tab?: TermTab): DockSide => tab?.side ?? 'right'
const otherSide = (side: DockSide): DockSide => (side === 'left' ? 'right' : 'left')
const docKey = (id: string): WorkTabKey => `doc:${id}`
const termKeyOf = (id: string): WorkTabKey => `terminal:${id}`
const parseWorkKey = (key: string): { kind: WorkTabKind; id: string } | null => {
  const split = key.indexOf(':')
  if (split < 0) return null
  const kind = key.slice(0, split)
  if (kind !== 'doc' && kind !== 'terminal') return null
  return { kind, id: key.slice(split + 1) }
}

// 원격 파일 패널이 쓰는 ssh:// URI 빌더 (main의 remoteFs와 동일 스킴)
const remoteUri = (profileId: string, p: string): string =>
  'ssh://' + profileId + (p.startsWith('/') ? p : '/' + p)

const isRemotePath = (p?: string): p is string => !!p && p.startsWith('ssh://')
const parseRemoteUri = (uri: string): { profileId: string; path: string } | null => {
  if (!isRemotePath(uri)) return null
  const rest = uri.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { profileId: rest, path: '/' }
  return { profileId: rest.slice(0, slash), path: rest.slice(slash) }
}

function useRemoteFileVersion(path?: string, intervalMs = 2500): number {
  const [version, setVersion] = useState(0)
  const sigRef = useRef('')

  useEffect(() => {
    if (!isRemotePath(path)) return
    let alive = true
    const tick = (): void => {
      window.lt.fs
        .stat(path)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = `${s.size}:${s.mtimeMs ?? 0}`
          if (sigRef.current && sig !== sigRef.current) setVersion((v) => v + 1)
          sigRef.current = sig
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path, intervalMs])

  return version
}
interface CaseMeta {
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
}
interface CurrentCase {
  drafts: string
  records?: string
  name: string
  meta?: CaseMeta
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
  remotePath?: string
}

const WORKSPACE_VERSION = 1
const RESTORABLE_DOC_KINDS = new Set<DocTab['kind']>([
  'markdown',
  'mdview',
  'file',
  'pdf',
  'image',
  'hwp',
  'csv',
  'settings'
])

const isWorkspaceMode = (value: unknown): value is Mode =>
  value === 'explorer' || value === 'cases' || value === 'viewer'

const isWorkKey = (value: unknown): value is WorkTabKey =>
  typeof value === 'string' && parseWorkKey(value) !== null

const formatWorkspaceSavedAt = (savedAt: string): string => {
  const date = new Date(savedAt)
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString('ko-KR')
}

const describeWorkspaceEntry = (entry: WorkspaceEntry, index: number): string =>
  `${index + 1}. ${entry.label} · ${formatWorkspaceSavedAt(entry.savedAt)} · 문서 ${entry.docs}개 / 터미널 ${entry.terminals}개`

const toWorkspaceDoc = (tab: DocTab): WorkspaceDocTabPayload | null => {
  if (!RESTORABLE_DOC_KINDS.has(tab.kind)) return null
  if (tab.kind !== 'settings' && !tab.path) return null
  return {
    id: tab.id,
    title: tab.title,
    kind: tab.kind as WorkspaceDocTabPayload['kind'],
    path: tab.path,
    side: docSide(tab)
  }
}

const toDocTab = (tab: WorkspaceDocTabPayload): DocTab | null => {
  if (!RESTORABLE_DOC_KINDS.has(tab.kind)) return null
  if (tab.kind !== 'settings' && !tab.path) return null
  return {
    id: tab.id || `file-${++docSeq}`,
    title: tab.title || tab.path?.split(/[\\/]/).pop() || '문서',
    kind: tab.kind,
    path: tab.path,
    side: tab.side ?? 'left'
  }
}

const sanitizeCurrentCase = (value: unknown): CurrentCase | null => {
  if (!value || typeof value !== 'object') return null
  const c = value as Partial<CurrentCase>
  if (typeof c.drafts !== 'string' || typeof c.name !== 'string') return null
  return {
    drafts: c.drafts,
    records: typeof c.records === 'string' ? c.records : undefined,
    name: c.name,
    meta: c.meta,
    ssh: c.ssh,
    sshLabel: typeof c.sshLabel === 'string' ? c.sshLabel : undefined,
    profileId: typeof c.profileId === 'string' ? c.profileId : undefined,
    remotePath: typeof c.remotePath === 'string' ? c.remotePath : undefined
  }
}

interface JuriSupportLegalPromptContext {
  caseId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
}

function buildJuriSupportLegalDocumentPrompt(
  doc: MarkdownDocumentPayload,
  context: JuriSupportLegalPromptContext
): string {
  const title = doc.title.replace(/\.[^.]+$/, '') || '문서'
  const caseLines = [
    context.caseId && `- caseId: ${context.caseId}`,
    context.court && `- 법원: ${context.court}`,
    context.caseNumber && `- 사건번호: ${context.caseNumber}`,
    context.caseName && `- 사건명: ${context.caseName}`,
    context.client && `- 의뢰인/당사자: ${context.client}`
  ].filter(Boolean)
  const caseBlock = caseLines.length
    ? caseLines.join('\n')
    : '- 현재 앱에서 연결된 JuriSupport 사건 ID를 확인하지 못했습니다. 먼저 list_cases 등으로 대상 사건을 확인하세요.'

  return `아래 Markdown 원본을 JuriSupport 소송문서(legal_document)로 정리해 주세요.

목표:
- Markdown은 사람이 읽고 편집하기 위한 원본입니다. 사용자에게 별도 변환용 문법을 요구하지 마세요.
- 원본 의미를 보존하되, JuriSupport MCP/API 규칙에 맞는 legal_document content, evidenceList, attachments로 분리하세요.
- 대상이 명확하면 create_legal_document 또는 update_legal_document/autosave_legal_document MCP 도구를 호출하세요.
- 기존 문서 ID가 필요하지만 원본/대화에서 특정되지 않으면 임의로 고르지 말고 먼저 짧게 확인하세요.

사건 컨텍스트:
${caseBlock}

문서 원본:
- 파일명: ${doc.title}
${doc.path ? `- 경로: ${doc.path}` : '- 경로: 미저장 문서'}
- 기본 제목 후보: ${title}

JuriSupport legal_document 작성 규칙:
- documentType은 원본에서 판단하세요. 가능한 값: complaint, accusation, brief, answer, appeal, supremeAppeal, correction, cause, modifiedCause, applicationReason, other.
- content에는 순수 본문만 넣으세요.
- content에 문서 제목, 사건번호, 법원, 당사자 표시, 대리인 표시, 입증방법/증거방법 목록, 첨부서류 목록, 날짜, 서명란, 법원 귀중을 중복으로 넣지 마세요.
- 원본의 번호 붙은 제목은 JuriSupport 에디터 개요 규칙에 맞게 h1/h2/h3 구조로 정리하고, 자동 번호와 중복될 수 있는 번호 텍스트는 제거하세요.
- 소송서류 본문은 공손한 서면체로 유지하세요.

서증 처리:
- 본문 안의 "갑 제1호증", "을 제2호증의1" 같은 raw 호증 문구는 content에 그대로 두지 말고 data-evidence-exhibit span으로 변환하세요.
- 새 서증 span 예: <span data-evidence-exhibit="true" data-side="갑" data-description="매매계약서" contenteditable="false"></span>
- 재인용 서증 span 예: <span data-evidence-exhibit="true" data-side="갑" data-is-reference="true" data-reference-main-number="1" data-description="매매계약서" contenteditable="false"></span>
- 새 서증의 evidenceList 항목은 mainNumber를 null로 두고, 본문 등장 순서와 evidenceList 순서를 맞추세요.
- 재인용은 isReference=true, referenceMainNumber를 사용하세요.
- 원본의 입증방법/증거방법 목록과 본문 인용이 불일치하면 MCP 도구를 호출하지 말고 불일치 항목을 질문하세요.

첨부서류 처리:
- 본문 안의 첨부서류 인용은 data-attachment-exhibit span으로 변환하세요.
- 새 첨부 span 예: <span data-attachment-exhibit="true" data-name="위임장" data-description="위임장" data-sub-description="2026. 4. 17.자" data-quantity="1통" contenteditable="false"></span>
- 재인용 첨부 span 예: <span data-attachment-exhibit="true" data-name="위임장" data-description="위임장" data-quantity="1통" data-is-reference="true" data-reference-attachment-number="1" contenteditable="false"></span>
- 새 첨부의 attachments 항목은 attachmentNumber를 null 또는 생략하고, 재인용 첨부는 includeInAttachmentList=false로 중복 목록 생성을 피하세요.
- 원본의 첨부서류 목록은 attachments로 분리하고 content에 목록을 중복 출력하지 마세요.

진행 방식:
- 애매한 서증/첨부/문서유형/대상 문서 ID가 있으면 먼저 확인 질문만 하세요.
- 애매하지 않으면 변환 요약을 한 번 보여준 뒤 MCP 도구를 호출하세요.

<markdown-source>
${doc.markdown}
</markdown-source>
`
}
// 법원명 약칭 (탭 제목 길이 절약)
function abbrevCourt(court: string): string {
  return court
    .replace('지방법원', '지법')
    .replace('고등법원', '고법')
    .replace('지원', '지원')
    .trim()
}

// 완료 알림음 (외부 파일 없이 WebAudio로 합성). 컨텍스트를 1개만 만들어 재사용하고
// 자동재생 정책 때문에 사용자 제스처(클릭)에서 resume 해 둔다.
let _actx: AudioContext | null = null
function getAudioCtx(): AudioContext | null {
  try {
    if (!_actx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      _actx = new Ctx()
    }
    if (_actx.state === 'suspended') void _actx.resume()
    return _actx
  } catch {
    return null
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => void getAudioCtx(), { capture: true })
}
function playNotificationSound(
  sound = DEFAULT_NOTIFICATION_SOUND,
  volume = DEFAULT_NOTIFICATION_VOLUME
): void {
  if (sound === 'none') return
  const volumeRatio = clampNotificationVolume(volume) / 100
  if (volumeRatio <= 0) return
  const ctx = getAudioCtx()
  if (!ctx) return
  const tones = NOTIFICATION_TONES[sound]
  const play = ({ frequency, start, duration, type = 'sine', gain = 0.16 }: NotificationTone): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.value = frequency
    o.connect(g)
    g.connect(ctx.destination)
    const t0 = ctx.currentTime + start
    const peak = Math.max(0.0001, gain * volumeRatio)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    o.start(t0)
    o.stop(t0 + duration + 0.02)
  }
  tones.forEach(play)
}

let docSeq = 0
const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${++docSeq}`

export default function App(): JSX.Element {
  const docOnly = window.location.hash.includes('docOnly')
  const termOnly = window.location.hash.includes('termOnly')
  const [mode, setMode] = useState<Mode>('explorer')
  const [info, setInfo] = useState<string>('')
  const [platform, setPlatform] = useState<string>('')

  const [docTabs, setDocTabs] = useState<DocTab[]>(() =>
    docOnly ? [] : [{ id: 'doc-welcome', title: '시작하기.md', kind: 'welcome', side: 'left' }]
  )
  const [activeDoc, setActiveDoc] = useState<string>(() => (docOnly ? '' : 'doc-welcome'))
  // 닫으면 내용이 사라지는 문서(저장 안 된 새 문서) id 집합 — 닫기 전 확인용
  const [dirtyDocs, setDirtyDocs] = useState<Set<string>>(new Set())

  const [termTabs, setTermTabs] = useState<TermTab[]>([])
  const [activeTerm, setActiveTerm] = useState<string>('')
  const [termFocusNonce, setTermFocusNonce] = useState<Record<string, number>>({})
  const termTabsRef = useRef<TermTab[]>([])
  const [activeWork, setActiveWork] = useState<Record<DockSide, string>>({
    left: docOnly ? '' : docKey('doc-welcome'),
    right: ''
  })
  const [draftsRoot, setDraftsRoot] = useState<string | undefined>()
  const [recordsRoot, setRecordsRoot] = useState<string | undefined>()
  const [caseOpenTarget, setCaseOpenTarget] = useState<string>(CASE_OPEN_LOCAL)
  const [notificationSound, setNotificationSound] =
    useState<NotificationSound>(DEFAULT_NOTIFICATION_SOUND)
  const [notificationVolume, setNotificationVolume] = useState(DEFAULT_NOTIFICATION_VOLUME)
  // SSH 접속 프로필 + 접속 선택/원격 폴더 선택 모달 상태
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([])
  const [connMenu, setConnMenu] = useState(false)
  const [remotePick, setRemotePick] = useState<SshProfile | null>(null)
  const [recordsPick, setRecordsPick] = useState<{
    profile: SshProfile
    draftsPath?: string
    title?: string
    startPath?: string
  } | null>(null)
  const [syncInit, setSyncInit] = useState<{
    profile: SshProfile
    macFolder: string
  } | null>(null)

  // 활성 PDF의 목차 분류 결과 + 페이지 점프 신호
  const [pdfRecord, setPdfRecord] = useState<{ path: string; parsed: ParsedRecord } | null>(null)
  const [pdfJump, setPdfJump] = useState<{ page: number; nonce: number } | undefined>()
  const jumpNonce = useRef(0)


  // 소송기록 폴더의 PDF 파일명을 파싱한 분류 결과 (폴더 기반 기록)
  const [folderRecord, setFolderRecord] = useState<ParsedRecord | null>(null)

  // 여백 자르기는 앱 전역으로 유지 (문서 바꿔도 적용 지속)
  const [cropOn, setCropOn] = useState(false)
  const [cropRatio, setCropRatio] = useState(0.05)

  // 최근 사건 히스토리
  const [recent, setRecent] = useState<{ drafts: string; records?: string; name: string; ts: number }[]>(
    []
  )

  // 탐색기 트리 새로고침 트리거 (드래그드롭 복사 후)
  const [treeRefresh, setTreeRefresh] = useState(0)

  // 탐색기 인라인 생성 (VS Code식: 트리에 입력칸이 떠서 이름 입력)
  const [pendingCreate, setPendingCreate] = useState<'file' | 'folder' | null>(null)
  const closeActiveTermRef = useRef<() => void>(() => {})

  useEffect(() => {
    const applySettings = (s: AppSettings): void => {
      const profiles = s.sshProfiles ?? []
      setDraftsRoot(s.draftsRoot)
      setRecordsRoot(s.recordsRoot)
      setSshProfiles(profiles)
      setCaseOpenTarget(resolveCaseOpenTarget(s.caseOpenTarget, profiles))
      setNotificationSound(resolveNotificationSound(s.notificationSound))
      setNotificationVolume(clampNotificationVolume(s.notificationVolume))
    }
    window.lt?.app
      .info()
      .then((i) => {
        setPlatform(i.platform)
        setInfo(`Electron ${i.versions.electron} · Node ${i.versions.node} · ${i.platform}`)
      })
      .catch(() => setInfo('preload 브리지 미연결'))
    window.lt?.settings.get().then(applySettings)
    window.lt?.case.history().then(setRecent)
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  termTabsRef.current = termTabs
  useEffect(() => {
    const killWindowTerms = (): void => {
      for (const t of termTabsRef.current) window.lt.pty.kill(t.id)
    }
    window.addEventListener('beforeunload', killWindowTerms)
    return () => window.removeEventListener('beforeunload', killWindowTerms)
  }, [])

  const setWorkActive = (side: DockSide, key: WorkTabKey): void => {
    setActiveWork((active) => ({ ...active, [side]: key }))
  }
  const activateDocTab = (id: string): void => {
    const tab = docTabs.find((t) => t.id === id)
    setActiveDoc(id)
    setWorkActive(docSide(tab), docKey(id))
  }
  const activateTermTab = (id: string): void => {
    const tab = termTabs.find((t) => t.id === id)
    setActiveTerm(id)
    setWorkActive(termSide(tab), termKeyOf(id))
  }
  const moveDocToSide = (id: string, side: DockSide): void => {
    setDocTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, side } : t)))
    setActiveDoc(id)
    setWorkActive(side, docKey(id))
  }
  const moveTermToSide = (id: string, side: DockSide): void => {
    setTermTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, side } : t)))
    setActiveTerm(id)
    setWorkActive(side, termKeyOf(id))
  }
  const moveWorkTabToSide = (key: string, side: DockSide): void => {
    const parsed = parseWorkKey(key)
    if (!parsed) return
    if (parsed.kind === 'doc') moveDocToSide(parsed.id, side)
    else moveTermToSide(parsed.id, side)
  }

  // ── 본문(문서) 탭 ──
  // 활성 사건 폴더가 있으면 거기에 실제 파일을 만들어 연다(VS Code식). 없으면 메모리 스크래치.
  const addDoc = (side: DockSide = 'left'): void => {
    const t = termTabs.find((t) => t.id === activeTerm)
    // 원격 사건이면 ssh:// URI로 만들어 원격에 생성 (plain cwd면 로컬에 잘못 생성됨)
    const dir = t ? (t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd) : undefined
    if (dir) {
      window.lt.fs.createFile(dir, '새 문서.md').then((r) => {
        if (r.ok && r.path) {
          setTreeRefresh((x) => x + 1)
          openFile(r.path, r.path.split(/[\\/]/).pop() ?? '새 문서.md', side)
        }
      })
      return
    }
    const n = ++docSeq
    const tab: DocTab = { id: `doc-${n}`, title: `새 문서 ${n}.md`, kind: 'mdview', side }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }
  const setDocPath = (id: string, path: string): void =>
    setDocTabs((tabs) =>
      tabs.map((t) =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() ?? t.title } : t
      )
    )
  const closeDoc = (id: string): void => {
    // 저장 안 된 새 문서면 확인 (경로 있는 문서는 자동저장되므로 그냥 닫음)
    if (
      dirtyDocs.has(id) &&
      !window.confirm('저장하지 않은 새 문서입니다. 닫으면 내용이 사라집니다. 닫을까요?')
    )
      return
    setDirtyDocs((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
    setDocTabs((tabs) => closeTab(tabs, id, activeDoc, setActiveDoc))
  }

  const openNewWorkspaceWindow = (): void => {
    void window.lt.app.newWindow()
  }

  // 단축키: Ctrl/Cmd+W 탭 닫기 / Ctrl/Cmd+N 새 문서 / Ctrl/Cmd+Shift+N 새 작업환경
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const primary = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey
      if (!primary || e.altKey) return
      const k = e.key.toLowerCase()
      const inTerm = (document.activeElement as HTMLElement | null)?.closest?.('.term-col')
      if (k === 'w' && !e.shiftKey) {
        if (platform === 'darwin' && activeTerm) {
          e.preventDefault()
          e.stopPropagation()
          closeActiveTermRef.current()
          return
        }
        if (inTerm) return // 터미널 포커스 시 claude로 (단어 삭제)
        e.preventDefault()
        if (activeDoc) closeDoc(activeDoc)
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault()
        openNewWorkspaceWindow()
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        addDoc()
      } else if (k === 'tab') {
        // Ctrl/Cmd+Tab: 문서 탭 순환 (터미널 포커스 시엔 터미널이 자체 처리)
        if (inTerm) return
        e.preventDefault()
        cycleDoc(e.shiftKey ? -1 : 1)
      } else if (k === 'pageup' || k === 'pagedown') {
        // Ctrl/Cmd+PageUp/PageDown: 문서 탭 이동 (터미널 포커스 시엔 터미널이 자체 처리)
        if (inTerm) return
        e.preventDefault()
        cycleDoc(k === 'pageup' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDoc, activeTerm, termTabs, docTabs, platform]) // eslint-disable-line react-hooks/exhaustive-deps

  const openSettings = (): void => {
    const existing = docTabs.find((t) => t.kind === 'settings')
    if (existing) {
      activateDocTab(existing.id)
      return
    }
    const tab: DocTab = { id: 'settings', title: '설정', kind: 'settings', side: 'left' }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive('left', docKey(tab.id))
  }

  const openFile = (path: string, name: string, side: DockSide = 'left'): void => {
    const existing = docTabs.find((t) => t.path === path)
    if (existing) {
      activateDocTab(existing.id)
      return
    }
    const lower = path.toLowerCase()
    let kind: DocTab['kind'] = 'file'
    if (lower.endsWith('.pdf')) kind = 'pdf'
    else if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/.test(lower)) kind = 'image'
    else if (/\.(hwp|hwpx)$/.test(lower)) kind = 'hwp'
    else if (/\.(md|markdown)$/.test(lower)) kind = 'mdview'
    else if (lower.endsWith('.csv')) kind = 'csv'
    const tab: DocTab = { id: `file-${++docSeq}`, title: name, kind, path, side }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
    setWorkActive(side, docKey(tab.id))
  }

  // 이미지 뷰어: 같은 폴더의 정렬순 이전/다음 이미지로 현재 탭에서 이동
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/i
  const navigateImage = async (curPath: string, dir: 1 | -1): Promise<void> => {
    const parent = curPath.replace(/[\\/][^\\/]*$/, '')
    if (!parent || parent === curPath) return
    try {
      const list = await window.lt.fs.list(parent)
      const imgs = list.filter((e) => !e.isDir && IMG_RE.test(e.name))
      const i = imgs.findIndex((e) => e.path === curPath)
      if (i < 0) return
      const next = imgs[i + dir]
      if (!next) return
      setDocTabs((tabs) =>
        tabs.map((t) =>
          t.kind === 'image' && t.path === curPath ? { ...t, path: next.path, title: next.name } : t
        )
      )
    } catch {
      /* 무시 */
    }
  }

  const currentCaseFromTerm = (t: TermTab): CurrentCase => {
    const drafts = t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd
    return {
      drafts,
      records: t.recordsFolder,
      name: t.title,
      meta: {
        jsId: t.jsId,
        court: t.court,
        caseNumber: t.caseNumber,
        caseName: t.caseName,
        client: t.client
      },
      ssh: t.ssh,
      sshLabel: t.sshLabel,
      profileId: t.profileId,
      remotePath: t.ssh ? t.cwd : undefined
    }
  }

  // 다른 창에서 찢겨/이동돼 온 탭 수신 → 문서 또는 터미널 열기.
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const receiveTabRef = useRef<(p: TabPayload) => void>(() => {})
  receiveTabRef.current = (p) => {
    if (p.kind === 'terminal') {
      const tab = { ...(p.tab as TermTab), side: (p.tab as TermTab).side ?? 'right' }
      setTermTabs((tabs) => (tabs.some((t) => t.id === tab.id) ? tabs : [...tabs, tab]))
      setActiveTerm(tab.id)
      setCurrentCase(currentCaseFromTerm(tab))
      setWorkActive(termSide(tab), termKeyOf(tab.id))
      return
    }
    openFileRef.current(p.path, p.title, p.side ?? 'left')
  }
  useEffect(() => {
    const off = window.lt.tabs.onReceive((p) => receiveTabRef.current(p))
    window.lt.tabs.ready() // 큐잉된 페이로드 flush 요청
    return off
  }, [])

  // claude 세션 제목(ai-title)을 주기적으로 읽어 탭 이름에 반영 (수동 변경한 탭 제외)
  const termKey = termTabs.map((t) => t.id + ':' + t.cwd).join('|')
  useEffect(() => {
    if (termTabs.length === 0) return
    let alive = true
    const tick = (): void => {
      termTabs.forEach((t) => {
        if (t.renamed || t.ssh) return // 원격 transcript 조회는 세션 목록을 열 때만 수행
        // 이 터미널이 시작된 이후의 세션만 매칭 (과거 세션 제목 방지)
        window.lt.sessions.current(t.cwd, (t.createdAt ?? 0) - 3000, t.ssh).then((r) => {
          if (!alive || !r?.title) return
          setTermTabs((tabs) =>
            tabs.map((x) =>
              x.id === t.id && !x.renamed && x.sessionTitle !== r.title
                ? { ...x, sessionTitle: r.title }
                : x
            )
          )
        })
      })
    }
    tick()
    const iv = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey])

  // 문서 탭 순서 변경 (탭 바 안에서 드래그 재정렬)
  const reorderDocs = (fromId: string, toId: string): void => {
    setDocTabs((ts) => {
      const a = [...ts]
      const fi = a.findIndex((x) => x.id === fromId)
      const ti = a.findIndex((x) => x.id === toId)
      if (fi < 0 || ti < 0 || fi === ti) return ts
      const [m] = a.splice(fi, 1)
      a.splice(ti, 0, m)
      return a
    })
  }
  const reorderTerms = (fromId: string, toId: string): void => {
    setTermTabs((ts) => {
      const a = [...ts]
      const fi = a.findIndex((x) => x.id === fromId)
      const ti = a.findIndex((x) => x.id === toId)
      if (fi < 0 || ti < 0 || fi === ti) return ts
      const [m] = a.splice(fi, 1)
      a.splice(ti, 0, m)
      return a
    })
  }

  // ── 사건 터미널 탭 (작성서류 폴더 = cwd로 claude 실행) ──
  const createCase = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta,
    side: DockSide = 'right'
  ): void => {
    const tab: TermTab = {
      id: newId(),
      title: name,
      cwd: drafts,
      recordsFolder: records,
      suggestedRecords: suggested,
      autoClaude: true, // 사건 열기 → claude 자동 실행
      createdAt: Date.now(),
      side,
      ...caseMeta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    setCurrentCase({ drafts, records, name, meta: caseMeta })
    window.lt.case.addHistory({ drafts, records, name }).then(setRecent)
  }

  const historyDraftsForTerm = (t: TermTab): string =>
    t.ssh && t.profileId ? remoteUri(t.profileId, t.cwd) : t.cwd

  const addTerm = async (side: DockSide = 'right'): Promise<void> => {
    const picked = await window.lt.dialog.pickFolder({
      title: '사건(작성서류) 폴더 선택',
      defaultPath: draftsRoot
    })
    if (!picked) return
    // 이전에 페어링한 소송기록 폴더가 있으면 '추천'만 (자동 적용하지 않고 물어봄)
    const paired = await window.lt.case.getPairing(picked.path)
    createCase(picked.path, picked.name, undefined, paired ?? undefined, undefined, side)
  }

  // 원격(SSH) 사건 터미널 — cwd는 원격 경로, claude도 원격에서 실행.
  // 파일 패널(탐색기·뷰어·에디터)은 ssh://<profileId>/<경로> URI로 원격 파일을 다룬다.
  const createRemoteCase = (
    profile: SshProfile,
    remotePath: string,
    name?: string,
    meta?: CaseMeta,
    records?: string,
    side: DockSide = 'right'
  ): { id: string; title: string } => {
    const title = name || remotePath.replace(/\/+$/, '').split('/').pop() || profile.label
    const draftsUri = remoteUri(profile.id, remotePath)
    const ssh = sshConnFromProfile(profile)
    const tab: TermTab = {
      id: newId(),
      title,
      cwd: remotePath,
      recordsFolder: records,
      autoClaude: true,
      createdAt: Date.now(),
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      side,
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
    setCurrentCase({
      drafts: draftsUri,
      records,
      name: title,
      meta,
      ssh,
      sshLabel: profile.label,
      profileId: profile.id,
      remotePath
    })
    window.lt.case.addHistory({ drafts: draftsUri, records, name: title }).then(setRecent)
    // 소송기록이 정해졌으면 페어링 기억(다음에 자동 적용) — 로컬과 동일
    if (records) window.lt.case.setPairing(draftsUri, records)
    return { id: tab.id, title }
  }

  const attachRemoteRecords = (
    tabId: string,
    profile: SshProfile,
    remotePath: string,
    title: string,
    records?: string
  ): void => {
    if (!records) return
    setTermTabs((tabs) =>
      tabs.map((t) => (t.id === tabId ? { ...t, recordsFolder: records } : t))
    )
    setCurrentCase((c) =>
      c?.profileId === profile.id && c.remotePath === remotePath ? { ...c, records } : c
    )
    const drafts = remoteUri(profile.id, remotePath)
    window.lt.case.setPairing(drafts, records)
    window.lt.case.addHistory({ drafts, records, name: title }).then(setRecent)
  }

  const resolveRemoteRecordsLater = (
    tabId: string,
    profile: SshProfile,
    remotePath: string,
    title: string,
    c?: JsCase
  ): void => {
    void resolveRemoteRecords(profile, remotePath, c)
      .then((records) => attachRemoteRecords(tabId, profile, remotePath, title, records))
      .catch(() => {})
  }

  // ssh:// URI에서 원격 plain 경로만 추출 (createRemoteCase의 cwd용)
  const remotePlain = (uri: string, profileId: string): string =>
    uri.startsWith('ssh://' + profileId) ? uri.slice(('ssh://' + profileId).length) : uri

  // 원격 사건의 소송기록 폴더를 로컬과 동일한 우선순위로 결정:
  // ① 기억된 페어링(getPairing) → ② 소송기록 루트에서 사건번호/폴더명 매칭.
  // draftsRemotePath = 원격 작성서류(사건) 폴더 plain 경로, c = (있으면) JuriSupport 사건.
  const resolveRemoteRecords = async (
    profile: SshProfile,
    draftsRemotePath: string,
    c?: JsCase
  ): Promise<string | undefined> => {
    const draftsKey = remoteUri(profile.id, draftsRemotePath)
    const paired = await window.lt.case.getPairing(draftsKey)
    if (paired) return paired
    if (!profile.recordsRoot) return undefined
    const recRoot = remoteUri(profile.id, profile.recordsRoot)
    if (c) return await matchCaseFolder(recRoot, c)
    const name = draftsRemotePath.replace(/\/+$/, '').split('/').pop() ?? ''
    return await matchRemoteByName(recRoot, name)
  }

  // 원격 루트(ssh:// URI)에서 폴더명으로 매칭 — 소송기록 폴더 자동 지정용. 매칭 항목의 ssh:// URI 반환.
  const matchRemoteByName = async (rootUri: string, name: string): Promise<string | undefined> => {
    try {
      const list = await window.lt.fs.list(rootUri)
      const dirs = list.filter((e) => e.isDir)
      const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
      const n = norm(name)
      if (n.length < 2) return undefined
      return (
        dirs.find((d) => norm(d.name) === n)?.path ??
        dirs.find((d) => norm(d.name).includes(n) || n.includes(norm(d.name)))?.path
      )
    } catch {
      return undefined
    }
  }

  // rclone 동기화 모달 열기 — 맥의 사건 폴더(원격 경로)를 추정해 프리필.
  // (클라우드 경유 모델: 맥에서 rclone 실행 → 맥 폴더 ↔ OneDrive 클라우드)
  const openSync = (): void => {
    if (sshProfiles.length === 0) {
      window.alert('먼저 설정에서 SSH 접속 프로필을 추가하세요.')
      return
    }
    const cur = termTabs.find((t) => t.id === activeTerm)
    const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    if (cur?.ssh && cur.profileId) {
      // 활성 사건이 원격 → 그 맥 폴더를 그대로 사용
      const profile = sshProfiles.find((p) => p.id === cur.profileId) ?? sshProfiles[0]
      setSyncInit({ profile, macFolder: cur.cwd })
    } else {
      // 활성 사건이 로컬 → 첫 프로필의 원격 작성서류 루트 하위 동일 폴더명으로 추정
      const localPath = cur?.cwd ?? currentCase?.drafts ?? ''
      const name = baseName(localPath)
      const profile = sshProfiles[0]
      setSyncInit({
        profile,
        macFolder: profile.draftsRoot ? profile.draftsRoot.replace(/\/+$/, '') + '/' + name : ''
      })
    }
  }

  // 📁/＋ 클릭: 저장된 SSH 프로필이 있으면 접속 선택 메뉴, 없으면 바로 로컬 폴더 선택.
  const openConnOrLocal = async (): Promise<void> => {
    const s = await window.lt.settings.get()
    const profs = s.sshProfiles ?? []
    setSshProfiles(profs)
    if (profs.length > 0) setConnMenu(true)
    else void addTerm()
  }

  // 최근 사건은 사용자가 명시적으로 고른 것이므로 연결된 소송기록을 바로 적용
  const openRecent = async (entry: {
    drafts: string
    records?: string
    name: string
  }): Promise<void> => {
    const remote = parseRemoteUri(entry.drafts)
    if (!remote) {
      createCase(entry.drafts, entry.name, entry.records)
      return
    }
    const s = await window.lt.settings.get()
    const profiles = s.sshProfiles ?? []
    setSshProfiles(profiles)
    const profile = profiles.find((p) => p.id === remote.profileId)
    if (!profile) {
      window.alert('이 최근 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      return
    }
    createRemoteCase(profile, remote.path, entry.name, undefined, entry.records)
  }

  // 과거 claude 세션 이어서 열기 (claude --resume). 지정한 cwd/사건 컨텍스트에서.
  const openPastSession = (
    sessionId: string,
    cwd: string,
    title?: string,
    source?: TermTab,
    side: DockSide = termSide(source)
  ): void => {
    const base =
      currentCase && (currentCase.drafts === cwd || currentCase.remotePath === cwd)
        ? currentCase
        : undefined
    const meta = base?.meta
    const tab: TermTab = {
      id: newId(),
      title: title ? title : base?.name ?? cwd.split(/[\\/]/).pop() ?? '세션',
      cwd,
      recordsFolder: base?.records ?? source?.recordsFolder,
      autoClaude: true,
      createdAt: Date.now(),
      resumeSessionId: sessionId,
      renamed: !!title, // 과거 세션 제목을 그대로 쓰면 자동 갱신 안 함
      jsId: source?.jsId,
      court: source?.court,
      caseNumber: source?.caseNumber,
      caseName: source?.caseName,
      client: source?.client,
      ssh: source?.ssh,
      sshLabel: source?.sshLabel,
      profileId: source?.profileId,
      side,
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
  }

  // + / Ctrl+T : 같은 사건에서 새 터미널(claude 실행). 활성 터미널이 없으면 마지막 사건에서, 그것도 없으면 폴더 선택.
  const addTermSame = (preferredSide?: DockSide): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const side = preferredSide ?? termSide(cur)
    if (!cur) {
      if (currentCase) {
        if (currentCase.ssh && currentCase.profileId && currentCase.remotePath) {
          const saved = sshProfiles.find((p) => p.id === currentCase.profileId)
          const profile: SshProfile =
            saved ?? {
              id: currentCase.profileId,
              label: currentCase.sshLabel ?? currentCase.profileId,
              host: currentCase.ssh.host,
              user: currentCase.ssh.user,
              port: currentCase.ssh.port,
              identityFile: currentCase.ssh.identityFile
            }
          createRemoteCase(
            profile,
            currentCase.remotePath,
            currentCase.name,
            currentCase.meta,
            currentCase.records,
            side
          )
        } else {
          createCase(currentCase.drafts, currentCase.name, currentCase.records, undefined, currentCase.meta, side)
        }
      } else {
        void addTerm(side)
      }
      return
    }
    const tab: TermTab = {
      id: newId(),
      title: cur.title,
      cwd: cur.cwd,
      recordsFolder: cur.recordsFolder,
      autoClaude: true, // 새 터미널도 일괄적으로 claude 실행
      createdAt: Date.now(),
      jsId: cur.jsId,
      court: cur.court,
      caseNumber: cur.caseNumber,
      caseName: cur.caseName,
      client: cur.client,
      ssh: cur.ssh, // 원격 사건이면 같은 접속으로 새 터미널
      sshLabel: cur.sshLabel,
      profileId: cur.profileId,
      side
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setWorkActive(side, termKeyOf(tab.id))
  }

  // 추천 소송기록 폴더 적용 ('열기' 클릭 시)
  const applySuggested = (): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    if (!cur?.suggestedRecords) return
    const rec = cur.suggestedRecords
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === activeTerm ? { ...t, recordsFolder: rec, suggestedRecords: undefined } : t
      )
    )
    const drafts = historyDraftsForTerm(cur)
    window.lt.case.setPairing(drafts, rec)
    window.lt.case.addHistory({ drafts, records: rec, name: cur.title }).then(setRecent)
  }

  const removeTermTab = (id: string): void => {
    setTermTabs((tabs) => closeTab(tabs, id, activeTerm, setActiveTerm))
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
    setTermStatus((m) => {
      if (!m.has(id)) return m
      const n = new Map(m)
      n.delete(id)
      return n
    })
  }
  const closeTerm = (id: string): void => {
    window.lt.pty.kill(id)
    removeTermTab(id)
  }
  const detachTerm = (id: string): void => removeTermTab(id)

  // 터미널 선택 → 활성화 + 완료(주목) 표시 해제
  const selectTerm = (id: string): void => {
    activateTermTab(id)
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  // 터미널 작업 상태(진행중/완료/질문대기). 완료·질문 전이에서만 소리.
  const onTermStatus = (id: string, status: 'working' | 'done' | 'question'): void => {
    setTermStatus((m) => {
      const n = new Map(m)
      n.set(id, status)
      return n
    })
    if (status === 'working') {
      setTermAttention((s) => {
        if (!s.has(id)) return s
        const n = new Set(s)
        n.delete(id)
        return n
      })
    } else {
      playNotificationSound(notificationSound, notificationVolume)
      const bg = id !== activeTermRef.current
      if (bg) setTermAttention((s) => new Set(s).add(id))
      if (status === 'question' && bg) pushToast(id)
    }
  }

  // 질문/확인 대기 팝업(토스트)
  const toastSeq = useRef(0)
  const pushToast = (termId: string): void => {
    const t = termTabs.find((x) => x.id === termId)
    const key = ++toastSeq.current
    setToasts((ts) => [...ts.filter((x) => x.termId !== termId), { key, termId, title: t?.title ?? '세션' }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 12000)
  }
  const dismissToast = (key: number): void => setToasts((ts) => ts.filter((x) => x.key !== key))

  // Ctrl+Tab: 같은 종류 탭 순환 (터미널끼리 / 문서끼리)
  const cycleTerm = (dir: number): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const side = termSide(cur)
    const scoped = termTabs.filter((t) => termSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === activeTerm)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    selectTerm(scoped[ni].id)
  }
  const cycleDoc = (dir: number): void => {
    const cur = docTabs.find((t) => t.id === activeDoc)
    const side = docSide(cur)
    const scoped = docTabs.filter((t) => docSide(t) === side)
    if (scoped.length < 2) return
    const i = scoped.findIndex((t) => t.id === activeDoc)
    const ni = (((i < 0 ? 0 : i) + dir) % scoped.length + scoped.length) % scoped.length
    activateDocTab(scoped[ni].id)
  }

  // 활성 사건(또는 마지막 사건)에 소송기록 폴더를 지정/탐색 → 뷰어 연결 + 페어링 기억.
  // 터미널이 닫혀 있어도 현재 사건 컨텍스트에 적용된다.
  const pickRecords = async (): Promise<void> => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const remoteCtx =
      cur?.ssh && cur.profileId
        ? {
            profileId: cur.profileId,
            draftsPath: cur.cwd,
            title: cur.title,
            records: cur.recordsFolder
          }
        : !cur && currentCase?.ssh && currentCase.profileId && currentCase.remotePath
          ? {
              profileId: currentCase.profileId,
              draftsPath: currentCase.remotePath,
              title: currentCase.name,
              records: currentCase.records
            }
          : null
    if (remoteCtx) {
      let profiles = sshProfiles
      let prof = profiles.find((p) => p.id === remoteCtx.profileId)
      if (!prof) {
        const s = await window.lt.settings.get()
        profiles = s.sshProfiles ?? []
        setSshProfiles(profiles)
        prof = profiles.find((p) => p.id === remoteCtx.profileId)
      }
      if (prof) {
        const currentRecords =
          remoteCtx.records && isRemotePath(remoteCtx.records)
            ? remotePlain(remoteCtx.records, prof.id)
            : undefined
        setRecordsPick({
          profile: prof,
          draftsPath: remoteCtx.draftsPath,
          title: remoteCtx.title,
          startPath: currentRecords || prof.recordsRoot || '~'
        })
      } else {
        window.alert('이 사건에 연결된 SSH 프로필을 찾을 수 없습니다. 설정에서 SSH 프로필을 확인하세요.')
      }
      return
    }
    const draftsForPair = cur?.cwd ?? currentCase?.drafts
    const r = await window.lt.dialog.pickFolder({
      title: '소송기록 폴더 선택',
      defaultPath: recordsRoot ?? currentCase?.records
    })
    if (!r) return
    if (cur) {
      setTermTabs((tabs) =>
        tabs.map((t) => (t.id === activeTerm ? { ...t, recordsFolder: r.path } : t))
      )
    }
    // 터미널 유무와 무관하게 현재 사건 컨텍스트에도 반영(뷰어가 이걸 참조)
    setCurrentCase((c) => (c ? { ...c, records: r.path } : c))
    if (draftsForPair) {
      window.lt.case.setPairing(draftsForPair, r.path)
      window.lt.case
        .addHistory({ drafts: draftsForPair, records: r.path, name: cur?.title ?? currentCase?.name ?? '사건' })
        .then(setRecent)
    }
  }

  const onOutline = (path: string, parsed: ParsedRecord): void => setPdfRecord({ path, parsed })
  const jumpToPage = (page: number): void => {
    jumpNonce.current += 1
    setPdfJump({ page, nonce: jumpNonce.current })
  }

  // 마지막으로 연 사건 컨텍스트 — 터미널을 모두 닫아도 유지(탐색기·뷰어·새 터미널 기준)
  const [currentCase, setCurrentCase] = useState<CurrentCase | null>(null)

  // 사건 지정 해제 — 마지막 사건 컨텍스트를 비워 '+'·'이 사건에서 열기'가 더는 그 사건을 열지 않게.
  // (탐색기·뷰어 패널도 활성 터미널이 없으면 비워진다)
  const clearCase = (): void => {
    setCurrentCase(null)
    setFolderRecord(null)
    setPdfRecord(null)
  }

  const activeDocTab = docTabs.find((t) => t.id === activeDoc)
  const activeTermTab = termTabs.find((t) => t.id === activeTerm)
  // 활성 터미널이 있으면 그 사건, 없으면(터미널 다 닫힘) 마지막 사건 컨텍스트 유지
  // 원격 탭의 작성서류 폴더는 ssh:// URI로 변환(패널·탐색기용). 터미널은 plain cwd를 그대로 씀.
  const activeDraftsFolder =
    activeTermTab && activeTermTab.ssh && activeTermTab.profileId
      ? remoteUri(activeTermTab.profileId, activeTermTab.cwd)
      : (activeTermTab?.cwd ?? currentCase?.drafts)
  const activeRecordsFolder = activeTermTab?.recordsFolder ?? currentCase?.records
  const activeSuggestedRecords = activeTermTab?.suggestedRecords
  const defaultCaseOpenProfileId = caseOpenProfileId(
    resolveCaseOpenTarget(caseOpenTarget, sshProfiles)
  )
  const isViewer = mode === 'viewer'
  const sessionCaseSource: TermTab | undefined = currentCase
    ? (() => {
        const remote = parseRemoteUri(currentCase.drafts)
        const profileId = currentCase.profileId ?? remote?.profileId
        const savedProfile = profileId ? sshProfiles.find((p) => p.id === profileId) : undefined
        const ssh = currentCase.ssh ?? (savedProfile ? sshConnFromProfile(savedProfile) : undefined)
        const cwd = currentCase.remotePath ?? remote?.path ?? currentCase.drafts
        return {
          id: '__current_case__',
          title: currentCase.name,
          cwd,
          recordsFolder: currentCase.records,
          autoClaude: true,
          jsId: currentCase.meta?.jsId,
          court: currentCase.meta?.court,
          caseNumber: currentCase.meta?.caseNumber,
          caseName: currentCase.meta?.caseName,
          client: currentCase.meta?.client,
          ssh,
          sshLabel: currentCase.sshLabel ?? savedProfile?.label,
          profileId,
          side: 'right'
        }
      })()
    : undefined

  const buildWorkspaceSnapshot = async (): Promise<WorkspaceSnapshot> => {
    const docs = docTabs.map(toWorkspaceDoc).filter((t): t is WorkspaceDocTabPayload => !!t)
    const terminals = await Promise.all(
      termTabs.map(async (t) => {
        const current = await window.lt.sessions
          .current(t.cwd, (t.createdAt ?? 0) - 3000, t.ssh)
          .catch(() => null)
        return {
          ...t,
          side: termSide(t),
          resumeSessionId: current?.sessionId ?? t.resumeSessionId,
          sessionTitle: current?.title ?? t.sessionTitle
        }
      })
    )
    return {
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      mode,
      docs,
      terminals,
      activeDoc,
      activeTerm,
      activeWork,
      currentCase,
      crop: { on: cropOn, ratio: cropRatio }
    }
  }

  const sanitizeWorkspaceTerm = (raw: unknown): TermTab | null => {
    if (!raw || typeof raw !== 'object') return null
    const t = raw as Partial<TermTab>
    if (typeof t.cwd !== 'string' || !t.cwd) return null
    return {
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      title: typeof t.title === 'string' && t.title ? t.title : t.cwd.split(/[\\/]/).pop() || '세션',
      cwd: t.cwd,
      recordsFolder: typeof t.recordsFolder === 'string' ? t.recordsFolder : undefined,
      suggestedRecords: typeof t.suggestedRecords === 'string' ? t.suggestedRecords : undefined,
      autoClaude: t.autoClaude ?? true,
      jsId: typeof t.jsId === 'string' ? t.jsId : undefined,
      court: typeof t.court === 'string' ? t.court : undefined,
      caseNumber: typeof t.caseNumber === 'string' ? t.caseNumber : undefined,
      caseName: typeof t.caseName === 'string' ? t.caseName : undefined,
      client: typeof t.client === 'string' ? t.client : undefined,
      sessionTitle: typeof t.sessionTitle === 'string' ? t.sessionTitle : undefined,
      renamed: !!t.renamed,
      createdAt: Date.now(),
      resumeSessionId: typeof t.resumeSessionId === 'string' ? t.resumeSessionId : undefined,
      ssh: t.ssh,
      sshLabel: typeof t.sshLabel === 'string' ? t.sshLabel : undefined,
      profileId: typeof t.profileId === 'string' ? t.profileId : undefined,
      side: t.side ?? 'right'
    }
  }

  const restoreWorkspaceSnapshot = (snapshot: WorkspaceSnapshot): void => {
    const snapshotDocs = Array.isArray(snapshot.docs) ? snapshot.docs : []
    const snapshotTerms = Array.isArray(snapshot.terminals) ? snapshot.terminals : []
    const nextDocs = [...docTabs]
    const docIdMap = new Map<string, string>()
    for (const saved of snapshotDocs) {
      const tab = toDocTab(saved)
      if (!tab) continue
      const existingById = nextDocs.find((t) => t.id === tab.id)
      const existingByPath = tab.path ? nextDocs.find((t) => t.path === tab.path) : undefined
      const existing = existingById ?? existingByPath
      if (existing) {
        docIdMap.set(saved.id, existing.id)
        continue
      }
      nextDocs.push(tab)
      docIdMap.set(saved.id, tab.id)
    }

    const nextTerms = [...termTabs]
    const termIdSet = new Set(nextTerms.map((t) => t.id))
    for (const saved of snapshotTerms) {
      const tab = sanitizeWorkspaceTerm(saved)
      if (!tab || termIdSet.has(tab.id)) continue
      nextTerms.push(tab)
      termIdSet.add(tab.id)
    }

    setDocTabs(nextDocs)
    setTermTabs(nextTerms)

    const activeDocId =
      (snapshot.activeDoc && docIdMap.get(snapshot.activeDoc)) ||
      (activeDoc && nextDocs.some((t) => t.id === activeDoc) ? activeDoc : nextDocs[0]?.id ?? '')
    const activeTermId =
      (snapshot.activeTerm && nextTerms.some((t) => t.id === snapshot.activeTerm)
        ? snapshot.activeTerm
        : undefined) ||
      (activeTerm && nextTerms.some((t) => t.id === activeTerm) ? activeTerm : nextTerms[0]?.id ?? '')
    setActiveDoc(activeDocId)
    setActiveTerm(activeTermId)

    const validKeys = new Set([
      ...nextDocs.map((t) => docKey(t.id)),
      ...nextTerms.map((t) => termKeyOf(t.id))
    ])
    const firstKeyForSide = (side: DockSide): string => {
      const doc = nextDocs.find((t) => docSide(t) === side)
      if (doc) return docKey(doc.id)
      const term = nextTerms.find((t) => termSide(t) === side)
      return term ? termKeyOf(term.id) : ''
    }
    const left =
      isWorkKey(snapshot.activeWork?.left) && validKeys.has(snapshot.activeWork.left)
        ? snapshot.activeWork.left
        : firstKeyForSide('left')
    const activeTermTab = nextTerms.find((t) => t.id === activeTermId)
    const right =
      isWorkKey(snapshot.activeWork?.right) && validKeys.has(snapshot.activeWork.right)
        ? snapshot.activeWork.right
        : firstKeyForSide('right')
    setActiveWork({ left, right })

    if (isWorkspaceMode(snapshot.mode)) setMode(snapshot.mode)
    const restoredCase = sanitizeCurrentCase(snapshot.currentCase)
    setCurrentCase(restoredCase ?? (activeTermTab ? currentCaseFromTerm(activeTermTab) : currentCase))
    if (snapshot.crop) {
      setCropOn(!!snapshot.crop.on)
      if (Number.isFinite(snapshot.crop.ratio)) setCropRatio(snapshot.crop.ratio)
    }
    setTreeRefresh((n) => n + 1)
  }

  const saveWorkspace = async (exportFile = false): Promise<void> => {
    const snapshot = await buildWorkspaceSnapshot()
    const skippedDocs = docTabs.length - snapshot.docs.length
    const result = exportFile
      ? await window.lt.workspace.exportFile(snapshot)
      : await window.lt.workspace.save(snapshot)
    if (result.canceled) return
    if (!result.ok) {
      window.alert('작업환경 저장 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    window.alert(
      `작업환경 저장 완료\n문서 ${snapshot.docs.length}개, 터미널 ${snapshot.terminals.length}개` +
        (skippedDocs > 0 ? `\n임시/미저장 문서 ${skippedDocs}개는 제외했습니다.` : '') +
        (result.path ? `\n${result.path}` : '')
    )
  }

  const chooseWorkspaceEntry = (entries: WorkspaceEntry[]): WorkspaceEntry | null => {
    if (entries.length === 0) return null
    if (entries.length === 1) return entries[0]
    const selected = window.prompt(
      `불러올 작업환경 번호를 입력하세요.\n\n${entries.map(describeWorkspaceEntry).join('\n')}`,
      '1'
    )
    if (selected === null) return null
    const index = Number.parseInt(selected.trim(), 10) - 1
    if (!Number.isInteger(index) || !entries[index]) {
      window.alert('작업환경 번호가 올바르지 않습니다.')
      return null
    }
    return entries[index]
  }

  const loadSavedWorkspace = async (): Promise<WorkspaceLoadResult> => {
    const list = await window.lt.workspace.list()
    if (!list.ok) return { ok: false, error: list.error ?? '작업환경 목록을 불러오지 못했습니다.' }
    const entries = list.entries ?? []
    if (entries.length === 0) return window.lt.workspace.load()
    const entry = chooseWorkspaceEntry(entries)
    if (!entry) return { ok: true, canceled: true, snapshot: null }
    return window.lt.workspace.load(entry.id)
  }

  const restoreWorkspace = async (importFile = false): Promise<void> => {
    const result = importFile ? await window.lt.workspace.importFile() : await loadSavedWorkspace()
    if (result.canceled) return
    if (!result.ok) {
      window.alert('작업환경 복원 실패: ' + (result.error ?? '알 수 없는 오류'))
      return
    }
    if (!result.snapshot) {
      window.alert('저장된 작업환경이 없습니다.')
      return
    }
    restoreWorkspaceSnapshot(result.snapshot)
    window.alert(
      `작업환경 복원 완료${result.entry?.label ? `\n${result.entry.label}` : ''}\n문서 ${result.snapshot.docs?.length ?? 0}개, 터미널 ${
        result.snapshot.terminals?.length ?? 0
      }개`
    )
  }

  useEffect(() => {
    if (!isRemotePath(activeDraftsFolder) && !isRemotePath(activeRecordsFolder)) return
    const timer = setInterval(() => setTreeRefresh((x) => x + 1), 5000)
    return () => clearInterval(timer)
  }, [activeDraftsFolder, activeRecordsFolder])

  const copyPathsTo = (dir: string, paths: string[]): void => {
    if (!paths.length) return
    window.lt.fs.copyInto(dir, paths).then((r) => {
      if (r.copied.length === 0) {
        window.alert('붙여넣기/복사할 수 있는 파일이 없습니다.')
        return
      }
      setTreeRefresh((n) => n + 1)
    })
  }
  // 외부 파일을 특정 폴더로 복사 (드래그앤드롭)
  const copyFilesTo = (dir: string, files: FileList): void => {
    const paths = Array.from(files)
      .map((f) => window.lt.fs.pathForFile(f))
      .filter(Boolean)
    copyPathsTo(dir, paths)
  }
  const pasteFilesTo = async (dir: string): Promise<void> => {
    const clip = await window.lt.fs.clipboardFiles()
    if (clip.paths.length === 0) {
      window.alert('클립보드에 붙여넣을 로컬 파일 경로가 없습니다.')
      return
    }
    copyPathsTo(dir, clip.paths)
  }
  const onDropFiles = (files: FileList): void => {
    if (activeDraftsFolder) copyFilesTo(activeDraftsFolder, files)
  }
  const downloadEntry = (path: string, name: string, isDir: boolean): void => {
    if (!isRemotePath(path)) return
    window.lt.fs.download(path).then((r) => {
      if (r.canceled) return
      if (!r.ok) {
        window.alert('다운로드 실패: ' + (r.error ?? '알 수 없는 오류'))
        return
      }
      window.alert(
        `${isDir ? '폴더' : '파일'} 다운로드 완료: ${name}` +
          (r.count !== undefined ? `\n파일 ${r.count}개` : '') +
          (r.path ? `\n${r.path}` : '')
      )
    })
  }
  // 트리 내부 이동 (드래그앤드롭)
  const moveEntry = (src: string, destDir: string): void => {
    window.lt.fs.move(src, destDir).then((r) => {
      if (r.ok) setTreeRefresh((n) => n + 1)
      else if (r.error) console.warn('[move]', r.error)
    })
  }

  // 파일/폴더 삭제 (확인은 FileTree에서 받음) — 삭제 후 트리 새로고침 + 해당 문서 탭 닫기
  const deleteEntry = (path: string): void => {
    window.lt.fs.delete(path).then((r) => {
      if (!r.ok) {
        if (r.error) window.alert('삭제 실패: ' + r.error)
        return
      }
      setTreeRefresh((n) => n + 1)
      // 삭제된 파일(또는 폴더 하위)을 열어둔 문서 탭이 있으면 닫는다
      setDocTabs((tabs) => {
        const dead = tabs.filter((t) => t.path && (t.path === path || t.path.startsWith(path + '/') || t.path.startsWith(path + '\\')))
        if (dead.length === 0) return tabs
        let next = tabs
        for (const d of dead) next = closeTab(next, d.id, activeDoc, setActiveDoc)
        return next
      })
    })
  }

  // 탐색기 인라인 생성: 버튼 → 트리에 입력칸 표시
  const newFile = (): void => (activeDraftsFolder ? setPendingCreate('file') : addDoc())
  const newFolder = (): void => {
    if (activeDraftsFolder) setPendingCreate('folder')
  }

  const onCreateEntry = (name: string, type: 'file' | 'folder'): void => {
    setPendingCreate(null)
    const dir = activeDraftsFolder
    if (!dir) return
    const n = name.trim()
    if (type === 'folder') {
      if (n) window.lt.fs.mkdir(dir, n).then(() => setTreeRefresh((x) => x + 1))
      return
    }
    // 파일: 이름 없으면 무제 스크래치(저장 시 이름 물어봄)
    if (!n) {
      const id = `doc-${++docSeq}`
      setDocTabs((t) => [...t, { id, title: '무제.md', kind: 'mdview', side: 'left' }])
      setActiveDoc(id)
      setWorkActive('left', docKey(id))
      return
    }
    const fn = /\.[^.]+$/.test(n) ? n : n + '.md'
    window.lt.fs.createFile(dir, fn).then((r) => {
      if (r.ok && r.path) {
        setTreeRefresh((x) => x + 1)
        openFile(r.path, r.path.split(/[\\/]/).pop() ?? fn)
      }
    })
  }

  const activePdfPath = activeDocTab?.kind === 'pdf' ? activeDocTab.path : undefined
  const outlineRecord = pdfRecord && pdfRecord.path === activePdfPath ? pdfRecord.parsed : null
  // 패널 표시: 소송기록 폴더 분류(우선) → 없으면 열린 PDF의 목차
  const panelRecord = folderRecord ?? outlineRecord

  // 활성 PDF가 바뀌면 이전 점프 신호 제거 (새 뷰어에 stale 점프 방지)
  useEffect(() => {
    setPdfJump(undefined)
  }, [activePdfPath])

  // 소송기록 폴더의 PDF 파일명 파싱 → 문서/서증/첨부 분류
  useEffect(() => {
    if (!isViewer || !activeRecordsFolder) {
      setFolderRecord(null)
      return
    }
    let alive = true
    window.lt.fs.listPdfs(activeRecordsFolder).then((files) => {
      if (alive) setFolderRecord(parseRecordFiles(files))
    })
    return () => {
      alive = false
    }
  }, [isViewer, activeRecordsFolder, treeRefresh])

  // 문서(파일) 순서: 본안 → 서증 → 첨부
  const recordOrder: OutlineItem[] = panelRecord
    ? [...panelRecord.documents, ...panelRecord.evidences, ...panelRecord.attachments].filter(
        (it) => it.path
      )
    : []
  const recordItems = recordOrder.map((it) => ({ path: it.path as string, label: it.label }))

  // 목록 항목 열기: 폴더 기록이면 그 문서를 '새 탭'으로 열기(이미 열렸으면 포커스),
  // 단일 PDF 목차면 현재 PDF 페이지 점프.
  const onOpenItem = (it: OutlineItem): void => {
    if (it.path) openFile(it.path, it.label)
    else if (it.page > 0) jumpToPage(it.page)
  }

  // 임의 터미널에 bracketed paste로 텍스트 주입 (줄바꿈이 바로 제출되지 않게).
  const pasteToTerm = (termId: string, payload: string): void => {
    const tab = termTabs.find((t) => t.id === termId)
    setActiveTerm(termId)
    setWorkActive(termSide(tab), termKeyOf(termId))
    setTermFocusNonce((n) => ({ ...n, [termId]: (n[termId] ?? 0) + 1 }))
    window.lt.pty.write(termId, `\x1b[200~${normalizePasteForPty(payload)}\x1b[201~`)
  }

  // Claude 질문 전송: 이 창에 터미널이 있으면 직접, 없으면(문서 전용 창) 메인 창 터미널로 IPC 전달.
  const activeTermRef = useRef(activeTerm)
  activeTermRef.current = activeTerm
  const sendClaude = (payload: string): void => {
    if (activeTerm) pasteToTerm(activeTerm, payload)
    else window.lt.claude.ask(payload)
  }
  // 메인 창: 다른 창에서 온 Claude 질문을 활성 터미널에 주입.
  useEffect(
    () =>
      window.lt.claude.onIncoming((payload) => {
        const term = activeTermRef.current
        if (term) pasteToTerm(term, payload)
      }),
    []
  )

  // 파일 1개를 "물어보기" 형태로 전송 (경로 포함 → claude가 실제 파일을 읽음).
  const askAboutFile = (termId: string, path: string, label: string): void => {
    pasteToTerm(termId, `「${label}」(${path}) 파일에 대해 `)
  }

  // 활성 문서명+경로 + (있으면) 선택 텍스트로 claude 프롬프트 주입. 텍스트 없으면 문서 전체에 대해 묻기.
  const askClaude = (text: string): void => {
    const d = docTabs.find((x) => x.id === activeDoc)
    const docName = d?.title
    const docPath = d?.path
    const ref = docName ? `「${docName}」${docPath ? `(${docPath})` : ''}` : ''
    const t = text.trim()
    let payload: string
    if (t) {
      payload = ref ? `${ref} 중 다음 부분:\n"${t}"\n\n` : `"${t}"\n\n`
    } else if (docName) {
      payload = `${ref} 파일에 대해 `
    } else return
    sendClaude(payload)
  }

  const sendMarkdownToJuriSupport = (doc: MarkdownDocumentPayload): void => {
    const prompt = buildJuriSupportLegalDocumentPrompt(doc, {
      caseId: activeTermTab?.jsId ?? currentCase?.meta?.jsId,
      court: activeTermTab?.court ?? currentCase?.meta?.court,
      caseNumber: activeTermTab?.caseNumber ?? currentCase?.meta?.caseNumber,
      caseName: activeTermTab?.caseName ?? currentCase?.meta?.caseName,
      client: activeTermTab?.client ?? currentCase?.meta?.client
    })
    sendClaude(prompt)
  }

  // ── 사건 대시보드 동작 ──
  // 토큰 변경 등으로 좌측 '다가오는 기일' 패널을 새로고침하기 위한 nonce
  const [jsNonce, setJsNonce] = useState(0)
  // 세션 목록 드롭다운 + 사건 필터('all' | jsId | '__folder__')
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  // claude 완료 주목 표시가 필요한 터미널 id 집합 + 진행중/완료 상태
  const [termAttention, setTermAttention] = useState<Set<string>>(new Set())
  const [termStatus, setTermStatus] = useState<Map<string, 'working' | 'done' | 'question'>>(
    new Map()
  )
  const [toasts, setToasts] = useState<{ key: number; termId: string; title: string }[]>([])

  // Ctrl+W 등으로 터미널 닫기 — claude가 작업 중이면 확인 후 닫는다.
  const closeTermWithConfirm = (id: string): void => {
    if (termStatus.get(id) === 'working') {
      if (!window.confirm('claude가 아직 작업 중입니다. 이 터미널을 닫을까요?')) return
    }
    closeTerm(id)
  }
  closeActiveTermRef.current = (): void => {
    if (activeTerm) closeTermWithConfirm(activeTerm)
  }

  const caseRef = (c: JsCase): string => `${c.caseNumber ?? ''} ${c.caseName ?? ''}`.trim() || c.id

  // 폴더명 자동 매칭 (사건번호 우선 → 사건명/당사자명 부분일치)
  const matchCaseFolder = async (root: string, c: JsCase): Promise<string | undefined> => {
    try {
      const list = await window.lt.fs.list(root)
      const dirs = list.filter((e) => e.isDir)
      const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
      if (c.caseNumber) {
        const no = norm(c.caseNumber)
        const hit = dirs.find((d) => norm(d.name).includes(no))
        if (hit) return hit.path
      }
      const keys = [c.caseName, ...c.parties.map((p) => p.party.name)]
        .filter(Boolean)
        .map((s) => norm(s as string))
        .filter((s) => s.length >= 2)
      const hit = dirs.find((d) => keys.some((k) => norm(d.name).includes(k)))
      return hit?.path
    } catch {
      return undefined
    }
  }

  // 좌클릭: 사건 작업환경 열기 (폴더 매칭 → 없으면 직접 지정 → 터미널/뷰어 연결)
  const openCaseWorkspace = async (c: JsCase): Promise<void> => {
    const saved = await window.lt.case.getJsPairing(c.id)
    let drafts = saved?.drafts
    let records = saved?.records
    if (!drafts && draftsRoot) drafts = await matchCaseFolder(draftsRoot, c)
    if (!records && recordsRoot) records = await matchCaseFolder(recordsRoot, c)
    if (!drafts) {
      // 자동 매칭 실패 → 사용자가 직접 작성서류 폴더 지정
      const picked = await window.lt.dialog.pickFolder({
        title: `「${caseRef(c)}」 작성서류 폴더 선택`,
        defaultPath: draftsRoot
      })
      if (!picked) return
      drafts = picked.path
    }
    await window.lt.case.setJsPairing(c.id, drafts, records)
    // 세션 자동 명명: 법원(약칭) · 사건번호 · 사건명
    const court = c.court || ''
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const name =
      [court && abbrevCourt(court), c.caseNumber, c.caseName, client].filter(Boolean).join(' ') ||
      caseRef(c)
    const meta: CaseMeta = {
      jsId: c.id,
      court: court || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined
    }
    setCurrentCase({ drafts, records, name, meta })
    const existing = termTabs.find((t) => t.cwd === drafts || (t.jsId && t.jsId === c.id))
    if (existing) {
      activateTermTab(existing.id)
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === existing.id
            ? { ...t, ...meta, title: name, recordsFolder: records ?? t.recordsFolder }
            : t
        )
      )
    } else {
      createCase(drafts, name, records, undefined, meta)
    }
    setMode('explorer')
  }

  // 우클릭: 사건을 원격(SSH 프로필)에서 열기 — 원격 draftsRoot에서 폴더명 매칭, 실패 시 수동 선택.
  const [remoteCasePick, setRemoteCasePick] = useState<{
    profile: SshProfile
    name: string
    meta: CaseMeta
  } | null>(null)
  const openCaseRemote = async (c: JsCase, profile: SshProfile): Promise<void> => {
    const court = c.court || ''
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const name =
      [court && abbrevCourt(court), c.caseNumber, c.caseName, client].filter(Boolean).join(' ') ||
      caseRef(c)
    const meta: CaseMeta = {
      jsId: c.id,
      court: court || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined
    }
    // 원격 작성서류 루트에서 폴더명(사건번호/당사자) 자동 매칭
    let matchedUri: string | undefined
    if (profile.draftsRoot) {
      matchedUri = await matchCaseFolder(remoteUri(profile.id, profile.draftsRoot), c)
    }
    if (matchedUri) {
      const remotePath = remotePlain(matchedUri, profile.id)
      const opened = createRemoteCase(profile, remotePath, name, meta)
      // 소송기록 매칭은 터미널을 먼저 띄운 뒤 붙인다. SFTP/키 문제로 터미널 생성이 막히면 안 된다.
      resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title, c)
      setMode('explorer')
    } else {
      // 작성서류 매칭 실패 → 폴더 선택기로 직접 지정 (소송기록은 picker onPick에서 resolve)
      setRemoteCasePick({ profile, name, meta })
    }
  }

  // 우클릭: Claude에 사건 브리핑 요청
  const briefCaseToClaude = (c: JsCase): void => {
    sendClaude(
      `「${caseRef(c)}」 사건(JuriSupport id: ${c.id})의 다가오는 기일과 진행상황을 정리해줘.\n`
    )
  }
  // 우클릭: 준비서면 초안 시작 (/brief-protocol 슬래시커맨드)
  const draftCaseWithClaude = (c: JsCase): void => {
    sendClaude(`/brief-protocol ${caseRef(c)} `)
  }

  // 탐색기/외부에서 터미널로 드래그드롭한 파일들을 그 터미널 프롬프트에 주입.
  const dropFilesToTerm = (termId: string, paths: string[]): void => {
    if (!paths.length) return
    const tab = termTabs.find((t) => t.id === termId)
    setActiveTerm(termId)
    setWorkActive(termSide(tab), termKeyOf(termId))
    if (paths.length === 1) {
      const p = paths[0]
      askAboutFile(termId, p, p.split(/[\\/]/).pop() ?? p)
    } else {
      pasteToTerm(termId, `다음 파일들에 대해:\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`)
    }
  }

  // 탭 드래그 중 여부 — 창 전체에서 '이동' 커서를 보이게 해 '금지' 표시를 막는다.
  const [tabDragging, setTabDragging] = useState(false)
  // 탭 드래그 중일 때 셸 어디서든 dragover를 허용(이동 커서) — 실제 찢기는 onDragEnd가 처리.
  const shellDragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!tabDragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: React.DragEvent) => {
      if (tabDragging) e.preventDefault()
    }
  }

  // 본문(문서) 렌더 — 좌/우 작업 영역과 '문서 전용 창'에서 재사용
  const renderDocContent = (tab?: DocTab): ReactNode => (
    <>
      {!tab && <Empty label="열린 문서가 없습니다" actionLabel="새 문서" onAction={() => addDoc('left')} />}
      {tab?.kind === 'welcome' && <Welcome recent={recent} onOpen={openRecent} />}
      {tab?.kind === 'markdown' && <DocPlaceholder title={tab.title} />}
      {tab?.kind === 'file' && <FileView key={tab.path} path={tab.path as string} />}
      {tab?.kind === 'image' && (
        <ImageViewer
          key={tab.path}
          path={tab.path as string}
          onNavigate={(dir) => navigateImage(tab.path as string, dir)}
        />
      )}
      {tab?.kind === 'hwp' && <HwpView key={tab.path} path={tab.path as string} />}
      {tab?.kind === 'csv' && <CsvView key={tab.path} path={tab.path as string} />}
      {tab?.kind === 'mdview' && (
        <MarkdownEditor
          key={tab.id}
          path={tab.path}
          defaultDir={draftsRoot}
          onPath={(p) => setDocPath(tab.id, p)}
          onAsk={() => askClaude('')}
          onSendToJuriSupport={sendMarkdownToJuriSupport}
          onDirty={(d) =>
            setDirtyDocs((s) => {
              const has = s.has(tab.id)
              if (d === has) return s
              const n = new Set(s)
              if (d) n.add(tab.id)
              else n.delete(tab.id)
              return n
            })
          }
        />
      )}
      {tab?.kind === 'pdf' &&
        (recordItems.some((i) => i.path === tab.path) ? (
          <RecordViewer
            key={tab.id}
            items={recordItems}
            startPath={tab.path as string}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onCurrent={(it) =>
              setDocTabs((tabs) =>
                tabs.map((t) => (t.id === tab.id ? { ...t, path: it.path, title: it.label } : t))
              )
            }
            onAskDoc={() => askClaude('')}
          />
        ) : (
          <PdfViewer
            key={tab.path}
            path={tab.path as string}
            onOutline={onOutline}
            jumpTo={pdfJump}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onAskDoc={() => askClaude('')}
          />
        ))}
      {tab?.kind === 'settings' && <SettingsView />}
    </>
  )

  const docTabBar = (
    <TabBar
      tabs={docTabs.map((t) => ({
        id: t.id,
        title: t.title,
        tooltip: t.path,
        path: t.path,
        dragPayload: t.path
          ? ({ kind: 'doc', path: t.path, title: t.title, side: docSide(t) } as TabPayload)
          : undefined
      }))}
      activeId={activeDoc}
      onSelect={activateDocTab}
      onClose={closeDoc}
      onAdd={() => addDoc('left')}
      addTitle="새 문서"
      onReorder={reorderDocs}
      onTearOut={closeDoc}
      onDragActive={setTabDragging}
    />
  )

  const docsPanel = (
    <DocsPanel
      key="docs"
      mode={mode}
      draftsFolder={activeDraftsFolder}
      recordsFolder={activeRecordsFolder}
      suggestedRecords={activeSuggestedRecords}
      record={panelRecord}
      refreshNonce={treeRefresh}
      onOpenFile={openFile}
      onDropTo={copyFilesTo}
      onMove={moveEntry}
      onDelete={deleteEntry}
      onPasteTo={pasteFilesTo}
      onDownload={downloadEntry}
      onPickRecords={pickRecords}
      onApplySuggested={applySuggested}
      onOpenItem={onOpenItem}
      onDropFiles={onDropFiles}
      onNewFolder={newFolder}
      onNewFile={newFile}
      onSync={sshProfiles.length > 0 ? openSync : undefined}
      onOpenWorkspace={() => void openConnOrLocal()}
      onOpenCase={openCaseWorkspace}
      jsNonce={jsNonce}
      pendingCreate={pendingCreate}
      onCreateEntry={onCreateEntry}
      onCancelCreate={() => setPendingCreate(null)}
    />
  )

  const terminalPanel = (
    <div className="term-col" key="terminal">
      <TabBar
        tabs={termTabs.map((t) => ({
          id: t.id,
          title: t.renamed
            ? t.title
            : t.sessionTitle
              ? `${t.title} · ${t.sessionTitle}`
              : t.title,
          attention: termAttention.has(t.id) && termStatus.get(t.id) !== 'question',
          working: termStatus.get(t.id) === 'working',
          question: termStatus.get(t.id) === 'question' && termAttention.has(t.id),
          renamable: true,
          dragPayload: { kind: 'terminal', tab: { ...t } } as TabPayload,
          tooltip: [
            t.ssh && `🔗 ${t.sshLabel ?? '원격'} (${t.ssh.user}@${t.ssh.host})`,
            t.court && `${t.court}`,
            t.caseNumber,
            t.caseName,
            t.client && `의뢰인 ${t.client}`,
            t.cwd
          ]
            .filter(Boolean)
            .join('\n')
        }))}
        activeId={activeTerm}
        onSelect={selectTerm}
        onClose={closeTerm}
        onAdd={() => addTermSame()}
        addTitle="새 터미널"
        onReorder={reorderTerms}
        onTearOut={detachTerm}
        onDragActive={setTabDragging}
        onRename={(id, title) =>
          setTermTabs((tabs) =>
            tabs.map((t) => (t.id === id ? { ...t, title, renamed: true } : t))
          )
        }
        extraLeft={[
          {
            label: '☰',
            title: '세션 목록',
            active: sessionListOpen,
            onClick: () => {
              const cur = termTabs.find((t) => t.id === activeTerm)
              setSessionFilter(cur?.jsId ?? sessionCaseSource?.jsId ?? 'all')
              setSessionListOpen((v) => !v)
            }
          }
        ]}
        extra={{
          icon: <IconWorkspace size={15} />,
          title: '새 작업환경 열기',
          onClick: () => void openConnOrLocal()
        }}
      />
      {sessionListOpen && (
        <SessionList
          sessions={termTabs}
          activeId={activeTerm}
          filter={sessionFilter}
          onFilter={setSessionFilter}
          caseCwd={sessionCaseSource?.cwd ?? currentCase?.drafts}
          caseSource={sessionCaseSource}
          onSelect={(id) => {
            selectTerm(id)
            setSessionListOpen(false)
          }}
          onResume={(sid, cwd, title, source) => {
            openPastSession(sid, cwd, title, source)
            setSessionListOpen(false)
          }}
          onClose={() => setSessionListOpen(false)}
        />
      )}
      <div className="term-stack">
        {termTabs.length === 0 &&
          (currentCase ? (
            <Empty
              label={`「${currentCase.name}」 — 터미널이 모두 닫혔습니다`}
              actionLabel="이 사건에서 터미널 열기"
              onAction={addTermSame}
              secondaryLabel="✕ 사건 지정 해제"
              onSecondary={clearCase}
            />
          ) : (
            <Empty
              label="사건 폴더를 열어 시작하세요 (작성문서 또는 사건기록 폴더)"
              actionLabel="사건 폴더 열기"
              onAction={() => void openConnOrLocal()}
              secondaryLabel="새 작업환경 만들기"
              onSecondary={openNewWorkspaceWindow}
            />
          ))}
        {termTabs.map((t) => (
          <div
            key={t.id}
            className="term-pane"
            style={{ display: t.id === activeTerm ? 'block' : 'none' }}
          >
            <Terminal
              id={t.id}
              cwd={t.cwd}
              autoClaude={t.autoClaude ?? false}
              resumeSessionId={t.resumeSessionId}
              ssh={t.ssh}
              visible={t.id === activeTerm}
              focusNonce={termFocusNonce[t.id] ?? 0}
              onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
              onNewTerminal={() => addTermSame(termSide(t))}
              onRequestClose={() => closeTermWithConfirm(t.id)}
              onStatus={(s) => onTermStatus(t.id, s)}
              onCycleTab={cycleTerm}
            />
          </div>
        ))}
      </div>
    </div>
  )

  const renderWorkPane = (side: DockSide): ReactNode => {
    if (side === 'left' && mode === 'cases') {
      return (
        <div className="work-pane work-left" key="cases">
          <CasesDashboard
            onOpenWorkspace={openCaseWorkspace}
            onOpenRemote={openCaseRemote}
            sshProfiles={sshProfiles}
            defaultOpenProfileId={defaultCaseOpenProfileId}
            onBrief={briefCaseToClaude}
            onDraft={draftCaseWithClaude}
            onChanged={() => setJsNonce((n) => n + 1)}
          />
        </div>
      )
    }

    const docs = docTabs.filter((t) => docSide(t) === side)
    const terms = termTabs.filter((t) => termSide(t) === side)
    const workTabs = [
      ...docs.map((t) => ({
        id: docKey(t.id),
        title: t.title,
        tooltip: t.path,
        path: t.path,
        dragPayload: t.path
          ? ({ kind: 'doc', path: t.path, title: t.title, side } as TabPayload)
          : undefined
      })),
      ...terms.map((t) => ({
        id: termKeyOf(t.id),
        title: t.renamed
          ? t.title
          : t.sessionTitle
            ? `${t.title} · ${t.sessionTitle}`
            : t.title,
        attention: termAttention.has(t.id) && termStatus.get(t.id) !== 'question',
        working: termStatus.get(t.id) === 'working',
        question: termStatus.get(t.id) === 'question' && termAttention.has(t.id),
        renamable: true,
        dragPayload: { kind: 'terminal', tab: { ...t, side } } as TabPayload,
        tooltip: [
          t.ssh && `🔗 ${t.sshLabel ?? '원격'} (${t.ssh.user}@${t.ssh.host})`,
          t.court && `${t.court}`,
          t.caseNumber,
          t.caseName,
          t.client && `의뢰인 ${t.client}`,
          t.cwd
        ]
          .filter(Boolean)
          .join('\n')
      }))
    ]
    const activeKey = workTabs.some((t) => t.id === activeWork[side])
      ? activeWork[side]
      : (workTabs[0]?.id ?? '')
    const activeParsed = parseWorkKey(activeKey)
    const activeDocForPane =
      activeParsed?.kind === 'doc' ? docs.find((t) => t.id === activeParsed.id) : undefined
    const visibleTermId = activeParsed?.kind === 'terminal' ? activeParsed.id : ''
    const hasTerms = terms.length > 0
    const sessionListSide = termSide(activeTermTab)
    const canOpenSessionList = hasTerms || (side === sessionListSide && !!sessionCaseSource)

    return (
      <div className={`work-pane work-${side}`} key={side}>
        <TabBar
          tabs={workTabs}
          activeId={activeKey}
          onSelect={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') activateDocTab(parsed.id)
            else selectTerm(parsed.id)
          }}
          onClose={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') closeDoc(parsed.id)
            else closeTerm(parsed.id)
          }}
          onAdd={() => addDoc(side)}
          addTitle="새 문서"
          onReorder={(from, to) => {
            const f = parseWorkKey(from)
            const t = parseWorkKey(to)
            if (!f || !t || f.kind !== t.kind) return
            if (f.kind === 'doc') reorderDocs(f.id, t.id)
            else reorderTerms(f.id, t.id)
          }}
          onTearOut={(key) => {
            const parsed = parseWorkKey(key)
            if (!parsed) return
            if (parsed.kind === 'doc') closeDoc(parsed.id)
            else detachTerm(parsed.id)
          }}
          onDragActive={setTabDragging}
          onRename={(key, title) => {
            const parsed = parseWorkKey(key)
            if (parsed?.kind !== 'terminal') return
            setTermTabs((tabs) =>
              tabs.map((t) => (t.id === parsed.id ? { ...t, title, renamed: true } : t))
            )
          }}
          extraLeft={[
            ...(activeKey
              ? [
                  {
                    label: side === 'left' ? '⇥' : '⇤',
                    title: side === 'left' ? '활성 탭 오른쪽으로 이동' : '활성 탭 왼쪽으로 이동',
                    onClick: () => moveWorkTabToSide(activeKey, otherSide(side))
                  }
                ]
              : []),
            ...(canOpenSessionList
              ? [
                  {
                    label: '☰',
                    title: '세션 목록',
                    active: sessionListOpen && side === sessionListSide,
                    onClick: () => {
                      const cur =
                        terms.find((t) => t.id === activeTerm) ??
                        terms[0]
                      if (cur) {
                        setActiveTerm(cur.id)
                        setWorkActive(side, termKeyOf(cur.id))
                        setSessionFilter(cur.jsId ?? 'all')
                      } else {
                        setSessionFilter(sessionCaseSource?.jsId ?? 'all')
                      }
                      setSessionListOpen((v) => !(v && side === sessionListSide))
                    }
                  }
                ]
              : [])
          ]}
          extra={[
            {
              label: '＋T',
              title: '새 터미널',
              onClick: () => addTermSame(side)
            },
            {
              icon: <IconWorkspace size={15} />,
              title: '새 작업환경 열기',
              onClick: () => void openConnOrLocal()
            }
          ]}
        />
        {sessionListOpen && side === sessionListSide && (
          <SessionList
            sessions={termTabs}
            activeId={activeTerm}
            filter={sessionFilter}
            onFilter={setSessionFilter}
            caseCwd={sessionCaseSource?.cwd ?? currentCase?.drafts}
            caseSource={sessionCaseSource}
            onSelect={(id) => {
              selectTerm(id)
              setSessionListOpen(false)
            }}
            onResume={(sid, cwd, title, source) => {
              openPastSession(sid, cwd, title, source, side)
              setSessionListOpen(false)
            }}
            onClose={() => setSessionListOpen(false)}
          />
        )}
        <div className="work-content">
          {workTabs.length === 0 &&
            (side === 'right' ? (
              currentCase ? (
                <Empty
                  label={`「${currentCase.name}」 — 오른쪽에 열린 탭이 없습니다`}
                  actionLabel="이 사건에서 터미널 열기"
                  onAction={() => addTermSame(side)}
                  secondaryLabel="새 문서"
                  onSecondary={() => addDoc(side)}
                />
              ) : (
                <Empty
                  label="오른쪽에 열린 탭이 없습니다"
                  actionLabel="터미널 열기"
                  onAction={() => addTermSame(side)}
                  secondaryLabel="새 문서"
                  onSecondary={() => addDoc(side)}
                />
              )
            ) : (
              <Empty label="왼쪽에 열린 탭이 없습니다" actionLabel="새 문서" onAction={() => addDoc(side)} />
            ))}
          {activeDocForPane && (
            <div className="doc-content" onMouseDown={() => activateDocTab(activeDocForPane.id)}>
              {renderDocContent(activeDocForPane)}
            </div>
          )}
          {terms.map((t) => (
            <div
              key={t.id}
              className="term-pane"
              style={{ display: t.id === visibleTermId ? 'block' : 'none' }}
            >
              <Terminal
                id={t.id}
                cwd={t.cwd}
                autoClaude={t.autoClaude ?? false}
                resumeSessionId={t.resumeSessionId}
                ssh={t.ssh}
                visible={t.id === visibleTermId}
                focusNonce={termFocusNonce[t.id] ?? 0}
                onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                onNewTerminal={() => addTermSame(side)}
                onRequestClose={() => closeTermWithConfirm(t.id)}
                onStatus={(s) => onTermStatus(t.id, s)}
                onCycleTab={cycleTerm}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // 탭을 창 밖으로 찢어낸 '문서 전용 창': 터미널·탐색기·액티비티바 없이 문서만.
  if (docOnly) {
    return (
      <div className="shell-doconly" {...shellDragProps}>
        <div className="body-col">
          {docTabBar}
          <div className="doc-content">{renderDocContent(activeDocTab)}</div>
        </div>
        <SelectionAsk onAsk={askClaude} />
        <SelectionMenu onAsk={askClaude} />
      </div>
    )
  }

  if (termOnly) {
    return (
      <div className="shell-terminalonly" {...shellDragProps}>
        {terminalPanel}
        <div className="statusbar">
          <span className="status-left">legal-terminal · 터미널</span>
          <span className="status-right">{info}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`shell ${isViewer ? 'mode-viewer' : 'mode-default'}`}
      {...shellDragProps}
    >
      {/* ── 액티비티바 (모드 전환) ── */}
      <div className="activitybar" key="activity">
        <div className="activitybar-top">
          {ACTIVITY.map((item) => (
            <button
              key={item.id}
              className={`activity-item ${mode === item.id ? 'active' : ''}`}
              title={item.label}
              onClick={() => setMode(item.id)}
            >
              <item.Icon />
            </button>
          ))}
        </div>
        <div className="activitybar-bottom">
          <button
            className="activity-item"
            title="작업환경 저장 (Shift: 파일로 내보내기)"
            onClick={(e) => void saveWorkspace(e.shiftKey)}
          >
            <IconSave />
          </button>
          <button
            className="activity-item"
            title="작업환경 복원 (Shift: 파일에서 가져오기)"
            onClick={(e) => void restoreWorkspace(e.shiftKey)}
          >
            <IconSync />
          </button>
          <button className="activity-item" title="새 작업환경 만들기" onClick={openNewWorkspaceWindow}>
            <IconWorkspace />
          </button>
          <button className="activity-item" title="설정" onClick={openSettings}>
            <IconSettings />
          </button>
        </div>
      </div>

      <div className="side-col" key="side">
        {docsPanel}
      </div>

      {renderWorkPane('left')}

      {/* ── 서증·첨부서류 (뷰어 모드에서만) ── */}
      {isViewer && <EvidencePanel key="evid" record={panelRecord} onOpenItem={onOpenItem} />}

      {renderWorkPane('right')}

      <div className="statusbar" key="status">
        <span className="status-left">legal-terminal · {modeLabel(mode)}</span>
        <span className="status-right">{info}</span>
      </div>

      <SelectionAsk onAsk={askClaude} />
      <SelectionMenu onAsk={askClaude} />

      {/* 접속 선택 (로컬 / 저장된 SSH 프로필) */}
      {connMenu && (
        <ConnMenu
          profiles={sshProfiles}
          onLocal={() => {
            setConnMenu(false)
            void addTerm()
          }}
          onRemote={(p) => {
            setConnMenu(false)
            setRemotePick(p)
          }}
          onManage={() => {
            setConnMenu(false)
            openSettings()
          }}
          onClose={() => setConnMenu(false)}
        />
      )}

      {/* 원격 사건(작성서류) 폴더 선택 */}
      {remotePick && (
        <RemoteFolderPicker
          profile={remotePick}
          onCancel={() => setRemotePick(null)}
          onPick={async (remotePath) => {
            const prof = remotePick
            setRemotePick(null)
            const opened = createRemoteCase(prof, remotePath)
            resolveRemoteRecordsLater(opened.id, prof, remotePath, opened.title)
          }}
        />
      )}

      {/* 사건(JuriSupport) 원격 열기 — 자동 매칭 실패 시 폴더 직접 선택 */}
      {remoteCasePick && (
        <RemoteFolderPicker
          profile={remoteCasePick.profile}
          title={`「${remoteCasePick.name}」 작성서류 폴더 선택`}
          onCancel={() => setRemoteCasePick(null)}
          onPick={async (remotePath) => {
            const { profile, name, meta } = remoteCasePick
            setRemoteCasePick(null)
            const opened = createRemoteCase(profile, remotePath, name, meta)
            resolveRemoteRecordsLater(opened.id, profile, remotePath, opened.title)
            setMode('explorer')
          }}
        />
      )}

      {/* rclone 동기화 모달 */}
      {syncInit && (
        <SyncModal
          profiles={sshProfiles}
          init={syncInit}
          onClose={() => setSyncInit(null)}
        />
      )}

      {/* 원격 소송기록 폴더 선택 (기록뷰어) */}
      {recordsPick && (
        <RemoteFolderPicker
          profile={recordsPick.profile}
          title="소송기록 폴더 선택"
          confirmLabel="이 폴더로 지정"
          startPath={recordsPick.startPath}
          onCancel={() => setRecordsPick(null)}
          onPick={(remotePath) => {
            const uri = remoteUri(recordsPick.profile.id, remotePath)
            const cur = termTabs.find((t) => t.id === activeTerm)
            setTermTabs((tabs) =>
              tabs.map((t) => (activeTerm && t.id === activeTerm ? { ...t, recordsFolder: uri } : t))
            )
            setCurrentCase((c) => (c ? { ...c, records: uri } : c))
            // 페어링 기억 → 다음에 이 사건을 열면 자동 적용
            const draftsPath = recordsPick.draftsPath ?? (cur?.ssh ? cur.cwd : undefined)
            if (draftsPath) {
              const drafts = remoteUri(recordsPick.profile.id, draftsPath)
              window.lt.case.setPairing(drafts, uri)
              window.lt.case
                .addHistory({ drafts, records: uri, name: recordsPick.title ?? cur?.title ?? '사건' })
                .then(setRecent)
            }
            setRecordsPick(null)
          }}
        />
      )}

      {/* claude 질문/확인 대기 팝업 */}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div
              key={t.key}
              className="toast"
              onClick={() => {
                selectTerm(t.termId)
                dismissToast(t.key)
              }}
            >
              <span className="toast-icon">❓</span>
              <span className="toast-body">
                <b>{t.title}</b>
                <span className="toast-sub">claude가 확인/입력을 기다립니다 — 클릭하여 이동</span>
              </span>
              <button
                className="toast-x"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissToast(t.key)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 본문에서 텍스트 선택 후 우클릭 → 컨텍스트 메뉴 (Claude/법제처/법고을/엘박스)
function SelectionMenu({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const onCtx = (e: MouseEvent): void => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      const node = sel?.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!text || !el?.closest?.('.work-pane, .body-col')) return // 선택 없으면 기본 메뉴
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, text })
    }
    const close = (): void => setMenu(null)
    document.addEventListener('contextmenu', onCtx)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('contextmenu', onCtx)
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  if (!menu) return null
  const q = encodeURIComponent(menu.text)
  const open = (url: string): void => void window.lt.app.openExternal(url)
  const items: { label: string; act: () => void }[] = [
    { label: '✳ Claude에 물어보기', act: () => onAsk(menu.text) },
    { label: '법제처 검색', act: () => open(`https://www.law.go.kr/LSW/lsSc.do?menuId=1&query=${q}`) },
    {
      label: '법고을 검색',
      act: () => open(`https://lx.scourt.go.kr/sc/krcom/sc/cs/search/cmmnSearchList.do?searchWord=${q}`)
    },
    { label: '엘박스 검색', act: () => open(`https://lbox.kr/search?query=${q}`) }
  ]
  return (
    <ul
      className="ctx-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 150) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <li
          key={i}
          className="ctx-item"
          onClick={() => {
            it.act()
            setMenu(null)
          }}
        >
          {it.label}
        </li>
      ))}
    </ul>
  )
}

// 본문에서 텍스트를 드래그 선택하면 떠오르는 "Claude에 묻기" 버튼
function SelectionAsk({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [box, setBox] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const onUp = (): void => {
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      if (!sel || sel.rangeCount === 0 || !text.trim()) {
        setBox(null)
        return
      }
      const node = sel.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!el?.closest?.('.work-pane, .body-col')) {
        setBox(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setBox(null)
        return
      }
      setBox({ x: rect.left + rect.width / 2, y: rect.top - 6, text })
    }
    const onDown = (): void => setBox(null)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  if (!box) return null
  return (
    <button
      className="sel-ask"
      style={{ left: box.x, top: box.y }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={() => {
        onAsk(box.text)
        setBox(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      ✳ Claude에 묻기
    </button>
  )
}

function modeLabel(mode: Mode): string {
  return { explorer: '탐색기', cases: '사건', viewer: '기록뷰어' }[mode]
}

/** 탭 닫기 공통: 닫힌 탭이 활성이면 이웃으로 활성 이동 */
function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void
): T[] {
  const idx = tabs.findIndex((t) => t.id === id)
  const next = tabs.filter((t) => t.id !== id)
  if (id === activeId) setActive(next.length > 0 ? next[Math.min(idx, next.length - 1)].id : '')
  return next
}

// ── 좌측 문서 패널 (모드별) ──
// 탐색기 모드 = 작성서류 폴더 트리. 뷰어 모드 = 열린 PDF의 본안 문서 목차(없으면 소송기록 폴더 트리).
function DocsPanel({
  mode,
  draftsFolder,
  recordsFolder,
  suggestedRecords,
  record,
  refreshNonce,
  onOpenFile,
  onDropTo,
  onMove,
  onDelete,
  onPasteTo,
  onDownload,
  onPickRecords,
  onApplySuggested,
  onOpenItem,
  onDropFiles,
  onNewFolder,
  onNewFile,
  onSync,
  onOpenWorkspace,
  onOpenCase,
  jsNonce,
  pendingCreate,
  onCreateEntry,
  onCancelCreate
}: {
  mode: Mode
  draftsFolder?: string
  recordsFolder?: string
  suggestedRecords?: string
  record: ParsedRecord | null
  refreshNonce: number
  onOpenFile: (path: string, name: string) => void
  onDropTo: (dir: string, files: FileList) => void
  onMove: (src: string, destDir: string) => void
  onDelete: (path: string, name: string, isDir: boolean) => void
  onPasteTo: (dir: string) => void
  onDownload: (path: string, name: string, isDir: boolean) => void
  onPickRecords: () => void
  onApplySuggested: () => void
  onOpenItem: (it: OutlineItem) => void
  onDropFiles: (files: FileList) => void
  onNewFolder: () => void
  onNewFile: () => void
  onSync?: () => void
  onOpenWorkspace: () => void
  onOpenCase: (c: JsCase) => void
  jsNonce: number
  pendingCreate: 'file' | 'folder' | null
  onCreateEntry: (name: string, type: 'file' | 'folder') => void
  onCancelCreate: () => void
}): JSX.Element {
  const title = { explorer: '탐색기', cases: '다가오는 기일', viewer: '문서' }[mode]
  const [dragOver, setDragOver] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('name-asc')
  const [fileFindOpen, setFileFindOpen] = useState(false)
  const [fileFindQuery, setFileFindQuery] = useState('')
  const canDrop = mode === 'explorer' && !!draftsFolder
  const closeFileFind = (): void => {
    setFileFindOpen(false)
    setFileFindQuery('')
  }
  return (
    <div
      className={`sidebar ${dragOver ? 'drag-over' : ''}`}
      tabIndex={0}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement
        if (!target.closest('input, button, select')) e.currentTarget.focus()
      }}
      onKeyDown={(e) => {
        const primary = e.metaKey || e.ctrlKey
        if (mode !== 'explorer' || !primary || e.shiftKey || e.altKey) return
        if (e.key.toLowerCase() !== 'f') return
        e.preventDefault()
        e.stopPropagation()
        setFileFindOpen(true)
      }}
      onDragOver={(e) => {
        if (!canDrop) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!canDrop) return
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files)
      }}
    >
      <div className={`sidebar-header ${mode === 'explorer' ? 'explorer-header' : ''}`}>
        {mode === 'explorer' ? (
          <>
            <div className="sidebar-header-main">
              <span className="sidebar-title">{title}</span>
              <span className="header-actions explorer-actions">
                <button className="tool-btn" title="새 작업환경 열기" onClick={onOpenWorkspace}>
                  <IconWorkspace size={15} />
                  <span className="sr-only">새 작업환경 열기</span>
                </button>
                <button className="tool-btn" title="새 파일" disabled={!draftsFolder} onClick={onNewFile}>
                  <IconNewFile size={15} />
                  <span className="sr-only">새 파일</span>
                </button>
                <button
                  className={`tool-btn ${fileFindOpen ? 'on' : ''}`}
                  title="파일명 찾기"
                  disabled={!draftsFolder}
                  onClick={() => setFileFindOpen((v) => !v)}
                >
                  <IconSearch size={15} />
                  <span className="sr-only">파일명 찾기</span>
                </button>
                <button
                  className="tool-btn"
                  title="새 폴더"
                  disabled={!draftsFolder}
                  onClick={onNewFolder}
                >
                  <IconNewFolder size={15} />
                  <span className="sr-only">새 폴더</span>
                </button>
                {onSync && (
                  <button
                    className="tool-btn"
                    title="rclone 동기화 (로컬 ↔ 맥미니)"
                    disabled={!draftsFolder}
                    onClick={onSync}
                  >
                    <IconSync size={15} />
                    <span className="sr-only">동기화</span>
                  </button>
                )}
              </span>
            </div>
            <div className="explorer-sort-row">
              <select
                className="sort-select explorer-sort-select"
                value={sortMode}
                title="정렬"
                aria-label="탐색기 정렬"
                disabled={!draftsFolder}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {fileFindOpen && (
              <div className="explorer-find-row">
                <FindBar
                  value={fileFindQuery}
                  placeholder="파일명 찾기"
                  resultLabel={fileFindQuery.trim() ? '파일명' : ''}
                  onChange={setFileFindQuery}
                  onClose={closeFileFind}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <span className="sidebar-title">{title}</span>
            <span className="header-actions">
              {mode === 'viewer' && recordsFolder && (
                <button className="header-btn" title="소송기록 폴더 변경" onClick={onPickRecords}>
                  변경
                </button>
              )}
            </span>
          </>
        )}
      </div>
      <div className="sidebar-body">
        {mode === 'explorer' &&
          (draftsFolder ? (
            <FileTree
              root={draftsFolder}
              refreshNonce={refreshNonce}
              onOpenFile={onOpenFile}
              onDropTo={onDropTo}
              onMove={onMove}
              onDelete={onDelete}
              onPasteTo={onPasteTo}
              onDownload={onDownload}
              pendingCreate={pendingCreate}
              sortMode={sortMode}
              filter={fileFindOpen ? fileFindQuery : ''}
              onCreate={onCreateEntry}
              onCancelCreate={onCancelCreate}
            />
          ) : (
            <p className="muted pad">활성 사건이 없습니다. 오른쪽에서 사건 폴더를 여세요.</p>
          ))}
        {mode === 'viewer' &&
          (record ? (
            <>
              <CaseHeader record={record} />
              {record.documents.length ? (
                <OutlineList items={record.documents} onOpen={onOpenItem} />
              ) : (
                <p className="muted pad small">본안 문서가 없습니다.</p>
              )}
            </>
          ) : (
            <RecordsBody {...{ draftsFolder, suggestedRecords, onPickRecords, onApplySuggested }} />
          ))}
        {mode === 'cases' && <UpcomingHearings nonce={jsNonce} onPick={onOpenCase} />}
      </div>
    </div>
  )
}

// ── 서증·첨부서류 패널 (뷰어 모드) ──
function EvidencePanel({
  record,
  onOpenItem
}: {
  record: ParsedRecord | null
  onOpenItem: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <div className="evid-panel">
      <div className="sidebar-header">서증 · 첨부서류</div>
      <div className="sidebar-body">
        {record ? (
          <>
            <SectionLabel text={`서증 (${record.evidences.length})`} />
            {record.evidences.length ? (
              <OutlineList items={record.evidences} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">서증 없음</p>
            )}
            <SectionLabel text={`첨부서류 (${record.attachments.length})`} />
            {record.attachments.length ? (
              <OutlineList items={record.attachments} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">첨부서류 없음</p>
            )}
          </>
        ) : (
          <p className="muted pad">소송기록 폴더를 지정하면 서증·첨부서류가 분류됩니다.</p>
        )}
      </div>
    </div>
  )
}

// 법원·사건번호 한 줄 (상단 1회 표시)
function CaseHeader({ record }: { record: ParsedRecord }): JSX.Element {
  return (
    <div className="case-header">
      {[record.court, record.caseNo].filter(Boolean).join(' · ') || '사건 정보 없음'}
    </div>
  )
}

function SectionLabel({ text }: { text: string }): JSX.Element {
  return <div className="section-label">{text}</div>
}

// 목차/서증 항목 리스트 — 클릭 시 파일 열기(폴더 기반) 또는 페이지 점프(목차 기반)
function OutlineList({
  items,
  onOpen
}: {
  items: OutlineItem[]
  onOpen: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <ul className="outline-list">
      {items.map((it, i) => (
        <li
          key={i}
          className={`outline-item ${it.party ? 'party-' + it.party : ''}`}
          title={it.path ? `${it.rawTitle}\n(끌어서 터미널에 놓으면 Claude에 질문)` : it.rawTitle}
          onClick={() => onOpen(it)}
          draggable={!!it.path}
          onDragStart={
            it.path
              ? (e) => {
                  e.dataTransfer.setData(LT_PATH, it.path as string)
                  e.dataTransfer.effectAllowed = 'copyMove'
                }
              : undefined
          }
        >
          <span className="outline-label">{it.label}</span>
          {it.page > 0 && <span className="outline-page">{it.page}</span>}
        </li>
      ))}
    </ul>
  )
}

// 뷰어 모드: 소송기록 미지정 시 — 추천 폴더 제안(있으면) 또는 선택 버튼
function RecordsBody({
  draftsFolder,
  suggestedRecords,
  onPickRecords,
  onApplySuggested
}: {
  draftsFolder?: string
  suggestedRecords?: string
  onPickRecords: () => void
  onApplySuggested: () => void
}): JSX.Element {
  if (suggestedRecords)
    return (
      <div className="suggest pad">
        <p className="muted small">이전에 연결한 소송기록 폴더가 있습니다:</p>
        <p className="suggest-path">{suggestedRecords}</p>
        <div className="suggest-actions">
          <button className="empty-action" onClick={onApplySuggested}>
            이 폴더 열기
          </button>
          <button className="header-btn" onClick={onPickRecords}>
            다른 폴더…
          </button>
        </div>
      </div>
    )
  if (draftsFolder)
    return (
      <Empty
        label="이 사건의 소송기록 폴더가 지정되지 않았습니다"
        actionLabel="소송기록 폴더 선택"
        onAction={onPickRecords}
      />
    )
  return <p className="muted pad">사건을 먼저 여세요 (오른쪽 터미널의 ＋).</p>
}

interface TabBarProps {
  tabs: {
    id: string
    title: string
    tooltip?: string
    path?: string
    dragPayload?: TabPayload
    attention?: boolean
    working?: boolean
    question?: boolean
    renamable?: boolean
  }[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd?: () => void
  addTitle: string
  extra?:
    | { label?: string; icon?: ReactNode; title: string; onClick: () => void }
    | { label?: string; icon?: ReactNode; title: string; onClick: () => void }[]
  extraLeft?:
    | { label?: string; icon?: ReactNode; title: string; active?: boolean; onClick: () => void }
    | { label?: string; icon?: ReactNode; title: string; active?: boolean; onClick: () => void }[]
  // 탭 재정렬(같은 창) + 창 간 이동/찢기. 둘 다 주어질 때만 탭이 draggable.
  onReorder?: (fromId: string, toId: string) => void
  onTearOut?: (id: string) => void
  onDragActive?: (active: boolean) => void
  onRename?: (id: string, title: string) => void
}
function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onAdd,
  addTitle,
  extra,
  extraLeft,
  onReorder,
  onTearOut,
  onDragActive,
  onRename
}: TabBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const dragId = useRef<string | null>(null)
  const draggable = !!onTearOut
  const extraLeftItems = extraLeft ? (Array.isArray(extraLeft) ? extraLeft : [extraLeft]) : []
  const extraItems = extra ? (Array.isArray(extra) ? extra : [extra]) : []

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = (): void => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length])

  const scrollBy = (d: number): void => scrollRef.current?.scrollBy({ left: d, behavior: 'smooth' })

  return (
    <div className="tabs">
      {extraLeftItems.map((item, i) => (
        <button
          key={i}
          className={`tab-add ${item.active ? 'on' : ''}`}
          title={item.title}
          onClick={(e) => {
            e.stopPropagation()
            item.onClick()
          }}
        >
          {item.icon ?? item.label}
        </button>
      ))}
      {overflow && (
        <button className="tab-scroll" title="왼쪽" onClick={() => scrollBy(-180)}>
          ‹
        </button>
      )}
      <div className="tabs-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''} ${t.attention ? 'attention' : ''} ${t.working ? 'working' : ''} ${t.question ? 'question' : ''}`}
            onClick={() => onSelect(t.id)}
            title={
              t.working
                ? `${t.tooltip ?? t.title}\n⟳ 작업 중`
                : t.question
                  ? `${t.tooltip ?? t.title}\n❓ 확인/질문 대기`
                  : t.attention
                    ? `${t.tooltip ?? t.title}\n✓ 완료`
                    : (t.tooltip ?? t.title)
            }
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    dragId.current = t.id
                    e.dataTransfer.effectAllowed = 'move'
                    onDragActive?.(true)
                    if (t.dragPayload) void window.lt.tabs.beginDrag(t.dragPayload)
                  }
                : undefined
            }
            onDragOver={
              draggable
                ? (e) => {
                    if (dragId.current && dragId.current !== t.id) e.preventDefault()
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault()
                    if (dragId.current && dragId.current !== t.id) {
                      onReorder?.(dragId.current, t.id)
                      void window.lt.tabs.endDrag()
                    }
                    dragId.current = null
                  }
                : undefined
            }
            onDragEnd={
              draggable
                ? async () => {
                    const id = dragId.current
                    dragId.current = null
                    onDragActive?.(false)
                    if (!id || !t.dragPayload) return
                    const r = await window.lt.tabs.endDrag()
                    if (r?.action === 'moved') onTearOut?.(id)
                  }
                : undefined
            }
            onDoubleClick={
              onRename && t.renamable
                ? (e) => {
                    e.stopPropagation()
                    setEditing({ id: t.id, value: t.title })
                  }
                : undefined
            }
          >
            {t.working ? (
              <span className="tab-spin" title="작업 중">
                ⟳
              </span>
            ) : t.question ? (
              <span className="tab-q" title="확인/질문 대기">
                ❓
              </span>
            ) : (
              t.attention && (
                <span className="tab-dot" title="완료">
                  ●
                </span>
              )
            )}
            {editing?.id === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                value={editing.value}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename?.(t.id, editing.value.trim() || t.title)
                    setEditing(null)
                  } else if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => {
                  onRename?.(t.id, editing.value.trim() || t.title)
                  setEditing(null)
                }}
              />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            <button
              className="tab-close"
              title="닫기"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {overflow && (
        <button className="tab-scroll" title="오른쪽" onClick={() => scrollBy(180)}>
          ›
        </button>
      )}
      {extraItems.map((item, i) => (
        <button key={i} className="tab-add" title={item.title} onClick={item.onClick}>
          {item.icon ?? item.label}
        </button>
      ))}
      {onAdd && (
        <button className="tab-add" title={addTitle} onClick={onAdd}>
          ＋
        </button>
      )}
    </div>
  )
}

// 세션(터미널) 목록 드롭다운 — 사건별 필터 + 선택
function SessionList({
  sessions,
  activeId,
  filter,
  onFilter,
  caseCwd,
  caseSource,
  onSelect,
  onResume,
  onClose
}: {
  sessions: TermTab[]
  activeId: string
  filter: string
  onFilter: (f: string) => void
  caseCwd?: string
  caseSource?: TermTab
  onSelect: (id: string) => void
  onResume: (sessionId: string, cwd: string, title?: string, source?: TermTab) => void
  onClose: () => void
}): JSX.Element {
  const [past, setPast] = useState<{ sessionId: string; title?: string; mtime: number }[] | null>(
    null
  )

  useEffect(() => {
    const close = (): void => onClose()
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [onClose])

  // 필터 옵션: 전체 + 사건별(jsId) + 폴더 세션
  const caseOpts: { value: string; label: string }[] = []
  const seen = new Set<string>()
  let hasFolder = false
  for (const s of sessions) {
    if (s.jsId) {
      if (!seen.has(s.jsId)) {
        seen.add(s.jsId)
        caseOpts.push({
          value: s.jsId,
          label: [s.caseNumber, s.caseName].filter(Boolean).join(' ') || s.title
        })
      }
    } else hasFolder = true
  }
  if (caseSource?.jsId) {
    if (!seen.has(caseSource.jsId)) {
      seen.add(caseSource.jsId)
      caseOpts.push({
        value: caseSource.jsId,
        label:
          [caseSource.caseNumber, caseSource.caseName].filter(Boolean).join(' ') ||
          caseSource.title
      })
    }
  } else if (caseSource) {
    hasFolder = true
  }
  const shown = sessions.filter((s) =>
    filter === 'all' ? true : filter === '__folder__' ? !s.jsId : s.jsId === filter
  )

  // 과거 세션을 읽을 cwd: 필터된 사건의 열린 세션 cwd → 없으면 현재 사건 cwd
  const activeSession = sessions.find((s) => s.id === activeId)
  const caseFallback =
    filter !== 'all' && filter !== '__folder__'
      ? caseSource?.jsId === filter
        ? caseSource
        : undefined
      : filter === '__folder__'
        ? caseSource && !caseSource.jsId
          ? caseSource
          : undefined
        : caseSource
  const filterSource =
    filter !== 'all' && filter !== '__folder__'
      ? (sessions.find((s) => s.jsId === filter) ?? caseFallback)
      : filter === '__folder__'
        ? (shown.find((s) => s.id === activeId) ?? shown[0] ?? caseFallback)
        : (activeSession ?? caseFallback)
  const filterCwd =
    filter !== 'all' && filter !== '__folder__'
      ? (filterSource?.cwd ?? caseCwd)
      : (filterSource?.cwd ?? caseCwd)

  useEffect(() => {
    if (!filterCwd) {
      setPast([])
      return
    }
    let alive = true
    setPast(null)
    window.lt.sessions.list(filterCwd, filterSource?.ssh).then((r) => alive && setPast(r))
    return () => {
      alive = false
    }
  }, [filterCwd, filterSource?.ssh?.host, filterSource?.ssh?.user, filterSource?.ssh?.port, filterSource?.ssh?.identityFile])

  const fmt = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  }

  return (
    <div
      className="session-list"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sl-head">
        <span className="sl-title">세션</span>
        <select className="sl-filter" value={filter} onChange={(e) => onFilter(e.target.value)}>
          <option value="all">전체 사건</option>
          {caseOpts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {hasFolder && <option value="__folder__">폴더 세션</option>}
        </select>
      </div>
      <ul className="sl-list">
        <li className="sl-section">열린 세션</li>
        {shown.length === 0 && <li className="muted pad small">열린 세션이 없습니다.</li>}
        {shown.map((s) => (
          <li
            key={s.id}
            className={`sl-row ${s.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.cwd}
          >
            <span className="sl-name">{s.title}</span>
            <span className="sl-sub">
              {[s.client && `의뢰인 ${s.client}`, s.court].filter(Boolean).join(' · ') || s.cwd}
            </span>
          </li>
        ))}

        <li className="sl-section">과거 세션 (이어서 열기)</li>
        {!filterCwd && <li className="muted pad small">사건을 먼저 여세요.</li>}
        {filterCwd && past === null && <li className="muted pad small">불러오는 중…</li>}
        {filterCwd && past && past.length === 0 && (
          <li className="muted pad small">과거 세션이 없습니다.</li>
        )}
        {filterCwd &&
          past?.map((p) => (
            <li
              key={p.sessionId}
              className="sl-row past"
              onClick={() => onResume(p.sessionId, filterCwd, p.title, filterSource)}
              title={`${p.sessionId}\nclaude --resume 로 이어서 열기`}
            >
              <span className="sl-name">↻ {p.title || '(제목 없음)'}</span>
              <span className="sl-sub">{fmt(p.mtime)}</span>
            </li>
          ))}
      </ul>
    </div>
  )
}

const RECENT_CASES_PAGE_SIZE = 10

function Welcome({
  recent,
  onOpen
}: {
  recent: { drafts: string; records?: string; name: string; ts: number }[]
  onOpen: (e: { drafts: string; records?: string; name: string }) => void | Promise<void>
}): JSX.Element {
  const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_CASES_PAGE_SIZE)
  const visibleRecent = recent.slice(0, recentVisibleCount)
  const hasMoreRecent = recentVisibleCount < recent.length

  useEffect(() => {
    setRecentVisibleCount(RECENT_CASES_PAGE_SIZE)
  }, [recent.length])

  return (
    <div className="welcome">
      <h1>legal-terminal</h1>
      <p className="subtitle">Claude Code · Markdown 준비서면 · 전자소송기록 뷰어 — 한 화면에서</p>

      {recent.length > 0 && (
        <div className="recent">
          <h2 className="recent-title">최근 사건</h2>
          <ul className="recent-list">
            {visibleRecent.map((r) => (
              <li key={r.drafts} className="recent-item" onClick={() => void onOpen(r)} title={r.drafts}>
                <span className="recent-name">⚖️ {r.name}</span>
                {isRemotePath(r.drafts) && <span className="recent-tag">원격</span>}
                {r.records && <span className="recent-tag">기록 연결됨</span>}
              </li>
            ))}
          </ul>
          {hasMoreRecent && (
            <button
              className="recent-more"
              type="button"
              onClick={() => setRecentVisibleCount((count) => count + RECENT_CASES_PAGE_SIZE)}
            >
              더 보기
            </button>
          )}
        </div>
      )}

      <ul className="welcome-list">
        <li>📁 <b>탐색기 모드</b> — 작성서류 폴더의 파일트리에서 문서를 본문에 엽니다</li>
        <li>📄 <b>기록뷰어 모드</b> — 문서 | 본문 | 서증·첨부서류 | 터미널</li>
        <li>✳️ <b>Claude</b> — 오른쪽 터미널에서 <code>/brief-protocol</code> 실행 (모드 전환에도 유지)</li>
      </ul>
    </div>
  )
}

function DocPlaceholder({ title }: { title: string }): JSX.Element {
  return (
    <div className="welcome">
      <h2>{title}</h2>
      <p className="muted">M2에서 Monaco Markdown 에디터 + 라이브 프리뷰가 여기에 들어갑니다.</p>
    </div>
  )
}

interface TextFindRange {
  start: number
  end: number
}

function findTextRanges(text: string, query: string): TextFindRange[] {
  const needle = query.trim()
  if (!needle) return []
  const haystack = text.toLocaleLowerCase('ko-KR')
  const target = needle.toLocaleLowerCase('ko-KR')
  const out: TextFindRange[] = []
  let index = haystack.indexOf(target)
  while (index >= 0 && out.length < 2000) {
    out.push({ start: index, end: index + needle.length })
    index = haystack.indexOf(target, index + Math.max(needle.length, 1))
  }
  return out
}

/** 텍스트 문서 표시 — 자동 줄바꿈 기본 ON(토글) */
function TextDoc({ text, note }: { text: string; note?: string }): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const ranges = findTextRanges(text, findQuery)
  const activeFindIndex = ranges.length ? Math.max(0, Math.min(findIndex, ranges.length - 1)) : -1

  useEffect(() => {
    if (findIndex !== activeFindIndex) setFindIndex(activeFindIndex)
  }, [activeFindIndex, findIndex])

  useEffect(() => {
    if (!findOpen || activeFindIndex < 0) return
    rootRef.current
      ?.querySelector('.text-find-active')
      ?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [activeFindIndex, findOpen, findQuery])

  const nextFind = (): void =>
    setFindIndex((i) => (ranges.length ? (i + 1 + ranges.length) % ranges.length : -1))
  const prevFind = (): void =>
    setFindIndex((i) => (ranges.length ? (i - 1 + ranges.length) % ranges.length : -1))

  const renderText = (): ReactNode => {
    if (!ranges.length) return text
    const parts: ReactNode[] = []
    let pos = 0
    ranges.forEach((range, i) => {
      if (range.start > pos) parts.push(text.slice(pos, range.start))
      parts.push(
        <mark key={`${range.start}-${i}`} className={i === activeFindIndex ? 'text-find-active' : 'text-find-match'}>
          {text.slice(range.start, range.end)}
        </mark>
      )
      pos = range.end
    })
    if (pos < text.length) parts.push(text.slice(pos))
    return parts
  }

  return (
    <div
      ref={rootRef}
      className="text-doc"
      tabIndex={0}
      onKeyDown={(e) => {
        const primary = e.metaKey || e.ctrlKey
        if (!primary || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
      }}
    >
      <div className="text-toolbar">
        <button
          className={`tb-btn ${wrap ? 'on' : ''}`}
          title="자동 줄바꿈"
          onClick={() => setWrap((w) => !w)}
        >
          줄바꿈
        </button>
        <span className="tb-divider" />
        <button
          className={`tb-btn ${findOpen ? 'on' : ''}`}
          title="문서에서 찾기"
          onClick={() => setFindOpen((v) => !v)}
        >
          <IconSearch size={14} />
          <span className="sr-only">문서에서 찾기</span>
        </button>
      </div>
      {findOpen && (
        <FindBar
          value={findQuery}
          placeholder="문서에서 찾기"
          resultLabel={findQuery.trim() ? `${activeFindIndex + 1}/${ranges.length}` : ''}
          onChange={(v) => {
            setFindQuery(v)
            setFindIndex(0)
          }}
          onPrev={prevFind}
          onNext={nextFind}
          onClose={() => setFindOpen(false)}
        />
      )}
      <pre className={`file-view ${wrap ? 'wrap' : ''}`}>
        {renderText()}
        {note ? '\n\n' + note : ''}
      </pre>
    </div>
  )
}

/** 텍스트 파일 미리보기 (md/txt/csv/json…). MD 옵시디언식 라이브 프리뷰는 추후 CodeMirror로. */
function FileView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{
    loading: boolean
    text: string
    binary: boolean
    truncated: boolean
    err: string
  }>({ loading: true, text: '', binary: false, truncated: false, err: '' })

  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', binary: false, truncated: false, err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          text: r.text,
          binary: r.kind === 'binary',
          truncated: !!r.truncated,
          err: ''
        })
      })
      .catch((e) => alive && setState((s) => ({ ...s, loading: false, err: String(e) })))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>
  if (state.binary)
    return (
      <div className="welcome">
        <p className="muted">텍스트로 미리볼 수 없는 형식입니다.</p>
      </div>
    )
  return <TextDoc text={state.text} note={state.truncated ? '… (이하 생략, 2MB 초과)' : undefined} />
}

/** HWP(.hwp) — 텍스트만 추출해 표시 */
function HwpView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; text: string; err: string }>({
    loading: true,
    text: '',
    err: ''
  })
  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', err: '' })
    window.lt.fs
      .readHwpText(path)
      .then((r) => {
        if (!alive) return
        setState({ loading: false, text: r.text, err: r.ok ? '' : r.error || '추출 실패' })
      })
      .catch((e) => alive && setState({ loading: false, text: '', err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])
  if (state.loading) return <div className="welcome"><p className="muted">HWP 텍스트 추출 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">{state.err}</p></div>
  return <TextDoc text={state.text} />
}

// CSV 파싱 (따옴표·구분자 처리)
function parseCsv(text: string, delim: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.length))
}

function detectDelim(firstLine: string): string {
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ','
}

/** CSV — 표(기본) / 색상 텍스트(열별 색상) */
function CsvView({ path }: { path: string }): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [state, setState] = useState<{ loading: boolean; rows: string[][]; err: string }>({
    loading: true,
    rows: [],
    err: ''
  })
  const [mode, setMode] = useState<'table' | 'color'>('table')

  useEffect(() => {
    let alive = true
    setState({ loading: true, rows: [], err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        const text = r.text.replace(/^﻿/, '')
        const delim = detectDelim(text.split('\n')[0] ?? '')
        setState({ loading: false, rows: parseCsv(text, delim), err: '' })
      })
      .catch((e) => alive && setState({ loading: false, rows: [], err: String(e) }))
    return () => {
      alive = false
    }
  }, [path, remoteVersion])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>

  const [header, ...body] = state.rows
  return (
    <div className="text-doc">
      <div className="text-toolbar">
        <button className={`tb-btn ${mode === 'table' ? 'on' : ''}`} onClick={() => setMode('table')}>
          표
        </button>
        <button className={`tb-btn ${mode === 'color' ? 'on' : ''}`} onClick={() => setMode('color')}>
          색상
        </button>
        <span className="tb-sep-text">{state.rows.length}행</span>
      </div>
      <div className="csv-wrap">
        {mode === 'table' ? (
          <table className="csv-table">
            {header && (
              <thead>
                <tr>
                  {header.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={`csv-c${ci % 8}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="csv-color">
            {state.rows.map((r, ri) => (
              <div key={ri}>
                {r.map((c, ci) => (
                  <span key={ci}>
                    <span className={`csv-c${ci % 8}`}>{c}</span>
                    {ci < r.length - 1 && <span className="csv-delim">,</span>}
                  </span>
                ))}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 이미지 뷰어 — 폭맞춤(기본)/원본, Ctrl+휠 줌 */
function ImageViewer({
  path,
  onNavigate
}: {
  path: string
  onNavigate?: (dir: 1 | -1) => void
}): JSX.Element {
  const remoteVersion = useRemoteFileVersion(path)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'fit_page' | 'fit_width' | 'custom'>('fit_page')
  const [scale, setScale] = useState(1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navLock = useRef(false)

  useEffect(() => {
    let alive = true
    let made = ''
    setErr('')
    window.lt.fs
      .readBytes(path)
      .then((ab) => {
        if (!alive) return
        made = URL.createObjectURL(new Blob([ab]))
        setUrl(made)
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [path, remoteVersion])

  const zoomBy = (f: number): void => {
    setMode('custom')
    setScale((s) => Math.max(0.1, Math.min(8, +(s * f).toFixed(3))))
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
      return
    }
    // 스크롤이 끝(위/아래)에 닿으면 정렬순 이전/다음 이미지로 이동
    const el = wrapRef.current
    if (!el || !onNavigate) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const atTop = el.scrollTop <= 2
    if (e.deltaY > 0 && atBottom && !navLock.current) {
      navLock.current = true
      onNavigate(1)
      setTimeout(() => (navLock.current = false), 400)
    } else if (e.deltaY < 0 && atTop && !navLock.current) {
      navLock.current = true
      onNavigate(-1)
      setTimeout(() => (navLock.current = false), 400)
    }
  }

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || mode !== 'custom') return
    let dragging = false
    let sx = 0
    let sy = 0
    let sl = 0
    let st = 0
    const down = (e: MouseEvent): void => {
      if (e.button !== 0) return
      dragging = true
      sx = e.clientX
      sy = e.clientY
      sl = wrap.scrollLeft
      st = wrap.scrollTop
      wrap.classList.add('grabbing')
      e.preventDefault()
    }
    const move = (e: MouseEvent): void => {
      if (!dragging) return
      wrap.scrollLeft = sl - (e.clientX - sx)
      wrap.scrollTop = st - (e.clientY - sy)
    }
    const up = (): void => {
      dragging = false
      wrap.classList.remove('grabbing')
    }
    wrap.addEventListener('mousedown', down)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      wrap.removeEventListener('mousedown', down)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      wrap.classList.remove('grabbing')
    }
  }, [mode])

  const imgStyle: React.CSSProperties =
    mode === 'fit_page'
      ? { maxWidth: '100%', maxHeight: '100%' }
      : mode === 'fit_width'
        ? { width: '100%', height: 'auto' }
        : { width: `${scale * 100}%`, height: 'auto' }

  if (err) return <div className="welcome"><p className="muted">이미지 열기 실패: {err}</p></div>
  return (
    <div className="image-doc">
      <div className="pdf-toolbar">
        <button
          className={`tb-btn ${mode === 'fit_page' ? 'on' : ''}`}
          title="쪽 맞춤"
          onClick={() => setMode('fit_page')}
        >
          쪽맞춤
        </button>
        <button
          className={`tb-btn ${mode === 'fit_width' ? 'on' : ''}`}
          title="폭 맞춤"
          onClick={() => setMode('fit_width')}
        >
          폭맞춤
        </button>
        <button className="tb-btn" title="축소" onClick={() => zoomBy(1 / 1.1)}>
          －
        </button>
        <button className="tb-btn pct" onClick={() => setMode('fit_page')}>
          {mode === 'custom' ? `${Math.round(scale * 100)}%` : '맞춤'}
        </button>
        <button className="tb-btn" title="확대" onClick={() => zoomBy(1.1)}>
          ＋
        </button>
      </div>
      <div
        className={`image-wrap ${mode === 'fit_page' ? 'center' : ''} ${mode === 'custom' ? 'pannable' : ''}`}
        ref={wrapRef}
        onWheel={onWheel}
      >
        {url && <img src={url} style={imgStyle} draggable={false} alt="" />}
      </div>
    </div>
  )
}

function SettingsView(): JSX.Element {
  const [s, setS] = useState<AppSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [termFontSizeInput, setTermFontSizeInput] = useState(String(DEFAULT_TERM_FONT_SIZE))
  const [mdFontSizeInput, setMdFontSizeInput] = useState(String(DEFAULT_MD_FONT_SIZE))
  const [notificationVolumeInput, setNotificationVolumeInput] = useState(DEFAULT_NOTIFICATION_VOLUME)

  useEffect(() => {
    const applySettings = (v: AppSettings): void => {
      setS({
        ...v,
        caseOpenTarget: resolveCaseOpenTarget(v.caseOpenTarget, v.sshProfiles ?? [])
      })
      setLoaded(true)
    }
    window.lt.settings.get().then(applySettings)
    const onSettingsUpdated = (e: Event): void => applySettings((e as CustomEvent<AppSettings>).detail)
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [])

  useEffect(() => {
    setTermFontSizeInput(String(s.termFontSize ?? DEFAULT_TERM_FONT_SIZE))
  }, [s.termFontSize])

  useEffect(() => {
    setMdFontSizeInput(String(s.mdFontSize ?? DEFAULT_MD_FONT_SIZE))
  }, [s.mdFontSize])

  useEffect(() => {
    setNotificationVolumeInput(clampNotificationVolume(s.notificationVolume))
  }, [s.notificationVolume])

  const savePatch = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await window.lt.settings.set(patch)
    setS(next)
    emitSettingsUpdated(next)
  }

  const commitTermFontSize = async (): Promise<void> => {
    const next = clampFontSize(termFontSizeInput, s.termFontSize ?? DEFAULT_TERM_FONT_SIZE)
    setTermFontSizeInput(String(next))
    if (next !== (s.termFontSize ?? DEFAULT_TERM_FONT_SIZE)) await savePatch({ termFontSize: next })
  }

  const commitMdFontSize = async (): Promise<void> => {
    const next = clampFontSize(mdFontSizeInput, s.mdFontSize ?? DEFAULT_MD_FONT_SIZE)
    setMdFontSizeInput(String(next))
    if (next !== (s.mdFontSize ?? DEFAULT_MD_FONT_SIZE)) await savePatch({ mdFontSize: next })
  }

  const commitNotificationVolume = async (): Promise<void> => {
    const next = clampNotificationVolume(notificationVolumeInput)
    setNotificationVolumeInput(next)
    if (next !== clampNotificationVolume(s.notificationVolume)) {
      await savePatch({ notificationVolume: next })
    }
  }

  const pick = async (key: 'draftsRoot' | 'recordsRoot'): Promise<void> => {
    const title =
      key === 'draftsRoot'
        ? '작성서류 루트 폴더 선택 (모든 사건)'
        : '소송기록 루트 폴더 선택 (사건별 전자소송기록)'
    const r = await window.lt.dialog.pickFolder({ title, defaultPath: s[key] })
    if (!r) return
    await savePatch({ [key]: r.path })
  }

  const profiles = s.sshProfiles ?? []
  const caseOpenValue = resolveCaseOpenTarget(s.caseOpenTarget, profiles)
  const notificationSound = resolveNotificationSound(s.notificationSound)
  const notificationVolume = clampNotificationVolume(notificationVolumeInput)
  const mdFontValue = s.mdFont === DEFAULT_MD_FONT ? '' : s.mdFont ?? ''
  const mdFontOptions =
    mdFontValue && !MD_FONT_OPTIONS.some((option) => option.value === mdFontValue)
      ? [...MD_FONT_OPTIONS, { label: `현재 설정 (${mdFontValue})`, value: mdFontValue }]
      : MD_FONT_OPTIONS

  return (
    <div className="settings">
      <h1>설정</h1>
      <p className="muted">사건을 열 때 두 폴더를 자동으로 짝지으려면 아래 두 루트를 지정하세요.</p>

      <section className="setting-row">
        <div className="setting-label">
          작성서류 루트 <span className="muted small">— 모든 사건의 작성서류 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.draftsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('draftsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          소송기록 루트 <span className="muted small">— 사건별 전자소송기록 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.recordsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('recordsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          사건 기본 열기 <span className="muted small">— 사건 대시보드에서 클릭할 때 사용할 위치</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={caseOpenValue}
            onChange={(e) => savePatch({ caseOpenTarget: e.target.value })}
          >
            <option value={CASE_OPEN_LOCAL}>로컬</option>
            {profiles.map((p) => (
              <option key={p.id} value={remoteCaseOpenTarget(p.id)}>
                원격: {p.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          PDF 기본 배율 <span className="muted small">— 전자소송기록을 열 때 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={s.pdfZoom ?? 'fit_page'}
            onChange={async (e) => {
              await savePatch({ pdfZoom: e.target.value })
            }}
          >
            <option value="fit_page">쪽 맞춤</option>
            <option value="fit_width">폭 맞춤</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
            <option value="200">200%</option>
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          터미널 폰트 <span className="muted small">— 새 터미널부터 적용</span>
        </div>
        <div className="setting-value">
          <input
            className="setting-input"
            placeholder="예: Cascadia Mono, D2Coding, Consolas"
            defaultValue={s.termFont ?? ''}
            onBlur={async (e) => {
              await savePatch({ termFont: e.target.value.trim() })
            }}
          />
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">터미널 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={termFontSizeInput}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTermFontSizeInput(e.target.value)}
            onBlur={() => {
              void commitTermFontSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setTermFontSizeInput(String(s.termFontSize ?? DEFAULT_TERM_FONT_SIZE))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          작업 완료 알림음 <span className="muted small">— 완료·질문 대기 전환 시 재생</span>
        </div>
        <div className="setting-value notification-sound-row">
          <select
            className="setting-select"
            value={notificationSound}
            onChange={(e) => {
              const nextSound = resolveNotificationSound(e.target.value)
              setS((current) => ({ ...current, notificationSound: nextSound }))
              void savePatch({ notificationSound: nextSound })
              playNotificationSound(nextSound, notificationVolume)
            }}
          >
            {NOTIFICATION_SOUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="header-btn setting-preview-btn"
            type="button"
            onClick={() => playNotificationSound(notificationSound, notificationVolume)}
          >
            미리듣기
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">알림음 볼륨</div>
        <div className="setting-value notification-volume-row">
          <input
            className="setting-range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={notificationVolume}
            aria-label="알림음 볼륨"
            onChange={(e) => {
              const nextVolume = clampNotificationVolume(e.target.value)
              setNotificationVolumeInput(nextVolume)
            }}
            onPointerUp={() => {
              void commitNotificationVolume()
            }}
            onKeyUp={() => {
              void commitNotificationVolume()
            }}
            onBlur={() => {
              void commitNotificationVolume()
            }}
          />
          <span className="setting-range-value">{notificationVolume}%</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          마크다운 폰트 <span className="muted small">— 편집기(원본/서식)에 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select font-select"
            value={mdFontValue}
            onChange={(e) => {
              void savePatch({ mdFont: e.target.value || undefined })
            }}
          >
            {mdFontOptions.map((option) => (
              <option key={option.value || 'default'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="header-btn setting-reset-btn"
            type="button"
            onClick={() => {
              void savePatch({ mdFont: undefined })
            }}
          >
            기본값 복원
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">마크다운 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={mdFontSizeInput}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setMdFontSizeInput(e.target.value)}
            onBlur={() => {
              void commitMdFontSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setMdFontSizeInput(String(s.mdFontSize ?? DEFAULT_MD_FONT_SIZE))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row col">
        <div className="setting-label">
          SSH 접속 프로필{' '}
          <span className="muted small">— 원격 서버에서 사건·claude 실행 (사건 열기 → 접속 선택)</span>
        </div>
        <SshProfilesEditor />
      </section>

      <p className="muted small">{loaded ? '변경 즉시 저장됩니다 (마크다운은 새로 열 때 적용).' : '불러오는 중…'}</p>
    </div>
  )
}

// 설정 화면의 SSH 프로필 목록 편집기 (추가/수정/삭제 즉시 저장)
function SshProfilesEditor(): JSX.Element {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  // 루트 '찾아보기' — 해당 ssh에 접속해 원격 폴더를 탐색·선택
  const [picking, setPicking] = useState<{
    profile: SshProfile
    field: 'draftsRoot' | 'recordsRoot'
  } | null>(null)

  useEffect(() => {
    window.lt.settings.get().then((s) => setProfiles(s.sshProfiles ?? []))
  }, [])

  const save = (next: SshProfile[]): void => {
    setProfiles(next)
    void window.lt.settings.set({ sshProfiles: next }).then(emitSettingsUpdated)
  }
  const update = (id: string, patch: Partial<SshProfile>): void =>
    save(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const add = (): void => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ssh-${Date.now()}`
    save([...profiles, { id, label: '새 서버', host: '', user: '' }])
  }
  const remove = (id: string): void => save(profiles.filter((p) => p.id !== id))

  return (
    <div className="ssh-editor">
      {profiles.length === 0 && (
        <p className="muted small">저장된 프로필이 없습니다. 아래에서 추가하세요.</p>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="ssh-card">
          <div className="ssh-card-head">
            <input
              className="setting-input"
              placeholder="이름 (예: 사무실 서버)"
              defaultValue={p.label}
              onBlur={(e) => update(p.id, { label: e.target.value.trim() || '서버' })}
            />
            <button className="header-btn danger" onClick={() => remove(p.id)} title="삭제">
              삭제
            </button>
          </div>
          <div className="ssh-grid">
            <label>
              호스트
              <input
                className="setting-input"
                placeholder="example.com 또는 192.168.0.10"
                defaultValue={p.host}
                onBlur={(e) => update(p.id, { host: e.target.value.trim() })}
              />
            </label>
            <label>
              사용자
              <input
                className="setting-input"
                placeholder="ubuntu"
                defaultValue={p.user}
                onBlur={(e) => update(p.id, { user: e.target.value.trim() })}
              />
            </label>
            <label>
              포트
              <input
                className="setting-input narrow"
                type="number"
                placeholder="22"
                defaultValue={p.port ?? ''}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10)
                  update(p.id, { port: Number.isNaN(n) ? undefined : n })
                }}
              />
            </label>
            <label className="wide">
              개인키 파일 <span className="muted small">(비우면 ssh-agent·기본 키)</span>
              <input
                className="setting-input"
                placeholder="/Users/me/.ssh/id_ed25519"
                defaultValue={p.identityFile ?? ''}
                onBlur={(e) => update(p.id, { identityFile: e.target.value.trim() || undefined })}
              />
            </label>
            <label className="wide">
              원격 작성서류 루트 <span className="muted small">(사건 폴더 고를 때 시작 위치)</span>
              <div className="root-row">
                <input
                  key={'d:' + (p.draftsRoot ?? '')}
                  className="setting-input"
                  placeholder="/Users/me/OneDrive/진행중사건"
                  defaultValue={p.draftsRoot ?? ''}
                  onBlur={(e) => update(p.id, { draftsRoot: e.target.value.trim() || undefined })}
                />
                <button
                  className="header-btn"
                  type="button"
                  disabled={!p.host || !p.user}
                  title={!p.host || !p.user ? '호스트·사용자를 먼저 입력하세요' : '원격에서 폴더 찾기'}
                  onClick={() => setPicking({ profile: p, field: 'draftsRoot' })}
                >
                  찾아보기
                </button>
              </div>
            </label>
            <label className="wide">
              원격 소송기록 루트 <span className="muted small">(기록뷰어에서 소송기록 폴더 고를 때 시작 위치)</span>
              <div className="root-row">
                <input
                  key={'r:' + (p.recordsRoot ?? '')}
                  className="setting-input"
                  placeholder="/Users/me/OneDrive/소송기록"
                  defaultValue={p.recordsRoot ?? ''}
                  onBlur={(e) => update(p.id, { recordsRoot: e.target.value.trim() || undefined })}
                />
                <button
                  className="header-btn"
                  type="button"
                  disabled={!p.host || !p.user}
                  title={!p.host || !p.user ? '호스트·사용자를 먼저 입력하세요' : '원격에서 폴더 찾기'}
                  onClick={() => setPicking({ profile: p, field: 'recordsRoot' })}
                >
                  찾아보기
                </button>
              </div>
            </label>
          </div>
        </div>
      ))}
      <button className="empty-action" onClick={add}>
        ＋ 프로필 추가
      </button>

      {picking && (
        <RemoteFolderPicker
          profile={picking.profile}
          title={picking.field === 'draftsRoot' ? '작성서류 루트 선택' : '소송기록 루트 선택'}
          confirmLabel="이 폴더로 지정"
          startPath={
            picking.field === 'draftsRoot'
              ? picking.profile.draftsRoot
              : picking.profile.recordsRoot
          }
          onCancel={() => setPicking(null)}
          onPick={(remotePath) => {
            update(picking.profile.id, { [picking.field]: remotePath } as Partial<SshProfile>)
            setPicking(null)
          }}
        />
      )}
    </div>
  )
}

// 사건 열기 시 접속 선택 (로컬 / 저장된 SSH 프로필)
function ConnMenu({
  profiles,
  onLocal,
  onRemote,
  onManage,
  onClose
}: {
  profiles: SshProfile[]
  onLocal: () => void
  onRemote: (p: SshProfile) => void
  onManage: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal conn-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">사건 열기 — 접속 선택</div>
        <button className="conn-row" onClick={onLocal}>
          <span className="conn-ic">💻</span>
          <span className="conn-main">
            <b>이 컴퓨터 (로컬)</b>
            <span className="muted small">로컬 폴더에서 사건 선택</span>
          </span>
        </button>
        {profiles.map((p) => (
          <button key={p.id} className="conn-row" onClick={() => onRemote(p)}>
            <span className="conn-ic">🔗</span>
            <span className="conn-main">
              <b>{p.label}</b>
              <span className="muted small">
                {p.user}@{p.host}
                {p.port ? `:${p.port}` : ''}
              </span>
            </span>
          </button>
        ))}
        <div className="modal-actions">
          <button className="header-btn" onClick={onManage}>
            ＋ 프로필 관리…
          </button>
          <button className="header-btn" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

function parentRemotePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '~') return '~'
  if (trimmed.startsWith('~/')) {
    const parent = trimmed.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    return parent === '~' || !parent ? '~' : parent
  }
  return trimmed.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
}

function remoteCrumbs(path: string): { label: string; path: string }[] {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '~') return [{ label: '~', path: '~' }]
  if (trimmed.startsWith('~/')) {
    const parts = trimmed.slice(2).split('/').filter(Boolean)
    let acc = '~'
    return [
      { label: '~', path: '~' },
      ...parts.map((part) => {
        acc += '/' + part
        return { label: part, path: acc }
      })
    ]
  }
  if (!trimmed.startsWith('/')) return [{ label: trimmed, path: trimmed }]
  const parts = trimmed.split('/').filter(Boolean)
  let acc = ''
  return [
    { label: '루트', path: '/' },
    ...parts.map((part) => {
      acc += '/' + part
      return { label: part, path: acc }
    })
  ]
}

function remotePathParts(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
}

function oneDrivePartIndex(path: string): number {
  return remotePathParts(path).findIndex((part) => part.toLowerCase().startsWith('onedrive'))
}

function looksLikeOneDrivePath(path: string): boolean {
  return oneDrivePartIndex(path) >= 0
}

function cloudPathFromOneDrivePath(path: string): string {
  const parts = remotePathParts(path)
  const i = parts.findIndex((part) => part.toLowerCase().startsWith('onedrive'))
  return i >= 0 ? parts.slice(i + 1).join('/').normalize('NFC') : ''
}

const REMOTE_START_POINTS = [
  { label: '홈', path: '~' },
  { label: '루트 /', path: '/' },
  { label: '/Users', path: '/Users' },
  { label: '/home', path: '/home' },
  { label: '/Volumes', path: '/Volumes' },
  { label: 'CloudStorage', path: '~/Library/CloudStorage' },
  { label: 'OneDrive', path: '~/Library/CloudStorage/OneDrive' },
  { label: 'Documents', path: '~/Documents' }
]

// 원격(SSH) 사건 폴더 탐색·선택. ssh.listDir(키/agent 인증)로 목록을 받고,
// 실패 시(비밀번호 인증 등) 원격 경로를 직접 입력하는 폴백을 제공한다.
function RemoteFolderPicker({
  profile,
  title = '사건(작성서류) 폴더 선택',
  startPath,
  confirmLabel = '이 폴더로 사건 열기',
  onPick,
  onCancel
}: {
  profile: SshProfile
  title?: string
  startPath?: string
  confirmLabel?: string
  onPick: (remotePath: string) => void
  onCancel: () => void
}): JSX.Element {
  const initial = (startPath ?? profile.draftsRoot)?.trim() || '~'
  const [cwd, setCwd] = useState<string>(initial)
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null)
  const [err, setErr] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [pathInput, setPathInput] = useState(initial)
  const [syncOpen, setSyncOpen] = useState<{ macFolder: string; reloadPath: string } | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('name-asc')

  const load = (path: string): void => {
    const nextPath = path.trim() || '~'
    setPathInput(nextPath)
    setLoading(true)
    setErr('')
    window.lt.ssh
      .listDir(profile, nextPath)
      .then((r) => {
        setLoading(false)
        if (r.ok) {
          setCwd(r.cwd)
          setPathInput(r.cwd)
          setEntries(r.entries)
        } else {
          setErr(r.error)
          setEntries(null)
        }
      })
      .catch((e: unknown) => {
        setLoading(false)
        setErr(e instanceof Error ? e.message : String(e))
        setEntries(null)
      })
  }

  useEffect(() => {
    load(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const up = (): void => {
    load(parentRemotePath(cwd))
  }
  const dirs = sortEntries(entries?.filter((e) => e.isDir) ?? [], sortMode)
  const crumbs = remoteCrumbs(cwd)
  const canUsePathInput = pathInput.trim().length > 0
  const syncPath = (pathInput.trim() || cwd).trim()
  const canSyncOneDrive = looksLikeOneDrivePath(syncPath)
  const closeSync = (): void => {
    const reloadPath = syncOpen?.reloadPath
    setSyncOpen(null)
    if (reloadPath) load(reloadPath)
  }

  return (
    <>
      <div className="modal-overlay" onMouseDown={onCancel}>
        <div className="modal remote-picker" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-title">
            🔗 {profile.label} — {title}
          </div>
          <p className="muted small remote-hint">
            기본은 사용자 홈(/Users/사용자명 또는 /home/사용자명)에서 시작합니다. 위치가 다르면 루트(/)에서 다시 찾아보세요.
          </p>
          <div className="remote-path">
            <button className="header-btn" onClick={up} title="상위 폴더">
              ↑
            </button>
            <div className="remote-path-main">
              <div className="remote-breadcrumbs" aria-label="현재 경로">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="remote-crumb-wrap">
                    {i > 0 && <span className="remote-crumb-sep">/</span>}
                    <button className="remote-crumb" type="button" onClick={() => load(c.path)}>
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
              <code className="remote-cwd">{cwd}</code>
            </div>
            <button className="header-btn" onClick={() => load(cwd)} title="새로고침">
              ⟳
            </button>
            <select
              className="sort-select remote-sort"
              value={sortMode}
              title="정렬"
              aria-label="원격 폴더 정렬"
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              className="header-btn"
              type="button"
              disabled={!canSyncOneDrive}
              title={
                canSyncOneDrive
                  ? '현재 OneDrive 위치를 rclone으로 클라우드에서 최신화'
                  : 'OneDrive 또는 CloudStorage/OneDrive 폴더로 이동한 뒤 사용하세요'
              }
              onClick={() =>
                setSyncOpen({
                  macFolder: syncPath,
                  reloadPath: syncPath
                })
              }
            >
              OneDrive 최신화
            </button>
          </div>
          <div className="remote-quick">
            <span className="muted small">빠른 시작</span>
            {REMOTE_START_POINTS.map((p) => (
              <button key={p.path} className="remote-chip" type="button" onClick={() => load(p.path)}>
                {p.label}
              </button>
            ))}
          </div>
          <form
            className="remote-jump"
            onSubmit={(e) => {
              e.preventDefault()
              if (canUsePathInput) load(pathInput)
            }}
          >
            <input
              className="setting-input"
              placeholder="원격 경로 입력: /Users/me/OneDrive/진행중사건"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
            />
            <button className="header-btn" type="submit" disabled={!canUsePathInput}>
              이동
            </button>
            <button
              className="header-btn"
              type="button"
              disabled={!canUsePathInput}
              onClick={() => canUsePathInput && onPick(pathInput.trim())}
            >
              입력 경로 선택
            </button>
          </form>
          <div className="remote-list">
            {loading && <p className="muted pad small">불러오는 중…</p>}
            {!loading && err && (
              <div className="pad">
                <p className="muted small">
                  목록을 가져오지 못했습니다. 다른 시작 위치를 눌러보거나 경로를 직접 입력하세요.
                </p>
                <pre className="remote-err">{err}</pre>
              </div>
            )}
            {!loading && !err && dirs.length === 0 && (
              <p className="muted pad small">
                하위 폴더가 없습니다. 아래 ‘{confirmLabel}’를 누르거나 상위로 이동하세요.
              </p>
            )}
            {!loading &&
              !err &&
              dirs.map((e) => (
                <button
                  key={e.path}
                  className="remote-row"
                  onClick={() => load(e.path)}
                  title={e.path}
                >
                  📁 {e.name}
                </button>
              ))}
          </div>
          <div className="modal-actions">
            <button className="empty-action" onClick={() => onPick(cwd)}>
              {confirmLabel}
            </button>
            <button className="header-btn" onClick={onCancel}>
              취소
            </button>
          </div>
        </div>
      </div>
      {syncOpen && (
        <SyncModal
          profiles={[profile]}
          init={{ profile, macFolder: syncOpen.macFolder }}
          onClose={closeSync}
        />
      )}
    </>
  )
}

// rclone 동기화 모달 (클라우드 경유) — 맥에서 rclone 실행: 맥 사건폴더 ↔ OneDrive 클라우드.
// 올리기(맥→클라우드)/내리기(클라우드→맥) 두 버튼. Windows는 자신의 OneDrive 앱으로 받음.
function SyncModal({
  profiles,
  init,
  onClose
}: {
  profiles: SshProfile[]
  init: { profile: SshProfile; macFolder: string }
  onClose: () => void
}): JSX.Element {
  const [profileId, setProfileId] = useState(init.profile.id)
  const [macFolder, setMacFolder] = useState(init.macFolder)
  const [remoteName, setRemoteName] = useState('') // 예: "onedrive:"
  const [cloudPath, setCloudPath] = useState(cloudPathFromOneDrivePath(init.macFolder))
  const [syncMode, setSyncMode] = useState<'full' | 'folders'>('full')
  const [info, setInfo] = useState<{ installed: boolean; remotes: string[]; error?: string } | null>(
    null
  )
  const [log, setLog] = useState<string[]>([])
  const [runningDirection, setRunningDirection] = useState<'pull' | 'push' | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const profile = profiles.find((p) => p.id === profileId) ?? init.profile
  const running = runningDirection !== null
  const runningLabel =
    runningDirection === 'pull' ? '내리기' : runningDirection === 'push' ? '올리기' : ''

  // 진행 로그 구독
  useEffect(() => window.lt.sync.onProgress((line) => setLog((l) => [...l, line])), [])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // 프로필 바뀌면 맥 rclone 정보(설치/리모트) 다시 조회
  const probe = (): void => {
    setInfo(null)
    window.lt.sync.remoteInfo(profile).then((r) => {
      setInfo(r)
      if (r.installed && r.remotes.length && !remoteName) {
        setRemoteName(r.remotes.find((x) => /one/i.test(x)) ?? r.remotes[0])
      }
    })
  }
  useEffect(probe, [profileId]) // eslint-disable-line react-hooks/exhaustive-deps

  const normalizedCloudPath = cloudPath.trim().replace(/^\/+/, '').normalize('NFC')
  const dest = remoteName ? remoteName + normalizedCloudPath : ''
  const canRun = Boolean(!running && info?.installed && macFolder.trim() && remoteName)
  const run = (direction: 'pull' | 'push'): void => {
    if (!canRun) return
    const label = direction === 'pull' ? '내리기' : '올리기'
    const modeLabel = syncMode === 'folders' ? '폴더명만' : '전체'
    setRunningDirection(direction)
    setLog((l) => [...l, `${label} 시작 (${modeLabel}): ${dest}`])
    window.lt.sync
      .run({ profile, direction, mode: syncMode, macFolder, dest })
      .then((r) => {
        if (!r.ok && r.error) setLog((l) => [...l, '오류: ' + r.error])
      })
      .catch((e) => setLog((l) => [...l, '오류: ' + String(e)]))
      .finally(() => setRunningDirection(null))
  }
  const cancelRun = (): void => {
    if (!running) return
    setLog((l) => [...l, `${runningLabel} 중단 요청...`])
    window.lt.sync.cancel()
  }

  return (
    <div className="modal-overlay" onMouseDown={running ? undefined : onClose}>
      <div className="modal sync-modal" aria-busy={running} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">⇅ 동기화 (맥미니 rclone · 사건폴더 ↔ OneDrive 클라우드)</div>

        <label className="sync-field">
          접속 프로필 (맥미니)
          <select
            className="setting-select"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.user}@{p.host})
              </option>
            ))}
          </select>
        </label>

        {info && !info.installed && (
          <div className="pad">
            <p className="muted small">
              맥미니에서 rclone을 실행할 수 없습니다. (rclone 미설치이거나 SSH 키/agent 인증이
              아닐 수 있습니다.)
            </p>
            {info.error && <pre className="remote-err">{info.error}</pre>}
            <p className="muted small">
              맥미니 터미널에서 <code>rclone config</code> 로 OneDrive 리모트를 한 번 만들어 두세요.
            </p>
            <button className="empty-action" onClick={probe}>
              다시 확인
            </button>
          </div>
        )}

        {info?.installed && (
          <>
            <label className="sync-field">
              rclone 리모트 (맥의 OneDrive 설정)
              <select
                className="setting-select"
                value={remoteName}
                onChange={(e) => setRemoteName(e.target.value)}
              >
                {info.remotes.length === 0 && <option value="">(설정된 리모트 없음)</option>}
                {info.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="sync-field">
              맥 사건 폴더
              <input
                className="setting-input"
                value={macFolder}
                placeholder="/Users/me/Library/CloudStorage/OneDrive/진행중사건/사건폴더"
                onChange={(e) => setMacFolder(e.target.value)}
              />
            </label>
            <label className="sync-field">
              클라우드 경로 (리모트 내부)
              <input
                className="setting-input"
                value={cloudPath}
                placeholder="진행중사건/사건폴더 (비우면 OneDrive 루트)"
                onChange={(e) => setCloudPath(e.target.value)}
              />
            </label>
            <div className="sync-field">
              동기화 범위
              <div className="sync-mode" role="group" aria-label="동기화 범위">
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'full' ? 'active' : ''}`}
                  disabled={running}
                  onClick={() => setSyncMode('full')}
                >
                  전체
                </button>
                <button
                  type="button"
                  className={`sync-mode-btn ${syncMode === 'folders' ? 'active' : ''}`}
                  disabled={running}
                  onClick={() => setSyncMode('folders')}
                >
                  폴더명만
                </button>
              </div>
            </div>
            <p className="muted small">
              대상: <code>{dest || '(리모트:경로 미정)'}</code> ·{' '}
              {syncMode === 'folders' ? (
                <>
                  파일 복사 없이 폴더 구조만 생성(<b>삭제 전파 안 함</b>)
                </>
              ) : (
                <>
                  copy --update(빈 폴더 포함, <b>삭제 전파 안 함</b>)
                </>
              )}
            </p>
            <div className="sync-buttons">
              <button className="empty-action" disabled={!canRun} onClick={() => run('push')}>
                {runningDirection === 'push' ? '올리기 진행 중...' : '⬆ 올리기 (맥 → 클라우드)'}
              </button>
              <button className="empty-action" disabled={!canRun} onClick={() => run('pull')}>
                {runningDirection === 'pull' ? '내리기 진행 중...' : '⬇ 내리기 (클라우드 → 맥)'}
              </button>
            </div>
            {running && (
              <div className="sync-status" role="status" aria-live="polite">
                <div className="sync-status-main">
                  <span className="sync-spinner" aria-hidden="true" />
                  <div>
                    <b>{runningLabel} 진행 중...</b>
                    <span>완료될 때까지 동기화 버튼은 비활성화됩니다.</span>
                  </div>
                </div>
                <button className="header-btn danger" onClick={cancelRun}>
                  중단
                </button>
              </div>
            )}
            {log.length > 0 && (
              <pre className="sync-log" ref={logRef}>
                {log.join('\n')}
              </pre>
            )}
          </>
        )}

        {!info && <p className="muted pad small">맥미니 rclone 확인 중…</p>}

        <div className="modal-actions">
          <button className="header-btn" onClick={onClose} disabled={running}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

function Empty({
  label,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary
}: {
  label: string
  actionLabel: string
  onAction: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}): JSX.Element {
  return (
    <div className="empty">
      <p className="muted">{label}</p>
      <button className="empty-action" onClick={onAction}>
        ＋ {actionLabel}
      </button>
      {secondaryLabel && onSecondary && (
        <button className="header-btn empty-secondary" onClick={onSecondary}>
          {secondaryLabel}
        </button>
      )}
    </div>
  )
}
