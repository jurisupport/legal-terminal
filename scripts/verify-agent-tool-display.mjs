import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as values from '../src/renderer/src/agent/values.ts'
import * as subAgents from '../src/renderer/src/agent/subAgentStatus.ts'

const require = createRequire(import.meta.url)
const exports = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/renderer/src/agent/ToolRow.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText, {
  exports,
  require: name => name === './values' ? values : name === './subAgentStatus' ? subAgents : require(name)
})
const { toolStepDisplay, ToolRow, isDiagnosticStep, processStepStatus } = exports
const { renderToStaticMarkup } = require('react-dom/server')
const command = 'python /private/case/scan.py --all'
const description = '사건 기록에서 관련 판례를 찾습니다'
const step = { id: 'shell', title: '도구 · Bash', toolName: 'Bash', status: 'running',
  input: JSON.stringify({ command, description }), output: 'RAW_PROCESS_OUTPUT' }
assert.equal(toolStepDisplay(step).name, '명령 실행')
assert.equal(toolStepDisplay(step).arg, undefined, 'generated explanations stay in details regardless of language')
const collapsed = renderToStaticMarkup(ToolRow({ step, expanded: false, onToggle() {} }))
assert.ok(collapsed.includes('명령 실행') && collapsed.includes('실행 중'))
assert.ok(!collapsed.includes(description), 'generated explanations must not leak through the tooltip')
assert.ok(!collapsed.includes(command) && !collapsed.includes('RAW_PROCESS_OUTPUT'), 'raw data stays in the disclosure')
const expanded = renderToStaticMarkup(ToolRow({ step, expanded: true, onToggle() {} }))
assert.ok(expanded.includes(command) && expanded.includes('RAW_PROCESS_OUTPUT') && expanded.includes(description))

const truncated = { ...step, input: '{"command":"' + 'x'.repeat(1600) + '...', description }
assert.equal(toolStepDisplay(truncated).arg, undefined)
assert.ok(renderToStaticMarkup(ToolRow({ step: truncated, expanded: true, onToggle() {} })).includes(description),
  'a truncated input preview must preserve the separate description in details')
for (const input of [JSON.stringify({ command }), JSON.stringify({ command, description: '  ' }), '{invalid']) {
  assert.equal(toolStepDisplay({ ...step, input }).arg, undefined, 'missing descriptions must not expose commands')
}
assert.equal(toolStepDisplay({ ...step, toolName: 'Shell', input: command + '\n/private/case' }).arg, undefined,
  'Codex plain-text shell input stays in details')
assert.equal(toolStepDisplay({ id: 'read', title: '', toolName: 'Read', input: '{"file_path":"/case/소장.pdf"}' }).arg, '소장.pdf')
assert.equal(toolStepDisplay({ id: 'search', title: '', toolName: 'WebSearch', input: '{"query":"임대차 판례"}' }).arg, '임대차 판례')
assert.equal(toolStepDisplay({ id: 'agent', title: '', toolName: 'Agent', input: '{"description":"최초 작업","prompt":"RAW_PROMPT"}', text: '판례 세 건의 사실관계를 비교하고 있습니다' }).arg,
  undefined, 'live progress stays in details')
assert.equal(toolStepDisplay({ id: 'agent', title: '', toolName: 'Agent', input: '{"prompt":"RAW_PROMPT"}' }).arg, undefined)
assert.equal(toolStepDisplay({ id: 'summary', title: '도구 요약', text: '관련 판례 세 건을 확인했습니다' }).arg,
  undefined)
for (const title of ['명령 출력', '명령 출력 · stderr', '프로세스 출력 · stdout', '프로세스 종료', 'Codex']) {
  assert.equal(toolStepDisplay({ id: 'process', title, text: 'RAW_PROCESS_OUTPUT' }).arg, undefined)
}
assert.equal(toolStepDisplay({ id: 'managed', title: '', toolName: 'mcp__legal_terminal_jurisupport__get_task',
  input: '{"id":"opaque-id"}', text: 'opaque-id' }).arg, undefined)
for (const sample of [
  { id: 'agent', title: '도구 · Agent', toolName: 'Agent', text: 'Comparing precedents', description: 'Review records', output: 'RAW_AGENT_RESULT', status: 'running' },
  { id: 'codex-agent:child', title: '도구 · Agent', text: 'Analyzing evidence', status: 'done' },
  { id: 'claude-task:child', title: '백그라운드 작업', text: 'Analyzing evidence', status: 'paused' },
  { id: 'summary', title: '도구 요약', text: 'Found three precedents', status: 'done' },
  { id: 'external', title: '도구 · mcp__external__lookup', toolName: 'mcp__external__lookup', text: 'Looking up documents', status: 'error' },
  { id: 'legacy', title: '도구 · unknown_tool', text: 'Processing request', status: 'cancelled' }
]) {
  const before = JSON.stringify(sample)
  const display = toolStepDisplay(sample)
  assert.match(display.name, /[가-힣]/)
  const closed = renderToStaticMarkup(ToolRow({ step: sample, expanded: false, onToggle() {} }))
  assert.ok(!closed.includes(sample.text), 'raw summaries stay out of collapsed rows and tooltips')
  const opened = renderToStaticMarkup(ToolRow({ step: sample, expanded: true, onToggle() {} }))
  assert.ok(opened.includes(sample.text), 'original summaries remain available even alongside output')
  if (sample.output) assert.ok(opened.includes(sample.output))
  if (sample.description) assert.ok(opened.includes(sample.description))
  assert.equal(JSON.stringify(sample), before, 'display formatting must not rewrite stored events')
}
for (const [status, label] of Object.entries({ running: '실행 중', done: '완료', completed: '완료', paused: '일시 중지', error: '실패', cancelled: '중지됨' })) {
  assert.ok(renderToStaticMarkup(ToolRow({ step: { ...step, status }, expanded: false, onToggle() {} })).includes(label))
}
assert.equal(toolStepDisplay({ id: 'read', title: '', toolName: 'Read', description: 'Reading source', input: '{"file_path":"/case/contract.pdf"}' }).arg, 'contract.pdf',
  'file names remain unchanged even when descriptions are hidden')
console.log('Agent tool display: Korean rows and statuses, original-detail disclosure, malformed/truncated input, Claude/Codex fallbacks passed')

const hook = { id: 'hook', title: 'Hook · SessionStart:startup', text: 'RAW_HOOK_OUTPUT' }
for (const status of ['running', 'success', 'done', 'completed']) {
  assert.equal(isDiagnosticStep({ ...hook, status }), true, 'normal hooks belong in collapsed diagnostics')
}
for (const status of ['error', 'failed', 'cancelled', 'canceled', 'blocked', 'unknown']) {
  assert.equal(isDiagnosticStep({ ...hook, status }), false, 'failed or uncertain hooks must remain visible')
}
const limit = { id: 'limit', title: 'Rate limit' }
assert.equal(isDiagnosticStep({ ...limit, status: 'allowed', text: 'allowed' }), true)
assert.equal(isDiagnosticStep({ ...limit, text: 'allowed' }), true, 'legacy snapshots may only store the rate status as text')
for (const status of ['allowed_warning', 'rejected', 'unknown']) {
  assert.equal(isDiagnosticStep({ ...limit, status }), false)
}
assert.equal(isDiagnosticStep({ ...step, status: 'done' }), false, 'real tool work stays in the main timeline')
assert.equal(isDiagnosticStep({ ...step, title: hook.title }), false, 'tool calls must not be classified by a system-event title')
assert.equal(isDiagnosticStep({ id: 'connection', title: '원격 재연결 중', status: 'running' }), false)
assert.equal(processStepStatus({ ...hook, status: 'success' }), 'done')
assert.equal(processStepStatus({ ...hook, status: 'error' }), 'error')
assert.equal(processStepStatus({ ...limit, status: 'allowed_warning' }), 'warning')
assert.equal(processStepStatus({ ...limit, status: 'rejected' }), 'error')
assert.equal(processStepStatus({ ...step, status: 'running' }), 'running')
assert.equal(toolStepDisplay({ ...hook, status: 'error' }).name, '자동 처리 오류')
assert.equal(toolStepDisplay({ ...hook, status: 'error' }).arg, undefined, 'hook output stays in details')
assert.equal(toolStepDisplay({ ...limit, status: 'allowed_warning' }).name, '사용 한도에 가까워졌습니다')
assert.equal(toolStepDisplay({ ...limit, status: 'rejected' }).name, '사용 한도에 도달했습니다')
const hookError = { ...hook, status: 'error' }
assert.ok(!renderToStaticMarkup(ToolRow({ step: hookError, expanded: false, onToggle() {} })).includes('RAW_HOOK_OUTPUT'))
const hookDetails = renderToStaticMarkup(ToolRow({ step: hookError, expanded: true, onToggle() {} }))
assert.ok(hookDetails.includes('RAW_HOOK_OUTPUT') && hookDetails.includes(hook.title), 'original diagnostics remain inspectable')
console.log('System diagnostics: normal logs fold, failures and usage warnings remain visible, legacy events preserve raw details')
