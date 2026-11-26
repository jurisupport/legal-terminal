// 문서 사진 네 꼭짓점 보정(viewer/docWarp.ts) 검증 — 합성 이미지만 쓴다(실제 의뢰인 사진 없음).
// node --experimental-strip-types --no-warnings scripts/verify-doc-warp.mjs
import assert from 'node:assert/strict'
import {
  clampQuad,
  estimateCorners,
  flattenBackground,
  homography,
  outputSize,
  parseSidecar,
  warpQuad
} from '../src/renderer/src/viewer/docWarp.ts'

const inside = (q, x, y) => {
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const c = Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x))
    if (c && s && c !== s) return false
    if (c) s = c
  }
  return true
}

/** 회색 무늬 책상 위에 흰 종이(글자 줄 포함)를 비스듬히 놓은 합성 사진 */
function synth(w, h, paper, { desk = [150, 140, 125], occlude } = {}) {
  const data = new Uint8ClampedArray(w * h * 4)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    const n = (rnd() - 0.5) * 16
    let c = [desk[0] + n, desk[1] + n, desk[2] + n]
    if (inside(paper, x, y)) {
      c = [232, 233, 236]
      if (y % 40 < 3 && x % 90 < 60) c = [40, 40, 50] // 글자 줄
    }
    if (occlude && inside(occlude, x, y)) c = [70, 120, 170] // 모서리를 덮은 신분증
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255
  }
  return { width: w, height: h, data }
}

const maxErr = (a, b, w, h) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y))) / Math.hypot(w, h)

// 1) 사다리꼴 종이 → 네 점이 1.5% 안
{
  const w = 900, h = 1200
  const paper = [{ x: 120, y: 140 }, { x: 760, y: 110 }, { x: 820, y: 1100 }, { x: 70, y: 1060 }]
  const e = estimateCorners(synth(w, h, paper))
  assert.notEqual(e.method, 'fallback')
  assert.ok(maxErr(e.quad, paper, w, h) < 0.015, `추정 오차 ${maxErr(e.quad, paper, w, h)}`)
}

// 2) 신분증이 우상단 모서리를 덮음 → 두 변을 연장한 교점, 그 점은 weak
{
  const w = 900, h = 1200
  const paper = [{ x: 120, y: 140 }, { x: 760, y: 110 }, { x: 820, y: 1100 }, { x: 70, y: 1060 }]
  const card = [{ x: 640, y: 60 }, { x: 880, y: 60 }, { x: 880, y: 240 }, { x: 640, y: 240 }]
  const e = estimateCorners(synth(w, h, paper, { occlude: card }))
  assert.ok(maxErr(e.quad, paper, w, h) < 0.02, `가려진 모서리 오차 ${maxErr(e.quad, paper, w, h)}`)
  assert.equal(e.weak[1], true, '가려진 우상단 점은 weak')
}

// 3) 종이가 위로 화면 밖 → 꼭짓점은 사진 경계 위
{
  const w = 900, h = 1200
  const paper = [{ x: 140, y: -80 }, { x: 780, y: -60 }, { x: 820, y: 1100 }, { x: 90, y: 1060 }]
  const e = estimateCorners(synth(w, h, paper))
  assert.ok(e.quad.every((p) => p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h))
  assert.ok(e.quad[0].y <= 1 && e.quad[1].y <= 1, '위쪽 두 점은 사진 위 경계')
}

// 4) 종이가 없는 사진 → 그래도 네 점(안쪽 5%), 모두 weak
{
  const w = 400, h = 300
  const e = estimateCorners(synth(w, h, [{ x: -9, y: -9 }, { x: -8, y: -9 }, { x: -8, y: -8 }, { x: -9, y: -8 }]))
  assert.equal(e.method, 'fallback')
  assert.deepEqual(e.weak, [true, true, true, true])
  assert.deepEqual(e.quad[0], { x: 20, y: 15 })
}

// 5) 펴기: 출력 크기 = 마주 보는 변 평균, 여백 없음(가장자리까지 종이색), 비율 고정
{
  const w = 900, h = 1200
  const paper = [{ x: 120, y: 140 }, { x: 760, y: 110 }, { x: 820, y: 1100 }, { x: 70, y: 1060 }]
  const src = synth(w, h, paper)
  const size = outputSize(paper, 'free')
  const avgW = (Math.hypot(640, 30) + Math.hypot(750, 40)) / 2
  assert.ok(Math.abs(size.width - avgW) <= 1)
  const out = warpQuad(src, paper, size.width, size.height)
  for (const [x, y] of [[1, 1], [size.width - 2, 1], [size.width - 2, size.height - 2], [1, size.height - 2]]) {
    const o = (y * size.width + x) * 4
    assert.ok(out.data[o] > 200, `출력 가장자리(${x},${y})에 배경이 남음: ${out.data[o]}`)
  }
  const id = outputSize(paper, 'id')
  assert.ok(Math.abs(Math.max(id.width, id.height) / Math.min(id.width, id.height) - 85.6 / 54) < 0.01)
  const a4 = outputSize(paper, 'a4')
  assert.ok(Math.abs(a4.height / a4.width - Math.SQRT2) < 0.01)
  flattenBackground(out)
  const mid = ((size.height >> 1) * size.width + 5) * 4
  assert.ok(out.data[mid] >= 250, '배경 정리 후 바탕은 흰색')
}

// 6) homography가 네 점을 정확히 옮긴다
{
  const s = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }]
  const d = [{ x: 3, y: 4 }, { x: 50, y: 2 }, { x: 60, y: 80 }, { x: 1, y: 70 }]
  const H = homography(s, d)
  for (let i = 0; i < 4; i++) {
    const z = H[6] * s[i].x + H[7] * s[i].y + H[8]
    assert.ok(Math.abs((H[0] * s[i].x + H[1] * s[i].y + H[2]) / z - d[i].x) < 1e-6)
    assert.ok(Math.abs((H[3] * s[i].x + H[4] * s[i].y + H[5]) / z - d[i].y) < 1e-6)
  }
}

// 7) 사이드카 왕복 — 같은 크기면 같은 위치, 축소본이면 비율대로, 밖은 경계로
{
  const quad = [{ x: 10.5, y: 20 }, { x: 400, y: 22 }, { x: 410, y: 590 }, { x: 5, y: 600 }]
  const text = JSON.stringify({ version: 1, source: 'a.heic', width: 420, height: 600, clean: false, regions: [{ name: '01_반성문', quad, ratio: 'id' }] })
  const same = parseSidecar(text, 420, 600)
  assert.deepEqual(same.regions[0].quad, quad)
  assert.equal(same.regions[0].ratio, 'id')
  assert.equal(same.clean, false)
  const half = parseSidecar(text, 210, 300)
  assert.deepEqual(half.regions[0].quad[1], { x: 200, y: 11 })
  assert.equal(parseSidecar('{"version":2}', 1, 1), null)
  assert.deepEqual(clampQuad([{ x: -5, y: 3 }, { x: 9, y: -1 }, { x: 12, y: 12 }, { x: 0, y: 11 }], 10, 10)[2], { x: 10, y: 10 })
}

console.log('verify-doc-warp: ok')
