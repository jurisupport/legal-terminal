import { app } from 'electron'
import { get } from 'https'
import type { IncomingMessage } from 'http'

// GitHub 릴리스 기반 업데이트 확인.
// macOS 빌드는 코드서명이 없어 electron-updater(자동 교체)를 못 쓴다 —
// 새 버전이 있으면 릴리스 페이지를 열어 직접 내려받게 안내한다.

export interface GitHubRelease {
  tag_name?: string
  html_url?: string
}

export interface UpdateCheckResult {
  ok: boolean
  currentVersion: string
  latestVersion?: string
  updateAvailable?: boolean
  releaseUrl?: string
  error?: string
}

const RELEASES_API_URL = 'https://api.github.com/repos/jurisupport/legal-terminal/releases/latest'
export const GITHUB_PROJECT_URL = 'https://github.com/jurisupport/legal-terminal'

function parseVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    })
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a)
  const right = parseVersionParts(b)
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function httpGet(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  return new Promise((resolvePromise, reject) => {
    const req = get(url, { headers, timeout: 15000 }, (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`HTTP ${status || 'unknown'}`))
        return
      }
      resolvePromise(res)
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
  })
}

export async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await httpGet(RELEASES_API_URL, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'legal-terminal-update-check'
  })
  return await new Promise((resolvePromise, reject) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      body += chunk
    })
    res.on('error', reject)
    res.on('end', () => {
      try {
        resolvePromise(JSON.parse(body) as GitHubRelease)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const release = await fetchLatestRelease()
    const latestVersion = release.tag_name?.replace(/^v/i, '')
    if (!latestVersion) {
      return { ok: false, currentVersion, error: '최신 릴리스 정보를 읽지 못했습니다.' }
    }
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url ?? GITHUB_PROJECT_URL
    }
  } catch (error) {
    return {
      ok: false,
      currentVersion,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
