// 문서 사진 네 꼭짓점 추정·원근 펴기·배경 정리 (외부 의존성 없음, DOM 없음).
// 렌더러와 Node 검증 스크립트(scripts/verify-doc-warp.mjs)가 함께 쓴다.

export interface Pt { x: number; y: number }
/** 좌상·우상·우하·좌하 순서 */
export type Quad = [Pt, Pt, Pt, Pt]
export type Weak = [boolean, boolean, boolean, boolean]
/** RGBA 8bit (ImageData와 같은 모양) */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }
export type WarpRatio = 'free' | 'a4' | 'id'

export interface CornerEstimate {
  quad: Quad
  /** 사용자가 먼저 확인해야 할 점 (가려져 연장한 점, 기본값으로 둔 점) */
  weak: Weak
  method: 'paper' | 'edge' | 'fallback'
  score: number
}

export const RATIO_LABEL: Record<WarpRatio, string> = { free: '자유', a4: 'A4 (1:√2)', id: '신분증 (85.6:54)' }
export const MAX_OUTPUT_SIDE = 3508 // A4 300dpi 긴 변

// ── 기본 도구 ─────────────────────────────────────────────

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

export function fallbackQuad(width: number, height: number, inset = 0.05): Quad {
  const x0 = width * inset, y0 = height * inset, x1 = width * (1 - inset), y1 = height * (1 - inset)
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

/** 꼭짓점을 좌상·우상·우하·좌하로 정렬 (화면 좌표 시계 방향) */
export function orderQuad(points: Pt[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // atan2 오름차순 = 화면 좌표에서 시계 방향. 좌상(x+y 최소)부터 시작.
  let start = 0
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Quad
}

export function clampQuad(q: Quad, width: number, height: number): Quad {
  return q.map((p) => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) })) as Quad
}

function polygonArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length
    a += p[i].x * p[j].y - p[j].x * p[i].y
  }
  return Math.abs(a) / 2
}

function isConvex(q: Pt[]): boolean {
  let sign = 0
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], c = q[(i + 2) % q.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) return false
    const s = Math.sign(cross)
    if (sign && s !== sign) return false
    sign = s
  }
  return true
}

// ── 특징 맵 ─────────────────────────────────────────────

interface Features { w: number; h: number; gray: Uint8Array; val: Uint8Array; sat: Uint8Array; labB: Uint8Array }

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return t
})()
const labF = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)

function features(r: Raster): Features {
  const n = r.width * r.height
  const gray = new Uint8Array(n), val = new Uint8Array(n), sat = new Uint8Array(n), labB = new Uint8Array(n)
  const d = r.data
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const R = d[o], G = d[o + 1], B = d[o + 2]
    const mx = R > G ? (R > B ? R : B) : (G > B ? G : B)
    const mn = R < G ? (R < B ? R : B) : (G < B ? G : B)
    val[i] = mx
    sat[i] = mx === 0 ? 0 : Math.round(((mx - mn) * 255) / mx)
    gray[i] = (R * 77 + G * 150 + B * 29) >> 8
    const rl = SRGB_TO_LINEAR[R], gl = SRGB_TO_LINEAR[G], bl = SRGB_TO_LINEAR[B]
    const Y = 0.212671 * rl + 0.71516 * gl + 0.072169 * bl
    const Z = (0.019334 * rl + 0.119193 * gl + 0.950227 * bl) / 1.088754
    const b = 200 * (labF(Y) - labF(Z)) + 128
    labB[i] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
  }
  return { w: r.width, h: r.height, gray, val, sat, labB }
}

// ── 이진 형태학 (누적합으로 O(n)) ─────────────────────────────

function dilate(m: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const r = k >> 1
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h)
  const acc = new Int32Array(Math.max(w, h) + 1)
  for (let y = 0; y < h; y++) {
    const row = y * w
    acc[0] = 0
    for (let x = 0; x < w; x++) acc[x + 1] = acc[x] + m[row + x]
    for (let x = 0; x < w; x++) {
      const a = x - r < 0 ? 0 : x - r, b = x + r + 1 > w ? w : x + r + 1
      tmp[row + x] = acc[b] - acc[a] > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < w; x++) {
    acc[0] = 0
    for (let y = 0; y < h; y++) acc[y + 1] = acc[y] + tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      const a = y - r < 0 ? 0 : y - r, b = y + r + 1 > h ? h : y + r + 1
      out[y * w + x] = acc[b] - acc[a] > 0 ? 1 : 0
    }
  }
  return out
}
const invert = (m: Uint8Array): Uint8Array => m.map((v) => (v ? 0 : 1))
const erode = (m: Uint8Array, w: number, h: number, k: number): Uint8Array => invert(dilate(invert(m), w, h, k))
const close = (m: Uint8Array, w: number, h: number, k: number): Uint8Array => erode(dilate(m, w, h, k), w, h, k)
const open = (m: Uint8Array, w: number, h: number, k: number): Uint8Array => dilate(erode(m, w, h, k), w, h, k)

/** 4-연결 성분 라벨링. 면적 큰 순으로 성분 목록 반환 */
function components(m: Uint8Array, w: number, h: number): { labels: Int32Array; areas: { id: number; area: number }[] } {
  const labels = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const areas: { id: number; area: number }[] = []
  let next = 0
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue
    next++
    let top = 0, area = 0
    stack[top++] = s
    labels[s] = next
    while (top) {
      const p = stack[--top]
      area++
      const x = p % w
      if (x > 0 && m[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[top++] = p - 1 }
      if (x < w - 1 && m[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[top++] = p + 1 }
      if (p >= w && m[p - w] && !labels[p - w]) { labels[p - w] = next; stack[top++] = p - w }
      if (p + w < m.length && m[p + w] && !labels[p + w]) { labels[p + w] = next; stack[top++] = p + w }
    }
    areas.push({ id: next, area })
  }
  areas.sort((a, b) => b.area - a.area)
  return { labels, areas }
}

/** 성분 안의 구멍(글자 등)을 채운다 — 테두리에서 닿지 않는 바탕을 1로 */
function fillHoles(m: Uint8Array, w: number, h: number): Uint8Array {
  const reach = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let top = 0
  const push = (p: number): void => { if (!m[p] && !reach[p]) { reach[p] = 1; stack[top++] = p } }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (top) {
    const p = stack[--top]
    const x = p % w
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (p >= w) push(p - w)
    if (p + w < m.length) push(p + w)
  }
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = reach[i] ? 0 : 1
  return out
}

// ── 영역 → 사각형 ─────────────────────────────────────────

function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const A = points[a], B = points[b]
    const len = dist(A, B) || 1
    let best = -1, bi = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((B.x - A.x) * (A.y - points[i].y) - (A.x - points[i].x) * (B.y - A.y)) / len
      if (d > best) { best = d; bi = i }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]) }
  }
  return points.filter((_, i) => keep[i])
}

/** 닫힌 다각형 단순화: 서로 먼 두 점으로 나눠 각각 Douglas-Peucker */
function simplifyClosed(poly: Pt[], eps: number): Pt[] {
  if (poly.length <= 4) return poly
  let far = 0
  for (let i = 1; i < poly.length; i++) if (dist(poly[0], poly[i]) > dist(poly[0], poly[far])) far = i
  const a = simplify(poly.slice(0, far + 1), eps)
  const b = simplify([...poly.slice(far), poly[0]], eps)
  return a.slice(0, -1).concat(b.slice(0, -1))
}

function intersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x)
  if (Math.abs(d) < 1e-9) return null
  const t = ((a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x)) / d
  return { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) }
}

/**
 * 볼록껍질에서 네 변을 골라 연장해 꼭짓점을 만든다.
 * 신분증 등이 모서리를 덮으면 껍질에 짧은 모따기 변이 생기는데, 이 변은 버리고
 * 양옆 두 변을 연장한 교점을 꼭짓점으로 쓴다(그 점은 weak).
 */
function quadFromHull(hull: Pt[], w: number, h: number): { quad: Quad; weak: Weak } | null {
  const diag = Math.hypot(w, h)
  let peri = 0
  for (let i = 0; i < hull.length; i++) peri += dist(hull[i], hull[(i + 1) % hull.length])
  const poly = simplifyClosed(hull, Math.max(1.5, peri * 0.006))
  if (poly.length < 4) return null
  // 방향이 비슷한 이웃 변을 하나로 합친다
  type Side = { a: Pt; b: Pt; len: number; start: number }
  let sides: Side[] = poly.map((p, i) => ({ a: p, b: poly[(i + 1) % poly.length], len: dist(p, poly[(i + 1) % poly.length]), start: i }))
  const angle = (s: Side): number => Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x)
  const turn = (s: Side, t: Side): number => {
    let d = Math.abs(angle(s) - angle(t))
    if (d > Math.PI) d = 2 * Math.PI - d
    return d
  }
  for (let changed = true; changed && sides.length > 4;) {
    changed = false
    for (let i = 0; i < sides.length && sides.length > 4; i++) {
      const j = (i + 1) % sides.length
      if (turn(sides[i], sides[j]) < (14 * Math.PI) / 180) {
        const merged: Side = { a: sides[i].a, b: sides[j].b, len: dist(sides[i].a, sides[j].b), start: sides[i].start }
        sides = j === 0 ? [merged, ...sides.slice(1, i)] : [...sides.slice(0, i), merged, ...sides.slice(j + 1)]
        changed = true
        break
      }
    }
  }
  if (sides.length < 4) return null
  const chosen = [...sides].sort((a, b) => b.len - a.len).slice(0, 4).sort((a, b) => a.start - b.start)
  const corners: Pt[] = []
  const weak: boolean[] = []
  for (let i = 0; i < 4; i++) {
    const s = chosen[i], t = chosen[(i + 1) % 4]
    if (turn(s, t) < (25 * Math.PI) / 180) return null
    const c = intersect(s.a, s.b, t.a, t.b)
    if (!c) return null
    // 두 변 사이에 버린 변이 있으면(모따기) 연장으로 만든 꼭짓점
    const gap = dist(s.b, t.a)
    corners.push(c)
    weak.push(gap > diag * 0.02)
  }
  // 사진 밖으로 너무 멀리 나가면 잘못된 조합
  for (const c of corners) if (c.x < -0.3 * w || c.x > 1.3 * w || c.y < -0.3 * h || c.y > 1.3 * h) return null
  if (!isConvex(corners)) return null
  // 순서를 좌상부터 맞추면서 weak도 같이 옮긴다
  const ordered = orderQuad(corners)
  const orderedWeak = ordered.map((p) => weak[corners.indexOf(p)]) as Weak
  return { quad: clampQuad(ordered, w, h), weak: orderedWeak }
}

function regionToQuad(mask: Uint8Array, w: number, h: number): { quad: Quad; weak: Weak; area: number } | null {
  const pts: Pt[] = []
  let area = 0
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (lo < 0) lo = x; hi = x; area++ }
    if (lo >= 0) { pts.push({ x: lo, y }, { x: hi + 1, y }, { x: lo, y: y + 1 }, { x: hi + 1, y: y + 1 }) }
  }
  if (pts.length < 8) return null
  const fit = quadFromHull(convexHull(pts), w, h)
  return fit ? { ...fit, area: area / (w * h) } : null
}

// ── 후보 점수 ─────────────────────────────────────────

function onBorder(a: Pt, b: Pt, w: number, h: number): boolean {
  const t = 3
  return (a.x <= t && b.x <= t) || (a.y <= t && b.y <= t) || (a.x >= w - t && b.x >= w - t) || (a.y >= h - t && b.y >= h - t)
}

// ── 후보 마스크 ─────────────────────────────────────────

function candidatesFromMask(raw: Uint8Array, w: number, h: number, k: number, maxRegions = 1): Uint8Array[] {
  let m = close(raw, w, h, k)
  m = open(m, w, h, Math.max(3, Math.round(k / 3)) | 1)
  const { labels, areas } = components(m, w, h)
  const out: Uint8Array[] = []
  for (const c of areas.slice(0, maxRegions)) {
    if (c.area < 0.08 * w * h) break
    const one = new Uint8Array(w * h)
    for (let i = 0; i < one.length; i++) one[i] = labels[i] === c.id ? 1 : 0
    out.push(fillHoles(one, w, h))
  }
  return out
}

function blur3(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
      s += gray[yy * w + xx]; c++
    }
    out[y * w + x] = s / c
  }
  return out
}

/** 변 a→b를 따라 안팎 대비 평균(부호 포함). 바깥 법선은 사각형 중심 반대쪽 */
function sideContrast(g: Uint8Array, w: number, h: number, a: Pt, b: Pt, cx: number, cy: number, off: number): number {
  const len = dist(a, b) || 1
  let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  if ((mx + nx - cx) ** 2 + (my + ny - cy) ** 2 < (mx - cx) ** 2 + (my - cy) ** 2) { nx = -nx; ny = -ny }
  const at = (x: number, y: number): number => g[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))]
  let sum = 0, cnt = 0
  const N = 32
  for (let k = 1; k < N; k++) {
    const t = 0.08 + (0.84 * k) / N
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t
    const ox = px + nx * off, oy = py + ny * off
    if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue
    sum += at(px - nx * off, py - ny * off) - at(ox, oy)
    cnt++
  }
  return cnt >= 6 ? sum / cnt : 0
}

/** 변을 따라 대비가 일정 이상인 표본 비율 (0~1). 사진 경계에 붙은 변은 따로 계산 */
function edgeSupport(g: Uint8Array, w: number, h: number, q: Quad): number {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
  const off = Math.max(2, Math.round(Math.max(w, h) / 300))
  const at = (x: number, y: number): number => g[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))]
  let total = 0, weight = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const len = dist(a, b)
    if (onBorder(a, b, w, h)) { total += BORDER_SUPPORT * len; weight += len; continue }
    let nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1)
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((mx + nx - cx) ** 2 + (my + ny - cy) ** 2 < (mx - cx) ** 2 + (my - cy) ** 2) { nx = -nx; ny = -ny }
    let pos = 0, neg = 0, samples = 0
    for (let k = 1; k < 48; k++) {
      const t = 0.06 + (0.88 * k) / 48
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t
      if (px + nx * off < 0 || py + ny * off < 0 || px + nx * off >= w || py + ny * off >= h) continue
      samples++
      let best = 0
      for (const s of [-1, 0, 1]) {
        const qx = px + nx * s, qy = py + ny * s
        const diff = at(qx - nx * off, qy - ny * off) - at(qx + nx * off, qy + ny * off)
        if (Math.abs(diff) > Math.abs(best)) best = diff
      }
      if (best >= 8) pos++
      else if (best <= -8) neg++
    }
    // 한 변 안에서 밝기 방향이 일관돼야 진짜 종이 경계
    const s = samples >= 8 ? Math.max(pos, neg) / samples : 0
    total += s * len
    weight += len
  }
  return weight ? total / weight : 0
}

/** 각 변을 법선 방향으로 조금씩 옮겨 보며 대비가 가장 큰 선에 붙인다 */
function refineQuad(g: Uint8Array, w: number, h: number, q: Quad): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
  const R = Math.max(3, Math.round(Math.hypot(w, h) * 0.012))
  const off = Math.max(2, Math.round(Math.max(w, h) / 400))
  const lines: [Pt, Pt][] = []
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    if (onBorder(a, b, w, h)) { lines.push([a, b]); continue }
    const len = dist(a, b) || 1
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
    const base = sideContrast(g, w, h, a, b, cx, cy, off)
    const sign = base >= 0 ? 1 : -1
    let best = Math.abs(base), ba = 0, bb = 0
    for (let da = -R; da <= R; da++) for (let db = -R; db <= R; db++) {
      const A = { x: a.x + nx * da, y: a.y + ny * da }, B = { x: b.x + nx * db, y: b.y + ny * db }
      const c = sideContrast(g, w, h, A, B, cx, cy, off) * sign
      if (c > best + 0.5) { best = c; ba = da; bb = db }
    }
    lines.push([{ x: a.x + nx * ba, y: a.y + ny * ba }, { x: b.x + nx * bb, y: b.y + ny * bb }])
  }
  const out: Pt[] = []
  for (let i = 0; i < 4; i++) {
    const prev = lines[(i + 3) % 4], cur = lines[i]
    const c = intersect(prev[0], prev[1], cur[0], cur[1])
    if (!c || dist(c, q[i]) > R * 3) return q
    out.push(c)
  }
  return isConvex(out) ? clampQuad(out as Quad, w, h) : q
}

/** 사진 경계에 붙지 않은 변을 안쪽으로 d만큼 옮긴다 */
function insetQuad(q: Quad, w: number, h: number, d: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
  const lines = q.map((a, i) => {
    const b = q[(i + 1) % 4]
    if (onBorder(a, b, w, h)) return [a, b] as const
    const len = dist(a, b) || 1
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((mx + nx - cx) ** 2 + (my + ny - cy) ** 2 > (mx - cx) ** 2 + (my - cy) ** 2) { nx = -nx; ny = -ny }
    return [{ x: a.x + nx * d, y: a.y + ny * d }, { x: b.x + nx * d, y: b.y + ny * d }] as const
  })
  const out: Pt[] = []
  for (let i = 0; i < 4; i++) {
    const prev = lines[(i + 3) % 4], cur = lines[i]
    const c = intersect(prev[0], prev[1], cur[0], cur[1])
    if (!c) return q
    out.push(c)
  }
  return isConvex(out) ? clampQuad(out as Quad, w, h) : q
}

/**
 * 종이 네 꼭짓점을 추정한다. 어떤 사진이든 네 점을 돌려준다.
 * ① 종이 영역(밝고 채도 낮은 큰 영역, 색·밝기 군집) ② 윤곽선으로 둘러싸인 영역 ③ 안쪽 5% 기본값
 * 후보마다 변을 따라 경계 대비가 일관된지 점수를 매겨 가장 나은 것을 고른다.
 * 좌표는 입력 raster 기준(호출 측에서 원본 배율로 환산).
 */
// ── 직선 검출(Hough) → 네 직선 조합 ─────────────────────────────

interface Line { theta: number; rho: number; votes: number; border?: boolean; c: number; s: number; profile?: Int32Array[]; s0?: number }

function sobel(g: Uint8Array, w: number, h: number): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1]
    const X = (c + 2 * f + r - a - 2 * d - p) / 4, Y = (p + 2 * q + r - a - 2 * b - c) / 4
    gx[i] = X; gy[i] = Y; mag[i] = Math.hypot(X, Y)
  }
  return { gx, gy, mag }
}

/** 경계로 인정할 최소 밝기 차 */
const EDGE_STEP = 8
/** 사진 경계에 붙은 변(종이가 화면 밖으로 나감)의 지지율 */
const BORDER_SUPPORT = 0.35
/** 비슷한 지지율이면 큰 사각형을 고르도록 넓이에 주는 가중치 */
const AREA_W = 0.2
const COS = new Float64Array(180), SIN = new Float64Array(180)
for (let t = 0; t < 180; t++) { COS[t] = Math.cos((t * Math.PI) / 180); SIN[t] = Math.sin((t * Math.PI) / 180) }

function houghLines(w: number, h: number, gx: Float32Array, gy: Float32Array, mag: Float32Array, max: number): Line[] {
  const D = Math.ceil(Math.hypot(w, h)), nr = 2 * D + 1
  const acc = new Float32Array(180 * nr)
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, m = mag[i]
    if (m < 6) continue
    let deg = Math.round((Math.atan2(gy[i], gx[i]) * 180) / Math.PI)
    deg = ((deg % 180) + 180) % 180
    const vote = m > 40 ? 40 : m
    for (let dt = -2; dt <= 2; dt++) {
      const t = (deg + dt + 180) % 180
      acc[t * nr + Math.round(x * COS[t] + y * SIN[t]) + D] += vote
    }
  }
  // 상위 셀부터 비최대 억제
  const minVotes = Math.min(w, h) * 0.1 * 10
  const cells: number[] = []
  for (let i = 0; i < acc.length; i++) if (acc[i] >= minVotes) cells.push(i)
  cells.sort((a, b) => acc[b] - acc[a])
  const out: Line[] = []
  for (const cell of cells) {
    if (out.length >= max) break
    const t = Math.floor(cell / nr), rho = (cell % nr) - D
    const near = out.some((l) => {
      const dt = Math.abs(l.theta - t)
      if (dt <= 4) return Math.abs(l.rho - rho) <= 12
      if (dt >= 176) return Math.abs(l.rho + rho) <= 12
      return false
    })
    if (!near) out.push({ theta: t, rho, votes: acc[cell], c: COS[t], s: SIN[t] })
  }
  return out
}

/**
 * 직선을 따라 1px마다 "경계 대비가 있고 어느 쪽이 밝은가"를 누적해 둔다.
 * profile[0]=양(+)쪽이 밝음, [1]=음(-)쪽이 밝음, [2]=사진 안 표본 수 (모두 누적합)
 */
function lineProfile(g: Uint8Array, w: number, h: number, l: Line, off: number): void {
  const D = Math.ceil(Math.hypot(w, h))
  const n = 2 * D + 1
  const pos = new Int32Array(n + 1), neg = new Int32Array(n + 1), valid = new Int32Array(n + 1)
  const dx = -l.s, dy = l.c
  const at = (x: number, y: number): number => g[(y < 0 ? 0 : y >= h ? h - 1 : Math.round(y)) * w + (x < 0 ? 0 : x >= w ? w - 1 : Math.round(x))]
  for (let k = 0; k < n; k++) {
    const t = k - D
    const x = l.rho * l.c + t * dx, y = l.rho * l.s + t * dy
    let p = 0, q = 0, v = 0
    if (x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1) {
      v = 1
      if (!l.border) {
        let best = 0
        for (let e = -1; e <= 1; e++) {
          const cx = x + l.c * e, cy = y + l.s * e
          const near = at(cx + l.c * off, cy + l.s * off) - at(cx - l.c * off, cy - l.s * off)
          // 계단형 경계만 인정: 가는 줄(공책 괘선·인쇄 테두리)은 멀리서 보면 양쪽이 같다
          const far = at(cx + l.c * off * 3, cy + l.s * off * 3) - at(cx - l.c * off * 3, cy - l.s * off * 3)
          const diff = Math.sign(near) === Math.sign(far) ? (Math.abs(near) < Math.abs(far) ? near : far) : 0
          if (Math.abs(diff) > Math.abs(best)) best = diff
        }
        if (best >= EDGE_STEP) p = 1
        else if (best <= -EDGE_STEP) q = 1
      }
    }
    pos[k + 1] = pos[k] + p; neg[k + 1] = neg[k] + q; valid[k + 1] = valid[k] + v
  }
  l.profile = [pos, neg, valid]
  l.s0 = D
}

/** 직선 l 위 두 점 사이 구간의 경계 지지율 (0~1). 사진 경계선은 BORDER_SUPPORT */
function segmentSupport(l: Line, a: Pt, b: Pt): number {
  if (l.border) return BORDER_SUPPORT
  const [pos, neg, valid] = l.profile!
  const ta = -l.s * a.x + l.c * a.y, tb = -l.s * b.x + l.c * b.y
  let i = Math.round(Math.min(ta, tb)) + l.s0!, j = Math.round(Math.max(ta, tb)) + l.s0!
  const n = pos.length - 1
  i = Math.max(0, Math.min(n, i)); j = Math.max(0, Math.min(n, j))
  const v = valid[j] - valid[i]
  if (v < 6) return 0
  return Math.max(pos[j] - pos[i], neg[j] - neg[i]) / v
}

function meet(a: Line, b: Line): Pt | null {
  const d = a.c * b.s - a.s * b.c
  if (Math.abs(d) < 1e-6) return null
  return { x: (a.rho * b.s - b.rho * a.s) / d, y: (b.rho * a.c - a.rho * b.c) / d }
}

function quadFromLines(g: Uint8Array, w: number, h: number): { quad: Quad; weak: Weak; score: number } | null {
  const { gx, gy, mag } = sobel(g, w, h)
  const lines = houghLines(w, h, gx, gy, mag, 40)
  const off = Math.max(2, Math.round(Math.max(w, h) / 400))
  const border = (theta: number, rho: number): Line => ({ theta, rho, votes: 0, border: true, c: COS[theta], s: SIN[theta] })
  const horiz = lines.filter((l) => l.theta >= 45 && l.theta < 135).slice(0, 16)
  const vert = lines.filter((l) => l.theta < 45 || l.theta >= 135).slice(0, 16)
  horiz.push(border(90, 0), border(90, h - 1))
  vert.push(border(0, 0), border(0, w - 1))
  for (const l of [...horiz, ...vert]) lineProfile(g, w, h, l, off)
  const xc = w / 2, yc = h / 2
  const yAt = (l: Line): number => (l.rho - xc * l.c) / l.s
  const xAt = (l: Line): number => (l.rho - yc * l.s) / l.c
  horiz.sort((a, b) => yAt(a) - yAt(b))
  vert.sort((a, b) => xAt(a) - xAt(b))
  const slack = 0.03
  const inside = (p: Pt): boolean => p.x >= -slack * w && p.x <= (1 + slack) * w && p.y >= -slack * h && p.y <= (1 + slack) * h
  let best: { quad: Quad; weak: Weak; score: number } | null = null
  for (let ti = 0; ti < horiz.length; ti++) for (let bi = ti + 1; bi < horiz.length; bi++) {
    const top = horiz[ti], bot = horiz[bi]
    if (yAt(bot) - yAt(top) < 0.2 * h) continue
    if (top.border && bot.border) continue
    for (let li = 0; li < vert.length; li++) for (let ri = li + 1; ri < vert.length; ri++) {
      const left = vert[li], right = vert[ri]
      if (xAt(right) - xAt(left) < 0.2 * w) continue
      if (left.border && right.border && (top.border || bot.border)) continue
      const tl = meet(top, left), tr = meet(top, right), br = meet(bot, right), bl = meet(bot, left)
      if (!tl || !tr || !br || !bl) continue
      const q = [tl, tr, br, bl]
      if (!q.every(inside) || !isConvex(q)) continue
      const area = polygonArea(q) / (w * h)
      if (area < 0.1) continue
      const sides: [Line, Pt, Pt][] = [[top, tl, tr], [right, tr, br], [bot, br, bl], [left, bl, tl]]
      let sum = 0, len = 0
      for (const [l, a, b] of sides) {
        const L = dist(a, b)
        sum += segmentSupport(l, a, b) * L
        len += L
      }
      const score = (sum / len) * (1 - AREA_W + AREA_W * Math.sqrt(area))
      if (best && score <= best.score) continue
      // 꼭짓점 근처 15% 구간에서 양쪽 변이 모두 안 보이면 가려진 모서리(연장한 교점)
      const hidden = (l: Line, corner: Pt, other: Pt): boolean =>
        !l.border && segmentSupport(l, corner, { x: corner.x + (other.x - corner.x) * 0.15, y: corner.y + (other.y - corner.y) * 0.15 }) < 0.3
      const weak: Weak = [
        hidden(top, tl, tr) && hidden(left, tl, bl),
        hidden(top, tr, tl) && hidden(right, tr, br),
        hidden(bot, br, bl) && hidden(right, br, tr),
        hidden(bot, bl, br) && hidden(left, bl, tl)
      ]
      best = { quad: clampQuad(q as Quad, w, h), weak, score }
    }
  }
  return best
}


/**
 * 종이 네 꼭짓점을 추정한다. 어떤 사진이든 네 점을 돌려준다.
 * ① 종이 영역(밝고 채도 낮은 큰 영역) ② 윤곽 직선 네 개 조합 ③ 안쪽 5% 기본값
 * ①·②가 낸 후보마다 변을 따라 경계 대비가 일관된지 점수를 매겨 가장 나은 것을 고른다.
 * 가려진 모서리는 보이는 두 변을 연장한 교점이 되고 weak로 표시한다.
 * 좌표는 입력 raster 기준(호출 측에서 원본 배율로 환산).
 */
export function estimateCorners(r: Raster): CornerEstimate {
  const { w, h, gray, val, sat, labB } = features(r)
  const n = w * h
  const g = blur3(blur3(gray, w, h), w, h)
  const k = Math.max(5, Math.round(Math.max(w, h) / 40)) | 1
  type Cand = { quad: Quad; weak: Weak; score: number; method: 'paper' | 'edge' }
  const cands: Cand[] = []
  // ① 종이: 무채색·누렇지 않음·밝음 (docscan.find_page 기준)
  const paper = new Uint8Array(n)
  for (let i = 0; i < n; i++) paper[i] = sat[i] < 32 && labB[i] < 135 && val[i] > 100 ? 1 : 0
  for (const mask of candidatesFromMask(paper, w, h, k)) {
    const fit = regionToQuad(mask, w, h)
    if (!fit || fit.area < 0.1 || fit.area > 0.97) continue
    const area = polygonArea(fit.quad) / n
    cands.push({ quad: fit.quad, weak: fit.weak, method: 'paper', score: edgeSupport(g, w, h, fit.quad) * (1 - AREA_W + AREA_W * Math.sqrt(area)) })
  }
  // ② 윤곽 직선
  const lined = quadFromLines(g, w, h)
  if (lined) cands.push({ ...lined, method: 'edge' })
  const best = cands.sort((a, b) => b.score - a.score)[0]
  if (best && best.score >= 0.45) {
    // 경계선은 종이와 배경 사이 픽셀이라, 배경이 한 줄도 안 남도록 변을 살짝 안으로 들인다
    const quad = insetQuad(refineQuad(g, w, h, best.quad), w, h, Math.max(1, Math.max(w, h) / 300))
    return { quad, weak: best.weak, method: best.method, score: best.score }
  }
  return { quad: fallbackQuad(w, h), weak: [true, true, true, true], method: 'fallback', score: best?.score ?? 0 }
}

export function scaleQuad(q: Quad, sx: number, sy = sx): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad
}

// ── 원근 변환 ─────────────────────────────────────────

/** src 네 점 → dst 네 점 사영변환 행렬 (3x3, h33=1) */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('네 점이 한 직선 위에 있어 펼 수 없습니다.')
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
    }
  }
  return [...A.map((row, i) => row[8] / A[i][i]), 1]
}

export function outputSize(q: Quad, ratio: WarpRatio): { width: number; height: number } {
  let W = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2
  let H = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2
  if (ratio !== 'free') {
    const aspect = ratio === 'a4' ? Math.SQRT2 : 85.6 / 54
    const area = W * H
    const long = Math.sqrt(area * aspect), short = long / aspect
    // a4는 세로가 긴 쪽이 기본, 신분증은 가로가 긴 쪽이 기본. 실제 모양을 따른다.
    if (H >= W) { W = short; H = long } else { W = long; H = short }
  }
  const s = Math.min(1, MAX_OUTPUT_SIDE / Math.max(W, H))
  return { width: Math.max(1, Math.round(W * s)), height: Math.max(1, Math.round(H * s)) }
}

/** 사각형 안쪽만 직사각형으로 편다. 여백·테두리 없음. 표본은 원본 경계에서 멈춤 */
export function warpQuad(src: Raster, q: Quad, width: number, height: number): Raster {
  // 출력 → 원본 역사상
  const H = homography(
    [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    q
  )
  const out = new Uint8ClampedArray(width * height * 4)
  const sw = src.width, sh = src.height, sd = src.data
  for (let y = 0; y < height; y++) {
    const yy = y + 0.5
    for (let x = 0; x < width; x++) {
      const xx = x + 0.5
      const den = H[6] * xx + H[7] * yy + H[8]
      let fx = (H[0] * xx + H[1] * yy + H[2]) / den - 0.5
      let fy = (H[3] * xx + H[4] * yy + H[5]) / den - 0.5
      if (fx < 0) fx = 0; else if (fx > sw - 1) fx = sw - 1
      if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1
      const x0 = fx | 0, y0 = fy | 0
      const x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0
      const ax = fx - x0, ay = fy - y0
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4
      const o = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * ax
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * ax
        out[o + c] = top + (bot - top) * ay
      }
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

// ── 배경 정리: 조명 평탄화 + 바탕 흰색, 도장 색 유지 (docscan.flatten) ─────

function maxFilter1D(src: Float32Array, dst: Float32Array, n: number, stride: number, offset: number, r: number, useMax: boolean): void {
  for (let i = 0; i < n; i++) {
    const a = i - r < 0 ? 0 : i - r, b = i + r >= n ? n - 1 : i + r
    let v = src[offset + a * stride]
    for (let j = a + 1; j <= b; j++) {
      const s = src[offset + j * stride]
      if (useMax ? s > v : s < v) v = s
    }
    dst[offset + i * stride] = v
  }
}

function filter2D(img: Float32Array, w: number, h: number, r: number, useMax: boolean): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) maxFilter1D(img, tmp, w, 1, y * w, r, useMax)
  for (let x = 0; x < w; x++) maxFilter1D(tmp, out, h, w, x, r, useMax)
  return out
}

function boxBlur(img: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += img[y * w + k]; c++ }
      tmp[y * w + x] = s / c
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0, c = 0
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; c++ }
      out[y * w + x] = s / c
    }
  }
  return out
}

const LEVELS = (() => {
  const t = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    const v = Math.min(255, Math.max(0, ((i - 40) * 255) / (228 - 40)))
    t[i] = 255 * Math.pow(v / 255, 1.15)
  }
  return t
})()

/** 조명을 평탄화하고 바탕을 흰색으로. 채널별로 나눠 도장 붉은색은 남긴다. 제자리 변경 */
export function flattenBackground(img: Raster): Raster {
  const { width: w, height: h, data } = img
  // 축소본에서 배경(글자를 지운 밝기)을 추정한다: 블록 최대값 → 닫힘 → 흐림
  const f = Math.max(1, Math.round(Math.max(w, h) / 500))
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f)
  const kSmall = Math.max(3, Math.round(Math.max(31, Math.min(w, h) / 25) / f / 2))
  for (let c = 0; c < 3; c++) {
    const small = new Float32Array(sw * sh)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y / f) | 0) * sw + ((x / f) | 0)
      const v = data[(y * w + x) * 4 + c]
      if (v > small[i]) small[i] = v
    }
    let bg = filter2D(small, sw, sh, kSmall, true)
    bg = filter2D(bg, sw, sh, kSmall, false)
    bg = boxBlur(boxBlur(bg, sw, sh, Math.max(1, kSmall >> 1)), sw, sh, Math.max(1, kSmall >> 1))
    for (let y = 0; y < h; y++) {
      const gy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5))
      const y0 = gy | 0, y1 = Math.min(sh - 1, y0 + 1), ay = gy - y0
      for (let x = 0; x < w; x++) {
        const gx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5))
        const x0 = gx | 0, x1 = Math.min(sw - 1, x0 + 1), ax = gx - x0
        const b = (bg[y0 * sw + x0] * (1 - ax) + bg[y0 * sw + x1] * ax) * (1 - ay) + (bg[y1 * sw + x0] * (1 - ax) + bg[y1 * sw + x1] * ax) * ay
        const o = (y * w + x) * 4 + c
        const norm = Math.min(255, (data[o] * 255) / Math.max(1, b))
        data[o] = LEVELS[norm | 0]
      }
    }
  }
  return img
}

// ── 사이드카 JSON ─────────────────────────────────────────

export interface DocWarpRegion { name: string; quad: Quad; ratio: WarpRatio; output?: string }
export interface DocWarpSidecar {
  version: 1
  source: string
  /** 회전 반영 후 원본 픽셀 크기 — 좌표는 이 크기 기준 */
  width: number
  height: number
  clean: boolean
  regions: DocWarpRegion[]
  savedAt: string
}

export function parseSidecar(text: string, width: number, height: number): DocWarpSidecar | null {
  try {
    const v = JSON.parse(text) as DocWarpSidecar
    if (v?.version !== 1 || !Array.isArray(v.regions) || !v.width || !v.height) return null
    const sx = width / v.width, sy = height / v.height
    const regions = v.regions
      .filter((r) => Array.isArray(r.quad) && r.quad.length === 4 && r.quad.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)))
      .map((r) => ({
        name: typeof r.name === 'string' ? r.name : '',
        ratio: (['free', 'a4', 'id'] as const).includes(r.ratio) ? r.ratio : 'free',
        output: r.output,
        quad: clampQuad(scaleQuad(r.quad, sx, sy), width, height)
      }))
    return regions.length ? { ...v, width, height, regions, clean: v.clean !== false } : null
  } catch {
    return null
  }
}
