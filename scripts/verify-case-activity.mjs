import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCaseActivity, buildFolderActivity } from '../src/main/caseActivityData.ts'
import { cleanUserInstruction, daysFromTranscriptContent, mergeWorkLog } from '../src/main/workLogData.ts'

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

const meta = (over) => ({
  sessionId: 's-' + Math.random().toString(36).slice(2, 8),
  cwd: '/drafts/other',
  updatedAt: iso(0),
  ...over
})

// 1) 사건번호 정규화 일치 (공백·대소문자 무시)
{
  const entries = [
    meta({ sessionId: 'a', caseNumber: '2026가단 12345', generatedTitle: '준비서면 초안', mtime: now - 1000 }),
    meta({ sessionId: 'b', caseNumber: '2026가단99999', mtime: now - 2000 })
  ]
  const out = buildCaseActivity(entries, {}, {
    cases: [{ id: 'c1', caseNumber: '2026가단12345', caseName: '대여금' }]
  })
  assert.equal(out.c1.total, 1)
  assert.equal(out.c1.sessions[0].sessionId, 'a')
  assert.equal(out.c1.sessions[0].title, '준비서면 초안')
}

// 2) 사건번호 없는 세션은 pairing cwd로 매칭, pairing 없으면 미표시
{
  const entries = [meta({ sessionId: 'a', cwd: '/drafts/대여금 사건', mtime: now - 1000 })]
  const pairings = { c1: { drafts: '/drafts/대여금 사건' } }
  const matched = buildCaseActivity(entries, pairings, { cases: [{ id: 'c1' }] })
  assert.equal(matched.c1.total, 1)
  const unmatched = buildCaseActivity(entries, {}, { cases: [{ id: 'c1' }] })
  assert.equal(unmatched.c1, undefined)
}

// 3) 같은 폴더 공유: 다른 사건번호가 붙은 세션은 cwd 매칭에서 제외
{
  const entries = [
    meta({ sessionId: 'a', cwd: '/drafts/공유폴더', caseNumber: '2026가단11111', mtime: now - 1000 }),
    meta({ sessionId: 'b', cwd: '/drafts/공유폴더', mtime: now - 2000 })
  ]
  const pairings = { c1: { drafts: '/drafts/공유폴더' }, c2: { drafts: '/drafts/공유폴더' } }
  const out = buildCaseActivity(entries, pairings, {
    cases: [
      { id: 'c1', caseNumber: '2026가단11111' },
      { id: 'c2', caseNumber: '2026가단22222' }
    ]
  })
  assert.equal(out.c1.total, 2) // 번호 일치 + 번호 없는 cwd 매칭
  assert.equal(out.c2.total, 1) // 번호 없는 세션만 (다른 번호 세션 제외)
  assert.equal(out.c2.sessions[0].sessionId, 'b')
}

// 4) 원격 pairing: ssh://profileId/path ↔ meta.profileId + cwd
{
  const entries = [
    meta({ sessionId: 'a', cwd: '/home/u/drafts', profileId: 'office', sshLabel: '사무실', mtime: now - 1000 }),
    meta({ sessionId: 'b', cwd: '/home/u/drafts', profileId: 'home', mtime: now - 2000 })
  ]
  const pairings = { 'remote:office:c1': { drafts: 'ssh://office/home/u/drafts' } }
  const out = buildCaseActivity(entries, pairings, { cases: [{ id: 'c1' }] })
  assert.equal(out.c1.total, 1)
  assert.equal(out.c1.sessions[0].sshLabel, '사무실')
}

// 5) 사건명은 유형명('손해배상(기)' 등)이라 여러 사건이 공유 — 사건명만으로는 매칭하지 않는다
{
  const entries = [
    meta({ sessionId: 'a', cwd: '/drafts/위킵', caseName: '손해배상(기)', mtime: now - 1000 }),
    meta({ sessionId: 'b', cwd: '/drafts/최재혁', caseName: '손해배상(기)', mtime: now - 2000 })
  ]
  const pairings = { c1: { drafts: '/drafts/위킵' } }
  const out = buildCaseActivity(entries, pairings, {
    cases: [{ id: 'c1', caseName: '손해배상(기)' }]
  })
  assert.equal(out.c1.total, 1) // pairing cwd가 일치하는 세션만, 같은 사건명의 남의 세션은 제외
  assert.equal(out.c1.sessions[0].sessionId, 'a')
}

// 6) 정렬(최신순)·limitPerCase·total·workSummary 전달
{
  const entries = [
    meta({ sessionId: 'old', caseNumber: '2026가단1', mtime: now - 30_000 }),
    meta({ sessionId: 'new', caseNumber: '2026가단1', mtime: now - 1000, workSummary: '한 일: 초안 · 다음: 검토' }),
    meta({ sessionId: 'mid', caseNumber: '2026가단1', mtime: now - 10_000 }),
    meta({ sessionId: 'noMtime', caseNumber: '2026가단1', updatedAt: iso(5000), mtime: undefined })
  ]
  const out = buildCaseActivity(entries, {}, {
    cases: [{ id: 'c1', caseNumber: '2026가단1' }],
    limitPerCase: 2
  })
  assert.equal(out.c1.total, 4)
  assert.equal(out.c1.sessions.length, 2)
  assert.deepEqual(out.c1.sessions.map((s) => s.sessionId), ['new', 'noMtime'])
  assert.equal(out.c1.sessions[0].workSummary, '한 일: 초안 · 다음: 검토')
  assert.equal(out.c1.lastActivity, out.c1.sessions[0].mtime)
}

// 7) 제목 폴백: generatedTitle > transcriptTitle > title > folderName
{
  const entries = [meta({ sessionId: 'a', caseNumber: '2026가단1', folderName: '대여금 사건', mtime: now - 1000 })]
  const out = buildCaseActivity(entries, {}, { cases: [{ id: 'c1', caseNumber: '2026가단1' }] })
  assert.equal(out.c1.sessions[0].title, '대여금 사건')
}

// 7b) 오염된 제목(내부 태그)은 건너뛰고 폴더명 폴백
{
  const entries = [
    meta({
      sessionId: 'a',
      caseNumber: '2026가단1',
      transcriptTitle: '<local-command-caveat>Caveat: ...',
      folderName: '사건정리',
      mtime: now - 1000
    })
  ]
  const out = buildCaseActivity(entries, {}, { cases: [{ id: 'c1', caseNumber: '2026가단1' }] })
  assert.equal(out.c1.sessions[0].title, '사건정리')
}

// 8) 트랜스크립트 날짜별 분해: 여러 날 세션은 날짜마다 집계, 사이드체인·메타·caveat 제외
{
  const line = (obj) => JSON.stringify(obj)
  const iso = (msAgo) => new Date(now - msAgo).toISOString()
  const D = 86_400_000
  const content = [
    line({ type: 'queue-operation', timestamp: iso(2 * D) }),
    line({ type: 'user', timestamp: iso(2 * D), cwd: '/drafts/사건A', message: { content: '소장 초안 작성해줘' } }),
    line({ type: 'user', timestamp: iso(2 * D - 3600_000), message: { content: [{ type: 'text', text: '갑1호증 반영해줘' }] } }),
    line({ type: 'user', timestamp: iso(1000), message: { content: '준비서면 보강해줘' } }),
    line({ type: 'user', timestamp: iso(900), isSidechain: true, message: { content: '서브에이전트 지시' } }),
    line({ type: 'user', timestamp: iso(800), isMeta: true, message: { content: '메타' } }),
    line({ type: 'user', timestamp: iso(700), message: { content: '<local-command-caveat>Caveat…' } }),
    line({ type: 'user', timestamp: iso(600), message: { content: '<command-name>/usage</command-name>\n<command-message>usage</command-message>' } }),
    '{깨진 라인'
  ].join('\n')
  const scan = daysFromTranscriptContent(content)
  assert.equal(scan.cwd, '/drafts/사건A')
  assert.equal(scan.days.length, 2)
  assert.equal(scan.days[0].count, 2) // 이틀 전: 지시 2건
  assert.equal(scan.days[0].firstText, '소장 초안 작성해줘')
  assert.equal(scan.days[1].count, 1) // 오늘: 사이드체인·메타·caveat 제외하고 1건
}

assert.equal(cleanUserInstruction('<command-name>/usage</command-name>\n<command-message>usage</command-message>'), undefined)
assert.equal(cleanUserInstruction('<command-name>/review</command-name>\n<command-args>변경분</command-args>'), '/review 변경분')
assert.equal(
  cleanUserInstruction(
    '<legal-terminal-case-context>내부 사건 안내</legal-terminal-case-context>\n\n' +
      '<legal-terminal-user-request>\n첫 줄\n\n- 둘째 줄\n\n[legal-terminal attachments]\n내부 첨부 안내\n</legal-terminal-user-request>',
    true
  ),
  '첫 줄\n\n- 둘째 줄'
)

// 8b) 병합: 스캔된 세션은 날짜별 행, 스캔 안 된 세션은 인덱스 mtime 날짜에 폴백 행
{
  const D = 86_400_000
  const scans = [
    {
      sourceKey: 'local',
      sessions: [
        {
          sessionId: 's1',
          cwd: '/drafts/사건A',
          days: [
            { date: dateKey(now - 2 * D), count: 2, firstText: '소장 초안', lastTs: now - 2 * D },
            { date: dateKey(now), count: 1, firstText: '준비서면 보강', lastTs: now - 1000 }
          ]
        }
      ]
    }
  ]
  const indexEntries = [
    meta({ sessionId: 's1', caseNumber: '2026가단1', generatedTitle: '사건A 서면 작업', workSummary: '한 일: 보강', sourceKey: 'local' }),
    meta({ sessionId: 's2', caseNumber: '2026가단2', mtime: now - D, sourceKey: 'ssh:u@h:22', sshLabel: '사무실' })
  ]
  const log = mergeWorkLog(scans, indexEntries, now, 30)
  assert.equal(log.length, 3) // 오늘(s1) / 어제(s2 폴백) / 이틀 전(s1)
  assert.equal(log[0].items[0].workSummary, '한 일: 보강') // 요약은 마지막 활동 날짜에만
  assert.equal(log[2].items[0].workSummary, undefined)
  assert.equal(log[2].items[0].caseNumber, '2026가단1') // 인덱스 메타로 라벨 보강
  assert.equal(log[1].items[0].sessionId, 's2')
  assert.equal(log[1].items[0].count, 0) // 폴백 행 표식
}
function dateKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 9) 폴더 작업: 사건에 매칭 안 된 세션만 cwd별 그룹, 최신순
{
  const entries = [
    meta({ sessionId: 'case', caseNumber: '2026가단1', mtime: now - 1000 }),
    meta({ sessionId: 'f1a', cwd: '/drafts/법률상담', folderName: '법률상담', mtime: now - 2000 }),
    meta({ sessionId: 'f1b', cwd: '/drafts/법률상담/', folderName: '법률상담', mtime: now - 9000 }),
    meta({ sessionId: 'f2', cwd: '/home/u/메모', profileId: 'office', sshLabel: '사무실', mtime: now - 5000 })
  ]
  const out = buildFolderActivity(entries, {}, { cases: [{ id: 'c1', caseNumber: '2026가단1' }] })
  assert.deepEqual(out.map((f) => f.folderName), ['법률상담', '메모'])
  assert.equal(out[0].total, 2) // 후행 슬래시 정규화로 같은 폴더 병합
  assert.equal(out[1].sshLabel, '사무실')
  assert.ok(!out.flatMap((f) => f.sessions).some((s) => s.sessionId === 'case'))
}

// 10) 스캔 합성 메타(matchByFolder): 심링크 풀린 경로라도 pairing 폴더명 완전일치면 매칭
{
  const pairings = {
    c1: { drafts: '/Users/u/OneDrive/작성서류/SKT' },
    'remote:office:c2': { drafts: 'ssh://office/Users/u/OneDrive/작성서류/지미옥' }
  }
  const entries = [
    // 로컬: 스캔 cwd가 CloudStorage 실경로 — 문자열은 다르지만 폴더명이 같다
    meta({
      sessionId: 'scan1',
      cwd: '/Users/u/Library/CloudStorage/OneDrive-개인/작성서류/SKT',
      matchByFolder: true,
      mtime: now - 1000
    }),
    // 원격: 프로필 일치 + 폴더명 일치
    meta({
      sessionId: 'scan2',
      cwd: '/Users/u/Library/CloudStorage/OneDrive-개인/작성서류/지미옥',
      profileId: 'office',
      matchByFolder: true,
      mtime: now - 2000
    }),
    // matchByFolder 없는 일반 인덱스 항목은 폴더명만 같아선 매칭되지 않는다 (기존 보수적 규칙 유지)
    meta({
      sessionId: 'plain',
      cwd: '/Users/u/Library/CloudStorage/OneDrive-개인/작성서류/SKT',
      mtime: now - 3000
    }),
    // 프로필이 다르면 원격 폴더명이 같아도 제외
    meta({
      sessionId: 'scan3',
      cwd: '/other/지미옥',
      profileId: 'home',
      matchByFolder: true,
      mtime: now - 4000
    })
  ]
  const out = buildCaseActivity(entries, pairings, {
    cases: [{ id: 'c1' }, { id: 'c2' }]
  })
  assert.deepEqual(out.c1.sessions.map((s) => s.sessionId), ['scan1'])
  assert.deepEqual(out.c2.sessions.map((s) => s.sessionId), ['scan2'])
}

// 11) 작업일지의 원격 세션은 로컬 사건 폴더가 아니라 기록된 SSH 프로필·cwd로 복원
{
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const dashboard = readFileSync(
    new URL('../src/renderer/src/dashboard/CasesDashboard.tsx', import.meta.url),
    'utf8'
  )
  const workLog = readFileSync(
    new URL('../src/renderer/src/dashboard/WorkLogView.tsx', import.meta.url),
    'utf8'
  )
  const start = app.indexOf('const resumeCaseSession')
  const end = app.indexOf('const openHearingRecordForCase', start)
  const resume = app.slice(start, end)
  assert.match(resume, /if \(s\.profileId\)/)
  assert.match(resume, /if \(!s\.cwd\)[\s\S]*return/)
  assert.match(resume, /openCaseRemote\(c, profile, s\.cwd\)/)
  assert.match(resume, /openPastSession\([\s\S]*opened\.source[\s\S]*return/)
  assert.doesNotMatch(dashboard, /onResumePath && e\.cwd && !e\.profileId/)
  assert.match(dashboard, /onResumePath\(e\.sessionId, e\.cwd, e\.title, e\.profileId, options\?\.newTab\)/)
  assert.match(workLog, /event\.ctrlKey \|\| event\.metaKey/)
  assert.match(workLog, /onContextMenu=/)
  assert.match(workLog, /새 탭으로 열기/)

  const openStart = app.indexOf('const openPastSession')
  const openEnd = app.indexOf('const addTermSame', openStart)
  const open = app.slice(openStart, openEnd)
  assert.match(open, /forceNew = false/)
  assert.match(open, /const existing = !forceNew/)
  assert.match(open, /t\.resumeSessionId === sessionId/)
}

console.log('case activity ok')
