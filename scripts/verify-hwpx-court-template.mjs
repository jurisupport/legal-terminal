// 법원제출문서 표준 서식(샘플서면.hwpx 기반) hwpx 내보내기 검증:
// 용지 설정, 제목/개요 스타일 매핑, 사무실 정보 푸터(표·로고·별도 푸터 텍스트), XML 정합성.
import assert from 'node:assert/strict'

import { createHwpxFromMarkdown } from '../src/main/hwpxExport.ts'
import { imageInfo } from '../src/main/imageSize.ts'

// 1×1 투명 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

function sectionOf(buf) {
  const s = buf.toString('utf8')
  const i = s.indexOf('<hs:sec')
  const j = s.indexOf('</hs:sec>')
  assert.ok(i >= 0 && j > i, 'section0.xml 누락')
  return s.slice(i, j + 9)
}

// 단순 well-formed 검사 — 태그 스택 균형 확인 (선언·주석·자기닫힘 제외)
function assertBalanced(xml, label) {
  const stack = []
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    if (m[2].startsWith('?') || m[2].startsWith('!')) continue
    if (m[4] === '/' || /\/\s*$/.test(m[3])) continue
    if (m[1] === '/') {
      assert.equal(stack.pop(), m[2], `${label}: </${m[2]}> 짝 불일치`)
    } else {
      stack.push(m[2])
    }
  }
  assert.equal(stack.length, 0, `${label}: 닫히지 않은 태그 ${stack.join(',')}`)
}

const md = [
  '# 준비서면',
  '',
  '## 1. 기초사실',
  '',
  '본문 문단입니다.',
  '',
  '### 가. 세부 주장',
  '',
  '<!-- lt-align:right -->',
  '2026. 7. 8.',
  '<!-- /lt-align -->'
].join('\n')

// ── 1) 표준 서식 기본 구조 ──
const plain = createHwpxFromMarkdown(md, '준비서면')
const plainXml = plain.toString('utf8')
const section = sectionOf(plain)
assertBalanced(section, 'section0')

// A4 용지·여백 (샘플서면 표준)
assert.match(section, /<hp:pagePr landscape="WIDELY" width="59528" height="84188"/)
assert.match(section, /<hp:margin header="4251" footer="7086" gutter="0" left="7086" right="7086" top="5669" bottom="4251"\/>/)
assert.equal(section.match(/<hp:secPr /g).length, 1, 'secPr는 첫 문단에 1회')

// 표준 글꼴 스타일(휴먼명조/휴먼고딕)과 정렬용 paraPr가 header에 존재
assert.match(plainXml, /휴먼명조/)
assert.match(plainXml, /휴먼고딕/)
assert.match(plainXml, /<hh:paraPr id="21"[^>]*>.*?horizontal="RIGHT"/s)

// 제목: 자간 띄운 "준 비 서 면", 제목 스타일(charPr 12/paraPr 5)
assert.match(section, /paraPrIDRef="5" styleIDRef="1"[^>]*>.*?<hp:t[^>]*>준 비 서 면<\/hp:t>/s)
// "## 1. ..." → 번호 형식이 우선이라 개요 1수준(styleIDRef 2), 마커는 제거
assert.match(section, /styleIDRef="2"[^>]*>[\s\S]*?<hp:t[^>]*>기초사실<\/hp:t>/)
// "### 가. ..." → 개요 2수준(styleIDRef 3)
assert.match(section, /styleIDRef="3"[^>]*>[\s\S]*?<hp:t[^>]*>세부 주장<\/hp:t>/)
// 줄바꿈으로 이어진 문단(사건/원고/피고 블록)은 들여쓰기 없는 paraPr 6
assert.match(
  sectionOf(createHwpxFromMarkdown(['사    건    2024나0000', '원    고    강00', '피    고    이00'].join('\n'), '검증')),
  /paraPrIDRef="6"[^>]*>[\s\S]*?<hp:t>사    건    2024나0000<hp:lineBreak\/>원    고    강00<hp:lineBreak\/>피    고    이00<\/hp:t>/
)
// 날짜 줄 + 서명 줄이 한 문단 두 줄로 살아남아야 한다 (marked 순서목록 오파싱 방지)
assert.match(
  sectionOf(createHwpxFromMarkdown(['2026. 7. 8.', '피고의 소송대리인 변호사 하희봉'].join('\n'), '검증')),
  /<hp:t>2026\. 7\. 8\.<hp:lineBreak\/>피고의 소송대리인 변호사 하희봉<\/hp:t>/
)
// "…귀중" 줄은 샘플 수신 법원 원형(paraPr 6·charPr 14, 왼쪽 정렬)
assert.match(
  sectionOf(createHwpxFromMarkdown('서울중앙지방법원 제0민사부 귀중', '검증')),
  /paraPrIDRef="6"[^>]*>[\s\S]*?charPrIDRef="14"[\s\S]*?<hp:t>서울중앙지방법원 제0민사부 귀중<\/hp:t>/
)
// lt-align:right → paraPr 21
assert.match(section, /paraPrIDRef="21"[^>]*>[\s\S]*?2026\. 7\. 8\./)
// 사무실 정보가 없으면 푸터는 쪽번호만
assert.match(section, /numType="TOTAL_PAGE"/)
assert.doesNotMatch(section, /전화:/)

// ── 2) 사무실 정보 푸터(표 + 로고) ──
const office = {
  officeName: '법무법인 검증',
  phone: '02-000-0000',
  fax: '02-111-1111',
  email: 'test@example.com',
  address: '서울 서초구 서초대로 1',
  logo: { data: PNG_1PX, mime: 'image/png', ...imageInfo(PNG_1PX) }
}
assert.equal(imageInfo(PNG_1PX)?.width, 1)
const withOffice = createHwpxFromMarkdown(md, '준비서면', office)
const officeSection = sectionOf(withOffice)
assertBalanced(officeSection, 'section0(office)')
const officeXml = withOffice.toString('utf8')

assert.match(officeSection, /법무법인 검증/)
assert.match(officeSection, /전화: 02-000-0000  팩스: 02-111-1111/)
assert.match(officeSection, /이메일: test@example\.com/)
assert.match(officeSection, /서울 서초구 서초대로 1/)
assert.match(officeSection, /binaryItemIDRef="logo"/)
assert.match(officeXml, /BinData\/logo\.png/)
assert.match(officeXml, /<opf:item id="logo" href="BinData\/logo\.png" media-type="image\/png" isEmbeded="1"\/>/)
// 본문 표가 아닌 푸터 표: 4행 2열
assert.match(officeSection, /rowCnt="4" colCnt="2"/)
// placeholder가 남아 있으면 안 된다
assert.doesNotMatch(officeSection, /\[전화번호\]|\[팩스번호\]|\[이메일\]|\[주소\]|\[법무법인/)

// ── 3) 별도 푸터 텍스트가 있으면 표 대신 텍스트 ──
const withFooterText = createHwpxFromMarkdown(md, '준비서면', {
  ...office,
  footerText: '법무법인 검증 | 서울 서초구 | 02-000-0000'
})
const footerTextSection = sectionOf(withFooterText)
assertBalanced(footerTextSection, 'section0(footerText)')
assert.match(footerTextSection, /법무법인 검증 \| 서울 서초구 \| 02-000-0000/)
assert.doesNotMatch(footerTextSection, /rowCnt="4" colCnt="2"/)

// ── 4) 첫 블록이 표여도 secPr·푸터가 붙는다 ──
const tableFirst = createHwpxFromMarkdown(
  ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
  '표',
  office
)
const tableSection = sectionOf(tableFirst)
assertBalanced(tableSection, 'section0(table-first)')
assert.equal(tableSection.match(/<hp:secPr /g).length, 1)
assert.match(tableSection, /전화: 02-000-0000/)
// 본문 표는 표준 실선 테두리(borderFill 4)
assert.match(tableSection, /rowCnt="2" colCnt="2" cellSpacing="0" borderFillIDRef="4"/)

console.log('HWPX 법원제출문서 표준 서식 검증 완료')
