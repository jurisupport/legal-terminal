// Optional installed Claude/Codex protocol smoke; only localhost tools, never a model turn.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { configureProjectAgent, acquireProjectMcp, releaseProjectMcp, disposeProjectMcp } from '../src/main/projectAgent.ts'
import { PROJECT_MCP, PROJECT_MCP_ENV, claudeProjectServers, codexProjectConfig, projectMcpToken } from '../src/main/agent/projectMcpConfig.ts'

const root = await mkdtemp(join(tmpdir(), 'lt-project-native-')), folder = join(root, 'sources')
await mkdir(folder)
let project = { id: 'native-project', name: 'Native test', goal: 'Read linked data', notes: '', nextAction: '', status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', cases: [], folders: [{ path: folder, name: 'Evidence' }] }
let approved = false, mode = 'ask', approvals = 0, writes = 0
configureProjectAgent({ workspaceRoot: join(root, 'workspace'), store: {
  list: async () => [project], save: async value => { writes++; project = { ...value, updatedAt: new Date().toISOString() }; return project }
}, changed() {}, pairings: async () => ({}), realpath: async path => path, list: async () => [], stat: async () => ({ isDir: true, size: 0 }), readBytes: async () => Buffer.from(''), officeText: () => '', caseDetails: async () => ({}) })
const connection = await acquireProjectMcp('native-protocol', project.id, {
  canWrite: () => !['plan', 'dontAsk'].includes(mode),
  approveWrite: async () => { approvals++; return mode === 'bypassPermissions' || approved }
})
const token = projectMcpToken(connection), config = codexProjectConfig(connection, mode)
assert.equal(JSON.stringify(config).includes(token), false)
const proc = spawn('codex', ['-c', 'mcp_servers={}', 'app-server'], { cwd: root, env: { ...process.env, [PROJECT_MCP_ENV]: token }, stdio: ['pipe', 'pipe', 'pipe'] })
let seq = 0, buffer = '', threadId
const pending = new Map(), protocol = []
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject }); proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
})
proc.stdout.on('data', chunk => {
  buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()
  for (const line of lines) {
    const message = JSON.parse(line); protocol.push(message)
    const callback = pending.get(message.id)
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result) }
  }
})
proc.stderr.resume()
const abortController = new AbortController()
let claude, claudeChild
const timer = setTimeout(() => { for (const p of pending.values()) p.reject(new Error('native protocol timeout')); proc.kill(); abortController.abort(); claude?.close(); claudeChild?.kill() }, 55000)
try {
  await rpc('initialize', { clientInfo: { name: 'project_native_check', version: '1' }, capabilities: { experimentalApi: true } })
  proc.stdin.write('{"method":"initialized"}\n')
  const started = await rpc('thread/start', { cwd: root, config, ephemeral: false, approvalPolicy: 'on-request', sandbox: 'read-only' })
  threadId = started.thread.id
  const status = await rpc('mcpServerStatus/list', { threadId, limit: 100, detail: 'toolsAndAuthOnly' })
  assert.ok(JSON.stringify(status).includes('project_context'))
  const call = async (tool, args = {}) => rpc('mcpServer/tool/call', { threadId, server: PROJECT_MCP, tool, arguments: args })
  const contextResult = await call('project_context')
  const context = JSON.parse(contextResult.content.find(item => item.type === 'text').text)
  const note = () => ({ note: 'Native note check', expectedUpdatedAt: project.updatedAt, sources: [{ sourceId: context.sources[0].id }] })
  await call('project_record_note', note()); assert.equal(writes, 0); assert.equal(approvals, 1)
  approved = true
  await call('project_record_note', note()); assert.equal(writes, 1); assert.equal(approvals, 2)
  mode = 'plan'
  await call('project_record_note', note()); assert.equal(writes, 1); assert.equal(approvals, 2, 'server must deny plan before approval')
  for (mode of ['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']) {
    const next = await rpc('thread/start', { cwd: root, config: codexProjectConfig(connection, mode), ephemeral: true, approvalPolicy: ['bypassPermissions', 'dontAsk'].includes(mode) ? 'never' : 'on-request', sandbox: 'read-only' })
    assert.ok(next.thread.id)
  }
  let rollout = ''
  for (let i = 0; i < 15; i++) { try { rollout = await readFile(started.thread.path, 'utf8'); break } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 100)) } }
  assert.equal(rollout.includes(token), false)
  assert.equal(JSON.stringify(protocol).includes(token), false)
  const persistedSecrets = execFileSync('python3', ['-c', `import sys,json,mmap\nfrom pathlib import Path\nneedle=json.load(sys.stdin).encode();root=Path.home()/'.codex'\nhits=[]\nfor p in [root/'config.toml',*root.glob('*.sqlite*')]:\n if p.is_file() and p.stat().st_size:\n  with p.open('rb') as f:\n   with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as data:\n    if data.find(needle)>=0:hits.append(p.name)\nprint(json.dumps(hits))`], { input: JSON.stringify(token), encoding: 'utf8' })
  assert.deepEqual(JSON.parse(persistedSecrets), [], 'bearer must not be persisted in Codex config or thread-history databases')
  await rpc('thread/archive', { threadId }).catch(() => {})
  proc.kill()

  mode = 'ask'
  const captured = [], stdin = []
  const env = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-no-model-key', ANTHROPIC_BASE_URL: new URL(connection.url).origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  for (const key of ['CLAUDECODE', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', PROJECT_MCP_ENV]) delete env[key]
  claude = query({
    prompt: (async function* () { await new Promise(resolve => abortController.signal.addEventListener('abort', resolve, { once: true })) })(),
    options: { cwd: root, abortController, settingSources: [], persistSession: false, tools: [], env,
      spawnClaudeCodeProcess(options) {
        captured.push({ args: options.args, env: options.env })
        claudeChild = spawn(options.command, options.args, { cwd: root, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })
        const write = claudeChild.stdin.write.bind(claudeChild.stdin)
        claudeChild.stdin.write = (chunk, ...args) => { stdin.push(String(chunk)); return write(chunk, ...args) }
        claudeChild.stderr.resume(); return claudeChild
      }
    }
  })
  await claude.initializationResult()
  const configured = await claude.setMcpServers(claudeProjectServers(connection, 'ask'))
  assert.deepEqual(configured.errors, {})
  let connected
  for (let i = 0; i < 50; i++) {
    connected = (await claude.mcpServerStatus()).find(item => item.name === PROJECT_MCP)
    if (connected?.status !== 'pending') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(connected?.status, 'connected')
  assert.ok(connected.tools.some(tool => tool.name === 'project_record_note'))
  assert.equal(JSON.stringify(captured).includes(token), false)
  assert.ok(stdin.some(line => line.includes('mcp_set_servers') && line.includes(token)))
  assert.equal(stdin.some(line => /"type"\s*:\s*"user"/.test(line)), false)
  releaseProjectMcp('native-protocol')
  const revoked = await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal(revoked.status, 403)
  console.log('Installed Claude/Codex project MCP: actual localhost tools, one app approval per write, plan deny, all mode configs accepted, credential-free thread/argv, connected before prompt and token revocation passed; zero model turns')
} finally {
  clearTimeout(timer); proc.kill(); abortController.abort(); claude?.close(); claudeChild?.kill()
  await disposeProjectMcp(); await rm(root, { recursive: true, force: true })
}
