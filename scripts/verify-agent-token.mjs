import assert from 'node:assert/strict'

const { bearerToken, tokenFromClaudeConfig, tokenFromCodexConfig } = await import(
  '../src/main/agentToken.ts'
)

const server = (token, url = 'https://api.jurisupport.com/mcp') => ({
  type: 'http',
  url,
  headers: { Authorization: `Bearer ${token}` }
})

// 사용자 전체 등록(claude mcp add -s user)
assert.equal(
  tokenFromClaudeConfig(JSON.stringify({ mcpServers: { jurisupport: server('user-token') } })),
  'user-token'
)

// 사용자 전체 등록이 폴더 단위 등록보다 우선
assert.equal(
  tokenFromClaudeConfig(
    JSON.stringify({
      mcpServers: { jurisupport: server('user-token') },
      projects: { '/Users/a/jurisupport-plugins': { mcpServers: { jurisupport: server('old-token') } } }
    })
  ),
  'user-token'
)

// 예전 설치기가 남긴 폴더 단위 등록도 찾는다
assert.equal(
  tokenFromClaudeConfig(
    JSON.stringify({
      projects: {
        '/Users/a/empty': { mcpServers: {} },
        '/Users/a/jurisupport-plugins': { mcpServers: { jurisupport: server('local-token') } }
      }
    })
  ),
  'local-token'
)

// 다른 서버 주소, 자리표시자, 깨진 파일은 무시
assert.equal(
  tokenFromClaudeConfig(
    JSON.stringify({ mcpServers: { jurisupport: server('x', 'https://evil.example/mcp') } })
  ),
  null
)
assert.equal(
  tokenFromClaudeConfig(JSON.stringify({ mcpServers: { jurisupport: server('<MCP 토큰>') } })),
  null
)
assert.equal(tokenFromClaudeConfig('{not json'), null)
assert.equal(tokenFromClaudeConfig('[]'), null)

// 헤더 이름 대소문자
assert.equal(
  tokenFromClaudeConfig(
    JSON.stringify({
      mcpServers: {
        jurisupport: { url: 'https://api.jurisupport.com/mcp', headers: { authorization: 'bearer lower' } }
      }
    })
  ),
  'lower'
)

// Codex config.toml — 연결 스크립트가 쓰는 형식
const codex = [
  'model = "gpt-6"',
  '',
  '[mcp_servers.jurisupport]',
  'url = "https://api.jurisupport.com/mcp"',
  'http_headers = { Authorization = "Bearer codex-token" }',
  'disabled_tools = [',
  '  "studio_get_credits"',
  ']',
  'startup_timeout_sec = 20',
  '',
  '[mcp_servers.other]',
  'url = "https://example.com/mcp"',
  'http_headers = { Authorization = "Bearer other-token" }',
  ''
].join('\n')
assert.equal(tokenFromCodexConfig(codex), 'codex-token')

// 블록이 파일 끝에 있을 때
assert.equal(
  tokenFromCodexConfig(
    '[mcp_servers.jurisupport]\nurl = "https://api.jurisupport.com/mcp"\nhttp_headers = { "Authorization" = "Bearer last" }'
  ),
  'last'
)

// 환경변수 방식(bearer_token_env_var)은 파일에 토큰이 없으므로 null
assert.equal(
  tokenFromCodexConfig(
    '[mcp_servers.jurisupport]\nurl = "https://api.jurisupport.com/mcp"\nbearer_token_env_var = "JURISUPPORT_MCP_TOKEN"\n'
  ),
  null
)
assert.equal(tokenFromCodexConfig(codex.replace('api.jurisupport.com', 'evil.example')), null)

assert.equal(bearerToken('  Bearer  abc  '), 'abc')
assert.equal(bearerToken('Bearer a b'), null)
assert.equal(bearerToken(''), null)

console.log('agent token ok')
