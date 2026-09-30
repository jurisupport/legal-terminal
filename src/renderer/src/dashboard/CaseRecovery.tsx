import { buildCaseManagement, emptyCaseManagementUi } from '../../../shared/caseManagement'
import type { JsCase, JsUpcomingHearing, TodoCapabilities } from '../env'
import { TodoDialog } from './TodoDetails'
import CaseTaskPanel, { type TaskActionProps } from './CaseTaskPanel'
import type { CaseManagementUiController } from './useCaseManagementUi'
import type { TodoSnapshot } from './useTodoSnapshot'

/** A skip changes only this personal cursor. Task edits never advance the cursor. */
export default function CaseRecovery({ cases, snapshot, caseUi, capabilities, hearings, onClose, onChanged, ...actions }: TaskActionProps & {
  cases: JsCase[]
  hearings?: JsUpcomingHearing[]
  snapshot: TodoSnapshot
  caseUi: CaseManagementUiController
  capabilities: TodoCapabilities | null
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const model = buildCaseManagement(cases, snapshot.todos ?? [], caseUi.state?.ui ?? emptyCaseManagementUi(), new Date(), hearings?.map((hearing) => ({ ...hearing, caseId: hearing.case.id })))
  const row = model.recovery.find((item) => item.case.id === model.recoveryCaseId)
  const move = async (): Promise<void> => {
    if (!row || !caseUi.state) return
    const seenCaseIds = [...new Set([...model.ui.recovery.seenCaseIds, row.case.id])]
    const next = model.recovery.find((item) => !seenCaseIds.includes(item.case.id))
    await caseUi.update({ recovery: { caseId: next?.case.id ?? null, seenCaseIds } })
  }
  return <TodoDialog title="한 사건씩 정리" onClose={onClose}>
    <p className="muted small">변경은 현재 사건에만 적용됩니다. 건너뛰어도 기한과 업무 상태는 유지됩니다.</p>
    {snapshot.error && <p className="dash-err" role="alert">할일 조회 실패: {snapshot.error} · 최신 상태 확인 후 계속하세요. <button className="todo-small" onClick={snapshot.refresh}>다시 조회</button></p>}
    {caseUi.error && <p className="dash-err" role="alert">{caseUi.error} <button className="todo-small" onClick={() => void caseUi.refresh()}>선택 다시 불러오기</button></p>}
    {row ? <>
      <h3>{[row.case.caseNumber, row.case.caseName].filter(Boolean).join(' · ') || '사건번호 없는 사건'}</h3>
      <p className="todo-warning">{row.reasons.join(' · ') || '다음 할일 확인'}</p>
      <fieldset className="case-recovery-body" disabled={snapshot.loading || !!snapshot.error || caseUi.busy || !caseUi.state}>
        <CaseTaskPanel key={row.case.id} c={row.case} todos={row.openTasks} caseUi={caseUi} capabilities={capabilities} onChanged={onChanged} {...actions} />
        <div className="todo-actions"><button className="todo-small" onClick={() => void move()}>이번에는 건너뛰기</button><button className="todo-primary" onClick={() => void move()}>확인했음 · 다음 사건</button></div>
      </fieldset>
    </> : <><p>이번 순회에서 확인할 사건이 없습니다.</p><button className="todo-small" disabled={caseUi.busy || !caseUi.state} onClick={() => void caseUi.update({ recovery: { caseId: model.recovery[0]?.case.id ?? null, seenCaseIds: [] } })}>처음부터 다시 확인</button></>}
    <button className="todo-small" onClick={onClose}>여기서 마치기</button>
  </TodoDialog>
}
