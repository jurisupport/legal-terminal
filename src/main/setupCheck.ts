import { access, readFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { claudeConfigToken, tokenFromCodexConfig } from './agentToken'
import { appTokenState } from './jurisupport'
import {
  buildSetupItems,
  claudeLoginRecorded,
  installedPluginNames,
  setupReady,
  type SetupItem
} from './setupCheckData'

// 시작 화면의 "준비 상태": 이 컴퓨터에 깔린 도구와 JuriSupport 연결을 설정 파일만 보고 확인한다.
// GUI 앱은 로그인 셸 PATH를 못 받는 경우가 많아 claude/codex 명령을 실행하지 않는다.

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function anyExists(paths: string[]): Promise<boolean> {
  const found = await Promise.all(paths.map(exists))
  return found.some(Boolean)
}

function claudeBinaryCandidates(): string[] {
  const home = homedir()
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    ...(process.platform === 'win32'
      ? [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin'])
  ]
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)))
}

export interface SetupStatus {
  items: SetupItem[]
  ready: boolean
}

export async function setupStatus(): Promise<SetupStatus> {
  const home = homedir()
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const claudeJsonPath = join(claudeConfigDir || home, '.claude.json')
  const claudeDir = claudeConfigDir || join(home, '.claude')
  const codexDir = process.env.CODEX_HOME || join(home, '.codex')

  const [claudeJson, pluginsJson, codexToml, hasCredentials, codexInstalled, appToken] =
    await Promise.all([
      readTextIfExists(claudeJsonPath),
      readTextIfExists(join(claudeDir, 'plugins', 'installed_plugins.json')),
      readTextIfExists(join(codexDir, 'config.toml')),
      exists(join(claudeDir, '.credentials.json')),
      exists(codexDir),
      appTokenState()
    ])

  const claudeInstalled = claudeJson !== null || (await anyExists(claudeBinaryCandidates()))
  const ecourtInstalled = await anyExists([
    join(claudeDir, 'skills', 'ecfs'),
    join(home, 'ecourt-cli')
  ])

  const items = buildSetupItems({
    platform: process.platform,
    claudeInstalled,
    claudeLoggedIn: claudeLoginRecorded(claudeJson, hasCredentials),
    plugins: installedPluginNames(pluginsJson),
    claudeTokenScope: claudeJson ? (claudeConfigToken(claudeJson)?.scope ?? null) : null,
    codexInstalled,
    codexHasToken: codexToml ? tokenFromCodexConfig(codexToml) !== null : false,
    appToken,
    ecourtInstalled
  })
  return { items, ready: setupReady(items) }
}
