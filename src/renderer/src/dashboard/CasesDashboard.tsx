import { useEffect, useRef, useState } from 'react'
import type { JsCase, SshProfile } from '../env'
import { formatHearingLabel } from './hearings'
import CaseContextMenu, { type CaseContextMenuState } from './CaseContextMenu'
import { fmtDate, nextHearing, partyNames } from './caseUtils'
import {
  clearCaseListCache,
  listCasesCached,
  readCachedCaseList,
  type CaseListParams
} from './caseListCache'

const SIGNUP_URL = 'https://jurisupport.com/signup'
const CASES_URL = 'https://jurisupport.com/cases'

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

const openExt = (url: string): void => void window.lt.app.openExternal(url)

function caseListParams(q?: string, refresh = false): CaseListParams {
  const search = q?.trim()
  return search ? { search, refresh } : refresh ? { refresh } : {}
}

/** JuriSupport(본체) 사건 대시보드. 좌클릭=작업환경 열기, 우클릭=컨텍스트 메뉴. */
export default function CasesDashboard({
  onOpenWorkspace,
  onOpenDefault,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft,
  onHearingRecord,
  onChanged
}: {
  onOpenWorkspace: (c: JsCase) => void
  onOpenDefault?: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief: (c: JsCase) => void
  onDraft: (c: JsCase) => void
  onHearingRecord?: (c: JsCase) => void
  onChanged?: () => void
}): JSX.Element {
  const [tokenReady, setTokenReady] = useState<boolean | null>(null)
  const [cases, setCases] = useState<JsCase[] | null>(() => readCachedCaseList() ?? null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [menu, setMenu] = useState<CaseContextMenuState | null>(null)
  const [detail, setDetail] = useState<Record<string, JsCase>>({}) // 펼친 사건 상세
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultOpenProfile = defaultOpenProfileId
    ? sshProfiles.find((p) => p.id === defaultOpenProfileId)
    : undefined
  const openDefault = (c: JsCase): void => {
    if (onOpenDefault) {
      onOpenDefault(c)
      return
    }
    if (defaultOpenProfile && onOpenRemote) onOpenRemote(c, defaultOpenProfile)
    else onOpenWorkspace(c)
  }

  const load = (q?: string, refresh = false): void => {
    const params = caseListParams(q, refresh)
    const cached = refresh ? undefined : readCachedCaseList(params)
    if (cached) {
      setCases(cached)
      setErr('')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr('')
    listCasesCached(params)
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
      clearCaseListCache()
      setTokenInput('')
      setTokenReady(true)
      load(undefined, true)
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
        <button className="dash-btn" title="새로고침" onClick={() => load(search.trim(), true)}>
          ↻
        </button>
        <button
          className="dash-btn"
          title="토큰 재설정"
          onClick={() => {
            clearCaseListCache()
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
          const memo = (det?.memo ?? c.memo)?.trim()
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
              {memo && (
                <div className="case-memo" title={memo}>
                  {memo}
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
                            {formatHearingLabel(det, hh, { locationFirst: true })}
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
        <CaseContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenWorkspace={onOpenWorkspace}
          onOpenRemote={onOpenRemote}
          sshProfiles={sshProfiles}
          defaultOpenProfileId={defaultOpenProfileId}
          onBrief={onBrief}
          onDraft={onDraft}
          onHearingRecord={onHearingRecord}
          onDetail={toggleDetail}
        />
      )}
    </div>
  )
}
