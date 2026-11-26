import { Fragment, useEffect, useMemo, useState } from 'react'
import type { SessionTranscript, SshProfile, WorkLogDay, WorkLogFile, WorkLogItem, WorkLogStatus } from '../env'

const WORK_LOG_DAYS = 30
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function dayLabel(epoch: number): string {
  const d = new Date(epoch)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const date = `${d.getMonth() + 1}.${d.getDate()} (${WEEKDAY_KO[d.getDay()]})`
  if (dayKey(epoch) === dayKey(today.getTime())) return `오늘 · ${date}`
  if (dayKey(epoch) === dayKey(yesterday.getTime())) return `어제 · ${date}`
  return date
}

function timeLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function spanLabel(e: WorkLogItem): { time: string; duration?: string } {
  if (!e.firstTs || e.lastTs - e.firstTs < 60_000) return { time: timeLabel(e.lastTs) }
  const minutes = Math.round((e.lastTs - e.firstTs) / 60_000)
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}` : `${minutes}분`
  return { time: `${timeLabel(e.firstTs)}–${timeLabel(e.lastTs)}`, duration }
}

function caseLabel(e: WorkLogItem): string {
  return [e.caseNumber, e.caseName].filter(Boolean).join(' ') || e.folderName || '(사건 미지정)'
}

function usd(n?: number): string {
  return n === undefined ? '' : `$${n.toFixed(2)}`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

const STATUS_LABEL: Record<WorkLogStatus, string> = {
  done: '완료',
  unfinished: '하다 만 일',
  pending: '결재 대기',
  running: '진행 중',
  continued: '이어서 진행'
}

type Period = 'today' | 'week' | 'month'
type StatusFilter = 'all' | 'done' | 'unfinished' | 'pending' | 'running'

function periodStart(period: Period): number {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (period === 'today') return today
  if (period === 'week') return today - 6 * 86_400_000
  return 0
}

function StatusBadge({ status, reason }: { status?: WorkLogStatus; reason?: string }): JSX.Element | null {
  if (!status) return null
  return (
    <span className={`wlog-status wlog-status-${status}`} title={reason}>
      {STATUS_LABEL[status]}
      {reason && <span className="wlog-status-reason"> · {reason}</span>}
    </span>
  )
}

function FileChips({ files, onOpen }: { files?: WorkLogFile[]; onOpen?: (path: string) => void }): JSX.Element | null {
  if (!files?.length) return null
  return (
    <div className="wlog-files">
      {files.slice(0, 6).map((f) => (
        <button
          key={f.path}
          type="button"
          className="wlog-file"
          title={f.path}
          disabled={!onOpen}
          onClick={(event) => {
            event.stopPropagation()
            onOpen?.(f.path)
          }}
        >
          <span>{fileName(f.path)}</span>
          <span className="wlog-muted">{f.kind === 'write' ? '작성' : '수정'}</span>
        </button>
      ))}
      {files.length > 6 && <span className="wlog-muted">외 {files.length - 6}개</span>}
    </div>
  )
}

/**
 * 날짜별 작업일지. 세션 한 줄에 언제·어디서·누가·시킨 일·한 일·바뀐 파일·상태·비용을 보인다.
 * 업무 보드 카드가 연 세션은 원 지시 한 줄 아래에 하위 카드로 묶인다.
 * full이면 독립 화면: 기간·상태·사건 필터, 요약 숫자, 세션 상세를 함께 보인다.
 */
export default function WorkLogView({
  onResume,
  full = false,
  sshProfiles = [],
  onOpenFile,
  onOpenBoard
}: {
  onResume?: (e: WorkLogItem, options?: { newTab?: boolean }) => void
  full?: boolean
  sshProfiles?: SshProfile[]
  onOpenFile?: (path: string, e: WorkLogItem) => void
  onOpenBoard?: (workspace: string) => void
}): JSX.Element {
  const [daysData, setDaysData] = useState<WorkLogDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [windowDays, setWindowDays] = useState(WORK_LOG_DAYS)
  const [extending, setExtending] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; item: WorkLogItem } | null>(null)
  const [period, setPeriod] = useState<Period>(full ? 'today' : 'month')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [caseFilter, setCaseFilter] = useState('')
  const [selected, setSelected] = useState<{ item: WorkLogItem; date: string } | null>(null)

  useEffect(() => {
    let alive = true
    setExtending(true)
    window.lt.sessions
      .workLog(windowDays)
      .then((r) => {
        if (alive) setDaysData(r)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
      .finally(() => {
        if (alive) setExtending(false)
      })
    return () => {
      alive = false
    }
  }, [windowDays])
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const cases = useMemo(
    () => [...new Set((daysData ?? []).flatMap((d) => d.items.map(caseLabel)))].sort((a, b) => a.localeCompare(b, 'ko')),
    [daysData]
  )
  const shown = useMemo(() => {
    const start = periodStart(period)
    return (daysData ?? [])
      .filter((d) => d.epoch >= start)
      .map((d) => ({
        ...d,
        items: d.items.filter(
          (e) =>
            (statusFilter === 'all' || e.status === statusFilter) &&
            (!caseFilter || caseLabel(e) === caseFilter)
        )
      }))
      .filter((d) => !full || d.items.length > 0)
  }, [daysData, period, statusFilter, caseFilter, full])
  const summary = useMemo(() => {
    const items = shown.flatMap((d) => d.items)
    const count = (status: WorkLogStatus): number => items.filter((e) => e.status === status).length
    return {
      sessions: items.reduce((n, e) => n + 1 + (e.board?.children.length ?? 0), 0),
      done: count('done'),
      unfinished: count('unfinished'),
      pending: count('pending'),
      cost: items.reduce((n, e) => n + (e.costUsd ?? 0), 0)
    }
  }, [shown])

  const openFile = onOpenFile ? (e: WorkLogItem) => (path: string) => onOpenFile(path, e) : undefined
  const list = (
    <div className={full ? 'worklog wlog-full-list' : 'worklog'}>
      {failed && <p className="muted pad">작업일지를 불러오지 못했습니다.</p>}
      {!failed && !daysData && <p className="muted pad">작업 기록을 모으는 중… (원격 포함, 잠시 걸릴 수 있습니다)</p>}
      {daysData && daysData.length === 0 && (
        <p className="muted pad">
          최근 {windowDays}일간 기록된 에이전트 작업이 없습니다. 사건에서 작업하면 자동으로
          쌓입니다.
        </p>
      )}
      {full && daysData && daysData.length > 0 && shown.length === 0 && (
        <p className="muted pad">조건에 맞는 세션이 없습니다.</p>
      )}
      {shown.map((day) => (
        <Fragment key={day.date}>
          <div className="wl-day">
            {dayLabel(day.epoch)} <span className="wlog-muted">{day.items.length}건</span>
          </div>
          {day.items.map((e) => {
            const span = spanLabel(e)
            const isSelected = selected?.item === e
            return (
              <div
                key={`${e.board ? 'board:' + e.board.cardId : e.sessionId}-${day.date}`}
                className={`wlog-row${onResume || full ? ' clickable' : ''}${isSelected ? ' selected' : ''}`}
                title={full ? '클릭 → 상세' : onResume ? '클릭 → 열기 · Control/Command 클릭 또는 우클릭 → 새 탭' : undefined}
                onClick={(event) => {
                  if (full) setSelected({ item: e, date: day.date })
                  else onResume?.(e, { newTab: event.ctrlKey || event.metaKey })
                }}
                onContextMenu={(event) => {
                  if (!onResume) return
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ x: event.clientX, y: event.clientY, item: e })
                }}
              >
                <div className="wlog-when">
                  <span>{span.time}</span>
                  {span.duration && <span className="wlog-muted">{span.duration}</span>}
                </div>
                <div className="wlog-where">
                  <span className="wlog-case">{caseLabel(e)}</span>
                  <span className="wlog-loc">{e.sshLabel ? `SSH · ${e.sshLabel}` : '로컬'}</span>
                </div>
                <div className="wlog-who">
                  <span>{e.who ?? '일반 대화'}</span>
                  {e.departments?.map((d) => (
                    <span key={d} className="wlog-dept">{d}</span>
                  ))}
                </div>
                <div className="wlog-what">
                  <div className="wlog-asked">
                    {e.firstText || e.title || '(지시 없음)'}
                    {!e.board && e.count > 1 && <span className="wlog-muted"> 외 지시 {e.count - 1}건</span>}
                  </div>
                  {e.workSummary && <div className="wlog-did">{e.workSummary}</div>}
                  <FileChips files={e.files} onOpen={openFile?.(e)} />
                  {e.board && e.board.children.length > 0 && (
                    <div className="wlog-children">
                      {e.board.children.map((c) => (
                        <div key={c.cardId} className="wlog-child">
                          <span>{c.who}</span>
                          <span className="wlog-muted">{c.title}</span>
                          <StatusBadge status={c.status} />
                          {c.costUsd !== undefined && <span className="wlog-muted">{usd(c.costUsd)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="wlog-state">
                  <StatusBadge status={e.status} reason={e.statusReason} />
                  {e.costUsd !== undefined && <span className="wlog-muted">{usd(e.costUsd)}</span>}
                </div>
              </div>
            )
          })}
        </Fragment>
      ))}
      {daysData && daysData.length > 0 && windowDays < 180 && (!full || period === 'month') && (
        <button className="wl-more" disabled={extending} onClick={() => setWindowDays((d) => d + 30)}>
          {extending ? '불러오는 중…' : '이전 30일 더 보기'}
        </button>
      )}
      {menu && (
        <ul
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 60)
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <li
            className="ctx-item"
            onClick={() => {
              onResume?.(menu.item, { newTab: true })
              setMenu(null)
            }}
          >
            새 탭으로 열기
          </li>
        </ul>
      )}
    </div>
  )
  if (!full) return list

  const chip = (on: boolean): string => `wlog-chip${on ? ' on' : ''}`
  return (
    <div className="wlog-page">
      <div className="wlog-main">
        <div className="wlog-filters">
          <div className="wlog-group" role="group" aria-label="기간">
            {(
              [
                ['today', '오늘'],
                ['week', '최근 7일'],
                ['month', `최근 ${windowDays}일`]
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" className={chip(period === value)} aria-pressed={period === value} onClick={() => setPeriod(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="wlog-group" role="group" aria-label="상태">
            {(
              [
                ['all', '전체'],
                ['done', '완료'],
                ['unfinished', '하다 만 일'],
                ['pending', '결재 대기'],
                ['running', '진행 중']
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" className={chip(statusFilter === value)} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <label className="wlog-case-filter">
            사건
            <select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value)}>
              <option value="">전체</option>
              {cases.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="wlog-summary" aria-label="요약">
          <div><span>세션</span><b>{summary.sessions}개</b></div>
          <div><span>완료</span><b className="wlog-status-done">{summary.done}건</b></div>
          <div><span>하다 만 일</span><b className="wlog-status-unfinished">{summary.unfinished}건</b></div>
          <div><span>결재 대기</span><b className="wlog-status-pending">{summary.pending}건</b></div>
          <div title="Claude가 결과에 보고한 API 기준 금액. 앱 밖에서 실행한 세션은 빠집니다."><span>비용</span><b>{usd(summary.cost)}</b></div>
        </div>
        {list}
      </div>
      {selected && (
        <WorkLogDetail
          key={`${selected.item.sessionId}-${selected.date}`}
          item={selected.item}
          date={selected.date}
          ssh={sshProfiles.find((p) => p.id === selected.item.profileId)}
          onClose={() => setSelected(null)}
          onResume={onResume}
          onOpenFile={openFile?.(selected.item)}
          onOpenBoard={onOpenBoard}
        />
      )}
    </div>
  )
}

function WorkLogDetail({
  item,
  date,
  ssh,
  onClose,
  onResume,
  onOpenFile,
  onOpenBoard
}: {
  item: WorkLogItem
  date: string
  ssh?: SshProfile
  onClose: () => void
  onResume?: (e: WorkLogItem, options?: { newTab?: boolean }) => void
  onOpenFile?: (path: string) => void
  onOpenBoard?: (workspace: string) => void
}): JSX.Element {
  const [transcript, setTranscript] = useState<SessionTranscript | null | undefined>(item.board ? null : undefined)
  useEffect(() => {
    if (item.board || (item.profileId && !ssh)) {
      setTranscript(null)
      return
    }
    let alive = true
    window.lt.sessions
      .transcript(item.sessionId, ssh)
      .then((t) => alive && setTranscript(t))
      .catch(() => alive && setTranscript(null))
    return () => {
      alive = false
    }
  }, [item, ssh])
  const asked = (transcript?.messages ?? []).filter(
    (m) => m.role === 'user' && m.timestamp !== undefined && dayKeyIso(m.timestamp) === date
  )
  const span = spanLabel(item)
  return (
    <aside className="wlog-detail" aria-label="세션 상세">
      <header>
        <div>
          <span className="wlog-muted">
            {dayLabel(new Date(item.lastTs).setHours(0, 0, 0, 0))} {span.time}
            {span.duration ? ` · ${span.duration}` : ''} · {item.sshLabel ? `SSH · ${item.sshLabel}` : '로컬'}
          </span>
          <h2>{caseLabel(item)}</h2>
          <span>{item.who ?? '일반 대화'}</span>
        </div>
        <button type="button" aria-label="상세 닫기" onClick={onClose}>
          ×
        </button>
      </header>
      {item.departments && item.departments.length > 0 && (
        <section>
          <h3>부서</h3>
          <div className="wlog-who">
            {item.departments.map((d) => (
              <span key={d} className="wlog-dept">{d}</span>
            ))}
            <span className="wlog-muted">카드 담당</span>
          </div>
        </section>
      )}
      <section>
        <h3>시킨 일</h3>
        {item.board ? (
          <p>{item.firstText}</p>
        ) : transcript === undefined ? (
          <p className="wlog-muted">대화 기록을 읽는 중…</p>
        ) : asked.length ? (
          <ol>
            {asked.map((m) => (
              <li key={m.id}>
                <span className="wlog-muted">{timeLabel(m.timestamp!)} </span>
                {m.text.replace(/\s+/g, ' ').slice(0, 300)}
              </li>
            ))}
          </ol>
        ) : (
          <p>{item.firstText ?? '(기록 없음)'}</p>
        )}
      </section>
      <section>
        <h3>한 일</h3>
        <p>{item.workSummary ?? <span className="wlog-muted">요약이 아직 없습니다.</span>}</p>
      </section>
      {item.board && item.board.children.length > 0 && (
        <section>
          <h3>하위 업무</h3>
          <div className="wlog-children">
            {item.board.children.map((c) => (
              <div key={c.cardId} className="wlog-child">
                <span>{c.who}</span>
                <span className="wlog-muted">{c.title}</span>
                <StatusBadge status={c.status} />
                {c.costUsd !== undefined && <span className="wlog-muted">{usd(c.costUsd)}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3>만들거나 고친 파일</h3>
        {item.files?.length ? (
          <ul className="wlog-detail-files">
            {item.files.map((f) => (
              <li key={f.path}>
                <div>
                  <span>{fileName(f.path)}</span>
                  <span className="wlog-muted">
                    {f.kind === 'write' ? '작성' : '수정'} · {f.path}
                  </span>
                </div>
                {onOpenFile && (
                  <button type="button" onClick={() => onOpenFile(f.path)}>
                    열기
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wlog-muted">파일 쓰기·수정 도구로 바꾼 파일이 없습니다. 셸 명령으로 만든 파일은 여기 나오지 않습니다.</p>
        )}
      </section>
      <section className="wlog-detail-facts">
        <div>
          <span>상태</span>
          <StatusBadge status={item.status} reason={item.statusReason} />
        </div>
        <div>
          <span>비용</span>
          <b>{item.costUsd !== undefined ? usd(item.costUsd) : '-'}</b>
        </div>
        <div>
          <span>모델</span>
          <b>{transcript?.model ?? '-'}</b>
        </div>
      </section>
      <footer>
        {item.board && onOpenBoard && (
          <button type="button" className="primary" onClick={() => onOpenBoard(item.board!.workspace)}>
            업무 보드에서 보기
          </button>
        )}
        {onResume && (
          <button type="button" className={item.board ? undefined : 'primary'} onClick={() => onResume(item)}>
            세션 이어서 열기
          </button>
        )}
      </footer>
    </aside>
  )
}

function dayKeyIso(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
