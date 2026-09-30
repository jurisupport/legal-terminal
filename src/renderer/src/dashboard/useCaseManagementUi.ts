import { useCallback, useEffect, useRef, useState } from 'react'
import { buildCaseManagement, type CaseManagementState, type CaseManagementUi } from '../../../shared/caseManagement'
import type { TodoSnapshot } from './useTodoSnapshot'

/** One App-owned instance: selections are only committed after the settings write succeeds. */
export function useCaseManagementUi(snapshot?: TodoSnapshot) {
  const [state, setState] = useState<CaseManagementState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const saving = useRef(false)
  const current = useRef(state)
  current.current = state
  const refresh = useCallback(async (): Promise<void> => {
    const expected = generation.current
    setLoading(true)
    try {
      const result = await window.lt.caseManagement.get()
      if (expected !== generation.current) return
      if (!result.ok || !result.state) throw new Error(result.error || '개인 선택을 불러오지 못했습니다.')
      setState(result.state); setError('')
    } catch (e) { if (expected === generation.current) setError(String(e)) }
    finally { if (expected === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const reset = (): void => { generation.current++; current.current = null; saving.current = false; setState(null); setBusy(false); setError(''); void refresh() }
    window.addEventListener('lt-js-token-updated', reset)
    return () => { generation.current++; window.removeEventListener('lt-js-token-updated', reset) }
  }, [refresh])
  const update = useCallback(async (patch: Partial<CaseManagementUi> | ((ui: CaseManagementUi) => Partial<CaseManagementUi>)): Promise<boolean> => {
    const previous = current.current
    if (!previous || saving.current) return false
    const expected = generation.current
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await window.lt.caseManagement.update({ generation: previous.generation, revision: previous.revision,
        patch: typeof patch === 'function' ? patch(previous.ui) : patch })
      if (expected !== generation.current) return false
      if (!result.ok || !result.state) throw new Error(result.error || '선택 저장 실패. 다시 불러온 뒤 재시도하세요.')
      current.current = result.state; setState(result.state)
      return true
    } catch (e) { if (expected === generation.current) setError(String(e)); return false }
    finally { if (expected === generation.current) { saving.current = false; setBusy(false) } }
  }, [])
  useEffect(() => {
    const stored = current.current
    if (!stored || !snapshot?.todos || snapshot.loading || snapshot.error || !snapshot.hasToken) return
    const selectedCases = Object.keys(stored.ui.selectedTaskByCase).map((id) => ({ id, status: 'active' }))
    const normalized = buildCaseManagement(selectedCases, snapshot.todos, stored.ui).ui
    const patch = { selectedTaskByCase: normalized.selectedTaskByCase, focus: normalized.focus, previousFocus: normalized.previousFocus }
    if (Object.entries(patch).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(stored.ui[key as keyof typeof patch]))) void update(patch)
    // A failed write is retried by the next fresh snapshot, never in an error/render loop.
  }, [snapshot?.todos, snapshot?.loading, snapshot?.error, snapshot?.hasToken, state?.generation, update])
  return { state, loading, busy, error, update, refresh }
}
export type CaseManagementUiController = ReturnType<typeof useCaseManagementUi>
