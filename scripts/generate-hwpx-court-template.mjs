// 샘플서면.hwpx(법원제출문서 표준 서식)에서 스타일과 문단 원형을 추출해
// src/main/hwpxCourtTemplate.ts 를 생성한다.
//
//   node scripts/generate-hwpx-court-template.mjs [샘플.hwpx 경로]
//
// 추출 내용:
//  - header.xml 전체(글꼴·문단·개요 스타일) + 정렬용 paraPr(20~23) 추가
//  - section0.xml의 문단 원형들: 제목(용지 설정·푸터 포함), 본문, 개요 1~6수준, 그림
//    → 내보내기는 이 원형의 텍스트만 바꿔 넣는다 (한글이 쓴 XML 구조를 그대로 유지).
//    줄배치(linesegarray)는 뷰어가 재계산하므로 제거한다.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const samplePath =
  process.argv[2] ??
  '/Users/haheebong/Library/CloudStorage/OneDrive-개인/쥬리서포트/legal terminal/샘플서면.hwpx'

// 최상위 <hp:p>...</hp:p> 블록 분리 (푸터·셀 안의 중첩 문단은 상위에 포함)
function topLevelParagraphs(xml) {
  const paras = []
  let depth = 0
  let start = -1
  const re = /<hp:p[ >]|<\/hp:p>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith('<hp:p')) {
      if (depth === 0) start = m.index
      depth += 1
    } else {
      depth -= 1
      if (depth === 0) paras.push(xml.slice(start, re.lastIndex))
    }
  }
  return paras
}

const tmp = mkdtempSync(join(tmpdir(), 'hwpx-template-'))
try {
  execFileSync('unzip', [
    '-o',
    '-q',
    samplePath,
    'Contents/header.xml',
    'Contents/section0.xml',
    'Contents/content.hpf',
    'version.xml',
    'settings.xml',
    'META-INF/container.xml',
    'META-INF/manifest.xml',
    'META-INF/container.rdf',
    '-d',
    tmp
  ])
  let header = readFileSync(join(tmp, 'Contents/header.xml'), 'utf8')
  const rawSection = readFileSync(join(tmp, 'Contents/section0.xml'), 'utf8')

  // 패키징 메타데이터 — 윈도 정품 한글은 이 파일들에 훨씬 까다로워 샘플 그대로 쓴다.
  const versionXml = readFileSync(join(tmp, 'version.xml'), 'utf8')
  const settingsXml = readFileSync(join(tmp, 'settings.xml'), 'utf8')
  const containerXml = readFileSync(join(tmp, 'META-INF/container.xml'), 'utf8')
  const manifestXml = readFileSync(join(tmp, 'META-INF/manifest.xml'), 'utf8')
  const containerRdf = readFileSync(join(tmp, 'META-INF/container.rdf'), 'utf8')
  const contentHpf = readFileSync(join(tmp, 'Contents/content.hpf'), 'utf8')
  const IMAGE1_ITEM = '<opf:item id="image1" href="BinData/image1.PNG" media-type="image/png" isEmbeded="1"/>'
  if (!contentHpf.includes(IMAGE1_ITEM)) throw new Error('content.hpf에서 image1 항목을 찾지 못했습니다.')
  if (!contentHpf.includes('<opf:title/>')) throw new Error('content.hpf에서 opf:title 자리를 찾지 못했습니다.')

  // 정렬용 문단 모양 추가:
  //  20/21 — 본문(paraPr 6: 앞뒤 여백, 줄간격 250%) 복제, lt-align center/right용
  //  22/23 — 표 셀(paraPr 0: 여백 없음, 줄간격 160%) 복제, 셀 가운데/오른쪽 정렬용
  const clone = (src, id, align) => {
    const base = header.match(new RegExp(`<hh:paraPr id="${src}".*?</hh:paraPr>`, 's'))?.[0]
    if (!base) throw new Error(`paraPr id=${src} 를 찾지 못했습니다.`)
    if (!base.includes('horizontal="JUSTIFY"')) throw new Error(`paraPr ${src} 정렬이 JUSTIFY가 아닙니다.`)
    return base.replace(`id="${src}"`, `id="${id}"`).replace('horizontal="JUSTIFY"', `horizontal="${align}"`)
  }
  const extras = [clone(6, 20, 'CENTER'), clone(6, 21, 'RIGHT'), clone(0, 22, 'CENTER'), clone(0, 23, 'RIGHT')]
  const paraCnt = header.match(/<hh:paraProperties itemCnt="(\d+)">/)
  if (!paraCnt) throw new Error('paraProperties itemCnt 를 찾지 못했습니다.')
  header = header
    .replace(paraCnt[0], `<hh:paraProperties itemCnt="${Number(paraCnt[1]) + extras.length}">`)
    .replace('</hh:paraProperties>', `${extras.join('')}</hh:paraProperties>`)

  // 푸터 9pt 글자 모양 추가:
  //  20 — 연락처용(charPr 9: 휴먼고딕 12pt 일반) 복제 후 9pt
  //  21 — 상호용(charPr 10: 휴먼고딕 12pt 굵게) 복제 후 9pt
  const cloneChar = (src, id) => {
    const base = header.match(new RegExp(`<hh:charPr id="${src}" .*?</hh:charPr>`, 's'))?.[0]
    if (!base) throw new Error(`charPr id=${src} 를 찾지 못했습니다.`)
    if (!base.includes('height="1200"')) throw new Error(`charPr ${src} 크기가 12pt가 아닙니다.`)
    return base.replace(`id="${src}"`, `id="${id}"`).replace('height="1200"', 'height="900"')
  }
  const charExtras = [cloneChar(9, 20), cloneChar(10, 21)]
  const charCnt = header.match(/<hh:charProperties itemCnt="(\d+)">/)
  if (!charCnt) throw new Error('charProperties itemCnt 를 찾지 못했습니다.')
  header = header
    .replace(charCnt[0], `<hh:charProperties itemCnt="${Number(charCnt[1]) + charExtras.length}">`)
    .replace('</hh:charProperties>', `${charExtras.join('')}</hh:charProperties>`)

  // 줄배치 정보 제거 — 텍스트를 바꿔 넣으면 어차피 맞지 않고, 없으면 재계산된다.
  const section = rawSection.replace(/<hp:linesegarray>.*?<\/hp:linesegarray>/gs, '')

  const prolog = section.match(/^<\?xml[^>]*\?>/)?.[0]
  const secOpen = section.match(/<hs:sec[^>]*>/)?.[0]
  if (!prolog || !secOpen) throw new Error('section0 프롤로그/루트를 찾지 못했습니다.')

  const paras = topLevelParagraphs(section)
  const need = (pred, label) => {
    const p = paras.find(pred)
    if (!p) throw new Error(`${label} 원형 문단을 찾지 못했습니다.`)
    return p
  }
  const titlePara = paras[0]
  for (const required of [
    '<hp:secPr ',
    '<hp:footer ',
    '<hp:t>준 비 서 면</hp:t>',
    '[법무법인/법률사무소 상호/로고]',
    '전화: [전화번호]  팩스: [팩스번호]',
    '이메일: [이메일]',
    '[주소]'
  ]) {
    if (!titlePara.includes(required)) throw new Error(`제목 문단에 ${required} 가 없습니다.`)
  }
  const bodyPara = need((p) => p.includes('위 사건에 관하여'), '본문')
  const bodyText = bodyPara.match(/<hp:t>([^<]*)<\/hp:t>/)?.[1]
  if (!bodyText) throw new Error('본문 원형 텍스트를 찾지 못했습니다.')
  const outlines = [1, 2, 3, 4, 5, 6].map((n) =>
    need((p) => p.includes(`<hp:t>제${n}수준</hp:t>`), `개요${n}`)
  )
  const picPara = need((p) => p.includes('<hp:pic '), '그림')
  const pic = picPara.match(/<hp:pic [\s\S]*?<\/hp:pic>/)?.[0]
  if (!pic) throw new Error('그림 원형을 찾지 못했습니다.')
  const courtPara = need((p) => p.includes('귀중</hp:t>'), '귀중(수신 법원)')
  const courtText = courtPara.match(/<hp:t>([^<]*귀중)<\/hp:t>/)?.[1]
  if (!courtText) throw new Error('귀중 원형 텍스트를 찾지 못했습니다.')
  // 사건표시 블록(사   건 / 원   고 / 피   고) — 들여쓰기 없는 휴먼고딕 문단
  const casePara = need((p) => /<hp:t>사\s+건/.test(p), '사건표시')
  const caseT = casePara.match(/<hp:t>[\s\S]*?<\/hp:t>/)?.[0]
  if (!caseT) throw new Error('사건표시 원형 텍스트를 찾지 못했습니다.')

  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  const lit = (s) => `\`${esc(s)}\``
  const out = [
    '// 자동 생성 파일 — 직접 수정하지 말 것.',
    '// 원본: 샘플서면.hwpx (법원제출문서 표준 서식)',
    '// 재생성: node scripts/generate-hwpx-court-template.mjs [샘플 경로]',
    '',
    '/** 표준 서식 header.xml 전체 (글꼴·문단·개요 스타일 + 정렬용 paraPr 20~23) */',
    `export const COURT_HEADER_XML = ${lit(header)}`,
    '',
    '/** section0.xml 프롤로그(<?xml ...?>) — 샘플 그대로 */',
    `export const COURT_SECTION_PROLOG = ${lit(prolog)}`,
    '',
    '/** <hs:sec ...> 루트 여는 태그 — 샘플의 네임스페이스 선언 그대로 */',
    `export const COURT_SEC_OPEN = ${lit(secOpen)}`,
    '',
    '/** 제목 문단 원형 — 용지 설정(secPr)·푸터(사무실 정보 표+쪽번호) 포함.',
    ' *  "준 비 서 면"과 푸터의 [상호/로고]·[전화번호]·[팩스번호]·[이메일]·[주소] 자리를 바꿔 쓴다. */',
    `export const COURT_TITLE_PARA = ${lit(titlePara)}`,
    '',
    '/** 본문(바탕글) 문단 원형과 그 안의 교체용 텍스트 */',
    `export const COURT_BODY_PARA = ${lit(bodyPara)}`,
    `export const COURT_BODY_TEXT = ${lit(bodyText)}`,
    '',
    '/** 개요 1~6수준 문단 원형 — "제N수준" 텍스트를 바꿔 쓴다 */',
    `export const COURT_OUTLINE_PARAS = [${outlines.map(lit).join(', ')}]`,
    '',
    '/** 그림(hp:pic) 원형 — 로고 삽입 시 크기·바이너리 참조를 바꿔 쓴다 */',
    `export const COURT_PIC_XML = ${lit(pic)}`,
    '',
    '/** "…법원 귀중" 문단 원형(왼쪽 정렬·휴먼고딕 15pt 굵게)과 교체용 텍스트 */',
    `export const COURT_COURT_PARA = ${lit(courtPara)}`,
    `export const COURT_COURT_TEXT = ${lit(courtText)}`,
    '',
    '/** 사건표시 문단 원형(들여쓰기 없음·휴먼고딕 12pt) — 사건/원고/피고·첨부목록·다줄 블록용.',
    ' *  COURT_CASE_T(hp:t 요소 전체)를 통째로 바꿔 쓴다. */',
    `export const COURT_CASE_PARA = ${lit(casePara)}`,
    `export const COURT_CASE_T = ${lit(caseT)}`,
    '',
    '// ── 패키징 메타데이터 (샘플 그대로 — 윈도 정품 한글이 까다롭게 검사한다) ──',
    `export const COURT_VERSION_XML = ${lit(versionXml)}`,
    `export const COURT_SETTINGS_XML = ${lit(settingsXml)}`,
    `export const COURT_CONTAINER_XML = ${lit(containerXml)}`,
    `export const COURT_MANIFEST_XML = ${lit(manifestXml)}`,
    `export const COURT_CONTAINER_RDF = ${lit(containerRdf)}`,
    '/** content.hpf 원형 — <opf:title/>에 제목, image1 항목 자리에 로고 항목(또는 제거) */',
    `export const COURT_CONTENT_HPF = ${lit(contentHpf)}`,
    `export const COURT_IMAGE1_ITEM = ${lit(IMAGE1_ITEM)}`,
    ''
  ].join('\n')

  const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/main/hwpxCourtTemplate.ts')
  writeFileSync(dest, out, 'utf8')
  console.log(`생성 완료: ${dest} (header ${header.length}B, title ${titlePara.length}B)`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
