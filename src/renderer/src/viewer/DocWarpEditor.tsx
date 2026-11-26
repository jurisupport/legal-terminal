import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  RATIO_LABEL,
  clampQuad,
  estimateCorners,
  fallbackQuad,
  flattenBackground,
  outputSize,
  parseSidecar,
  scaleQuad,
  warpQuad,
  type DocWarpSidecar,
  type Pt,
  type Quad,
  type Raster,
  type Weak,
  type WarpRatio
} from './docWarp'
import './DocWarp.css'

interface Region { id: number; name: string; quad: Quad; weak: Weak; ratio: WarpRatio }
interface Loaded { bitmap: ImageBitmap; width: number; height: number; small: Raster; smallScale: number }
type Drag = { region: number; corner: number | 'all'; start: Pt; origin: Quad } | null

const ESTIMATE_SIDE = 1200
const LOUPE = 168
const LOUPE_ZOOM = 3 // 원본 1px = 화면 3px
const COLORS = ['#3b9eff', '#3ecf8e', '#c792ea', '#ff6b9a', '#4dd0e1', '#f7d154']
const WEAK = '#ff9f1a'
const CORNER_LABEL = ['좌상', '우상', '우하', '좌하']

const baseName = (path: string): string => path.replace(/^.*[\\/]/, '')
const stemOf = (path: string): string => baseName(path).replace(/\.[^.]+$/, '')
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function rasterOf(bitmap: ImageBitmap, maxSide: number): { raster: Raster; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { raster: { width: w, height: h, data: data.data }, scale }
}

async function jpegBytes(r: Raster): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(r.width, r.height)
  canvas.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return new Uint8Array(await blob.arrayBuffer())
}

function estimate(l: Loaded): { quad: Quad; weak: Weak; method: string } {
  const e = estimateCorners(l.small)
  return { quad: clampQuad(scaleQuad(e.quad, 1 / l.smallScale), l.width, l.height), weak: e.weak, method: e.method }
}

const outputNames = (regions: Region[], stem: string): string[] =>
  regions.map((r, i) => r.name.trim() || (regions.length === 1 ? stem : `${stem}_${i + 1}`))

/** 펴기 전 사진 위에 네 꼭짓점을 찍고, 사각형마다 직사각형으로 펴서 보정이미지/에 저장한다 */
export default function DocWarpEditor({
  path,
  onClose,
  onOpenFile
}: {
  path: string
  onClose: () => void
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('사진을 여는 중…')
  const [regions, setRegions] = useState<Region[]>([])
  const [active, setActive] = useState(0)
  const [selected, setSelected] = useState<{ region: number; corner: number } | null>(null)
  const [clean, setClean] = useState(true)
  const [busy, setBusy] = useState('')
  const [saved, setSaved] = useState<{ dir: string; files: string[] } | null>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number; img: Pt } | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const nextId = useRef(1)
  const stem = stemOf(path)

  // ── 열기: 디코딩(HEIC는 main에서 JPEG로) → 회전 반영 → 사이드카 or 자동 추정 ──
  useEffect(() => {
    let alive = true
    let bitmap: ImageBitmap | undefined
    setLoaded(null)
    setError('')
    setSaved(null)
    ;(async () => {
      const { bytes } = await window.lt.docWarp.decode(path)
      bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' })
      if (!alive) return
      const { raster, scale } = rasterOf(bitmap, ESTIMATE_SIDE)
      const l: Loaded = { bitmap, width: bitmap.width, height: bitmap.height, small: raster, smallScale: scale }
      const sidecar = parseSidecar((await window.lt.docWarp.loadSidecar(path).catch(() => null)) ?? '', l.width, l.height)
      if (!alive) return
      if (sidecar) {
        setRegions(sidecar.regions.map((r) => ({ id: nextId.current++, name: r.name, quad: r.quad, ratio: r.ratio, weak: [false, false, false, false] })))
        setClean(sidecar.clean)
        setNotice(`저장해 둔 꼭짓점 ${sidecar.regions.length}개 사각형을 불러왔습니다.`)
      } else {
        await tick()
        const e = estimate(l)
        if (!alive) return
        setRegions([{ id: nextId.current++, name: '', quad: e.quad, weak: e.weak, ratio: 'free' }])
        setNotice(
          e.method === 'fallback'
            ? '종이 테두리를 찾지 못해 기본 위치에 점을 두었습니다. 주황 점을 종이 모서리로 옮겨 주세요.'
            : e.weak.some(Boolean)
              ? '꼭짓점을 추정했습니다. 주황 점은 가려지거나 연장해 찾은 점이니 먼저 확인해 주세요.'
              : '꼭짓점을 추정했습니다. 맞으면 「펴기」를 누르고, 틀린 점만 끌어 옮기세요.'
        )
      }
      setActive(0)
      setLoaded(l)
    })().catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
      bitmap?.close()
    }
  }, [path])

  // ── 화면 맞춤 ──
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [loaded])

  const fit = useMemo(() => {
    if (!loaded || !stage.w || !stage.h) return null
    const pad = 24
    const scale = Math.min((stage.w - pad * 2) / loaded.width, (stage.h - pad * 2) / loaded.height)
    const w = loaded.width * scale, h = loaded.height * scale
    return { scale, w, h, left: (stage.w - w) / 2, top: (stage.h - h) / 2 }
  }, [loaded, stage])

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !loaded || !fit) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(fit.w * dpr)
    c.height = Math.round(fit.h * dpr)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(loaded.bitmap, 0, 0, c.width, c.height)
  }, [loaded, fit])

  // ── 끌기 ──
  const toImage = useCallback((clientX: number, clientY: number): Pt | null => {
    const el = stageRef.current
    if (!el || !fit || !loaded) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.min(loaded.width, Math.max(0, (clientX - rect.left - fit.left) / fit.scale)),
      y: Math.min(loaded.height, Math.max(0, (clientY - rect.top - fit.top) / fit.scale))
    }
  }, [fit, loaded])

  const updateQuad = (index: number, quad: Quad, corner?: number): void =>
    setRegions((rs) => rs.map((r, i) => (i === index ? { ...r, quad, weak: corner === undefined ? r.weak : (r.weak.map((v, k) => (k === corner ? false : v)) as Weak) } : r)))

  const onPointerDown = (e: React.PointerEvent, region: number, corner: number | 'all'): void => {
    if (e.button !== 0) return
    const p = toImage(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setActive(region)
    setSelected(corner === 'all' ? null : { region, corner })
    setDrag({ region, corner, start: p, origin: regions[region].quad })
    setSaved(null)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag || !loaded) return
    const p = toImage(e.clientX, e.clientY)
    if (!p) return
    const rect = stageRef.current!.getBoundingClientRect()
    if (drag.corner === 'all') {
      // 사각형 통째로 옮기기 — 사진 밖으로 나가지 않게 이동량을 제한
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y
      for (const c of drag.origin) {
        dx = Math.min(loaded.width - c.x, Math.max(-c.x, dx))
        dy = Math.min(loaded.height - c.y, Math.max(-c.y, dy))
      }
      updateQuad(drag.region, drag.origin.map((c) => ({ x: c.x + dx, y: c.y + dy })) as Quad)
      setPointer(null)
      return
    }
    const q = [...regions[drag.region].quad] as Quad
    q[drag.corner] = p
    updateQuad(drag.region, q, drag.corner)
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top, img: p })
  }

  const endDrag = (): void => {
    setDrag(null)
    setPointer(null)
  }

  // 화살표로 1px(Shift 10px) 미세 조정
  useEffect(() => {
    if (!selected || !loaded) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
      const step = e.shiftKey ? 10 : 1
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (!d) return
      e.preventDefault()
      setRegions((rs) => rs.map((r, i) => {
        if (i !== selected.region) return r
        const q = [...r.quad] as Quad
        const c = q[selected.corner]
        q[selected.corner] = { x: Math.min(loaded.width, Math.max(0, c.x + d[0])), y: Math.min(loaded.height, Math.max(0, c.y + d[1])) }
        return { ...r, quad: q, weak: r.weak.map((v, k) => (k === selected.corner ? false : v)) as Weak }
      }))
      setSaved(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, loaded])

  // ── 돋보기 ──
  const loupeTarget = pointer?.img ?? null
  useEffect(() => {
    const c = loupeRef.current
    if (!c || !loaded || !loupeTarget || !drag || drag.corner === 'all') return
    const dpr = window.devicePixelRatio || 1
    c.width = LOUPE * dpr
    c.height = LOUPE * dpr
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, LOUPE, LOUPE)
    const span = LOUPE / LOUPE_ZOOM
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(loaded.bitmap, loupeTarget.x - span / 2, loupeTarget.y - span / 2, span, span, 0, 0, LOUPE, LOUPE)
    // 이웃 꼭짓점으로 가는 두 변을 같이 그려 모서리 각을 맞추기 쉽게
    const q = regions[drag.region].quad
    const k = drag.corner
    const toLoupe = (p: Pt): Pt => ({ x: LOUPE / 2 + (p.x - loupeTarget.x) * LOUPE_ZOOM, y: LOUPE / 2 + (p.y - loupeTarget.y) * LOUPE_ZOOM })
    ctx.strokeStyle = COLORS[drag.region % COLORS.length]
    ctx.lineWidth = 1.5
    for (const n of [q[(k + 3) % 4], q[(k + 1) % 4]]) {
      const a = toLoupe(loupeTarget), b = toLoupe(n)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.strokeStyle = '#ff3b30'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(LOUPE / 2, 0); ctx.lineTo(LOUPE / 2, LOUPE)
    ctx.moveTo(0, LOUPE / 2); ctx.lineTo(LOUPE, LOUPE / 2)
    ctx.stroke()
  }, [loupeTarget, loaded, drag, regions])

  // ── 펴기 후 미리보기 (축소본으로 빠르게) ──
  const [previews, setPreviews] = useState<Record<number, string>>({})
  useEffect(() => {
    if (!loaded || drag) return
    let alive = true
    const made: string[] = []
    const timer = setTimeout(async () => {
      const next: Record<number, string> = {}
      for (const r of regions) {
        const q = scaleQuad(r.quad, loaded.smallScale)
        const full = outputSize(r.quad, r.ratio)
        const s = Math.min(1, 360 / Math.max(full.width, full.height))
        let out: Raster
        try {
          out = warpQuad(loaded.small, q, Math.max(1, Math.round(full.width * s)), Math.max(1, Math.round(full.height * s)))
        } catch {
          continue
        }
        if (clean) flattenBackground(out)
        const blob = new Blob([await jpegBytes(out)], { type: 'image/jpeg' })
        const url = URL.createObjectURL(blob)
        made.push(url)
        next[r.id] = url
      }
      if (alive) setPreviews(next)
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
      setTimeout(() => made.forEach((u) => URL.revokeObjectURL(u)), 1000)
    }
  }, [loaded, regions, clean, drag])

  // ── 사각형 추가·삭제·다시 추정 ──
  const addRegion = (): void => {
    if (!loaded) return
    const inset = 0.25 + (regions.length % 3) * 0.04
    setRegions((rs) => [...rs, { id: nextId.current++, name: '', quad: fallbackQuad(loaded.width, loaded.height, inset), weak: [true, true, true, true], ratio: 'free' }])
    setActive(regions.length)
    setSelected(null)
    setSaved(null)
    setNotice('사각형을 추가했습니다. 네 점을 끌어 펼 영역의 모서리에 맞추세요. 안쪽을 끌면 통째로 옮겨집니다.')
  }

  const removeRegion = (index: number): void => {
    if (regions.length <= 1) return
    setRegions((rs) => rs.filter((_, i) => i !== index))
    setActive((a) => Math.max(0, a >= index ? a - 1 : a))
    setSelected(null)
    setSaved(null)
  }

  const reestimate = async (): Promise<void> => {
    if (!loaded) return
    setBusy('꼭짓점을 다시 찾는 중…')
    await tick()
    const e = estimate(loaded)
    setRegions((rs) => rs.map((r, i) => (i === active ? { ...r, quad: e.quad, weak: e.weak } : r)))
    setBusy('')
    setSaved(null)
    setNotice(e.method === 'fallback' ? '종이 테두리를 찾지 못했습니다. 점을 직접 옮겨 주세요.' : '꼭짓점을 다시 추정했습니다.')
  }

  // ── 펴기(저장) ──
  const save = async (): Promise<void> => {
    if (!loaded || busy) return
    setBusy('펴는 중…')
    setSaved(null)
    await tick()
    try {
      const full = rasterOf(loaded.bitmap, Infinity).raster
      const names = outputNames(regions, stem)
      const outputs: { name: string; data: Uint8Array }[] = []
      for (let i = 0; i < regions.length; i++) {
        setBusy(`펴는 중… (${i + 1}/${regions.length})`)
        await tick()
        const r = regions[i]
        const size = outputSize(r.quad, r.ratio)
        const out = warpQuad(full, r.quad, size.width, size.height)
        if (clean) flattenBackground(out)
        outputs.push({ name: names[i], data: await jpegBytes(out) })
      }
      const sidecar: DocWarpSidecar = {
        version: 1,
        source: baseName(path),
        width: loaded.width,
        height: loaded.height,
        clean,
        regions: regions.map((r, i) => ({
          name: r.name.trim(),
          ratio: r.ratio,
          output: `${names[i]}.jpg`,
          quad: r.quad.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) as Quad
        })),
        savedAt: new Date().toISOString()
      }
      setBusy('저장하는 중…')
      const result = await window.lt.docWarp.save({ sourcePath: path, outputs, sidecar: JSON.stringify(sidecar, null, 1) })
      setSaved(result)
      setRegions((rs) => rs.map((r) => ({ ...r, weak: [false, false, false, false] })))
      setNotice(`보정이미지/에 ${result.files.length}개 저장했습니다. 꼭짓점은 다음에 열 때 그대로 불러옵니다.`)
    } catch (e) {
      setNotice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  if (error) {
    return (
      <div className="docwarp">
        <div className="pdf-toolbar"><button className="tb-btn" onClick={onClose}>← 원본 보기</button></div>
        <p className="docwarp-error">문서 펴기를 열 수 없습니다: {error}</p>
      </div>
    )
  }

  const handleR = 7
  const names = outputNames(regions, stem)
  return (
    <div className="docwarp">
      <div className="pdf-toolbar docwarp-toolbar">
        <button className="tb-btn" onClick={onClose} title="보정을 닫고 원본 이미지 보기로">← 원본 보기</button>
        <span className="docwarp-sep" />
        <button className="tb-btn" onClick={addRegion} disabled={!loaded} title="한 사진에서 영역을 하나 더 펴기 (예: 노트 오른쪽 쪽, 신분증)">＋ 사각형 추가</button>
        <button className="tb-btn" onClick={() => void reestimate()} disabled={!loaded || !!busy} title="선택한 사각형의 꼭짓점을 다시 자동 추정">다시 추정</button>
        <label className="docwarp-check" title="조명을 평탄화하고 바탕을 흰색으로 만듭니다. 도장 색은 유지합니다.">
          <input type="checkbox" checked={clean} onChange={(e) => { setClean(e.target.checked); setSaved(null) }} /> 배경 정리
        </label>
        <span className="docwarp-spacer" />
        <button className="tb-btn docwarp-primary" onClick={() => void save()} disabled={!loaded || !!busy} title="사각형마다 직사각형으로 펴서 보정이미지/에 저장">
          {busy || '펴기'}
        </button>
      </div>
      <div className="docwarp-notice">
        {notice}
        {saved && (
          <span className="docwarp-saved">
            {saved.files.map((f) => (
              <button key={f} className="docwarp-link" onClick={() => onOpenFile?.(f)} disabled={!onOpenFile}>{baseName(f)}</button>
            ))}
          </span>
        )}
      </div>
      <div className="docwarp-body">
        <div
          className="docwarp-stage"
          ref={stageRef}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={() => setSelected(null)}
        >
          {!loaded && <div className="docwarp-loading">사진을 여는 중…</div>}
          {loaded && fit && (
            <>
              <canvas ref={canvasRef} className="docwarp-canvas" style={{ left: fit.left, top: fit.top, width: fit.w, height: fit.h }} />
              <svg className="docwarp-overlay" style={{ left: fit.left, top: fit.top, width: fit.w, height: fit.h }} viewBox={`0 0 ${loaded.width} ${loaded.height}`}>
                {regions.map((r, ri) => {
                  const color = COLORS[ri % COLORS.length]
                  const on = ri === active
                  const pts = r.quad.map((p) => `${p.x},${p.y}`).join(' ')
                  const c = r.quad.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 })
                  return (
                    <g key={r.id} className={on ? 'on' : ''}>
                      <polygon
                        points={pts}
                        fill={on ? `${color}22` : `${color}0d`}
                        stroke={color}
                        strokeWidth={(on ? 2.5 : 1.5) / fit.scale}
                        className="docwarp-poly"
                        onPointerDown={(e) => onPointerDown(e, ri, 'all')}
                      />
                      <text x={c.x} y={c.y} fontSize={14 / fit.scale} fill={color} textAnchor="middle" dominantBaseline="middle" className="docwarp-label">
                        {ri + 1}
                      </text>
                      {r.quad.map((p, k) => {
                        const isSel = selected?.region === ri && selected.corner === k
                        return (
                          <g key={k}>
                            <circle cx={p.x} cy={p.y} r={(handleR + 7) / fit.scale} fill="transparent" className="docwarp-hit" onPointerDown={(e) => onPointerDown(e, ri, k)}>
                              <title>{`${ri + 1}번 ${CORNER_LABEL[k]}${r.weak[k] ? ' — 먼저 확인할 점' : ''}`}</title>
                            </circle>
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={(isSel ? handleR + 2 : handleR) / fit.scale}
                              fill={r.weak[k] ? WEAK : color}
                              stroke={isSel ? '#fff' : '#000'}
                              strokeWidth={(isSel ? 2.5 : 1.2) / fit.scale}
                              pointerEvents="none"
                            />
                          </g>
                        )
                      })}
                    </g>
                  )
                })}
              </svg>
              {pointer && drag && drag.corner !== 'all' && (
                <canvas
                  ref={loupeRef}
                  className="docwarp-loupe"
                  style={{
                    width: LOUPE,
                    height: LOUPE,
                    left: pointer.x + 24 + LOUPE > stage.w ? pointer.x - 24 - LOUPE : pointer.x + 24,
                    top: pointer.y - 24 - LOUPE < 0 ? pointer.y + 24 : pointer.y - 24 - LOUPE
                  }}
                />
              )}
            </>
          )}
        </div>
        <aside className="docwarp-side">
          <div className="docwarp-side-title">펴기 결과 미리보기</div>
          {regions.map((r, i) => (
            <div key={r.id} className={`docwarp-item ${i === active ? 'on' : ''}`} onClick={() => setActive(i)}>
              <div className="docwarp-item-head">
                <span className="docwarp-swatch" style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
                <input
                  className="docwarp-name"
                  value={r.name}
                  placeholder={names[i]}
                  onChange={(e) => { const name = e.target.value; setRegions((rs) => rs.map((x, k) => (k === i ? { ...x, name } : x))); setSaved(null) }}
                  title="저장할 파일 이름 (확장자 .jpg는 자동). 비우면 원본 이름을 씁니다."
                />
                {regions.length > 1 && (
                  <button className="docwarp-remove" title="이 사각형 삭제" onClick={(e) => { e.stopPropagation(); removeRegion(i) }}>×</button>
                )}
              </div>
              <select
                className="docwarp-ratio"
                value={r.ratio}
                onChange={(e) => { const ratio = e.target.value as WarpRatio; setRegions((rs) => rs.map((x, k) => (k === i ? { ...x, ratio } : x))); setSaved(null) }}
                title="출력 비율. 신분증을 고르면 85.6:54로 고정합니다."
              >
                {(Object.keys(RATIO_LABEL) as WarpRatio[]).map((k) => <option key={k} value={k}>{RATIO_LABEL[k]}</option>)}
              </select>
              {previews[r.id] ? <img className="docwarp-preview" src={previews[r.id]} alt="" draggable={false} /> : <div className="docwarp-preview empty" />}
              {r.weak.some(Boolean) && <div className="docwarp-hint">주황 점 {r.weak.filter(Boolean).length}개를 확인하세요</div>}
            </div>
          ))}
          <p className="docwarp-help">
            점을 끌어 종이 모서리에 맞춥니다. 끄는 동안 돋보기가 뜹니다. 점을 누른 뒤 화살표 키로 1px씩(Shift 10px) 옮길 수 있습니다.
          </p>
        </aside>
      </div>
    </div>
  )
}
