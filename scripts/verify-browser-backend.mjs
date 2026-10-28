import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-browser-backend-'))
const remote = process.argv.includes('--remote')
let profile
if (remote) {
  const userData = process.env.LT_BROWSER_USER_DATA || path.join(os.homedir(), 'Library/Application Support/legal-terminal')
  const settings = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'))
  profile = settings.sshProfiles?.find(p => !process.env.LT_BROWSER_PROFILE || p.id === process.env.LT_BROWSER_PROFILE)
  assert.ok(profile, 'a configured SSH profile is required for --remote')
  await fs.cp(path.join(userData, 'ssh-host-keys'), path.join(temp, 'profile', 'ssh-host-keys'), { recursive: true })
}

function run({ root, temp, profile }) {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
  const http = require('node:http'), { createRequire } = require('node:module')
  const nativeRequire = createRequire(path.join(root, 'package.json'))
  const ts = nativeRequire('typescript')
  const cache = new Map(), handlers = new Map()
  const context = { source: 'local', cwd: temp, busy: false, permissionMode: 'ask', ssh: undefined }
  let ownerId
  const agentStub = { getAgentBrowserContext(id, owner) {
    if (!id.startsWith('browser-test-') || (owner !== undefined && owner !== ownerId)) throw Error('Unauthorized test agent')
    return context
  } }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const localRequire = name => {
      if (name === './agent/agent-service') return agentStub
      if (name.endsWith('/settings') || name === './settings') return { getSettings: async () => ({ sshProfiles: profile ? [profile] : [] }) }
      if (name.endsWith('?raw')) return fs.readFileSync(path.resolve(path.dirname(file), name.slice(0, -4)), 'utf8')
      if (name.startsWith('.')) {
        let target = path.resolve(path.dirname(file), name)
        if (!path.extname(target)) target += '.ts'
        return load(target)
      }
      return nativeRequire(name)
    }
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    new Function('require', 'module', 'exports', '__filename', '__dirname', code)(localRequire, module, module.exports, file, path.dirname(file))
    return module.exports
  }
  const wait = async (fn) => { for (let i = 0; i < 80; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)) } throw Error('Condition timed out') }
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`
  app.setPath('userData', path.join(temp, 'profile'))
  fs.mkdirSync(path.join(temp, 'downloads'), { recursive: true })
  app.setPath('downloads', path.join(temp, 'downloads'))
  app.whenReady().then(async () => {
    let browser, rfs, fixture, win, siteForward, remoteDirectory
    try {
      browser = load(path.join(root, 'src/main/browser.ts'))
      const bridge = load(path.join(root, 'src/main/browserAgentBridge.ts'))
      rfs = load(path.join(root, 'src/main/remoteFs.ts'))
      const register = () => browser.registerBrowserIpc({ handle: (name, callback) => handlers.set(name, callback) })
      register()
      fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><html><head><title>브라우저 연결 검사</title></head><body style="font:24px sans-serif;padding:32px"><h1>로컬·원격 브라우저 검사</h1><input id="text" aria-label="시험 입력"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#text\').value">확인</button><p id="result">준비</p><a href="/new" target="_blank">새 탭</a></body></html>') })
      await new Promise(r => fixture.listen(0, '127.0.0.1', r))
      const sitePort = fixture.address().port
      win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      ownerId = win.webContents.id
      await win.loadURL('data:text/html,<html><body><h1>Browser backend verification</h1></body></html>')
      win.show()
      const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
      const invoke = (channel, ...args) => handlers.get(`browser:${channel}`)(event, ...args)
      const agentId = `browser-test-${path.basename(temp)}`
      const local = await invoke('open', { agentSessionId: agentId, location: 'local' })
      await invoke('bounds', local.id, { x: 10, y: 100, width: 1100, height: 650 })
      await invoke('command', local.id, { action: 'navigate', url: `http://127.0.0.1:${sitePort}/` })
      await wait(async () => (await invoke('state', local.id)).title === '브라우저 연결 검사')
      const connection = await bridge.getBrowserAgentConnection(agentId)
      const call = async (conn, name, args = {}) => {
        const response = await fetch(conn.url, { method: 'POST', headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        const data = await response.json()
        assert.equal(data.result?.isError, undefined, JSON.stringify(data))
        return JSON.parse(data.result.content[0].text)
      }
      await call(connection, 'browser_type', { selector: '#text', text: '한글 입력 확인' })
      await call(connection, 'browser_click', { selector: '#apply' })
      await wait(async () => /한글 입력 확인/.test((await call(connection, 'browser_read')).text))
      const originalTab = (await invoke('state', local.id)).activeTabId
      await assert.rejects(invoke('command', local.id, { action: 'switch_tab', tabId: 'missing-tab' }))
      const afterCommandError = await invoke('open', { agentSessionId: agentId, location: 'local' })
      assert.equal(afterCommandError.activeTabId, originalTab, 'reconnect after an operation error must retain local tabs')
      assert.match((await call(connection, 'browser_read')).text, /한글 입력 확인/, 'operation errors must retain form and page state')
      const localFrame = await invoke('frame', local.id, 'saver')
      assert.match(localFrame.dataUrl, /^data:image\/jpeg;base64,/)
      assert.ok(localFrame.width > 0)
      assert.equal(localFrame.state.traffic.receivedBytes, 0)
      await invoke('command', local.id, { action: 'new_tab', url: `http://127.0.0.1:${sitePort}/new` })
      let localTabs = await invoke('state', local.id)
      assert.equal(localTabs.tabs.length, 2)
      await invoke('command', local.id, { action: 'close_tab', tabId: localTabs.activeTabId })
      await wait(async () => (await invoke('state', local.id)).tabs.length === 1)
      const remaining = (await invoke('state', local.id)).activeTabId
      const retainedView = win.contentView.children.find(view => String(view.webContents?.id) === remaining)
      await retainedView.webContents.executeJavaScript('window.onbeforeunload = () => false; true', true)
      await invoke('command', local.id, { action: 'close_tab', tabId: remaining })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(win.contentView.children.includes(retainedView), 'a prevented tab close must keep its native view attached')
      assert.equal((await invoke('state', local.id)).activeTabId, remaining)
      await retainedView.webContents.executeJavaScript('window.onbeforeunload = null')
      await assert.rejects(invoke('command', local.id, { action: 'navigate', url: 'file:///etc/passwd' }))
      assert.throws(() => handlers.get('browser:state')({ ...event, senderFrame: {} }, local.id), /앱 화면/)
      await invoke('bounds', local.id, null)
      await call(connection, 'browser_type', { selector: '#text', text: ' 숨긴 뒤에도' })
      await call(connection, 'browser_click', { selector: '#apply' })
      await wait(async () => /숨긴 뒤에도/.test((await call(connection, 'browser_read')).text))
      if (profile) {
        context.source = 'ssh'; context.ssh = profile
        const reverse = await bridge.getBrowserAgentConnection(agentId)
        const remoteRead = `import urllib.request,json\nr=urllib.request.Request(${JSON.stringify(reverse.url.replace('/mcp', '/state'))},headers={'Authorization':${JSON.stringify('Bearer ' + reverse.token)}})\nprint(json.load(urllib.request.urlopen(r))['title'])`
        assert.match(await rfs.rfsBrowserExec(profile.id, `python3 -c ${quote(remoteRead)}`), /브라우저 연결 검사/)
        console.log('local browser: remote-agent loopback access passed')
      }
      await invoke('close', local.id)
      context.source = 'local'
      const moved = await invoke('open', { agentSessionId: agentId, location: 'local' })
      const movedConnection = await bridge.getBrowserAgentConnection(agentId)
      const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await other.loadURL('about:blank')
      ownerId = other.webContents.id
      const otherEvent = { sender: other.webContents, senderFrame: other.webContents.mainFrame }
      assert.equal((await handlers.get('browser:open')(otherEvent, { agentSessionId: agentId, location: 'local' })).id, moved.id)
      const closed = new Promise(resolve => other.once('closed', resolve)); other.destroy(); await closed
      assert.throws(() => handlers.get('browser:state')(otherEvent, moved.id))
      await assert.rejects(fetch(movedConnection.url, { headers: { Authorization: `Bearer ${movedConnection.token}` }, signal: AbortSignal.timeout(1000) }), 'new owner closing must terminate the local server')
      ownerId = win.webContents.id
      console.log('local browser: native view, Korean input, click/read, tabs, URL/owner boundaries passed')
      if (profile) {
        context.source = 'ssh'; context.ssh = profile
        siteForward = await rfs.rfsForwardLocalPort(profile.id, sitePort)
        const remote = await invoke('open', { agentSessionId: agentId, location: 'remote', profileId: profile.id })
        remoteDirectory = path.posix.dirname(remote.downloadPath)
        await invoke('command', remote.id, { action: 'navigate', url: `http://127.0.0.1:${siteForward.port}/` })
        await wait(async () => (await invoke('state', remote.id)).title === '브라우저 연결 검사')
        const first = await invoke('frame', remote.id, 'saver')
        assert.match(first.dataUrl, /^data:image\/jpeg;base64,/)
        assert.ok(first.state.traffic.receivedBytes > 0 && first.state.traffic.sentBytes > 0)
        const second = await invoke('frame', remote.id, 'saver', first.etag)
        assert.equal(second.dataUrl, undefined, 'unchanged image is not retransmitted')
        const firstConnection = await bridge.getBrowserAgentConnection(agentId)
        browser.disposeBrowsers()
        register()
        const resumed = await invoke('open', { agentSessionId: agentId, location: 'remote', profileId: profile.id })
        assert.equal(resumed.url, first.state.url, 'server browser survives detached app connection')
        const secondConnection = await bridge.getBrowserAgentConnection(agentId)
        assert.equal(firstConnection.url, secondConnection.url, 'daemon port is retained')
        assert.equal(firstConnection.token, secondConnection.token, 'daemon identity is retained')
        console.log(JSON.stringify({ remoteBrowser: 'passed', firstFrameBytes: Buffer.from(first.dataUrl.split(',')[1], 'base64').length, measuredReceivedBytes: first.state.traffic.receivedBytes, measuredSentBytes: first.state.traffic.sentBytes, unchangedFrameBytes: 0, reconnectPreserved: true }))
        await invoke('close', resumed.id)
      }
      browser.disposeBrowsers()
      siteForward?.close()
      if (remoteDirectory && /\/.legal-terminal\/browsers\/[a-f0-9]{32}$/.test(remoteDirectory)) await rfs.rfsBrowserExec(profile.id, `python3 -c ${quote(`import shutil,time\ntime.sleep(1)\nshutil.rmtree(${JSON.stringify(remoteDirectory)},ignore_errors=True)`)}`)
      rfs.disposeRemote()
      fixture.closeAllConnections(); fixture.close(); win.destroy()
      app.exit(0)
    } catch (error) {
      console.error(error)
      try { browser?.disposeBrowsers(); siteForward?.close(); rfs?.disposeRemote(); fixture?.close(); win?.destroy() } catch {}
      app.exit(1)
    }
  })
}

const entry = path.join(temp, 'test.cjs')
await fs.writeFile(entry, `(${run.toString()})(${JSON.stringify({ root, temp, profile })})`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', data => { output += data; process.stdout.write(data) })
child.stderr.on('data', data => { if (!/CoreText|WARNING:|ERROR:.*(gpu|network_service)/.test(String(data))) process.stderr.write(data) })
const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
const code = await new Promise(resolve => child.once('exit', resolve)); clearTimeout(timer)
assert.equal(code, 0, `browser backend verification failed; files: ${temp}`)
await fs.rm(temp, { recursive: true, force: true })
