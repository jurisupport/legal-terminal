import { useEffect, useState } from 'react'
import type { CaseTaskDisposition, JsCase, JsTodo } from '../env'
import { TodoDialog } from './TodoDetails'

export default function CaseTaskReview({ caseId, title, onClose, onChanged, closureSupported = true }: { closureSupported?: boolean; caseId: string; title: string; onClose: () => void; onChanged: () => void }): JSX.Element {
  const [tab, setTab] = useState(closureSupported ? 'status' : 'memos')
  const [cases, setCases] = useState<JsCase[]>([])
  const [target, setTarget] = useState('closed')
  const [caseVersion, setCaseVersion] = useState<number | undefined>()
  const [blocked, setBlocked] = useState(false)
  const [tasks, setTasks] = useState<JsTodo[] | null>(null)
  const [choices, setChoices] = useState<Record<string, CaseTaskDisposition>>({})
  const [memos, setMemos] = useState<JsTodo[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newMemo, setNewMemo] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    setError(''); setTasks(null); setChoices({})
    try { const r = await window.lt.js.caseClosurePreview(caseId); if (!r.ok) throw new Error(r.error || '열린 할일 조회 실패'); if (!r.preview) throw new Error('사건 검토 응답이 없습니다.'); setTasks(r.preview.tasks); setCaseVersion(r.preview.version); setBlocked(r.preview.blocked) } catch (e) { setError(String(e)) }
  }
  const loadMemos = async (): Promise<void> => {
    try { const r = await window.lt.todo.list({ caseId, type: 'memo', includeArchived: false }); if (!r.ok) throw new Error(r.error || '메모 조회 실패'); setMemos(r.todos ?? []); setDrafts(Object.fromEntries((r.todos ?? []).map((memo) => [memo.id, memo.title]))) } catch (e) { setError(String(e)) }
  }
  useEffect(() => { if (closureSupported) { void load(); void window.lt.js.listCases().then((r) => { if (r.ok) setCases(r.cases ?? []) }).catch(() => {}) }; void loadMemos() }, [caseId])
  const run = async (fn: () => Promise<void>): Promise<void> => { if (busy) return; setBusy(true); setError(''); try { await fn() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const needsReview = ['closed', 'archived', 'declined', 'withdrawn'].includes(target)
  const incomplete = needsReview && (blocked || !tasks || tasks.some((todo) => !choices[todo.id]?.action || (choices[todo.id].action === 'transfer' && !choices[todo.id].targetCaseId?.trim())))
  const save = (): void => { void run(async () => {
    const dispositions = needsReview ? (tasks ?? []).map((todo) => ({ ...choices[todo.id], version: todo.version })) : undefined
    const r = ['closed', 'archived', 'active'].includes(target) ? await window.lt.js.updateCaseStatus(caseId, target, dispositions, caseVersion) : await window.lt.js.updateCaseEngagement(caseId, target as 'unknown' | 'consulting' | 'retained' | 'declined' | 'withdrawn', dispositions, caseVersion)
    if (!r.ok) throw new Error(r.error || '사건 변경 실패. 새로 조회한 뒤 다시 확인하세요.')
    onChanged(); onClose()
  }) }
  return <TodoDialog title={`${title} · 사건 관리`} onClose={onClose}>
    <div className="todo-tabs"><button className="todo-tab" disabled={!closureSupported} aria-pressed={tab === 'status'} onClick={() => setTab('status')}>종결·수임 상태</button><button className="todo-tab" aria-pressed={tab === 'memos'} onClick={() => setTab('memos')}>사건 메모</button></div>
    {error && <p className="dash-err" role="alert">{error}</p>}
    {tab === 'status' ? <fieldset disabled={busy}><legend>사건 상태 변경</legend><label>변경할 상태 <select value={target} onChange={(e) => setTarget(e.target.value)}><optgroup label="사건 상태"><option value="closed">종결</option><option value="archived">보관</option><option value="active">진행</option></optgroup><optgroup label="수임 상태"><option value="unknown">미확인</option><option value="consulting">상담중</option><option value="retained">수임</option><option value="declined">불수임</option><option value="withdrawn">사임</option></optgroup></select></label>
      {needsReview && <>{blocked && <p className="dash-err">접근할 수 없는 열린 할일이 있어 사건 상태를 변경할 수 없습니다.</p>}<p>열린 할일을 각각 검토하세요. 유지·이관할 후속 업무도 선택할 수 있습니다.</p><button className="todo-small" onClick={() => void load()}>열린 할일 다시 조회</button>{tasks === null && <p role="status">열린 할일 조회가 필요합니다.</p>}{tasks?.length === 0 && <p>열린 할일이 없습니다.</p>}{tasks?.map((todo) => <div className="todo-case-task" key={todo.id}><label className="todo-disposition"><span>{todo.title}</span><select value={choices[todo.id]?.action || ''} onChange={(e) => setChoices({ ...choices, [todo.id]: { ...choices[todo.id], id: todo.id, action: e.target.value as CaseTaskDisposition['action'], targetCaseId: e.target.value === 'transfer' ? choices[todo.id]?.targetCaseId : undefined } })}><option value="">처리 선택</option><option value="complete">완료</option><option value="close">종료</option><option value="keep">유지</option><option value="transfer">이관</option></select></label>{choices[todo.id]?.action === 'transfer' && <label>이관할 사건 <select value={choices[todo.id]?.targetCaseId || ''} onChange={(e) => setChoices({ ...choices, [todo.id]: { ...choices[todo.id], targetCaseId: e.target.value } })}><option value="">사건 선택</option>{cases.filter((c) => c.id !== caseId && c.status === 'active').map((c) => <option key={c.id} value={c.id}>{[c.caseNumber, c.caseName].filter(Boolean).join(' · ') || '이름 없는 사건'}</option>)}</select></label>}<label>처리 사유 <input value={choices[todo.id]?.reason || ''} onChange={(e) => setChoices({ ...choices, [todo.id]: { ...choices[todo.id], reason: e.target.value } })} /></label></div>)}</>}
      <button className="todo-primary" disabled={incomplete || busy} onClick={save}>검토 내용과 상태 저장</button>
    </fieldset> : <fieldset disabled={busy}><legend>사건 메모</legend><label>새 메모 <input value={newMemo} onChange={(e) => setNewMemo(e.target.value)} /></label><button className="todo-small" disabled={!newMemo.trim()} onClick={() => void run(async () => { const r = await window.lt.todo.create({ caseId, type: 'memo', title: newMemo.trim() }); if (!r.ok) throw new Error(r.error || '메모 추가 실패'); setNewMemo(''); await loadMemos() })}>메모 추가</button>{memos === null && <p>메모 조회 중…</p>}{memos?.length === 0 && <p>메모가 없습니다.</p>}{memos?.map((memo) => <div className="todo-evidence" key={memo.id}><label>메모 내용 <textarea value={drafts[memo.id] ?? memo.title} onChange={(e) => setDrafts({ ...drafts, [memo.id]: e.target.value })} /></label><div className="todo-actions"><button className="todo-small" disabled={!drafts[memo.id]?.trim()} onClick={() => void run(async () => { const r = await window.lt.todo.update(memo.id, { title: drafts[memo.id].trim(), version: memo.version }); if (!r.ok) throw new Error(r.error || '메모 저장 실패'); await loadMemos() })}>저장</button><button className="todo-small" onClick={() => void run(async () => { const r = await window.lt.todo.archive(memo.id, { version: memo.version }); if (!r.ok) throw new Error(r.error || '메모 보관 실패'); await loadMemos() })}>보관</button></div></div>)}</fieldset>}
  </TodoDialog>
}
