import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'
import * as summary from '../src/shared/todoSummary.ts'
const directory = await fs.mkdtemp(path.join(tmpdir(), 'legal-terminal-case-management-'))
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const model = {}
vm.runInNewContext(compile('../src/shared/caseManagement.ts'), { exports: model, require: () => summary })
const settingsCode = compile('../src/main/settings.ts')
let failRename = false
function settingsModule() {
  const exports = {}
  vm.runInNewContext(settingsCode, { exports, structuredClone, require(name) {
    if (name === 'electron') return { app: { getPath: () => directory } }
    if (name === 'fs/promises') return { ...fs, rename: async (...args) => { if (failRename) throw Error('synthetic disk failure'); return fs.rename(...args) } }
    if (name === 'path') return path
    if (name === 'crypto') return crypto
    if (name === '../shared/caseManagement') return model
    if (name === '../shared/todoSummary') return summary
    throw Error(name)
  } })
  return exports
}
const plain = value => JSON.parse(JSON.stringify(value))
try {
  let api = settingsModule()
  let state = await api.getCaseManagementState()
  assert.equal(state.revision, 0)
  const initialGeneration = state.generation
  const focus = { date: '2026-09-30', taskIds: ['a', 'b', 'c', 'd'] }
  state = await api.updateCaseManagementState({ ...state, patch: { selectedTaskByCase: { caseA: 'a' }, focus, recovery: { caseId: 'caseA', seenCaseIds: ['caseB'] } } })
  api = settingsModule()
  assert.deepEqual(plain(await api.getCaseManagementState()), plain(state), 'restart preserves the UI generation and refs')
  await Promise.all([api.setSettings({ termFontSize: 17 }), api.setSettings({ notificationVolume: 50 }), api.updateCaseManagementState({ ...state, patch: { previousFocus: { date: '2026-09-29', taskIds: ['old'] } } })])
  let saved = await api.getSettings()
  assert.equal(saved.termFontSize, 17)
  assert.equal(saved.notificationVolume, 50)
  assert.equal(saved.caseManagementState.ui.previousFocus.taskIds[0], 'old')
  await api.setSettings({ caseManagementState: { generation: 'evil', revision: 999, ui: model.emptyCaseManagementUi() }, pdfZoom: '125' })
  state = await api.getCaseManagementState()
  assert.equal(state.generation, initialGeneration, 'generic settings cannot overwrite personal state')
  const concurrent = await Promise.allSettled([
    api.updateCaseManagementState({ ...state, patch: { focus: null } }),
    api.updateCaseManagementState({ ...state, patch: { recovery: { caseId: 'caseC', seenCaseIds: [] } } })
  ])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1, 'stale revision cannot clobber a newer window')
  state = await api.getCaseManagementState()
  const switched = await Promise.allSettled([
    api.setSettings({ jurisupportTokenEnc: 'plain:synthetic-B' }),
    api.updateCaseManagementState({ ...state, patch: { focus } })
  ])
  assert.equal(switched[0].status, 'fulfilled')
  assert.equal(switched[1].status, 'rejected')
  const fresh = await api.getCaseManagementState()
  assert.notEqual(fresh.generation, state.generation)
  assert.deepEqual(plain(fresh.ui), plain(model.emptyCaseManagementUi()))
  assert.equal(JSON.stringify(fresh).includes('synthetic-B'), false)
  assert.equal((await api.getSettings()).pdfZoom, '125')
  state = fresh
  const beforeFailure = await fs.readFile(path.join(directory, 'config.json'), 'utf8')
  failRename = true
  await assert.rejects(api.updateCaseManagementState({ ...state, patch: { focus } }), /disk failure/)
  assert.equal(await fs.readFile(path.join(directory, 'config.json'), 'utf8'), beforeFailure, 'failed atomic replacement leaves complete prior settings')
  assert.equal((await fs.readdir(directory)).some(file => file.endsWith('.tmp')), false)
  failRename = false
  state = await api.updateCaseManagementState({ ...state, patch: { focus } })
  for (const patch of [{ focus: { date: '2026-02-30', taskIds: [] } }, { recovery: { caseId: null, seenCaseIds: [42] } }, { selectedTaskByCase: { a: { secret: true } } }, { unknown: 'not UI state' }]) {
    await assert.rejects(api.updateCaseManagementState({ ...state, patch }), /형식/)
  }
  await api.setSettings({ jurisupportTokenEnc: undefined })
  const cleared = await settingsModule().getCaseManagementState()
  assert.notEqual(cleared.generation, state.generation)
  assert.equal(cleared.ui.focus, null)
  assert.equal((await api.getSettings()).jurisupportTokenEnc, undefined)
  await fs.writeFile(path.join(directory, 'config.json'), '{broken')
  await assert.rejects(api.setSettings({ termFontSize: 22 }))
  assert.equal(await fs.readFile(path.join(directory, 'config.json'), 'utf8'), '{broken', 'unreadable config cannot be overwritten with partial settings')
  console.log('case settings: restart, serialized writes, atomic failure, revisions, token reset, stale-account rejection and validation verified')
} finally { await fs.rm(directory, { recursive: true, force: true }) }
