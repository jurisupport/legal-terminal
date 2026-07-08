import assert from 'node:assert/strict'
import { utils as cfbUtils, write as writeCfb } from 'cfb'

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

// 짧은 순한글 H1은 문서 제목으로 보고 법원서면 표준대로 "제 목"처럼 자간을 띄운다
assert.match(extractHwpText(hwpx, '.hwpx'), /제 목/)
assert.match(extractHwpText(hwpx, '.hwpx'), /본문입니다/)
assert.match(extractHwpMarkdown(hwpx, '.hwpx'), /\| A \| B \|/)

const previewOnlyHwpx = Buffer.from(
  hwpx.toString('binary').replaceAll('Contents/section0.xml', 'Contents/notsect0.xml'),
  'binary'
)
assert.match(extractHwpText(previewOnlyHwpx, '.hwpx'), /본문입니다/)
assert.match(extractHwpMarkdown(previewOnlyHwpx, '.hwpx'), /본문입니다/)

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
assert.match(createHwpxFromMarkdown(spaced).toString('utf8'), /<hp:t>  앞  중간  뒤  <\/hp:t>/)

const cmTable = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '<!-- colw: 2cm,3cm -->'].join('\n')
assert.match(mdToPrintHtml(cmTable), /<table class="fixed" style="width:5cm">/)
assert.match(mdToPrintHtml(cmTable), /<col style="width:2cm"><col style="width:3cm">/)
assert.match(createHwpxFromMarkdown(cmTable).toString('utf8'), /<hp:cellSz width="5670" height="1400"\/>/)
assert.match(createHwpxFromMarkdown(cmTable).toString('utf8'), /<hp:cellSz width="8505" height="1400"\/>/)

const partialCmTable = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '<!-- colw: 2cm -->'].join('\n')
assert.match(mdToPrintHtml(partialCmTable), /<table class="fixed"><colgroup><col style="width:2cm"><col>/)
assert.match(createHwpxFromMarkdown(partialCmTable).toString('utf8'), /<hp:cellSz width="5670" height="1400"\/>/)
assert.match(createHwpxFromMarkdown(partialCmTable).toString('utf8'), /<hp:cellSz width="36850" height="1400"\/>/)

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

const previewOnlyHwp = cfbUtils.cfb_new()
cfbUtils.cfb_add(previewOnlyHwp, 'PrvText', Buffer.from('\ufeffHWP 미리보기 본문', 'utf16le'))
const previewOnlyHwpBytes = Buffer.from(writeCfb(previewOnlyHwp, { type: 'buffer' }))
assert.equal(extractHwpText(previewOnlyHwpBytes, '.hwp'), 'HWP 미리보기 본문')
assert.equal(extractHwpMarkdown(previewOnlyHwpBytes, '.hwp'), 'HWP 미리보기 본문')

console.log('HWP/HWPX text extraction verified')
