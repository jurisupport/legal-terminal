import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SshConnectionPool } from '../src/main/sshConnectionPool.ts'

class MockClient {
  endCalls = 0
  destroyCalls = 0

  end() {
    this.endCalls += 1
  }

  destroy() {
    this.destroyCalls += 1
  }
}

{
  const clients = []
  let rejectFirst
  const pool = new SshConnectionPool(() => {
    const client = new MockClient()
    clients.push(client)
    if (clients.length === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = () => {
          client.destroy()
          reject(new Error('simulated readyTimeout'))
        }
      })
    }
    return Promise.resolve({ client, sftp: {} })
  }, 4)

  const calls = Array.from({ length: 10 }, () => pool.get('profile-a'))
  rejectFirst()
  const results = await Promise.allSettled(calls)

  assert.equal(clients.length, 2)
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 9)
  assert.equal(
    clients.filter(({ endCalls, destroyCalls }) => endCalls === 0 && destroyCalls === 0).length,
    1
  )

  const live = await pool.get('profile-a')
  pool.discard('profile-a', live)
  const replacement = await pool.get('profile-a')
  assert.equal(live.client.endCalls, 1)
  assert.notEqual(replacement, live)
}

{
  const clients = []
  const warnings = []
  let resolveFirst
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const pool = new SshConnectionPool(() => {
      const client = new MockClient()
      clients.push(client)
      return new Promise((resolve) => {
        resolveFirst = () => resolve({ client, sftp: {} })
      })
    }, 1)

    const first = pool.get('profile-a')
    await assert.rejects(pool.get('profile-b'), /원격 연결 상한\(1\) 초과/)
    assert.equal(clients.length, 1)
    assert.equal(warnings.length, 1)
    resolveFirst()
    await first
    pool.dispose()
  } finally {
    console.warn = originalWarn
  }
}

{
  const clients = []
  const pool = new SshConnectionPool(() => {
    const client = new MockClient()
    clients.push(client)
    if (clients.length === 1) {
      client.destroy()
      return Promise.reject(new Error('first attempt failed'))
    }
    return Promise.resolve({ client, sftp: {} })
  }, 1)

  await assert.rejects(pool.get('profile-a'), /first attempt failed/)
  await pool.get('profile-a')
  assert.equal(clients.length, 2)
  pool.dispose()
}

const poolSource = await readFile(new URL('../src/main/sshConnectionPool.ts', import.meta.url), 'utf8')
assert.equal(poolSource.match(/this\.pool\.delete\(profileId\)/g)?.length, 1)

const renderer = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const mountCode = renderer.match(/const visibleTermTabs =[\s\S]*?const activeDocTab =/)?.[0] ?? ''
const pty = await readFile(new URL('../src/main/pty/claude-pty.ts', import.meta.url), 'utf8')
const agents = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')

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
