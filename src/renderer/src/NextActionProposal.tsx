import { useEffect, useRef, useState } from 'react'
import type { JsTodo } from './env'
import { nextActionCollector, type NextActionSuggestion } from '../../shared/nextActionProposal'
import { setTodoDate } from '../../shared/todoSummary'

export interface NextActionRequest { id: string; task: JsTodo; sessionId: string }
export interface NextActionProposalProps {
  request: NextActionRequest
  activeCaseId?: string
  onClose: () => void
  onSaved: (todo: JsTodo) => void
}

export default function NextActionProposal({ request, activeCaseId, onClose, onSaved }: NextActionProposalProps): JSX.Element | null {
  const [suggestion, setSuggestion] = useState<NextActionSuggestion>({ phase: 'waiting', title: '' })
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<JsTodo | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const edited = useRef(false)
  const saving = useRef(false)
  const attempted = useRef(false)
  const active = useRef(false)
  const epoch = useRef(0)
  const close = useRef(onClose)
  close.current = onClose
  const currentContext = `${request.id}:${request.sessionId}:${request.task.id}:${activeCaseId ?? ''}`
  const context = useRef(currentContext)
  if (context.current !== currentContext) { context.current = currentContext; active.current = false; epoch.current++ }
  const caseMatches = !!request.task.caseId && activeCaseId === request.task.caseId

  useEffect(() => {
    const generation = ++epoch.current
    active.current = caseMatches
    edited.current = false; saving.current = false; attempted.current = false
    setSuggestion({ phase: 'waiting', title: '' }); setTitle(''); setDue(''); setError(''); setBusy(false); setSaved(null); setUncertain(false)
    if (!caseMatches) { close.current(); return }
    const collect = nextActionCollector(request.id, request.sessionId)
    const unsubscribe = window.lt.agent.onEvent(event => {
      if (!active.current || epoch.current !== generation) return
      const next = collect(event)
      setSuggestion(next)
      if (next.phase === 'done' && !edited.current) setTitle(next.title)
    })
    const invalidate = (): void => { active.current = false; epoch.current++; close.current() }
    window.addEventListener('lt-js-token-updated', invalidate)
    return () => { active.current = false; epoch.current++; unsubscribe(); window.removeEventListener('lt-js-token-updated', invalidate) }
  }, [request.id, request.sessionId, request.task.id, request.task.caseId, activeCaseId, caseMatches])

  const dismiss = (): void => { active.current = false; epoch.current++; onClose() }
  const save = async (): Promise<void> => {
    if (!active.current || !caseMatches || saving.current || attempted.current || !title.trim()) return
    const generation = epoch.current
    const valid = (): boolean => active.current && epoch.current === generation
    saving.current = true; setBusy(true); setError('')
    try {
      const dueDate = due ? setTodoDate(null, due) : undefined
      const original = await window.lt.todo.get(request.task.id)
      if (!valid()) return
      if (!original.ok || !original.todo) throw new Error(original.error || '원 할일을 다시 확인할 수 없습니다.')
      const task = original.todo
      if (task.id !== request.task.id || !task.caseId || task.caseId !== request.task.caseId || !['pending', 'in_progress', 'open'].includes(task.status) || (task.type && task.type !== 'todo')) throw new Error('원 할일의 사건 또는 상태가 변경되었습니다. 현재 할일에서 다시 제안해 주세요.')
      if (task.version !== request.task.version || (request.task.updatedAt && task.updatedAt !== request.task.updatedAt)) throw new Error('원 할일이 변경되었습니다. 현재 내용을 확인하고 다시 제안해 주세요.')
      attempted.current = true
      const response = await window.lt.todo.create({ title: title.trim(), caseId: task.caseId, dueDate,
        notes: `후속 업무 · 원 할일: ${task.title} (${task.id})\n제안 참조: ${request.id}` })
      if (!valid()) return
      if (!response.ok || !response.todo?.id || response.todo.caseId !== task.caseId) {
        setUncertain(true)
        throw new Error(response.error || '저장 결과를 확인할 수 없습니다.')
      }
      setSaved(response.todo)
      onSaved(response.todo)
    } catch (failure) {
      if (valid()) { setError(failure instanceof Error ? failure.message : String(failure)); if (attempted.current) setUncertain(true) }
    } finally {
      if (valid()) { saving.current = false; setBusy(false) }
    }
  }

  if (!caseMatches) return null
  return <section className="todo-summary" aria-label="다음 행동 제안">
    <div className="todo-summary-heading"><h2>다음 행동 제안</h2><button className="todo-small" onClick={dismiss}>닫기</button></div>
    <p>원 할일: {request.task.title}</p>
    <p className="muted small" role="status">{suggestion.phase === 'waiting' ? 'Agent 입력창의 요청을 직접 보내면 제안을 가져옵니다. 다음 행동을 직접 입력해도 됩니다.' : suggestion.phase === 'receiving' ? '이 요청의 제안을 기다리는 중… 직접 입력한 내용은 유지됩니다.' : suggestion.phase === 'done' ? '제안을 확인하고 후속 할일로 저장하세요.' : '제안을 가져오지 못했습니다. 다음 행동을 직접 입력할 수 있습니다.'}</p>
    {saved ? <p role="status">후속 할일 저장됨: {saved.title}</p> : <fieldset className="todo-create" disabled={busy || uncertain}>
      <legend>별도 후속 할일</legend>
      <label>다음 행동 <input className="todo-create-input" value={title} maxLength={200} onChange={event => { edited.current = true; setTitle(event.target.value) }} /></label>
      <label>기한 <input type="date" value={due} onChange={event => setDue(event.target.value)} /></label>
      {!due && <span className="muted small">기한 없이 추가됩니다.</span>}
      <button className="todo-primary" disabled={!title.trim() || busy || uncertain} onClick={() => void save()}>{busy ? '저장 중…' : '후속 할일로 저장'}</button>
    </fieldset>}
    {error && <p className="dash-err" role="alert">{error}</p>}
    {uncertain && <p className="todo-warning" role="alert">저장 요청을 보냈습니다. 중복 생성을 막기 위해 이 요청은 다시 저장하지 않습니다. 사건의 할일 목록을 새로고침하고 “제안 참조: {request.id}”가 있는 할일을 확인하세요.</p>}
  </section>
}
