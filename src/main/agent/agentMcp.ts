import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AgentPermissionMode } from './agent-types'

export const MANAGED_MCP = 'legal_terminal_jurisupport'
export const MANAGED_MCP_ENV = 'LEGAL_TERMINAL_JURISUPPORT_TOKEN'
export const MANAGED_MCP_URL = 'https://api.jurisupport.com/mcp'
export const MCP_READ_TOOLS = new Set(['list_upcoming_hearings', 'list_task_assignees', 'list_tasks', 'get_task', 'get_task_evidence_suggestions', 'get_case', 'list_cases', 'get_case_closure_preview', 'get_dashboard', 'list_documents', 'get_document', 'list_legal_documents', 'get_legal_document', 'list_case_progresses', 'list_hearings', 'get_hearing', 'list_hearing_notes', 'list_case_evidence', 'list_case_instances', 'list_case_relations', 'list_document_versions', 'get_document_version'])
export const MCP_WRITE_TOOLS = new Set(['create_task', 'create_task_from_source', 'update_task', 'update_task_from_source', 'update_task_status', 'delete_task', 'update_case', 'update_case_status'])
export interface ManagedMcpConnection { token: string; epoch: number; tools: string[] }

export function managedToolName(name: string): string | null {
  const prefix = `mcp__${MANAGED_MCP}__`
  if (name.startsWith(prefix)) return name.slice(prefix.length)
  if (name.startsWith(`${MANAGED_MCP}.`)) return name.slice(MANAGED_MCP.length + 1)
  return null
}
export function managedToolDecision(name: string, mode: AgentPermissionMode): 'allow' | 'ask' | 'deny' | null {
  const tool = managedToolName(name)
  if (!tool) return null
  if (MCP_READ_TOOLS.has(tool)) return 'allow'
  if (!MCP_WRITE_TOOLS.has(tool) || (mode === 'plan' || mode === 'dontAsk')) return 'deny'
  return mode === 'bypassPermissions' ? 'allow' : 'ask'
}
export function claudeManagedServers(connection: ManagedMcpConnection, mode: AgentPermissionMode): Record<string, McpHttpServerConfig> {
  return { [MANAGED_MCP]: {
    type: 'http', url: MANAGED_MCP_URL, headers: { Authorization: `Bearer ${connection.token}` },
    tools: connection.tools.map((name) => {
      const decision = managedToolDecision(`mcp__${MANAGED_MCP}__${name}`, mode)
      return { name, permission_policy: decision === 'deny' ? 'always_deny' : decision === 'allow' ? 'always_allow' : 'always_ask', org_max_permission: decision === 'deny' ? 'blocked' : decision === 'ask' ? 'ask' : 'allow' }
    })
  } }
}
/** Tokens remain process-local: Codex persists per-thread config, even without a model turn. */
export function codexManagedConfig(connection: ManagedMcpConnection, mode: AgentPermissionMode): Record<string, unknown> {
  const enabledTools = connection.tools.filter((name) => MCP_READ_TOOLS.has(name) || (mode !== 'plan' && mode !== 'dontAsk' && MCP_WRITE_TOOLS.has(name)))
  return {
    [`mcp_servers.${MANAGED_MCP}`]: {
        url: MANAGED_MCP_URL, bearer_token_env_var: MANAGED_MCP_ENV,
        enabled_tools: enabledTools, required: true,
        default_tools_approval_mode: mode === 'ask' || mode === 'acceptEdits' ? 'prompt' : 'auto',
        tools: Object.fromEntries(enabledTools.map((name) => [name, { approval_mode: MCP_READ_TOOLS.has(name) || mode === 'bypassPermissions' ? 'auto' : 'prompt' }]))
    },
    'shell_environment_policy.set': { [MANAGED_MCP_ENV]: '' }
  }
}
export function redactManagedSecrets<T>(value: T, secrets: Iterable<string>): T {
  const values = [...secrets].filter(Boolean)
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') {
      for (const secret of values) item = (item as string).split(secret).join('[JuriSupport token redacted]')
      return (item as string).replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    }
    if (Array.isArray(item)) return item.map(redact)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, /^(authorization|access_token|refresh_token|bearer_token|http_headers|headers)$/i.test(key) ? '[redacted]' : redact(v)]))
    return item
  }
  return redact(value) as T
}

export function managedDisallowedTools(connection: ManagedMcpConnection, mode: AgentPermissionMode): string[] {
  return connection.tools.filter((name) => managedToolDecision(`mcp__${MANAGED_MCP}__${name}`, mode) === 'deny').map((name) => `mcp__${MANAGED_MCP}__${name}`)
}

export function managedMcpApproval(params: Record<string, unknown>, threadId?: string): { name: string; input: Record<string, unknown>; title?: string; description?: string } | null {
  const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const meta = object(params._meta)
  const schema = object(params.requestedSchema)
  const properties = object(schema?.properties)
  const input = object(meta?.tool_params)
  if (params.serverName !== MANAGED_MCP || !threadId || params.threadId !== threadId || params.mode !== 'form' ||
      meta?.codex_approval_kind !== 'mcp_tool_call' || typeof meta.tool_name !== 'string' || !input ||
      schema?.type !== 'object' || !properties || Object.keys(properties).length ||
      (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))) return null
  return {
    name: `mcp__${MANAGED_MCP}__${meta.tool_name}`, input,
    title: typeof meta.tool_title === 'string' ? meta.tool_title : 'JuriSupport 변경 승인',
    description: typeof meta.tool_description === 'string' ? meta.tool_description : typeof params.message === 'string' ? params.message : undefined
  }
}
