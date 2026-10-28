export interface BrowserAgentConnection {
  url: string
  token: string
  location: 'local' | 'remote'
}

let resolver: ((sessionId: string) => Promise<BrowserAgentConnection | undefined>) | undefined

export function configureBrowserAgentBridge(value: typeof resolver): void { resolver = value }

export async function getBrowserAgentConnection(sessionId: string): Promise<BrowserAgentConnection | undefined> {
  return resolver?.(sessionId)
}

export const BROWSER_MCP = 'legal_terminal_browser'
export const BROWSER_MCP_ENV = 'LEGAL_TERMINAL_BROWSER_TOKEN'
