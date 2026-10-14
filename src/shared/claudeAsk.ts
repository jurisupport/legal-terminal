export interface ClaudeSelectionSource {
  docId?: string
  docPath?: string
  docTitle?: string
  text?: string
  range?: {
    startLine?: number
    startColumn?: number
    endLine?: number
    endColumn?: number
    startPage?: number
    endPage?: number
  }
}

export interface ClaudeAskOptions {
  docPath?: string | null
  sourcePath?: string
  sourceTitle?: string
  instruction?: string
  sourceLabel?: string
  selectionSource?: ClaudeSelectionSource
  agentQuoteMessageId?: string
}

export interface SendClaudeOptions {
  displayText?: string
  contextPath?: string
  pasteOnly?: boolean
  selection?: ClaudeAskOptions
}
