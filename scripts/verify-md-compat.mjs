import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import {
  completeMarkdownSyntaxTree,
  LOOSE_OPEN_STRONG_RE,
  LOOSE_STRONG_RE,
  parseInlineMarkdown,
  parseMarkdown
} from '../src/renderer/src/editor/markdownCompat.ts'

assert.equal(parseInlineMarkdown('**" "**에서'), '<strong>&quot; &quot;</strong>에서')
assert.equal(parseInlineMarkdown('**위탁(§26)**에'), '<strong>위탁(§26)</strong>에')
assert.equal(
  parseInlineMarkdown('<br>**1. 수집 시점·맥락별 항목<br>　[회원가입] 이메일'),
  '<br><strong>1. 수집 시점·맥락별 항목</strong><br>　[회원가입] 이메일'
)
assert.equal(parseInlineMarkdown('**" "** 에서'), '<strong>&quot; &quot;</strong> 에서')
assert.equal(parseInlineMarkdown('~2026. 1. 1.~'), '~2026. 1. 1.~')
assert.equal(parseInlineMarkdown('~~삭제~~'), '<del>삭제</del>')
assert.equal(parseInlineMarkdown('\\~삭제\\~'), '~삭제~')
assert.match(parseMarkdown('`**" "**에서`'), /<code>\*\*&quot; &quot;\*\*에서<\/code>/)
assert.match(parseMarkdown('~<b>~'), /~&lt;b&gt;~/)

LOOSE_STRONG_RE.lastIndex = 0
assert.equal(LOOSE_STRONG_RE.exec('**" "**에서')?.[2], '**" "**')
LOOSE_STRONG_RE.lastIndex = 0
assert.equal(LOOSE_STRONG_RE.exec('**위탁(§26)**에')?.[2], '**위탁(§26)**')
LOOSE_OPEN_STRONG_RE.lastIndex = 0
assert.equal(
  LOOSE_OPEN_STRONG_RE.exec('<br>**1. 수집 시점·맥락별 항목<br>')?.[2],
  '**1. 수집 시점·맥락별 항목'
)

const longMarkdown = `${Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n')}

| A | B |
|---|---|
| x | y |`
const longState = EditorState.create({
  doc: longMarkdown,
  extensions: [markdownLanguage({ extensions: GFM })]
})
let foundTrailingTable = false
completeMarkdownSyntaxTree(longState).iterate({
  enter: (node) => {
    if (node.name === 'Table') foundTrailingTable = true
  }
})
assert.equal(foundTrailingTable, true)

console.log('md compat ok')
