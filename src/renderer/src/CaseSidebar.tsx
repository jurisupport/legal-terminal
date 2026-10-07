import { useEffect, useId, useRef, useState } from 'react'
import type { SessionListEntry } from './env'
import { IconExplorer, IconNewFile, IconSync } from './icons/Icons'
import {
  expandSessionSearchLimit,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_RECENT_LIMIT
} from './search/sessionSearch'
import './CaseSidebar.css'

export interface SidebarTask {
  id: string
  title: string
  mtime: number
  sessionId?: string
  originDevice?: 'android' | 'desktop'
  status?: string
  active?: boolean
}

export interface SidebarCase {
  id: string
  title: string
  participants?: string
  subtitle: string
  active: boolean
  updatedAt: number
  historyKey?: string
  tasks: SidebarTask[]
  unavailable?: boolean
}

interface CaseSidebarProps {
  cases: SidebarCase[]
  onOpenCase: (id: string) => void
  onOpenTask: (caseId: string, task: SidebarTask) => void
  onNewTask: (caseId: string) => void
  onAddCase: () => void
  loadSessions: (caseId: string, limit: number, refresh: boolean) => Promise<SessionListEntry[]>
}

const PERIOD_KEY = 'lt:case-sidebar-days'
const DAY_MS = 24 * 60 * 60 * 1000

function readPeriod(): number {
  try {
    const value = Number(localStorage.getItem(PERIOD_KEY))
    return [7, 14, 30].includes(value) ? value : 7
  } catch {
    return 7
  }
}

function CaseGroup({
  item,
  days,
  onOpenCase,
  onOpenTask,
  onNewTask,
  loadSessions
}: Omit<CaseSidebarProps, 'cases' | 'onAddCase'> & {
  item: SidebarCase
  days: number
}): JSX.Element {
  const listId = useId()
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<SessionListEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [limit, setLimit] = useState(SESSION_SEARCH_RECENT_LIMIT)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [visibleCount, setVisibleCount] = useState(5)
  const [showOlder, setShowOlder] = useState(false)
  const [now, setNow] = useState(Date.now)
  const wasActive = useRef(item.active)
  const handledRefresh = useRef(0)
  const loader = useRef(loadSessions)
  loader.current = loadSessions

  useEffect(() => {
    if (item.active && !wasActive.current) setExpanded(true)
    wasActive.current = item.active
  }, [item.active])

  useEffect(() => {
    setVisibleCount(5)
    setShowOlder(false)
  }, [days])

  useEffect(() => {
    if (!expanded || item.unavailable) return
    let cancelled = false
    let pending = false
    const load = async (refresh: boolean): Promise<void> => {
      if (pending) return
      pending = true
      setLoading(true)
      setError(false)
      try {
        const result = await loader.current(item.id, limit, refresh)
        if (!cancelled) {
          setSessions(result)
          setHasLoaded(true)
          setNow(Date.now())
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        pending = false
        if (!cancelled) setLoading(false)
      }
    }
    const forceRefresh = refreshVersion !== handledRefresh.current
    handledRefresh.current = refreshVersion
    void load(forceRefresh)
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void load(false)
    }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void load(false)
    }, 60_000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [expanded, item.id, item.unavailable, limit, refreshVersion])

  const openSessionIds = new Set(item.tasks.map((task) => task.sessionId).filter(Boolean))
  const seen = new Set<string>()
  const history: SidebarTask[] = sessions
    .filter((session) => {
      if (openSessionIds.has(session.sessionId) || seen.has(session.sessionId)) return false
      seen.add(session.sessionId)
      return true
    })
    .map((session) => ({
      id: `session:${session.sessionId}`,
      sessionId: session.sessionId,
      originDevice: session.originDevice,
      title: session.transcriptTitle || session.title || '이름 없는 작업',
      mtime: session.mtime
    }))
  const filteredHistory = history
    .filter((task) => showOlder || task.mtime >= now - days * DAY_MS)
    .sort((a, b) => b.mtime - a.mtime)
  const visibleTasks = [
    ...item.tasks.map((task) => ({
      ...task,
      originDevice: task.originDevice ?? sessions.find((session) => session.sessionId === task.sessionId)?.originDevice
    })),
    ...filteredHistory.slice(0, Math.max(0, visibleCount - item.tasks.length))
  ].sort((a, b) => b.mtime - a.mtime)
  const canLoadMore = sessions.length >= limit && limit < SESSION_SEARCH_MAX_LIMIT
  const hasMore = item.tasks.length + filteredHistory.length > visibleTasks.length || (!showOlder && history.some((task) => task.mtime < now - days * DAY_MS)) || canLoadMore

  const showMore = (): void => {
    const nextCount = visibleTasks.length + 5
    setShowOlder(true)
    setVisibleCount(nextCount)
    if (item.tasks.length + history.length < nextCount && canLoadMore) {
      setLimit(expandSessionSearchLimit(limit))
    }
  }

  return (
    <section className={`case-sidebar-group${item.active ? ' active' : ''}`} data-case-id={item.id}>
      <div className="case-sidebar-case-row">
        <button
          type="button"
          className="case-sidebar-toggle"
          aria-label={`${item.title} 작업 ${expanded ? '접기' : '펼치기'}`}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
        </button>
        <button
          type="button"
          className={`case-sidebar-case${item.active ? ' active' : ''}`}
          title={[item.title, item.participants, item.subtitle].filter(Boolean).join('\n')}
          aria-current={item.active ? 'page' : undefined}
          onClick={() => { setExpanded(true); onOpenCase(item.id) }}
        >
          <IconExplorer size={16} />
          <span className="case-sidebar-case-text">
            <span className="case-sidebar-case-title">{item.title}</span>
            {item.participants && <span className="case-sidebar-case-participants">{item.participants}</span>}
          </span>
        </button>
        <button
          type="button"
          className="case-sidebar-new-task"
          title="새 작업"
          aria-label={`${item.title} 새 작업`}
          disabled={item.unavailable}
          onClick={() => { setExpanded(true); onNewTask(item.id) }}
        >
          <IconNewFile size={15} />
        </button>
      </div>
      {expanded && (
        <div id={listId} className="case-sidebar-tasks" aria-label={`${item.title} 작업`}>
          {visibleTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`case-sidebar-task${task.active ? ' active' : ''}`}
              title={`${task.title}${task.status ? ` · ${task.status}` : ''}`}
              aria-current={task.active ? 'page' : undefined}
              onClick={() => onOpenTask(item.id, task)}
            >
              <span className="case-sidebar-task-title">{task.title}</span>
              {task.originDevice === 'android' && <span className="case-sidebar-task-origin" title="폰에서 시작한 작업">폰</span>}
              {task.status && <span className="case-sidebar-task-status">{task.status}</span>}
            </button>
          ))}
          {item.unavailable ? (
            <p className="case-sidebar-message">SSH에 연결하면 이전 작업을 볼 수 있습니다.</p>
          ) : error ? (
            <div className="case-sidebar-message" role="status">
              작업을 불러오지 못했습니다.
              <button type="button" className="case-sidebar-retry" disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}>다시 시도</button>
            </div>
          ) : loading && !hasLoaded ? (
            <p className="case-sidebar-message" role="status">작업 불러오는 중…</p>
          ) : visibleTasks.length === 0 ? (
            <p className="case-sidebar-message">{showOlder ? '저장된 작업이 없습니다.' : `최근 ${days}일 동안의 작업이 없습니다.`}</p>
          ) : null}
          {!item.unavailable && (
            <div className="case-sidebar-task-actions">
              {hasMore && (
                <button type="button" className="case-sidebar-more-tasks" disabled={loading} onClick={showMore}>
                  더 보기
                </button>
              )}
              {showOlder && (
                <button type="button" className="case-sidebar-recent-only" onClick={() => { setShowOlder(false); setVisibleCount(5) }}>
                  최근 작업만
                </button>
              )}
              <button
                type="button"
                className="case-sidebar-refresh"
                title="작업 새로고침"
                aria-label="작업 새로고침"
                disabled={loading}
                onClick={() => setRefreshVersion((value) => value + 1)}
              >
                <IconSync size={13} />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default function CaseSidebar({ cases, onAddCase, ...callbacks }: CaseSidebarProps): JSX.Element {
  const [days, setDays] = useState(readPeriod)
  const [visibleCases, setVisibleCases] = useState(6)
  const orderedCases = [...cases].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <nav className="case-sidebar" aria-label="사건별 작업">
      <div className="case-sidebar-heading">
        <span>열어본 사건</span>
        <select
          aria-label="최근 작업 기간"
          value={days}
          onChange={(event) => {
            const value = Number(event.target.value)
            setDays(value)
            try { localStorage.setItem(PERIOD_KEY, String(value)) } catch { /* 기간은 현재 창에서 유지합니다. */ }
          }}
        >
          {[7, 14, 30].map((value) => <option key={value} value={value}>최근 {value}일</option>)}
        </select>
      </div>
      <div className="case-sidebar-list">
        {orderedCases.slice(0, visibleCases).map((item) => <CaseGroup key={`${item.id}:${item.historyKey ?? ''}`} item={item} days={days} {...callbacks} />)}
        {cases.length === 0 && <p className="case-sidebar-empty">사건을 열면 최근 작업이 여기에 표시됩니다.</p>}
        {cases.length > visibleCases && (
          <button type="button" className="case-sidebar-more-cases" onClick={() => setVisibleCases((count) => count + 6)}>
            사건 더 보기
          </button>
        )}
      </div>
      <button type="button" className="case-sidebar-add-case" onClick={onAddCase}>
        <span aria-hidden="true">+</span> 사건 추가
      </button>
    </nav>
  )
}
