import { useEffect, useRef, useState } from 'react'
import type { JsCase, JsHearing, SshProfile } from '../env'
import { formatHearingLabel, isActiveHearing } from './hearings'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'
import { listCasesCached, readCachedCaseList } from './caseListCache'

const WD = ['일', '월', '화', '수', '목', '금', '토']
const RETRY_DELAYS = [700, 1800]

interface Row {
  c: JsCase
  when: Date
  h: JsHearing
}

function clientNames(c: JsCase): string {
  return c.parties
    .filter((p) => p.role === 'client')
    .map((p) => p.party.name)
    .join(', ')
}

function rowSortKey(c: JsCase): string {
  return [c.court, c.caseNumber, c.caseName, c.id].filter(Boolean).join(' ')
}

function compareRows(a: Row, b: Row): number {
  const byTime = a.when.getTime() - b.when.getTime()
  if (byTime !== 0) return byTime
  return rowSortKey(a.c).localeCompare(rowSortKey(b.c), 'ko-KR')
}

function rowKey(r: Row, i: number): string {
  return [r.c.id, r.h.dateTime, r.h.type, r.h.location, r.h.note, i].filter(Boolean).join('|')
}

function buildRows(cases: JsCase[]): Row[] {
  const out: Row[] = []
  for (const c of cases) {
    for (const h of c.hearings ?? []) {
      if (!isActiveHearing(h)) continue
      const d = new Date(h.dateTime)
      if (isNaN(d.getTime())) continue
      out.push({ c, when: d, h })
    }
  }
  const today = new Date()
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return out
    .filter((x) => x.when.getTime() >= cutoff)
    .sort(compareRows)
}

/** 좌측 사이드바: 모든 사건의 다가오는 기일을 날짜순으로. 클릭 → 그 사건 작업환경 열기. */
export default function UpcomingHearings({
  nonce = 0,
  onPick,
  onOpenWorkspace,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onPickRecords,
  onBrief,
  onHearingRecord,
  onTodoChanged
}: {
  nonce?: number
  onPick: (c: JsCase) => void
  onOpenWorkspace?: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onPickRecords?: (c: JsCase) => void | Promise<void>
  onBrief: (c: JsCase) => void
  onHearingRecord?: (c: JsCase) => void
  onTodoChanged?: () => void
}): JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(() => {
    const cached = readCachedCaseList()
    return cached ? buildRows(cached) : null
  })
  const [hasTok, setHasTok] = useState(true)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [menu, setMenu] = useState<CaseContextMenuState | null>(null)
  const previousNonce = useRef(0)
  const defaultOpenProfile = defaultOpenProfileId
    ? sshProfiles.find((p) => p.id === defaultOpenProfileId)
    : undefined

  useEffect(() => {
    let alive = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const refresh = reloadNonce > 0 || nonce !== previousNonce.current
    previousNonce.current = nonce

    const fail = (message: string, attempt: number): void => {
      if (!alive) return
      const nextDelay = RETRY_DELAYS[attempt]
      if (nextDelay !== undefined) {
        setErr(`${message} · 다시 불러오는 중`)
        setLoading(true)
        retryTimer = setTimeout(() => load(attempt + 1), nextDelay)
        return
      }
      setErr(message)
      setLoading(false)
      setRows((current) => current ?? [])
    }

    const load = (attempt = 0): void => {
      if (attempt === 0) {
        setErr('')
        setNotice('')
        const cached = refresh ? undefined : readCachedCaseList()
        if (cached) {
          setRows(buildRows(cached))
          setLoading(false)
          return
        }
        setLoading(true)
      }
      window.lt.js
        .hasToken()
        .then((has) => {
          if (!alive) return
          setHasTok(has)
          if (!has) {
            setRows([])
            setLoading(false)
            return
          }
          listCasesCached(refresh ? { refresh: true } : undefined)
            .then((r) => {
              if (!alive) return
              if (!r.ok || !r.cases) {
                fail(r.error ?? '다가오는 기일을 불러오지 못했습니다.', attempt)
                return
              }
              setRows(buildRows(r.cases))
              setErr('')
              setLoading(false)
            })
            .catch((error) => fail(error instanceof Error ? error.message : String(error), attempt))
        })
        .catch((error) => fail(error instanceof Error ? error.message : String(error), attempt))
    }

    load()
    return () => {
      alive = false
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [nonce, reloadNonce])

  useEffect(() => {
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  if (!hasTok) {
    return <p className="muted pad small">JuriSupport 연결 후 다가오는 기일이 표시됩니다.</p>
  }
  if (!rows) return <p className="muted pad small">불러오는 중...</p>
  if (rows.length === 0) {
    return (
      <div className="agenda-state">
        <p className={`muted pad small ${err ? 'agenda-error' : ''}`}>
          {err || (loading ? '불러오는 중...' : '다가오는 기일이 없습니다.')}
        </p>
        {err && (
          <button className="header-btn agenda-retry" onClick={() => setReloadNonce((n) => n + 1)}>
            다시 불러오기
          </button>
        )}
      </div>
    )
  }

  const today = new Date()
  const isSoon = (d: Date): boolean => (d.getTime() - today.getTime()) / 86400000 < 3
  const value = (s?: string | null): string | undefined => s?.trim() || undefined
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hearingTime = (d: Date): string => `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const namesByRole = (c: JsCase, role: string): string =>
    c.parties
      .filter((p) => p.role === role)
      .map((p) => p.party.name)
      .join(', ')
  const createTodoForHearing = async (c: JsCase, h?: JsHearing): Promise<void> => {
    if (!h) return
    const when = new Date(h.dateTime)
    if (Number.isNaN(when.getTime())) {
      setErr('기일 날짜를 확인할 수 없어 할일을 만들지 못했습니다.')
      return
    }
    const kind = formatHearingLabel(c, h)
    const client = namesByRole(c, 'client')
    const opponent = namesByRole(c, 'opponent')
    const partyLine = [client, opponent].filter(Boolean).join(' / ')
    const caseTitle = [c.caseNumber, c.caseName].filter(Boolean).join(' ') || '사건'
    const notes = [
      '[기일]',
      `일시: ${hearingTime(when)}`,
      kind && `종류: ${kind}`,
      h.location && `장소: ${h.location}`,
      h.note && h.note !== kind && `메모: ${h.note}`
    ]
      .filter((line): line is string => !!line)
      .join('\n')

    setNotice('JuriSupport 할일 생성 중...')
    setErr('')
    try {
      const result = await window.lt.todo.create({
        title: `기일 준비: ${when.getMonth() + 1}/${when.getDate()} ${kind} - ${caseTitle}`,
        status: 'pending',
        priority: isSoon(when) ? 'high' : 'medium',
        dueDate: ymd(when),
        caseId: value(c.id),
        court: value(c.court),
        caseNumber: value(c.caseNumber),
        caseName: value(c.caseName),
        client: value(client),
        opponent: value(opponent),
        partyNames: value(partyLine),
        notes
      })
      if (!result.ok) {
        setNotice('')
        setErr(result.error ?? '할일 생성 실패')
        return
      }
      setNotice('기일 할일을 만들었습니다.')
      window.setTimeout(() => setNotice(''), 2500)
      onTodoChanged?.()
    } catch (error) {
      setNotice('')
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      {(err || notice) && (
        <div className="agenda-warning">
          <span>{err || notice}</span>
          {err && (
            <button className="header-btn agenda-retry" onClick={() => setReloadNonce((n) => n + 1)}>
              새로고침
            </button>
          )}
        </div>
      )}
      <ul className="agenda">
        {rows.map((r, i) => {
          const kind = formatHearingLabel(r.c, r.h)
          const court = r.c.court || ''
          // 장소(법정 호실)는 법원명이 있을 때만 의미가 있음
          const courtLine = court ? `${court}${r.h.location ? ` ${r.h.location}` : ''}` : ''
          const client = clientNames(r.c)
          return (
            <li
              key={rowKey(r, i)}
              className="agenda-row"
              onClick={() => onPick(r.c)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, c: r.c, hearing: r.h })
              }}
              title={`${r.c.caseNumber ?? ''} ${r.c.caseName ?? ''}\n클릭 → ${
                defaultOpenProfile ? `${defaultOpenProfile.label}에서 열기` : '작업환경 열기'
              } · 우클릭 → 메뉴`}
            >
              <span className={`agenda-date ${isSoon(r.when) ? 'soon' : ''}`}>
                {r.when.getMonth() + 1}/{r.when.getDate()}
                <span className="agenda-wd">({WD[r.when.getDay()]})</span>
              </span>
              <span className="agenda-body">
                <span className="agenda-note">{kind}</span>
                {courtLine && <span className="agenda-court">{courtLine}</span>}
                {client && <span className="agenda-client">의뢰인 {client}</span>}
                <span className="agenda-case">{r.c.caseName || r.c.caseNumber || ''}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {menu && (
        <CaseContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenWorkspace={onOpenWorkspace ?? onPick}
          onOpenRemote={onOpenRemote}
          sshProfiles={sshProfiles}
          defaultOpenProfileId={defaultOpenProfileId}
          onPickRecords={onPickRecords}
          onBrief={onBrief}
          onHearingRecord={onHearingRecord}
          onCreateTodo={createTodoForHearing}
        />
      )}
    </>
  )
}
