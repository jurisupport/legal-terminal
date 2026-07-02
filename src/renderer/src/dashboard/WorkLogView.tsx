import { Fragment, useEffect, useState } from 'react'
import type { WorkLogDay, WorkLogItem } from '../env'

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
  if (dayKey(epoch) === dayKey(today.getTime())) return '오늘'
  if (dayKey(epoch) === dayKey(yesterday.getTime())) return '어제'
  return `${d.getMonth() + 1}.${d.getDate()} (${WEEKDAY_KO[d.getDay()]})`
}

function timeLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function caseLabel(e: WorkLogItem): string {
  return [e.caseNumber, e.caseName].filter(Boolean).join(' ') || e.folderName || '(사건 미지정)'
}

/**
 * 날짜별 작업일지. 트랜스크립트 타임스탬프 기준이라 한 세션을 여러 날 썼으면
 * 각 날짜에 그날의 지시 수·첫 지시가 따로 나온다. 원격 스캔 포함이라 첫 로딩은 수 초 걸릴 수 있다.
 */
export default function WorkLogView({
  onResume
}: {
  onResume?: (e: WorkLogItem) => void
}): JSX.Element {
  const [daysData, setDaysData] = useState<WorkLogDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [windowDays, setWindowDays] = useState(WORK_LOG_DAYS)
  const [extending, setExtending] = useState(false)

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

  return (
    <div className="worklog">
      {failed && <p className="muted pad">작업일지를 불러오지 못했습니다.</p>}
      {!failed && !daysData && <p className="muted pad">작업 기록을 모으는 중… (원격 포함, 잠시 걸릴 수 있습니다)</p>}
      {daysData && daysData.length === 0 && (
        <p className="muted pad">
          최근 {windowDays}일간 기록된 에이전트 작업이 없습니다. 사건에서 작업하면 자동으로
          쌓입니다.
        </p>
      )}
      {daysData?.map((day) => (
        <Fragment key={day.date}>
          <div className="wl-day">{dayLabel(day.epoch)}</div>
          {day.items.map((e) => (
            <div
              key={`${e.sessionId}-${day.date}`}
              className={`wl-row${onResume ? ' clickable' : ''}`}
              title={onResume ? '클릭 → 이 세션 이어서 열기' : undefined}
              onClick={() => onResume?.(e)}
            >
              <span className="wl-time">{timeLabel(e.lastTs)}</span>
              <div className="wl-main">
                <div className="wl-head">
                  <span className="wl-case">{caseLabel(e)}</span>
                  <span className="wl-title">{e.title || e.firstText || '(제목 없음)'}</span>
                  {e.sshLabel && <span className="cat-ssh">{e.sshLabel}</span>}
                </div>
                {e.firstText && (
                  <div className="wl-inst">
                    {e.firstText}
                    {e.count > 1 && <span className="wl-count"> 외 지시 {e.count - 1}건</span>}
                  </div>
                )}
                {e.workSummary && <div className="wl-summary">{e.workSummary}</div>}
              </div>
            </div>
          ))}
        </Fragment>
      ))}
      {daysData && daysData.length > 0 && windowDays < 180 && (
        <button
          className="wl-more"
          disabled={extending}
          onClick={() => setWindowDays((d) => d + 30)}
        >
          {extending ? '불러오는 중…' : '이전 30일 더 보기'}
        </button>
      )}
    </div>
  )
}
