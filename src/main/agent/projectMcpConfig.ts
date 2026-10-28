import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AgentPermissionMode } from './agent-types'

export const PROJECT_MCP = 'legal_terminal_project'
export const PROJECT_MCP_ENV = 'LEGAL_TERMINAL_PROJECT_TOKEN'
export const PROJECT_READ_TOOLS = ['project_context', 'project_list_files', 'project_read_file', 'project_search', 'project_case_details']
export const PROJECT_WRITE_TOOL = 'project_record_note'
export interface ProjectMcpConnection { url: string; headers: Record<string, string> }

export function projectToolName(name: string): string | null {
  const prefix = `mcp__${PROJECT_MCP}__`
  return name.startsWith(prefix) ? name.slice(prefix.length)
    : name.startsWith(`${PROJECT_MCP}.`) ? name.slice(PROJECT_MCP.length + 1) : null
}

export function projectToolDecision(name: string, mode: AgentPermissionMode): 'allow' | 'ask' | 'deny' | null {
  const tool = projectToolName(name)
  if (!tool) return null
  if (PROJECT_READ_TOOLS.includes(tool)) return 'allow'
  if (tool !== PROJECT_WRITE_TOOL || mode === 'plan' || mode === 'dontAsk') return 'deny'
  return mode === 'bypassPermissions' ? 'allow' : 'ask'
}

export function projectMcpToken(connection: ProjectMcpConnection): string {
  const url = new URL(connection.url)
  const token = connection.headers.Authorization?.match(/^Bearer ([^\s]+)$/)?.[1]
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !token) {
    throw new Error('프로젝트 도구의 로컬 연결 정보를 확인할 수 없습니다.')
  }
  return token
}

export function projectDisallowedTools(mode: AgentPermissionMode): string[] {
  return projectToolDecision(`mcp__${PROJECT_MCP}__${PROJECT_WRITE_TOOL}`, mode) === 'deny'
    ? [`mcp__${PROJECT_MCP}__${PROJECT_WRITE_TOOL}`] : []
}

export function claudeProjectServers(connection: ProjectMcpConnection, mode: AgentPermissionMode): Record<string, McpHttpServerConfig> {
  projectMcpToken(connection)
  return { [PROJECT_MCP]: {
    type: 'http', url: connection.url, headers: connection.headers,
    tools: [...PROJECT_READ_TOOLS, PROJECT_WRITE_TOOL].map(name => {
      const decision = projectToolDecision(`mcp__${PROJECT_MCP}__${name}`, mode)
      // The local server requests the app's existing approval immediately before each write.
      return { name, permission_policy: decision === 'deny' ? 'always_deny' : 'always_allow',
        org_max_permission: decision === 'deny' ? 'blocked' : 'allow' }
    })
  } }
}

/** Codex persists config: credentials belong only to its process, never the thread or child shells. */
export function codexProjectConfig(connection: ProjectMcpConnection, mode: AgentPermissionMode): Record<string, unknown> {
  projectMcpToken(connection)
  const enabled = [...PROJECT_READ_TOOLS, ...(mode === 'plan' || mode === 'dontAsk' ? [] : [PROJECT_WRITE_TOOL])]
  return {
    [`mcp_servers.${PROJECT_MCP}`]: {
      url: connection.url, bearer_token_env_var: PROJECT_MCP_ENV, enabled_tools: enabled, required: true,
      default_tools_approval_mode: 'auto',
      tools: Object.fromEntries(enabled.map(name => [name, { approval_mode: 'auto' }]))
    },
    'shell_environment_policy.set': { [PROJECT_MCP_ENV]: '' }
  }
}
