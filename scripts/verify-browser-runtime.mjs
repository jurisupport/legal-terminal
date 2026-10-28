import assert from 'node:assert/strict'
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'

const source = await readFile(new URL('../src/main/browser/runtime.cjs.txt', import.meta.url), 'utf8')
const module = { exports: {} }
new Function('require', 'module', 'exports', source)(createRequire(import.meta.url), module, module.exports)
const { validateCommand, safeUrl, runPageCommand, createHttpServer, createChromeController, findChrome } = module.exports

for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'https://user:secret@example.com']) assert.throws(() => safeUrl(url))
assert.equal(safeUrl('https://example.com'), 'https://example.com/')
assert.equal(safeUrl('about:blank'), 'about:blank')
assert.throws(() => validateCommand({ action: 'evaluate', expression: 'process.exit()' }))
assert.throws(() => validateCommand({ action: 'type', text: 'x'.repeat(16001) }))
assert.throws(() => validateCommand({ action: 'click', x: Infinity, y: 3 }))
assert.throws(() => validateCommand({ action: 'key', key: 'Enter', modifiers: 1.5 }))
const calls = []
await runPageCommand(async (method, params) => { calls.push({ method, params }); return {} }, { action: 'type', text: "it's safe ${process.exit()}" })
assert.deepEqual(calls, [{ method: 'Input.insertText', params: { text: "it's safe ${process.exit()}" } }])
await runPageCommand(async (method, params) => { calls.push({ method, params }); return {} }, { action: 'key', key: 'Enter' })
assert.equal(calls[1].params.text, '\r')
for (const platform of ['darwin', 'linux', 'win32']) {
  const isolated = { exports: {} }
  new Function('require', 'module', 'exports', 'process', source)(createRequire(import.meta.url), isolated, isolated.exports, { platform })
  const modifierCalls = []
  const send = async (method, params) => { modifierCalls.push(params); return {} }
  await isolated.exports.runPageCommand(send, { action: 'key', key: 'a', code: 'KeyA', modifiers: 4 })
  assert.equal(modifierCalls[0].modifiers, platform === 'darwin' ? 4 : 2)
  await isolated.exports.runPageCommand(send, { action: 'key', key: 'a', code: 'KeyA', modifiers: 2 })
  assert.equal(modifierCalls[2].modifiers, 2, 'Explicit Ctrl must stay Ctrl on every platform')
}

const token = 'test-browser-token-01234567890123456789'
let frameCalls = 0, closed = false
const fake = {
  state: () => ({ url: 'about:blank', tabs: [] }),
  command: command => command.action === 'read' ? { text: 'Page content' } : { command },
  frame: async () => { frameCalls++; await new Promise(resolve => setTimeout(resolve, 25)); return { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1280, height: 800, etag: '"same-frame"' } },
  close: async () => { closed = true }
}
const endpoint = await createHttpServer({ controller: fake, token })
const base = `http://127.0.0.1:${endpoint.port}`
const request = (route, options = {}) => fetch(base + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } })
const rpc = async (name, args = {}) => (await request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()
try {
  assert.equal((await fetch(base + '/state')).status, 401)
  assert.equal((await request('/state', { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await request('/state', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await request('/state', { headers: { origin: 'null' } })).status, 403)
  assert.equal((await request('/command', { method: 'POST', body: '{' })).status, 400)
  assert.equal((await request('/command', { method: 'POST', body: JSON.stringify({ action: 'navigate', url: 'file:///secret' }) })).status, 400)
  assert.equal((await request('/command', { method: 'POST', body: JSON.stringify({ action: 'type', text: 'x'.repeat(70000) }) })).status, 413)
  assert.equal((await request('/frame?quality=invalid')).status, 400)
  assert.equal((await rpc('browser_click', { x: 10, y: 10 })).result.isError, true)
  assert.equal((await rpc('browser_read')).result.content[0].text, '{"text":"Page content"}')
  assert.equal((await rpc('browser_tabs', { action: 'list' })).result.isError, undefined)
  assert.equal((await request('/policy', { method: 'POST', body: JSON.stringify({ readOnly: false }) })).status, 200)
  assert.equal((await rpc('browser_click', { x: 10, y: 10 })).result.isError, undefined)
  assert.equal((await request('/policy', { method: 'POST', body: JSON.stringify({ readOnly: 'false' }) })).status, 400)
  endpoint.setReadOnly(true)
  assert.equal((await rpc('browser_type', { text: 'test' })).result.isError, true)
  assert.equal((await request('/command', { method: 'POST', body: JSON.stringify({ action: 'type', text: 'test' }) })).status, 200)
  endpoint.setReadOnly(false)
  const originalCommand = fake.command
  const execution = []
  let signalStart
  const started = new Promise(resolve => { signalStart = resolve })
  fake.command = async command => {
    execution.push(`start:${command.text}`)
    if (command.text === 'first') { signalStart(); await new Promise(resolve => setTimeout(resolve, 60)) }
    if (command.text === 'failure') throw new Error('Expected command failure')
    execution.push(`end:${command.text}`)
    return { ok: true }
  }
  const firstCommand = request('/command', { method: 'POST', body: JSON.stringify({ action: 'type', text: 'first' }) })
  await started
  const secondCommand = rpc('browser_type', { text: 'second' })
  await Promise.all([firstCommand, secondCommand])
  assert.deepEqual(execution, ['start:first', 'end:first', 'start:second', 'end:second'], 'UI and agent commands must share one queue')
  assert.equal((await rpc('browser_type', { text: 'failure' })).result.isError, true)
  assert.equal((await rpc('browser_type', { text: 'recovered' })).result.isError, undefined, 'Failed commands must not block the queue')
  fake.command = originalCommand
  const first = await request('/frame?quality=saver')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-browser-width'), '1280')
  assert.equal((await first.arrayBuffer()).byteLength, 4)
  const unchanged = await request('/frame?quality=saver', { headers: { 'if-none-match': first.headers.get('etag') } })
  assert.equal(unchanged.status, 304)
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0)
  const before = frameCalls
  await Promise.all([request('/frame'), request('/frame'), request('/frame')])
  assert.equal(frameCalls - before, 1, 'Concurrent frame polling shares a single capture')
  const init = await request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' }) })
  assert.equal((await init.json()).result.serverInfo.name, 'legal-terminal-browser')
  const tools = await request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }) })
  assert.equal((await tools.json()).result.tools.length, 8)
  for (const method of ['resources/list', 'prompts/list']) {
    const response = await request('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method }) })
    assert.deepEqual((await response.json()).result, { [method.split('/')[0]]: [] })
  }
  assert.equal((await request('/shutdown', { method: 'POST' })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(closed, true)
} finally { endpoint.server.close(); endpoint.server.closeAllConnections() }
console.log('Browser runtime validation, HTTP authentication, policy, bounded requests, MCP, JPEG and 304 checks passed.')

let chromePath
try { chromePath = await findChrome() } catch { console.log('Chrome integration skipped: Chrome/Chromium is not installed.'); process.exit(0) }
const directory = await mkdtemp(path.join(tmpdir(), 'lt-browser-test-'))
const fixture = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Browser fixture</title><h1>Browser test page</h1><input id="name" aria-label="Name"><input type="password" value="secret-password"><input autocomplete="one-time-code" value="secret-code"><textarea>secret-note</textarea><div contenteditable>secret-editable</div><button id="go" onclick="document.querySelector(\'h1\').textContent=\'Clicked \'+document.querySelector(\'#name\').value">Go</button><div style="height:2000px"></div>')
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
let controller
try {
  controller = await createChromeController({ directory, chromePath })
  await controller.command({ action: 'navigate', url: `http://127.0.0.1:${fixture.address().port}/` })
  let read
  for (let index = 0; index < 30; index++) {
    read = await controller.command({ action: 'read' })
    if (read.title === 'Browser fixture') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(read.title, 'Browser fixture')
  for (const secret of ['secret-password', 'secret-code', 'secret-note', 'secret-editable']) assert.ok(!JSON.stringify(read).includes(secret), `${secret} must not leak`)
  await controller.command({ action: 'type', selector: '#name', text: 'typed safely' })
  await controller.command({ action: 'key', key: 'a', code: 'KeyA', modifiers: 4 })
  await controller.command({ action: 'type', text: 'replacement' })
  await controller.command({ action: 'click', selector: '#go' })
  assert.ok((await controller.command({ action: 'read' })).text.includes('Clicked replacement'), 'Platform select-all shortcut should replace the prior text')
  const saver = await controller.frame({ quality: 'saver' })
  assert.equal(saver.width, 1280)
  assert.equal(saver.height, 800)
  assert.equal(saver.data[0], 0xff)
  assert.equal(saver.data[1], 0xd8)
  await controller.command({ action: 'scroll', x: 640, y: 400, deltaY: 500 })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.notEqual((await controller.frame({ quality: 'saver' })).etag, saver.etag)
  const initial = (await controller.state()).activeTabId
  const second = await controller.command({ action: 'new_tab', url: 'about:blank' })
  assert.equal(second.tabs.length, 2)
  assert.notEqual(second.activeTabId, initial)
  await controller.command({ action: 'switch_tab', tabId: initial })
  assert.equal((await controller.state()).activeTabId, initial)
  await controller.command({ action: 'close_tab', tabId: second.activeTabId })
  assert.equal((await controller.state()).tabs.length, 1)
  await assert.rejects(() => controller.command({ action: 'navigate', url: 'file:///etc/passwd' }))
  console.log(`Chrome integration passed: navigation, credential redaction, typing, clicking, scrolling, ${saver.data.length}-byte saver JPEG and tab lifecycle.`)
} finally {
  await controller?.close()
  fixture.close(); fixture.closeAllConnections()
  await new Promise(resolve => setTimeout(resolve, 250))
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const daemonDirectory = await mkdtemp(path.join(tmpdir(), 'lt-browser-daemon-test-'))
let daemon
try {
  const runtimePath = path.join(daemonDirectory, 'runtime.cjs')
  const configPath = path.join(daemonDirectory, 'config.json')
  await writeFile(runtimePath, source)
  await writeFile(configPath, JSON.stringify({ directory: daemonDirectory, token, chromePath }), { mode: 0o600 })
  for (const crashChrome of [true, false]) {
    daemon = spawn(process.execPath, [runtimePath, configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = once(daemon, 'exit')
    let stderr = '', ready
    daemon.stderr.on('data', data => { stderr += data.toString() })
    for (let index = 0; index < 150; index++) {
      assert.equal(daemon.exitCode, null, stderr)
      try { ready = JSON.parse(await readFile(path.join(daemonDirectory, 'ready.json'), 'utf8')); break } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'Daemon must publish readiness after Chrome is usable')
    assert.equal(ready.pid, daemon.pid)
    assert.equal((await stat(path.join(daemonDirectory, 'ready.json'))).mode & 0o777, 0o600)
    const headers = { authorization: `Bearer ${token}` }
    const daemonBase = `http://127.0.0.1:${ready.port}`
    assert.equal((await fetch(daemonBase + '/state', { headers })).status, 200)
    const frame = await fetch(daemonBase + '/frame', { headers })
    assert.equal(frame.status, 200)
    assert.ok((await frame.arrayBuffer()).byteLength > 100)
    const same = await fetch(daemonBase + '/frame', { headers: { ...headers, 'if-none-match': frame.headers.get('etag') } })
    assert.equal(same.status, 304)
    assert.equal((await same.arrayBuffer()).byteLength, 0)
    if (crashChrome) {
      const children = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === daemon.pid).map(([pid]) => pid)
      assert.equal(children.length, 1, 'The daemon must own exactly one Chrome child process')
      assert.ok(Number.isInteger(children[0]) && children[0] > 0 && children[0] !== daemon.pid && children[0] !== process.pid)
      process.kill(children[0], 'SIGKILL')
    } else assert.equal((await fetch(daemonBase + '/shutdown', { method: 'POST', headers })).status, 200)
    await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Daemon did not exit after shutdown')), 10000); timer.unref() })])
    await assert.rejects(() => stat(path.join(daemonDirectory, 'ready.json')))
    await assert.rejects(() => stat(path.join(daemonDirectory, 'runtime.lock')))
    assert.equal(daemon.exitCode, crashChrome ? 1 : 0)
  }
  console.log('Standalone daemon passed: private readiness file, real Chrome JPEG/304, unexpected Chrome crash cleanup, restart in the same profile and clean shutdown.')
} finally {
  if (daemon?.exitCode === null) daemon.kill('SIGTERM')
  await rm(daemonDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
