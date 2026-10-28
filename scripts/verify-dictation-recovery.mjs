import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const userData = await fs.mkdtemp(path.join(tmpdir(), 'dictation-recovery-'))
const directory = path.join(userData, 'dictation-recovery')
const source = await fs.readFile(new URL('../src/main/dictationRecovery.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
let calls = []
let response = async () => ({ ok: true, text: '보존된 전사 결과', corrected: false })
function load() {
  const api = {}
  runInNewContext(compiled, {
    exports: api, Buffer, Uint8Array, Error, AbortController,
    require: (name) => {
      if (name === 'electron') return { app: { getPath: (key) => { assert.equal(key, 'userData'); return userData } } }
      if (name === 'crypto') return crypto
      if (name === 'fs/promises') return fs
      if (name === 'path') return path
      if (name === './dictation') return { transcribe: async (input, signal) => { calls.push(input); return response(input, signal) } }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return api
}
function backup(id = 'entry-one', patch = {}) {
  return {
    id, recordId: 'record-one', caseKey: 'case-one', recordPath: '/original/hearing.json',
    recordJson: JSON.stringify({ id: 'record-one', entries: [{ id, text: '', dictation: { status: 'transcribing' } }] }),
    selection: { value: '기존 내용', start: 2, end: 3, message: '' }, startedAt: 100,
    input: { audio: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/webm', diarize: true }, ...patch
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

try {
  let api = load()
  assert.deepEqual(plain(await api.listDictationBackups({ caseKey: 'case-one' })), [])
  const original = backup()
  await api.saveDictationBackup(original)
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(directory, 'entry-one.json'))).mode & 0o777, 0o600)

  // Discard all module state: stopped audio and its hearing snapshot must still recover.
  api = load()
  let listed = await api.listDictationBackups({ caseKey: 'case-one' })
  assert.equal(listed.length, 1)
  assert.deepEqual(plain(listed[0]), plain(original))
  assert.deepEqual([...listed[0].input.audio], [1, 2, 3, 4])
  await api.saveDictationBackup(backup('entry-other', { caseKey: 'case-other' }))
  assert.deepEqual(plain((await api.listDictationBackups({ caseKey: 'case-one' })).map(({ id }) => id)), ['entry-one'])
  assert.deepEqual(plain((await api.listDictationBackups({ caseKey: 'case-other' })).map(({ id }) => id)), ['entry-other'])

  // Retry metadata may improve after a preceding queued recording resolves; original audio cannot change.
  const updated = {
    ...original.input, backupId: original.id, audio: new Uint8Array([99]), mimeType: 'bad/new-type',
    context: { caseNumber: '2026가단123', participants: [{ id: 'judge', label: '재판부' }] },
    knownSpeakers: [{ name: 'speaker_0', audio: new Uint8Array([10, 11]), participantId: 'judge' }],
    openaiApiKey: 'never-store-this-secret'
  }
  response = async () => ({ ok: false, error: 'network unavailable' })
  assert.equal((await api.transcribeWithBackup(updated)).ok, false)
  assert.deepEqual([...calls.at(-1).audio], [1, 2, 3, 4])
  assert.equal(calls.at(-1).mimeType, 'audio/webm')
  api = load()
  listed = await api.listDictationBackups({ caseKey: 'case-one' })
  assert.deepEqual(plain(listed[0].input.context), plain(updated.context))
  assert.deepEqual([...listed[0].input.knownSpeakers[0].audio], [10, 11])
  assert.equal((await fs.readFile(path.join(directory, 'entry-one.json'), 'utf8')).includes('never-store-this-secret'), false)

  response = async () => { throw new Error('connection reset') }
  await assert.rejects(api.transcribeWithBackup(updated), /connection reset/)
  assert.equal((await api.listDictationBackups({ caseKey: 'case-one' })).length, 1)

  const entered = deferred()
  const finish = deferred()
  response = async () => { entered.resolve(); return finish.promise }
  const count = calls.length
  const first = api.transcribeWithBackup(updated)
  const second = api.transcribeWithBackup(updated)
  await entered.promise
  assert.equal(calls.length, count + 1, 'Concurrent retries share one HTTP request')
  const success = { ok: true, text: '긴 전사의 완성본', corrected: false,
    segments: [{ speaker: 'speaker_0', text: '긴 전사의 완성본', start: 0, end: 2, participantId: 'judge', participantSource: 'voice' }] }
  finish.resolve(success)
  assert.deepEqual(plain(await first), success)
  assert.deepEqual(plain(await second), success)
  api = load()
  const cachedCalls = calls.length
  await api.saveDictationBackup(backup('entry-one', { input: { audio: new Uint8Array([99]), mimeType: 'audio/ogg' } }))
  assert.deepEqual(plain(await api.transcribeWithBackup(updated)), success)
  assert.equal(calls.length, cachedCalls, 'Success survives reload and idempotent save without a second HTTP request')

  // A removed recording must not be recreated by a late network response.
  await api.saveDictationBackup(backup('entry-remove'))
  const removingEntered = deferred()
  const removingFinish = deferred()
  let removingSignal
  response = async (_input, signal) => { removingSignal = signal; removingEntered.resolve(); return removingFinish.promise }
  const removed = api.transcribeWithBackup({ ...original.input, backupId: 'entry-remove' })
  await removingEntered.promise
  await api.removeDictationBackup('entry-remove')
  assert.equal(removingSignal.aborted, true, 'Deletion cancels active requests and their automatic retries')
  removingFinish.resolve(success)
  await removed
  await assert.rejects(fs.stat(path.join(directory, 'entry-remove.json')), { code: 'ENOENT' })
  await assert.rejects(api.transcribeWithBackup({ ...original.input, backupId: 'entry-remove' }), /복구 음성이 없습니다/)

  await api.saveDictationBackup(backup('entry-fallback', { caseKey: 'fallback-case' }))
  response = async () => ({ ok: true, text: '화자 없이 복구한 전사', corrected: false, fallback: 'whisper-1' })
  const fallbackInput = { ...original.input, backupId: 'entry-fallback' }
  const fallbackResult = plain(await api.transcribeWithBackup(fallbackInput))
  api = load()
  const fallbackCalls = calls.length
  assert.deepEqual(plain(await api.transcribeWithBackup(fallbackInput)), fallbackResult)
  assert.equal(fallbackResult.fallback, 'whisper-1')
  assert.equal(calls.length, fallbackCalls, 'Cached fallback retains its provenance without another API call')
  await api.removeDictationBackup('entry-fallback')

  for (const id of ['', '../escape', '/tmp/escape', 'entry.json', 'entry\\escape', 'a'.repeat(129)]) {
    await assert.rejects(api.saveDictationBackup(backup(id)), /올바르지/)
    await assert.rejects(api.removeDictationBackup(id), /올바르지/)
    await assert.rejects(api.transcribeWithBackup({ ...original.input, backupId: id }), /올바르지/)
  }
  for (const patch of [
    { recordJson: 'broken json' }, { recordId: 'different-record' }, { caseKey: '' }, { startedAt: -1 },
    { selection: { ...original.selection, end: 999 } },
    { input: { ...original.input, audio: new Uint8Array() } },
    { input: { ...original.input, audio: new Uint8Array(25 * 1024 * 1024 + 1) } },
    { recordJson: 'x'.repeat(8 * 1024 * 1024 + 1) }
  ]) await assert.rejects(api.saveDictationBackup(backup('entry-invalid', patch)))
  await assert.rejects(api.saveDictationBackup(backup('entry-one', { caseKey: 'different-case' })), /올바르지/)

  await fs.writeFile(path.join(directory, 'entry-damaged.json'), '{broken')
  const outside = path.join(userData, 'unrelated.json')
  await fs.writeFile(outside, 'do not modify')
  await fs.symlink(outside, path.join(directory, 'entry-link.json'))
  api = load()
  listed = await api.listDictationBackups({ caseKey: 'case-one' })
  assert.equal(listed.length, 1, 'One corrupt or symlinked entry must not hide valid backups')
  assert.equal(await fs.readFile(path.join(directory, 'entry-damaged.json'), 'utf8'), '{broken')
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not modify')
  assert.deepEqual(plain(await api.transcribeWithBackup(updated)), success)
  await api.removeDictationBackup('entry-one')
  await api.removeDictationBackup('entry-one')
  assert.equal((await api.listDictationBackups({ caseKey: 'case-one' })).length, 0)
  assert.equal((await api.listDictationBackups({ caseKey: 'case-other' })).length, 1)

  response = async () => ({ ok: false, error: 'direct API result' })
  const directCalls = calls.length
  assert.equal((await api.transcribeWithBackup(original.input)).error, 'direct API result')
  assert.equal(calls.length, directCalls + 1, 'Callers without backupId retain the original transcription path')
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false)
  console.log('dictation recovery: durable audio/result, reload, retry, concurrency, isolation, removal and corruption checks passed')
} finally {
  await fs.rm(userData, { recursive: true, force: true })
}
