import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const workspaceCode = compile(await fs.readFile(new URL('../src/main/workspace.ts', import.meta.url), 'utf8') +
  '\nexport { saveSharedRemote };')
const sharedModule = { exports: {} }
vm.runInNewContext(compile(await fs.readFile(new URL('../src/shared/workspaceAgentTabs.ts', import.meta.url), 'utf8')),
  { module: sharedModule, exports: sharedModule.exports })
const snapshot = (revision = 0) => ({ version: 1, savedAt: '2026-10-14T00:00:00.000Z',
  workspaceId: 'test-workspace', workspaceLabel: '한글 사건 ⚖️', revision,
  terminals: [{ id: 'agent', kind: 'agent', cwd: '/cases/test', resumeSessionId: 'retained-session' }] })

async function fixture(t, { fileSystem = fs, transport, platform = process.platform } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'workspace-write-integrity-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const userData = join(directory, 'desktop')
  const home = join(directory, 'host')
  const mocks = {
    electron: { app: { getPath: () => userData } },
    os: { homedir: () => home, hostname: () => 'test-desktop' },
    'fs/promises': fileSystem,
    './sshOptions': { buildSshArgs: () => ['synthetic-host'] },
    '../shared/workspaceAgentTabs': sharedModule.exports,
    ...(transport ? { child_process: { spawn: (bin, args, options) => transport({ bin, args, options, home }) } } : {})
  }
  const module = { exports: {} }
  vm.runInNewContext(workspaceCode, { module, exports: module.exports,
    require: name => mocks[name] ?? require(name), process: { platform, pid: process.pid }, Buffer,
    console, setTimeout, clearTimeout })
  return { api: module.exports, directory, userData, home }
}

const shells = ['/bin/sh', ...(process.platform === 'darwin' ? ['/bin/zsh'] : [])]
for (const shell of shells) for (const platform of ['darwin', 'win32']) for (const failure of ['empty', 'partial']) {
  test(`remote ${platform} caller via ${shell} preserves the original on ${failure} input`,
    { skip: process.platform === 'win32' && 'POSIX remote commands run on macOS CI; Windows runs local write integrity checks' }, async t => {
      let inputMode = 'complete'
      const { api, home } = await fixture(t, { platform, transport({ bin, args, options, home }) {
        assert.equal(bin, platform === 'win32' ? 'ssh.exe' : 'ssh')
        assert.equal(options.windowsHide, true)
        assert.equal(args[0], 'synthetic-host')
        const proc = spawn(shell, ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: home } })
        const end = proc.stdin.end.bind(proc.stdin)
        proc.stdin.end = content => {
          const bytes = Buffer.from(content, 'utf8')
          return end(inputMode === 'empty' ? Buffer.alloc(0) : inputMode === 'partial' ? bytes.subarray(0, bytes.length - 1) : bytes)
        }
        return proc
      } })
      const folder = join(home, '.claude/legal-terminal-workspaces')
      const path = join(folder, `${createHash('sha256').update('/cases/test').digest('hex').slice(0, 24)}.json`)
      await fs.mkdir(folder, { recursive: true })
      const original = JSON.stringify(snapshot())
      await fs.writeFile(path, original)
      {
        inputMode = failure
        await assert.rejects(api.saveSharedRemote({ host: 'synthetic-host' }, '/cases/test', snapshot(1)), /다시 시도/)
        assert.equal(await fs.readFile(path, 'utf8'), original, `${failure} stdin must preserve the last good snapshot`)
        assert.deepEqual(await fs.readdir(folder), [path.split(/[\\/]/).at(-1)], 'failed upload removes its temporary file')
      }
      inputMode = 'complete'
      await api.saveSharedRemote({ host: 'synthetic-host' }, '/cases/test', snapshot(2))
      assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), snapshot(2), 'UTF-8 data replaces the old snapshot only after a complete upload')
      assert.equal((await fs.readdir(folder)).length, 1, 'successful upload leaves no temporary file')
    })
}

for (const target of ['manual', 'snapshot', 'index']) {
  for (const failure of ['write', 'rename']) {
    test(`${target} preserves its previous JSON and cleans up after a failed ${failure}`, async t => {
      let failPath
      const fileSystem = { ...fs,
        async writeFile(path, content, options) {
          if (failure === 'write' && failPath && (path === failPath || path.startsWith(`${failPath}.`))) {
            await fs.writeFile(path, Buffer.from(content).subarray(0, 10))
            throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' })
          }
          return fs.writeFile(path, content, options)
        },
        async rename(from, to) {
          if (failure === 'rename' && to === failPath) throw Object.assign(new Error('simulated replacement denied'), { code: 'EPERM' })
          return fs.rename(from, to)
        }
      }
      const { api, userData } = await fixture(t, { fileSystem })
      const manualPath = join(userData, 'manual.json')
      const save = revision => api.saveWorkspaceSnapshot(snapshot(revision), target === 'manual' ? manualPath : undefined)
      assert.equal((await save(0)).ok, true)
      failPath = target === 'manual' ? manualPath : join(userData, 'workspaces', target === 'index' ? 'workspace-index.json' : 'test-workspace.json')
      const original = await fs.readFile(failPath, 'utf8')
      const result = await save(1)
      assert.equal(result.ok, false)
      assert.match(result.error, failure === 'write' ? /disk full/ : /replacement denied/)
      assert.equal(await fs.readFile(failPath, 'utf8'), original)
      assert.equal((await fs.readdir(target === 'manual' ? userData : join(userData, 'workspaces'))).some(name => name.endsWith('.tmp')), false)
    })
  }
}

test('concurrent readers see complete local snapshots, exports and workspace index JSON', async t => {
  let slowWrites = false
  const fileSystem = { ...fs, async writeFile(path, content, options) {
    if (!slowWrites) return fs.writeFile(path, content, options)
    // Force a reader-visible interval between truncation and completion on the real filesystem.
    const bytes = Buffer.from(content)
    const halfway = Math.floor(bytes.length / 2)
    await fs.writeFile(path, bytes.subarray(0, halfway))
    await new Promise(resolve => setTimeout(resolve, 2))
    await fs.appendFile(path, bytes.subarray(halfway))
  } }
  const { api, userData } = await fixture(t, { fileSystem })
  const manualPath = join(userData, 'export.json')
  assert.equal((await api.saveWorkspaceSnapshot(snapshot())).ok, true)
  assert.equal((await api.saveWorkspaceSnapshot(snapshot(), manualPath)).ok, true)
  const paths = [manualPath, join(userData, 'workspaces/test-workspace.json'), join(userData, 'workspaces/workspace-index.json')]
  slowWrites = true
  let done = false
  let reads = 0
  let readError
  const reading = (async () => {
    while (!done) {
      for (const path of paths) {
        const parsed = JSON.parse(await fs.readFile(path, 'utf8'))
        assert.equal(parsed.version, 1)
        reads++
      }
    }
  })().catch(error => { readError = error })
  try {
    for (let revision = 1; revision <= 20; revision++) {
      const stored = await api.saveWorkspaceSnapshot(snapshot(revision))
      assert.equal(stored.ok, true, `snapshot revision ${revision}: ${stored.error ?? 'save failed'}`)
      const exported = await api.saveWorkspaceSnapshot(snapshot(revision), manualPath)
      assert.equal(exported.ok, true, `export revision ${revision}: ${exported.error ?? 'save failed'}`)
    }
  } finally {
    done = true
    await reading
  }
  if (readError) throw readError
  assert.ok(reads > 20, 'read integrity was checked while writes were in progress')
  assert.equal(JSON.parse(await fs.readFile(paths[1], 'utf8')).revision, 20)
  assert.equal(JSON.parse(await fs.readFile(paths[2], 'utf8')).entries.length, 1)
})
