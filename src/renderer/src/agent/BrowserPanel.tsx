import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { BrowserCommand, BrowserFrame, BrowserLocation, BrowserQuality, BrowserState } from '../../../shared/browser'
import type { SshConn } from '../env'
import { isImeComposing } from '../ime'
import './BrowserPanel.css'

interface Props {
  agentSessionId: string
  profileId?: string
  ssh?: SshConn
  visible: boolean
  onClose: () => void
}

function bytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function initialLocation(id: string, remote: boolean): BrowserLocation {
  try {
    const saved = localStorage.getItem(`agent-browser-location:${id}`)
    if (saved === 'local' || (saved === 'remote' && remote)) return saved
  } catch { /* Storage is optional. */ }
  return remote ? 'remote' : 'local'
}

export function BrowserPanel({ agentSessionId, profileId, ssh, visible, onClose }: Props): JSX.Element {
  const remoteAvailable = Boolean(profileId && ssh)
  const [location, setLocation] = useState<BrowserLocation>(() => initialLocation(agentSessionId, remoteAvailable))
  const [session, setSession] = useState<BrowserState | null>(null)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState(false)
  const [reconnect, setReconnect] = useState(0)
  const [quality, setQuality] = useState<BrowserQuality>(() => {
    try { return sessionStorage.getItem(`agent-browser-quality:${agentSessionId}`) === 'standard' ? 'standard' : 'saver' }
    catch { return 'saver' }
  })
  const [paused, setPaused] = useState(() => {
    try { return sessionStorage.getItem(`agent-browser-paused:${agentSessionId}`) === 'true' }
    catch { return false }
  })
  const [rate, setRate] = useState(0)
  const [closing, setClosing] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const liveId = useRef<string | null>(null)
  const generation = useRef(0)
  const commandQueue = useRef(Promise.resolve())
  const framePending = useRef(false)
  const etag = useRef<string>()
  const composing = useRef(false)
  const trafficTotal = useRef(0)
  const lastSessions = useRef<Partial<Record<BrowserLocation, BrowserState>>>({})
  const active = visible

  useEffect(() => {
    try {
      sessionStorage.setItem(`agent-browser-quality:${agentSessionId}`, quality)
      sessionStorage.setItem(`agent-browser-paused:${agentSessionId}`, String(paused))
    } catch { /* Preferences are optional. */ }
  }, [agentSessionId, paused, quality])

  const fail = useCallback((reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason))
    setRate(0)
  }, [])

  const acceptState = useCallback((next: BrowserState): void => {
    if (liveId.current !== next.id) return
    setSession(next)
    lastSessions.current[next.location] = next
    trafficTotal.current = next.traffic.receivedBytes + next.traffic.sentBytes
  }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    generation.current += 1
    liveId.current = null
    setOpening(true)
    setError('')
    setNotice('')
    setSession(lastSessions.current[location] ?? null)
    setFrame(null)
    setRate(0)
    etag.current = undefined
    void window.lt.browser.open({ agentSessionId, location, profileId: location === 'remote' ? profileId : undefined })
      .then((next) => {
        if (cancelled) return
        liveId.current = next.id
        acceptState(next)
      })
      .catch((reason: unknown) => { if (!cancelled) fail(reason) })
      .finally(() => { if (!cancelled) setOpening(false) })
    return () => { cancelled = true; liveId.current = null; generation.current += 1 }
  }, [acceptState, active, agentSessionId, fail, location, profileId, reconnect])

  useEffect(() => {
    if (!active || !session?.id || location !== 'remote') return
    let total = trafficTotal.current
    let at = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      setRate(Math.max(0, trafficTotal.current - total) * 1000 / (now - at))
      total = trafficTotal.current
      at = now
    }, 1000)
    return () => clearInterval(timer)
  }, [active, location, session?.id])

  useEffect(() => { if (session) setAddress(session.url === 'about:blank' ? '' : session.url) }, [session?.url])

  const command = useCallback((request: BrowserCommand): void => {
    const id = liveId.current
    if (!id) return
    const current = generation.current
    commandQueue.current = commandQueue.current.then(async () => {
      if (liveId.current !== id || generation.current !== current) return
      try {
        const next = await window.lt.browser.command(id, request)
        if (generation.current === current) acceptState(next)
      } catch (reason) { if (liveId.current === id && generation.current === current) fail(reason) }
    })
  }, [acceptState, fail])

  const refreshFrame = useCallback(async (): Promise<void> => {
    const id = liveId.current
    if (!id || framePending.current) return
    framePending.current = true
    const current = generation.current
    try {
      const next = await window.lt.browser.frame(id, quality, etag.current)
      if (liveId.current !== id || generation.current !== current) return
      acceptState(next.state)
      etag.current = next.etag
      if (next.dataUrl) setFrame(next)
    } catch (reason) { if (liveId.current === id && generation.current === current) fail(reason) }
    finally { framePending.current = false }
  }, [acceptState, fail, quality])

  useEffect(() => {
    if (!active || opening || !session?.id || location !== 'remote' || paused || error) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await refreshFrame()
      if (!cancelled) timer = setTimeout(() => void poll(), quality === 'saver' ? 2000 : 1000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, error, location, opening, paused, quality, refreshFrame, session?.id])

  useEffect(() => {
    if (!active || opening || !session?.id || location !== 'local' || error) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const id = session.id
    const poll = async (): Promise<void> => {
      try { const next = await window.lt.browser.state(id); if (!cancelled) acceptState(next) }
      catch (reason) { if (!cancelled) fail(reason); return }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [acceptState, active, error, fail, location, opening, session?.id])

  useLayoutEffect(() => {
    if (!session?.id || session.location !== 'local') return
    const id = session.id
    const element = viewport.current
    if (!active || opening || error || session.location !== location || !element) {
      void window.lt.browser.bounds(id, null).catch(fail)
      return
    }
    let cancelled = false
    let lastBounds = ''
    let pendingResize = 0
    const resize = (): void => {
      pendingResize = 0
      const modalVisible = [...document.querySelectorAll<HTMLElement>('.modal-overlay, [role="dialog"][aria-modal="true"]')]
        .some((modal) => modal.getClientRects().length > 0 && getComputedStyle(modal).visibility !== 'hidden')
      const rect = element.getBoundingClientRect()
      const bounds = !modalVisible && rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null
      const key = JSON.stringify(bounds)
      if (key === lastBounds) return
      lastBounds = key
      void window.lt.browser.bounds(id, bounds).catch((reason: unknown) => { if (!cancelled) fail(reason) })
    }
    const scheduleResize = (): void => {
      if (!pendingResize) pendingResize = requestAnimationFrame(resize)
    }
    resize()
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(element)
    // Parent panel dividers can move this viewport without resizing it.
    window.addEventListener('resize', scheduleResize)
    window.addEventListener('scroll', scheduleResize, true)
    // Native views sit above renderer dialogs, so hide them while a modal is visible.
    const modals = new MutationObserver(scheduleResize)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'role', 'aria-modal'] })
    return () => {
      cancelled = true
      observer.disconnect()
      modals.disconnect()
      cancelAnimationFrame(pendingResize)
      window.removeEventListener('resize', scheduleResize)
      window.removeEventListener('scroll', scheduleResize, true)
      void window.lt.browser.bounds(id, null).catch(() => {})
    }
  }, [active, error, fail, location, opening, session?.id, session?.location])

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const rect = image.current?.getBoundingClientRect()
    if (!rect || !frame || rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.min(frame.width - 1, Math.max(0, Math.round((event.clientX - rect.left) * frame.width / rect.width))),
      y: Math.min(frame.height - 1, Math.max(0, Math.round((event.clientY - rect.top) * frame.height / rect.height)))
    }
  }

  const click = (event: MouseEvent<HTMLImageElement>): void => {
    event.preventDefault()
    const position = point(event)
    if (!position || error) return
    input.current?.focus({ preventScroll: true })
    command({ action: 'click', ...position, button: event.button === 2 ? 'right' : 'left', clickCount: Math.min(event.detail || 1, 2) })
  }

  const sendText = (element: HTMLTextAreaElement): void => {
    if (element.value) command({ action: 'type', text: element.value })
    element.value = ''
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    event.stopPropagation()
    if (composing.current || isImeComposing(event)) return
    const shortcut = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (shortcut && key === 'v') return
    if (shortcut && (key === 'c' || key === 'x')) {
      event.preventDefault()
      setNotice('원격 페이지의 복사·잘라내기는 아직 지원하지 않습니다. 붙여넣기는 사용할 수 있습니다.')
      return
    }
    if (shortcut && key === 'l') { event.preventDefault(); addressInput.current?.select(); addressInput.current?.focus(); return }
    if (!shortcut && !event.altKey && event.key.length === 1) return
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return
    // Escape leaves the proxy so keyboard users can reach the surrounding controls.
    if (event.key === 'Escape') { event.preventDefault(); addressInput.current?.focus(); return }
    event.preventDefault()
    command({ action: 'key', key: event.key, code: event.code,
      modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) })
  }

  const changeLocation = (next: BrowserLocation): void => {
    setLocation(next)
    try { localStorage.setItem(`agent-browser-location:${agentSessionId}`, next) } catch { /* Storage is optional. */ }
  }

  const closeBrowser = async (): Promise<void> => {
    const id = session?.id
    if (!id) return
    setClosing(true)
    liveId.current = null
    try {
      await window.lt.browser.close(id)
      if (session) delete lastSessions.current[session.location]
      setSession(null)
      setFrame(null)
      onClose()
    } catch (reason) { liveId.current = id; fail(reason) }
    finally { setClosing(false) }
  }

  const disabled = opening || closing || !session || Boolean(error)
  const total = session ? session.traffic.receivedBytes + session.traffic.sentBytes : 0
  return (
    <section className="agent-browser" aria-label="대화 브라우저" onPaste={(event) => event.stopPropagation()}
      onDragEnter={(event) => event.stopPropagation()} onDragOver={(event) => event.stopPropagation()} onDrop={(event) => { event.preventDefault(); event.stopPropagation() }}>
      <div className="agent-browser-toolbar">
        <label className="agent-browser-location">실행 위치
          <select aria-label="브라우저 실행 위치" value={location} disabled={opening || closing}
            onChange={(event) => changeLocation(event.target.value as BrowserLocation)}>
            <option value="local">내 PC</option>
            <option value="remote" disabled={!remoteAvailable}>원격 서버{ssh ? ` · ${ssh.host}` : ' · SSH 연결 필요'}</option>
          </select>
        </label>
        <button type="button" onClick={() => void closeBrowser()} disabled={!session || opening || closing}>브라우저 종료</button>
      </div>
      <div className="agent-browser-toolbar agent-browser-address">
        <button type="button" aria-label="뒤로" title="뒤로" disabled={disabled} onClick={() => command({ action: 'back' })}>←</button>
        <button type="button" aria-label="앞으로" title="앞으로" disabled={disabled} onClick={() => command({ action: 'forward' })}>→</button>
        <button type="button" aria-label="페이지 새로고침" title="페이지 새로고침" disabled={disabled} onClick={() => command({ action: 'reload' })}>↻</button>
        <form onSubmit={(event) => {
          event.preventDefault()
          const url = address.trim()
          if (!disabled && url) command({ action: 'navigate', url: url.includes('://') || url === 'about:blank' ? url : `https://${url}` })
        }}>
          <input ref={addressInput} aria-label="웹 주소" placeholder="https://example.com" value={address}
            onChange={(event) => setAddress(event.target.value)} disabled={disabled} autoComplete="off" spellCheck={false} />
          <button type="submit" disabled={disabled || !address.trim()}>이동</button>
        </form>
      </div>
      <div className="agent-browser-toolbar">
        <select className="agent-browser-tabs" aria-label="브라우저 탭" value={session?.activeTabId ?? ''}
          disabled={disabled} onChange={(event) => command({ action: 'switch_tab', tabId: event.target.value })}>
          {!session && <option value="">브라우저 준비 중</option>}
          {session?.tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.url || '새 탭'}</option>)}
        </select>
        <button type="button" disabled={disabled} onClick={() => command({ action: 'new_tab', url: 'about:blank' })}>새 탭</button>
        <button type="button" disabled={disabled} onClick={() => session && command({ action: 'close_tab', tabId: session.activeTabId })}>탭 닫기</button>
        {location === 'remote' && <>
          <select aria-label="화면 전송 품질" value={quality} onChange={(event) => setQuality(event.target.value as BrowserQuality)}>
            <option value="saver">데이터 절약 · 2초</option><option value="standard">일반 · 1초</option>
          </select>
          <button type="button" aria-pressed={paused} onClick={() => { setPaused((value) => !value); setRate(0) }}>{paused ? '자동 수신 재개' : '자동 수신 중지'}</button>
          <button type="button" disabled={disabled} onClick={() => void refreshFrame()}>화면 받기</button>
        </>}
      </div>
      {location === 'remote' ? <div className="agent-browser-traffic"
        title="이 브라우저 연결에서 주고받은 데이터입니다. SSH 자체 오버헤드와 다른 앱의 통신은 제외하므로 모바일 요금제의 전체 사용량과 다릅니다.">
        <strong>이번 연결 전송량 {bytes(total)}</strong>
        <span>현재 {bytes(rate)}/초</span>
        <span>↓ {bytes(session?.traffic.receivedBytes ?? 0)} · ↑ {bytes(session?.traffic.sentBytes ?? 0)}</span>
        {paused && <span>자동 화면 수신 중지 · 조작 시 통신 발생</span>}
      </div> : <div className="agent-browser-traffic">웹사이트는 내 PC의 인터넷 연결을 사용합니다.</div>}
      {error && <div className="agent-browser-error" role="alert"><span>{error}</span>
        <button type="button" disabled={opening || closing} onClick={() => setReconnect((value) => value + 1)}>다시 연결</button></div>}
      <div className="agent-browser-viewport" ref={viewport}>
        {opening && <div className="agent-browser-placeholder" role="status">{location === 'remote' ? '원격 브라우저에 연결하는 중…' : '브라우저를 여는 중…'}</div>}
        {!opening && location === 'remote' && !frame && !error && <div className="agent-browser-placeholder">{paused ? '자동 화면 수신이 중지되었습니다. ‘화면 받기’를 누르세요.' : '첫 화면을 기다리는 중…'}</div>}
        {location === 'remote' && frame?.dataUrl && <img ref={image} src={frame.dataUrl} alt="원격 브라우저 화면" draggable={false}
          onClick={click} onContextMenu={click} onWheel={(event) => {
            event.stopPropagation()
            const position = point(event)
            if (!position || error) return
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1
            command({ action: 'scroll', ...position, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit })
          }} />}
      </div>
      {location === 'remote' && <textarea ref={input} className="agent-browser-input" rows={1} disabled={disabled}
        aria-label="원격 페이지 키보드 입력" placeholder="페이지 클릭 후 입력 · 한글·붙여넣기 지원 · Esc로 주소창 이동"
        onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={(event) => { composing.current = false; sendText(event.currentTarget) }}
        onInput={(event) => { if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) sendText(event.currentTarget) }}
        onPaste={(event) => {
          event.preventDefault(); event.stopPropagation()
          const text = event.clipboardData.getData('text/plain')
          if (text) command({ action: 'type', text })
        }} />}
      {notice && <div className="agent-browser-note" role="status">{notice}</div>}
      {session?.downloadPath && <div className="agent-browser-download" title={session.downloadPath}>다운로드: {location === 'local' ? '내 PC' : '원격 서버'} · {session.downloadPath}</div>}
    </section>
  )
}
