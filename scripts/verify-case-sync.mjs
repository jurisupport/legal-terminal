import assert from 'node:assert/strict'
import {
  LEGACY_PAIRING_UPDATED_AT,
  fromRemoteLocalCaseForm,
  isCasePairingRecord,
  legacyJsPairingsToRecords,
  mergeCaseEntries,
  mergeCasePair,
  parseCasePairingFileText,
  toRemoteLocalCaseForm
} from '../src/main/caseSyncData.ts'

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

const rec = (over) => ({
  key: 'case-1',
  drafts: '/Users/u/작성서류/2026가단12345 대여금',
  updatedAt: iso(0),
  ...over
})

// 1) mergeCasePair: 새 항목이 이기고, records는 drafts가 같을 때만 옛 항목에서 보충
{
  const older = rec({ updatedAt: iso(60_000), records: '/Users/u/소송기록/대여금' })
  const newer = rec({ updatedAt: iso(0) })
  const merged = mergeCasePair(older, newer)
  assert.equal(merged.updatedAt, newer.updatedAt)
  assert.equal(merged.records, '/Users/u/소송기록/대여금') // 같은 drafts → 보충
  assert.deepEqual(merged, mergeCasePair(newer, older)) // 인자 순서 무관

  // 새 지정이 다른 폴더면 옛 records를 붙이지 않는다
  const moved = rec({ updatedAt: iso(0), drafts: '/Users/u/작성서류/새폴더' })
  assert.equal(mergeCasePair(older, moved).records, undefined)
}

// 2) mergeCaseEntries: 재병합은 changed=false, 갱신은 changed=true + 최신순 정렬
{
  const a = rec({ key: 'a', updatedAt: iso(30_000) })
  const b = rec({ key: 'b', updatedAt: iso(10_000) })
  const first = mergeCaseEntries([a], [b])
  assert.equal(first.changed, true)
  assert.deepEqual(
    first.entries.map((e) => e.key),
    ['b', 'a']
  )
  const again = mergeCaseEntries(first.entries, [a, b])
  assert.equal(again.changed, false)
  const updated = mergeCaseEntries(first.entries, [
    { ...a, updatedAt: iso(0), drafts: '/Users/u/작성서류/변경' }
  ])
  assert.equal(updated.changed, true)
  assert.equal(updated.entries[0].drafts, '/Users/u/작성서류/변경')
}

// 3) toRemoteLocalCaseForm: remote:<프로필id>: 키 + ssh:// URI를 호스트 기준 plain으로
{
  const entry = rec({
    key: 'remote:home-a:case-77',
    drafts: 'ssh://home-a/Users/u/작성서류/대여금',
    records: 'ssh://home-a/Users/u/소송기록/대여금'
  })
  const remote = toRemoteLocalCaseForm(entry, 'home-a')
  assert.equal(remote.key, 'case-77')
  assert.equal(remote.drafts, '/Users/u/작성서류/대여금')
  assert.equal(remote.records, '/Users/u/소송기록/대여금')
  assert.ok(isCasePairingRecord(remote))
  // 다른 프로필 항목·로컬 항목은 이 호스트로 푸시하지 않는다
  assert.equal(toRemoteLocalCaseForm(entry, 'office-b'), null)
  assert.equal(toRemoteLocalCaseForm(rec({ key: 'case-1' }), 'home-a'), null)
  // 다른 프로필의 records URI는 버리되 항목 자체는 유지
  const mixed = toRemoteLocalCaseForm(
    rec({ key: 'remote:home-a:c', drafts: 'ssh://home-a/d', records: 'ssh://other/r' }),
    'home-a'
  )
  assert.equal(mixed.drafts, '/d')
  assert.equal(mixed.records, undefined)
}

// 4) fromRemoteLocalCaseForm: 호스트 local 항목만 자기 프로필 기준으로 변환
{
  const hostEntry = rec({
    key: 'case-77',
    drafts: '/Users/u/작성서류/대여금',
    records: '/Users/u/소송기록/대여금'
  })
  const pulled = fromRemoteLocalCaseForm(hostEntry, 'office-b')
  assert.equal(pulled.key, 'remote:office-b:case-77')
  assert.equal(pulled.drafts, 'ssh://office-b/Users/u/작성서류/대여금')
  assert.equal(pulled.records, 'ssh://office-b/Users/u/소송기록/대여금')
  // 호스트가 제3의 호스트에 대해 지정한 항목·비절대경로는 무시
  assert.equal(fromRemoteLocalCaseForm(rec({ key: 'remote:x:c' }), 'office-b'), null)
  assert.equal(fromRemoteLocalCaseForm(rec({ drafts: 'C:\\사건' }), 'office-b'), null)
}

// 5) 왕복 시나리오: A기기의 지정을 호스트가 받고, B기기가 자기 프로필로 풀어 쓴다
{
  const onA = rec({
    key: 'remote:home-a:case-9',
    drafts: 'ssh://home-a/Users/u/작성서류/임차권등기',
    records: 'ssh://home-a/Users/u/소송기록/임차권등기',
    updatedAt: iso(5_000)
  })
  const hostFile = mergeCaseEntries([], [toRemoteLocalCaseForm(onA, 'home-a')]).entries
  const pulledB = hostFile
    .map((e) => fromRemoteLocalCaseForm(e, 'office-b'))
    .filter(Boolean)
  assert.equal(pulledB.length, 1)
  assert.equal(pulledB[0].key, 'remote:office-b:case-9')
  assert.equal(pulledB[0].drafts, 'ssh://office-b/Users/u/작성서류/임차권등기')
  // B기기가 다시 푸시하면 호스트 파일과 동일한 형태로 돌아간다 (라운드트립)
  const rePush = toRemoteLocalCaseForm(pulledB[0], 'office-b')
  assert.deepEqual(rePush, hostFile[0])
  // 호스트에서 직접 지정한 최신 항목이 이긴다
  const onHost = rec({ key: 'case-9', drafts: '/Users/u/작성서류/임차권등기-정리', updatedAt: iso(0) })
  const merged = mergeCaseEntries(hostFile, [onHost])
  assert.equal(merged.entries[0].drafts, '/Users/u/작성서류/임차권등기-정리')
}

// 6) 구버전 이관: 가장 오래된 시각을 받아 새 저장·동기화 항목에 항상 진다
{
  const legacy = legacyJsPairingsToRecords({
    'case-1': { drafts: '/old/폴더' },
    'remote:home-a:case-2': { drafts: 'ssh://home-a/old', records: 'ssh://home-a/old-r' },
    빈값: { drafts: '' }
  })
  assert.equal(legacy.length, 2)
  assert.ok(legacy.every((e) => e.updatedAt === LEGACY_PAIRING_UPDATED_AT))
  const fresh = rec({ key: 'case-1', drafts: '/new/폴더' })
  const merged = mergeCaseEntries(legacy, [fresh])
  assert.equal(merged.entries.find((e) => e.key === 'case-1').drafts, '/new/폴더')
}

// 7) 파일 파싱: 정상 + 비원자 쓰기 겹침 복구 + 잘못된 항목 걸러내기
{
  const good = JSON.stringify({ version: 1, entries: [rec({}), { key: 'no-drafts' }] }, null, 2)
  assert.equal(parseCasePairingFileText(good).length, 1)
  const overlapped = good + '"drafts": "/잔여물"}]}'
  assert.equal(parseCasePairingFileText(overlapped).length, 1)
  assert.deepEqual(parseCasePairingFileText('완전히 깨진 내용'), [])
}

console.log('verify-case-sync: OK')
