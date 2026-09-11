import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JsTodo, TodoCapabilities, TodoEvidence } from '../env'
import { kstDateKey, setTodoDate } from '../../../shared/todoSummary'
import { caseWebUrl } from './caseUtils'

export function TodoDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  useEffect(() => { window.addEventListener('lt-js-token-updated', onClose); return () => window.removeEventListener('lt-js-token-updated', onClose) }, [onClose])
  return <dialog ref={ref} className="todo-dialog" aria-label={title} onCancel={onClose}><div className="todo-summary-heading"><h2>{title}</h2><button className="todo-small" onClick={onClose} aria-label="닫기">닫기</button></div>{children}</dialog>
}

export function TodoResolution({ todo, action, progressText, onClose, onSaved }: { todo: JsTodo; action: 'complete' | 'close'; progressText?: string; onClose: () => void; onSaved: (todo?: JsTodo | null) => void }): JSX.Element {
  const [detail, setDetail] = useState<JsTodo | null>(null)
  const [choices, setChoices] = useState<Record<string, 'complete' | 'close' | 'keep'>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = (): void => { setError(''); void window.lt.todo.get(todo.id).then((r) => { if (r.ok && r.todo) setDetail(r.todo); else setError(r.error || '할일 조회 실패') }).catch((e) => setError(String(e))) }
  useEffect(load, [todo.id])
  const children = (detail?.children ?? []).filter((child) => ['pending', 'in_progress', 'open'].includes(child.status))
  const save = async (): Promise<void> => {
    if (!detail || busy || children.some((child) => !choices[child.id])) return
    setBusy(true); setError('')
    try {
      const options = { version: detail.version, ...(children.length ? { childDispositions: children.map((child) => ({ id: child.id, action: choices[child.id] })) } : {}) }
      const r = action === 'complete' ? await window.lt.todo.complete(todo.id, progressText, undefined, options) : await window.lt.todo.archive(todo.id, options)
      if (!r.ok) throw new Error(r.error || '처리 실패')
      onSaved(r.todo)
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <TodoDialog title={action === 'complete' ? '할일 완료 확인' : '할일 종료 확인'} onClose={onClose}><p>{todo.title}</p>
    {!detail && !error && <p role="status">자식 할일을 확인하는 중…</p>}
    {children.length > 0 && <p>연결된 열린 하위 할일의 처리 방법을 각각 선택하세요.</p>}
    {children.map((child) => <label className="todo-disposition" key={child.id}><span>{child.title}</span><select aria-label={`${child.title} 처리`} value={choices[child.id] || ''} disabled={busy} onChange={(e) => setChoices({ ...choices, [child.id]: e.target.value as 'complete' | 'close' | 'keep' })}><option value="">처리 선택</option><option value="complete">완료</option><option value="close">종료</option><option value="keep">유지</option></select></label>)}
    {error && <p className="dash-err" role="alert">{error} <button className="todo-small" onClick={load}>다시 조회</button></p>}
    <button className="todo-primary" onClick={() => void save()} disabled={!detail || busy || children.some((child) => !choices[child.id])}>{busy ? '처리 중…' : action === 'complete' ? '완료 확인' : '종료 확인'}</button>
  </TodoDialog>
}

export default function TodoDetails({ todo, parentTitle, capabilities, onChanged, onComplete }: { parentTitle?: string; todo: JsTodo; capabilities: TodoCapabilities | null; onChanged: () => void; onComplete: () => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [due, setDue] = useState('')
  const [review, setReview] = useState('')
  const [candidates, setCandidates] = useState<TodoEvidence[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<JsTodo | null>(null)
  const [followup, setFollowup] = useState('')
  const [followupDue, setFollowupDue] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => { if (busy) return; setBusy(true); setError(''); try { await fn() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const saveDates = (): void => { void run(async () => {
    const patch = { dueDate: due ? setTodoDate(todo.dueDate, due) : null, ...(capabilities?.updateFields.includes('reviewAt') ? { reviewAt: review ? setTodoDate(todo.reviewAt, review) : null } : {}) }
    const r = await window.lt.todo.update(todo.id, patch)
    if (!r.ok) throw new Error(r.error || '날짜 저장 실패')
    setEditing(false); onChanged()
  }) }
  const loadEvidence = (): void => { void run(async () => {
    const [r, current] = await Promise.all([window.lt.todo.evidenceSuggestions(todo.id), window.lt.todo.get(todo.id)])
    if (!r.ok || !current.ok || !current.todo) throw new Error(r.error || current.error || '근거 조회 실패')
    setDetail(current.todo); setCandidates(r.candidates ?? []); setConfirmed(false)
  }) }
  const markEvidence = (candidate: TodoEvidence, status: 'confirmed' | 'dismissed'): void => { void run(async () => {
    if (!detail) return
    const evidence = [...(detail.evidence ?? []).filter((item) => !(item.kind === candidate.kind && item.id === candidate.id && item.uri === candidate.uri)), { ...candidate, status }]
    const r = await window.lt.todo.update(todo.id, { evidence })
    if (!r.ok) throw new Error(r.error || '근거 저장 실패')
    setDetail(r.todo ?? { ...detail, evidence }); setCandidates((rows) => rows?.filter((item) => item !== candidate) ?? []); setConfirmed(status === 'confirmed'); onChanged()
  }) }
  const createFollowup = (): void => { void run(async () => {
    const r = await window.lt.todo.create({ title: followup.trim(), caseId: todo.caseId || undefined, dueDate: followupDue ? setTodoDate(null, followupDue) : undefined, notes: `후속 업무 · 원 할일: ${todo.title} (${todo.id})` })
    if (!r.ok) throw new Error(r.error || '후속 할일 추가 실패')
    setFollowup(''); setFollowupDue(''); onChanged()
  }) }
  return <div className="todo-details" onClick={(e) => e.stopPropagation()}>
    <div className="todo-actions"><button className="todo-small" disabled={busy} onClick={() => { setDue(kstDateKey(todo.dueDate) || ''); setReview(kstDateKey(todo.reviewAt) || ''); setEditing(!editing) }}>기한·재확인 변경</button>{capabilities?.evidenceSuggestions && <button className="todo-small" disabled={busy} onClick={loadEvidence}>완료 근거 확인</button>}</div>
    {editing && <fieldset disabled={busy}><legend>날짜 변경 · 한국 시간</legend><label>기한 <input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label><label>재확인 <input type="date" value={review} disabled={!capabilities?.updateFields.includes('reviewAt')} onChange={(e) => setReview(e.target.value)} /></label><p className="muted small">기존 시각은 유지됩니다. {todo.dueDate && `기한: ${new Date(todo.dueDate).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`}</p>{!capabilities?.updateFields.includes('reviewAt') && <p className="muted small">현재 연결은 재확인일 저장을 지원하지 않습니다.</p>}{!due && !review && <p className="todo-warning">기한·재확인일 없이 저장됩니다.</p>}<button className="todo-primary" onClick={saveDates}>저장</button> <button className="todo-small" onClick={() => setEditing(false)}>취소</button></fieldset>}
    {todo.parentId && <p className="muted small">상위 할일: {parentTitle || '연결된 상위 할일'}</p>}
    {!!todo.children?.length && <p className="muted small">자식 할일 {todo.children.length}건 · {todo.children.map((child) => child.title).join(', ')}</p>}
    {candidates !== null && <fieldset disabled={busy}><legend>완료 근거 후보</legend><p className="muted small">원문을 확인한 뒤 완료 여부를 결정하세요. 초안·제출대기는 제출 확인이 필요합니다.</p>{!candidates.length && <p>추가 근거 없음 · 완료 여부 확인 불가</p>}{candidates.map((candidate, index) => <div className="todo-evidence" key={`${candidate.kind}-${candidate.id || index}`}><strong>{candidate.label}</strong><span>{candidate.occurredAt && kstDateKey(candidate.occurredAt)} · {candidate.reason || '직접 확인 필요'}</span><div className="todo-actions"><button className="todo-small" onClick={() => {
      const uri = candidate.uri && /^https?:\/\//i.test(candidate.uri) ? candidate.uri : candidate.uri?.startsWith('/') && !candidate.uri.startsWith('//') ? new URL(candidate.uri, 'https://jurisupport.com').href : todo.caseId ? caseWebUrl(todo.caseId) : null
      if (uri) void window.lt.app.openExternal(uri).catch((e) => setError(String(e)))
      else setError('열 수 있는 원본 주소가 없습니다. 근거 ID를 확인하세요.')
    }}>{candidate.uri ? '원본 열기' : '사건에서 원본 확인'}</button><button className="todo-small" onClick={() => markEvidence(candidate, 'confirmed')} disabled={!capabilities?.updateFields.includes('evidence')}>근거 확인</button><button className="todo-small" onClick={() => markEvidence(candidate, 'dismissed')} disabled={!capabilities?.updateFields.includes('evidence')}>후보 제외·할일 유지</button></div></div>)}{confirmed && <button className="todo-primary" onClick={onComplete}>확인한 근거로 완료 확인</button>}<label>후속 할일 제안 <input value={followup} onChange={(e) => setFollowup(e.target.value)} placeholder="직접 확인 후 추가할 업무" /></label><label>후속 기한 <input type="date" value={followupDue} onChange={(e) => setFollowupDue(e.target.value)} /></label>{followup && !followupDue && <p className="todo-warning">후속 할일에 기한이 없습니다.</p>}<button className="todo-small" onClick={createFollowup} disabled={!followup.trim()}>후속 할일 추가</button><button className="todo-small" onClick={() => setCandidates(null)}>닫기·할일 유지</button></fieldset>}
    {error && <p className="dash-err" role="alert">{error}</p>}
  </div>
}
