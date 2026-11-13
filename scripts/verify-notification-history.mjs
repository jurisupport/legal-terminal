import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const source = await fs.readFile(path.join(root, 'src/renderer/src/App.tsx'), 'utf8')
const shared = await import('../src/shared/sharedUiState.ts')
const storeModule = { exports: {} }
const storeCode = ts.transpileModule(await fs.readFile(path.join(root, 'src/renderer/src/notificationHistoryStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
vm.runInNewContext(storeCode, { module: storeModule, exports: storeModule.exports, require: () => shared })
const store = storeModule.exports
const timers = [], pending = [], saved = new Map()
let history = [], toasts = [], error = '', clock = Date.now(), serial = 0
const localStorage = { get length() { return saved.size }, key: index => [...saved.keys()][index] ?? null, getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
const local = { id: 'local', title: '로컬 작업', kind: 'agent' }
const tab = { id: 'case', ssh: { host: 'office' } }
const context = vm.createContext({
  ...store, localStorage, Date: { now: () => ++clock }, newId: () => `notice-${++serial}`,
  toastSeq: { current: 0 }, termTabsRef: { current: [local] },
  notificationHistoryRef: { current: [] }, setNotificationHistory: entries => { history = entries },
  setNotificationHistoryError: value => { error = value },
  sharedUiCase: () => undefined, caseIdForTerm: () => 'case', sharedUiActivityId: term => term.id,
  workspaceHostKey: ssh => ssh?.host ?? 'local', sharedUiCaseKey: () => 'case-key',
  sharedUiRunsRef: { current: new Map() },
  sharedUiSendRef: { current: (_, operation) => pending.push(operation) },
  enqueueSharedUiOperation: (_, operation) => pending.push(operation), sshProfiles: [], caseOpenProfileId: () => undefined, caseOpenTarget: 'local',
  setToasts: update => { toasts = update(toasts) }, setTimeout: callback => timers.push(callback)
})
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(parsed), node.initializer.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
const names = ['updateNotificationHistory', 'recordNotification', 'pushToast', 'dismissToastForTerm', 'dismissToast', 'pushSyncedTabsToast', 'clearNotificationHistory']
const functions = names.map(name => `const ${name} = ${declarations.get(name)};`).join('\n')
vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
vm.runInContext("pushToast('local', 'done'); pushToast('remote', 'question', '원격 사건'); pushSyncedTabsToast(2)", context)
assert.deepEqual(Array.from(history, item => item.status), ['synced', 'question', 'done'])
assert.equal(history[1].title, '원격 사건')
assert.equal(history[2].title, '로컬 작업')
assert.equal(store.readNotificationHistory(localStorage).length, 3, 'new renderer restores persisted records')
for (const timer of timers.splice(0)) timer()
assert.equal(toasts.length, 1, 'only questions remain after automatic expiry')
assert.equal(history.length, 3, 'expiry preserves history')
vm.runInContext("dismissToastForTerm('remote')", context)
assert.equal(toasts.length, 0)
assert.equal(history.length, 3, 'acknowledgement preserves history')
vm.runInContext("for (let i = 0; i < 105; i++) pushToast('local', 'done', String(i))", context)
assert.equal(history.length, 100)
assert.equal(history[0].title, '104')
assert.equal(history[99].title, '5')
assert.ok(history.every(item => Number.isFinite(item.createdAt)))
context.tab = tab
const sharedCall = "pushToast('remote', 'question', '공유 사건', {tab, activity: {runId:'run', sequence:2}, recorded:false})"
vm.runInContext(sharedCall, context)
vm.runInContext(sharedCall, context)
assert.equal(pending.length, 1, 'same remote event is recorded and queued once')
assert.equal(pending[0].id, pending[0].entry.id)
const server = shared.emptySharedUiState()
shared.applySharedUiOperation(server, pending[0])
assert.equal(server.notifications[0].title, '공유 사건')
const secondComputer = JSON.parse(JSON.stringify(server))
assert.equal(secondComputer.notifications[0].id, history[0].id, 'server snapshot carries history to another computer')
vm.runInContext('clearNotificationHistory()', context)
assert.equal(history.length, 0)
assert.equal(store.readNotificationHistory(localStorage).length, 0, 'clear survives restart even before connection returns')
assert.equal(pending[1].type, 'notification-clear')
shared.applySharedUiOperation(server, pending[1])
shared.applySharedUiOperation(server, pending[0])
assert.equal(server.notifications.length, 0, 'reconnect retry cannot resurrect cleared records')
assert.throws(() => store.readNotificationHistory({length: 1, key: () => store.NOTIFICATION_HISTORY_KEY + ':bad', getItem: () => '{broken'}))
assert.throws(() => store.readNotificationHistory({length: 1, key: () => store.NOTIFICATION_HISTORY_KEY + ':bad', getItem: () => JSON.stringify({id:'x',host:'office', createdAt:'bad'})}))
context.localStorage = { setItem: () => { throw Error('full') } }
vm.runInContext("pushToast('local', 'done')", context)
assert.ok(error.includes('저장하지 못했습니다'), 'failed local writes are visible')
assert.equal(history.length, 1, 'storage failure retains in-memory history')

context.localStorage = localStorage
context.sshProfiles = [{id:'office-profile', host:'office'}]
vm.runInContext("pushToast('local', 'done', '공유할 로컬 알림')", context)
assert.equal(pending.at(-1).entry.title, '공유할 로컬 알림', 'single configured server also shares local notifications')
context.sshProfiles = [{id:'office-profile', host:'office'}, {id:'other-profile', host:'other'}]
const beforeAmbiguous = pending.length
vm.runInContext("pushToast('local', 'done', '서버 미지정 알림')", context)
assert.equal(pending.length, beforeAmbiguous, 'multiple servers without a default cannot receive local notices arbitrarily')
context.caseOpenProfileId = () => 'other-profile'
vm.runInContext("pushToast('local', 'done', '기본 서버 알림')", context)
assert.equal(history[0].host, 'other', 'configured default determines the local notification sharing scope')

// Execute the production outbox path across an offline renderer restart.
const transportNames = ['persistSharedUiQueue', 'pendingNotificationOperations', 'flushSharedUiQueue', 'enqueueSharedUiOperation']
const transportCode = transportNames.map(name => `const ${name} = ${declarations.get(name)};`).join('\n') + '\n({enqueueSharedUiOperation, flushSharedUiQueue})'
let online = false
const transportServer = shared.emptySharedUiState()
const transportContext = () => ({
  ...store, localStorage, sharedUiQueueRef: {current: []}, sharedUiSequenceRef: {current: 0}, sharedUiChainRef: {current: Promise.resolve()},
  sshProfiles: [{host: 'office'}], workspaceHostKey: profile => profile.host, sshConnFromProfile: profile => profile,
  setNotificationHistoryError: () => {}, setWorkspaceSyncError: () => {}, setSharedUiConflict: () => {},
  window: {lt: {workspace: {sharedUiApply: async (_, operation) => {
    if (!online) return {ok:false, error:'offline'}
    shared.applySharedUiOperation(transportServer, operation)
    return {ok:true, state:transportServer}
  }}}}
})
const transport = ctx => vm.runInNewContext(ts.transpileModule(transportCode, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, ctx)
const firstWindow = transportContext()
transport(firstWindow).enqueueSharedUiOperation('office', pending[0])
await firstWindow.sharedUiChainRef.current
assert.equal(store.readNotificationOutbox(localStorage).length, 1, 'offline queue is durable')
online = true
await transport(transportContext()).flushSharedUiQueue()
assert.equal(transportServer.notifications.length, 1, 'fresh renderer replays persisted offline history')
assert.equal(store.readNotificationOutbox(localStorage).length, 0)
const removedProfileWindow = transportContext()
removedProfileWindow.sshProfiles = []
transport(removedProfileWindow).enqueueSharedUiOperation('office', pending[1])
await removedProfileWindow.sharedUiChainRef.current
assert.equal(store.readNotificationOutbox(localStorage).length, 1, 'clear remains pending while profile is removed')
await transport(transportContext()).flushSharedUiQueue()
assert.equal(transportServer.notifications.length, 0, 'restoring the profile applies the durable clear')

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-history-'))
try {
  await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import NotificationHistory from './src/renderer/src/NotificationHistory'; import {readNotificationHistory, writeNotificationHistory, NOTIFICATION_HISTORY_KEY} from './src/renderer/src/notificationHistoryStore';
      function Test() { const [entries, setEntries] = React.useState(() => readNotificationHistory(localStorage)); window.setEntries = setEntries; const previous = React.useRef(entries); React.useEffect(() => {writeNotificationHistory(localStorage, entries, previous.current); previous.current = entries}, [entries]);
        return <div className="workspace-todo-header"><button id="outside">오늘 요약</button><NotificationHistory entries={entries} onSelect={entry => window.selected = entry.termId} onClear={() => setEntries([])} /></div> }
      createRoot(document.getElementById('root')).render(<Test/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, jsx: 'automatic', outfile: path.join(temp, 'ui.js')
  })
  await fs.copyFile(path.join(root, 'src/renderer/src/styles.css'), path.join(temp, 'styles.css'))
  await fs.writeFile(path.join(temp, 'index.html'), '<html lang="ko"><meta charset="UTF-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script src="ui.js"></script></html>')
  const screenshot = path.join(os.tmpdir(), 'legal-terminal-notification-history.png')
  function testApp(temp, screenshot) {
    const { app, BrowserWindow } = require('electron')
    const fs = require('node:fs')
    const assert = require('node:assert/strict')
    app.setPath('userData', require('node:path').join(temp, 'profile'))
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 1000, height: 700, show: false })
      const run = code => win.webContents.executeJavaScript(code)
      try {
        await win.loadFile(require('node:path').join(temp, 'index.html'))
        for (let i = 0; i < 50 && !await run('!!document.querySelector("summary")'); i++) await new Promise(r => setTimeout(r, 20))
        await run('document.querySelector("summary").click()')
        assert.ok(await run('document.body.innerText.includes("아직 받은 알림이 없습니다")'))
        const entries = [
          { id: 'three', host: 'office', termId: 'remote', title: '손해배상 사건 · 상대방 준비서면 검토 및 추가 자료 확인 요청', status: 'question', createdAt: Date.now() },
          { id: 'two', host: 'office', termId: 'local', title: '대여금 사건 · 준비서면 초안', status: 'done', createdAt: Date.now() - 60000 },
          { id: 'one', host: 'office', termId: '', title: '새 탭 2개를 가져왔습니다', status: 'synced', createdAt: Date.now() - 120000 }
        ]
        await run(`window.setEntries(${JSON.stringify(entries)})`)
        await new Promise(r => setTimeout(r, 100))
        assert.equal(await run('document.querySelectorAll(".notification-history-entry").length'), 3)
        assert.ok(await run('document.querySelectorAll(".notification-history-entry")[2].disabled'))
        await win.loadFile(require('node:path').join(temp, 'index.html'))
        for (let i = 0; i < 50 && !await run('!!document.querySelector("summary")'); i++) await new Promise(r => setTimeout(r, 20))
        await run('document.querySelector("summary").click()')
        assert.equal(await run('document.querySelectorAll(".notification-history-entry").length'), 3, 'reload restores the history UI')
        const bounds = await run('JSON.stringify(document.querySelector(".notification-history-panel").getBoundingClientRect().toJSON())')
        assert.ok(JSON.parse(bounds).right <= 1000)
        fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
        await run('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))')
        assert.equal(await run('document.querySelector("details").open'), false)
        assert.equal(await run('document.activeElement.tagName'), 'SUMMARY')
        await run('document.querySelector("summary").click(); document.querySelector(".notification-history-entry").click()')
        assert.equal(await run('window.selected'), 'remote')
        assert.equal(await run('document.querySelector("details").open'), false)
        await run('document.querySelector("summary").click(); document.querySelector("#outside").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true}))')
        assert.equal(await run('document.querySelector("details").open'), false)
        await run('document.querySelector("summary").click(); document.querySelector(".notification-history-panel header button").click()')
        await new Promise(r => setTimeout(r, 50))
        assert.ok(await run('document.body.innerText.includes("아직 받은 알림이 없습니다")'))
        console.log('Notification history: expiry, acknowledgement, remote events, 100-item limit, navigation, clear, Escape and outside click passed. Screenshot: ' + screenshot)
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    })
  }
  const entry = path.join(temp, 'main.cjs')
  await fs.writeFile(entry, `(${testApp.toString()})(${JSON.stringify(temp)}, ${JSON.stringify(screenshot)})`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 30000)
  const code = await new Promise(resolve => child.once('exit', resolve))
  clearTimeout(timeout)
  assert.equal(code, 0)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
