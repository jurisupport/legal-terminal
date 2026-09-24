import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/agent/AgentPanel.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('AgentPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const panel = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AgentPanel')
const effect = (fragment) => {
  const statement = panel.body.statements.find((node) => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect' && node.getText(ast).includes(fragment))
  assert.ok(statement, `missing actual effect: ${fragment}`)
  return statement.expression.arguments[0].getText(ast)
}
const session = panel.body.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find((node) => node.name.getText(ast) === 'inlineSession')
const helpers = ['mergePromptHistory', 'expandSlashInput', 'slashCommandName']
const helperSource = ast.statements.filter((node) => helpers.includes(node.name?.text)).map((node) => node.getText(ast)).join('\n')
const bridgeEffect = panel.body.statements.find((node) => node.getText(ast).includes('onInlineActions?.(id, actions)'))
assert.equal(bridgeEffect.expression.arguments[1].getText(ast), '[id, onInlineActions]', 'draft changes must not unregister the bridge')
const code = ts.transpileModule(`${helperSource}\n({
  makeSession: ${session.initializer.arguments[0].getText(ast)},
  mount: ${effect('inlineSession.active = true')},
  create: ${effect('inlineSession.creation = window.lt.agent')},
  register: ${effect('onInlineActions?.(id, actions)')}
})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const attachment = { kind: 'selection', label: '계약서 · PDF 2쪽', text: '선택한 문장', range: { startPage: 2, endPage: 2 } }
const request = { text: '  이 부분을 설명해줘  ', attachment }
const unchanged = () => assert.fail('inline submission must not modify or focus the normal composer')
const fixture = (createPromise = Promise.resolve({ ok: true })) => {
  const sent = [], registrations = [], errors = [], modes = []
  let creates = 0, consumed = 0
  const ctx = {
    id: 'agent-1', provider: 'claude', cwd: '/case', title: '사건', settingsLoaded: true,
    mode: 'ask', resumeSessionId: undefined, defaultModel: 'model-1', ssh: undefined,
    caseContext: '사건 맥락', workspaceContext: { kind: 'case', cwd: '/case', caseId: 'case-1' }, forkFromSessionId: undefined,
    input: '오른쪽에 작성 중인 초안', attachments: [{ kind: 'file', path: '/draft.md' }], quotedMessage: { text: '보류한 인용' },
    setInput: unchanged, setAttachments: unchanged, setQuotedMessage: unchanged, resetPromptHistoryCursor: unchanged,
    focusPrompt: unchanged, scrollTimelineToBottom: unchanged, onStatus: unchanged,
    PROMPT_HISTORY_LIMIT: 100, promptHistoryRef: { current: [] },
    codexPanelSlashCommandNames: new Set(['/compact', '/model', '/permissions']),
    claudeTerminalOnlySlashCommandNames: new Set(['/permissions', '/exit']),
    setError: (error) => errors.push(error),
    setPendingHandoff: (update) => { ctx.inlineStateRef.current.pendingHandoff = update(ctx.inlineStateRef.current.pendingHandoff) },
    onInlineActions: (id, actions) => registrations.push({ id, actions }),
    window: { lt: { agent: {
      create: async (options) => { creates++; assert.equal(options.id, 'agent-1'); return createPromise },
      send: async (id, payload) => { sent.push({ id, payload }); return { ok: true } }
    } } }
  }
  const api = runInNewContext(code, ctx)
  ctx.inlineSession = api.makeSession()
  const unmount = api.mount()
  ctx.inlineStateRef = { current: {
    session: ctx.inlineSession, sendBlockedReason: '', mode: 'ask', queuesNewInput: false,
    workspaceContext: ctx.workspaceContext, pendingHandoff: null,
    allSlashCommands: [{ name: '/plan', mode: 'plan', expand: (rest) => `계획: ${rest}` }, { name: '/mcp', expand: () => 'mcp' }],
    onPrepareAttachment: undefined, onHandoffConsumed: () => { consumed++ },
    selectPermissionMode: (...args) => modes.push(args)
  } }
  api.create()
  const unregister = api.register()
  return { ctx, api, sent, registrations, errors, modes, actions: registrations.at(-1).actions,
    unmount: () => { unregister(); unmount() }, creates: () => creates, consumed: () => consumed }
}

const creating = deferred()
const fresh = fixture(creating.promise)
const originalDraft = JSON.stringify([fresh.ctx.input, fresh.ctx.attachments, fresh.ctx.quotedMessage])
const waiting = fresh.actions.submit(request)
assert.equal(fresh.sent.length, 0, 'submit must await the actual create promise')
fresh.api.create()
assert.equal(fresh.creates(), 1, 'rerendering must not create a second session')
creating.resolve({ ok: true })
assert.equal((await waiting).ok, true)
assert.equal(fresh.sent[0].id, 'agent-1')
assert.equal(fresh.sent[0].payload.text, request.text.trim())
assert.equal(fresh.sent[0].payload.attachments.length, 1)
assert.equal(fresh.sent[0].payload.attachments[0], attachment)
assert.equal(fresh.sent[0].payload.workspaceContext, fresh.ctx.workspaceContext)
assert.equal(fresh.sent[0].payload.quote, undefined, 'the normal pending quote must not leak into inline instructions')
assert.equal(JSON.stringify([fresh.ctx.input, fresh.ctx.attachments, fresh.ctx.quotedMessage]), originalDraft)
assert.equal(fresh.ctx.promptHistoryRef.current.at(-1), request.text.trim())

for (const result of [{ ok: false, error: '생성 실패' }, Promise.reject(new Error('연결 실패'))]) {
  const failed = fixture(Promise.resolve(result))
  const response = await failed.actions.submit(request)
  assert.equal(response.ok, false)
  assert.match(response.error, /실패/)
  assert.equal(failed.sent.length, 0)
  assert.equal(failed.ctx.promptHistoryRef.current.length, 0)
}
for (const reason of ['로그인 필요', '로그인 진행 중', 'CLI 없음', '이전 할일 연결']) {
  const blocked = fixture()
  blocked.ctx.inlineStateRef.current.sendBlockedReason = reason
  assert.equal((await blocked.actions.submit(request)).error, reason)
  assert.equal(blocked.sent.length, 0)
}
const beforeSettings = fixture()
beforeSettings.ctx.inlineSession.creation = null
beforeSettings.ctx.inlineStateRef.current.sendBlockedReason = 'Agent 설정 로드 중'
assert.equal((await beforeSettings.actions.submit(request)).error, 'Agent 설정 로드 중')

const prepared = deferred()
const queued = fixture()
queued.ctx.inlineStateRef.current.onPrepareAttachment = () => prepared.promise
const queueSend = queued.actions.submit(request)
await Promise.resolve(); await Promise.resolve()
assert.equal((await queued.actions.submit(request)).ok, false, 'duplicate inline submissions are blocked while preparing')
queued.ctx.inlineStateRef.current.queuesNewInput = true
queued.ctx.inlineStateRef.current.mode = 'plan'
queued.ctx.inlineStateRef.current.pendingHandoff = { preamble: '이전 대화 맥락', count: 2 }
const newAttachment = { ...attachment, text: '저장 직전 최신 선택 내용' }
prepared.resolve(newAttachment)
assert.equal((await queueSend).ok, true)
assert.equal(queued.sent[0].payload.delivery, 'queue', 'delivery uses the latest state after attachment preparation')
assert.equal(queued.sent[0].payload.permissionMode, 'plan')
assert.equal(queued.sent[0].payload.attachments[0], newAttachment)
assert.equal(queued.sent[0].payload.text, `이전 대화 맥락\n${request.text.trim()}`)
assert.equal(queued.sent[0].payload.displayText, request.text.trim())
assert.equal(queued.consumed(), 1)
assert.equal(queued.ctx.inlineStateRef.current.pendingHandoff, null)
queued.ctx.promptHistoryRef.current = ['계약서를 요약해줘', '계약서를 검토해줘']
assert.equal(queued.actions.suggest('계약서'), '계약서를 검토해줘')
assert.equal(queued.actions.suggest('계약서를 검토해줘'), undefined)
assert.equal(queued.actions.suggest(''), undefined)
assert.equal(queued.actions.suggest('다른 대화'), undefined)
queued.ctx.promptHistoryRef.current = ['여러 줄\n지시문', '긴 ' + '지시'.repeat(300)]
assert.equal(queued.actions.suggest('여러'), undefined, 'multiline history stays in the normal input history')
assert.equal(queued.actions.suggest('긴 '), undefined, 'large prompts do not fill the small completion preview')

const sendingFailure = fixture()
sendingFailure.ctx.inlineStateRef.current.pendingHandoff = { preamble: '맥락', count: 1 }
sendingFailure.ctx.window.lt.agent.send = async () => ({ ok: false, error: '전송 실패' })
assert.equal((await sendingFailure.actions.submit(request)).error, '전송 실패')
assert.equal(sendingFailure.ctx.promptHistoryRef.current.length, 0)
assert.equal(sendingFailure.consumed(), 0)
assert.ok(sendingFailure.ctx.inlineStateRef.current.pendingHandoff)
const accepting = deferred()
const dispatched = deferred()
const replacedHandoff = fixture()
replacedHandoff.ctx.inlineStateRef.current.pendingHandoff = { preamble: '이전 맥락', count: 1 }
replacedHandoff.ctx.window.lt.agent.send = () => { dispatched.resolve(); return accepting.promise }
const accepted = replacedHandoff.actions.submit(request)
await dispatched.promise
const newerHandoff = { preamble: '새 맥락', count: 2 }
replacedHandoff.ctx.inlineStateRef.current.pendingHandoff = newerHandoff
accepting.resolve({ ok: true })
assert.equal((await accepted).ok, true)
assert.equal(replacedHandoff.ctx.inlineStateRef.current.pendingHandoff, newerHandoff, 'success cannot consume a newer handoff')
assert.equal(replacedHandoff.consumed(), 0)
const prepFailure = fixture()
prepFailure.ctx.inlineStateRef.current.onPrepareAttachment = async () => { throw new Error('첨부 준비 실패') }
assert.match((await prepFailure.actions.submit(request)).error, /첨부 준비 실패/)
assert.equal(prepFailure.sent.length, 0)

const commands = fixture()
for (const text of ['/model', '/mcp auth', '/permissions', '/unknown']) {
  assert.match((await commands.actions.submit({ ...request, text })).error, /Agent 입력창/)
}
assert.equal(commands.sent.length, 0)
assert.equal((await commands.actions.submit({ ...request, text: '/plan 검토' })).ok, true)
assert.equal(commands.sent[0].payload.text, '계획: 검토')
assert.equal(commands.sent[0].payload.permissionMode, 'plan')
assert.equal(commands.modes[0][0], 'plan')
commands.ctx.inlineSession.provider = 'codex'
commands.ctx.inlineStateRef.current.allSlashCommands.push({ name: '/compact', expand: () => '요약' })
assert.match((await commands.actions.submit({ ...request, text: '/compact' })).error, /Agent 입력창/)
assert.equal(commands.sent.length, 1, 'a Codex panel command cannot bypass its dedicated execution path')

for (const change of ['unmount', 'id', 'provider', 'auth']) {
  const preparing = deferred()
  const stale = fixture()
  stale.ctx.inlineStateRef.current.onPrepareAttachment = () => preparing.promise
  const pending = stale.actions.submit(request)
  await Promise.resolve(); await Promise.resolve()
  if (change === 'unmount') stale.unmount()
  else if (change === 'auth') stale.ctx.inlineStateRef.current.sendBlockedReason = '로그인 필요'
  else stale.ctx.inlineStateRef.current.session = { ...stale.ctx.inlineSession, [change]: change === 'id' ? 'agent-2' : 'codex' }
  preparing.resolve(attachment)
  assert.equal((await pending).ok, false, `${change} while preparing must cancel before dispatch`)
  assert.equal(stale.sent.length, 0)
  if (change === 'unmount') {
    assert.equal(stale.registrations.at(-1).actions, null)
    assert.equal(stale.actions.suggest('이'), undefined)
    assert.equal((await stale.actions.submit(request)).ok, false)
  }
}

console.log('inline Agent submission: draft/quote preservation, create readiness/failure, auth/settings, attachment preparation, queue/handoff/history, slash gates and stale sessions passed')
