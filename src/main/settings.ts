import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

/** 앱 전역 설정 (userData/config.json에 영구 저장) */
export interface Settings {
  /** 작성서류 루트 — 모든 사건의 작성서류가 하위 폴더로 존재 */
  draftsRoot?: string
  /** 소송기록 루트 — 사건별 전자소송기록 폴더가 하위에 존재 */
  recordsRoot?: string
  /** PDF 기본 배율: 'fit_page' | 'fit_width' | '50' | '100' | '125' | '150' | '200' */
  pdfZoom?: string
  /** 터미널 폰트 패밀리 */
  termFont?: string
  /** 터미널 글자 크기(px) */
  termFontSize?: number
  /** 마크다운 원본(소스) 폰트 패밀리 */
  mdFont?: string
  /** 마크다운 글자 크기(px) */
  mdFontSize?: number
  /** JuriSupport MCP 토큰 (safeStorage로 암호화된 base64) */
  jurisupportTokenEnc?: string
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
