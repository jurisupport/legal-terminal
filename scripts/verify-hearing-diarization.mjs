import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { shouldUseDictationCorrection } from '../src/main/dictationGuard.ts'

// Exercise the real transcription path without Electron, stored secrets, or network access.
const source = readFileSync(new URL('../src/main/dictation.ts', import.meta.url), 'utf8')
const api = {}
let responses = []
let requests = []
let timer
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports: api,
  require: (name) => {
    if (name === 'electron') return { safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'test-key' } }
    if (name === './settings') return { getSettings: async () => ({ openaiApiKeyEnc: 'v1:dGVzdA==' }) }
    if (name === './dictationGuard') return { shouldUseDictationCorrection }
    throw new Error(`Unexpected import: ${name}`)
  },
  Buffer, Uint8Array, Blob, FormData, AbortController, Error,
  setTimeout: (callback, delay) => { timer = { callback, delay }; return timer },
  clearTimeout: () => {},
  fetch: async (url, options) => {
    requests.push({ url, ...options, timeout: timer.delay })
    const next = responses.shift()
    assert.ok(next, 'Unexpected API request')
    if (typeof next === 'function') return next(options)
    return new Response(next.body, { status: next.status ?? 200 })
  }
})

const input = { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', diarize: true }
const segments = [
  { speaker: 'A', text: '다음 기일은 9월 12일입니다.', start: 0, end: 2.5 },
  { speaker: 'B', text: '출석하겠습니다.', start: 2, end: 4 },
  { speaker: 'A', text: '네.', start: 5, end: 5.5 }
]
async function transcribe(reply, patch = {}) {
  requests = []
  responses = [{ body: JSON.stringify(reply) }]
  return api.transcribe({ ...input, ...patch })
}

let result = await transcribe({ segments })
assert.equal(result.ok, true)
assert.deepEqual(JSON.parse(JSON.stringify(result.segments)), segments)
assert.equal(result.text, segments.map((segment) => segment.text).join('\n'))
assert.equal(result.corrected, false)
assert.equal(requests.length, 1, 'Diarization must not apply text-only correction')
const request = requests[0]
assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions')
assert.equal(request.headers.Authorization, 'Bearer test-key')
assert.equal(request.timeout, 600_000)
assert.equal(request.body.get('model'), 'gpt-4o-transcribe-diarize')
assert.equal(request.body.get('response_format'), 'diarized_json')
assert.equal(request.body.get('chunking_strategy'), 'auto')
assert.equal(request.body.get('language'), 'ko')
assert.equal(request.body.get('file').size, 3)
for (const forbidden of ['prompt', 'keywords[]', 'languages[]']) {
  assert.equal(request.body.has(forbidden), false)
}
assert.equal((await transcribe({ text: '전체 전사문', segments })).text, '전체 전사문')

const referenceAudio = Buffer.alloc(44 + 16_000 * 2 * 3)
referenceAudio.write('RIFF')
referenceAudio.writeUInt32LE(referenceAudio.length - 8, 4)
referenceAudio.write('WAVEfmt ', 8)
referenceAudio.writeUInt32LE(16, 16)
referenceAudio.writeUInt16LE(1, 20)
referenceAudio.writeUInt16LE(1, 22)
referenceAudio.writeUInt32LE(16_000, 24)
referenceAudio.writeUInt32LE(32_000, 28)
referenceAudio.writeUInt16LE(2, 32)
referenceAudio.writeUInt16LE(16, 34)
referenceAudio.write('data', 36)
referenceAudio.writeUInt32LE(referenceAudio.length - 44, 40)
const knownSpeakers = [{ name: 'speaker_0', audio: referenceAudio }, { name: 'speaker_1', audio: referenceAudio }]
result = await transcribe({ segments: [{ ...segments[0], speaker: 'speaker_1' }] }, { knownSpeakers })
assert.equal(result.ok, true)
assert.equal(result.segments[0].speaker, 'speaker_1')
assert.deepEqual(requests[0].body.getAll('known_speaker_names[]'), ['speaker_0', 'speaker_1'])
assert.deepEqual(requests[0].body.getAll('known_speaker_references[]'),
  knownSpeakers.map(() => `data:audio/wav;base64,${referenceAudio.toString('base64')}`))
for (const invalid of [null, {}, [null], Array(1), Array(5).fill(knownSpeakers[0]), [knownSpeakers[0], knownSpeakers[0]],
  [{ name: 'A', audio: referenceAudio }], [{ name: 'speaker_0', audio: new Uint8Array(64_044) }],
  [{ name: 'speaker_0', audio: referenceAudio.subarray(0, 100) }],
  [{ name: 'speaker_0', audio: new Uint8Array(320_046) }]]) {
  assert.equal((await transcribe({ segments }, { knownSpeakers: invalid })).ok, false)
  assert.equal(requests.length, 0, 'Malformed voice references must not be sent to the API')
}

for (const invalid of [
  {}, { text: '화자 정보 없음' }, { segments: [] }, { segments: [null] },
  ...[
    { speaker: '' }, { text: ' ' }, { speaker: 1 }, { text: null },
    { start: -1 }, { start: '0' }, { start: null }, { end: -1 }, { end: null }
  ].map((patch) => ({ segments: [segments[0], { ...segments[1], ...patch }] }))
]) {
  result = await transcribe(invalid)
  assert.equal(result.ok, false, JSON.stringify(invalid))
  assert.equal(result.segments, undefined, 'Never keep only part of a malformed transcript')
  assert.equal(requests.length, 1)
}
for (const audio of [new Uint8Array(), new Uint8Array(25 * 1024 * 1024 + 1)]) {
  assert.equal((await transcribe({}, { audio })).ok, false)
  assert.equal(requests.length, 0, 'Invalid audio must not reach the API')
}
for (const response of [
  { body: 'Rate limit', status: 429 },
  { body: 'not JSON' },
  () => { throw new Error('Network error') },
  () => { timer.callback(); throw new Error('Aborted') }
]) {
  requests = []
  responses = [response]
  result = await api.transcribe(input)
  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.equal(requests.length, 1)
}
assert.match(result.error, /시간 초과/)

for (const diarize of [false, true]) {
  requests = []
  responses = [{ status: 429, body: JSON.stringify({ error: {
    message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted'
  } }) }]
  result = await api.transcribe({ ...input, diarize })
  assert.equal(result.ok, false)
  assert.match(result.error, /크레딧.*소진/)
  assert.match(result.error, /충전.*다시 시도/)
  assert.equal(requests.length, 1, '잔액 부족은 자동 재시도하지 않아야 한다')
}

// The existing short dictation request and guarded correction remain unchanged.
requests = []
responses = [{ body: JSON.stringify({ text: '기일은 9월 12일입니다.' }) },
  { body: JSON.stringify({ output_text: '기일은 9월 12일입니다.' }) }]
result = await api.transcribe({ ...input, diarize: undefined, context: { court: '서울중앙지법' } })
assert.equal(result.ok, true)
assert.equal(result.corrected, true)
assert.equal(result.segments, undefined)
assert.equal(requests.length, 2)
assert.equal(requests[0].timeout, 120_000)
assert.equal(requests[0].body.get('model'), 'gpt-transcribe')
assert.equal(requests[0].body.get('languages[]'), 'ko')
assert.match(requests[0].body.get('prompt'), /서울중앙지법/)
assert.deepEqual(requests[0].body.getAll('keywords[]'), ['서울중앙지법'])
assert.equal(requests[0].body.has('response_format'), false)
assert.equal(requests[1].url, 'https://api.openai.com/v1/responses')
assert.equal(JSON.parse(requests[1].body).model, 'gpt-5.4-mini')

requests = []
responses = [{ body: JSON.stringify({ text: '기일은 9월 12일입니다.' }) },
  { body: JSON.stringify({ output_text: '기일은 9월 13일입니다.' }) }]
result = await api.transcribe({ ...input, diarize: false })
assert.equal(result.corrected, false)
assert.equal(result.text, '기일은 9월 12일입니다.')
for (const [raw, corrected] of [
  ['인정합니다.', '부인합니다.'],
  ['합의 조건을 모두 확인한 뒤 서명하겠다는 것입니다.', '합의 조건을 확인한 뒤 서명하겠다는 것입니다.']
]) {
  responses = [{ body: JSON.stringify({ text: raw }) },
    { body: JSON.stringify({ output_text: corrected }) }]
  result = await api.transcribe({ ...input, diarize: false })
  assert.equal(result.text, raw, '교정이 내용을 바꾸거나 누락하면 원래 전사문을 돌려줘야 한다')
  assert.equal(result.corrected, false)
}
console.log('hearing diarization request, segments, validation, and ordinary dictation verified')

// A disk read may finish after one pending row has expanded into several speakers.
const panel = {}
const panelSource = readFileSync(new URL('../src/renderer/src/hearing/HearingRecordPanel.tsx', import.meta.url), 'utf8')
runInNewContext(ts.transpileModule(`${panelSource}\nObject.assign(exports, { mergePendingRecord, selectSpeakerReferences, applyDiarizedTranscript, assignRecordSpeaker, speakerAssignmentGroups, sanitizeRecord, buildReport, renameRecordSpeaker, alphabeticSpeakerLabel })`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText, { exports: panel, require: () => ({}) })
const base = { speakers: [], case: {}, requests: [], activeSpeakerId: '', result: {} }
const placeholder = { id: 'recording', dictation: { status: 'transcribing' } }
const manual = { id: 'manual', text: '수동 메모' }
const split = [
  { id: 'recording', text: '첫 질문', recording: { id: 'recording', start: 0, end: 1 } },
  { id: 'recording-segment-1', text: '답변', recording: { id: 'recording', start: 2, end: 3 } }
]
const merged = panel.mergePendingRecord(
  { ...base, entries: [placeholder, manual] },
  { ...base, entries: [...split, manual] }
)
assert.deepEqual(JSON.parse(JSON.stringify(merged.entries)), [...split, manual],
  'All speaker segments must replace the pending row together without moving past subsequent notes')
console.log('hearing diarization preserves segment order when a delayed disk read completes')

const plain = (value) => JSON.parse(JSON.stringify(value))
const overSplit = [...segments, { speaker: 'C', text: '같은 사람의 다른 발언', start: 6, end: 9 }]
const original = panel.applyDiarizedTranscript({ ...base, entries: [placeholder, manual] }, 'recording', 0, overSplit, [])
const [speakerA, speakerB, speakerC] = original.speakers.map(({ id }) => id)
assert.deepEqual(plain(original.speakers.map(({ label }) => label)), ['A', 'B', 'C'])
assert.equal(panel.alphabeticSpeakerLabel(25), 'Z')
assert.equal(panel.alphabeticSpeakerLabel(26), 'AA')
assert.equal(panel.alphabeticSpeakerLabel(701), 'ZZ')
const combined = panel.assignRecordSpeaker(original, speakerC, speakerA)
assert.equal(combined.speakers.length, 2, 'Detected speakers can merge with one another')
assert.equal(combined.entries[3].speakerId, speakerA)
assert.deepEqual(plain(combined.entries.map(({ text, recording }) => ({ text, recording }))),
  plain(original.entries.map(({ text, recording }) => ({ text, recording }))), 'Merging must preserve every word, time, and entry')
assert.equal(panel.assignRecordSpeaker(combined, speakerA, 'missing'), combined)
assert.equal(panel.assignRecordSpeaker(combined, speakerA, speakerA), combined)

const cache = new Map([['recording-segment-3', referenceAudio], ['recording-segment-1', referenceAudio]])
const references = panel.selectSpeakerReferences(original, cache)
const next = { ...combined, entries: [...combined.entries, { id: 'next', dictation: { status: 'transcribing' } }] }
const reused = panel.applyDiarizedTranscript(next, 'next', 1000, [
  { ...segments[0], speaker: references[1].name },
  { ...segments[1], speaker: references[0].name }
], references)
assert.equal(reused.speakers.length, 2, 'Known voices must not create new speakers')
assert.equal(reused.entries.at(-2).speakerId, speakerB)
assert.equal(reused.entries.at(-1).speakerId, speakerA, 'A merge during the API request must follow the sample entry')
assert.deepEqual(plain(reused.entries.slice(-2).map(({ text }) => text)), segments.slice(0, 2).map(({ text }) => text))
const unknown = panel.applyDiarizedTranscript(next, 'next', 1000, [segments[0]], references)
assert.equal(unknown.speakers.length, 3, 'Unknown A/B labels cannot be matched to previous labels by order')
const deletedSample = { ...next, entries: next.entries.filter(({ id }) => id !== references[0].entryId) }
assert.equal(panel.selectSpeakerReferences(deletedSample, cache).length, 1)
assert.equal(panel.applyDiarizedTranscript(deletedSample, 'next', 0,
  [{ ...segments[0], speaker: references[0].name }], references).speakers.length, 3,
  'Deleting the sample entry removes its identity evidence')
assert.equal(panel.selectSpeakerReferences({ ...base, entries: [] }, cache).length, 0, 'References must not leak to another record')
assert.equal(panel.applyDiarizedTranscript(combined, 'deleted-placeholder', 0, segments, references), combined)
const reassigned = { ...next, entries: next.entries.map((entry) => entry.id === references[0].entryId
  ? { ...entry, speakerId: speakerB } : entry) }
assert.equal(panel.selectSpeakerReferences(reassigned, cache).length, 1, 'Corrected sample entries group under the corrected speaker')
assert.equal(panel.applyDiarizedTranscript(reassigned, 'next', 0,
  [{ ...segments[0], speaker: references[0].name }], references).entries.at(-1).speakerId, speakerB)

const restored = panel.mergePendingRecord(original, combined, new Set([speakerC]))
assert.equal(restored.speakers.length, 2, 'A delayed disk read must not resurrect a merged speaker')
assert.equal(restored.entries[3].speakerId, speakerA, 'A delayed disk read must preserve reassigned speech')
assert.equal(panel.mergePendingRecord(original, original, new Set([speakerA])).speakers.length, 3,
  'Removing and then restoring a preset speaker must survive a delayed disk read')
const many = {
  ...base,
  speakers: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, label: `s${i}`, detected: i !== 5 })),
  entries: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, speakerId: `s${i}` }))
}
const selected = panel.selectSpeakerReferences(many, new Map(many.entries.map(({ id }) => [id, referenceAudio])))
assert.equal(selected.length, 4)
assert.equal(selected[0].entryId, 'e5', 'User-named speakers should be prioritized within the API limit')
console.log('voice references, speaker reuse, manual merges, deletion, record scope, and pending corrections verified')

const roster = [{ id: 'mediator', label: '조정위원', role: 'court' }, { id: 'client', label: '홍길동', role: 'plaintiff' }]
const declared = { ...base, speakers: roster, activeSpeakerId: 'client', entries: [placeholder],
  hearing: { type: 'hearing', dateTime: '2026-10-12T10:00:00+09:00' } }
const matchedSegments = [
  { ...segments[0], participantId: 'mediator', participantSource: 'context' },
  segments[1],
  { ...segments[2], speaker: 'C', participantId: 'mediator', participantSource: 'context' }
]
const matched = panel.applyDiarizedTranscript(declared, 'recording', 0, matchedSegments, [])
assert.deepEqual(plain(matched.speakers.map(({ label }) => label)), ['조정위원', '홍길동', 'A', 'B', 'C'],
  'A declared roster must not prevent anonymous voice groups')
const groups = panel.speakerAssignmentGroups(matched)
assert.deepEqual(plain(groups.map(({ label }) => label)), ['A', 'B', 'C'])
assert.deepEqual(plain(matched.entries.map(({ speakerId }) => speakerId)), plain(groups.map(({ id }) => id)),
  'Two voices suggested as the same participant must remain distinct')
assert.ok(matched.entries.every(({ participantSource }) => participantSource === undefined))
assert.deepEqual(plain(matched.entries.map(({ text, recording }) => [text, recording.start, recording.end])),
  matchedSegments.map(({ text, start, end }) => [text, start, end]), 'Grouping must not rewrite speech')

const repeated = panel.applyDiarizedTranscript(declared, 'recording', 0, segments, [])
const [a, b] = panel.speakerAssignmentGroups(repeated)
const renamed = panel.renameRecordSpeaker(repeated, a.id, '  김 변호사  ')
assert.equal(renamed.speakers.find(({ id }) => id === a.id).label, '김 변호사')
assert.deepEqual(plain(renamed.entries), plain(repeated.entries), 'Rename preserves IDs, content, order and timestamps')
assert.equal(panel.renameRecordSpeaker(renamed, a.id, '   '), renamed, 'Empty names are ignored')
assert.equal(panel.renameRecordSpeaker(renamed, 'missing', '이름'), renamed)
const delayedRename = panel.mergePendingRecord(repeated, renamed, new Set(), new Map([[a.id, '김 변호사']]))
assert.equal(delayedRename.speakers.find(({ id }) => id === a.id).label, '김 변호사',
  'A late disk read must not undo a rename')
assert.equal(panel.mergePendingRecord(renamed, repeated).speakers.find(({ id }) => id === a.id).label, '김 변호사',
  'Unedited defaults must not overwrite a saved speaker name')
const report = panel.buildReport(panel.sanitizeRecord(plain(renamed)))
assert.equal(report.match(/김 변호사:/g)?.length, 2, 'All A entries use the renamed label after reload and export')
assert.equal(report.match(/ B:/g)?.length, 1, 'Renaming A leaves B untouched')
assert.doesNotMatch(report, /맥락 추정|참여자 확인 필요/)
const duplicateNames = panel.renameRecordSpeaker(renamed, b.id, '김 변호사')
assert.equal(new Set(duplicateNames.entries.map(({ speakerId }) => speakerId)).size, 2,
  'Display names never silently merge distinct voice identities')
const renamedCache = new Map([['recording', referenceAudio], ['recording-segment-1', referenceAudio]])
const renamedReferences = panel.selectSpeakerReferences(renamed, renamedCache)
assert.equal(renamedReferences.length, 2, 'Anonymous voices can be reused without a participant guess')
assert.ok(renamedReferences.every(({ participantId }) => participantId === undefined))
const reusedNamed = panel.applyDiarizedTranscript({ ...renamed, entries: [...renamed.entries, { id: 'next' }] },
  'next', 10_000, [{ ...segments[0], speaker: renamedReferences[0].name }], renamedReferences)
assert.equal(reusedNamed.entries.at(-1).speakerId, a.id, 'Renaming preserves identity across recordings')
assert.equal(reusedNamed.speakers.length, renamed.speakers.length)
const assigned = panel.assignRecordSpeaker(reusedNamed, a.id, 'mediator')
assert.deepEqual(plain(assigned.entries.map(({ speakerId }) => speakerId)), ['mediator', b.id, 'mediator', 'mediator'],
  'Reassignment changes all entries of the source voice, across recordings')
assert.deepEqual(plain(assigned.entries.map(({ text, recording }) => ({ text, recording }))),
  plain(reusedNamed.entries.map(({ text, recording }) => ({ text, recording }))))
const reassignedParticipant = panel.assignRecordSpeaker(assigned, 'mediator', 'client')
assert.ok(reassignedParticipant.speakers.some(({ id }) => id === 'mediator'), 'Keep declared participants when moving their speech')
assert.deepEqual(plain(reassignedParticipant.entries.map(({ speakerId }) => speakerId)), ['client', b.id, 'client', 'client'])
assert.equal(panel.selectSpeakerReferences(reassignedParticipant, renamedCache)[0].participantId, 'client')
assert.equal(panel.assignRecordSpeaker(matched, groups[1].id, 'invented'), matched)

const old = { ...declared, entries: [
  { ...repeated.entries[0], speakerId: 'mediator', participantSource: 'context' },
  { ...repeated.entries[1], speakerId: '' },
  { ...repeated.entries[2], speakerId: 'mediator', participantSource: 'context' }
] }
const migrated = panel.sanitizeRecord(plain(old))
assert.deepEqual(plain(panel.speakerAssignmentGroups(migrated).map(({ label }) => label)), ['A', 'B'])
assert.equal(migrated.entries[0].speakerId, migrated.entries[2].speakerId)
assert.notEqual(migrated.entries[0].speakerId, migrated.entries[1].speakerId)
assert.ok(migrated.entries.every(({ participantSource }) => participantSource === undefined))
assert.deepEqual(plain(panel.sanitizeRecord(plain(migrated))), plain(migrated), 'Migration is stable after saving and reopening')
console.log('anonymous A/B/C groups, global rename and assignment, voice reuse, roster preservation, reload and report labels verified')
