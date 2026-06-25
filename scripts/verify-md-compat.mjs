import assert from 'node:assert/strict'
import {
  LOOSE_STRONG_RE,
  parseInlineMarkdown,
  parseMarkdown
} from '../src/renderer/src/editor/markdownCompat.ts'

assert.equal(parseInlineMarkdown('**" "**에서'), '<strong>&quot; &quot;</strong>에서')
assert.equal(parseInlineMarkdown('**위탁(§26)**에'), '<strong>위탁(§26)</strong>에')
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

console.log('md compat ok')
