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
runInNewContext(ts.transpileModule(`${panelSource}\nexports.mergePendingRecord = mergePendingRecord`, {
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
