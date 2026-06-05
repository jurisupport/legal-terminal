import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

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
  /** 원격 작성서류 루트 — 사건 폴더 고를 때 시작 위치 */
  draftsRoot?: string
  /** 원격 소송기록 루트 (Phase 2 예정) */
  recordsRoot?: string
  /** 원격 폴더 선택기 빠른 시작 경로 목록 */
  quickStartPaths?: string[]
}

/** 앱 전역 설정 (userData/config.json에 영구 저장) */
export interface Settings {
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
  /** 마크다운 원본(소스) 폰트 패밀리 */
  mdFont?: string
  /** 마크다운 글자 크기(px) */
  mdFontSize?: number
  /** Agent Panel 답변 글자 크기(px) */
  agentFontSize?: number
  /** 파일 탐색기 정렬 방식 */
  explorerSortMode?: string
  /** 원격 폴더 선택기 정렬 방식 */
  remotePickerSortMode?: string
  /** JuriSupport MCP 토큰 (safeStorage로 암호화된 base64) */
  jurisupportTokenEnc?: string
  /** 사용자가 건너뛴 최신 릴리스 버전. 더 높은 버전이 나오면 다시 알린다. */
  ignoredUpdateVersion?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export async function getSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}
