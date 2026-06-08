import { useEffect, useState } from 'react'
import type { JsCase, JsHearing, SshProfile } from '../env'
import { formatHearingLabel } from './hearings'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'

const WD = ['일', '월', '화', '수', '목', '금', '토']

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

/** 좌측 사이드바: 모든 사건의 다가오는 기일을 날짜순으로. 클릭 → 그 사건 작업환경 열기. */
export default function UpcomingHearings({
  nonce = 0,
  onPick,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft
}: {
  nonce?: number
  onPick: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief: (c: JsCase) => void
  onDraft: (c: JsCase) => void
}): JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [hasTok, setHasTok] = useState(true)
  const [menu, setMenu] = useState<CaseContextMenuState | null>(null)

  useEffect(() => {
    let alive = true
    window.lt.js.hasToken().then((has) => {
      if (!alive) return
      setHasTok(has)
      if (!has) {
        setRows([])
        return
      }
      window.lt.js.listCases().then((r) => {
        if (!alive) return
        if (!r.ok || !r.cases) {
          setRows([])
          return
        }
        const out: Row[] = []
        for (const c of r.cases) {
          for (const h of c.hearings ?? []) {
            const d = new Date(h.dateTime)
            if (isNaN(d.getTime())) continue
            out.push({ c, when: d, h })
          }
        }
        const cutoff = Date.now() - 86400000 // 어제까지 포함(오늘 기일 표시)
        setRows(
          out
            .filter((x) => x.when.getTime() >= cutoff)
            .sort(compareRows)
        )
      })
    })
    return () => {
      alive = false
    }
  }, [nonce])

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
  if (!rows) return <p className="muted pad small">불러오는 중…</p>
  if (rows.length === 0) return <p className="muted pad small">다가오는 기일이 없습니다.</p>

  const today = new Date()
  const isSoon = (d: Date): boolean => (d.getTime() - today.getTime()) / 86400000 < 3

  return (
    <>
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
                setMenu({ x: e.clientX, y: e.clientY, c: r.c })
              }}
              title={`${r.c.caseNumber ?? ''} ${r.c.caseName ?? ''}\n클릭 → 작업환경 열기 · 우클릭 → 메뉴`}
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
          onOpenWorkspace={onPick}
          onOpenRemote={onOpenRemote}
          sshProfiles={sshProfiles}
          defaultOpenProfileId={defaultOpenProfileId}
          onBrief={onBrief}
          onDraft={onDraft}
        />
      )}
    </>
  )
}
