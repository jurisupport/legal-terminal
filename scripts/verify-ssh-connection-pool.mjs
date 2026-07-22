import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main/remoteFs.ts', import.meta.url), 'utf8')
const connectionCode = source.match(/function connect\([\s\S]*?\n}\n\nasync function execRemoteCommand/)?.[0] ?? ''
const renderer = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const mountCode = renderer.match(/const visibleTermTabs =[\s\S]*?const activeDocTab =/)?.[0] ?? ''
const pty = await readFile(new URL('../src/main/pty/claude-pty.ts', import.meta.url), 'utf8')
const agents = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')

assert.match(connectionCode, /pool\.get\(profileId\) === connection/)
assert.match(connectionCode, /removeConnection\(profileId, existing\)/)
assert.match(connectionCode, /removeConnection\(profileId, fresh\)/)
assert.match(connectionCode, /if \(err\) \{\s+failConnection\(err\)/)
assert.match(connectionCode, /client\.on\('error', failConnection\)/)
assert.match(connectionCode, /client\.destroy\(\)/)
assert.equal(connectionCode.match(/pool\.delete\(profileId\)/g)?.length, 1)
assert.match(mountCode, /activeTermIds/)
assert.match(mountCode, /for \(const id of activeTermIds\)/)
assert.doesNotMatch(mountCode, /for \(const term of visibleTermTabs\)/)
assert.match(mountCode, /mountedTermIds\.has\(term\.id\) \|\| activeTermIds\.has\(term\.id\)/)
assert.match(pty, /ssh\?\.remoteControl[\s\S]*--remote-control/)
assert.match(agents, /session\.ssh\?\.remoteControl/)
assert.match(agents, /app-server daemon bootstrap --remote-control/)
assert.match(agents, /app-server proxy/)
assert.match(renderer, /checked=\{p\.remoteControl === true\}/)
assert.match(renderer, /host: '', user: '', remoteControl: true/)

console.log('verify-ssh-connection-pool: OK')
