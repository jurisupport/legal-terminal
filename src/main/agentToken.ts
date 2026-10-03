// Claude Code·Codex에 이미 등록된 JuriSupport MCP 토큰을 찾는다.
// 설치기나 연결 스크립트로 한 번 등록한 토큰을 앱에서 다시 붙여넣지 않게 하려는 용도다.
// 파일 읽기는 호출하는 쪽(jurisupport.ts)이 하고, 여기는 문자열 해석만 한다.

const JURISUPPORT_MCP_HOST = 'api.jurisupport.com'

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function bearerToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value
    .trim()
    .replace(/^bearer\s+/i, '')
    .trim()
  if (!token || /\s/.test(token) || token.startsWith('<')) return null
  return token
}

function isJuriSupportUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).hostname === JURISUPPORT_MCP_HOST
  } catch {
    return false
  }
}

function tokenFromServer(value: unknown): string | null {
  const server = asObject(value)
  if (!server || !isJuriSupportUrl(server.url)) return null
  const headers = asObject(server.headers)
  if (!headers) return null
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
  return key ? bearerToken(headers[key]) : null
}

// ~/.claude.json: 사용자 전체 등록(mcpServers)을 먼저 보고,
// 없으면 예전 설치기가 폴더 단위로 남긴 등록(projects[경로].mcpServers)을 본다.
export function tokenFromClaudeConfig(text: string): string | null {
  let root: Record<string, unknown> | null
  try {
    root = asObject(JSON.parse(text))
  } catch {
    return null
  }
  if (!root) return null

  const userServers = asObject(root.mcpServers)
  const userToken = userServers ? tokenFromServer(userServers.jurisupport) : null
  if (userToken) return userToken

  const projects = asObject(root.projects)
  if (!projects) return null
  for (const project of Object.values(projects)) {
    const servers = asObject(asObject(project)?.mcpServers)
    const token = servers ? tokenFromServer(servers.jurisupport) : null
    if (token) return token
  }
  return null
}

// ~/.codex/config.toml의 [mcp_servers.jurisupport] 블록.
// 연결 스크립트가 쓰는 한 줄 형식(http_headers = { Authorization = "Bearer ..." })만 읽는다.
export function tokenFromCodexConfig(text: string): string | null {
  const block = text.match(/^\[mcp_servers\.jurisupport\][^\S\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1]
  if (!block) return null
  const url = block.match(/^url\s*=\s*"([^"]*)"/m)?.[1]
  if (!isJuriSupportUrl(url)) return null
  const auth = block.match(/^http_headers\s*=\s*\{[^}\n]*?"?Authorization"?\s*=\s*"([^"]*)"/im)?.[1]
  return bearerToken(auth)
}
