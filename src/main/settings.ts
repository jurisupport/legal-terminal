import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir, rename, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { emptyCaseManagementUi, type CaseManagementUi, type CaseManagementState, type CaseManagementPatch } from '../shared/caseManagement'
import { kstDateKey } from '../shared/todoSummary'
import type { AgentPermissionMode, AgentProvider } from './agent/agent-types'

/** SSH 접속 프로필 — 원격 서버에서 사건 작업(claude 실행 등)을 위한 저장된 연결. */
export interface SshProfile {
  /** 안정적인 식별자 */
  id: string
  /** 사용자에게 보이는 이름 (예: '사무실 서버') */
  label: string
  /** 호스트명 또는 IP */
  host: string
  /** 로그인 사용자명 */
  user: string
  /** 포트 (기본 22) */
  port?: number
  /** 개인키 파일 경로 (미지정 시 ssh-agent·기본 키 사용) */
  identityFile?: string
  /** Claude 터미널·Codex Agent를 공급자 공식 원격 제어에 등록 */
  remoteControl?: boolean
  /** 원격 작성서류 루트 — 사건 폴더 고를 때 시작 위치 */
  draftsRoot?: string
  /** 원격 소송기록 루트 (Phase 2 예정) */
  recordsRoot?: string
  /** 원격 폴더 선택기 빠른 시작 경로 목록 */
  quickStartPaths?: string[]
}

/** 서면(hwpx) 푸터에 넣는 사무실 정보 — 직접 입력분이 JuriSupport 계정 정보보다 우선 */
export interface OfficeProfileSettings {
  officeName?: string
  /** 상호 숨김 — 로고만 표시 (JuriSupport 상호도 무시) */
  hideOfficeName?: boolean
  phone?: string
  fax?: string
  email?: string
  address?: string
  /** 별도 푸터 텍스트 — 지정 시 사무실 정보 표 대신 이 텍스트를 쓴다 (줄바꿈 가능) */
  footerText?: string
  /** 로고 이미지 파일 경로 (PNG/JPEG) */
  logoPath?: string
}

/** 앱 전역 설정 (userData/config.json에 영구 저장) */
export interface Settings {
  /** Personal ID references; updated only through the revision-checked case-management API. */
  caseManagementState?: CaseManagementState
  /** 서면 푸터 사무실 정보 (직접 입력) */
  officeProfile?: OfficeProfileSettings
  /** 저장된 SSH 접속 프로필 목록 */
  sshProfiles?: SshProfile[]
  /** 작성서류 루트 — 모든 사건의 작성서류가 하위 폴더로 존재 */
  draftsRoot?: string
  /** 소송기록 루트 — 사건별 전자소송기록 폴더가 하위에 존재 */
  recordsRoot?: string
  /** 사건 대시보드에서 좌클릭 기본 열기 대상: local 또는 remote:<sshProfileId> */
  caseOpenTarget?: string
  /** PDF 기본 배율: 'fit_page' | 'fit_width' | '50' | '100' | '125' | '150' | '200' */
  pdfZoom?: string
  /** 터미널 폰트 패밀리 */
  termFont?: string
  /** 터미널 글자 크기(px) */
  termFontSize?: number
  /** 터미널 작업 완료/질문 대기 알림음 */
  notificationSound?: string
  /** 터미널 작업 완료/질문 대기 알림음 볼륨(0-100) */
  notificationVolume?: number
  /** 작업 완료 알림(토스트·OS 알림) 표시 — 질문 대기 알림은 항상 표시 (기본 켬) */
  notifyDone?: boolean
  /** 마크다운 원본(소스) 폰트 패밀리 */
  mdFont?: string
  /** 마크다운 글자 크기(px) */
  mdFontSize?: number
  /** Agent Panel 답변 글자 크기(px) */
  agentFontSize?: number
  /** Agent Panel 기본 권한 모드 */
  agentDefaultPermissionMode?: AgentPermissionMode
  /** 새 Agent Panel 기본 AI */
  agentDefaultProvider?: AgentProvider
  /** AI별 새 Agent 세션 기본 모델 */
  agentDefaultModels?: Partial<Record<AgentProvider, string>>
  /** 파일 탐색기 정렬 방식 */
  explorerSortMode?: string
  /** 원격 폴더 선택기 정렬 방식 */
  remotePickerSortMode?: string
  /** SSH 원격 폴더/파일 목록을 디스크에 저장해 다음 실행에서 재사용 */
  remoteDirectoryCache?: boolean
  /** SSH 원격 파일 내용을 디스크에 저장해 다음 실행에서 재사용 */
  remoteFileCache?: boolean
  /** 원격 OneDrive 경로에 저장한 파일을 rclone으로 즉시 클라우드에 올리기 */
  syncAutoPushOnSave?: boolean
  /** 마지막으로 사용한 원격 다운로드 저장 폴더 */
  lastDownloadDir?: string
  /** JuriSupport MCP 토큰 (safeStorage로 암호화된 base64) */
  jurisupportTokenEnc?: string
  /** OpenAI API 키 (safeStorage로 암호화된 base64) */
  openaiApiKeyEnc?: string
  /** 사용자가 건너뛴 최신 릴리스 버전. 더 높은 버전이 나오면 다시 알린다. */
  ignoredUpdateVersion?: string
  /** 설치 환경+스킬 이름 → 사용자가 "다시 묻지 않기"한 SKILL.md 해시. */
  dismissedSkillHash?: Record<string, string>
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

// All config writers share this queue; reads during a write wait for its atomic rename.
let writes: Promise<unknown> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation)
  writes = result.catch(() => {})
  return result
}
async function readSettings(): Promise<Settings> {
  try {
    const value = JSON.parse(await readFile(configPath(), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('설정 파일 형식을 확인해 주세요.')
    return value as Settings
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}
async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporary = `${configPath()}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, configPath())
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
function newCaseManagementState(): CaseManagementState {
  return { generation: randomUUID(), revision: 0, ui: emptyCaseManagementUi() }
}

export async function getSettings(): Promise<Settings> {
  await writes
  return readSettings()
}

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const { caseManagementState: _ignored, ...safePatch } = structuredClone(patch)
  return serialized(async () => {
    const current = await readSettings()
    const next = { ...current, ...safePatch }
    // Reset even for token reissue/removal; old in-flight UI writes cannot enter the new connection.
    if (Object.hasOwn(safePatch, 'jurisupportTokenEnc')) next.caseManagementState = newCaseManagementState()
    await writeSettings(next)
    return next
  })
}

function validateUiPatch(value: unknown): Partial<CaseManagementUi> {
  const fail = (): never => { throw new Error('사건 화면 설정 형식을 확인해 주세요.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const patch = value as Record<string, unknown>
  const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 512
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 20_000 || !value.every(validId)) return fail()
    return [...new Set(value)]
  }
  const result: Partial<CaseManagementUi> = {}
  for (const [key, entry] of Object.entries(patch)) {
    if (key === 'selectedTaskByCase') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail()
      const pairs = Object.entries(entry)
      if (pairs.length > 20_000 || pairs.some(([caseId, taskId]) => !validId(caseId) || !validId(taskId))) return fail()
      result.selectedTaskByCase = Object.fromEntries(pairs)
    } else if (key === 'focus' || key === 'previousFocus') {
      if (entry === null) { result[key] = null; continue }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail()
      const focus = entry as Record<string, unknown>
      if (Object.keys(focus).some(field => !['date', 'taskIds'].includes(field)) || typeof focus.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(focus.date) || kstDateKey(focus.date) !== focus.date) return fail()
      result[key] = { date: focus.date, taskIds: ids(focus.taskIds) }
    } else if (key === 'recovery') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail()
      const recovery = entry as Record<string, unknown>
      if (Object.keys(recovery).some(field => !['caseId', 'seenCaseIds'].includes(field)) || (recovery.caseId !== null && !validId(recovery.caseId))) return fail()
      result.recovery = { caseId: recovery.caseId as string | null, seenCaseIds: ids(recovery.seenCaseIds) }
    } else return fail()
  }
  return result
}

export function getCaseManagementState(): Promise<CaseManagementState> {
  return serialized(async () => {
    const settings = await readSettings()
    if (settings.caseManagementState) return settings.caseManagementState
    const state = newCaseManagementState()
    await writeSettings({ ...settings, caseManagementState: state })
    return state
  })
}

export function updateCaseManagementState(input: CaseManagementPatch): Promise<CaseManagementState> {
  // Snapshot and validate IPC input before entering the queue.
  if (!input || typeof input.generation !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    return Promise.reject(new Error('사건 화면 설정 버전을 확인해 주세요.'))
  }
  const generation = input.generation, revision = input.revision
  let patch: Partial<CaseManagementUi>
  try { patch = validateUiPatch(input.patch) } catch (error) { return Promise.reject(error) }
  return serialized(async () => {
    const settings = await readSettings()
    const current = settings.caseManagementState
    if (!current || current.generation !== generation) throw new Error('연결이 변경되었습니다. 사건 화면을 다시 조회해 주세요.')
    if (current.revision !== revision) throw new Error('다른 화면에서 선택이 변경되었습니다. 다시 조회해 주세요.')
    const state = { generation, revision: revision + 1, ui: { ...current.ui, ...patch } }
    await writeSettings({ ...settings, caseManagementState: state })
    return state
  })
}
