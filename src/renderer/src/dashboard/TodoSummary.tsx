import { filterTodos, kstDateKey, summarizeTodos, type TodoFilter } from '../../../shared/todoSummary'
import type { JsCase, JsUpcomingHearing } from '../env'
import { formatHearingLabel } from './hearings'
import type { TodoSnapshot } from './useTodoSnapshot'

export function TodoSnapshotState({ snapshot }: { snapshot: TodoSnapshot }): JSX.Element {
  return <div className="todo-snapshot-state" role="status">
    {snapshot.hasToken === false ? 'JuriSupport 연결 후 할일이 표시됩니다.' :
      snapshot.error ? `조회 실패: ${snapshot.error}${snapshot.todos ? ' · 이전 조회 결과입니다.' : ''}` :
        snapshot.loading ? '할일을 불러오는 중…' : null}
    {snapshot.fetchedAt && <span>조회 {new Date(snapshot.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)</span>}
    <button className="todo-small" onClick={snapshot.refresh} disabled={snapshot.loading}>새로고침</button>
  </div>
}

export function TodoHeaderBadge({ snapshot, onOpen }: { snapshot: TodoSnapshot; onOpen: () => void }): JSX.Element {
  const count = snapshot.todos ? summarizeTodos(snapshot.todos).overdueCount : null
  return <button className="header-btn" onClick={onOpen} title={snapshot.error || '오늘 요약 열기'}>
    {count === null ? '오늘 요약' : `기한 도과 ${count} · 오늘 요약`}{snapshot.error ? ' · 갱신 실패' : ''}
  </button>
}

export default function TodoSummary({ snapshot, onFilter, onGlobalWork, hearingSummary, hearingsLoading, hearingsError, upcomingHearings, hearingsComplete, onOpenCase }: {
  snapshot: TodoSnapshot
  upcomingHearings?: JsUpcomingHearing[]
  hearingsComplete?: boolean
  onOpenCase?: (c: JsCase) => void
  onFilter?: (filter: TodoFilter) => void
  onGlobalWork?: () => void
  hearingSummary?: { todayCount: number; weekCount: number; fetchedAt: string } | null
  hearingsLoading?: boolean
  hearingsError?: string
}): JSX.Element {
  const counts = snapshot.todos ? summarizeTodos(snapshot.todos) : null
  const metrics: { label: string; value: number | null; filter?: TodoFilter }[] = [
    { label: '오늘 기일', value: hearingSummary?.todayCount ?? null },
    { label: '앞으로 7일 기일', value: hearingSummary?.weekCount ?? null },
    { label: '기한 도과', value: counts?.overdueCount ?? null, filter: 'overdue' },
    { label: '기한 없음', value: counts?.undatedCount ?? null, filter: 'undated' },
    { label: '재확인 필요', value: counts?.reviewCount ?? null, filter: 'review' }
  ]
  const overdue = snapshot.todos ? filterTodos(snapshot.todos, 'overdue') : []
  return <section className="todo-summary" aria-label="오늘 업무 요약">
    <div className="todo-summary-heading"><h2>오늘 요약</h2>{onGlobalWork && <button className="todo-primary" onClick={onGlobalWork}>AI와 전체 할일 정리</button>}</div>
    <div className="todo-summary-grid">{metrics.map(({label, value, filter}) => <button key={label} className="todo-metric" disabled={!filter || !onFilter || value === null} onClick={() => filter && onFilter?.(filter)}><span>{label}</span><strong>{value ?? '—'}</strong></button>)}</div>
    {hearingsError && <p className="dash-err">기일 조회 실패: {hearingsError}{hearingSummary ? ' · 이전 조회 결과입니다.' : ''}</p>}
    {hearingSummary && <p className="muted small">기일 조회 {new Date(hearingSummary.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)</p>}
    {hearingsLoading && <p className="muted small">기일을 불러오는 중…</p>}
    {hearingsComplete === false && <p className="todo-warning">기일 전체 조회를 확인하지 못했습니다. 표시된 목록 외에 추가 기일이 있을 수 있습니다.</p>}
    {upcomingHearings && <details className="today-hearings"><summary>앞으로 7일 기일 전체 보기 · {upcomingHearings.length}건{hearingsComplete === false ? ' (전체성 미확인)' : ''}</summary><ul>{upcomingHearings.map((hearing) => <li key={hearing.id}><span>{new Date(hearing.dateTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {formatHearingLabel(hearing.case, hearing)}</span>{onOpenCase && <button className="todo-small" onClick={() => onOpenCase(hearing.case)}>사건 열기</button>}</li>)}</ul></details>}
    <TodoSnapshotState snapshot={snapshot} />
    {counts && counts.openCount === 0 && !snapshot.error && !snapshot.loading && <p className="muted">처리할 할일이 없습니다.</p>}
    {overdue.length > 0 && <div className="todo-summary-overdue"><strong>오래된 도과 할일 · 전체 {counts?.overdueCount}건</strong><ul>{overdue.slice(0, 5).map((todo) => <li key={todo.id}><span>{kstDateKey(todo.dueDate)} · {todo.title}</span><small>{todo.caseNumber || todo.caseName || '사건 미연결'}</small></li>)}</ul><button className="todo-small" onClick={() => onFilter?.('overdue')} disabled={!onFilter}>전체 보기</button></div>}
  </section>
}
