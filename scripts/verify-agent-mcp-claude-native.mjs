// Optional installed-Claude SDK smoke test: held input, synthetic localhost MCP, no model turn.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeManagedServers, MANAGED_MCP } from '../src/main/agent/agentMcp.ts'
const token = `synthetic-claude-mcp-${Date.now()}`
const calls = [], nonMcpRequests = [], spawnArgs = [], stdin = []
let authorization
const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') { nonMcpRequests.push(req.url); res.writeHead(503); res.end(); return }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
  let body = ''; for await (const chunk of req) body += chunk
  const message = JSON.parse(body); calls.push(message.method); authorization = req.headers.authorization
  if (message.id === undefined) { res.writeHead(202); res.end(); return }
  if (message.method === 'initialize') await new Promise(resolve => setTimeout(resolve, 350))
  const result = message.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-mcp', version: '1' } }
    : message.method === 'tools/list'
      ? { tools: ['list_tasks', 'update_task', 'delete_case'].map(name => ({ name, description: 'Synthetic test tool', inputSchema: { type: 'object', properties: {} } })) }
      : message.method === 'resources/list' ? { resources: [] }
        : message.method === 'prompts/list' ? { prompts: [] } : {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'synthetic-claude-session' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const cwd = await mkdtemp(join(tmpdir(), 'lt-claude-mcp-native-'))
const abortController = new AbortController()
const env = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-key-no-model-call', ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
for (const key of ['CLAUDECODE', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']) delete env[key]
let child
const response = query({
  prompt: (async function* () { await new Promise(resolve => abortController.signal.addEventListener('abort', resolve, { once: true })) })(),
  options: {
    cwd, abortController, strictMcpConfig: true, settingSources: [], persistSession: false, tools: [], permissionMode: 'default', env,
    spawnClaudeCodeProcess(options) {
      spawnArgs.push(options.args)
      assert.equal(JSON.stringify(options.args).includes(token), false)
      assert.equal(JSON.stringify(options.env).includes(token), false)
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk, ...args) => { stdin.push(String(chunk)); return write(chunk, ...args) }
      child.stderr.resume()
      return child
    }
  }
})
const timeout = setTimeout(() => { abortController.abort(); response.close(); child?.kill() }, 25000)
try {
  await response.initializationResult()
  const servers = claudeManagedServers({ token, epoch: 1, tools: ['list_tasks', 'update_task', 'delete_case'] }, 'ask')
  servers[MANAGED_MCP].url = `${base}/mcp`
  const started = Date.now()
  const configured = await response.setMcpServers(servers)
  assert.deepEqual(configured.errors, {})
  const configuredMs = Date.now() - started
  let status = (await response.mcpServerStatus()).find(item => item.name === MANAGED_MCP)
  const firstStatus = status?.status ?? 'missing'
  const deadline = Date.now() + 10000
  while (status?.status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    status = (await response.mcpServerStatus()).find(item => item.name === MANAGED_MCP)
  }
  assert.equal(status?.status, 'connected')
  assert.equal(authorization, `Bearer ${token}`)
  assert.ok(status.tools.some(tool => tool.name === 'list_tasks'))
  assert.ok(stdin.some(line => line.includes('mcp_set_servers') && line.includes(token)))
  assert.equal(stdin.some(line => /"type"\s*:\s*"user"/.test(line)), false)
  assert.equal(spawnArgs.some(args => args.includes('--mcp-config')), false)
  assert.equal(calls.includes('tools/call'), false)
  assert.equal(nonMcpRequests.some(path => /messages|responses|complete/.test(path)), false)
  console.log(`installed Claude SDK MCP: bearer only in native stdin; policies accepted; setup ${configuredMs} ms; first status ${firstStatus}; connected; zero tool/model calls`)
} finally {
  clearTimeout(timeout); abortController.abort(); response.close(); child?.kill(); server.closeAllConnections(); server.close()
}
