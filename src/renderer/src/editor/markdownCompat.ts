import { Marked, type Tokens } from 'marked'

export const LOOSE_STRONG_RE = /(^|[^\\*])(\*\*(?=\S)((?:(?!\*\*)[^\n])*?\S)\*\*)(?=[\p{L}\p{N}_])/gu

const markdown = new Marked({ gfm: true, breaks: true })

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

markdown.use({
  extensions: [
    {
      name: 'del',
      renderer(token: Tokens.Generic) {
        const raw = String(token.raw ?? '')
        if (raw.startsWith('~') && !raw.startsWith('~~')) return escapeHtml(raw)
        return false
      }
    },
    {
      name: 'looseStrong',
      level: 'inline',
      start(src) {
        return src.indexOf('**')
      },
      tokenizer(src) {
        const match = /^\*\*(?=\S)((?:(?!\*\*)[^\n])*?\S)\*\*(?=[\p{L}\p{N}_])/u.exec(src)
        if (!match) return undefined
        return {
          type: 'looseStrong',
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1])
        }
      },
      renderer(token: Tokens.Generic) {
        return `<strong>${this.parser.parseInline(token.tokens ?? [])}</strong>`
      }
    }
  ]
})

export function parseMarkdown(md: string): string {
  return markdown.parse(md) as string
}

export function parseInlineMarkdown(md: string): string {
  return markdown.parseInline(md) as string
}
