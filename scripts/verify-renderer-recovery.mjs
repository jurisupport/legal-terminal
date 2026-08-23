import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('renderer recovery check skipped: macOS only')
  process.exit(0)
}

const execFileAsync = promisify(execFile)
const electronPath = createRequire(import.meta.url)('electron')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = await fs.readFile(path.join(repo, 'src/main/index.ts'), 'utf8')
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-terminal-renderer-recovery-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

assert.match(
  mainSource,
  /webContents\.on\('render-process-gone'[\s\S]*?rendererRecoveryRequested[\s\S]*?reload\(\)/,
  'a requested renderer recovery must reload after the crash event'
)
assert.match(mainSource, /webContents\.on\('unresponsive'[\s\S]*?forcefullyCrashRenderer\(\)/)
assert.match(mainSource, /role: 'reload', label: '화면 다시 불러오기'/)

const electron = spawn(
  electronPath,
  [`--user-data-dir=${userData}`, repo],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
)
let output = ''
electron.stdout.on('data', (data) => (output += data))
electron.stderr.on('data', (data) => (output += data))

const rendererPids = async () => {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  return stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[2]) === electron.pid && match[3].includes('--type=renderer'))
    .map((match) => Number(match[1]))
}

const waitForRenderer = async (excluded = 0) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pid = (await rendererPids()).find((candidate) => candidate !== excluded)
    if (pid) return pid
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`renderer recovery timed out\n${output}`)
}

try {
  const before = await waitForRenderer()
  process.kill(before, 'SIGKILL')
  const after = await waitForRenderer(before)

  assert.notEqual(after, before)
  assert.equal(electron.exitCode, null)
  assert.match(output, /\[renderer\] process gone: killed/)
  console.log('renderer crash reloads the legal-terminal window')
} finally {
  electron.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => electron.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ])
  if (electron.exitCode === null) electron.kill('SIGKILL')
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}
