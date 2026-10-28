import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(
  readFileSync(new URL('../src/renderer/src/viewer/PdfViewer.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }
).outputText
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const bytes = () => new Uint8Array([37, 80, 68, 70]).buffer
const document = (numPages = 3) => ({ numPages, destroyed: 0, destroy() { this.destroyed++; return Promise.resolve() } })
const children = (node) => Array.isArray(node) ? node : [node]
const nodes = (node) => node && typeof node === 'object'
  ? [node, ...children(node.props?.children).flatMap(nodes)] : []
const text = (node) => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children)
    : node == null || typeof node === 'boolean' ? '' : String(node)

// Execute the production component and its effects; only React scheduling and external IO are mocked.
function harness(path = '/records/test.pdf') {
  const slots = [], reads = [], tasks = [], workers = [], ports = [], timers = new Map(), statuses = [], outlines = []
  let cursor = 0, dirty = true, effects = [], tree, timerId = 0, statVersion = 1
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (update) => {
        const next = typeof update === 'function' ? update(slots[index]) : update
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true }
      }]
    },
    useRef(current) {
      const index = cursor++
      return slots[index] ??= { current }
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) effects.push({ index, callback, deps })
    }
  }
  const jsx = (type, props) => ({ type, props })
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline': {
      default: class {
        terminated = 0
        constructor() { ports.push(this) }
        terminate() { this.terminated++ }
      }
    },
    'pdfjs-dist': {
      PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
      PDFWorker: class {
        destroyed = 0
        constructor({ port }) { this.port = port; workers.push(this) }
        destroy() { this.destroyed++ }
      },
      getDocument(options) {
        const task = { ...deferred(), options, destroyed: 0, destroy() { this.destroyed++; return Promise.resolve() } }
        tasks.push(task)
        return task
      }
    },
    './recordOutline': { parseRecordOutline: async () => ({ entries: [] }) }
  }
  const context = {
    exports: {}, Uint8Array, Error, console,
    require(name) { assert.ok(name in modules, `unexpected dependency: ${name}`); return modules[name] },
    setInterval(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id },
    clearInterval(id) { timers.delete(id) },
    window: { lt: {
      settings: { get: async () => ({}) },
      fs: {
        readBytes(readPath) { const read = { ...deferred(), path: readPath }; reads.push(read); return read.promise },
        stat: async () => ({ ok: true, size: 100, mtimeMs: statVersion })
      }
    } }
  }
  vm.runInNewContext(code, context, { filename: 'PdfViewer.js' })
  const props = { path, cropOn: false, cropRatio: 0.1, onCropOn() {}, onCropRatio() {},
    onStatus: (status) => statuses.push(status), onOutline: (...args) => outlines.push(args) }
  function render() {
    let passes = 0
    while (dirty) {
      assert.ok(++passes < 30, 'component render/effect loop must settle')
      dirty = false; cursor = 0; effects = []
      tree = context.exports.default(props)
      const pending = effects
      for (const { index } of pending) slots[index]?.cleanup?.()
      for (const { index, callback, deps } of pending) slots[index] = { deps, cleanup: callback() }
    }
  }
  render()
  return {
    reads, tasks, workers, ports, statuses, outlines,
    setProps(update) { Object.assign(props, update); dirty = true; render() },
    async flush() { await new Promise(setImmediate); render(); await new Promise(setImmediate); render() },
    click(label) {
      const matches = nodes(tree).filter((node) => node.type === 'button' && text(node).trim() === label)
      assert.equal(matches.length, 1, `one visible ${label} button`)
      assert.ok(!matches[0].props.disabled, `${label} must remain enabled`)
      matches[0].props.onClick()
    },
    text: () => text(tree),
    hasPage: () => nodes(tree).some((node) => node.props?.className === 'pdf-page'),
    poll() { statVersion++; for (const timer of timers.values()) if (timer.ms === 2500) timer.callback() },
    unmount() { for (const slot of slots) slot?.cleanup?.() }
  }
}

const cancelled = 'PDF 불러오기를 취소했습니다.'
async function loaded(h, index = 0) {
  h.reads[index].resolve(bytes())
  await h.flush()
  const doc = document()
  h.tasks.at(-1).resolve(doc)
  await h.flush()
  assert.equal(h.statuses.at(-1).pages, doc.numPages, 'retry exposes loaded page count')
  assert.equal(h.hasPage(), true, 'successful retry displays the page container')
  assert.doesNotMatch(h.text(), /취소했습니다|PDF 열기 실패|PDF 불러오는 중/)
  return doc
}

// A read that never settles must not prevent cancellation or a successful retry.
{
  const h = harness()
  h.click('취소')
  await h.flush()
  assert.ok(h.text().includes(cancelled))
  assert.equal(h.hasPage(), false)
  h.click('다시 시도')
  await h.flush()
  assert.equal(h.reads.length, 2)
  await loaded(h, 1)
  h.unmount()
}

for (const failure of [false, true]) {
  const h = harness()
  h.click('취소')
  // Settle before a React effect cleanup to prove the click invalidates work synchronously.
  if (failure) h.reads[0].reject(new Error('old read failed'))
  else h.reads[0].resolve(bytes())
  await h.flush()
  assert.ok(h.text().includes(cancelled), 'late old IO cannot overwrite cancellation')
  assert.equal(h.tasks.length, 0, 'cancelled IO must not start PDF parsing')
  h.click('다시 시도')
  await h.flush()
  await loaded(h, 1)
  h.unmount()
}

for (const failure of [false, true]) {
  const h = harness()
  h.click('취소')
  await h.flush()
  h.click('다시 시도')
  await h.flush()
  await loaded(h, 1)
  if (failure) h.reads[0].reject(new Error('previous attempt failed after retry'))
  else h.reads[0].resolve(bytes())
  await h.flush()
  assert.equal(h.tasks.length, 1, 'late previous read cannot create a second parser')
  assert.equal(h.statuses.at(-1).pages, 3)
  assert.equal(h.hasPage(), true)
  assert.equal(h.outlines.length, 1, 'only the current attempt publishes an outline')
  h.unmount()
}

for (const password of [false, true]) {
  const h = harness()
  h.reads[0].resolve(bytes())
  await h.flush()
  if (password) {
    h.tasks[0].onPassword(() => {}, 1)
    await h.flush()
    assert.match(h.text(), /암호가 필요한 PDF입니다/)
  }
  h.click('취소')
  assert.ok(h.tasks[0].destroyed, 'cancel destroys the PDF loading task immediately')
  assert.ok(h.workers[0].destroyed, 'cancel destroys the owned PDF worker')
  assert.ok(h.ports[0].terminated, 'cancel terminates the actual worker port')
  const staleDoc = document(99)
  h.tasks[0].resolve(staleDoc)
  await h.flush()
  assert.ok(h.text().includes(cancelled))
  assert.ok(staleDoc.destroyed, 'a document resolved after cancellation is released')
  assert.equal(h.outlines.length, 0)
  h.click('다시 시도')
  await h.flush()
  await loaded(h, 1)
  h.unmount()
}

{
  const h = harness('ssh://host/records/test.pdf')
  await h.flush()
  h.poll()
  h.click('취소')
  await h.flush()
  h.poll()
  await h.flush()
  assert.equal(h.reads.length, 1, 'queued or future remote polling cannot restart a cancelled load')
  assert.ok(h.text().includes(cancelled))
  h.click('다시 시도')
  await h.flush()
  await loaded(h, 1)
  h.unmount()
}

{
  const h = harness()
  h.reads[0].reject(new Error('read failed'))
  await h.flush()
  assert.match(h.text(), /PDF 열기 실패: read failed/)
  h.click('다시 시도')
  await h.flush()
  await loaded(h, 1)
  h.unmount()
}

// A citation may arrive before PDF bytes/parsing finish; loading must not reset its requested page.
for (const requested of [2, 12]) {
  const h = harness()
  h.setProps({ jumpTo: { path: '/records/test.pdf', page: requested, nonce: 1 } })
  await loaded(h)
  assert.equal(h.statuses.at(-1).page, Math.min(requested, 3), 'pending quote navigation survives loading and clamps to page count')
  h.setProps({ jumpTo: { path: '/records/another.pdf', page: 1, nonce: 2 } })
  assert.equal(h.statuses.at(-1).page, Math.min(requested, 3), 'a jump for another PDF must not affect this viewer')
  h.setProps({ jumpTo: { path: '/records/test.pdf', page: 1, nonce: 3 } })
  assert.equal(h.statuses.at(-1).page, 1, 'a loaded viewer must navigate to a new citation')
  h.unmount()
}

console.log('PDF cancellation and citation navigation: stalled reads, cleanup, retry, pending page jumps, and document isolation passed')
