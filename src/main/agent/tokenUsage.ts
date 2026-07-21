export interface TranscriptTokenUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
  lastTurnTokens?: number
  updatedAt: number
}

interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function breakdown(value: unknown): TokenBreakdown | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const inputTokens = number(usage.input_tokens) || number(usage.inputTokens)
  const outputTokens = number(usage.output_tokens) || number(usage.outputTokens)
  const cacheCreationInputTokens =
    number(usage.cache_creation_input_tokens) || number(usage.cacheCreationInputTokens)
  const cacheReadInputTokens = number(usage.cache_read_input_tokens) || number(usage.cacheReadInputTokens)
  const totalTokens = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
  return totalTokens > 0
    ? { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, totalTokens }
    : undefined
}

function hasUserText(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const item = record(block)
      return item?.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0
    })
  )
}

export function tokenUsageFromTranscript(content: string, updatedAt = Date.now()): TranscriptTokenUsage | undefined {
  const messages = new Map<string, TokenBreakdown & { turn: number }>()
  const users = new Set<string>()
  let turn = 0
  let lineIndex = 0

  for (const line of content.split('\n')) {
    lineIndex += 1
    if (!line.includes('{')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message = record(entry.message)
    if (!message) continue
    if (message.role === 'user' && hasUserText(message.content)) {
      const id = typeof entry.uuid === 'string' ? entry.uuid : `user-${lineIndex}`
      if (!users.has(id)) {
        users.add(id)
        turn += 1
      }
      continue
    }
    if (message.role !== 'assistant') continue
    const usage = breakdown(message.usage)
    if (!usage) continue
    const id =
      typeof message.id === 'string'
        ? message.id
        : typeof entry.requestId === 'string'
          ? entry.requestId
          : typeof entry.uuid === 'string'
            ? entry.uuid
            : `assistant-${lineIndex}`
    messages.set(id, { ...usage, turn })
  }

  if (messages.size === 0) return undefined
  const totals = [...messages.values()].reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + usage.cacheReadInputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0 }
  )
  const lastTurn = Math.max(...[...messages.values()].map((usage) => usage.turn))
  const lastTurnTokens = [...messages.values()]
    .filter((usage) => usage.turn === lastTurn)
    .reduce((sum, usage) => sum + usage.totalTokens, 0)
  return { turns: users.size, ...totals, lastTurnTokens, updatedAt }
}
