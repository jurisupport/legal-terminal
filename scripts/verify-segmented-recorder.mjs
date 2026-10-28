import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workletSource = await fs.readFile(path.join(root, 'src/renderer/src/hearing/dictationRecorder.worklet.js'), 'utf8')
const helperSource = await fs.readFile(path.join(root, 'src/renderer/src/hearing/segmentedRecorder.ts'), 'utf8')
const ts = require('typescript')
const helperCode = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

function processor(segmentFrames, sampleRate = 16_000) {
  let Processor
  const messages = []
  vm.runInNewContext(workletSource, {
    sampleRate,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (data, transfer) => messages.push(structuredClone(data, { transfer })) }
    },
    registerProcessor(name, value) { assert.equal(name, 'dictation-recorder'); Processor = value }
  })
  const node = new Processor({ processorOptions: { segmentFrames } })
  return { node, messages, stop: () => node.port.onmessage({ data: 'stop' }) }
}

function readPcm(segment, sampleRate) {
  const { audio } = segment
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  assert.equal(Buffer.from(audio.subarray(0, 4)).toString(), 'RIFF')
  assert.equal(Buffer.from(audio.subarray(8, 16)).toString(), 'WAVEfmt ')
  assert.equal(Buffer.from(audio.subarray(36, 40)).toString(), 'data')
  for (const [offset, value] of [[4, audio.length - 8], [16, 16], [24, sampleRate], [28, sampleRate * 2], [40, audio.length - 44]]) {
    assert.equal(view.getUint32(offset, true), value)
  }
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) assert.equal(view.getUint16(offset, true), value)
  return Array.from({ length: (audio.length - 44) / 2 }, (_, index) => view.getInt16(44 + index * 2, true))
}

const pcm = (value) => Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 0x8000 : 0x7fff))
for (const length of [0, 999, 1000, 1001, 3507]) {
  const recording = processor(1000)
  const samples = Float32Array.from({ length }, (_, index) => Math.sin(index / 17) * 0.8)
  let offset = 0
  for (const count of [127, 1, 1500, 17, 31, 3000]) {
    const block = samples.subarray(offset, offset + count)
    recording.node.process([[block]])
    offset += block.length
  }
  assert.equal(offset, length)
  recording.stop()
  recording.stop()
  assert.equal(recording.node.process([[new Float32Array(128).fill(1)]]), false)
  const segments = recording.messages.filter((message) => message.audio)
  assert.equal(segments.length, Math.ceil(length / 1000), `Segment count for ${length} frames`)
  assert.equal(recording.messages.filter((message) => message.stopped).length, 1, 'Stop is acknowledged once')
  assert.deepEqual(segments.flatMap((segment) => readPcm(segment, 16_000)), Array.from(samples, pcm), 'Every input frame occurs once, in order')
  segments.forEach((segment, index) => {
    assert.equal(segment.startSeconds, index * 1000 / 16_000)
    assert.equal(segment.final, index === segments.length - 1 && length % 1000 !== 0)
  })
}
const stereo = processor(4, 48_000)
stereo.node.process([[new Float32Array([1, -1, 2, -2]), new Float32Array([0, 0, 2, -2])]])
stereo.node.process([[new Float32Array([NaN, Infinity, -Infinity])]])
stereo.stop()
assert.deepEqual(readPcm(stereo.messages[0], 48_000), [16384, -16384, 32767, -32768])
assert.deepEqual(readPcm(stereo.messages[1], 48_000), [0, 0, 0])
assert.equal(stereo.messages[1].startSeconds, 4 / 48_000)
const empty = processor(10)
empty.node.process([[]])
empty.stop()
assert.deepEqual(empty.messages, [{ stopped: true }], 'No audio produces no phantom WAV')
for (const size of [0, -1, NaN, Infinity, 0.5, 12_500_000]) assert.throws(() => processor(size))

const nodes = []
const urls = []
const revoked = []
const exported = {}
vm.runInNewContext(helperCode, {
  exports: exported,
  require: () => workletSource,
  Blob,
  URL: { createObjectURL: () => { const url = `blob:${urls.length}`; urls.push(url); return url }, revokeObjectURL: (url) => revoked.push(url) },
  AudioWorkletNode: class {
    constructor(context, name, options) {
      assert.equal(name, 'dictation-recorder')
      assert.equal(options.processorOptions.segmentFrames, 1600)
      this.context = context
      this.messages = []
      this.port = { onmessage: null, postMessage: (data) => this.messages.push(data), close: () => { this.closed = true } }
      nodes.push(this)
    }
    connect(target) { assert.equal(target, this.context.destination) }
    disconnect() { this.disconnected = true }
  }
})
const { createSegmentedRecorder } = exported
let loads = 0
const context = { sampleRate: 16_000, destination: {}, audioWorklet: { async addModule() { loads++ } } }
const source = { connected: [], disconnected: [], connect(node) { this.connected.push(node) }, disconnect(node) { assert.ok(node); this.disconnected.push(node) } }
const received = []
const errors = []
const create = (ctx = context, segmentSeconds = 0.1) => createSegmentedRecorder(ctx, source, segmentSeconds, (data) => received.push(data), (error) => errors.push(error))
const recorder = await create()
assert.equal(loads, 1)
assert.deepEqual(revoked, urls, 'Release the worklet Blob URL after loading')
const node = nodes.at(-1)
let resolved = false
const stopped = recorder.stop().then(() => { resolved = true })
assert.equal(recorder.stop(), recorder.stop(), 'Repeated stop returns the same promise')
assert.deepEqual(node.messages, ['stop'])
node.port.onmessage({ data: { audio: new Uint8Array([1]), startSeconds: 0, final: true } })
await Promise.resolve()
assert.equal(resolved, false, 'Wait for final acknowledgement, after delivering the tail')
assert.equal(received.length, 1)
node.port.onmessage({ data: { stopped: true } })
await stopped
recorder.dispose()
await recorder.stop()
assert.equal(node.closed, true)
assert.equal(node.disconnected, true)
assert.deepEqual(source.disconnected, [node], 'Disconnect only the recorder, never the analyser')
assert.deepEqual(errors, [])

const cancelled = await create()
assert.equal(loads, 1, 'Register the processor once per AudioContext')
cancelled.dispose()
cancelled.dispose()
await cancelled.stop()
const failing = await create()
const failureWait = assert.rejects(failing.stop(), /오디오 녹음 처리가 중단/)
nodes.at(-1).onprocessorerror()
await failureWait
assert.equal(errors.length, 1)
await assert.rejects(failing.stop(), /오디오 녹음 처리가 중단/)
const interrupted = await create()
const interruptedWait = assert.rejects(interrupted.stop(), /연결이 해제/)
interrupted.dispose()
await interruptedWait

const failedLoadContext = { ...context, audioWorklet: { async addModule() { throw new Error('module failed') } } }
await assert.rejects(create(failedLoadContext), /module failed/)
assert.deepEqual(revoked, urls, 'Release the Blob URL even on module load failure')
failedLoadContext.audioWorklet.addModule = async () => { loads++ }
;(await create(failedLoadContext)).dispose()
assert.equal(loads, 2, 'A failed module load can be retried')
for (const seconds of [0, -1, NaN, Infinity, 0.0000001, 1000]) await assert.rejects(create(context, seconds), /올바르지/)
for (const sampleRate of [0, -1, NaN, Infinity, 0.5]) await assert.rejects(create({ ...context, sampleRate }), /올바르지/)
console.log('Segmented recorder PCM boundaries, WAV headers, stereo, limits, lifecycle and errors: passed')

// Exercise the actual browser worklet, MessagePort transfer and WAV decoder without a microphone or API.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-segmented-recorder-'))
try {
  await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><title>Segmented recording verification</title>')
  const run = async ({ helperCode, workletSource }) => {
    const exports = {}
    new Function('exports', 'require', helperCode)(exports, () => workletSource)
    const sampleRate = 16_000
    const segmentSeconds = 120
    const segmentFrames = sampleRate * segmentSeconds
    const totalFrames = 2 * segmentFrames + 256
    const context = new OfflineAudioContext(1, totalFrames, sampleRate)
    const source = context.createBufferSource()
    source.buffer = context.createBuffer(2, totalFrames, sampleRate)
    source.buffer.getChannelData(0).fill(0.25)
    source.buffer.getChannelData(1).fill(0.75)
    const segments = []
    const recorder = await exports.createSegmentedRecorder(context, source, segmentSeconds,
      (segment) => segments.push(segment), (error) => { throw error })
    source.start()
    const output = await context.startRendering()
    await Promise.race([recorder.stop(), new Promise((_, reject) => setTimeout(() => reject(Error('Stop acknowledgement timed out')), 5000))])
    if (output.getChannelData(0).some((value) => value !== 0)) throw Error('Microphone audio leaked into the output')
    let frames = 0
    for (const segment of segments) {
      const expectedFrames = Math.min(segmentFrames, totalFrames - frames)
      if (segment.audio.byteLength !== 44 + expectedFrames * 2 || segment.audio.byteLength >= 25_000_000) throw Error('Invalid segment WAV size')
      const decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(segment.audio.slice().buffer)
      if (decoded.sampleRate !== sampleRate || decoded.numberOfChannels !== 1) throw Error('Invalid decoded WAV format')
      if (decoded.length !== expectedFrames) throw Error('Incorrect segment duration')
      if (segment.startSeconds !== frames / sampleRate) throw Error('Segment gap or overlap')
      if (segment.final !== (frames + expectedFrames === totalFrames)) throw Error('Incorrect final segment flag')
      if (decoded.getChannelData(0).some((sample) => Math.abs(sample - 0.5) > 0.00004)) throw Error('Incorrect PCM conversion or stereo downmix')
      frames += decoded.length
    }
    if (frames !== totalFrames || segments.length !== 3 || !segments.at(-1).final) throw Error(`Incorrect real worklet frame count: ${frames}/${segments.length}`)
    recorder.dispose()
    return { frames, segments: segments.length, segmentSeconds, sampleRate, bytes: segments.map((segment) => segment.audio.byteLength) }
  }
  const main = `const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
    app.whenReady().then(async () => {
      try {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
        await win.loadFile(${JSON.stringify(path.join(temp, 'index.html'))});
        const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${run.toString()})(${JSON.stringify({ helperCode, workletSource })})`)});
        console.log('Real Electron AudioWorklet capture and WAV decode: ' + JSON.stringify(result));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });`
  const mainPath = path.join(temp, 'main.cjs')
  await fs.writeFile(mainPath, main)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [mainPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
  clearTimeout(timeout)
  assert.equal(code, 0, output)
  console.log(output.split('\n').filter((line) => line.startsWith('Real Electron')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
