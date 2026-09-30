import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMediaTime, type MediaAskRequest, type MediaChange, type MediaSelection, type MediaSnapshot, type MediaVersion, type MediaViewState } from '../../../shared/media'
import './MediaViewer.css'

type Props = {
  path: string
  active?: boolean
  projectDir?: string
  initialState?: MediaViewState
  reveal?: { selection: MediaSelection; nonce: number }
  onStateChange?: (state: MediaViewState) => void
  onAsk?: (request: MediaAskRequest) => void | 'attached' | 'forwarded' | Promise<void | 'attached' | 'forwarded'>
  onRemotionPreview?: () => void
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function rangeOf(state: MediaViewState): { start: number; end: number } | undefined {
  return Number.isFinite(state.start) && Number.isFinite(state.end) && state.start! >= 0 && state.end! > state.start!
    ? { start: state.start!, end: state.end! } : undefined
}

function versionKey(version: MediaVersion): string {
  return JSON.stringify([version.sourcePath, version.versionId])
}

function boundedState(state: MediaViewState, duration: number): MediaViewState {
  const time = Math.max(0, Math.min(Number.isFinite(state.time) ? state.time! : 0, duration))
  const range = rangeOf(state)
  const start = range ? Math.min(range.start, duration) : undefined
  const end = range ? Math.min(range.end, duration) : undefined
  return { time, ...(start !== undefined && end !== undefined && start < end ? { start, end } : {}) }
}

// Decode the replacement before retiring the version being reviewed.
function prepareMedia(snapshot: MediaSnapshot, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(snapshot.mimeType.startsWith('audio/') ? 'audio' : 'video')
    const finish = (error?: Error): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      element.onloadeddata = null
      element.onerror = null
      element.removeAttribute('src')
      element.load()
      error ? reject(error) : resolve()
    }
    const cancel = (): void => finish(new Error('준비를 취소했습니다.'))
    const timeout = window.setTimeout(() => finish(new Error('미디어 재생 준비가 지연되고 있습니다. 다시 시도해 주세요.')), 30_000)
    element.onloadeddata = () => finish()
    element.onerror = () => finish(new Error('이 파일을 재생할 수 없습니다. MP4(H.264/AAC), WebM, MP3 또는 WAV로 변환해 주세요.'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    element.preload = 'auto'
    element.crossOrigin = 'anonymous'
    element.src = snapshot.url
    element.load()
  })
}

export default function MediaViewer({ path, active: visible = true, projectDir, initialState, reveal, onStateChange, onAsk, onRemotionPreview }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<MediaSnapshot>()
  const [versions, setVersions] = useState<MediaVersion[]>([])
  const [view, setView] = useState<MediaViewState>({})
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ downloadedBytes: number; totalBytes: number }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [change, setChange] = useState<MediaChange>()
  const [loop, setLoop] = useState(false)
  const [rate, setRate] = useState(1)
  const [asking, setAsking] = useState(false)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const snapshotRef = useRef<MediaSnapshot>()
  const viewRef = useRef<MediaViewState>({})
  const retained = useRef<MediaSnapshot[]>([])
  const active = useRef(false)
  const request = useRef<{ id: string; controller: AbortController }>()
  const callbacks = useRef({ onStateChange, onAsk })
  callbacks.current = { onStateChange, onAsk }
  const initialRef = useRef(initialState)
  initialRef.current = initialState
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const pendingPosition = useRef<MediaViewState>()

  const updateView = useCallback((next: MediaViewState) => {
    viewRef.current = next
    setView(next)
    const current = snapshotRef.current
    if (current) callbacks.current.onStateChange?.({ sourcePath: current.sourcePath, versionId: current.versionId, time: next.time ?? 0, ...rangeOf(next) })
  }, [])

  const cancel = useCallback(() => {
    const old = request.current
    request.current = undefined
    if (old) {
      old.controller.abort()
      void window.lt.media.cancel(old.id).catch(() => {})
    }
    setLoading(false)
    setProgress(undefined)
  }, [])

  const load = useCallback(async (sourcePath: string, options: { versionId?: string; force?: boolean } = {}, position?: MediaViewState) => {
    cancel()
    const job = { id: crypto.randomUUID(), controller: new AbortController() }
    request.current = job
    setLoading(true)
    setError('')
    setNotice('')
    let opened: MediaSnapshot | undefined
    const currentJob = (): boolean => active.current && request.current === job
    try {
      opened = await window.lt.media.open({ path: sourcePath, requestId: job.id, ...options })
      if (!currentJob()) return
      await prepareMedia(opened, job.controller.signal)
      if (!currentJob()) return
      const nextPosition = position ?? viewRef.current
      pendingPosition.current = nextPosition
      mediaRef.current?.pause()
      snapshotRef.current = opened
      setSnapshot(opened)
      setDuration(0)
      setChange(undefined)
      setLoop(false)
      // Keep the current and preceding snapshot pinned while comparing, even with persistent caching disabled.
      const keep = [opened, ...retained.current.filter((item) => versionKey(item) !== versionKey(opened!))].slice(0, 2)
      for (const old of retained.current) if (!keep.some((item) => item.token === old.token)) void window.lt.media.release(old.token).catch(() => {})
      retained.current = keep
      const ready = opened
      opened = undefined
      setVersions((old) => [ready, ...old.filter((item) => versionKey(item) !== versionKey(ready))])
      void window.lt.media.versions(sourcePath).then((known) => {
        if (active.current && snapshotRef.current?.token === ready.token) setVersions((old) => {
          const all = new Map([...old, ...known, ready].map((item) => [versionKey(item), item]))
          return [...all.values()].sort((a, b) => b.createdAt - a.createdAt)
        })
      }).catch(() => {})
    } catch (cause) {
      if (currentJob()) setError(errorText(cause))
    } finally {
      if (opened) void window.lt.media.release(opened.token).catch(() => {})
      if (currentJob()) { request.current = undefined; setLoading(false); setProgress(undefined) }
    }
  }, [cancel])

  useEffect(() => {
    active.current = true
    setSnapshot(undefined)
    snapshotRef.current = undefined
    setVersions([])
    setView({})
    viewRef.current = {}
    setDuration(0)
    setChange(undefined)
    if (visibleRef.current) void load(initialRef.current?.sourcePath ?? path, { versionId: initialRef.current?.versionId }, initialRef.current)
    const unsubscribe = window.lt.media.onProgress((event) => {
      if (event.requestId === request.current?.id) setProgress(event)
    })
    return () => {
      active.current = false
      cancel()
      unsubscribe()
      for (const item of retained.current) void window.lt.media.release(item.token).catch(() => {})
      retained.current = []
    }
  }, [path, load, cancel])

  useEffect(() => {
    if (!visible) { mediaRef.current?.pause(); setLoop(false) }
    else if (!snapshotRef.current && !request.current) void load(initialRef.current?.sourcePath ?? path, { versionId: initialRef.current?.versionId }, initialRef.current)
  }, [visible, path, load])

  useEffect(() => {
    if (!reveal) return
    const selection = reveal.selection
    const current = snapshotRef.current
    if (current && current.versionId === selection.versionId && current.sourcePath === selection.sourcePath) {
      pendingPosition.current = selection
      const element = mediaRef.current
      if (element?.readyState) {
        element.pause()
        const next = boundedState(selection, element.duration || 0)
        element.currentTime = next.time!
        updateView(next)
        pendingPosition.current = undefined
      }
    } else void load(selection.sourcePath, { versionId: selection.versionId }, selection)
  }, [reveal?.nonce, path, load, updateView])

  useEffect(() => {
    if (!snapshot || !visible) return
    let disposed = false
    let checking = false
    const check = async (): Promise<void> => {
      if (checking || request.current) return
      checking = true
      try {
        const result = await window.lt.media.check({ path: snapshot.sourcePath, versionId: snapshot.versionId, projectDir })
        if (!disposed) { setChange(result.changed ? result : undefined); setNotice('') }
      } catch {
        if (!disposed) setNotice('새 파일 확인에 연결할 수 없습니다. 내려받은 버전은 계속 재생할 수 있습니다.')
      } finally { checking = false }
    }
    const timer = window.setInterval(() => { void check() }, 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [snapshot, projectDir, visible])

  const metadataReady = (): void => {
    const element = mediaRef.current
    if (!element || !Number.isFinite(element.duration)) return
    setDuration(element.duration)
    element.playbackRate = rate
    const saved = pendingPosition.current ?? viewRef.current
    pendingPosition.current = undefined
    const next = boundedState(saved, element.duration)
    if (element.currentTime !== next.time) element.currentTime = next.time!
    updateView(next)
  }

  const selectPoint = (point: 'start' | 'end', raw: string): void => {
    const value = raw === '' ? undefined : Number(raw)
    const next = { ...viewRef.current, [point]: value }
    if ((value !== undefined && (!Number.isFinite(value) || value < 0 || value > duration)) ||
        (next.start !== undefined && next.end !== undefined && next.start >= next.end)) {
      setError('구간은 0초 이상, 시작 < 끝, 전체 길이 이내로 지정해 주세요.')
      return
    }
    setError('')
    setLoop(false)
    updateView(next)
  }

  const timeUpdated = (): void => {
    const element = mediaRef.current
    if (!element) return
    const range = rangeOf(viewRef.current)
    if (loop && range && (element.currentTime >= range.end || element.currentTime < range.start)) element.currentTime = range.start
    updateView({ ...viewRef.current, time: element.currentTime })
  }

  const ask = async (useRange: boolean): Promise<void> => {
    const element = mediaRef.current
    const source = snapshotRef.current
    if (!element || !source || !callbacks.current.onAsk || asking) return
    element.pause()
    setAsking(true)
    setError('')
    try {
      if (element.seeking) await new Promise<void>((resolve, reject) => {
        const done = (): void => { clearTimeout(timer); element.removeEventListener('seeked', done); resolve() }
        const timer = window.setTimeout(() => { element.removeEventListener('seeked', done); reject(new Error('화면 이동이 끝난 뒤 다시 첨부해 주세요.')) }, 5000)
        element.addEventListener('seeked', done, { once: true })
      })
      if (!active.current || snapshotRef.current?.token !== source.token) return
      const selection: MediaSelection = { sourcePath: source.sourcePath, versionId: source.versionId, time: element.currentTime, ...(useRange ? rangeOf(viewRef.current) : {}) }
      let capture: Uint8Array | undefined
      if (element instanceof HTMLVideoElement) {
        if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !element.videoWidth) throw new Error('화면이 준비된 뒤 다시 첨부해 주세요.')
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 1920 / Math.max(element.videoWidth, element.videoHeight))
        canvas.width = Math.round(element.videoWidth * scale)
        canvas.height = Math.round(element.videoHeight * scale)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('화면 캡처를 만들 수 없습니다.')
        context.drawImage(element, 0, 0, canvas.width, canvas.height)
        selection.captureTime = element.currentTime
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('화면 캡처에 실패했습니다.')), 'image/jpeg', 0.9))
        capture = new Uint8Array(await blob.arrayBuffer())
      }
      if (!active.current || snapshotRef.current?.token !== source.token) return
      const result = await callbacks.current.onAsk({ selection, capture })
      if (active.current && snapshotRef.current?.token === source.token) setNotice(result === 'forwarded'
        ? '선택 내용을 기본 창으로 전달했습니다. 대화창에서 첨부 상태를 확인하세요.'
        : '선택 내용을 대화 입력창에 첨부했습니다. 수정할 내용을 적어 보내세요.')
    } catch (cause) { if (active.current) setError(errorText(cause)) }
    finally { if (active.current) setAsking(false) }
  }

  const range = rangeOf(view)
  const isAudio = snapshot?.mimeType.startsWith('audio/')
  const ready = !!snapshot && duration > 0
  const mediaProps = {
    src: snapshot?.url, crossOrigin: 'anonymous' as const, controls: true, preload: 'auto', onLoadedMetadata: metadataReady, onTimeUpdate: timeUpdated,
    onError: () => setError('재생 중 오류가 발생했습니다. 지원되는 MP4, WebM, MP3 또는 WAV 파일인지 확인해 주세요.'),
    onEnded: () => { if (loop && range && mediaRef.current) { mediaRef.current.currentTime = range.start; void mediaRef.current.play().catch((cause) => setError(errorText(cause))) } }
  }
  return (
    <section className="media-viewer" aria-label="영상 및 음성 리뷰">
      <div className="media-viewer-toolbar">
        <label>리뷰 버전 <select aria-label="리뷰 버전" value={snapshot ? versionKey(snapshot) : ''} disabled={!snapshot || asking} onChange={(event) => {
          const selected = versions.find((item) => versionKey(item) === event.target.value)
          if (selected) void load(selected.sourcePath, { versionId: selected.versionId })
        }}>
          {!snapshot && <option value="">준비 중</option>}
          {versions.map((item) => <option key={versionKey(item)} value={versionKey(item)}>{new Date(item.createdAt).toLocaleString()} · {item.versionId.slice(0, 8)}</option>)}
        </select></label>
        <button type="button" disabled={loading || asking} onClick={() => { void load(snapshot?.sourcePath ?? path, { force: true }) }}>원본 다시 읽기</button>
        {onRemotionPreview && <button type="button" onClick={onRemotionPreview}>Remotion 미리보기</button>}
      </div>
      {loading && <div className="media-viewer-status" role="status">
        <span>{path.startsWith('ssh://') ? '미디어 내려받는 중' : '미디어 준비 중'}{progress ? ` · ${(progress.downloadedBytes / 1048576).toFixed(1)} / ${(progress.totalBytes / 1048576).toFixed(1)} MB` : '…'}</span>
        <progress aria-label="미디어 준비 진행률" max={progress?.totalBytes || 1} value={progress?.totalBytes ? progress.downloadedBytes : undefined} />
        <button type="button" onClick={() => { cancel(); setNotice('준비를 취소했습니다. 다시 읽기로 재시도할 수 있습니다.') }}>취소</button>
      </div>}
      {change?.changed && <div className="media-viewer-status">
        <span>{change.completed ? '완성된 새 버전이 있습니다.' : '원본이 변경되었습니다. 제작이 끝났다면 원본을 다시 읽어 주세요.'}</span>
        {change.completed && <button type="button" disabled={loading || asking} onClick={() => { void load(change.path ?? snapshot?.sourcePath ?? path, { force: true }) }}>새 버전 보기</button>}
      </div>}
      {error && <p className="media-viewer-error" role="alert">{error}</p>}
      {notice && <p className="media-viewer-notice" role="status">{notice}</p>}
      <div className={`media-viewer-stage${isAudio ? ' media-viewer-audio' : ''}`}>
        {snapshot ? isAudio
          ? <><span className="media-viewer-audio-label">음성 리뷰</span><audio key={snapshot.token} ref={(node) => { mediaRef.current = node }} aria-label="음성 재생" {...mediaProps} /></>
          : <video key={snapshot.token} ref={(node) => { mediaRef.current = node }} aria-label="영상 재생" playsInline {...mediaProps} />
          : <p className="media-viewer-placeholder">{loading ? '재생할 파일을 준비하고 있습니다.' : '재생할 파일이 없습니다. 원본 다시 읽기로 재시도해 주세요.'}</p>}
      </div>
      <div className="media-viewer-review">
        <div className="media-viewer-time-row">
          <output aria-label="현재 시각 및 전체 길이">{formatMediaTime(view.time ?? 0)} / {formatMediaTime(duration)}</output>
          <label>재생 속도 <select aria-label="재생 속도" value={rate} onChange={(event) => { const value = Number(event.target.value); setRate(value); if (mediaRef.current) mediaRef.current.playbackRate = value }}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
          </select></label>
          <button type="button" className="media-viewer-ask" disabled={!ready || asking || !onAsk} onClick={() => { void ask(false) }}>{asking ? '첨부 준비 중…' : isAudio ? '이 시점 질문' : '이 장면 질문'}</button>
        </div>
        <div className="media-viewer-range">
          <label>시작(초) <input aria-label="구간 시작 초" type="number" min="0" max={duration} step="0.001" disabled={!ready || asking} value={view.start ?? ''} onChange={(event) => selectPoint('start', event.target.value)} /></label>
          <button type="button" disabled={!ready || asking} onClick={() => {
            const time = mediaRef.current?.currentTime ?? 0
            setError(''); setLoop(false); updateView({ ...viewRef.current, start: time, end: viewRef.current.end !== undefined && viewRef.current.end > time ? viewRef.current.end : undefined })
          }}>구간 시작</button>
          <label>끝(초) <input aria-label="구간 끝 초" type="number" min="0" max={duration} step="0.001" disabled={!ready || asking} value={view.end ?? ''} onChange={(event) => selectPoint('end', event.target.value)} /></label>
          <button type="button" disabled={!ready || asking} onClick={() => {
            if (viewRef.current.start === undefined) updateView({ ...viewRef.current, start: 0 })
            selectPoint('end', String(mediaRef.current?.currentTime ?? 0))
          }}>구간 끝</button>
          <label className="media-viewer-loop"><input type="checkbox" checked={loop} disabled={!range || asking} onChange={(event) => {
            setLoop(event.target.checked)
            if (event.target.checked && range && mediaRef.current) { mediaRef.current.currentTime = range.start; void mediaRef.current.play().catch((cause) => setError(errorText(cause))) }
          }} /> 구간 반복</label>
          <button type="button" disabled={view.start === undefined && view.end === undefined || asking} onClick={() => { setLoop(false); updateView({ time: viewRef.current.time }); setError('') }}>선택 해제</button>
          <button type="button" className="media-viewer-ask" disabled={!range || asking || !onAsk} onClick={() => { void ask(true) }}>이 구간 질문</button>
        </div>
        {range && <p className="media-viewer-notice">선택 {formatMediaTime(range.start)}–{formatMediaTime(range.end)}{!isAudio && ' · 현재 화면 한 장이 함께 첨부됩니다.'}</p>}
        <p className="media-viewer-notice">새 버전은 렌더 완료 기록으로 확인합니다. 직접 덮어쓴 파일은 원본 다시 읽기를 눌러 주세요.</p>
        <p className="media-viewer-source" title={snapshot?.sourcePath ?? path}>{snapshot?.sourcePath ?? path}</p>
      </div>
    </section>
  )
}
