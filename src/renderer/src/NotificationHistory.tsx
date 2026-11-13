import { useEffect, useRef } from 'react'

import type { NotificationEntry } from './notificationHistoryStore'

export default function NotificationHistory({ entries, error, onSelect, onClear }: {
  entries: NotificationEntry[]
  error?: string
  onSelect: (entry: NotificationEntry) => void
  onClear: () => void
}): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const details = detailsRef.current
      if (details && !details.contains(event.target as Node)) details.open = false
    }
    const escape = (event: KeyboardEvent): void => {
      const details = detailsRef.current
      if (event.key === 'Escape' && details?.open) {
        details.open = false
        details.querySelector('summary')?.focus()
        event.stopPropagation()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [])

  return (
    <details className="notification-history" ref={detailsRef}>
      <summary className="todo-small" title="알림 히스토리 열어보기">
        알림{entries.length > 0 && <span className="notification-history-count">{entries.length}</span>}
      </summary>
      <section className="notification-history-panel" aria-label="알림 히스토리">
        <header><strong>알림 히스토리</strong><button className="todo-small" disabled={!entries.length} onClick={onClear} title="공유된 기록은 다른 기기에서도 지워집니다">기록 지우기</button></header>
        <p className="notification-history-note">최근 100개 자동 저장 · 같은 서버의 기록은 기기 간 공유됩니다</p>
        {error && <p className="notification-history-note" role="alert">{error}</p>}
        {entries.length === 0 ? <p className="notification-history-empty">아직 받은 알림이 없습니다.</p> : (
          <ul>{entries.map((entry) => (
            <li key={JSON.stringify([entry.host, entry.id])}>
              <button className="notification-history-entry" disabled={!entry.termId} onClick={() => {
                onSelect(entry)
                if (detailsRef.current) detailsRef.current.open = false
              }}>
                <span className={`notification-history-icon ${entry.status}`} aria-hidden="true">{entry.status === 'question' ? '?' : entry.status === 'synced' ? '+' : '✓'}</span>
                <span className="notification-history-body">
                  <strong>{entry.title}</strong>
                  <span>{entry.status === 'question' ? '확인/입력을 기다립니다' : entry.status === 'synced' ? '다른 기기에서 열린 탭입니다' : '작업이 완료되었습니다'}</span>
                  <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString('ko-KR')}</time>
                </span>
              </button>
            </li>
          ))}</ul>
        )}
      </section>
    </details>
  )
}
