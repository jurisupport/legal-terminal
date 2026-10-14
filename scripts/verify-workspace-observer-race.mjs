import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const workspaceCode = compile(await readFile(new URL('../src/main/workspace.ts', import.meta.url), 'utf8'))
const sharedModule = { exports: {} }
vm.runInNewContext(compile(await readFile(new URL('../src/shared/workspaceAgentTabs.ts', import.meta.url), 'utf8')),
  { module: sharedModule, exports: sharedModule.exports })

for (const phase of ['local write', 'shared read', 'shared write']) {
  test(`observing an imported tab during an older ${phase} preserves its later close`, { timeout: 5000 }, async () => {
    const cwd = '/cases/observer-race'
    const location = { cwd }
    const home = '/virtual/home'
    const userData = '/virtual/data'
    const sharedPath = join(home, '.claude', 'legal-terminal-workspaces',
      `${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}.json`)
    const files = new Map()
    const directories = new Set()
    let localPath, blocked = false, signalPaused, release
    const paused = new Promise((resolve) => { signalPaused = resolve })
    const resumed = new Promise((resolve) => { release = resolve })
    const pause = async (at) => {
      if (phase !== at || blocked) return
      blocked = true
      signalPaused()
      await resumed
    }
    const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fs = {
      mkdir: async (path, options) => {
        if (directories.has(path) && !options?.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        directories.add(path)
      },
      readFile: async (path) => {
        if (!files.has(path)) throw missing()
        const contents = files.get(path)
        if (path === sharedPath) await pause('shared read')
        return contents
      },
      writeFile: async (path, contents) => {
        if (path === localPath) await pause('local write')
        if (path.startsWith(`${sharedPath}.`) && path.endsWith('.tmp')) await pause('shared write')
        files.set(path, contents)
      },
      rename: async (from, to) => {
        if (!files.has(from)) throw missing()
        files.set(to, files.get(from))
        files.delete(from)
      },
      rmdir: async (path) => { directories.delete(path) },
      stat: async () => ({ mtimeMs: Date.now() }),
      readdir: async () => []
    }
    const mocks = {
      electron: { app: { getPath: () => userData } },
      os: { homedir: () => home, hostname: () => 'test-desktop' },
      'fs/promises': fs,
      './sshOptions': { buildSshArgs: () => [] },
      '../shared/workspaceAgentTabs': sharedModule.exports
    }
    const module = { exports: {} }
    vm.runInNewContext(workspaceCode, { module, exports: module.exports,
      require: (id) => mocks[id] ?? require(id), process, Buffer, console, setTimeout, clearTimeout })
    const api = module.exports
    localPath = join(userData, 'workspaces', `${api.workspaceIdForLocation(cwd)}.json`)
    const snapshot = (ids) => ({ version: 1, savedAt: new Date().toISOString(),
      currentCase: { drafts: cwd, name: 'Observer race' },
      terminals: ids.map((id) => ({ id, kind: 'agent', cwd, resumeSessionId: id })) })
    files.set(sharedPath, JSON.stringify(snapshot(['A', 'B'])))
    await api.observeAutomaticWorkspace(location, snapshot(['A']), 1)

    const saving = api.saveAutomaticWorkspace(snapshot(['A']), location, 1)
    await paused
    // The renderer imports B while its earlier save still represents only A.
    const observing = api.observeAutomaticWorkspace(location, snapshot(['A', 'B']), 1)
    release()
    const [saved] = await Promise.all([saving, observing])
    assert.equal(saved.ok, true)
    assert.equal(saved.remoteError, undefined)
    assert.deepEqual(JSON.parse(files.get(sharedPath)).terminals.map((tab) => tab.id), ['A', 'B'],
      'the older save must not mistake newly observed B for a local close')

    const closed = await api.saveAutomaticWorkspace(snapshot(['A']), location, 1)
    assert.equal(closed.ok, true)
    assert.equal(closed.remoteError, undefined)
    const latest = JSON.parse(files.get(sharedPath))
    assert.deepEqual(latest.terminals.map((tab) => tab.id), ['A'],
      'closing imported B must persist after the earlier save finishes')
    assert.equal(latest.closedAgentTabs.some((tab) => tab.resumeSessionId === 'B'), true,
      'the close record must prevent another desktop from resurrecting B')
  })
}
