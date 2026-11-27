import { Fragment, useEffect, useMemo, useState } from 'react'
import type { DepartmentSource, SessionTranscript, SshProfile, WorkLogDay, WorkLogDepartment, WorkLogFile, WorkLogItem, WorkLogStatus } from '../env'

const WORK_LOG_DAYS = 30

// 작업일지를 닫았다 다시 열 때 빈 화면으로 기다리지 않도록 마지막 결과를 기억한다 (기간별).
// 다시 열면 이 결과를 먼저 보이고, 뒤에서 새로 모은 결과로 바꾼다.
const workLogMemo = new Map<number, WorkLogDay[]>()
let departmentsMemo: WorkLogDepartment[] | null = null
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

type DepartmentChoice = { department?: string; departmentSource: DepartmentSource; departmentReason?: string }

const DEPARTMENT_NOTE: Partial<Record<DepartmentSource, string>> = { card: '카드 담당', direct: '직접 지정', confirmed: '추천 확정' }

function itemKey(e: WorkLogItem): string {
  return `${e.profileId ?? 'local'}:${e.sessionId}`
}

// 부서 표시: 카드 담당·직접 지정·추천 확정은 진한 칩, 추천은 점선 칩과 [확정], 부서 없음은 회색 글씨.
function DepartmentBadge({
  e,
  colors,
  onConfirm
}: {
  e: WorkLogItem
  colors: Map<string, string>
  onConfirm?: () => void
}): JSX.Element | null {
  const source = e.departmentSource
  if (!source) return null
  const dot = (name: string): JSX.Element => <span className="wlog-dot" style={{ background: colors.get(name) ?? '#9d9d9d' }} aria-hidden="true" />
  if (source === 'none') return <span className="wlog-muted">부서 없음</span>
  if (source === 'suggested') {
    const name = e.departments?.[0]
    if (!name) return <span className="wlog-muted" title={e.departmentReason}>맞는 부서 없음 · 추천</span>
    return (
      <span className="wlog-dept-row">
        <span className="wlog-dept suggested" title={e.departmentReason}>{dot(name)}{name} 추천</span>
        {onConfirm && (
          <button
            type="button"
            className="wlog-mini primary"
            onClick={(event) => {
              event.stopPropagation()
              onConfirm()
            }}
          >
            확정
          </button>
        )}
      </span>
    )
  }
  return (
    <span className="wlog-dept-row">
      {(e.departments ?? []).map((name) => (
        <span key={name} className="wlog-dept">{dot(name)}{name}</span>
      ))}
      {DEPARTMENT_NOTE[source] && <span className="wlog-muted">{DEPARTMENT_NOTE[source]}</span>}
    </span>
  )
}

// 부서 필터: 추천을 집계에서 빼면 추천 세션은 "부서 없음·미확정"으로 센다.
function departmentMatches(e: WorkLogItem, filter: string, includeSuggested: boolean): boolean {
  if (filter === 'all') return true
  const counted = e.departmentSource !== 'suggested' || includeSuggested
  const names = counted ? e.departments ?? [] : []
  if (filter === 'none') return names.length === 0
  return names.includes(filter)
}

// 이어서·후속 업무로 넘길 지시 초안. 변호사가 업무 보드 양식에서 고쳐 등록한다.
export function handoffText(e: WorkLogItem, mode: 'continue' | 'followUp'): string {
  const asked = (e.firstText || e.title || '').trim()
  const lines = [
    mode === 'continue' ? `이어서 처리: ${asked}` : `다음 결과를 바탕으로 후속 업무를 진행해 줘: ${asked}`,
    '',
    `- 사건: ${caseLabel(e)}`,
    e.status ? `- 이전 세션 상태: ${STATUS_LABEL[e.status]}${e.statusReason ? ` · ${e.statusReason}` : ''}` : '',
    e.workSummary ? `- 한 일: ${e.workSummary}` : '',
    e.files?.length ? `- 바뀐 파일: ${e.files.map((f) => f.path).join(', ')}` : '',
    `- 이전 세션: ${e.sessionId} (${new Date(e.lastTs).toLocaleString('ko-KR')})`
  ]
  return lines.filter((line, i) => line || i === 1).join('\n')
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
  onOpenBoard,
  onHandoff
}: {
  onResume?: (e: WorkLogItem, options?: { newTab?: boolean }) => void
  full?: boolean
  sshProfiles?: SshProfile[]
  onOpenFile?: (path: string, e: WorkLogItem) => void
  onOpenBoard?: (workspace: string) => void
  /** Opens the work board form with a drafted instruction, and the department to start with. */
  onHandoff?: (e: WorkLogItem, text: string, team?: string) => void
}): JSX.Element {
  const [daysData, setDaysData] = useState<WorkLogDay[] | null>(() => workLogMemo.get(WORK_LOG_DAYS) ?? null)
  const [failed, setFailed] = useState(false)
  const [windowDays, setWindowDays] = useState(WORK_LOG_DAYS)
  const [extending, setExtending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; item: WorkLogItem } | null>(null)
  const [period, setPeriod] = useState<Period>(full ? 'today' : 'month')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [caseFilter, setCaseFilter] = useState('')
  const [selected, setSelected] = useState<{ key: string; date: string } | null>(null)
  const [departments, setDepartments] = useState<WorkLogDepartment[]>(() => departmentsMemo ?? [])
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [includeSuggested, setIncludeSuggested] = useState(true)
  const [overrides, setOverrides] = useState<Record<string, DepartmentChoice>>({})
  const [departmentError, setDepartmentError] = useState('')

  useEffect(() => {
    let alive = true
    let settled = false
    const memo = workLogMemo.get(windowDays)
    const show = (r: WorkLogDay[]): void => {
      workLogMemo.set(windowDays, r)
      if (!alive) return
      setDaysData(r)
      setFailed(false)
      setExtending(false)
    }
    if (memo) setDaysData(memo)
    else setExtending(true)
    setRefreshing(true)
    // 기억한 결과가 없으면 원격은 앱이 저장해 둔 결과로 먼저 그린다 — 서버를 다시 읽는 동안 비워 두지 않는다.
    if (!memo) {
      window.lt.sessions
        .workLog(windowDays, { quick: true })
        .then((r) => {
          if (!settled) show(r)
        })
        .catch(() => {})
    }
    window.lt.sessions
      .workLog(windowDays)
      .then((r) => {
        settled = true
        show(r)
      })
      .catch(() => {
        settled = true
        if (alive && !workLogMemo.has(windowDays)) setFailed(true)
      })
      .finally(() => {
        if (!alive) return
        setExtending(false)
        setRefreshing(false)
      })
    return () => {
      alive = false
    }
  }, [windowDays])
  useEffect(() => {
    if (!full) return
    let alive = true
    window.lt.sessions
      .workLogDepartments()
      .then((list) => {
        departmentsMemo = list
        if (alive) setDepartments(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [full])
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
        items: d.items
          .map((e) => {
            const choice = e.board ? undefined : overrides[itemKey(e)]
            return choice
              ? { ...e, departments: choice.department ? [choice.department] : undefined, departmentSource: choice.departmentSource, departmentReason: choice.departmentReason }
              : e
          })
          .filter(
            (e) =>
              (statusFilter === 'all' || e.status === statusFilter) &&
              (!caseFilter || caseLabel(e) === caseFilter) &&
              departmentMatches(e, departmentFilter, includeSuggested)
          )
      }))
      .filter((d) => !full || d.items.length > 0)
  }, [daysData, period, statusFilter, caseFilter, departmentFilter, includeSuggested, overrides, full])
  const colors = useMemo(() => new Map(departments.map((d) => [d.name, d.color])), [departments])
  const departmentNames = useMemo(() => {
    const names = new Set(departments.map((d) => d.name))
    for (const day of daysData ?? []) for (const e of day.items) for (const name of e.departments ?? []) names.add(name)
    return [...names]
  }, [departments, daysData])
  const chooseDepartment = async (e: WorkLogItem, choice: DepartmentChoice & { departmentSource: 'direct' | 'confirmed' | 'none' }): Promise<void> => {
    if (!e.cwd) return
    setDepartmentError('')
    const saved = await window.lt.sessions
      .setDepartment({ sessionId: e.sessionId, cwd: e.cwd, profileId: e.profileId, department: choice.department, source: choice.departmentSource })
      .catch((error: unknown) => ({ ok: false, error: String(error) }))
    if (!saved.ok) {
      setDepartmentError(saved.error ?? '부서를 저장하지 못했습니다.')
      return
    }
    setOverrides((prev) => ({ ...prev, [itemKey(e)]: choice }))
  }
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
            const isSelected = selected?.key === itemKey(e) && selected.date === day.date
            return (
              <div
                key={`${e.board ? 'board:' + e.board.cardId : e.sessionId}-${day.date}`}
                className={`wlog-row${onResume || full ? ' clickable' : ''}${isSelected ? ' selected' : ''}`}
                title={full ? '클릭 → 상세' : onResume ? '클릭 → 열기 · Control/Command 클릭 또는 우클릭 → 새 탭' : undefined}
                onClick={(event) => {
                  if (full) setSelected({ key: itemKey(e), date: day.date })
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
                  <DepartmentBadge
                    e={e}
                    colors={colors}
                    onConfirm={full && e.departments?.[0] ? () => void chooseDepartment(e, { department: e.departments![0], departmentSource: 'confirmed', departmentReason: e.departmentReason }) : undefined}
                  />
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
                  {full && onHandoff && e.status === 'unfinished' && !e.board && e.cwd && (
                    <button
                      type="button"
                      className="wlog-mini primary"
                      onClick={(event) => {
                        event.stopPropagation()
                        const team = e.departmentSource !== 'none' ? e.departments?.[0] : undefined
                        onHandoff(e, handoffText(e, 'continue'), team)
                      }}
                    >
                      {e.departmentSource !== 'none' && e.departments?.[0] ? `${e.departments[0]}에 이어서 맡기기` : '부서에 이어서 맡기기'}
                    </button>
                  )}
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
  const selectedItem = selected
    ? (shown.find((d) => d.date === selected.date)?.items.find((e) => itemKey(e) === selected.key) ??
      (daysData ?? []).find((d) => d.date === selected.date)?.items.find((e) => itemKey(e) === selected.key))
    : undefined
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
          {departmentNames.length > 0 && (
            <div className="wlog-group" role="group" aria-label="부서">
              {[['all', '전체'], ...departmentNames.map((name) => [name, name]), ['none', '부서 없음·미확정']].map(([value, label]) => (
                <button key={value} type="button" className={chip(departmentFilter === value)} aria-pressed={departmentFilter === value} onClick={() => setDepartmentFilter(value)}>
                  {value !== 'all' && value !== 'none' && <span className="wlog-dot" style={{ background: colors.get(value) ?? '#9d9d9d' }} aria-hidden="true" />}
                  {label}
                </button>
              ))}
            </div>
          )}
          {departmentNames.length > 0 && (
            <label className="wlog-toggle">
              <input type="checkbox" checked={includeSuggested} onChange={(event) => setIncludeSuggested(event.target.checked)} />
              추천 부서도 포함해 집계
            </label>
          )}
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
          <div>
            <span>
              세션
              {refreshing && daysData && (
                <em className="wlog-refreshing" role="status">
                  {' '}· 새 기록 확인 중…
                </em>
              )}
            </span>
            <b>{summary.sessions}개</b>
          </div>
          <div><span>완료</span><b className="wlog-status-done">{summary.done}건</b></div>
          <div><span>하다 만 일</span><b className="wlog-status-unfinished">{summary.unfinished}건</b></div>
          <div><span>결재 대기</span><b className="wlog-status-pending">{summary.pending}건</b></div>
          <div title="Claude가 결과에 보고한 API 기준 금액. 앱 밖에서 실행한 세션은 빠집니다."><span>비용</span><b>{usd(summary.cost)}</b></div>
        </div>
        {departmentError && <p role="alert" className="wlog-error">{departmentError}</p>}
        {list}
      </div>
      {selectedItem && selected && (
        <WorkLogDetail
          key={`${selected.key}-${selected.date}`}
          item={selectedItem}
          date={selected.date}
          ssh={sshProfiles.find((p) => p.id === selectedItem.profileId)}
          colors={colors}
          departmentNames={departmentNames}
          onClose={() => setSelected(null)}
          onResume={onResume}
          onOpenFile={openFile?.(selectedItem)}
          onOpenBoard={onOpenBoard}
          onDepartment={(choice) => void chooseDepartment(selectedItem, choice)}
          onHandoff={onHandoff}
        />
      )}
    </div>
  )
}

function WorkLogDetail({
  item,
  date,
  ssh,
  colors,
  departmentNames,
  onClose,
  onResume,
  onOpenFile,
  onOpenBoard,
  onDepartment,
  onHandoff
}: {
  item: WorkLogItem
  date: string
  ssh?: SshProfile
  colors: Map<string, string>
  departmentNames: string[]
  onClose: () => void
  onResume?: (e: WorkLogItem, options?: { newTab?: boolean }) => void
  onOpenFile?: (path: string) => void
  onOpenBoard?: (workspace: string) => void
  onDepartment: (choice: DepartmentChoice & { departmentSource: 'direct' | 'confirmed' | 'none' }) => void
  onHandoff?: (e: WorkLogItem, text: string, team?: string) => void
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
  }, [item.sessionId, item.board, item.profileId, ssh])
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
      {(item.board ? !!item.departments?.length : departmentNames.length > 0 || !!item.departmentSource) && (
        <section className={item.departmentSource === 'suggested' ? 'wlog-detail-dept suggested' : 'wlog-detail-dept'}>
          <h3>부서</h3>
          <div className="wlog-who">
            {item.departmentSource ? <DepartmentBadge e={item} colors={colors} /> : <span className="wlog-muted">아직 정하지 않음</span>}
          </div>
          {item.departmentReason && item.departmentSource === 'suggested' && <p>추천 이유: {item.departmentReason}</p>}
          {!item.board && (
            <div className="wlog-detail-dept-actions">
              {item.departmentSource === 'suggested' && item.departments?.[0] && (
                <button type="button" className="primary" onClick={() => onDepartment({ department: item.departments![0], departmentSource: 'confirmed', departmentReason: item.departmentReason })}>
                  {item.departments[0]}으로 확정
                </button>
              )}
              <label>
                {item.departmentSource === 'suggested' || !item.departmentSource ? '부서 고르기' : '다른 부서'}
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) onDepartment({ department: event.target.value, departmentSource: 'direct' })
                  }}
                >
                  <option value="">선택</option>
                  {departmentNames
                    .filter((name) => !(item.departmentSource !== 'suggested' && item.departments?.includes(name)))
                    .map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                </select>
              </label>
              {item.departmentSource !== 'none' && (
                <button type="button" onClick={() => onDepartment({ departmentSource: 'none', departmentReason: '직접 지정' })}>
                  해당 부서 없음
                </button>
              )}
            </div>
          )}
          {!item.board && <p className="wlog-muted">직접 정하거나 확정한 부서는 추천이 바꾸지 않습니다.</p>}
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
        {onHandoff && item.cwd && (
          <button type="button" onClick={() => onHandoff(item, handoffText(item, 'followUp'))}>
            이 결과로 부서에 후속 업무 맡기기
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
