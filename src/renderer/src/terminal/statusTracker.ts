export type ClaudeIdleStatus = 'working' | 'done' | 'question'

export const CLAUDE_INPUT_PROMPT_RE = /^\s*(?:[│┃]\s*)?[›>]\s/

const QUESTION_RE =
  /(do you want to|would you like to|continue\?|❯\s*1\.|\b1\.\s*yes\b|\(y\/n\)|\by\/n\b)/i

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

export const isClaudeInputPromptLine = (line: string): boolean => CLAUDE_INPUT_PROMPT_RE.test(line)

export const getClaudeIdleStatus = (recentOutput: string, cursorLine: string): ClaudeIdleStatus => {
  const recent = stripAnsi(recentOutput)
  if (QUESTION_RE.test(recent)) return 'question'
  return isClaudeInputPromptLine(stripAnsi(cursorLine)) ? 'done' : 'working'
}
