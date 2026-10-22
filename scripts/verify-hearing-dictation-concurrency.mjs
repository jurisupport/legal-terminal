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
const names = ['touch', 'transcribeDictation', 'removeEntry', 'startNewRecord', 'loadFromPath']
const callbacks = component.body.statements.filter((node) =>
  node.declarationList?.declarations.some((declaration) => names.includes(declaration.name?.text))
).map((node) => node.getText(source)).join('\n')
assert.equal(callbacks.match(/const (touch|transcribeDictation|removeEntry|startNewRecord|loadFromPath) =/g)?.length, names.length)
const compiled = ts.transpileModule(callbacks, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function harness() {
  let record = { entries: [], speakers: [{ id: 'court', label: '재판부' }], activeSpeakerId: 'court', case: {} }
  let deferred = true
  let sequence = 0
  const updates = []
  const requests = []
  const ref = (current) => ({ current })
  const context = {
    useCallback: (callback) => callback,
    setRecord: (update) => {
      if (deferred) updates.push(update)
      else record = typeof update === 'function' ? update(record) : update
    },
    latestRecordRef: ref(record), latestDraftRef: ref(''),
    dictationChunksRef: ref([]), dictationSelectionRef: ref({}),
    recordingSessionRef: ref({}), recorderRef: ref(null), latestEntryRef: ref(null),
    pendingDictationsRef: ref(new Set()), retryDictationsRef: ref(new Map()),
    deletedEntryIdsRef: ref(new Set()), diarizationQueueRef: ref(Promise.resolve()),
    speakerReferencesRef: ref(new Map()),
    removedSpeakerIdsRef: ref(new Set()), renamedSpeakerLabelsRef: ref(new Map()),
    loadedPathRef: ref('/records/old.hearing.json'), lastSavedSourceStampRef: ref(''), onSavedPathRef: ref(null),
    draftsDir: undefined, initialCase: undefined, initialHearing: undefined,
    createInitialRecord: () => ({ ...record, entries: [], case: { caseNumber: 'new-case' } }),
    shouldKeepPendingRecord, selectSpeakerReferences: () => [],
    flushAutoSave: async () => true,
    setRecordPath() {}, updateLoadState() {}, setSaveStatus() {}, setSaveMessage() {},
    setLastSavedAt() {}, setJsStatus() {}, setJsMessage() {},
    newId: () => `entry-${++sequence}`, insertDictationText,
    setDraft() {}, releaseDictationMedia() {}, setDictationState() {},
    setDictationMessage() {}, focusInput() {},
    window: {
      requestAnimationFrame() {},
      lt: { fs: { stat: async () => ({ ok: false }) }, dictation: { transcribe: (payload) => new Promise((resolve, reject) => {
        requests.push({ payload, resolve, reject })
      }) } }
    }
  }
  const api = Function(...Object.keys(context), `${compiled}\nreturn { ${names.join(', ')} }`)(...Object.values(context))
  return {
    ...api, context, requests,
    get record() { return record },
    set deferred(value) { deferred = value },
    flush() {
      for (const update of updates.splice(0)) record = typeof update === 'function' ? update(record) : update
      context.latestRecordRef.current = record
    },
    start(draft = '', diarize = false) {
      context.dictationChunksRef.current = [new Blob(['synthetic audio'])]
      context.dictationSelectionRef.current = { value: draft, start: draft.length, end: draft.length, message: '전사 중...' }
      context.recordingSessionRef.current = { diarize, startedAt: Date.now() }
      return api.transcribeDictation('audio/webm')
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
