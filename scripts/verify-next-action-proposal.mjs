import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as dates from '../src/shared/todoSummary.ts'
import { nextActionCollector } from '../src/shared/nextActionProposal.ts'
const event = (type, extra = {}) => ({ type, sessionId: 'session', ...extra })
const user = event('message:user', { text: '', attachments: [{ content: '[next-action:request]' }] })
let collect = nextActionCollector('request', 'session')
assert.equal(collect(event('message:assistant_start', { messageId: 'old' })).phase, 'waiting')
assert.equal(collect(event('message:user', { sessionId: 'other', text: '[next-action:request]' })).phase, 'waiting')
assert.equal(collect(user).phase, 'receiving')
collect(event('message:assistant_start', { messageId: 'old' }))
collect(event('message:assistant_delta', { messageId: 'old', text: '다음 행동: 오래된 제안' }))
assert.equal(collect(event('message:assistant_done', { messageId: 'old' })).phase, 'receiving')
collect(event('message:assistant_start', { messageId: 'new' }))
collect(event('message:assistant_delta', { messageId: 'new', text: '다음 행동: ' }))
collect(event('message:assistant_delta', { messageId: 'new', text: '계좌내역 요청\n설명' }))
assert.equal(collect(event('message:assistant_done', { messageId: 'other' })).phase, 'receiving')
assert.equal(collect(event('message:assistant_done', { messageId: 'new' })).title, '계좌내역 요청')
assert.equal(collect(event('message:assistant_replace', { messageId: 'new', text: '다음 행동: 덮어쓰기' })).title, '계좌내역 요청')
collect = nextActionCollector('request', 'session'); collect(user)
collect(event('message:user', { text: '다른 요청' }))
assert.equal(collect(event('message:assistant_start', { messageId: 'later' })).phase, 'unavailable')
collect = nextActionCollector('request', 'session'); collect(user)
collect(event('message:assistant_start', { messageId: 'new' }))
collect(event('message:assistant_replace', { messageId: 'new', text: '다음 행동: ' + '가'.repeat(10_000) }))
assert.equal(collect(event('message:assistant_done', { messageId: 'new' })).title.length, 200)

// Exercise the real React component with synthetic IPC and minimal hook/element adapters.
const code = ts.transpileModule(readFileSync(new URL('../src/renderer/src/NextActionProposal.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const original = { id: 'task', caseId: 'case', title: '원 업무', status: 'pending', type: 'todo', version: 3, updatedAt: '2026-10-01' }
function harness(overrides = {}) {
  const hooks = [], pendingEffects = [], events = new Set(), listeners = new Map(), calls = []
  let cursor = 0, closed = 0, props, tree
  const saved = []
  const react = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value }] },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial } },
    useEffect(fn, deps) {
      const i = cursor++, previous = hooks[i]
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        pendingEffects.push(() => { previous?.cleanup?.(); hooks[i] = { deps, cleanup: fn() } })
      }
    }
  }
  const exports = {}
  vm.runInNewContext(code, { exports, require(name) {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    if (name.includes('nextActionProposal')) return { nextActionCollector }
    if (name.includes('todoSummary')) return dates
    throw Error(name)
  }, window: {
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    lt: { agent: { onEvent: fn => { events.add(fn); return () => events.delete(fn) } }, todo: {
      get: async id => { calls.push(['get', id]); return overrides.get ? overrides.get(id) : { ok: true, todo: original } },
      create: async input => { calls.push(['create', input]); return overrides.create ? overrides.create(input) : { ok: true, todo: { ...input, id: 'created', status: 'pending' } } }
    } }
  } })
  props = { request: { id: 'request', sessionId: 'session', task: original }, activeCaseId: 'case', onClose: () => { closed++ }, onSaved: todo => saved.push(todo) }
  function render(update = {}) { props = { ...props, ...update }; cursor = 0; tree = exports.default(props); while (pendingEffects.length) pendingEffects.shift()(); return tree }
  const flatten = node => !node ? [] : Array.isArray(node) ? node.flatMap(flatten) : typeof node === 'object' ? [node, ...flatten(node.props?.children)] : []
  const find = predicate => flatten(tree).find(predicate)
  const button = () => find(node => node.type === 'button' && node.props.children === '후속 할일로 저장')
  const titleInput = () => find(node => node.type === 'input' && node.props.className === 'todo-create-input')
  const send = value => { for (const fn of events) fn(value); render() }
  const dispose = () => { for (const hook of hooks) hook?.cleanup?.() }
  render(); render()
  return { render, calls, saved, button, titleInput, send, dispose, listeners, events, closed: () => closed, find }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
let ui = harness()
assert.equal(ui.calls.length, 0, 'mount never writes or invokes the model')
ui.titleInput().props.onChange({ target: { value: '직접 고친 행동' } }); ui.render()
ui.send(user); ui.send(event('message:assistant_start', { messageId: 'new' }))
ui.send(event('message:assistant_delta', { messageId: 'new', text: '다음 행동: AI 제안' }))
ui.send(event('message:assistant_done', { messageId: 'new' }))
assert.equal(ui.titleInput().props.value, '직접 고친 행동', 'stream never overwrites user edits')
assert.equal(ui.calls.length, 0, 'a finished suggestion cannot mutate tasks')
const save = ui.button().props.onClick
save(); save(); await flush(); ui.render()
assert.equal(ui.calls.filter(call => call[0] === 'create').length, 1)
const input = ui.calls.find(call => call[0] === 'create')[1]
assert.equal(input.title, '직접 고친 행동'); assert.equal(input.caseId, 'case')
assert.equal(input.dueDate, undefined); assert.equal(input.parentId, undefined)
assert.match(input.notes, /task/); assert.match(input.notes, /request/)
assert.equal(ui.saved[0].id, 'created')
save(); await flush(); assert.equal(ui.calls.length, 2, 'success reuses the saved ID without another create')
ui.dispose(); assert.equal(ui.events.size, 0)

ui = harness({ create: async () => { throw Error('response lost') } })
ui.titleInput().props.onChange({ target: { value: '후속 업무' } }); ui.render()
ui.button().props.onClick(); await flush(); ui.render()
assert.equal(ui.button().props.disabled, true)
ui.button().props.onClick(); await flush()
assert.equal(ui.calls.filter(call => call[0] === 'create').length, 1, 'uncertain response prevents blind retries')
ui.dispose()
for (const changed of [{ version: 4 }, { caseId: 'other' }, { status: 'completed' }]) {
  ui = harness({ get: async () => ({ ok: true, todo: { ...original, ...changed } }) })
  ui.titleInput().props.onChange({ target: { value: '후속 업무' } }); ui.render()
  ui.button().props.onClick(); await flush(); ui.render()
  assert.equal(ui.calls.some(call => call[0] === 'create'), false)
  ui.dispose()
}
let release
ui = harness({ get: () => new Promise(resolve => { release = resolve }) })
ui.titleInput().props.onChange({ target: { value: '후속 업무' } }); ui.render()
ui.button().props.onClick(); await flush()
ui.listeners.get('lt-js-token-updated')()
release({ ok: true, todo: original }); await flush()
assert.equal(ui.closed(), 1); assert.equal(ui.calls.some(call => call[0] === 'create'), false)
ui.dispose()
ui = harness(); ui.render({ activeCaseId: 'other' })
assert.equal(ui.closed(), 1); assert.equal(ui.events.size, 0)
assert.equal(ui.calls.length, 0)
ui.dispose()
console.log('next action: explicit-turn parsing, bounded proposal, edit preservation, explicit-only create, current-task checks, duplicate prevention and account/case cancellation verified')
