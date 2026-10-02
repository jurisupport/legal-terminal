import assert from 'node:assert/strict'
import {
  mergeWorkspaceSessions,
  sameWorkspaceSessions,
  workspaceSessionKeys
} from '../src/renderer/src/workspaceSessions.ts'
import { agentTabsOnly, mergeSharedAgentTabs } from '../src/shared/workspaceAgentTabs.ts'

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

{
  const mixed = {
    ...snapshot([term('agent', 's1'), { ...term('shell', 's2'), kind: 'terminal' }, null]),
    docs: [{ id: 'pdf', kind: 'pdf', path: '/private.pdf' }],
    caseTabs: [{ activeDocId: 'pdf' }], activeDoc: 'pdf', activeWork: { left: 'doc:pdf' },
    activeTerm: 'shell', pdfStatus: { pdf: {} }, crop: { on: true }
  }
  const shared = agentTabsOnly(mixed)
  assert.deepEqual(shared.terminals.map((tab) => tab.id), ['agent'])
  assert.deepEqual(shared.docs, [])
  for (const key of ['caseTabs', 'activeDoc', 'activeWork', 'pdfStatus', 'crop']) assert.equal(shared[key], undefined)
  assert.equal(shared.activeTerm, 'agent')
  assert.equal(mixed.docs.length, 1, 'manual backup must remain untouched')
  assert.equal(agentTabsOnly(snapshot([{}, { ...term('bad', 's'), agentProvider: 'unknown' }])).terminals.length, 0)
}

{
  const known = snapshot([term('pc', 's1')])
  const incoming = snapshot([term('pc-new', 's2')])
  const current = snapshot([term('pc', 's1'), term('phone', 's3')])
  const merged = mergeSharedAgentTabs(current, incoming, known)
  assert.deepEqual(merged.terminals.map((tab) => tab.resumeSessionId), ['s2', 's3'],
    'local close applies but phone tabs opened since last load survive')
  const again = mergeSharedAgentTabs(merged, incoming, incoming)
  assert.equal(again.terminals.length, 2, 'an unseen phone tab survives subsequent saves')
  const renamed = mergeSharedAgentTabs(current, snapshot([term('other-id', 's3')]), known)
  assert.equal(renamed.terminals.length, 1, 'session identity deduplicates different device tab ids')
  const blank = snapshot([term('blank', undefined)])
  assert.equal(mergeSharedAgentTabs(blank, snapshot([term('blank', 'started')]), blank).terminals.length, 1)
  assert.equal(mergeSharedAgentTabs(snapshot([term('blank', 'started')]), blank, blank).terminals[0].resumeSessionId, 'started',
    'an old blank tab must not erase a session started on another device')
  const clash = mergeSharedAgentTabs(snapshot([term('same', 'remote')]), snapshot([term('same', 'local')]), undefined)
  assert.deepEqual(clash.terminals.map((tab) => tab.id), ['same', 'same-2'])
}

{
  const local = snapshot([term('same-id', 's1')])
  const remote = { ...snapshot([term('same-id', 's2')]), activeTerm: 'same-id' }
  const merged = mergeWorkspaceSessions(local, remote)
  assert.equal(merged.activeTerm, 'same-id-2', 'active id follows collision remapping')
  const duplicate = mergeWorkspaceSessions(local, { ...snapshot([term('other-id', 's1')]), activeTerm: 'other-id' })
  assert.equal(duplicate.activeTerm, 'same-id')
  assert.equal(mergeWorkspaceSessions(local, snapshot([{ ...term('remote', 's1'), ssh: { user: 'u', host: 'server' } }])).terminals.length, 2)
  assert.equal(mergeWorkspaceSessions(local, snapshot([{ ...term('codex', 's1'), agentProvider: 'codex' }])).terminals.length, 2)
  assert.equal(mergeWorkspaceSessions(snapshot([{ ...term('case-a', 's1'), jsId: 'case-a' }]),
    snapshot([{ ...term('case-b', 's1'), jsId: 'case-b' }])).terminals.length, 2,
    'same-folder sessions from distinct cases must remain isolated')
  assert.equal(mergeWorkspaceSessions(local, snapshot([{ ...term('legacy', 's1'), agentProvider: undefined }])).terminals.length, 1)
  const started = mergeWorkspaceSessions(snapshot([term('blank', undefined)]), snapshot([term('blank', 'started')]))
  assert.equal(started.terminals.length, 1)
  assert.equal(started.terminals[0].resumeSessionId, 'started')
}
console.log('agent-only handover and concurrent-device merge: OK')

{
  const blank = snapshot([term('blank', undefined)])
  const started = snapshot([term('blank', 'started')])
  const closed = mergeSharedAgentTabs(started, snapshot([]), blank)
  const stale = snapshot([term('other-device-id', 'started')])
  assert.equal(mergeSharedAgentTabs(closed, stale, undefined).terminals.length, 0,
    'closing a blank tab retains the session identity learned by another device')
  assert.equal(mergeSharedAgentTabs(closed, blank, undefined).terminals.length, 0,
    'the original blank tab identity is also suppressed')
  const closedBeforeInit = mergeSharedAgentTabs(blank, snapshot([]), blank)
  const lateInit = mergeSharedAgentTabs(closedBeforeInit, started, blank)
  assert.equal(mergeSharedAgentTabs(lateInit, stale, undefined).terminals.length, 0,
    'a late session:init enriches a blank close record without reopening it')
  const reopened = mergeSharedAgentTabs(closed, stale, closed, stale.terminals)
  assert.equal(reopened.terminals.length, 1)
  assert.equal(reopened.closedAgentTabs.length, 0)
  assert.equal(mergeSharedAgentTabs(reopened, { ...stale, closedAgentTabs: closed.closedAgentTabs }, undefined).terminals.length, 1,
    'stale client close records cannot undo an intentional reopen')
}
