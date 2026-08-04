import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import {
  buildSshArgs,
  disposeSshControlMasters,
  getControlPathForProfile
} from '../src/main/sshOptions.ts'

function getOption(args, prefix) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-o' && args[index + 1].startsWith(prefix)) return args[index + 1]
  }
}

const profile = { user: 'svc', host: 'macmini.example.local', port: 680, identityFile: '/Users/me/.ssh/id_ed25519' }

const oneshot = buildSshArgs(profile, { usage: 'oneshot' })
const interactive = buildSshArgs(profile, { usage: 'interactive', tty: true, batchMode: false })

assert.equal(oneshot.includes('-tt'), false)
assert.equal(interactive.includes('-tt'), true)

assert.equal(oneshot.includes('-o'), true)
assert.ok(oneshot.includes('BatchMode=yes'))
assert.ok(oneshot.includes('ServerAliveInterval=30'))
assert.ok(oneshot.includes('ServerAliveCountMax=3'))
assert.ok(oneshot.includes('StrictHostKeyChecking=accept-new'))
assert.ok(interactive.includes('ServerAliveInterval=30'))
assert.ok(interactive.includes('ServerAliveCountMax=3'))
assert.ok(interactive.includes('StrictHostKeyChecking=accept-new'))

assert.ok(!interactive.includes('ControlMaster=auto'))
assert.ok(!interactive.includes('ControlPersist=60'))
assert.equal(getOption(interactive, 'ControlPath='), undefined)

const controlPathArg = getOption(oneshot, 'ControlPath=')
assert.ok(controlPathArg)
if (controlPathArg) {
  assert.equal(controlPathArg.startsWith('ControlPath='), true)
  const controlPath = controlPathArg.slice('ControlPath='.length)
  const openSshTemporaryPath = `${controlPath}.${'x'.repeat(16)}`
  assert.ok(
    Buffer.byteLength(openSshTemporaryPath) <= 103,
    `OpenSSH temporary control path too long: ${openSshTemporaryPath}`
  )
  assert.ok(existsSync(dirname(controlPath)), `controlPath parent does not exist: ${dirname(controlPath)}`)
}

const longProfile = {
  user: 'svc',
  host: `long-host-${'x'.repeat(220)}.example.com`,
  port: 680,
  identityFile: '/very/very/long/path/that/does/not/matter/for/uniqueness/anymore'
}
const longHostArgs = buildSshArgs(longProfile, { usage: 'oneshot' })
const longControlPathArg = getOption(longHostArgs, 'ControlPath=')
assert.ok(longControlPathArg)
if (longControlPathArg) {
  assert.equal(longControlPathArg.startsWith('ControlPath='), true)
  assert.ok(Buffer.byteLength(longControlPathArg.slice('ControlPath='.length)) <= 100)
}

const expectedControlPath = getControlPathForProfile(profile)
assert.ok(expectedControlPath.endsWith('.sock'))
assert.equal(dirname(expectedControlPath), tmpdir())
const hashPath = getControlPathForProfile(longProfile)
assert.ok(Buffer.byteLength(hashPath) <= 100)

const windows = buildSshArgs(profile, { usage: 'oneshot', platform: 'win32' })
assert.ok(!windows.includes('ControlMaster=auto'))
assert.ok(!windows.includes('ControlPersist=60'))
assert.equal(getOption(windows, 'ControlPath='), undefined)

const explicit = getControlPathForProfile({ ...profile, user: 'svc2', host: 'other.local' })
assert.notEqual(hashPath, explicit)

const syncSource = await readFile(new URL('../src/main/sync.ts', import.meta.url), 'utf8')
const agentSource = await readFile(new URL('../src/main/agent/agent-service.ts', import.meta.url), 'utf8')
const ptySource = await readFile(new URL('../src/main/pty/claude-pty.ts', import.meta.url), 'utf8')
const indexSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')

assert.match(syncSource, /buildSshArgs\(opts\.profile, \{ usage: 'oneshot' \}\)/)
assert.match(agentSource, /sshArgs\(session\.ssh, \{ usage: 'interactive' \}\), remoteCodexCommand/)
assert.match(agentSource, /sshArgs\(ssh, \{ usage: 'interactive' \}\), remoteClaudeCommand/)
assert.match(ptySource, /usage: 'interactive'/)
assert.match(indexSource, /disposeSshControlMasters\(\)/)

const stalePath = getControlPathForProfile({ user: 'stale-test', host: 'example.invalid' })
buildSshArgs({ user: 'stale-test', host: 'example.invalid' }, { usage: 'oneshot' })
writeFileSync(stalePath, 'stale')
disposeSshControlMasters()
assert.equal(existsSync(stalePath), false)

console.log('verify-ssh-options: OK')
