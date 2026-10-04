import assert from 'node:assert/strict'

const { buildSetupItems, claudeLoginRecorded, installedPluginNames, setupCommands, setupReady } =
  await import('../src/main/setupCheckData.ts')
const { claudeConfigToken } = await import('../src/main/agentToken.ts')

const base = {
  platform: 'darwin',
  claudeInstalled: true,
  claudeLoggedIn: true,
  plugins: new Set(['jurisupport']),
  claudeTokenScope: 'user',
  codexInstalled: false,
  codexHasToken: false,
  appToken: 'none',
  ecourtInstalled: false
}
const byId = (items) => Object.fromEntries(items.map((item) => [item.id, item]))

// installed_plugins.json (Claude Code 2.1 형식)
const plugins = installedPluginNames(
  JSON.stringify({
    version: 2,
    plugins: {
      'jurisupport@jurisupport-plugins': [{ scope: 'user', version: '0.2.12' }],
      'legal-polish-public@jurisupport-plugins': [],
      'jurisupport-lawyer-profile@jurisupport-lawyer-profile': [{ scope: 'user' }]
    }
  })
)
assert.deepEqual([...plugins].sort(), ['jurisupport', 'jurisupport-lawyer-profile'])
assert.equal(installedPluginNames('{broken').size, 0)
assert.equal(installedPluginNames(null).size, 0)

// 로그인 흔적
assert.equal(claudeLoginRecorded(JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }), false), true)
assert.equal(claudeLoginRecorded(JSON.stringify({ userID: 'x' }), false), false)
assert.equal(claudeLoginRecorded(null, true), true)
assert.equal(claudeLoginRecorded('{broken', false), false)

// 등록 범위: 모든 폴더 vs 특정 폴더
const server = { type: 'http', url: 'https://api.jurisupport.com/mcp', headers: { Authorization: 'Bearer t' } }
assert.equal(claudeConfigToken(JSON.stringify({ mcpServers: { jurisupport: server } }))?.scope, 'user')
assert.equal(
  claudeConfigToken(JSON.stringify({ projects: { '/a': { mcpServers: { jurisupport: server } } } }))?.scope,
  'folder'
)

// 모두 준비됨: 필수 항목만 보고 판단, 선택 도구는 꺼져 있어도 준비 완료
let items = buildSetupItems(base)
assert.equal(setupReady(items), true)
assert.equal(byId(items).ecourt.state, 'off')
assert.equal(byId(items).codex, undefined) // Codex를 안 쓰면 줄 자체가 없다
assert.ok(byId(items).connection.actions.some((a) => a.kind === 'connect'))

// 아무것도 없는 새 컴퓨터: 설치기 명령 하나로 안내
items = buildSetupItems({
  ...base,
  claudeInstalled: false,
  claudeLoggedIn: false,
  plugins: new Set(),
  claudeTokenScope: null
})
assert.equal(setupReady(items), false)
assert.equal(byId(items).claude.state, 'missing')
assert.equal(byId(items).plugin.state, 'missing')
assert.equal(byId(items).connection.state, 'missing')
const install = byId(items).claude.actions.find((a) => a.kind === 'install')
assert.equal(install.command, setupCommands('darwin').install)
assert.match(install.command, /^bash <\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/jurisupport\/jurisupport-plugins\/main\/bootstrap\.sh\)$/)

// 예전 설치기로 폴더 단위 등록만 있는 경우: 경고 + 다시 등록 명령
items = buildSetupItems({ ...base, claudeTokenScope: 'folder' })
assert.equal(byId(items).connection.state, 'warn')
assert.equal(setupReady(items), false)

// 로그인 안 됨은 경고
items = buildSetupItems({ ...base, claudeLoggedIn: false })
assert.equal(byId(items).claude.state, 'warn')

// 앱에만 키가 있는 경우 안내 문구
items = buildSetupItems({ ...base, claudeTokenScope: null, appToken: 'stored' })
assert.match(byId(items).connection.detail, /이 앱에는 연결 키가 있지만/)

// Codex를 쓰는데 키가 없으면 선택 항목 경고(준비 완료 판단에는 영향 없음)
items = buildSetupItems({ ...base, codexInstalled: true })
assert.equal(byId(items).codex.state, 'warn')
assert.equal(setupReady(items), true)

// Windows 명령은 PowerShell 한 줄
const win = setupCommands('win32')
assert.match(win.install, /^irm https:\/\/raw\.githubusercontent\.com\/jurisupport\/jurisupport-plugins\/main\/windows-bootstrap\.ps1 \| iex$/)
assert.match(win.connect, /connect-mcp\.ps1 \| iex$/)

console.log('setup check ok')
