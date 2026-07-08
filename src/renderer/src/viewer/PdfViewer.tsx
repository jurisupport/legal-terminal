import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { parseRecordOutline, type ParsedRecord } from './recordOutline'

export type PdfZoomMode = 'fit_page' | 'fit_width' | 'custom'
export interface PdfViewStatus {
  path: string
  page: number
  pages: number
  zoomPct: number
  zoomMode: PdfZoomMode
  rotation: number
  cropOn: boolean
  cropRatio: number
}
const CROP_OPTIONS = [0.05, 0.1, 0.15, 0.2, 0.25]
const WHEEL_SCROLL_SENSITIVITY = 0.45
const WHEEL_PAGE_TURN_THRESHOLD_PX = 90
const WHEEL_PAGE_TURN_LOCK_MS = 450
const isRemotePath = (p: string): boolean => p.startsWith('ssh://')
const isLocalCloudPath = (p: string): boolean =>
  p.includes('/OneDrive/') || p.includes('/Library/CloudStorage/OneDrive')
type PasswordPrompt = { reason: 'need' | 'incorrect' }
const PDF_PAN_EXCLUDE_SELECTOR =
  'input, textarea, button, select, a, [contenteditable="true"], .pdf-password'

function cleanPdfError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

function resolveDefault(pdfZoom?: string): { mode: PdfZoomMode; scale: number } {
  if (pdfZoom === 'fit_width') return { mode: 'fit_width', scale: 1 }
  if (pdfZoom === 'fit_page' || !pdfZoom) return { mode: 'fit_page', scale: 1 }
  const n = parseInt(pdfZoom, 10)
  if (!Number.isNaN(n)) return { mode: 'custom', scale: n / 100 }
  return { mode: 'fit_page', scale: 1 }
}

function wheelDeltaPixels(e: WheelEvent): { x: number; y: number } {
  const unit =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 40
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1
  return { x: e.deltaX * unit, y: e.deltaY * unit }
}

function createPdfWorker(): pdfjs.PDFWorker {
  const port = new PdfJsWorker({ name: 'pdfjs-worker' })
  return new pdfjs.PDFWorker({
    port
  } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0])
}

/**
 * 전자소송기록 PDF 뷰어 (viewer-windows pdf_frame.py 포팅).
 * 배율: 쪽맞춤/폭맞춤/프리셋·회전·Ctrl 줌. 입력: 휠=페이지넘김, Ctrl+휠=줌,
 * ↑↓=스크롤(끝에서 페이지넘김), ←→/PageUp·Down=페이지, 드래그=팬. 여백 자르기(crop).
 */
export default function PdfViewer({
  path,
  onOutline,
  jumpTo,
  onNextDoc,
  onPrevDoc,
  cropOn,
  cropRatio,
  onCropOn,
  onCropRatio,
  onAskDoc,
  initialStatus,
  onStatus
}: {
  path: string
  onOutline?: (path: string, parsed: ParsedRecord) => void
  jumpTo?: { page: number; nonce: number }
  onNextDoc?: () => void // 마지막 페이지에서 다음 문서로
  onPrevDoc?: () => void // 첫 페이지에서 이전 문서로
  cropOn: boolean // 여백 자르기 (앱 전역 유지)
  cropRatio: number
  onCropOn: (v: boolean) => void
  onCropRatio: (r: number) => void
  onAskDoc?: () => void // 이 문서에 대해 Claude에 묻기 (선택 없이)
  initialStatus?: PdfViewStatus
  onStatus?: (status: PdfViewStatus) => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const taskRef = useRef<RenderTask | null>(null)
  const numPagesRef = useRef(0)
  const pageRef = useRef(1)
  const modeRef = useRef<PdfZoomMode>('fit_page')
  const effScaleRef = useRef(1) // 현재 화면에 그려진 실효 배율 (맞춤 모드 포함)
  const nextDocRef = useRef<(() => void) | undefined>(onNextDoc)
  const prevDocRef = useRef<(() => void) | undefined>(onPrevDoc)
  const initialStatusRef = useRef<PdfViewStatus | undefined>(initialStatus)
  const passwordCallbackRef = useRef<((password: string) => void) | null>(null)
  const wrapSizeRef = useRef('')

  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [mode, setMode] = useState<PdfZoomMode>('fit_page')
  const [customScale, setCustomScale] = useState(1.0)
  const [rotation, setRotation] = useState(0)
  const [panMode, setPanMode] = useState(true)
  const [effPct, setEffPct] = useState(100)
  const [wrapTick, setWrapTick] = useState(0)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null)
  const [passwordValue, setPasswordValue] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  const scrollToPageStart = useCallback((): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    wrap.scrollTop = 0
  }, [])

  numPagesRef.current = numPages
  pageRef.current = page
  modeRef.current = mode
  nextDocRef.current = onNextDoc
  prevDocRef.current = onPrevDoc
  initialStatusRef.current = initialStatus

  useEffect(() => {
    onStatus?.({
      path,
      page,
      pages: numPages,
      zoomPct: effPct,
      zoomMode: mode,
      rotation,
      cropOn,
      cropRatio
    })
  }, [cropOn, cropRatio, effPct, mode, numPages, onStatus, page, path, rotation])

  // 마지막/첫 페이지 경계에서 다음/이전 문서로 이동. 버튼 클릭 후에도 키보드가 먹도록 뷰어에 포커스 복원.
  // 로딩 중(numPages=0)엔 무시 — 새 문서가 뜨기 전 입력이 다음다음 문서로 건너뛰는 것 방지.
  const goPrev = useCallback(() => {
    wrapRef.current?.focus()
    if (numPagesRef.current === 0) return
    if (pageRef.current <= 1) prevDocRef.current?.()
    else {
      scrollToPageStart()
      setPage((p) => Math.max(1, p - 1))
    }
  }, [scrollToPageStart])
  const goNext = useCallback(() => {
    wrapRef.current?.focus()
    if (numPagesRef.current === 0) return
    if (pageRef.current >= numPagesRef.current) nextDocRef.current?.()
    else {
      scrollToPageStart()
      setPage((p) => Math.min(numPagesRef.current, p + 1))
    }
  }, [scrollToPageStart])

  useEffect(() => {
    window.lt.settings.get().then((s) => {
      const d = resolveDefault(s.pdfZoom)
      setMode(d.mode)
      setCustomScale(d.scale)
    })
  }, [])

  useEffect(() => {
    if (!isRemotePath(path)) return
    let alive = true
    let lastSig = ''
    const tick = (): void => {
      window.lt.fs
        .stat(path)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = `${s.size}:${s.mtimeMs ?? 0}`
          if (lastSig && sig !== lastSig) setReloadNonce((n) => n + 1)
          lastSig = sig
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path])

  // 문서 로드
  useEffect(() => {
    let cancelled = false
    const initialPage =
      initialStatusRef.current?.path === path && Number.isFinite(initialStatusRef.current.page)
        ? Math.max(1, Math.floor(initialStatusRef.current.page))
        : 1
    const initialRotation =
      initialStatusRef.current?.path === path && Number.isFinite(initialStatusRef.current.rotation)
        ? ((Math.floor(initialStatusRef.current.rotation / 90) * 90) % 360 + 360) % 360
        : 0
    setErr('')
    setLoading(true)
    setNumPages(0)
    setPage(initialPage)
    setRotation(initialRotation)
    setPasswordPrompt(null)
    setPasswordValue('')
    setPasswordBusy(false)
    passwordCallbackRef.current = null
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null
    window.lt.fs
      .readBytes(path)
      .then(async (ab) => {
        loadingTask = pdfjs.getDocument({ data: new Uint8Array(ab), worker: createPdfWorker() })
        loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
          if (cancelled) return
          passwordCallbackRef.current = (password: string): void => {
            setPasswordBusy(true)
            updatePassword(password)
          }
          setPasswordPrompt({
            reason:
              reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'need'
          })
          setPasswordBusy(false)
          setLoading(false)
        }
        const doc = await loadingTask.promise
        if (cancelled) {
          doc.destroy()
          return
        }
        docRef.current = doc
        passwordCallbackRef.current = null
        setPasswordPrompt(null)
        setPasswordBusy(false)
        setPage(Math.min(initialPage, doc.numPages))
        setNumPages(doc.numPages)
        setLoading(false)
        if (onOutline) {
          parseRecordOutline(doc)
            .then((parsed) => {
              if (!cancelled) onOutline(path, parsed)
            })
            .catch(() => {})
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(cleanPdfError(e))
          setLoading(false)
          setPasswordPrompt(null)
          setPasswordBusy(false)
          passwordCallbackRef.current = null
        }
      })
    return () => {
      cancelled = true
      void loadingTask?.destroy()
      taskRef.current?.cancel()
      docRef.current?.destroy()
      docRef.current = null
      passwordCallbackRef.current = null
    }
  }, [path, reloadNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loading || (!isRemotePath(path) && !isLocalCloudPath(path))) {
      setLoadingSeconds(0)
      return
    }
    setLoadingSeconds(0)
    const timer = setInterval(() => setLoadingSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [loading, path])

  // 현재 페이지 렌더 (배율/회전/여백자르기 반영)
  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || numPages === 0) return
    let cancelled = false
    ;(async () => {
      const pg = await doc.getPage(page)
      if (cancelled) return
      const base = pg.getViewport({ scale: 1, rotation })
      const r = cropOn ? cropRatio : 0
      const contentW = base.width * (1 - 2 * r)
      const contentH = base.height * (1 - 2 * r)

      let scale = customScale
      if (mode === 'fit_width' || mode === 'fit_page') {
        const wrap = wrapRef.current
        let availW = contentW
        let availH = contentH
        if (wrap) {
          const style = window.getComputedStyle(wrap)
          availW = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          availH = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          if (availW <= 0 || availH <= 0) return
        }
        const sW = availW / contentW
        const sH = availH / contentH
        scale = mode === 'fit_width' ? sW : Math.min(sW, sH)
      }
      scale = Math.max(0.1, Math.min(scale, 6))
      effScaleRef.current = scale
      setEffPct(Math.round(scale * 100))

      const viewport = pg.getViewport({ scale, rotation })
      const cropX = viewport.width * r
      const cropY = viewport.height * r
      const visW = Math.floor(viewport.width - 2 * cropX)
      const visH = Math.floor(viewport.height - 2 * cropY)

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(visW * dpr)
      canvas.height = Math.floor(visH * dpr)
      canvas.style.width = `${visW}px`
      canvas.style.height = `${visH}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (r > 0) ctx.translate(-cropX, -cropY) // 여백만큼 이동시켜 잘라냄

      taskRef.current?.cancel()
      const task = pg.render({ canvasContext: ctx, viewport })
      taskRef.current = task
      try {
        await task.promise
      } catch {
        /* 취소 무시 */
      }

      // 텍스트 레이어 (드래그 선택 가능)
      const tl = textLayerRef.current
      if (tl && !cancelled) {
        tl.replaceChildren()
        tl.style.setProperty('--scale-factor', String(scale))
        tl.style.width = `${Math.floor(viewport.width)}px`
        tl.style.height = `${Math.floor(viewport.height)}px`
        tl.style.transform = r > 0 ? `translate(${-cropX}px, ${-cropY}px)` : ''
        try {
          const textContent = await pg.getTextContent()
          if (cancelled) return
          const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: tl, viewport })
          await textLayer.render()
        } catch {
          /* 텍스트 없는 페이지 무시 */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [page, mode, customScale, rotation, cropOn, cropRatio, numPages, wrapTick])

  // 컨테이너 리사이즈 → 맞춤 재계산
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const updateSize = (): void => {
      const key = `${wrap.clientWidth}x${wrap.clientHeight}`
      if (key === wrapSizeRef.current) return
      wrapSizeRef.current = key
      setWrapTick((t) => t + 1)
    }
    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // 외부 페이지 점프
  useEffect(() => {
    if (jumpTo && jumpTo.page > 0)
      setPage(Math.min(Math.max(1, jumpTo.page), numPagesRef.current || jumpTo.page))
  }, [jumpTo?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // 맞춤 모드에서 줌을 시작하면 화면에 보이는 실효 배율에서 이어간다.
  // (이전엔 내부 customScale(기본 100%)에서 시작해, 쪽맞춤 배율이 100%를 넘는
  // 가로문서·큰 화면에서 확대를 눌러도 처음 크기 근처로만 그려졌다.)
  const zoomBy = useCallback((factor: number) => {
    const fromFit = modeRef.current !== 'custom'
    modeRef.current = 'custom'
    setMode('custom')
    setCustomScale((s) => {
      const base = fromFit ? effScaleRef.current : s
      return Math.max(0.1, Math.min(6, +(base * factor).toFixed(3)))
    })
  }, [])

  // 휠: Ctrl+휠=줌, 확대 시 가로/세로 스크롤, 끝에서는 페이지 넘김.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let pageTurnDelta = 0
    let pageTurnLocked = false
    let unlockTimer: ReturnType<typeof setTimeout> | null = null
    const lockPageTurn = (): void => {
      pageTurnDelta = 0
      if (unlockTimer) clearTimeout(unlockTimer)
      pageTurnLocked = true
      unlockTimer = setTimeout(() => {
        pageTurnLocked = false
        unlockTimer = null
      }, WHEEL_PAGE_TURN_LOCK_MS)
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault()
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        return
      }

      const delta = wheelDeltaPixels(e)
      const verticalDelta = delta.y * WHEEL_SCROLL_SENSITIVITY
      const horizontalDelta =
        e.shiftKey && Math.abs(delta.x) < Math.abs(delta.y) ? verticalDelta : delta.x * WHEEL_SCROLL_SENSITIVITY
      const hasHorizontalIntent =
        Math.abs(horizontalDelta) > 0.5 && Math.abs(horizontalDelta) >= Math.abs(verticalDelta)
      const canScrollX = wrap.scrollWidth > wrap.clientWidth + 1

      if (hasHorizontalIntent) {
        e.preventDefault()
        if (canScrollX) wrap.scrollLeft += horizontalDelta
        pageTurnDelta = 0
        return
      }

      const canScrollY = wrap.scrollHeight > wrap.clientHeight + 1
      if (canScrollY && Math.abs(verticalDelta) > 0.5) {
        const maxTop = wrap.scrollHeight - wrap.clientHeight
        const nextTop = Math.max(0, Math.min(maxTop, wrap.scrollTop + verticalDelta))
        if (nextTop !== wrap.scrollTop) {
          e.preventDefault()
          wrap.scrollTop = nextTop
          pageTurnDelta = 0
          return
        }
      }

      e.preventDefault()
      if (pageTurnLocked) {
        if (Math.abs(delta.y) > 0.5) lockPageTurn()
        return
      }
      if (Math.abs(delta.y) <= 0.5) return

      if (pageTurnDelta !== 0 && Math.sign(delta.y) !== Math.sign(pageTurnDelta)) {
        pageTurnDelta = 0
      }
      pageTurnDelta += delta.y
      if (Math.abs(pageTurnDelta) < WHEEL_PAGE_TURN_THRESHOLD_PX) return

      if (pageTurnDelta < 0) goPrev()
      else goNext()
      lockPageTurn()
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (unlockTimer) clearTimeout(unlockTimer)
      wrap.removeEventListener('wheel', onWheel)
    }
  }, [zoomBy, goPrev, goNext])

  // 드래그 팬 (확대 시 스크롤 이동)
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let dragging = false
    let sx = 0
    let sy = 0
    let sl = 0
    let st = 0
    const finishDrag = (): void => {
      dragging = false
      wrap.classList.remove('grabbing')
    }
    const down = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(PDF_PAN_EXCLUDE_SELECTOR)) return
      // 손 도구가 꺼져 있으면 텍스트 레이어 위 드래그는 텍스트 선택으로 둔다.
      if (!panMode && target?.closest('.textLayer')) return
      dragging = true
      sx = e.clientX
      sy = e.clientY
      sl = wrap.scrollLeft
      st = wrap.scrollTop
      wrap.classList.add('grabbing')
      if (panMode) e.preventDefault()
    }
    const move = (e: MouseEvent): void => {
      if (!dragging) return
      e.preventDefault()
      wrap.scrollLeft = sl - (e.clientX - sx)
      wrap.scrollTop = st - (e.clientY - sy)
    }
    const onSelectStart = (e: Event): void => {
      const target = e.target instanceof Element ? e.target : null
      if (panMode && target?.closest('.textLayer')) e.preventDefault()
    }
    const onDragStart = (e: DragEvent): void => {
      const target = e.target instanceof Element ? e.target : null
      if (!target?.closest('.pdf-page')) return
      e.preventDefault()
      e.stopPropagation()
      finishDrag()
    }
    wrap.addEventListener('mousedown', down)
    wrap.addEventListener('selectstart', onSelectStart)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', finishDrag)
    window.addEventListener('blur', finishDrag)
    document.addEventListener('dragstart', onDragStart, true)
    return () => {
      wrap.removeEventListener('mousedown', down)
      wrap.removeEventListener('selectstart', onSelectStart)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', finishDrag)
      window.removeEventListener('blur', finishDrag)
      document.removeEventListener('dragstart', onDragStart, true)
      finishDrag()
    }
  }, [panMode])

  // 키보드 (뷰어 영역 포커스 시)
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (e.ctrlKey) {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBy(1.1)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomBy(1 / 1.1)
      }
      return
    }
    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        goPrev()
        break
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault()
        goNext()
        break
      case 'ArrowUp':
        if (wrap.scrollTop <= 0) {
          e.preventDefault()
          goPrev()
        } else {
          e.preventDefault()
          wrap.scrollTop -= 60
        }
        break
      case 'ArrowDown':
        if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 1) {
          e.preventDefault()
          goNext()
        } else {
          e.preventDefault()
          wrap.scrollTop += 60
        }
        break
      case 'Home':
        e.preventDefault()
        setPage(1)
        break
      case 'End':
        e.preventDefault()
        setPage(numPagesRef.current)
        break
    }
  }

  const submitPassword = (e: React.FormEvent): void => {
    e.preventDefault()
    const password = passwordValue
    if (!password || !passwordCallbackRef.current) return
    passwordCallbackRef.current(password)
  }

  if (err)
    return (
      <div className="welcome">
        <p className="muted">PDF 열기 실패: {err}</p>
      </div>
    )

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button className="tb-btn" onClick={goPrev} disabled={page <= 1} title="이전 페이지">
          ◀
        </button>
        <input
          className="pdf-page-input"
          value={page}
          onChange={(e) => {
            const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
            if (!Number.isNaN(n)) setPage(Math.min(Math.max(1, n), numPages || 1))
          }}
        />
        <span className="tb-sep-text">/ {numPages || '…'}</span>
        <button
          className="tb-btn"
          onClick={goNext}
          disabled={numPages === 0 || page >= numPages}
          title="다음 페이지"
        >
          ▶
        </button>

        <span className="tb-divider" />

        <button className={`tb-btn ${mode === 'fit_page' ? 'on' : ''}`} title="쪽 맞춤" onClick={() => setMode('fit_page')}>
          쪽
        </button>
        <button className={`tb-btn ${mode === 'fit_width' ? 'on' : ''}`} title="폭 맞춤" onClick={() => setMode('fit_width')}>
          폭
        </button>
        <button className="tb-btn" onClick={() => zoomBy(1 / 1.1)} title="축소">
          －
        </button>
        <button className="tb-btn pct" title="100%로" onClick={() => { setMode('custom'); setCustomScale(1) }}>
          {effPct}%
        </button>
        <button className="tb-btn" onClick={() => zoomBy(1.1)} title="확대">
          ＋
        </button>

        <button
          className={`tb-btn ${panMode ? 'on' : ''}`}
          title={panMode ? '손 도구 켜짐' : '손 도구'}
          onClick={() => setPanMode((v) => !v)}
        >
          손
        </button>

        <span className="tb-divider" />

        <button className={`tb-btn ${cropOn ? 'on' : ''}`} title="여백 자르기 (전체 문서 적용)" onClick={() => onCropOn(!cropOn)}>
          ✂
        </button>
        {cropOn && (
          <>
            <button
              className="tb-btn"
              title="여백 비율 감소"
              onClick={() =>
                onCropRatio(CROP_OPTIONS[Math.max(0, CROP_OPTIONS.indexOf(cropRatio) - 1)] ?? cropRatio)
              }
            >
              －
            </button>
            <span className="tb-pct">{Math.round(cropRatio * 100)}%</span>
            <button
              className="tb-btn"
              title="여백 비율 증가"
              onClick={() =>
                onCropRatio(
                  CROP_OPTIONS[Math.min(CROP_OPTIONS.length - 1, CROP_OPTIONS.indexOf(cropRatio) + 1)] ??
                    cropRatio
                )
              }
            >
              ＋
            </button>
          </>
        )}

        <span className="tb-divider" />

        <button className="tb-btn" title="좌회전" onClick={() => setRotation((rot) => (rot + 270) % 360)}>
          ↺
        </button>
        <button className="tb-btn" title="우회전" onClick={() => setRotation((rot) => (rot + 90) % 360)}>
          ↻
        </button>

        <span className="tb-divider" />

        <button
          className="tb-btn"
          title="이 서류를 내 컴퓨터에 저장"
          onClick={() => {
            void window.lt.fs
              .download(path)
              .then((r) => {
                if (!r.canceled && !r.ok) window.alert('다운로드 실패: ' + (r.error ?? '알 수 없는 오류'))
              })
              .catch((e) => window.alert('다운로드 실패: ' + String(e)))
          }}
        >
          ⬇
        </button>

        {onAskDoc && (
          <>
            <span className="tb-divider" />
            <button className="tb-btn tb-ask" title="이 문서에 대해 Claude에 묻기" onClick={onAskDoc}>
              ✳ Claude
            </button>
          </>
        )}
      </div>
      <div
        className={`pdf-canvas-wrap ${mode === 'fit_page' ? 'fit-page' : ''} ${panMode ? 'pannable' : ''}`}
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={() => wrapRef.current?.focus()}
      >
        {passwordPrompt ? (
          <form className="pdf-password" onSubmit={submitPassword}>
            <div className="pdf-password-title">암호가 필요한 PDF입니다</div>
            <div className="pdf-password-sub">
              {passwordPrompt.reason === 'incorrect'
                ? '암호가 맞지 않습니다. 다시 입력하세요.'
                : '문서를 열려면 PDF 암호를 입력하세요.'}
            </div>
            <div className="pdf-password-row">
              <input
                className="pdf-password-input"
                type="password"
                autoFocus
                value={passwordValue}
                disabled={passwordBusy}
                onChange={(e) => setPasswordValue(e.target.value)}
                placeholder="PDF 암호"
              />
              <button
                className="pdf-password-submit"
                type="submit"
                disabled={!passwordValue || passwordBusy}
              >
                열기
              </button>
            </div>
          </form>
        ) : loading ? (
          <div className="pdf-loading">
            <p className="muted pad">
              {(isRemotePath(path) || isLocalCloudPath(path)) && loadingSeconds >= 5
                ? isRemotePath(path)
                  ? '원격 PDF를 내려받는 중…'
                  : 'OneDrive PDF를 내려받는 중…'
                : 'PDF 불러오는 중…'}
            </p>
            {(isRemotePath(path) || isLocalCloudPath(path)) && loadingSeconds >= 10 && (
              <p className="muted pad small">
                {isRemotePath(path)
                  ? 'OneDrive 클라우드 전용 파일이면 원격 Mac에서 다운로드가 끝날 때까지 조금 걸릴 수 있습니다.'
                  : '맥 OneDrive 클라우드 전용 파일이면 다운로드가 끝난 뒤 열립니다.'}
              </p>
            )}
          </div>
        ) : (
          <div className="pdf-page">
            <canvas ref={canvasRef} />
            <div className="textLayer" ref={textLayerRef} />
          </div>
        )}
      </div>
    </div>
  )
}
