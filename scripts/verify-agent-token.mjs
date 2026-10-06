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

// Exercise the real adapter with isolated settings/config files and synthetic HTTP only.
const { readFileSync } = await import('node:fs')
const { createRequire } = await import('node:module')
const ts = (await import('typescript')).default
const require = createRequire(import.meta.url)
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const modules = { './agentToken': { tokenFromClaudeConfig, tokenFromCodexConfig } }
for (const [name, path] of [['./jurisupportNormalize', '../src/main/jurisupportNormalize.ts'], ['./mcpResponse', '../src/main/mcpResponse.ts'], ['../shared/todoSummary', '../src/shared/todoSummary.ts']]) {
  const exported = {}; new Function('require', 'exports', compile(path))(require, exported); modules[name] = exported
}
const adapterCode = compile('../src/main/jurisupport.ts')
function adapter({ stored = 'plain:synthetic-old', agent = 'synthetic-new', paths = require('node:path') } = {}) {
  const state = { settings: { jurisupportTokenEnc: stored }, agent, rejected: new Set(), posts: [], writes: [], events: 0, networkStatus: 200, beforeInitialize: null, beforePersist: null }
  let clock = Date.parse('2026-10-06T00:00:00Z')
  class Clock extends Date { static now() { return clock += 1000 } }
  const mockedRequire = (name) => modules[name] ?? ({
    electron: { app: { getPath: () => '/nonexistent-token-test' }, safeStorage: { isEncryptionAvailable: () => false, decryptString: () => { throw new Error('synthetic locked key') } } },
    './settings': { getSettings: async () => state.settings, setSettings: async (patch) => { await state.beforePersist?.(); state.settings = { ...state.settings, ...patch } } },
    'fs/promises': { rm: async () => {}, readFile: async (path) => {
      if (path.replaceAll('\\', '/').endsWith('/.claude.json') && state.agent) return JSON.stringify({ mcpServers: { jurisupport: server(state.agent) } })
      throw new Error('synthetic file missing')
    } },
    path: paths, os: { homedir: () => '/nonexistent-token-test-home' }, './imageSize': {}
  }[name] ?? require(name))
  const fetch = async (_url, options) => {
    const input = JSON.parse(options.body), token = options.headers.Authorization.slice('Bearer '.length)
    state.posts.push({ method: input.method, tool: input.params?.name, token })
    if (input.method === 'initialize') await state.beforeInitialize?.(token)
    const status = state.rejected.has(token) ? 401 : state.networkStatus
    let result = {}
    if (input.method === 'tools/list') result = { tools: [{ name: 'get_case' }, { name: 'update_task' }] }
    if (status === 200 && input.method === 'tools/call') {
      if (input.params.name === 'update_task') state.writes.push({ token, args: input.params.arguments })
      const value = input.params.name === 'get_case'
        ? { id: input.params.arguments.id, caseName: 'Synthetic case', caseNumber: null, parties: [] }
        : { id: input.params.arguments.id, title: 'Synthetic task', status: 'pending' }
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
    }
    return { status, headers: { get: (key) => key === 'mcp-session-id' && status === 200 ? `synthetic-session-${token}` : null }, text: async () => JSON.stringify(status === 200 ? { jsonrpc: '2.0', id: input.id, result } : { jsonrpc: '2.0', id: input.id, error: { message: `HTTP ${status}` } }) }
  }
  const api = {}
  new Function('require', 'exports', 'fetch', 'Date', 'process', adapterCode)(mockedRequire, api, fetch, Clock, { env: {} })
  api.onAgentMcpAccountChange(() => state.events++)
  return { api, state }
}
{
  const { api, state } = adapter({ stored: undefined })
  state.settings = {}
  assert.equal(await api.hasToken(), true)
  assert.equal(await api.appTokenState(), 'none')
  assert.equal((await api.getAgentMcpConnection()).token, 'synthetic-new')
  assert.equal(state.settings.jurisupportTokenEnc, undefined, 'initial reuse does not silently rewrite app credentials')
  state.agent = 'synthetic-other'
  await assert.rejects(api.updateTodo('old-account-task', { title: 'must not replay' }), /계정이 변경/)
  assert.equal(state.writes.length, 0)
  assert.equal(state.events, 1, 'external config changes invalidate the active account and views')
  assert.equal((await api.getAgentMcpConnection()).token, 'synthetic-other')
}
{
  const { api, state } = adapter()
  state.rejected.add('synthetic-old')
  const epoch = api.agentMcpAccountEpoch()
  await assert.rejects(api.updateTodo('old-account-task', { title: 'must not replay' }), /새 JuriSupport 연결 키/)
  assert.equal(state.writes.length, 0, 'credential fallback must never replay a mutation under the discovered account')
  assert.equal(state.settings.jurisupportTokenEnc, 'plain:synthetic-new')
  assert.ok(api.agentMcpAccountEpoch() > epoch)
  assert.equal(state.events, 2, 'recovery broadcasts account invalidation and settled refresh')
  assert.equal((await api.getAgentMcpConnection()).token, 'synthetic-new')
}
{
  const { api, state } = adapter()
  await api.getCase('old-account-case')
  state.rejected.add('synthetic-old')
  await assert.rejects(api.updateTodo('old-account-task', { title: 'no cross-account retry' }), /새 JuriSupport 연결 키/)
  assert.equal(state.writes.length, 0, 'expiration after session establishment follows the same no-replay boundary')
}
{
  const { api, state } = adapter()
  state.networkStatus = 503
  await assert.rejects(api.getCase('case'), /HTTP 503/)
  assert.equal(state.posts.some((post) => post.token === 'synthetic-new'), false, 'network/server errors never replace credentials')
  assert.equal(state.settings.jurisupportTokenEnc, 'plain:synthetic-old')
  assert.equal(state.events, 0)
}
{
  const { api, state } = adapter()
  state.rejected.add('synthetic-old')
  state.beforeInitialize = async (token) => { if (token === 'synthetic-new') await api.setToken('synthetic-user-selected') }
  await assert.rejects(api.getCase('case'), /계정이 변경/)
  assert.equal(state.settings.jurisupportTokenEnc, 'plain:synthetic-user-selected', 'manual changes during fallback validation must win')
  assert.equal(state.writes.length, 0)
}
{
  const { api, state } = adapter()
  state.rejected.add('synthetic-old')
  state.beforePersist = async () => { throw new Error('synthetic persistence failure') }
  await assert.rejects(api.getCase('case'), /persistence failure/)
  assert.equal(state.settings.jurisupportTokenEnc, 'plain:synthetic-old')
  assert.equal(state.events, 2, 'failed persistence still invalidates and refreshes account state')
  assert.equal(state.writes.length, 0)
}
{
  const { api } = adapter({ stored: 'v1:synthetic-locked' })
  assert.equal(await api.appTokenState(), 'locked')
  assert.equal(await api.tokenStatus(), 'ok', 'a usable registered agent key can serve while the app key remains locked')
}
console.log('agent token integration: initial reuse, external changes, rejected/expired key rotation, no cross-account replay, manual-change and persistence-failure guards passed')

for (const paths of [require('node:path').posix, require('node:path').win32]) {
  const { api, state } = adapter({ paths }); state.settings = {};
  assert.equal(await api.hasToken(), true, 'registered-token reuse supports both POSIX and Windows config paths');
}
console.log('agent token path portability: POSIX and Windows config lookups passed')
