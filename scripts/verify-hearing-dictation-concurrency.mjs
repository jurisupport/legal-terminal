import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { insertDictationText } from '../src/renderer/src/hearing/dictationText.ts'
import { shouldKeepPendingRecord } from '../src/renderer/src/hearing/loadPolicy.ts'

// Run the actual callbacks with React state updates deliberately held until a render.
const source = ts.createSourceFile('HearingRecordPanel.tsx', readFileSync(
  new URL('../src/renderer/src/hearing/HearingRecordPanel.tsx', import.meta.url), 'utf8'
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = source.statements.find((node) => node.name?.text === 'HearingRecordPanel')
const names = ['touch', 'transcribeDictation', 'saveRecord', 'recoverDictation', 'removeEntry', 'startNewRecord', 'loadFromPath']
const callbacks = component.body.statements.filter((node) =>
  node.declarationList?.declarations.some((declaration) => names.includes(declaration.name?.text))
).map((node) => node.getText(source)).join('\n')
assert.equal(callbacks.match(/const (touch|transcribeDictation|saveRecord|recoverDictation|removeEntry|startNewRecord|loadFromPath) =/g)?.length, names.length)
const caseKeySource = source.statements.find((node) => node.name?.text === 'dictationBackupCaseKey').getText(source)
const compiled = ts.transpileModule(`${caseKeySource}\n${callbacks}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

const caseKey = Function(ts.transpileModule(caseKeySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText + '; return dictationBackupCaseKey')()
for (const folder of ['/cases/example', 'ssh://server/cases/example', 'C:\\cases\\example']) {
  const separator = folder.startsWith('C:') ? '\\' : '/'
  assert.equal(caseKey({ id: 'new', case: {} }, folder),
    caseKey({ id: 'restored', case: {} }, undefined, `${folder}${separator}.hearings${separator}record.hearing.json`),
    'opening the saved file without case metadata still finds the same local audio')
}

function harness() {
  let record = { id: 'record-1', entries: [], speakers: [{ id: 'court', label: '재판부' }], activeSpeakerId: 'court', case: {} }
  let deferred = true
  let sequence = 0
  const updates = []
  const requests = []
  const backups = new Map()
  const drafts = []
  const referenceSelections = []
  const ref = (current) => ({ current })
  const context = {
    useCallback: (callback) => callback,
    setRecord: (update) => {
      if (deferred) updates.push(update)
      else record = typeof update === 'function' ? update(record) : update
    },
    latestRecordRef: ref(record), latestDraftRef: ref(''),
    recorderRef: ref(null), latestEntryRef: ref(null),
    pendingDictationsRef: ref(new Set()), retryDictationsRef: ref(new Map()),
    deletedEntryIdsRef: ref(new Set()), diarizationQueueRef: ref(Promise.resolve()),
    speakerReferencesRef: ref(new Map()),
    removedSpeakerIdsRef: ref(new Set()), renamedSpeakerLabelsRef: ref(new Map()),
    loadedPathRef: ref('/records/old.hearing.json'), lastSavedSourceStampRef: ref(''), onSavedPathRef: ref(null),
    draftsDir: undefined, initialCase: undefined, initialHearing: undefined, initialPath: undefined,
    recordPath: '/records/old.hearing.json', pendingSaveRef: ref(Promise.resolve()), loadStateRef: ref('idle'),
    ensureRecordDir: async () => '/records', buildHearingRecordTitle: () => '기일기록',
    sanitizeRecord: (value) => value, setDictationBackups() {}, dictationBusy: false,
    recordHasContent: (value) => value.entries.length > 0,
    createInitialRecord: () => ({ ...record, entries: [], case: { caseNumber: 'new-case' } }),
    shouldKeepPendingRecord, selectSpeakerReferences: () => { referenceSelections.push(true); return [] },
    flushAutoSave: async () => true,
    setRecordPath() {}, updateLoadState() {}, setSaveStatus() {}, setSaveMessage() {},
    setLastSavedAt() {}, setJsStatus() {}, setJsMessage() {},
    newId: () => `entry-${++sequence}`, insertDictationText,
    setDraft(value) { drafts.push(value) }, releaseDictationMedia() {}, setDictationState() {},
    setDictationMessage() {}, focusInput() {},
    window: {
      requestAnimationFrame() {},
      lt: { fs: { stat: async () => ({ ok: false }), writeText: async () => ({ ok: true }) }, dictation: {
        backup: async (backup) => { if (!backups.has(backup.id)) backups.set(backup.id, structuredClone(backup)) },
        removeBackup: async (id) => { backups.delete(id) },
        transcribe: (payload) => new Promise((resolve, reject) => {
        requests.push({ payload, resolve, reject })
      }) } }
    }
  }
  const api = Function(...Object.keys(context), `${compiled}\nreturn { ${names.join(', ')} }`)(...Object.values(context))
  return {
    ...api, context, requests, backups, drafts, referenceSelections,
    get record() { return record },
    set deferred(value) { deferred = value },
    flush() {
      for (const update of updates.splice(0)) record = typeof update === 'function' ? update(record) : update
      context.latestRecordRef.current = record
    },
    start(draft = '', diarize = false) {
      return api.transcribeDictation({ audio: new TextEncoder().encode('synthetic audio'), mimeType: 'audio/webm',
        diarize, startedAt: Date.now(),
        selection: { value: draft, start: draft.length, end: draft.length, message: '전사 중...' } })
    }
  }
}

await test('Both recordings are submitted before React renders their pending rows', async () => {
  const h = harness()
  const first = h.start('앞 초안')
  await setImmediate()
  h.flush()
  h.deferred = false
  const second = h.start('뒤 초안')
  await setImmediate()
  assert.equal(h.requests.length, 2, 'A queued row is not a deleted recording; both requests must be sent')
  assert.equal(h.context.pendingDictationsRef.current.size, 2)

  h.deferred = true
  h.requests[1].resolve({ ok: true, text: '두 번째 발언' })
  await second
  h.flush()
  assert.equal(h.record.entries[0].dictation.status, 'transcribing')
  assert.equal(h.record.entries[1].text, '뒤 초안 두 번째 발언')
  assert.equal(h.context.pendingDictationsRef.current.size, 1)

  h.requests[0].resolve({ ok: true, text: '첫 번째 발언' })
  await first
  h.flush()
  assert.deepEqual(h.record.entries.map(({ text }) => text), ['앞 초안 첫 번째 발언', '뒤 초안 두 번째 발언'])
  assert.ok(h.record.entries.every((entry) => !entry.dictation))
  assert.equal(h.context.pendingDictationsRef.current.size, 0)
  assert.equal(h.context.retryDictationsRef.current.size, 0)
})

await test('Batched reverse completion preserves both results and an intervening typed note', async () => {
  const h = harness()
  const first = h.start()
  const second = h.start()
  await setImmediate()
  assert.equal(h.requests.length, 2)
  h.touch((current) => ({ ...current, entries: [...current.entries, { id: 'typed', text: '직접 입력' }] }))
  h.requests[1].resolve({ ok: true, text: '두 번째 발언' })
  h.requests[0].resolve({ ok: true, text: '첫 번째 발언' })
  await Promise.all([first, second])
  h.flush()
  assert.deepEqual(h.record.entries.map(({ text }) => text), ['첫 번째 발언', '두 번째 발언', '직접 입력'])
  assert.ok(h.record.entries.every((entry) => !entry.dictation))
})

await test('A late failure stays retryable after the next recording succeeds', async () => {
  const h = harness()
  const first = h.start('보존할 초안')
  const second = h.start()
  await setImmediate()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve({ ok: true, text: '두 번째 발언' })
  h.requests[0].reject(new Error('연결 실패'))
  await Promise.all([first, second])
  h.flush()
  assert.equal(h.record.entries[0].text, '보존할 초안')
  assert.equal(h.record.entries[0].dictation.status, 'error')
  assert.equal(h.record.entries[1].text, '두 번째 발언')
  const retry = h.context.retryDictationsRef.current.get(h.record.entries[0].id)()
  await setImmediate()
  assert.equal(h.requests.length, 3)
  h.requests[2].resolve({ ok: true, text: '첫 번째 발언' })
  await retry
  h.flush()
  assert.deepEqual(h.record.entries.map(({ text }) => text), ['보존할 초안 첫 번째 발언', '두 번째 발언'])
  assert.ok(h.record.entries.every((entry) => !entry.dictation))
})

await test('A deleted pending row is not restored when its transcription finishes', async () => {
  const h = harness()
  const first = h.start()
  await setImmediate()
  assert.equal(h.requests.length, 1)
  h.flush()
  h.removeEntry(h.record.entries[0].id)
  h.requests[0].resolve({ ok: true, text: '삭제한 발언' })
  await first
  h.flush()
  assert.deepEqual(h.record.entries, [])
  assert.equal(h.context.pendingDictationsRef.current.size, 0)
})

await test('Deleting queued diarization cancels the request before the deletion renders', async () => {
  const h = harness()
  let release
  h.context.diarizationQueueRef.current = new Promise((resolve) => { release = resolve })
  const pending = h.start('', true)
  h.flush()
  h.removeEntry(h.record.entries[0].id)
  release()
  await pending
  h.flush()
  assert.equal(h.requests.length, 0)
  assert.deepEqual(h.record.entries, [])
  assert.equal(h.context.pendingDictationsRef.current.size, 0)
  await h.context.diarizationQueueRef.current
})

for (const destination of ['new', 'saved']) {
  await test(`A cancelled queued recording stays cancelled after switching to a ${destination} record`, async () => {
    const h = harness()
    let release
    h.context.diarizationQueueRef.current = new Promise((resolve) => { release = resolve })
    const pending = h.start('', true)
    h.flush()
    h.removeEntry(h.record.entries[0].id)
    if (destination === 'new') await h.startNewRecord()
    else await h.loadFromPath('/records/other.hearing.json')
    h.flush()
    release()
    await setImmediate()
    assert.equal(h.requests.length, 0, 'Cancelled audio must not be sent with the next record\'s context')
    await pending
    h.flush()
    assert.deepEqual(h.record.entries, [])

    const next = h.start()
    await setImmediate()
    assert.equal(h.requests.length, 1, 'The new record can still transcribe')
    h.requests[0].resolve({ ok: true, text: '새 기록의 발언' })
    await next
    h.flush()
    assert.equal(h.record.entries[0].text, '새 기록의 발언')
    assert.equal(h.context.pendingDictationsRef.current.size, 0)
  })
}

await test('Audio is durable before waiting for another diarization request', async () => {
  const h = harness()
  let release
  h.context.diarizationQueueRef.current = new Promise((resolve) => { release = resolve })
  const pending = h.start('보존할 초안', true)
  await setImmediate()
  h.flush()
  assert.equal(h.requests.length, 0)
  const backup = [...h.backups.values()][0]
  assert.equal(new TextDecoder().decode(backup.input.audio), 'synthetic audio')
  assert.equal(JSON.parse(backup.recordJson).entries[0].recoveryId, backup.id)
  h.removeEntry(backup.id)
  release()
  await pending
  h.flush()
  assert.equal(h.backups.size, 0, 'deleting queued audio removes its durable recovery too')
  assert.equal(h.requests.length, 0)
})

await test('A failed backup prevents HTTP and leaves an in-memory retry', async () => {
  const h = harness()
  const save = h.context.window.lt.dictation.backup
  h.context.window.lt.dictation.backup = async () => { throw new Error('디스크 저장 실패') }
  await h.start('잃으면 안 되는 초안')
  h.flush()
  assert.equal(h.requests.length, 0)
  assert.match(h.record.entries[0].dictation.message, /디스크 저장 실패/)
  h.context.window.lt.dictation.backup = save
  const retry = h.context.retryDictationsRef.current.get(h.record.entries[0].id)()
  await setImmediate()
  assert.equal(h.backups.size, 1)
  h.requests[0].resolve({ ok: true, text: '보존된 음성' })
  await retry
  h.flush()
  assert.equal(h.record.entries[0].text, '잃으면 안 되는 초안 보존된 음성')
})

await test('Reopening uses saved audio, selection and speaker without clearing the new draft', async () => {
  const original = harness()
  const first = original.start('원래 초안')
  await setImmediate()
  original.requests[0].resolve({ ok: false, error: '시간 초과' })
  await first
  original.flush()
  const backup = structuredClone([...original.backups.values()][0])
  const reopened = harness()
  reopened.context.setRecord(JSON.parse(backup.recordJson))
  reopened.flush()
  reopened.context.latestDraftRef.current = '새로 입력한 메모'
  const retry = reopened.transcribeDictation({ ...backup.input, diarize: !!backup.input.diarize,
    startedAt: backup.startedAt, selection: backup.selection }, backup)
  await setImmediate()
  assert.equal(reopened.requests[0].payload.backupId, backup.id)
  assert.deepEqual(reopened.requests[0].payload.audio, backup.input.audio)
  assert.equal(reopened.requests[0].payload.context.speaker, '재판부')
  reopened.requests[0].resolve({ ok: true, text: '복구된 발언' })
  await retry
  reopened.flush()
  assert.equal(reopened.record.entries.length, 1)
  assert.equal(reopened.record.entries[0].text, '원래 초안 복구된 발언')
  assert.equal(reopened.context.latestDraftRef.current, '새로 입력한 메모')
  assert.deepEqual(reopened.drafts, [])
})

await test('Successful transcription retains recovery until the hearing file saves successfully', async () => {
  const h = harness()
  const pending = h.start()
  await setImmediate()
  h.requests[0].resolve({ ok: true, text: '저장할 결과' })
  await pending
  h.flush()
  assert.equal(h.backups.size, 1)
  h.context.window.lt.fs.writeText = async () => ({ ok: false, error: '서버 연결 실패' })
  await assert.rejects(h.saveRecord(), /서버 연결 실패/)
  assert.equal(h.backups.size, 1)
  h.context.window.lt.fs.writeText = async () => ({ ok: true })
  await h.saveRecord()
  assert.equal(h.backups.size, 0)
})

await test('Deleting one completed segment retains the remaining group recovery until saved', async () => {
  const h = harness()
  h.backups.set('entry-1', {})
  h.context.setRecord({ ...h.record, entries: [
    { id: 'entry-1', recoveryId: 'entry-1', recording: { id: 'entry-1' }, text: '첫 발언' },
    { id: 'entry-1-segment-1', recording: { id: 'entry-1' }, text: '남은 발언' }
  ] })
  h.flush()
  h.removeEntry('entry-1')
  h.flush()
  assert.equal(h.backups.size, 1)
  assert.equal(h.record.entries[0].recoveryId, 'entry-1')
  await h.saveRecord()
  assert.equal(h.backups.size, 0)
})

await test('Recovering an already completed recording loads it without another transcription', async () => {
  const h = harness()
  const completed = { ...h.record, entries: [{ id: 'entry-1', recoveryId: 'entry-1', text: '이미 저장된 결과' }] }
  const backup = { id: 'entry-1', recordId: completed.id, recordPath: '/records/finished.hearing.json',
    recordJson: JSON.stringify(completed), input: { mimeType: 'audio/webm' } }
  h.backups.set(backup.id, backup)
  h.context.window.lt.fs.stat = async () => ({ ok: true })
  h.context.window.lt.fs.readText = async () => ({ text: JSON.stringify(completed) })
  await h.recoverDictation(backup)
  h.flush()
  assert.equal(h.requests.length, 0)
  assert.equal(h.backups.size, 0)
  assert.equal(h.record.entries[0].text, '이미 저장된 결과')
})

await test('Recovered speaker labels never use samples from a later recording', async () => {
  const h = harness()
  const snapshot = { ...h.record, entries: [{ id: 'entry-1', recoveryId: 'entry-1', text: '', dictation: { status: 'error' } }] }
  h.context.setRecord(snapshot)
  h.flush()
  const backup = { id: 'entry-1', recordId: snapshot.id, recordJson: JSON.stringify(snapshot),
    selection: { value: '', start: 0, end: 0, message: '전사 중...' }, startedAt: 0,
    input: { audio: new Uint8Array([1]), mimeType: 'audio/webm', diarize: true } }
  const pending = h.transcribeDictation({ ...backup.input, diarize: true,
    startedAt: backup.startedAt, selection: backup.selection }, backup)
  await setImmediate()
  assert.deepEqual(h.referenceSelections, [])
  assert.equal(h.requests[0].payload.knownSpeakers, undefined, 'retain the original saved reference audio in the backend')
  h.requests[0].resolve({ ok: false, error: '연결 실패' })
  await pending
})

for (const diarize of [false, true]) {
  await test(`Plain fallback preserves text and draft ownership (diarize=${diarize})`, async () => {
    const h = harness()
    const pending = h.start('입력 중인 초안', diarize)
    await setImmediate()
    h.context.latestDraftRef.current = '새로 입력한 메모'
    h.requests[0].resolve({ ok: true, text: '복구된 발언', corrected: false, fallback: 'whisper-1' })
    await pending
    h.flush()
    const entry = h.record.entries[0]
    assert.equal(entry.text, diarize ? '복구된 발언' : '입력 중인 초안 복구된 발언')
    assert.equal(entry.speakerId, diarize ? '' : 'court')
    assert.equal(entry.transcriptionFallback, true)
    assert.equal(entry.recording, undefined, 'Plain fallback must not fabricate speaker timings')
    assert.equal(entry.dictation, undefined)
    assert.equal(h.context.latestDraftRef.current, '새로 입력한 메모')
    assert.equal(h.context.retryDictationsRef.current.size, 0)
    assert.equal(h.backups.size, 1, 'Keep audio until the fallback text has been saved')
  })
}
