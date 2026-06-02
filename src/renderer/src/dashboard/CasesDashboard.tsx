import { useEffect, useRef, useState } from 'react'
import type { JsCase, JsParty, SshProfile } from '../env'

const SIGNUP_URL = 'https://jurisupport.com/signup'
const CASES_URL = 'https://jurisupport.com/cases'
const caseWebUrl = (id: string): string => `https://jurisupport.com/cases/${id}`

const CASE_TYPE_KO: Record<string, string> = {
  civil: '민사',
  civilMain: '민사',
  criminal: '형사',
  family: '가사',
  administrative: '행정',
  other: '기타'
}

function statusKo(s: string): string {
  return { active: '진행중', closed: '종결', archived: '보관' }[s] ?? s
}

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function nextHearing(c: JsCase): { when: string; note: string } | null {
  if (!c.hearings?.length) return null
  const now = Date.now()
  const sorted = [...c.hearings].sort(
    (a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
  )
  const h = sorted.find((x) => new Date(x.dateTime).getTime() >= now) ?? sorted[sorted.length - 1]
  return { when: fmtDate(h.dateTime), note: h.note || h.location || h.type }
}

function partyNames(parties: JsParty[], role: string): string {
  return parties
    .filter((p) => p.role === role)
    .map((p) => p.party.name)
    .join(', ')
}

const openExt = (url: string): void => void window.lt.app.openExternal(url)
const copy = (s: string): void => void navigator.clipboard.writeText(s)

/** JuriSupport(본체) 사건 대시보드. 좌클릭=작업환경 열기, 우클릭=컨텍스트 메뉴. */
export default function CasesDashboard({
  onOpenWorkspace,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft,
  onChanged
}: {
  onOpenWorkspace: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief: (c: JsCase) => void
  onDraft: (c: JsCase) => void
  onChanged?: () => void
}): JSX.Element {
  const [tokenReady, setTokenReady] = useState<boolean | null>(null)
  const [cases, setCases] = useState<JsCase[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; c: JsCase } | null>(null)
  const [detail, setDetail] = useState<Record<string, JsCase>>({}) // 펼친 사건 상세
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultOpenProfile = defaultOpenProfileId
    ? sshProfiles.find((p) => p.id === defaultOpenProfileId)
    : undefined
  const remoteMenuProfiles = sshProfiles.filter((p) => p.id !== defaultOpenProfile?.id)
  const openDefault = (c: JsCase): void => {
    if (defaultOpenProfile && onOpenRemote) onOpenRemote(c, defaultOpenProfile)
    else onOpenWorkspace(c)
  }

  const load = (q?: string): void => {
    setLoading(true)
    setErr('')
    window.lt.js
      .listCases(q ? { search: q } : {})
      .then((r) => {
        if (r.ok) setCases(r.cases ?? [])
        else setErr(r.error ?? '불러오기 실패')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    window.lt.js.hasToken().then((has) => {
      setTokenReady(has)
      if (has) load()
    })
  }, [])

  useEffect(() => {
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  const saveToken = (): void => {
    const t = tokenInput.trim()
    if (!t) return
    window.lt.js.setToken(t).then(() => {
      setTokenInput('')
      setTokenReady(true)
      load()
      onChanged?.() // 좌측 '다가오는 기일' 패널도 새로고침
    })
  }

  const onSearchChange = (v: string): void => {
    setSearch(v)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => load(v.trim()), 350)
  }

  const toggleDetail = (c: JsCase): void => {
    if (detail[c.id]) {
      setDetail((d) => {
        const n = { ...d }
        delete n[c.id]
        return n
      })
      return
    }
    window.lt.js.getCase(c.id).then((r) => {
      if (r.ok && r.case) setDetail((d) => ({ ...d, [c.id]: r.case as JsCase }))
    })
  }

  // ── 토큰 미설정: 연결 + 가입 유도 ──
  if (tokenReady === false) {
    return (
      <div className="dash-token">
        <h2>JuriSupport 연결</h2>
        <p className="muted">
          사건 관리·일정·당사자를 JuriSupport에서 가져와 이 화면에서 바로 다룹니다.
        </p>
        <div className="dash-signup">
          <span className="muted small">아직 계정이 없으세요?</span>
          <button className="dash-link" onClick={() => openExt(SIGNUP_URL)}>
            JuriSupport 무료로 시작하기 →
          </button>
        </div>
        <p className="muted small dash-or">이미 가입했다면, 웹 → 프로필 → MCP 연결에서 토큰 발급</p>
        <textarea
          className="dash-token-input"
          placeholder="MCP 토큰(eyJ…) 붙여넣기"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        <button className="dash-token-save" onClick={saveToken} disabled={!tokenInput.trim()}>
          연결
        </button>
      </div>
    )
  }

  return (
    <div className="dash">
      <div className="dash-bar">
        <input
          className="dash-search"
          placeholder="사건번호·사건명·당사자 검색"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <button className="dash-btn" title="새로고침" onClick={() => load(search.trim())}>
          ↻
        </button>
        <button
          className="dash-btn"
          title="토큰 재설정"
          onClick={() => {
            setTokenReady(false)
            setCases(null)
          }}
        >
          ⚙
        </button>
      </div>

      {loading && !cases && <p className="muted pad">불러오는 중…</p>}
      {err && (
        <p className="dash-err pad">
          오류: {err}
          {/session|초기화|토큰/i.test(err) && ' — ⚙에서 토큰을 다시 설정해 보세요.'}
        </p>
      )}

      {/* 사건 없음 → 가입/추가 유도 */}
      {cases && cases.length === 0 && !loading && !search && (
        <div className="dash-empty">
          <p>등록된 사건이 없습니다.</p>
          <button className="dash-link" onClick={() => openExt(CASES_URL)}>
            JuriSupport에서 사건 추가하기 →
          </button>
          <button className="dash-link sub" onClick={() => openExt(SIGNUP_URL)}>
            JuriSupport 둘러보기 / 가입
          </button>
        </div>
      )}
      {cases && cases.length === 0 && !loading && search && (
        <p className="muted pad">검색 결과가 없습니다.</p>
      )}

      <div className="dash-list">
        {cases?.map((c) => {
          const h = nextHearing(c)
          const client = partyNames(c.parties, 'client')
          const opponent = partyNames(c.parties, 'opponent')
          const det = detail[c.id]
          return (
            <div
              key={c.id}
              className="case-card"
              onClick={() => openDefault(c)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, c })
              }}
              title="클릭 → 작업환경 열기 · 우클릭 → 메뉴"
            >
              <div className="case-top">
                <span className="case-no">{c.caseNumber || '(사건번호 미정)'}</span>
                <span className={`case-status st-${c.status}`}>{statusKo(c.status)}</span>
              </div>
              <div className="case-name">{c.caseName || '(사건명 없음)'}</div>
              <div className="case-meta">
                {c.court && <span className="case-court">{c.court}</span>}
                {c.division && <span className="case-div">{c.division}</span>}
                {c.caseType && (
                  <span className="case-type">{CASE_TYPE_KO[c.caseType] ?? c.caseType}</span>
                )}
              </div>
              {(client || opponent) && (
                <div className="case-parties">
                  {client && <span className="pty pty-client">의뢰인 {client}</span>}
                  {opponent && <span className="pty pty-opp">상대 {opponent}</span>}
                </div>
              )}
              {h && (
                <div className="case-hearing">
                  <span className="case-hdate">{h.when}</span> {h.note}
                </div>
              )}
              {det && (
                <div className="case-detail" onClick={(e) => e.stopPropagation()}>
                  {det.hearings.length > 0 && (
                    <div className="cd-section">
                      <div className="cd-h">기일</div>
                      {det.hearings
                        .slice()
                        .sort(
                          (a, b) =>
                            new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime()
                        )
                        .map((hh, i) => (
                          <div key={i} className="cd-row">
                            <span className="case-hdate">{fmtDate(hh.dateTime)}</span>{' '}
                            {hh.note || hh.location || hh.type}
                          </div>
                        ))}
                    </div>
                  )}
                  {det._count && (
                    <div className="cd-counts muted small">
                      당사자 {det._count.parties} · 기일 {det._count.hearings} · 진행{' '}
                      {det._count.progresses} · 문서 {det._count.documents}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {menu && (
        <ul
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 300)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(
            [
              ['✳ Claude에 브리핑 요청', () => onBrief(menu.c)],
              ['✍ 준비서면 초안 (/brief-protocol)', () => onDraft(menu.c)],
              ...(onOpenRemote && sshProfiles.length
                  ? ([
                      ...(defaultOpenProfile ? [['📁 로컬에서 열기', () => onOpenWorkspace(menu.c)]] : []),
                      ...remoteMenuProfiles.map((p) => [
                        `🔗 ${p.label}에서 열기`,
                        () => onOpenRemote(menu.c, p)
                      ])
                    ] as [string, () => void][])
                : []),
              ['—', null],
              ['🌐 JuriSupport에서 보기', () => openExt(caseWebUrl(menu.c.id))],
              ['ℹ 상세 보기', () => toggleDetail(menu.c)],
              ['—', null],
              ['📋 사건번호 복사', () => copy(menu.c.caseNumber ?? '')],
              [
                '👤 당사자 복사',
                () => {
                  const cl = partyNames(menu.c.parties, 'client')
                  const op = partyNames(menu.c.parties, 'opponent')
                  copy([cl && `의뢰인: ${cl}`, op && `상대: ${op}`].filter(Boolean).join('\n'))
                }
              ],
              [
                '📅 다음 기일 복사',
                () => {
                  const nh = nextHearing(menu.c)
                  copy(nh ? `${nh.when} ${nh.note}` : '')
                }
              ]
            ] as [string, (() => void) | null][]
          ).map(([label, act], i) =>
            act === null ? (
              <li key={i} className="ctx-sep" />
            ) : (
              <li
                key={i}
                className="ctx-item"
                onClick={() => {
                  act()
                  setMenu(null)
                }}
              >
                {label}
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}
