import { exec } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { load, JSON_SCHEMA } from 'js-yaml'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { BoardAgent, BoardTask } from '../shared/workBoard'
import { prepareBoardRemoteClaude } from './agent/boardRemoteClaude'
import { cleanEnv, packagedClaudeAgentSdkExecutable } from './agent/agent-service'
import { isRemote, rfsBoardAgentSources, rfsBoardApprovedCommand, rfsList, rfsMkdir, rfsRealpath, rfsWriteText } from './remoteFs'
import { readWorkspaceDocument } from './projectAgent'
import { boardFileTools, boardPermission, boardRelativePath, readBoardPolicy } from './workBoardPolicy'

async function localAgentSources(): Promise<string[]> {
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'agents')
  const sources: string[] = []
  const entries = await readdir(directory, { withFileTypes: true }).catch(err => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    sources.push(await readFile(join(directory, entry.name), 'utf8'))
  }
  return sources
}

async function definitions(workspace: string): Promise<Map<string, BoardAgent & { prompt: string }>> {
  const sources = isRemote(workspace) ? await rfsBoardAgentSources(workspace) : await localAgentSources()
  const result = new Map<string, BoardAgent & { prompt: string }>()
  for (const text of sources) {
    const parts = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
    if (!parts) continue
    let data: Partial<BoardAgent> | null
    try { data = load(parts[1], { schema: JSON_SCHEMA }) as Partial<BoardAgent> | null }
    catch { continue }
    if (!data || typeof data.name !== 'string' || !/^[\p{L}\d_-]{1,100}$/u.test(data.name) || !parts[2].trim()) continue
    if (result.has(data.name)) throw new Error('중복된 에이전트 이름: ' + data.name)
    result.set(data.name, { name: data.name, description: String(data.description ?? ''), prompt: parts[2] })
  }
  return result
}

export async function listBoardAgents(workspace = ''): Promise<BoardAgent[]> {
  return [...(await definitions(workspace)).values()].map(({ name, description }) => ({ name, description }))
}

export interface BoardRunInput {
  task: BoardTask
  phase: 'work' | 'review' | 'execute'
  prompt: string
  approvedTools: string[]
  /** Bound to the account and scope authorized by the local board dispatcher. */
  readTodos?: () => Promise<string>
  withOwnership?: <T>(effect: () => Promise<T>) => Promise<T>
  resume?: string
  policyDir: string
  signal: AbortSignal
  onProgress(message: string, sessionId?: string): void
}

export async function runBoardAgent(input: BoardRunInput) {
  const { task, phase, signal, onProgress } = input
  signal.throwIfAborted()
  if (phase === 'work' && input.readTodos) {
    onProgress('앱의 할 일 목록 조회 · ' + (task.agent ? '지정 담당 ' + task.agent : '기본 담당'))
    try {
      const text = await input.readTodos()
      signal.throwIfAborted()
      if (typeof text !== 'string' || !text.trim()) throw new Error('조회 결과를 받지 못했습니다. 앱의 할 일 연결을 확인한 뒤 다시 시도하세요.')
      onProgress('앱의 할 일 조회 결과로 보고서 작성')
      return { text }
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error && error.message.trim() ? error.message : '앱의 할 일 연결을 확인한 뒤 다시 시도하세요.'
      onProgress('앱의 할 일 조회 중단')
      return { blocked: true, text: '## 할 일 조회 확인 필요\n\n' + reason }
    }
  }
  const policy = await readBoardPolicy(input.policyDir)
  const name = phase === 'review' ? task.review_agent : task.agent
  const agent = name ? (await definitions(task.cwd)).get(name) : undefined
  if (name && !agent) throw new Error('등록된 담당 에이전트를 찾지 못했습니다: ' + name)
  const remote = isRemote(task.cwd)
  const canonical = remote ? rfsRealpath : realpath
  const root = await canonical(task.cwd)
  const separator = remote ? '/' : sep
  const prefix = root.endsWith(separator) ? root : root + separator
  const target = async (path: string) => {
    const resolved = await canonical(path ? prefix + boardRelativePath(path) : root)
    if (resolved !== root && !resolved.startsWith(prefix)) throw new Error('작업 폴더 밖의 자료입니다.')
    return resolved
  }
  const grants = new Set(phase === 'execute' ? input.approvedTools : [])
  const notes = new Set<string>()
  const failedActions = new Set<string>()
  const outputs: string[] = []
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const blocked = (reason: string) => {
    notes.add(reason)
    onProgress('결재 필요 · ' + reason)
    controller.abort()
    throw new Error('결재 필요 · ' + reason)
  }
  const guarded = (toolName: string, command?: string) => {
    signal.throwIfAborted()
    controller.signal.throwIfAborted()
    if (!boardPermission(toolName, command, [...grants], policy)) blocked(toolName === 'Bash' ? 'Bash(' + command + ')' : toolName)
  }
  const reply = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
  const withOwnership = async <T>(effect: () => Promise<T>): Promise<T> => {
    if (!input.withOwnership) return effect()
    let entered = false
    try {
      return await input.withOwnership(() => {
        controller.signal.throwIfAborted()
        entered = true
        return effect()
      })
    } catch (error) {
      if (!entered) return blocked('배분 권한을 확인하지 못해 실행을 중단했습니다.')
      throw error
    }
  }
  const files = [
    tool('case_list', '작업 폴더 아래의 파일 목록을 조회합니다.', { path: z.string().default('') }, async ({ path }) => {
      guarded('case_list')
      const directory = await target(path)
      const entries = remote ? await rfsList(directory, { prefetch: false, followSymlinks: false })
        : (await readdir(directory, { withFileTypes: true })).filter(e => !e.isSymbolicLink()).map(e => ({ name: e.name, isDir: e.isDirectory() }))
      onProgress('폴더 조회 · ' + (path || '.'))
      return reply(entries.filter(e => !e.name.startsWith('.')).slice(0, 500).map(e => e.name + (e.isDir ? '/' : '')).join('\n'))
    }),
    tool('case_read', '작업 폴더의 문서를 읽습니다. 상대 경로를 입력하세요.', { path: z.string().min(1) }, async ({ path }) => {
      guarded('case_read')
      const document = await readWorkspaceDocument(await target(path))
      onProgress('파일 읽음 · ' + path)
      return reply(document.text + (document.truncated ? '\n[일부 생략]' : ''))
    }),
    tool('case_draft', '_업무산출물 폴더에 새 Markdown 또는 텍스트 초안을 저장합니다.', {
      name: z.string().regex(/^[\p{L}\p{N} _-]{1,80}\.(md|txt)$/u), text: z.string().max(500000)
    }, ({ name, text }) => withOwnership(async () => {
      guarded('case_draft')
      if (phase === 'review') blocked('검토 세션의 초안 작성')
      const directory = prefix + '_업무산출물'
      if (remote) await rfsMkdir(root, '_업무산출물').catch(async err => {
        if ((await rfsRealpath(directory).catch(() => '')) !== directory) throw err
      })
      else await mkdir(directory, { recursive: true })
      if (await canonical(directory) !== directory) throw new Error('산출물 폴더가 다른 경로에 연결되어 있습니다.')
      const path = directory + separator + task.id + '-' + name
      controller.signal.throwIfAborted()
      if (remote) await rfsWriteText(path, text, null)
      else await writeFile(path, text, { flag: 'wx', mode: 0o600 })
      outputs.push(path)
      onProgress('파일 작성 · ' + path)
      return reply(path)
    })),
    tool('request_action', 'Bash 또는 외부 MCP 도구를 요청합니다. 종류에 정확한 도구 이름을 입력하세요. 사용자 입력이 필요하면 AskUserQuestion과 question을 지정하세요.', {
      name: z.string().max(200), args: z.record(z.string(), z.unknown())
    }, async ({ name, args }) => {
      if (name === 'AskUserQuestion') blocked(String(args.question || '사용자 답변 필요').slice(0, 1000))
      const command = typeof args.command === 'string' ? args.command : undefined
      guarded(name, command)
      return withOwnership(async () => {
        controller.signal.throwIfAborted()
        const grant = name === 'Bash' ? `Bash(${command})` : name
        if (!grants.delete(grant)) blocked(grant)
        onProgress('승인된 실행 · ' + name)
        failedActions.add(grant)
        if (name === 'Bash' && command) {
          if (remote) {
            const output = await rfsBoardApprovedCommand(root, command, controller.signal)
            failedActions.delete(grant)
            return reply(output)
          }
          const result = await promisify(exec)(command, { cwd: root, env: cleanEnv(), timeout: 60000, signal: controller.signal, maxBuffer: 1024 * 1024 })
          failedActions.delete(grant)
          return reply(result.stdout + result.stderr)
        }
        const parts = /^mcp__([a-zA-Z0-9_-]+?)__([a-zA-Z0-9_-]+)$/.exec(name)
        const server = parts && Object.hasOwn(policy.mcpServers, parts[1]) ? policy.mcpServers[parts[1]] : undefined
        if (!parts || !server) return blocked('도구 서버 미등록 · ' + name)
        const client = new Client({ name: 'legal-terminal-board', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers, redirect: 'error', signal: controller.signal } }))
          const result = await client.callTool({ name: parts[2], arguments: args }, undefined, { signal: controller.signal, timeout: 60000 })
          if (result.isError) throw new Error('승인된 도구에서 오류를 반환했습니다.')
          failedActions.delete(grant)
          return reply(JSON.stringify(result.content).slice(0, 50000))
        } finally { await client.close() }
      })
    })
  ]
  const sandbox = join(input.policyDir, 'sessions')
  await mkdir(sandbox, { recursive: true, mode: 0o700 })
  const tools = [...boardFileTools, 'request_action'].map(n => 'mcp__board__' + n)
  const binding = join(sandbox, task.id + '-' + phase + '.session')
  const sessionBinding = (id: string) => remote ? 'ssh:' + id : id
  if (input.resume && (await readFile(binding, 'utf8').catch(() => '')) !== sessionBinding(input.resume)) {
    throw new Error(remote ? '이전 세션을 이 SSH 서버와 연결할 수 없습니다. 기존 로컬 실행 기록을 확인한 뒤 ‘다시 대기열에 넣기’를 선택하세요.' : '이 업무에 연결된 세션을 확인할 수 없습니다.')
  }
  let remoteFailure: Error | undefined
  const transport = remote ? await prepareBoardRemoteClaude(root, error => { remoteFailure = error }) : {}

  let result = ''
  let sessionId = ''
  const summaries = new Set<string>()
  const reviewFormat = phase === 'review' ? '\n검토 근거를 적고 맨 마지막 줄에 REVIEW: PASS 또는 REVIEW: REJECT를 쓰세요.' : ''
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const session = query({
      prompt: '다음 업무지시를 수행하고 최종 답변을 Markdown으로 작성하세요. 파일 경로는 case_list/read의 상대 경로를 사용하세요. 외부 작업 또는 사용자 답변이 필요하면 request_action을 호출하세요.\n' +
        input.prompt + reviewFormat + (phase === 'execute' ? '\n이 지시에 승인된 도구 목록: ' + JSON.stringify([...grants]) : ''),
      options: {
        ...transport, cwd: sandbox, env: cleanEnv(), pathToClaudeCodeExecutable: packagedClaudeAgentSdkExecutable(),
        abortController: controller, resume: input.resume,
        ...(agent ? { agent: agent.name, agents: { [agent.name]: { description: agent.description || agent.name, prompt: agent.prompt } } } : {}),
        tools: [], skills: [], plugins: [], settingSources: [], strictMcpConfig: true,
        managedSettings: { disableAllHooks: true }, agentProgressSummaries: true,
        settings: { disableAllHooks: true, disableSkillShellExecution: true, disableBundledSkills: true, autoMemoryEnabled: false }, maxTurns: 40,
        mcpServers: { board: createSdkMcpServer({ name: 'board', tools: files }) },
        permissionMode: 'default',
        canUseTool: async name => tools.includes(name) ? { behavior: 'allow' } : blocked(name),
        onUserDialog: async req => blocked('사용자 응답 필요 · ' + req.dialogKind)
      }
    })
    try {
      for await (const message of session) {
        if ('session_id' in message && message.session_id && message.session_id !== sessionId) {
          sessionId = message.session_id
          await writeFile(binding, sessionBinding(sessionId), { mode: 0o600 })
          onProgress((remote ? 'SSH 서버에서 세션 시작 · ' : '세션 시작 · ') + (name || '기본 에이전트'), sessionId)
        }
        const summary = (message.type === 'tool_use_summary' ? message.summary
          : message.type === 'system' && message.subtype === 'task_progress' ? message.summary || message.description : '')?.slice(0, 500)
        if (summary && summaries.size < 100 && !summaries.has(summary)) {
          summaries.add(summary)
          onProgress(summary)
        }
        if (remote && message.type === 'assistant' && (message.error === 'authentication_failed' || message.error === 'oauth_org_not_allowed')) {
          throw new Error('SSH 서버의 Claude 인증을 확인하세요. 서버에서 claude auth login 후 다시 시도하세요.')
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') throw new Error(message.errors.join('\n') || message.subtype)
          if (message.is_error) throw new Error(message.result)
          result = message.result
        }
      }
    } finally { session.close() }
  } catch (error) {
    if (!notes.size || signal.aborted) {
      if (remoteFailure && !signal.aborted) throw remoteFailure
      if (remote && error instanceof Error && /not logged in|authentication (?:failed|required)|invalid .*api.?key|please run .*login/i.test(error.message)) {
        throw new Error('SSH 서버의 Claude 인증을 확인하세요. 서버에서 claude auth login 후 다시 시도하세요.')
      }
      throw error
    }
  } finally { signal.removeEventListener('abort', cancel) }
  await rm(binding, { force: true })
  for (const action of failedActions) notes.add('실행 결과 확인 필요 · ' + action)
  if (notes.size) return { text: [result, ...outputs.map(p => '산출물 · ' + p), '## 결재 필요', ...notes].filter(Boolean).join('\n\n'), blocked: true }
  if (!result.trim()) throw new Error('에이전트가 보고서를 반환하지 않았습니다.')
  const verdict = phase === 'review' ? /(?:^|\n)REVIEW: (PASS|REJECT)\s*$/.exec(result) : null
  if (phase === 'review' && !verdict) throw new Error('검토 결과에서 승인 또는 반려 판정을 확인하지 못했습니다.')
  return { text: [result, ...outputs.map(p => '산출물 · ' + p)].join('\n'), rejected: verdict?.[1] === 'REJECT' }
}
