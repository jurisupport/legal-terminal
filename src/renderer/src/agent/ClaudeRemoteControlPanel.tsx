import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { normalizeClaudeRemoteControlUrl, type RemoteControlConnection } from '../../../shared/claudeRemoteControl'
import './ClaudeRemoteControlPanel.css'

interface Props {
  connection?: RemoteControlConnection
  visible: boolean
  onOpen: (connection?: RemoteControlConnection) => void
  onRemove: (id: string) => void
}

export function ClaudeRemoteControlPanel({ connection, visible, onOpen, onRemove }: Props): JSX.Element {
  const [connections, setConnections] = useState<RemoteControlConnection[]>([])
  const [editingId, setEditingId] = useState('')
  const [label, setLabel] = useState('원격2')
  const [url, setUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (connection || !visible) return
    let cancelled = false
    void window.lt.settings.get().then(settings => {
      if (cancelled) return
      setConnections(settings.claudeRemoteConnections ?? [])
      setLoaded(true)
      setError('')
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [connection, visible, revision])

  useEffect(() => {
    if (!connection) return
    let cancelled = false
    setReady(false)
    setError('')
    void window.lt.claudeRemoteControl.open({ id: connection.id, url: connection.url })
      .then(() => { if (!cancelled) setReady(true) })
      .catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => {
      cancelled = true
      void window.lt.claudeRemoteControl.close(connection.id).catch(() => {})
    }
  }, [connection?.id, connection?.url, revision])

  useLayoutEffect(() => {
    if (!connection || !ready) return
    const id = connection.id
    const element = viewport.current
    if (!visible || !element || error) {
      void window.lt.claudeRemoteControl.bounds(id, null).catch(() => {})
      return
    }
    let pending = 0
    let lastBounds = ''
    let cancelled = false
    const resize = (): void => {
      pending = 0
      const overlay = [...document.querySelectorAll<HTMLElement>('.modal-overlay, [aria-modal="true"], .tab-context-menu')]
        .some(item => item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden')
      const rect = element.getBoundingClientRect()
      const bounds = !overlay && rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null
      const key = JSON.stringify(bounds)
      if (key === lastBounds) return
      lastBounds = key
      void window.lt.claudeRemoteControl.bounds(id, bounds)
        .catch(reason => { if (!cancelled) setError(String(reason)) })
    }
    const schedule = (): void => { if (!pending) pending = requestAnimationFrame(resize) }
    resize()
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-modal'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      cancelled = true
      cancelAnimationFrame(pending)
      observer.disconnect()
      overlays.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      void window.lt.claudeRemoteControl.bounds(id, null).catch(() => {})
    }
  }, [connection?.id, ready, visible, error])

  const openOfficialPage = (address: string): void => {
    try {
      const safeUrl = normalizeClaudeRemoteControlUrl(address)
      void window.lt.app.openExternal(safeUrl).catch(reason => setError(String(reason)))
    } catch (reason) { setError(String(reason)) }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const name = label.trim()
      if (!name) throw new Error('연결 이름을 입력해 주세요.')
      const next = { id: editingId || crypto.randomUUID(), label: name, url: normalizeClaudeRemoteControlUrl(url) }
      const settings = await window.lt.settings.get()
      const saved = await window.lt.settings.set({ claudeRemoteConnections: [
        ...(settings.claudeRemoteConnections ?? []).filter(item => item.id !== next.id), next
      ] })
      setConnections(saved.claudeRemoteConnections ?? [])
      setEditingId('')
      setLabel('원격2')
      setUrl('')
      onOpen(next)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const settings = await window.lt.settings.get()
      const saved = await window.lt.settings.set({ claudeRemoteConnections: (settings.claudeRemoteConnections ?? []).filter(item => item.id !== id) })
      setConnections(saved.claudeRemoteConnections ?? [])
      if (editingId === id) { setEditingId(''); setLabel('원격2'); setUrl('') }
      onRemove(id)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  if (connection) return <section className="claude-remote-panel" aria-label={`${connection.label} 원격 제어`}>
    <div className="claude-remote-toolbar">
      <strong>{connection.label}</strong><span>Claude Remote Control</span>
      <button type="button" onClick={() => setRevision(value => value + 1)}>다시 연결</button>
      <button type="button" onClick={() => openOfficialPage(connection.url)}>외부 브라우저</button>
      <button type="button" onClick={() => onOpen()}>연결 관리</button>
    </div>
    {error && <div className="claude-remote-error" role="alert">{error}</div>}
    <div className="claude-remote-viewport" ref={viewport}>
      {!ready && <p role="status">{error ? '연결 주소와 원격 컴퓨터의 실행 상태를 확인해 주세요.' : 'Claude 공식 화면을 여는 중입니다…'}</p>}
    </div>
  </section>

  return <section className="claude-remote-manager" aria-label="Claude 원격 연결 관리">
    <h2>원격 제어</h2>
    <p>다른 컴퓨터에서 실행 중인 Claude에 연결해 직접 작업을 지시합니다.</p>
    <ol>
      <li>원격 컴퓨터의 작업 폴더에서 <code>claude --remote-control "원격2"</code>를 실행합니다.</li>
      <li>표시된 Claude 연결 주소를 아래에 붙여넣습니다.</li>
      <li>열린 탭에서 원격 컴퓨터와 같은 Claude 계정으로 로그인합니다.</li>
    </ol>
    <p className="claude-remote-note">원격 컴퓨터와 Claude를 켜 두세요. 파일은 해당 컴퓨터에서 작업하며, 다른 컴퓨터와 자동으로 동기화되지 않습니다. 탭을 닫아도 원격 작업은 종료되지 않습니다.</p>
    {error && <div className="claude-remote-error" role="alert">{error}</div>}
    {!loaded && <button type="button" onClick={() => setRevision(value => value + 1)}>연결 목록 다시 불러오기</button>}
    {connections.length > 0 && <ul className="claude-remote-connections">
      {connections.map(item => <li key={item.id}>
        <div><strong>{item.label}</strong><small title={item.url}>{item.url}</small></div>
        <button type="button" disabled={busy} onClick={() => onOpen(item)} aria-label={`${item.label} 열기`}>열기</button>
        <button type="button" disabled={busy} onClick={() => { setEditingId(item.id); setLabel(item.label); setUrl(item.url) }} aria-label={`${item.label} 수정`}>수정</button>
        <button type="button" disabled={busy} onClick={() => { void remove(item.id) }} aria-label={`${item.label} 연결 삭제`}>삭제</button>
      </li>)}
    </ul>}
    <form onSubmit={event => { void save(event) }}>
      <h3>{editingId ? '연결 수정' : '연결 추가'}</h3>
      <label>연결 이름<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="원격2 · Windows" /></label>
      <label>Claude 연결 주소<input required type="url" maxLength={2048} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://claude.ai/code/…" /></label>
      <div className="claude-remote-actions">
        <button type="submit" disabled={!loaded || busy}>{busy ? '저장 중…' : '저장하고 열기'}</button>
        {editingId && <button type="button" disabled={busy} onClick={() => { setEditingId(''); setLabel('원격2'); setUrl('') }}>취소</button>}
        <button type="button" onClick={() => openOfficialPage('https://claude.ai/code')}>Claude에서 연결 찾기</button>
      </div>
    </form>
  </section>
}
