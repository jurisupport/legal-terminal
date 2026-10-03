// 시작 화면의 "준비 상태" 목록을 만드는 순수 함수 모음.
// 파일 읽기와 경로 확인은 setupCheck.ts가 하고, 여기는 읽어 온 사실로 항목만 만든다.

import type { ClaudeTokenScope } from './agentToken'

export type SetupItemState = 'ok' | 'warn' | 'missing' | 'off'

export interface SetupAction {
  label: string
  kind: 'install' | 'connect' | 'link'
  command?: string // 터미널에 붙여넣을 한 줄
  url?: string // 브라우저로 열 주소
}

export interface SetupItem {
  id: 'claude' | 'plugin' | 'connection' | 'codex' | 'polish' | 'ecourt'
  label: string
  state: SetupItemState
  detail: string
  optional?: boolean
  actions: SetupAction[]
}

export interface SetupFacts {
  platform: NodeJS.Platform
  claudeInstalled: boolean
  claudeLoggedIn: boolean
  plugins: ReadonlySet<string> // installed_plugins.json의 플러그인 이름(@ 앞부분)
  claudeTokenScope: ClaudeTokenScope | null
  codexInstalled: boolean
  codexHasToken: boolean
  appToken: 'stored' | 'locked' | 'none'
  ecourtInstalled: boolean
}

const RAW = 'https://raw.githubusercontent.com/jurisupport'
export const TOKEN_PAGE_URL = 'https://jurisupport.com/profile'

export function setupCommands(platform: NodeJS.Platform): { install: string; connect: string } {
  return platform === 'win32'
    ? {
        install: `irm ${RAW}/jurisupport-plugins/main/windows-bootstrap.ps1 | iex`,
        connect: `irm ${RAW}/jurisupport-lawyer-profile-plugin/main/connect-mcp.ps1 | iex`
      }
    : {
        install: `bash <(curl -fsSL ${RAW}/jurisupport-plugins/main/bootstrap.sh)`,
        connect: `curl -fsSL ${RAW}/jurisupport-lawyer-profile-plugin/main/connect-mcp.sh | bash`
      }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// ~/.claude/plugins/installed_plugins.json → 설치된 플러그인 이름.
// 키 형식은 "<플러그인>@<마켓플레이스>"다.
export function installedPluginNames(text: string | null): Set<string> {
  const names = new Set<string>()
  if (!text) return names
  try {
    const plugins = asObject(asObject(JSON.parse(text))?.plugins)
    for (const [key, entries] of Object.entries(plugins ?? {})) {
      if (Array.isArray(entries) && entries.length === 0) continue
      names.add(key.split('@')[0])
    }
  } catch {
    /* 깨진 파일은 설치 안 됨으로 본다 */
  }
  return names
}

// Claude 계정 로그인 흔적. API 키 방식은 여기서 알 수 없으므로 credentials 파일도 함께 본다.
export function claudeLoginRecorded(claudeJson: string | null, hasCredentialsFile: boolean): boolean {
  if (hasCredentialsFile) return true
  if (!claudeJson) return false
  try {
    return !!asObject(asObject(JSON.parse(claudeJson))?.oauthAccount)
  } catch {
    return false
  }
}

export function buildSetupItems(f: SetupFacts): SetupItem[] {
  const cmd = setupCommands(f.platform)
  const installAll: SetupAction = { kind: 'install', label: '설치 명령 복사', command: cmd.install }
  const connect = (label: string): SetupAction => ({ kind: 'connect', label, command: cmd.connect })
  const tokenPage: SetupAction = { kind: 'link', label: '연결 키 받기', url: TOKEN_PAGE_URL }
  const items: SetupItem[] = []

  items.push(
    !f.claudeInstalled
      ? {
          id: 'claude',
          label: 'Claude Code',
          state: 'missing',
          detail: '설치기 한 번으로 Claude Code와 JuriSupport 도구를 함께 설치합니다.',
          actions: [installAll]
        }
      : f.claudeLoggedIn
        ? { id: 'claude', label: 'Claude Code', state: 'ok', detail: '설치됨 · 로그인됨', actions: [] }
        : {
            id: 'claude',
            label: 'Claude Code',
            state: 'warn',
            detail: '로그인 기록이 없습니다. 오른쪽 터미널에서 claude를 실행해 로그인하세요.',
            actions: []
          }
  )

  items.push(
    f.plugins.has('jurisupport')
      ? {
          id: 'plugin',
          label: 'JuriSupport 플러그인',
          state: 'ok',
          detail: '설치됨 (/brief-protocol 등 소송 명령)',
          actions: []
        }
      : {
          id: 'plugin',
          label: 'JuriSupport 플러그인',
          state: 'missing',
          detail: '준비서면 작성 명령이 들어 있는 플러그인입니다. 설치기가 함께 설치합니다.',
          actions: [installAll]
        }
  )

  const appNote =
    f.appToken === 'stored'
      ? ''
      : ' 사건 대시보드도 이 키를 그대로 씁니다.'
  if (f.claudeTokenScope === 'user') {
    items.push({
      id: 'connection',
      label: 'JuriSupport 연결',
      state: 'ok',
      detail: `Claude Code에 모든 폴더용으로 등록됨.${appNote} 키는 30일마다 바뀌니 만료되면 같은 명령으로 다시 등록하세요.`,
      actions: [connect('키 다시 등록 명령 복사'), tokenPage]
    })
  } else if (f.claudeTokenScope === 'folder') {
    items.push({
      id: 'connection',
      label: 'JuriSupport 연결',
      state: 'warn',
      detail:
        '예전 방식으로 등록되어 특정 폴더에서만 연결됩니다. 아래 명령으로 다시 등록하면 모든 사건 폴더에서 연결됩니다.',
      actions: [connect('다시 등록 명령 복사'), tokenPage]
    })
  } else {
    items.push({
      id: 'connection',
      label: 'JuriSupport 연결',
      state: 'missing',
      detail:
        f.appToken === 'stored'
          ? '이 앱에는 연결 키가 있지만 Claude Code에는 등록되지 않았습니다. 한 번 등록하면 Claude Code·Codex·이 앱이 함께 씁니다.'
          : '연결 키를 받아 한 번만 등록하면 Claude Code·Codex·이 앱이 함께 씁니다.',
      actions: [tokenPage, connect('등록 명령 복사')]
    })
  }

  if (f.codexInstalled) {
    items.push(
      f.codexHasToken
        ? { id: 'codex', label: 'Codex 연결', state: 'ok', detail: 'JuriSupport 키 등록됨', optional: true, actions: [] }
        : {
            id: 'codex',
            label: 'Codex 연결',
            state: 'warn',
            detail: 'Codex에는 JuriSupport 키가 없습니다. 등록 명령을 실행하면 Codex에도 함께 들어갑니다.',
            optional: true,
            actions: [connect('등록 명령 복사')]
          }
    )
  }

  items.push(
    f.plugins.has('legal-polish-public')
      ? { id: 'polish', label: '문장 다듬기', state: 'ok', detail: '설치됨', optional: true, actions: [] }
      : {
          id: 'polish',
          label: '문장 다듬기',
          state: 'off',
          detail: '서면 문장을 다듬는 플러그인입니다. 설치기가 기본으로 함께 설치합니다.',
          optional: true,
          actions: [installAll]
        }
  )

  items.push(
    f.ecourtInstalled
      ? { id: 'ecourt', label: '전자소송 도구', state: 'ok', detail: '설치됨', optional: true, actions: [] }
      : {
          id: 'ecourt',
          label: '전자소송 도구',
          state: 'off',
          detail:
            '기록 내려받기·제출용 도구입니다. 필요하면 설치기를 실행하고 전자소송 도구 질문에 y를 누르세요.',
          optional: true,
          actions: [installAll]
        }
  )

  return items
}

export function setupReady(items: SetupItem[]): boolean {
  return items.every((item) => item.optional || item.state === 'ok')
}
