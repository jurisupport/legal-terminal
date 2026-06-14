import assert from 'node:assert/strict'

import { createHwpxFromMarkdown } from '../src/main/hwpxExport.ts'
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
