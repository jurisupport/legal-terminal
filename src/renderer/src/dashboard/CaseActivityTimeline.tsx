import { useEffect, useState } from 'react'
import type { CaseActivity, CaseSessionSummary, JsCase } from '../env'
import { agoLabel } from './caseUtils'

const MAX_SESSIONS = 20
const MAX_INSTRUCTIONS = 10

// sessions.ts userTitleCandidate와 같은 취지의 경량 정리 — 내부 태그·명령 래퍼를 걷어내되 자르지는 않는다.
function cleanInstruction(raw: string): string | undefined {
  const command = /<command-name>\s*([^<\n]+?)\s*<\/command-name>/.exec(raw)
  if (command) {
    const args = /<command-args>\s*([^<\n]*?)\s*<\/command-args>/.exec(raw)?.[1]
    return [command[1], args].filter(Boolean).join(' ')
  }
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>/.test(raw)) return undefined
  if (/원본 대화 transcript입니다|진행하던 대화 transcript입니다/.test(raw)) return undefined
  if (/^\[Request interrupted/.test(raw.trim())) return undefined
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text || undefined
}

/** 사건 카드에서 펼치는 작업 이력: 세션 목록 → 세션별 사용자 지시 원문 + 이어하기. */
export default function CaseActivityTimeline({
  c,
  onResume
}: {
  c: JsCase
  onResume?: (c: JsCase, s: CaseSessionSummary) => void
}): JSX.Element {
  const [activity, setActivity] = useState<CaseActivity | null>(null)
  const [failed, setFailed] = useState(false)
  const [openId, setOpenId] = useState('')
  // sessionId → 지시 목록 (null = 로딩 중)
  const [instructions, setInstructions] = useState<Record<string, string[] | null>>({})

  useEffect(() => {
    let alive = true
    window.lt.sessions
      .byCase({
        cases: [{ id: c.id, caseNumber: c.caseNumber, caseName: c.caseName }],
        limitPerCase: MAX_SESSIONS
      })
      .then((r) => {
        if (alive) setActivity(r[c.id] ?? { sessions: [], lastActivity: 0, total: 0 })
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [c.id, c.caseNumber, c.caseName])

  const toggleSession = (s: CaseSessionSummary): void => {
    const next = openId === s.sessionId ? '' : s.sessionId
    setOpenId(next)
    if (!next || instructions[s.sessionId] !== undefined) return
    setInstructions((m) => ({ ...m, [s.sessionId]: null }))
    window.lt.sessions
      .transcript(s.sessionId)
      .then((t) => {
        const texts = (t?.messages ?? [])
          .filter((m) => m.role === 'user')
          .map((m) => cleanInstruction(m.text))
          .filter((x): x is string => !!x)
        setInstructions((m) => ({ ...m, [s.sessionId]: texts }))
      })
      .catch(() => setInstructions((m) => ({ ...m, [s.sessionId]: [] })))
  }

  return (
    <div className="case-timeline" onClick={(e) => e.stopPropagation()}>
      {failed && <div className="muted small">작업 이력을 불러오지 못했습니다.</div>}
      {!failed && !activity && <div className="muted small">불러오는 중…</div>}
      {activity && !activity.sessions.length && (
        <div className="muted small">이 사건에서 진행한 에이전트 작업이 없습니다.</div>
      )}
      {activity?.sessions.map((s) => {
        const open = openId === s.sessionId
        const insts = instructions[s.sessionId]
        return (
          <div key={s.sessionId} className={`cat-row${open ? ' open' : ''}`}>
            <button className="cat-head" onClick={() => toggleSession(s)}>
              <span className="cat-title">{s.title || '(제목 없음)'}</span>
              {s.sshLabel && <span className="cat-ssh">{s.sshLabel}</span>}
              <span className="cat-time">{agoLabel(s.mtime)}</span>
            </button>
            {s.workSummary && <div className="cat-summary">{s.workSummary}</div>}
            {open && (
              <div className="cat-body">
                {insts === null && <div className="muted small">지시 내용 불러오는 중…</div>}
                {insts && !insts.length && (
                  <div className="muted small">표시할 지시 내용이 없습니다.</div>
                )}
                {insts?.slice(0, MAX_INSTRUCTIONS).map((text, i) => (
                  <div key={i} className="cat-inst">
                    {text}
                  </div>
                ))}
                {insts && insts.length > MAX_INSTRUCTIONS && (
                  <div className="muted small">…외 {insts.length - MAX_INSTRUCTIONS}개</div>
                )}
                {onResume && !s.profileId && (
                  <button className="cat-resume" onClick={() => onResume(c, s)}>
                    이어서 열기 ↩
                  </button>
                )}
                {s.profileId && (
                  <div className="muted small">원격 세션 — 원격에서 열기로 이어하세요.</div>
                )}
              </div>
            )}
          </div>
        )
      })}
      {activity && activity.total > activity.sessions.length && (
        <div className="muted small">…외 {activity.total - activity.sessions.length}건</div>
      )}
    </div>
  )
}
