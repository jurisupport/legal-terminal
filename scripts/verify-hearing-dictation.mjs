import assert from 'node:assert/strict'
import { shouldUseDictationCorrection } from '../src/main/dictationGuard.ts'
import { insertDictationText } from '../src/renderer/src/hearing/dictationText.ts'

assert.deepEqual(insertDictationText('', '  재판부가 석명을 요구했습니다.  ', 0, 0), {
  value: '재판부가 석명을 요구했습니다.',
  caret: 16
})

assert.deepEqual(insertDictationText('앞 뒤', '가운데', 2, 2), {
  value: '앞 가운데 뒤',
  caret: 6
})

assert.deepEqual(insertDictationText('원고 기존 문장', '피고', 3, 5), {
  value: '원고 피고 문장',
  caret: 5
})

assert.deepEqual(insertDictationText('앞  기존  뒤', '새', 3, 5), {
  value: '앞  새  뒤',
  caret: 4
})

assert.deepEqual(insertDictationText('보존', '   ', 1, 1), { value: '보존', caret: 1 })

assert.equal(shouldUseDictationCorrection('기일은 9월 12일입니다.', '기일은 9월 13일입니다.'), false)
assert.equal(shouldUseDictationCorrection('제출하지 않았습니다.', '제출했습니다.'), false)
assert.equal(shouldUseDictationCorrection('서울 중앙 지법입니다.', '서울중앙지법입니다.'), true)
assert.equal(shouldUseDictationCorrection('원문', ''), false)
assert.equal(shouldUseDictationCorrection('원문', '완전히 다른 새로운 문장입니다.'), false)

console.log('hearing dictation text insertion ok')
