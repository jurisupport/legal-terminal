import { Marked, type Tokens } from 'marked'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export const LOOSE_STRONG_RE = /(^|[^\\*])(\*\*(?=\S)((?:(?!\*\*)[^\n])*?\S)\*\*)(?=[\p{L}\p{N}_])/gu
export const LOOSE_OPEN_STRONG_RE =
  /(^|<br\s*\/?>|\n)(\*\*(\d+\.\s+(?:(?!\*\*|<br\s*\/?>)[^\n])*?\S))(?=<br\s*\/?>|\n|$)/giu

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
    },
    {
      name: 'looseOpenStrong',
      level: 'inline',
      start(src) {
        return src.indexOf('**')
      },
      tokenizer(src) {
        const match = /^\*\*(\d+\.\s+(?:(?!\*\*|<br\s*\/?>)[^\n])*?\S)(?=<br\s*\/?>|\n|$)/iu.exec(src)
        if (!match) return undefined
        return {
          type: 'looseOpenStrong',
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

export function completeMarkdownSyntaxTree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length) ?? syntaxTree(state)
}
