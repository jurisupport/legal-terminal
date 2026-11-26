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
  // 정오 기준: 자정 가까이 실행해도 "이틀 전 + 1시간"이 다른 날로 넘어가지 않게 한다.
  const noon = new Date(now).setHours(12, 0, 0, 0)
  const iso = (msAgo) => new Date(noon - msAgo).toISOString()
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
// 8c) 바뀐 파일·마지막 상태·업무 보드 묶음·비용
{
  const line = (obj) => JSON.stringify(obj)
  const noon = new Date(now).setHours(12, 0, 0, 0)
  const iso = (msAgo) => new Date(noon - msAgo).toISOString()
  const D = 86_400_000
  const tool = (name, input) => ({ type: 'tool_use', id: name, name, input })
  const content = [
    line({ type: 'user', timestamp: iso(D), cwd: '/drafts/사건A', message: { content: '감정서 정리해줘' } }),
    line({ type: 'assistant', timestamp: iso(D - 1000), message: { content: [tool('Edit', { file_path: '/drafts/사건A/메모.md' })] } }),
    line({ type: 'user', timestamp: iso(5000), message: { content: '반박 초안 써줘' } }),
    line({ type: 'assistant', timestamp: iso(4000), message: { content: [tool('Write', { file_path: '/drafts/사건A/반박초안.md' }), tool('Read', { file_path: '/drafts/사건A/소장.md' })] } }),
    line({ type: 'assistant', timestamp: iso(3500), message: { content: [tool('Edit', { file_path: '/drafts/사건A/반박초안.md' })] } }),
    line({ type: 'assistant', timestamp: iso(3400), isSidechain: true, message: { content: [tool('Write', { file_path: '/drafts/사건A/sub.md' })] } }),
    line({ type: 'assistant', timestamp: iso(3000), message: { content: [{ type: 'text', text: '작성했습니다.' }] } })
  ].join('\n')
  const scan = daysFromTranscriptContent(content)
  assert.deepEqual(scan.days[0].files, [{ path: '/drafts/사건A/메모.md', kind: 'edit' }])
  // 같은 날 새로 쓴 뒤 고친 파일은 '작성'으로 남고, 읽기 도구·사이드체인은 빠진다.
  assert.deepEqual(scan.days[1].files, [{ path: '/drafts/사건A/반박초안.md', kind: 'write' }])
  assert.equal(scan.days[1].firstTs, noon - 5000)
  assert.equal(scan.days[1].lastTs, noon - 3500)
  assert.deepEqual(scan.end, { state: 'done', ts: noon - 3000 })
  const endOf = (...lines) => daysFromTranscriptContent(lines.map(line).join('\n')).end?.state
  assert.equal(endOf({ type: 'user', timestamp: iso(1), message: { content: '해줘' } }, { type: 'user', timestamp: iso(0), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), 'interrupted')
  assert.equal(endOf({ type: 'assistant', timestamp: iso(0), isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } }), 'error')
  assert.equal(endOf({ type: 'assistant', timestamp: iso(0), message: { content: [tool('Bash', { command: 'ls' })] } }), 'open')
  // 끝낸 뒤 /usage 같은 명령을 실행해도 끊긴 것으로 보지 않는다.
  assert.equal(endOf({ type: 'assistant', timestamp: iso(2), message: { content: [{ type: 'text', text: '끝' }] } },
    { type: 'user', timestamp: iso(1), message: { content: '<command-name>/usage</command-name>' } },
    { type: 'user', timestamp: iso(0), message: { content: '<local-command-stdout>사용량</local-command-stdout>' } }), 'done')

  const today = dateKey(noon), yesterday = dateKey(noon - D)
  const scans = [{ sourceKey: 'local', sessions: [
    { sessionId: 'chat', cwd: '/drafts/사건A', days: [{ date: yesterday, count: 1, firstText: '어제 일', lastTs: noon - D }, { date: today, count: 2, firstText: '오늘 일', firstTs: noon - 600_000, lastTs: noon - 60_000, files: [{ path: '/drafts/사건A/a.md', kind: 'write' }] }], end: { state: 'interrupted', ts: noon - 60_000 } },
    { sessionId: 'open-old', cwd: '/drafts/사건B', days: [{ date: today, count: 1, firstText: '끊긴 일', lastTs: noon - 3_600_000 }], end: { state: 'open', ts: noon - 3_600_000 } },
    { sessionId: 'open-new', cwd: '/drafts/사건B', days: [{ date: today, count: 1, firstText: '하는 중', lastTs: noon - 60_000 }], end: { state: 'open', ts: noon - 60_000 } },
    { sessionId: 'chief-s', cwd: '/drafts/사건C', days: [{ date: today, count: 1, firstText: '조립된 긴 프롬프트', firstTs: noon - 900_000, lastTs: noon - 800_000 }], end: { state: 'done', ts: noon - 800_000 } },
    { sessionId: 'member-s', cwd: '/drafts/사건C', days: [{ date: today, count: 1, firstText: '부서원 프롬프트', firstTs: noon - 700_000, lastTs: noon - 300_000, files: [{ path: '/drafts/사건C/신청서.hwpx', kind: 'write' }] }], end: { state: 'done', ts: noon - 300_000 } }
  ] }]
  const cards = [
    { id: 'root', rootId: 'root', workspace: '/drafts/사건C', title: '임차권 신청', body: '판례 조사 후 신청서 작성', status: 'awaiting_approval', chief: true, cost: 0.1, sessions: ['chief-s'], createdAt: '2026-11-26T01:00:00Z', report: '# 보고\n\n## 결론\n\n신청서 **초안** 완성.\n\n## 근거\n...' },
    { id: 'dept', rootId: 'root', workspace: '/drafts/사건C', title: '조사', body: '판례 조사', status: 'done', team: '조사부', routedBy: 'root', cost: 0.2, sessions: [], createdAt: '2026-11-26T01:01:00Z' },
    { id: 'member', rootId: 'root', workspace: '/drafts/사건C', title: '판례 수집', body: '수집', status: 'done', agent: 'fact', delegatedBy: 'dept', delegatorTeam: '조사부', cost: 0.3, sessions: ['member-s'], createdAt: '2026-11-26T01:02:00Z' }
  ]
  const index = [meta({ sessionId: 'chat', caseNumber: '2026가합1', sourceKey: 'local', costByDay: { [today]: 0.42, [yesterday]: 0.1 } })]
  const log = mergeWorkLog(scans, index, noon, 30, cards)
  const items = log.find((d) => d.date === today).items
  const chat = items.find((e) => e.sessionId === 'chat')
  assert.equal(chat.status, 'unfinished')
  assert.equal(chat.statusReason, '사용자가 중지함')
  assert.equal(chat.costUsd, 0.42)
  assert.equal(chat.who, '일반 대화')
  assert.deepEqual(chat.files, [{ path: '/drafts/사건A/a.md', kind: 'write' }])
  // 이전 날짜는 이어서 진행한 것으로 보고, 비용은 그날 것만
  const before = log.find((d) => d.date === yesterday).items[0]
  assert.equal(before.status, 'continued')
  assert.equal(before.costUsd, 0.1)
  assert.equal(items.find((e) => e.sessionId === 'open-old').statusReason, '응답 없이 끊김')
  assert.equal(items.find((e) => e.sessionId === 'open-new').status, 'running')
  // 업무 보드 세션 두 개는 원 지시 한 줄로 묶이고 따로 나오지 않는다.
  const board = items.filter((e) => e.board)
  assert.equal(board.length, 1)
  assert.ok(!items.some((e) => !e.board && (e.sessionId === 'chief-s' || e.sessionId === 'member-s')))
  assert.equal(board[0].title, '임차권 신청')
  assert.equal(board[0].firstText, '판례 조사 후 신청서 작성')
  assert.equal(board[0].who, '업무 보드 · 자동 배분(비서실장)')
  assert.equal(board[0].status, 'pending')
  assert.equal(board[0].costUsd, 0.6)
  assert.equal(board[0].firstTs, noon - 900_000)
  assert.equal(board[0].lastTs, noon - 300_000)
  assert.deepEqual(board[0].departments, ['조사부'])
  assert.equal(board[0].workSummary, '신청서 초안 완성.')
  assert.deepEqual(board[0].files, [{ path: '/drafts/사건C/신청서.hwpx', kind: 'write' }])
  assert.deepEqual(board[0].board.children.map((c) => [c.who, c.status, c.costUsd]), [['조사부 부서장', 'done', 0.2], ['조사부 부서원 · fact', 'done', 0.3]])
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
  assert.match(dashboard, /onResumePath\(e\.sessionId, e\.cwd, e\.title, e\.profileId, options\?\.newTab, e\.originDevice\)/)
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

// Creator metadata survives every dashboard summary; legacy/invalid values stay unknown.
for (const originDevice of ['android', 'desktop', undefined, 'unknown']) {
  const entry = meta({ sessionId: 'origin', cwd: '/drafts/origin', sourceKey: 'local', originDevice, mtime: now })
  const expected = originDevice === 'android' || originDevice === 'desktop' ? originDevice : undefined
  const caseSummary = buildCaseActivity([entry], { origin: { drafts: entry.cwd } }, { cases: [{ id: 'origin' }] })
  assert.equal(caseSummary.origin.sessions[0].originDevice, expected, 'case activity retains known creator')
  assert.equal(buildFolderActivity([entry], {}, { cases: [] })[0].sessions[0].originDevice, expected,
    'folder activity retains known creator')
  const scan = [{ sourceKey: 'local', sessions: [{ sessionId: entry.sessionId, cwd: entry.cwd,
    days: [{ date: dateKey(now), count: 1, firstText: '검토', lastTs: now }] }] }]
  for (const scans of [scan, []]) {
    assert.equal(mergeWorkLog(scans, [entry], now, 30)[0].items[0].originDevice, expected,
      'both scanned and index-only work log rows retain known creator')
  }
}
console.log('dashboard creator metadata: case, folder, scanned and index-only work log OK')
