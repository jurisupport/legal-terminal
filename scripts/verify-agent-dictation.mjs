import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText
const componentCode = compile(readFileSync(new URL(
  '../src/renderer/src/agent/AgentDictationButton.tsx', import.meta.url), 'utf8'))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const audio = (sample = 2048) => {
  const bytes = new Uint8Array(48)
  new DataView(bytes.buffer).setInt16(44, sample, true)
  return bytes
}

// Exercise the real component, holding state changes until the next render like React does.
function harness(options = {}) {
  const slots = [], effects = [], requests = [], recorders = [], contexts = [], texts = [], busy = []
  const timers = new Map()
  let cursor = 0, dirty = true, mounted = true, tree, mediaCalls = 0, timerId = 0
  let props = { active: true, onText: (text) => texts.push(text), onBusyChange: (value) => busy.push(value) }
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value } },
    useState(value) {
      const index = cursor++
      slots[index] ??= { value: typeof value === 'function' ? value() : value }
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true }
      }]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: callback }
      return slots[index].value
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback() })
      }
    }
  }
  hooks.useLayoutEffect = hooks.useEffect
  hooks.useMemo = (callback, deps) => hooks.useCallback(callback, deps)()
  const track = { stopped: 0, readyState: 'live', listeners: {},
    stop() { this.stopped++; this.readyState = 'ended' },
    addEventListener(name, listener) { this.listeners[name] = listener }, removeEventListener() {} }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const exports = {}
  vm.runInNewContext(componentCode, {
    exports,
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
      if (name.endsWith('/segmentedRecorder')) return {
        async createSegmentedRecorder(context, source, seconds, onSegment, onError) {
          const recorder = { stops: 0, disposed: 0, onSegment, onError,
            async stop() {
              this.stops++
              if (options.stopGate) await options.stopGate.promise
              onSegment({ audio: options.finalAudio ?? audio(), startSeconds: 0, final: true })
            }, dispose() { this.disposed++ } }
          recorders.push(recorder)
          if (options.recorderGate) await options.recorderGate.promise
          return recorder
        }
      }
      throw new Error(`Unexpected component dependency: ${name}`)
    },
    navigator: { mediaDevices: { getUserMedia: async () => {
      mediaCalls++
      if (options.mediaError) throw options.mediaError
      if (options.mediaGate) await options.mediaGate.promise
      return stream
    } } },
    AudioWorkletNode: class {},
    AudioContext: class {
      state = 'running'
      closed = 0
      constructor() { contexts.push(this) }
      async resume() {}
      async close() { this.closed++; this.state = 'closed' }
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data) => data.fill(128) } }
    },
    window: {
      setInterval(callback) { timers.set(++timerId, callback); return timerId },
      clearInterval(id) { timers.delete(id) },
      setTimeout(callback) { timers.set(++timerId, callback); return timerId },
      clearTimeout(id) { timers.delete(id) },
      lt: { dictation: {
        keyStatus: async () => options.keyStatus ?? 'ok',
        transcribe(payload) { const request = { payload, ...deferred() }; requests.push(request); return request.promise }
      } }
    },
    Uint8Array, DataView, Error, Date, console
  })
  function render() {
    let remaining = 20
    while (mounted && dirty) {
      assert.ok(remaining--, 'Component rendering must settle')
      dirty = false; cursor = 0
      tree = exports.AgentDictationButton(props)
      for (const effect of effects.splice(0)) effect()
    }
  }
  function nodes(node) {
    if (node == null || typeof node === 'boolean') return []
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child))
    if (typeof node !== 'object') return [node]
    return [node, ...nodes(node.props?.children)]
  }
  render()
  return {
    requests, recorders, contexts, texts, busy, track, timers,
    get mediaCalls() { return mediaCalls },
    get text() { return nodes(tree).filter((node) => typeof node === 'string').join(' ') },
    get buttons() { return nodes(tree).filter((node) => node?.type === 'button') },
    click(index = 0) { const button = this.buttons[index]; assert.ok(button, 'Button exists'); button.props.onClick() },
    async settle() { await setImmediate(); render(); await setImmediate(); render() },
    update(next) { props = { ...props, ...next }; dirty = true; render() },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.() }
  }
}

await test('A missing API key is explained before requesting microphone permission', async () => {
  const h = harness({ keyStatus: 'missing' })
  h.click(); await h.settle()
  assert.match(h.text, /OpenAI API 키/)
  assert.equal(h.mediaCalls, 0)
  assert.equal(h.requests.length, 0)
  assert.equal(h.busy.at(-1), false)
})

await test('Denied microphone permission offers a useful error and permits another attempt', async () => {
  const error = new Error('Permission denied'); error.name = 'NotAllowedError'
  const h = harness({ mediaError: error })
  h.click(); await h.settle()
  assert.match(h.text, /마이크.*권한/)
  assert.equal(h.buttons[0].props.disabled, false)
  assert.equal(h.requests.length, 0)
  assert.equal(h.busy.at(-1), false)
})

await test('Stop inserts the transcript once and releases the microphone before awaiting transcription', async () => {
  const h = harness()
  h.click(); await h.settle()
  assert.equal(h.buttons[0].props['aria-pressed'], true)
  assert.equal(h.requests.length, 0, 'No audio is uploaded before stopping')
  h.click(); await h.settle()
  assert.equal(h.track.stopped, 1)
  assert.equal(h.contexts[0].closed, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].payload.mimeType, 'audio/wav')
  assert.equal(h.requests[0].payload.context, undefined)
  h.requests[0].resolve({ ok: true, text: '  일반 질문입니다.  ' }); await h.settle()
  assert.deepEqual(h.texts, ['일반 질문입니다.'])
  assert.equal(h.busy.at(-1), false)
  assert.match(h.text, /확인한 뒤 전송/)
})

await test('Rapid duplicate stop clicks cannot upload the same audio twice', async () => {
  const stopGate = deferred()
  const h = harness({ stopGate })
  h.click(); await h.settle()
  h.click(); h.click()
  assert.equal(h.recorders[0].stops, 1)
  stopGate.resolve(); await h.settle()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve({ ok: true, text: '한 번만' }); await h.settle()
  assert.deepEqual(h.texts, ['한 번만'])
})

await test('Failed transcription retains the exact audio for retry and blocks replacement recording', async () => {
  const h = harness()
  h.click(); await h.settle(); h.click(); await h.settle()
  h.requests[0].reject(new Error('연결 실패')); await h.settle()
  assert.match(h.text, /연결 실패.*다시 시도/)
  assert.equal(h.buttons[0].props.disabled, true)
  assert.deepEqual(h.texts, [])
  h.click(1); await h.settle()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].payload.audio, h.requests[0].payload.audio)
  h.requests[1].resolve({ ok: true, text: '복구된 질문' }); await h.settle()
  assert.deepEqual(h.texts, ['복구된 질문'])
  assert.equal(h.buttons[0].props.disabled, false)
})

await test('Retrying a partial segmented result skips the completed segment and inserts each text once', async () => {
  const h = harness()
  h.click(); await h.settle()
  h.recorders[0].onSegment({ audio: audio(1024), startSeconds: 0, final: false })
  await h.settle()
  assert.equal(h.recorders[0].stops, 1, 'The duration limit stops recording')
  h.requests[0].resolve({ ok: true, text: '첫 구간' }); await h.settle()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve({ ok: false, error: '두 번째 구간 실패' }); await h.settle()
  assert.deepEqual(h.texts, [])
  h.click(1); await h.settle()
  assert.equal(h.requests.length, 3)
  assert.equal(h.requests[2].payload.audio, h.requests[1].payload.audio)
  h.requests[2].resolve({ ok: true, text: '마지막 구간' }); await h.settle()
  assert.deepEqual(h.texts, ['첫 구간 마지막 구간'])
})

await test('Silent audio produces no transcription request or fabricated text', async () => {
  const h = harness({ finalAudio: audio(0) })
  h.click(); await h.settle(); h.click(); await h.settle()
  assert.equal(h.requests.length, 0)
  assert.deepEqual(h.texts, [])
  assert.match(h.text, /녹음된 음성이 없습니다/)
  assert.equal(h.track.stopped, 1)
})

await test('A recorder that never acknowledges stop still releases the microphone after timeout', async () => {
  const h = harness({ stopGate: deferred() })
  h.click(); await h.settle(); h.click(); await h.settle()
  for (const callback of h.timers.values()) callback()
  await h.settle()
  assert.equal(h.track.stopped, 1)
  assert.equal(h.contexts[0].closed, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(h.busy.at(-1), false)
  assert.match(h.text, /누락될 수 있습니다/)
})

await test('Discarding failed audio allows a fresh recording without retrying the discarded clip', async () => {
  const h = harness()
  h.click(); await h.settle(); h.click(); await h.settle()
  h.requests[0].resolve({ ok: false, error: '연결 실패' }); await h.settle()
  h.click(2); await h.settle()
  assert.equal(h.buttons[0].props.disabled, false)
  assert.doesNotMatch(h.text, /다시 시도/)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.texts, [])
})

await test('Switching away stops recording and keeps its transcript with its owning conversation', async () => {
  const h = harness()
  h.click(); await h.settle()
  h.update({ active: false }); await h.settle()
  assert.equal(h.track.stopped, 1)
  assert.equal(h.recorders[0].stops, 1)
  h.requests[0].resolve({ ok: true, text: '이전 대화의 질문' }); await h.settle()
  assert.deepEqual(h.texts, ['이전 대화의 질문'])
  assert.equal(h.buttons[0].props.disabled, true)
})

await test('Unmount releases all microphone resources and ignores late transcription', async () => {
  const h = harness()
  h.click(); await h.settle(); h.click(); await h.settle()
  h.unmount()
  h.requests[0].resolve({ ok: true, text: '닫힌 대화의 질문' }); await h.settle()
  assert.deepEqual(h.texts, [])
  assert.equal(h.track.stopped, 1)
  assert.equal(h.contexts[0].closed, 1)
  assert.equal(h.timers.size, 0)
})

for (const cancel of ['inactive', 'unmount']) {
  for (const stage of ['media', 'recorder']) {
    await test(`${cancel} during ${stage} startup releases late resources without recording`, async () => {
      const gate = deferred()
      const h = harness({ [`${stage}Gate`]: gate })
      h.click(); await h.settle()
      if (cancel === 'inactive') h.update({ active: false })
      else h.unmount()
      gate.resolve(); await h.settle()
      assert.equal(h.track.stopped, 1)
      assert.equal(h.requests.length, 0)
      assert.equal(h.timers.size, 0)
      assert.equal(h.busy.at(-1), false)
      if (stage === 'recorder') {
        assert.equal(h.contexts[0].closed, 1)
        assert.equal(h.recorders[0].disposed, 1)
      }
    })
  }
}

await test('Unmount during recording releases the microphone without sending audio', async () => {
  const h = harness()
  h.click(); await h.settle(); h.unmount()
  assert.equal(h.track.stopped, 1)
  assert.equal(h.contexts[0].closed, 1)
  assert.equal(h.recorders[0].disposed, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(h.requests.length, 0)
})

await test('General questions use neutral transcription and correction prompts; hearings retain court context', async () => {
  const source = ts.createSourceFile('dictation.ts', readFileSync(new URL('../src/main/dictation.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['contextSummary', 'cleanPrompt', 'transcriptionPrompt', 'correctTranscript']
  const functions = source.statements.filter((node) => names.includes(node.name?.text)).map((node) => node.getText(source)).join('\n')
  const requests = []
  const api = Function('callResponses', 'CORRECTION_MODEL', 'stripCodeFence', 'extractText', 'shouldUseDictationCorrection',
    compile(functions) + '; return { transcriptionPrompt, correctTranscript }')(
    async (_key, request) => { requests.push(request); return { ok: true, json: {} } }, 'mock', (text) => text, () => '원문', () => true)
  assert.doesNotMatch(api.transcriptionPrompt(), /법정|기일기록/)
  assert.match(api.transcriptionPrompt({ court: '서울중앙지법' }), /법정.*서울중앙지법/)
  await api.correctTranscript('mock', '원문')
  await api.correctTranscript('mock', '원문', {})
  assert.doesNotMatch(requests[0].input[0].content[0].text, /법정/)
  assert.match(requests[1].input[0].content[0].text, /법정/)
})
