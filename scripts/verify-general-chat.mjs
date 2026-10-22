import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { GENERAL_CHAT_FOLDER, isGeneralChatDirectory } from '../src/shared/generalChat.ts'
import { resolveAgentContextKind, buildAgentWorkspaceContext } from '../src/shared/agentWorkspaceContext.ts'
import { mergeWorkspaceSessions } from '../src/renderer/src/workspaceSessions.ts'

const source = await fs.readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let handler
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'ipcMain.handle' &&
      node.arguments[0]?.text === 'app:generalChatDirectory') handler = node.arguments[1].getText(parsed)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.ok(handler, 'exercise the actual directory IPC handler')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'general-chat-'))
const profile = { id: 'phone-host', user: 'lawyer', host: 'phone.invalid' }
let remoteExists = false, remoteIsDir = true, offline = false, remoteCreates = 0
const prepare = vm.runInNewContext(ts.transpileModule(`(${handler})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, {
  app: { getPath: (key) => { assert.equal(key, 'home'); return home } },
  join: path.join, posix: path.posix, mkdir: fs.mkdir, GENERAL_CHAT_FOLDER,
  getSettings: async () => ({ sshProfiles: [profile] }),
  listRemoteDir: async (selected, directory) => {
    assert.equal(selected, profile)
    assert.equal(directory, '~')
    return offline ? { ok: false, error: 'offline' } : { ok: true, cwd: '/home/lawyer', entries: [] }
  },
  makeRemote: (id, directory) => `ssh://${id}${directory}`,
  rfsMkdir: async (parent, name) => {
    assert.equal(parent, 'ssh://phone-host/home/lawyer')
    assert.equal(name, GENERAL_CHAT_FOLDER)
    if (remoteExists) throw new Error('already exists')
    remoteExists = true
    remoteCreates++
  },
  rfsStat: async (uri) => {
    assert.equal(uri, 'ssh://phone-host/home/lawyer/legal-terminal-general')
    return { isDir: remoteIsDir }
  }
})

try {
  const directory = await prepare(null)
  assert.equal(directory, path.join(home, GENERAL_CHAT_FOLDER))
  await fs.writeFile(path.join(directory, 'keep.txt'), 'existing general chat files')
  assert.equal(await prepare(null), directory)
  assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'existing general chat files')
  assert.equal(await prepare(null, profile.id), '/home/lawyer/legal-terminal-general')
  assert.equal(await prepare(null, profile.id), '/home/lawyer/legal-terminal-general')
  assert.equal(remoteCreates, 1, 'existing Android folder is reused')
  remoteIsDir = false
  await assert.rejects(prepare(null, profile.id), /already exists/, 'do not accept a file as a workspace')
  offline = true
  await assert.rejects(prepare(null, profile.id), /offline/, 'do not silently switch shared questions to local storage')
  await assert.rejects(prepare(null, 'missing'), /원격 연결/)
} finally {
  await fs.rm(home, { recursive: true, force: true })
}

for (const cwd of ['/home/lawyer/legal-terminal-general', 'C:\\Users\\lawyer\\legal-terminal-general\\']) {
  assert.equal(isGeneralChatDirectory(cwd), true)
  assert.equal(resolveAgentContextKind({ cwd }), 'global', 'Android tabs without scope metadata are general questions')
  assert.equal(resolveAgentContextKind({ cwd, contextKind: 'folder' }), 'global')
  assert.equal(resolveAgentContextKind({ cwd, jsId: 'explicit-case' }), 'case', 'an explicit case remains scoped')
}
assert.equal(isGeneralChatDirectory('/home/lawyer/legal-terminal-general-backup'), false)
assert.equal(resolveAgentContextKind({ cwd: '/cases/normal' }), 'folder')
const context = buildAgentWorkspaceContext({ kind: 'global', cwd: '/home/lawyer/legal-terminal-general' })
assert.match(context, /일반 질문은 질문 자체에 답/)
assert.doesNotMatch(context, /draftsFolder|"caseId"/)

// Android sharedAgentSnapshot omits contextKind and uses the same cwd-keyed format.
const cwd = '/home/lawyer/legal-terminal-general'
const phoneTab = { id: 'mobile-shared', title: '폰 질문', kind: 'agent', agentProvider: 'claude',
  cwd, resumeSessionId: 'phone-session', originDevice: 'android', side: 'right' }
const phone = { version: 1, savedAt: '2026-10-13T00:00:00Z', workspaceDevice: 'Android', workspaceOpen: true,
  mode: 'explorer', currentCase: { name: '일반 작업', drafts: cwd }, docs: [], terminals: [phoneTab], activeTerm: phoneTab.id }
const desktop = { ...phone, terminals: [{ id: 'pc-new', title: '일반 질문', kind: 'agent',
  agentProvider: 'claude', contextKind: 'folder', cwd, originDevice: 'desktop', side: 'right' }] }
const restored = mergeWorkspaceSessions(desktop, phone)
assert.equal(restored.terminals.length, 2)
assert.equal(restored.terminals.find(tab => tab.resumeSessionId === 'phone-session').originDevice, 'android')
const roundTrip = mergeWorkspaceSessions(restored, phone)
assert.equal(roundTrip.terminals.length, 2, 'reading the phone snapshot again does not duplicate sessions')
assert.equal(resolveAgentContextKind(roundTrip.terminals.find(tab => tab.id === phoneTab.id)), 'global')
console.log('General chat: local/SSH directory safety, Android scope and session round-trip passed')
