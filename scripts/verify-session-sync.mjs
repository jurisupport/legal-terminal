import assert from 'node:assert/strict'
import {
  computeSearchText,
  fromRemoteLocalForm,
  isSessionMetaRecord,
  mergeMetaEntries,
  mergeMetaPair,
  toRemoteLocalForm
} from '../src/main/sessionSyncData.ts'

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

const meta = (over) => {
  const base = {
    key: 'local:s1',
    sourceKey: 'local',
    sessionId: 's1',
    cwd: '/Users/u/drafts/대여금',
    updatedAt: iso(0),
    searchText: '',
    ...over
  }
  base.searchText = computeSearchText(base)
  return base
}

// 1) mergeMetaPair: 새 항목이 이기되, 새 항목에 없는 필드는 옛 항목에서 채운다
{
  const older = meta({ updatedAt: iso(60_000), generatedTitle: '준비서면 초안', mtime: 100 })
  const newer = meta({ updatedAt: iso(0), workSummary: '한 일: 초안 완성', title: '탭제목' })
  const merged = mergeMetaPair(older, newer)
  assert.equal(merged.workSummary, '한 일: 초안 완성') // 새 항목 필드 유지
  assert.equal(merged.generatedTitle, '준비서면 초안') // 빠진 필드는 옛 항목에서
  assert.equal(merged.updatedAt, newer.updatedAt)
  // 인자 순서와 무관해야 한다
  const swapped = mergeMetaPair(newer, older)
  assert.deepEqual(merged, swapped)
}

// 2) mergeMetaEntries: 동일 항목 재병합은 changed=false, 새 항목·갱신은 changed=true + 최신순 정렬
{
  const a = meta({ key: 'local:a', sessionId: 'a', updatedAt: iso(30_000) })
  const b = meta({ key: 'local:b', sessionId: 'b', updatedAt: iso(10_000) })
  const first = mergeMetaEntries([a], [b])
  assert.equal(first.changed, true)
  assert.deepEqual(
    first.entries.map((e) => e.sessionId),
    ['b', 'a']
  )
  const again = mergeMetaEntries(first.entries, [a, b])
  assert.equal(again.changed, false)
  const updated = mergeMetaEntries(first.entries, [
    { ...a, updatedAt: iso(0), generatedTitle: '새 제목' }
  ])
  assert.equal(updated.changed, true)
  assert.equal(updated.entries[0].generatedTitle, '새 제목')
}

// 3) toRemoteLocalForm: 기기 종속 필드(ssh·profileId·sshLabel) 제거 + local 키로 변환
{
  const entry = meta({
    key: 'ssh:u@mini:22:s1',
    sourceKey: 'ssh:u@mini:22',
    ssh: { host: 'mini', user: 'u', identityFile: '/Users/u/.ssh/id' },
    profileId: 'office',
    sshLabel: '사무실 맥미니',
    caseNumber: '2026가단12345',
    generatedTitle: '임차권등기 신청서 작성'
  })
  const remote = toRemoteLocalForm(entry)
  assert.equal(remote.key, 'local:s1')
  assert.equal(remote.sourceKey, 'local')
  assert.equal(remote.ssh, undefined)
  assert.equal(remote.profileId, undefined)
  assert.equal(remote.sshLabel, undefined)
  assert.equal(remote.caseNumber, '2026가단12345')
  assert.ok(!remote.searchText.includes('사무실'))
  assert.ok(remote.searchText.includes('2026가단12345'))
  assert.ok(isSessionMetaRecord(remote))
}

// 4) fromRemoteLocalForm: local 항목만 이 앱 기준 ssh 항목으로 변환, 프로필 정보 재부여
{
  const remote = meta({ caseNumber: '2026가단12345', generatedTitle: '준비서면 초안' })
  const ctx = {
    sourceKey: 'ssh:u@mini:22',
    ssh: { host: 'mini', user: 'u' },
    profileId: 'office',
    sshLabel: '사무실 맥미니'
  }
  const pulled = fromRemoteLocalForm(remote, ctx)
  assert.equal(pulled.key, 'ssh:u@mini:22:s1')
  assert.equal(pulled.sourceKey, 'ssh:u@mini:22')
  assert.equal(pulled.profileId, 'office')
  assert.equal(pulled.generatedTitle, '준비서면 초안')
  assert.ok(pulled.searchText.includes('사무실 맥미니'.normalize('NFKC').toLowerCase()))
  // 원격 호스트가 제3의 호스트에 붙어 만든 항목은 무시
  const foreign = meta({ key: 'ssh:x@other:22:s9', sourceKey: 'ssh:x@other:22', sessionId: 's9' })
  assert.equal(fromRemoteLocalForm(foreign, ctx), null)
}

// 5) 왕복 시나리오: A기기가 푸시한 제목을 B기기가 풀로 받아 사건번호 검색까지 동작
{
  // A기기: 원격 세션에 제목·사건번호 저장 → 원격 파일(local 형태)로 푸시
  const onA = meta({
    key: 'ssh:u@mini:22:s7',
    sourceKey: 'ssh:u@mini:22',
    sessionId: 's7',
    cwd: '/Users/u/drafts/대여금',
    ssh: { host: 'mini', user: 'u' },
    profileId: 'home-a',
    caseNumber: '2026가단77777',
    generatedTitle: '대여금 답변서 쟁점 정리'
  })
  const remoteFile = mergeMetaEntries([], [toRemoteLocalForm(onA)]).entries
  // B기기: 풀 → 자기 프로필로 변환해 로컬 인덱스에 병합
  const ctxB = {
    sourceKey: 'ssh:u@mini:22',
    ssh: { host: 'mini', user: 'u' },
    profileId: 'office-b',
    sshLabel: '사무실'
  }
  const pulledB = remoteFile.map((e) => fromRemoteLocalForm(e, ctxB)).filter(Boolean)
  const indexB = mergeMetaEntries([], pulledB)
  assert.equal(indexB.entries.length, 1)
  const got = indexB.entries[0]
  assert.equal(got.generatedTitle, '대여금 답변서 쟁점 정리')
  assert.equal(got.profileId, 'office-b') // B기기 자신의 프로필로 매핑
  assert.ok(got.searchText.includes('2026가단77777')) // 사건번호 검색 매칭 가능
}

console.log('verify-session-sync: OK')
