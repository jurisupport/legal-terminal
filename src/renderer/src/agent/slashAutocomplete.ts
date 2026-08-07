export interface SlashToken {
  token: string
  start: number
  end: number
}

export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const position = Math.max(0, Math.min(caret, text.length))
  const match = text.slice(0, position).match(/(?:^|\s)(\/[^\s/]*)$/)
  if (!match) return null
  const token = match[1]
  const rest = text.slice(position).match(/^[^\s]*/)?.[0] ?? ''
  return { token: token.toLowerCase(), start: position - token.length, end: position + rest.length }
}

export function replaceSlashToken(
  text: string,
  token: SlashToken,
  command: string
): { text: string; caret: number } {
  const suffix = text.slice(token.end)
  const insert = `${command}${suffix && /^\s/.test(suffix) ? '' : ' '}`
  return {
    text: `${text.slice(0, token.start)}${insert}${suffix}`,
    caret: token.start + insert.length
  }
}
