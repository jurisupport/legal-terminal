export interface RemoteControlConnection {
  id: string
  label: string
  url: string
}

export interface ClaudeRemoteControlApi {
  open(input: { id: string; url: string }): Promise<void>
  bounds(id: string, bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>
  close(id: string): Promise<void>
}

export function normalizeClaudeRemoteControlUrl(value: unknown): string {
  const message = 'Claude 공식 리모트 컨트롤 주소(https://claude.ai/code/…)를 입력해 주세요.'
  if (typeof value !== 'string' || value.length > 4096) throw new Error(message)
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error(message) }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password ||
      (url.pathname !== '/code' && !url.pathname.startsWith('/code/'))) throw new Error(message)
  return url.href
}
