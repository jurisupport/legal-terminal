import assert from 'node:assert/strict'
import { extractSpeakerReferences } from '../src/renderer/src/hearing/speakerReferenceAudio.ts'

const sampleRate = 16_000
let channels = []
let decodeCalls = 0
let rejectDecode = false
let copiedInput
globalThis.OfflineAudioContext = class {
  constructor(...args) { assert.deepEqual(args, [1, 1, sampleRate]) }
  async decodeAudioData(input) {
    decodeCalls++
    copiedInput = new Uint8Array(input).slice()
    new Uint8Array(input).fill(99)
    if (rejectDecode) throw new Error('Unsupported recording')
    return { sampleRate, length: channels[0].length, numberOfChannels: channels.length,
      getChannelData: (index) => channels[index] }
  }
}
const source = new Uint8Array([7, 1, 2, 3, 8]).subarray(1, 4)
const segment = (speaker, start, end, text = '발언 내용') => ({ speaker, start, end, text })
const setAudio = (seconds, values = [0.5]) => {
  channels = values.map((value) => new Float32Array(seconds * sampleRate).fill(value))
}
const extract = (segments) => extractSpeakerReferences(source, segments)
const wavView = (reference) => new DataView(reference.audio.buffer)

for (const segments of [[], null, [null], [segment('A', 0, 1.9)],
  [segment('A', 0, 3, '')], [segment(' ', 0, 3)],
  ...[-1, NaN, Infinity, '1'].map((start) => [segment('A', start, 3)]),
  ...[0, -1, NaN, Infinity, '3'].map((end) => [segment('A', 0, end)])]) {
  assert.deepEqual(await extract(segments), [])
}
assert.deepEqual(await extractSpeakerReferences(new Uint8Array(), [segment('A', 0, 3)]), [])
assert.equal(decodeCalls, 0, 'Unusable timestamps/text must not decode the recording')

setAudio(14, [0.25, 0.75])
let result = await extract([segment('A', 0, 2), segment('A', 2, 14)])
assert.equal(result.length, 1)
assert.equal(result[0].segmentIndex, 1, 'Keep original segment provenance after sorting')
assert.equal(result[0].start, 2.05)
assert.equal(result[0].end, 10.05)
assert.equal(result[0].audio.length, 256044)
const view = wavView(result[0])
assert.equal(Buffer.from(result[0].audio.subarray(0, 4)).toString(), 'RIFF')
assert.equal(Buffer.from(result[0].audio.subarray(8, 16)).toString(), 'WAVEfmt ')
assert.equal(Buffer.from(result[0].audio.subarray(36, 40)).toString(), 'data')
for (const [offset, expected] of [[4, 256036], [16, 16], [24, sampleRate], [28, 32000], [40, 256000]]) {
  assert.equal(view.getUint32(offset, true), expected)
}
for (const [offset, expected] of [[20, 1], [22, 1], [32, 2], [34, 16]]) {
  assert.equal(view.getUint16(offset, true), expected)
}
assert.equal(view.getInt16(44, true), 16384, 'Average input channels to mono')
assert.equal(view.getInt16(result[0].audio.length - 2, true), 16384)
assert.deepEqual(source, new Uint8Array([1, 2, 3]), 'Decoder must not mutate source bytes')
assert.deepEqual(copiedInput, source, 'Copy only the provided input view')
const sourceBuffer = Buffer.from([1, 2, 3])
await extractSpeakerReferences(sourceBuffer, [segment('A', 0, 3)])
assert.deepEqual(sourceBuffer, Buffer.from([1, 2, 3]), 'Also copy Uint8Array subclasses before decode')

setAudio(40)
result = await extract([
  segment('A', 0, 2), segment('B', 2, 5), segment('C', 5, 9),
  segment('D', 9, 14), segment('E', 14, 20), segment('E', 20, 27)
])
assert.deepEqual(result.map((reference) => reference.speaker), ['E', 'D', 'C', 'B'])
assert.deepEqual(result.map((reference) => reference.segmentIndex), [5, 3, 2, 1])

result = await extract([segment('A', 0, 2), segment('B', 2, 4)])
assert.deepEqual(result.map(({ start, end }) => [start, end]), [[0, 2], [2, 4]],
  'Two seconds remains usable without edge trimming or added padding')
assert.equal(result[0].audio.length, 64044)
result = await extract([segment('A', 0.1, 2.2)])
assert.equal(result.length, 1, 'Edge margins must leave at least two seconds after sample rounding')
assert.equal(result[0].audio.length, 64044)
result = await extract([segment('A', 0.00001, 2.00001)])
assert.deepEqual(result, [], 'Rounding must never pad outside the utterance to reach two seconds')
result = await extract([segment('A', 39, 42), segment('B', 0, 3)])
assert.deepEqual(result.map((reference) => reference.speaker), ['B'], 'Reject out-of-recording timestamps')

const overlapping = [
  segment('A', 0, 12), segment('A', 0.5, 5), segment('B', 2, 6),
  segment('A', 7, 10), segment('C', 12, 15), segment('D', 14, 16), segment('C', 16, 19)
]
result = await extract(overlapping)
assert.deepEqual(result.map((reference) => reference.segmentIndex), [3, 6],
  'Reject earlier/later/nested cross-speaker overlap while allowing same-speaker overlap')
for (const reference of result) {
  for (const other of overlapping) {
    assert.ok(other.speaker === reference.speaker || other.end <= reference.start || other.start >= reference.end)
  }
}
const callsBeforeOverlap = decodeCalls
assert.deepEqual(await extract([segment('A', 0, 4), segment('B', 3, 6)]), [])
assert.equal(decodeCalls, callsBeforeOverlap)
assert.deepEqual(await extract([segment('A', 0, 4), segment('B', 3, 4, '')]), [],
  'An empty transcript segment still blocks overlapping voice samples')

setAudio(8, [0])
channels[0].fill(0.25, 4 * sampleRate, 7 * sampleRate)
result = await extract([segment('A', 4, 7)])
assert.equal(wavView(result[0]).getInt16(44, true), 8192)
assert.equal(wavView(result[0]).getInt16(result[0].audio.length - 2, true), 8192,
  'Copy samples at their recording offsets without padding from outside the segment')

// A sparse synthetic channel verifies long recordings without a large test allocation.
channels = [new Proxy({ length: 6000 * sampleRate }, {
  get: (target, key) => key === 'length' ? target.length : 0.25
})]
result = await extract([segment('A', 5900, 5908)])
assert.equal(result.length, 1, 'Long recordings must not be discarded by a duration cap')
assert.ok(result[0].start >= 5900 && result[0].end <= 5908)

setAudio(12, [0])
assert.deepEqual(await extract([segment('A', 0, 4)]), [])
setAudio(12, [0.5, -0.5])
assert.deepEqual(await extract([segment('A', 0, 4)]), [], 'Mono cancellation is silence')
for (const invalid of [NaN, Infinity, -Infinity]) {
  setAudio(12)
  channels[0][sampleRate] = invalid
  result = await extract([segment('A', 0, 5), segment('A', 6, 9)])
  assert.equal(result.length, 1)
  assert.equal(result[0].segmentIndex, 1, 'Fall back to another sample if the longest is invalid')
}
setAudio(12, [0])
channels[0].fill(0.5, 6 * sampleRate)
result = await extract([segment('A', 0, 5), segment('A', 6, 9)])
assert.equal(result[0].segmentIndex, 1, 'Fall back from a silent sample')
setAudio(3, [-2])
result = await extract([segment('A', 0, 3)])
assert.equal(wavView(result[0]).getInt16(44, true), -32768, 'Clamp PCM to its signed 16-bit range')
rejectDecode = true
assert.deepEqual(await extract([segment('A', 0, 3)]), [], 'Decode failure is nonfatal')
rejectDecode = false

// Thousands of short turns can be rejected without allocating a decoded recording.
const many = Array.from({ length: 20_000 }, (_, index) => segment(String(index % 2), index / 10, index / 10 + 3))
const callsBeforeMany = decodeCalls
assert.deepEqual(await extract(many), [])
assert.equal(decodeCalls, callsBeforeMany)
delete globalThis.OfflineAudioContext
assert.deepEqual(await extract([segment('A', 0, 3)]), [], 'Unsupported browser is nonfatal')
console.log('speaker references: clean interval selection, WAV encoding, provenance, bounds, silence and decode fallback verified')
