import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMediaTime, mediaSelectionKey, type MediaProgress, type MediaSnapshot } from '../../../shared/media'
import type { AgentAttachment } from '../env'
import { attachmentMediaReference, type AgentMediaContext, type AgentMediaReference } from './mediaReferences'
import './AgentMediaPreview.css'

const AUTO_IMAGE_BYTES = 2 * 1024 * 1024
const MANUAL_IMAGE_BYTES = 25 * 1024 * 1024
const sizeText = (size: number): string => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`

export function AgentMediaPreview({ reference, active, onOpen }: {
  reference: AgentMediaReference
  active: boolean
  onOpen?: () => void
}): JSX.Element {
  const { path, kind, label, selection } = reference
  const cardRef = useRef<HTMLElement>(null)
  const playerRef = useRef<HTMLMediaElement | null>(null)
  const mounted = useRef(false)
  const request = useRef<string>()
  const heldSnapshot = useRef<MediaSnapshot>()
  const autoAttempted = useRef(false)
  const [inView, setInView] = useState(false)
  const [size, setSize] = useState<number>()
  const [snapshot, setSnapshot] = useState<MediaSnapshot>()
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<MediaProgress>()
  const [error, setError] = useState('')
  const remote = path.startsWith('ssh://')

  const cancel = useCallback(() => {
    const current = request.current
    request.current = undefined
    if (current) void window.lt.media.cancel(current).catch(() => {})
    setLoading(false)
    setProgress(undefined)
  }, [])

  const load = useCallback(async (automatic = false) => {
    if (request.current || heldSnapshot.current) return
    const requestId = crypto.randomUUID()
    request.current = requestId
    setLoading(true)
    setProgress(undefined)
    setError('')
    let opened: MediaSnapshot | undefined
    try {
      opened = await window.lt.media.open({ path, requestId, versionId: selection?.versionId,
        ...(kind === 'image' ? { maxBytes: automatic ? AUTO_IMAGE_BYTES : MANUAL_IMAGE_BYTES } : {}) })
      if (!mounted.current || request.current !== requestId) return
      heldSnapshot.current = opened
      setSnapshot(opened)
      setSize(opened.size)
      opened = undefined
    } catch (cause) {
      if (mounted.current && request.current === requestId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (opened) void window.lt.media.release(opened.token).catch(() => {})
      if (mounted.current && request.current === requestId) { request.current = undefined; setLoading(false); setProgress(undefined) }
    }
  }, [kind, path, selection?.versionId])

  useEffect(() => {
    mounted.current = true
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.01 })
    if (cardRef.current) observer.observe(cardRef.current)
    const unsubscribe = window.lt.media.onProgress((event) => {
      if (request.current === event.requestId) setProgress(event)
    })
    return () => {
      mounted.current = false
      observer.disconnect()
      unsubscribe()
      playerRef.current?.pause()
      cancel()
      if (heldSnapshot.current) void window.lt.media.release(heldSnapshot.current.token).catch(() => {})
    }
  }, [cancel])

  useEffect(() => {
    if (!active || !inView || size !== undefined) return
    let disposed = false
    const inspect = async (): Promise<void> => {
      try {
        if (selection) {
          const versions = await window.lt.media.versions(path)
          const version = versions.find((item) => item.versionId === selection.versionId)
          if (!disposed && version) setSize(version.size)
        } else {
          const result = await window.lt.fs.stat(path)
          if (!disposed && result.ok && !result.isDir) setSize(result.size)
        }
      } catch { /* The explicit load reports missing or disconnected sources. */ }
    }
    void inspect()
    return () => { disposed = true }
  }, [active, inView, path, selection?.versionId, size])

  useEffect(() => {
    if (!active || !inView) { playerRef.current?.pause(); cancel(); return }
    if (kind === 'image' && size !== undefined && size <= AUTO_IMAGE_BYTES && !autoAttempted.current && !snapshot) {
      autoAttempted.current = true
      void load(true)
    }
  }, [active, inView, kind, size, snapshot, load, cancel])

  const seekSelection = (): void => {
    const player = playerRef.current
    if (!player || !selection) return
    const end = Number.isFinite(player.duration) ? player.duration : selection.time
    player.currentTime = Math.min(end, selection.time)
  }
  const range = selection?.start !== undefined && selection.end !== undefined
    ? `${formatMediaTime(selection.start)}–${formatMediaTime(selection.end)}`
    : selection ? formatMediaTime(selection.time) : ''
  const playerProps = {
    controls: true, preload: 'metadata', src: snapshot?.url,
    onLoadedMetadata: seekSelection,
    onError: () => setError('이 형식은 미리보기로 재생할 수 없습니다. 원본을 열어 확인해 주세요.'),
    onPlay: () => {
      const player = playerRef.current
      if (!player) return
      if (!active || !inView) { player.pause(); return }
      if (selection?.start !== undefined && selection.end !== undefined && (player.currentTime < selection.start || player.currentTime >= selection.end)) player.currentTime = selection.start
    },
    onTimeUpdate: () => {
      const player = playerRef.current
      if (player && selection?.end !== undefined && !player.paused && !player.seeking && player.currentTime >= selection.end) {
        player.pause()
        player.currentTime = Math.min(selection.end, player.duration)
      }
    }
  }

  return <figure ref={cardRef} className="agent-media-preview" data-media-path={path}>
    <figcaption><strong title={path}>{label}</strong><span>{remote ? '원격' : '내 PC'}{size !== undefined ? ` · ${sizeText(size)}` : ' · 크기 확인 전'}{range ? ` · ${range}` : ''}</span></figcaption>
    {snapshot && (kind === 'image'
      ? <img src={snapshot.url} alt={label} onError={() => setError('이 이미지를 표시할 수 없습니다. 원본을 열어 확인해 주세요.')} />
      : kind === 'audio'
        ? <audio ref={(element) => { playerRef.current = element }} {...playerProps} />
        : <video ref={(element) => { playerRef.current = element }} {...playerProps} playsInline />)}
    {!snapshot && <div className="agent-media-placeholder">
      <span>{kind === 'image' ? '이미지 미리보기' : kind === 'audio' ? '오디오 미리보기' : '동영상 미리보기'}</span>
      {remote && <small>{kind === 'image' ? '2 MB 이하 이미지만 자동으로 불러옵니다.' : '불러오면 원격 파일 전체를 내려받습니다.'}</small>}
      {kind === 'image' && size !== undefined && size > MANUAL_IMAGE_BYTES && <small>25 MB를 넘는 이미지는 원본에서 확인해 주세요.</small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {loading && progress && <div className="agent-media-progress"><progress aria-label="미리보기 다운로드" value={progress.downloadedBytes} max={Math.max(1, progress.totalBytes)} /><small>{sizeText(progress.downloadedBytes)} / {sizeText(progress.totalBytes)}</small></div>}
    <div className="agent-media-actions">
      {!snapshot && (loading
        ? <button type="button" onClick={cancel}>불러오는 중 · 취소</button>
        : <button type="button" disabled={!active || (kind === 'image' && size !== undefined && size > MANUAL_IMAGE_BYTES)} onClick={() => void load()}>{error ? '다시 불러오기' : '미리보기 불러오기'}</button>)}
      {onOpen && <button type="button" onClick={onOpen}>원본 열기</button>}
    </div>
  </figure>
}

export function AgentAttachmentMedia({ attachments, context, active, onOpenFile, onOpenSource }: {
  attachments: AgentAttachment[]
  context: AgentMediaContext
  active: boolean
  onOpenFile?: (path: string, title?: string) => void
  onOpenSource?: (attachment: AgentAttachment) => void
}): JSX.Element {
  const seen = new Set<string>()
  return <div className="agent-media-list">{attachments.map((attachment, index) => {
    const reference = attachmentMediaReference(attachment, context)
    if (!reference) return null
    const key = `${reference.path}:${reference.selection ? mediaSelectionKey(reference.selection) : ''}`
    if (seen.has(key)) return null
    seen.add(key)
    return <AgentMediaPreview key={`${key}:${index}`} reference={reference} active={active}
      onOpen={attachment.source && onOpenSource ? () => onOpenSource(attachment) : onOpenFile ? () => onOpenFile(reference.path, reference.label) : undefined} />
  })}</div>
}
