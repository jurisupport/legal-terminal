export interface JsonRpcEnvelope {
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

export function parseRpc(text: string): JsonRpcEnvelope | null {
  const candidates = text
    .split(/\r?\n\r?\n/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim()
    )
    .filter(Boolean)

  if (candidates.length === 0) candidates.push(text.trim())

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i])
      if (parsed && typeof parsed === 'object') return parsed as JsonRpcEnvelope
    } catch {
      // Keep walking backwards; SSE streams can contain non-result events.
    }
  }

  return null
}
