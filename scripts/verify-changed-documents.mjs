import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as values from '../src/renderer/src/agent/values.ts'

const diffSource = readFileSync(new URL('../src/renderer/src/agent/diff.ts', import.meta.url), 'utf8')
const diff = {}
runInNewContext(ts.transpileModule(diffSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: diff, require: () => values })

const source = readFileSync(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('AgentPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    declarations.set(node.name.getText(parsed), `const ${node.name.getText(parsed)} = ${node.initializer.getText(parsed)};`)
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
function load(names, context = {}) {
  const code = names.map((name) => {
    assert.ok(declarations.has(name), `actual implementation exists: ${name}`)
    return declarations.get(name)
  }).join('\n') + `\n;({${names.join(',')}})`
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, { ...values, ...diff, ...context })
}
const { reduceTimeline, currentChangedDocuments } = load([
  'upsertItem', 'messageQuote', 'attachmentSource', 'attachmentAccess', 'attachmentOrigin',
  'normalizeAgentAttachments', 'reduceTimeline', 'currentChangedDocuments'
])
let items = []
const event = (type, fields = {}) => { items = reduceTimeline(items, { type, sessionId: 'test', ...fields }, 'Claude') }
const request = (id) => event('message:user', { messageId: id, text: id, attachments: [] })
const applied = (id, path, before, after) => event('diff:applied', { proposalId: id, filePath: path, oldString: before, newString: after })
request('first')
event('diff:proposed', { proposal: { proposalId: 'a', filePath: '/case/draft.md', oldString: 'first', newString: 'second' } })
assert.equal(currentChangedDocuments(items).length, 0, 'unapplied proposals are not changed documents')
applied('a', '/case/draft.md', 'first', 'second')
applied('b', '/case/draft.md', 'second', 'third')
applied('c', '/case/exhibits/draft.md', 'evidence old', 'evidence new')
assert.equal(currentChangedDocuments(items).length, 2, 'same file groups; identical basenames in different directories stay separate')
const first = currentChangedDocuments(items)[0]
assert.equal(first.diff.hunks.length, 2, 'both edits remain reviewable')
assert.equal(first.diff.revertEdits[0].newString, 'third', 'latest edit is undone first')
const oldView = JSON.stringify(first)
request('second')
assert.equal(currentChangedDocuments(items).length, 0, 'new request starts its own change list')
applied('a', '/case/draft.md', 'third', 'fourth')
const current = currentChangedDocuments(items)[0]
assert.notEqual(current.id, first.id, 'provider proposal IDs reused across requests do not reuse diff tabs')
assert.equal(current.diff.hunks.length, 1, 'previous request edits are not merged into current changes')
assert.equal(JSON.stringify(items.find((item) => item.id === first.id)), oldView, 'prior comparison remains intact')
event('queue:added', { queueId: 'later', text: 'queued request', attachments: [] })
assert.equal(currentChangedDocuments(items)[0].id, current.id, 'queuing a request does not start it')
items = items.map((item) => item.id === current.id ? { ...item, status: 'reverted' } : item)
assert.equal(currentChangedDocuments(items)[0].status, 'reverted', 'reverted document remains identifiable')
applied('d', '/case/draft.md', 'third', 'fifth')
assert.equal(currentChangedDocuments(items).length, 1, 'a new edit after reverting is still one document')
assert.equal(currentChangedDocuments(items)[0].status, 'applied')

const patch = diff.diffViewFromRecord({ filePath: '/case/draft.md', structuredPatch: [], gitDiff: {
  diff: '--- a/draft.md\r\n+++ b/draft.md\r\n@@ -2,2 +2,2 @@\r\n-old text\r\n+new text\r\n context\r\n@@ -8 +8 @@\r\n-old end\r\n+new end\r\n\nMoved to: /case/new.md'
} })
assert.equal(patch.hunks.length, 2)
assert.equal(patch.additions, 2)
assert.equal(patch.deletions, 2)
assert.equal(patch.hunks[0].rows[0].before, 'old text')
assert.equal(patch.hunks[0].rows[0].after, 'new text')
assert.equal(patch.hunks[0].rows[0].beforeNo, 2)
assert.equal(patch.revertEdits, undefined, 'patch-only comparisons must not fabricate reversible full text')
assert.equal(diff.diffViewFromRecord({ gitDiff: { diff: 'Binary files differ' } }), undefined)
assert.equal(diff.diffViewFromRecord({ oldString: 'removed\nfile' }).deletions, 2)
assert.equal(diff.diffViewFromRecord({ newString: 'added\nfile' }).additions, 2)
const diffExample = '@@ -1 +1 @@\n-before\n+after'
assert.equal(diff.diffViewFromRecord({ newString: diffExample, gitDiff: { kind: { type: 'add' }, diff: diffExample } }).additions, 3,
  'a newly created document containing a diff example is still ordinary document text')

// Exercise the shared rollback handler: no write for ambiguity, stale content, active work, or rejection.
for (const scenario of ['success', 'ambiguous', 'missing', 'rejected', 'working', 'failure']) {
  let text = scenario === 'ambiguous' ? 'third third' : scenario === 'missing' ? 'edited elsewhere' : 'third'
  let writes = 0, error = '', reverted = false
  const { revertDiffItem } = load(['canRevertDiff', 'revertDiffItem'], {
    cwd: '/case', profileId: undefined, ssh: undefined, caseTabId: 'case', status: scenario === 'working' ? 'working' : 'done',
    useCallback: (callback) => callback,
    agentFilePathForApp: (path) => path, fileNameFromPath: (path) => path.split('/').at(-1),
    setRevertingDiffIds: (update) => update(new Set()), setError: (value) => { error = value },
    setItems: (update) => { reverted = update([first])[0].status === 'reverted' },
    REMOTE_FILE_CHANGED_EVENT: 'changed', CustomEvent: class {},
    window: { dispatchEvent() {}, lt: {
      dialog: { confirm: async () => scenario !== 'rejected' },
      fs: { readText: async () => ({ kind: 'text', text }), writeText: async (_path, next) => {
        writes++; if (scenario === 'failure') return { ok: false, error: 'write failed' }
        text = next; return { ok: true }
      } }
    } }
  })
  await revertDiffItem(first)
  assert.equal(writes, ['success', 'failure'].includes(scenario) ? 1 : 0, `${scenario}: only safe confirmed rollback attempts a write`)
  assert.equal(reverted, scenario === 'success', `${scenario}: status reflects actual successful write`)
  if (scenario === 'success') assert.equal(text, 'first', 'all same-request edits reverse in order')
  if (['ambiguous', 'missing', 'failure'].includes(scenario)) assert.ok(error, `${scenario}: failure is visible`)
}
console.log('changed documents: request boundaries, per-file grouping, unified diff, and guarded rollback passed')
