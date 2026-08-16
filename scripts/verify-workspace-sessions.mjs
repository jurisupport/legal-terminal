import assert from 'node:assert/strict'
import {
  mergeWorkspaceSessions,
  sameWorkspaceSessions,
  workspaceSessionKeys
} from '../src/renderer/src/workspaceSessions.ts'

const snapshot = (terminals, docs = []) => ({
  version: 1,
  savedAt: '2026-08-17T00:00:00.000Z',
  mode: 'explorer',
  terminals,
  docs
})
const term = (id, resumeSessionId, cwd = '/cases/a') => ({
  id,
  title: id,
  kind: 'agent',
  agentProvider: 'claude',
  cwd,
  resumeSessionId
})

{
  const a = snapshot([term('a', 'session-1'), term('b', 'session-2')])
  const b = snapshot([term('renamed', 'session-2'), term('other', 'session-1')])
  assert.equal(sameWorkspaceSessions(a, b), true)
  assert.deepEqual(workspaceSessionKeys(a), workspaceSessionKeys(b))
}

{
  const local = snapshot(
    [term('same-id', 'session-local')],
    [{ id: 'doc', title: '로컬', kind: 'mdview', path: '/cases/a/local.md' }]
  )
  const remote = snapshot(
    [term('same-id', 'session-remote')],
    [
      { id: 'doc', title: '중복', kind: 'mdview', path: '/cases/a/local.md' },
      { id: 'doc', title: '원격', kind: 'mdview', path: '/cases/a/remote.md' }
    ]
  )
  const merged = mergeWorkspaceSessions(local, remote)
  assert.equal(merged.terminals.length, 2)
  assert.deepEqual(
    merged.terminals.map((item) => item.id),
    ['same-id', 'same-id-2']
  )
  assert.equal(merged.docs.length, 2)
  assert.deepEqual(
    merged.docs.map((item) => item.path),
    ['/cases/a/local.md', '/cases/a/remote.md']
  )
}

console.log('verify-workspace-sessions: OK')
