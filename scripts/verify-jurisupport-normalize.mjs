import assert from 'node:assert/strict'

const { normalizeCaseList } = await import('../src/main/jurisupportNormalize.ts')

const cases = normalizeCaseList({
  data: {
    items: [
      {
        case_id: 'case-1',
        case_number: '2026가합10432',
        case_name: '손해배상',
        court_name: '서울중앙지방법원',
        case_type: 'civil',
        case_parties: [{ role: 'client', party_name: '홍길동' }],
        schedules: [
          {
            hearing_type: 'trial',
            date_time: '2026-07-03T10:30:00+09:00',
            court_room: '404호',
            memo: '변론기일'
          }
        ],
        counts: { party_count: 1, hearing_count: 1 }
      }
    ]
  }
})

assert.equal(cases.length, 1)
assert.equal(cases[0].id, 'case-1')
assert.equal(cases[0].caseNumber, '2026가합10432')
assert.equal(cases[0].caseName, '손해배상')
assert.equal(cases[0].court, '서울중앙지방법원')
assert.equal(cases[0].parties[0].party.name, '홍길동')
assert.equal(cases[0].hearings[0].dateTime, '2026-07-03T10:30:00+09:00')
assert.equal(cases[0].hearings[0].location, '404호')
assert.equal(cases[0]._count?.hearings, 1)
