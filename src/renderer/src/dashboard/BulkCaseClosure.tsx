import { useEffect, useRef, useState } from 'react'
import type { CaseClosurePreview, JsCase } from '../env'
import { TodoDialog } from './TodoDetails'

type Row = { c: JsCase; preview?: CaseClosurePreview; error?: string; closed?: boolean }
const eligible = (row: Row): boolean => !row.closed && !row.error && !!row.preview &&
  row.preview.status === 'active' && !row.preview.blocked && row.preview.tasks.length === 0

export default function BulkCaseClosure({ cases, onClose, onChanged }: {
  cases: JsCase[]; onClose: () => void; onChanged: () => void
}): JSX.Element {
  const [rows, setRows] = useState<Row[]>(() => cases.map((c) => ({ c })))
  const [busy, setBusy] = useState(true)
  const busyRef = useRef(false)
  const generation = useRef(0)
  const updateRow = (id: string, patch: Partial<Row>): void => {
    setRows((old) => old.map((row) => row.c.id === id ? { ...row, ...patch } : row))
  }
  const close = (): void => { generation.current++; onClose() }
  const load = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const run = ++generation.current
    try {
      for (const row of rows.filter((item) => !item.closed)) {
        if (run !== generation.current) break
        updateRow(row.c.id, { preview: undefined, error: undefined })
        try {
          const r = await window.lt.js.caseClosurePreview(row.c.id)
          if (run !== generation.current) break
          if (!r.ok || !r.preview) throw new Error(r.error || '사건 조회 실패')
          updateRow(row.c.id, { preview: r.preview })
        } catch (e) {
          if (run === generation.current) updateRow(row.c.id, { error: String(e) })
        }
      }
    } finally {
      if (run === generation.current) { busyRef.current = false; setBusy(false) }
    }
  }
  useEffect(() => {
    busyRef.current = false
    void load()
    return () => { generation.current++ }
  }, [])

  const save = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const run = generation.current
    try {
      // ponytail: one-case API; retain partial results until server-side batch transactions exist.
      for (const row of rows.filter(eligible)) {
        if (run !== generation.current) break
        try {
          const r = await window.lt.js.caseClosurePreview(row.c.id)
          if (run !== generation.current) break
          if (!r.ok || !r.preview) throw new Error(r.error || '사건 재확인 실패')
          updateRow(row.c.id, { preview: r.preview })
          if (!eligible({ ...row, preview: r.preview })) continue
          const result = await window.lt.js.updateCaseStatus(row.c.id, 'closed', [], r.preview.version)
          if (!result.ok) throw new Error(result.error || '종결 실패 · 다시 확인 후 재시도하세요.')
          if (run === generation.current) updateRow(row.c.id, { closed: true })
        } catch (e) {
          if (run === generation.current) updateRow(row.c.id, { preview: undefined, error: String(e) })
        }
      }
    } finally {
      if (run === generation.current) { busyRef.current = false; setBusy(false) }
      onChanged()
    }
  }
  const count = rows.filter(eligible).length
  const done = rows.filter((row) => row.closed).length
  return <TodoDialog title="선택 사건 일괄 종결" onClose={close}>
    <p>완료된 사건으로 선택한 {rows.length}건을 확인합니다. 열린 할일이 남은 사건은 개별 검토 후 종결하세요.</p>
    <p role="status">종결 완료 {done}건 · 종결 가능 {count}건{busy ? ' · 처리 중…' : ''}</p>
    {rows.map((row) => <div className="todo-evidence bulk-case-row" key={row.c.id}>
      <strong>{[row.c.caseNumber, row.c.caseName].filter(Boolean).join(' · ') || '사건'}</strong>
      <span role={row.error ? 'alert' : undefined}>{row.closed ? '종결 완료' : row.error ? row.error : !row.preview ? '확인 중…' :
        row.preview.blocked ? '접근할 수 없는 할일이 있어 제외' : row.preview.status !== 'active' ? '진행중 사건이 아니므로 제외' :
          row.preview.tasks.length ? `남은 할일 ${row.preview.tasks.length}건 · 개별 검토 필요` : '종결 가능'}</span>
    </div>)}
    <div className="todo-actions">
      <button className="todo-small" disabled={busy || done === rows.length} onClick={() => void load()}>다시 확인</button>
      <button className="todo-primary" disabled={busy || !count} onClick={() => void save()}>{count}건 일괄 종결</button>
    </div>
    {busy && <p className="muted small">닫으면 남은 처리를 중단합니다. 이미 요청한 사건은 종결될 수 있습니다.</p>}
  </TodoDialog>
}
