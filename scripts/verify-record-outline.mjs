import assert from 'node:assert/strict'
import { parseRecordFiles } from '../src/renderer/src/viewer/recordOutline.ts'

const samples = [
  ['2026비합50043_001_2026.06.30_서증_(갑_1_입금내역)_신청인.pdf', '갑1  입금내역'],
  ['2026비합50043_002_2026.06.30_서증_(을 제2호증의1 거래내역)_상대방.pdf', '을2-1  거래내역'],
  ['2025느합1050_013037_2025.08.13_준비서면_서증_입출금 자료_(을15-1_입출금 자료)_상대방.pdf', '을15-1  입출금 자료']
]

for (const [name, label] of samples) {
  const record = parseRecordFiles([{ name, path: name }])
  assert.equal(record.evidences[0]?.label, label)
}

console.log('record outline ok')
