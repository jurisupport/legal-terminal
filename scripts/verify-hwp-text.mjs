import assert from 'node:assert/strict'

import { createHwpxFromMarkdown } from '../src/main/hwpxExport.ts'
import { mdToPrintHtml } from '../src/renderer/src/editor/mdExport.ts'
import {
  extractHwpDocumentMarkdown,
  extractHwpDocumentText,
  extractHwpMarkdown,
  extractHwpText
} from '../src/main/hwpText.ts'

const hwpx = createHwpxFromMarkdown(
  ['# 제목', '', '본문입니다.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
  '검증'
)

assert.match(extractHwpText(hwpx, '.hwpx'), /제목/)
assert.match(extractHwpText(hwpx, '.hwpx'), /본문입니다/)
assert.match(extractHwpMarkdown(hwpx, '.hwpx'), /\| A \| B \|/)

const centered = [
  '<!-- lt-align:center -->',
  '## 신청취지',
  '',
  '본문 **강조**',
  '<!-- /lt-align -->'
].join('\n')
assert.match(mdToPrintHtml(centered), /<div class="lt-align-center">[\s\S]*<h2>신청취지<\/h2>/)
assert.match(createHwpxFromMarkdown(centered).toString('utf8'), /horizontal="CENTER"/)

const spaced = '  앞  중간  뒤  '
assert.match(mdToPrintHtml(spaced), /white-space: break-spaces/)
assert.doesNotMatch(mdToPrintHtml('| A | B |\\n| --- | --- |\\n| 1 | 2 |'), /page-break-inside:\s*avoid/)
assert.match(createHwpxFromMarkdown(spaced).toString('utf8'), /<hp:t xml:space="preserve">  앞  중간  뒤  <\/hp:t>/)

const legacyDoc = {
  sections: [
    {
      content: [
        {
          content: [
            { type: 0, value: '첫 줄' },
            { type: 0, value: 10 },
            { type: 0, value: '둘째 줄' },
            { type: 1, value: 9 },
            { type: 0, value: '탭 뒤' }
          ],
          controls: []
        }
      ]
    }
  ]
}

assert.equal(extractHwpDocumentText(legacyDoc), '첫 줄\n둘째 줄\t탭 뒤')
assert.equal(extractHwpDocumentMarkdown(legacyDoc), '첫 줄\n둘째 줄\t탭 뒤')

console.log('HWP/HWPX text extraction verified')
