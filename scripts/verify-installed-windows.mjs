// Run only on a disposable GitHub Windows runner: NSIS writes uninstall/shortcut registration.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'Installed-app verification requires Windows')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable GitHub-hosted runner')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-terminal-installed-'))
const installDir = path.join(temp, 'app')
const executable = path.join(installDir, 'legal-terminal.exe')
const profile = path.join(temp, 'profile')
const evidenceDir = path.join(root, '.omx/screenshots')
const ruleName = `legal-terminal-smoke-${randomUUID()}`
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
const pause = () => new Promise(resolve => setTimeout(resolve, 100))
const psQuote = value => `'${value.replaceAll("'", "''")}'`
const powershell = source => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${source}`], { encoding: 'utf8', timeout: 30000 })
let child, socket, firewallAdded = false, output = ''
try {
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidenceDir, { recursive: true })
  // The assisted NSIS installer does not launch the app silently without --force-run.
  execFileSync(path.join(root, 'dist/legal-terminal-Setup.exe'), ['/S', '/currentuser', `/D=${installDir}`], { windowsVerbatimArguments: true, timeout: 120000 })
  await fs.access(executable)
  const dismissedSkillHash = {}
  const skills = path.join(installDir, 'resources/skills')
  for (const name of await fs.readdir(skills)) {
    if (name.startsWith('.')) continue
    dismissedSkillHash[`local:${name}`] = createHash('sha256').update(await fs.readFile(path.join(skills, name, 'SKILL.md'))).digest('hex')
  }
  const sentinel = randomUUID()
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ dismissedSkillHash, notifyDone: false, ignoredUpdateVersion: sentinel }))
  // Block this binary's outbound traffic, including its native Node HTTPS update check.
  powershell(`New-NetFirewallRule -DisplayName ${psQuote(ruleName)} -Direction Outbound -Program ${psQuote(executable)} -Action Block -Profile Any | Out-Null`)
  firewallAdded = true
  const env = { ...process.env, USERPROFILE: path.join(temp, 'home'), APPDATA: path.join(temp, 'roaming'), LOCALAPPDATA: path.join(temp, 'local') }
  for (const directory of [env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true })
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let processError
  child.on('error', error => { processError = error })
  const wait = async (check, label) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (processError) throw processError
      assert.equal(child.exitCode, null, `App exited before ${label}: ${output}`)
      const value = await check()
      if (value) return value
      await pause()
    }
    throw Error(`Timed out: ${label}\n${output}`)
  }
  const port = await wait(async () => {
    try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }, 'isolated Chromium debugging port')
  const page = await wait(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return pages.find(page => page.type === 'page' && page.url.startsWith('file:'))
  }, 'packaged renderer')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map(), rendererErrors = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') rendererErrors.push(message.params.args)
    const response = pending.get(message.id)
    if (response) { pending.delete(message.id); clearTimeout(response.timer); message.error ? response.reject(Error(JSON.stringify(message.error))) : response.resolve(message.result) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await wait(() => evaluate(`!!window.lt && !!document.querySelector('.welcome') && !!document.querySelector('.workspace-todo-header')`), 'real welcome and task header')
  const info = await evaluate('window.lt.app.info()')
  assert.equal(info.version, version)
  assert.equal(info.platform, 'win32')
  assert.ok(info.versions.electron)
  assert.equal(await evaluate('window.lt.settings.get().then(s => s.ignoredUpdateVersion)'), sentinel, '--user-data-dir must select the seeded isolated settings')
  assert.equal(await evaluate('window.lt.js.hasToken()'), false, 'No real account is connected')
  const state = await evaluate('window.lt.caseManagement.get()')
  assert.equal(state.ok, true)
  const updated = await evaluate(`window.lt.caseManagement.update(${JSON.stringify({ generation: state.state.generation, revision: state.state.revision, patch: { focus: { date: '2026-10-01', taskIds: [] } } })})`)
  assert.equal(updated.ok, true)
  assert.equal(updated.state.revision, state.state.revision + 1)
  const persisted = JSON.parse(await fs.readFile(path.join(profile, 'config.json'), 'utf8'))
  assert.equal(persisted.caseManagementState.revision, updated.state.revision, 'Packaged preload/main persists to isolated profile')
  assert.deepEqual(rendererErrors, [])
  await fs.writeFile(path.join(evidenceDir, 'installed-windows.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  const result = { version, platform: info.platform, electron: info.versions.electron, nsisSilentInstall: true, packagedRenderer: true, isolatedPersistence: true, networkBlocked: true, rendererErrors }
  await fs.writeFile(path.join(evidenceDir, 'installed-windows.json'), JSON.stringify(result, null, 2))
  console.log('INSTALLED_WINDOWS_RESULT ' + JSON.stringify(result))
} finally {
  socket?.close()
  if (child?.pid && child.exitCode === null) {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' })
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  }
  if (firewallAdded) powershell(`Remove-NetFirewallRule -DisplayName ${psQuote(ruleName)}`)
  await fs.writeFile(path.join(evidenceDir, 'installed-windows.log'), output).catch(() => {})
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
