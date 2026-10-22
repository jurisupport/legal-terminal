import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { shouldUseDictationCorrection } from '../src/main/dictationGuard.ts'

const source = readFileSync(new URL('../src/main/dictation.ts', import.meta.url), 'utf8')
const api = {}
let responses = []
let requests = []
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
  setTimeout: () => 1, clearTimeout: () => {},
  fetch: async (url, options) => {
    requests.push({ url, ...options })
    const next = responses.shift()
    assert.ok(next, 'Unexpected API request')
    if (typeof next === 'function') return next(options)
    return new Response(next.body, { status: next.status ?? 200 })
  }
})

const plain = (value) => JSON.parse(JSON.stringify(value))
const participants = [{ id: 'judge', label: '재판부' }, { id: 'plaintiff', label: '원고 소송대리인' }]
const segments = [
  { speaker: 'A', text: '재판장입니다. 원고 대리인 말씀하세요.', start: 0, end: 3 },
  { speaker: 'B', text: '원고 대리인입니다. 청구를 유지합니다.', start: 3, end: 6 },
  { speaker: 'C', text: '원고 대리인입니다. 증거를 추가하겠습니다.', start: 6, end: 9 },
  { speaker: 'A', text: '다음 기일은 9월 12일입니다.', start: 9, end: 12 }
]
const rawText = '원래 전사 전체 본문입니다.'
const input = { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', diarize: true,
  context: { participants, recentDialogue: [{ speakerId: 'plaintiff', text: '앞서 제출한 증거입니다.' }],
    court: '서울중앙지법', caseNumber: '2026가단123', speaker: '현재 선택된 화자는 근거가 아닙니다.' } }
const mapping = (speaker, participantId, confident = true) => ({ speaker, participantId, confident })
const mappings = [mapping('A', 'judge'), mapping('B', 'plaintiff'), mapping('C', 'plaintiff')]
const completed = (items) => ({ status: 'completed', output: [{ type: 'message', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify({ mappings: items }) }] }] })
async function transcribe(mappingReply = completed(mappings), patch = {}, transcript = segments) {
  requests = []
  responses = [{ body: JSON.stringify({ text: rawText, segments: transcript }) }]
  if (mappingReply !== null) responses.push(typeof mappingReply === 'function' ? mappingReply : { body: JSON.stringify(mappingReply) })
  return api.transcribe({ ...input, ...patch })
}
function assertOriginal(result, original = segments) {
  assert.equal(result.ok, true)
  assert.equal(result.text, rawText)
  assert.equal(result.corrected, false)
  assert.deepEqual(plain(result.segments).map(({ participantId, participantSource, ...segment }) => segment), original)
}
function assertUnassigned(result, original = segments) {
  assertOriginal(result, original)
  assert.deepEqual(plain(result.segments), original)
}

let result = await transcribe()
assertOriginal(result)
assert.deepEqual(result.segments.map(({ participantId }) => participantId).join(','), 'judge,plaintiff,plaintiff,judge')
assert.ok(result.segments.every(({ participantSource }) => participantSource === 'context'))
assert.equal(requests.length, 2)
assert.equal(requests[0].body.has('prompt'), false, 'Use participant text only in the mapping request')
assert.equal(requests[1].url, 'https://api.openai.com/v1/responses')
const body = JSON.parse(requests[1].body)
assert.equal(body.model, 'gpt-5.4-mini')
assert.equal(body.store, false)
assert.equal(body.text.format.type, 'json_schema')
assert.equal(body.text.format.strict, true)
assert.equal(body.text.format.schema.additionalProperties, false)
assert.deepEqual(body.text.format.schema.properties.mappings.items.properties.speaker.enum, ['A', 'B', 'C'])
assert.deepEqual(body.text.format.schema.properties.mappings.items.properties.participantId.enum, ['', 'judge', 'plaintiff'])
const prompt = JSON.parse(body.input[1].content[0].text)
assert.deepEqual(prompt.participants, participants)
assert.deepEqual(prompt.recentDialogue, input.context.recentDialogue)
assert.equal(prompt.caseContext.court, '서울중앙지법')
assert.equal(prompt.caseContext.caseNumber, '2026가단123')
assert.equal(prompt.caseContext.speaker, undefined)
assert.ok(!requests[1].body.includes(input.context.speaker))
assert.ok(!requests[1].body.includes('data:audio'))
assert.match(body.input[0].content[0].text, /신뢰할 수 없는 데이터/)
assert.match(body.input[0].content[0].text, /참여자 목록 순서.*현재 선택된 화자.*참여자 수/)

for (const invalid of [
  [mapping('A', 'invented'), ...mappings.slice(1)],
  [mapping('missing', 'judge'), ...mappings.slice(1)],
  [mapping('A', 'judge'), mapping('A', 'plaintiff'), mappings[2]],
  [mapping('A', 'judge', 'true'), ...mappings.slice(1)],
  [{ ...mappings[0], extra: 'rewrite' }, ...mappings.slice(1)],
  [mappings[0]], [], null
]) assertUnassigned(await transcribe(completed(invalid)))

result = await transcribe(completed([mapping('A', 'judge', false), mapping('B', ''), mapping('C', 'plaintiff', false)]))
assertUnassigned(result)
for (const response of [
  { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: JSON.stringify({ mappings }) },
  { status: 'completed', output_text: JSON.stringify({ mappings }), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Unavailable' }] }] },
  { status: 'completed', output_text: JSON.stringify({ mappings }), output: [{ type: 'message', status: 'incomplete' }] },
  { status: 'completed', error: { message: 'failure' }, output_text: JSON.stringify({ mappings }) },
  { status: 'completed', output_text: '{"mappings":[' },
  { status: 'completed', output_text: JSON.stringify({ mappings, extra: true }) },
  { output_text: JSON.stringify({ mappings }) },
  () => new Response('Rate limit', { status: 429 }),
  () => new Response('not JSON'),
  () => { throw new Error('Network failure') }
]) assertUnassigned(await transcribe(response))

for (const roster of [undefined, [], null, {}, [null], Array(1),
  [{ id: '', label: '이름' }], [{ id: ' id ', label: '이름' }], [{ id: 'id', label: ' ' }],
  [{ id: 'x'.repeat(129), label: '이름' }], [{ id: 'id', label: 'x'.repeat(121) }],
  [participants[0], participants[0]], Array(33).fill(participants[0])]) {
  assertUnassigned(await transcribe(null, { context: { participants: roster } }))
  assert.equal(requests.length, 1, 'No valid roster keeps the existing single-request behavior')
}
assertUnassigned(await transcribe(null, { context: undefined }))
assert.equal(requests.length, 1)
const ambiguous = [{ speaker: 'A', text: '네.', start: 0, end: 1 }]
assertUnassigned(await transcribe(completed([mapping('A', '', false)]),
  { context: { participants: [participants[0]] } }, ambiguous), ambiguous)
assert.equal(requests.length, 2, 'A single participant still needs evidence instead of automatic assignment')

const wav = Buffer.alloc(44 + 16_000 * 2 * 3)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
const knownSpeakers = [{ name: 'speaker_0', audio: wav, participantId: 'plaintiff' }]
const known = [{ ...segments[0], speaker: 'speaker_0' }]
result = await transcribe(null, { knownSpeakers }, known)
assertOriginal(result, known)
assert.equal(result.segments[0].participantId, 'plaintiff', 'Voice reference takes priority over transcript self-introduction')
assert.equal(result.segments[0].participantSource, 'voice')
assert.equal(requests.length, 1, 'Already matched voices skip the second request')

const mixed = [...known, segments[1]]
result = await transcribe(completed([mapping('B', 'judge')]), { knownSpeakers }, mixed)
assertOriginal(result, mixed)
assert.deepEqual(plain(result.segments).map(({ participantId, participantSource }) => [participantId, participantSource]),
  [['plaintiff', 'voice'], ['judge', 'context']])
let mixedBody = JSON.parse(requests[1].body)
assert.deepEqual(mixedBody.text.format.schema.properties.mappings.items.properties.speaker.enum, ['B'])
assert.deepEqual(JSON.parse(mixedBody.input[1].content[0].text).voiceMappings, [{ speaker: 'speaker_0', participantId: 'plaintiff' }])
for (const reply of [completed([mapping('speaker_0', 'judge')]), { status: 'incomplete' },
  () => { throw new Error('Unavailable') }]) {
  result = await transcribe(reply, { knownSpeakers }, mixed)
  assert.equal(result.segments[0].participantId, 'plaintiff')
  assert.equal(result.segments[0].participantSource, 'voice')
  assert.equal(result.segments[1].participantId, undefined)
  assertOriginal(result, mixed)
}
result = await transcribe(completed([mapping('speaker_0', '', false)]),
  { knownSpeakers: [{ ...knownSpeakers[0], participantId: 'not-on-roster' }] }, known)
assertUnassigned(result, known)

const longSegments = Array.from({ length: 64 }, (_, index) => ({ speaker: `label_${index}`,
  text: `${index}:` + '긴 발언 '.repeat(5000).trim(), start: index * 3, end: index * 3 + 3 }))
const unresolved = longSegments.map(({ speaker }) => mapping(speaker, '', false))
const recentDialogue = Array.from({ length: 30 }, (_, index) => ({ speakerId: index === 29 ? 'unknown' : 'judge',
  text: ` ${index}:` + '앞선 발언 '.repeat(200) }))
result = await transcribe(completed(unresolved), { context: { participants, recentDialogue, court: 'x'.repeat(3000) } }, longSegments)
assertUnassigned(result, longSegments)
mixedBody = JSON.parse(requests[1].body)
const bounded = JSON.parse(mixedBody.input[1].content[0].text)
assert.equal(bounded.unknownSpeakers.length, 64, 'Every requested label can remain unresolved')
assert.equal(bounded.transcript.length, 64)
assert.ok(bounded.transcript.flatMap(({ excerpts }) => excerpts).reduce((sum, { text }) => sum + text.length, 0) <= 18_000)
assert.ok(bounded.recentDialogue.length <= 20)
assert.ok(bounded.recentDialogue.every(({ speakerId, text }) => speakerId === 'judge' && text.length <= 500))
assert.equal(bounded.caseContext.court.length, 500)
const tooMany = [...longSegments, { ...longSegments[0], speaker: 'last' }]
assertUnassigned(await transcribe(null, {}, tooMany), tooMany)
assert.equal(requests.length, 1, 'An oversized label set safely stays unresolved')

console.log('hearing participants: roster and recent context, strict many-to-one mapping, voice priority, bounded inputs, failure fallback and original transcript preservation verified')
