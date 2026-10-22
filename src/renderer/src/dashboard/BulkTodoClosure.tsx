import { useEffect, useRef, useState } from 'react'
import type { JsTodo } from '../env'
import { TodoDialog } from './TodoDetails'

type Row = { todo: JsTodo; detail?: JsTodo; error?: string; closed?: boolean }
const openChildren = (todo: JsTodo): boolean => (todo.children ?? []).some((child) => ['pending', 'in_progress', 'open'].includes(child.status))
const eligible = (row: Row): boolean => !row.closed && !row.error && !!row.detail &&
  (!row.detail.type || row.detail.type === 'todo') && ['completed', 'done'].includes(row.detail.status) && !openChildren(row.detail)

export default function BulkTodoClosure({ todos, onClose, onChanged }: {
  todos: JsTodo[]; onClose: () => void; onChanged: () => void
}): JSX.Element {
  const [rows, setRows] = useState<Row[]>(() => [...new Map(todos.map((todo) => [todo.id, todo])).values()].map((todo) => ({ todo })))
  const [busy, setBusy] = useState(true)
  const busyRef = useRef(false)
  const generation = useRef(0)
  const updateRow = (id: string, patch: Partial<Row>): void => {
    setRows((old) => old.map((row) => row.todo.id === id ? { ...row, ...patch } : row))
  }
  const close = (): void => { generation.current++; onClose() }
  const load = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const run = ++generation.current
    try {
      for (const row of rows.filter((item) => !item.closed)) {
        if (run !== generation.current) break
        updateRow(row.todo.id, { detail: undefined, error: undefined })
        try {
          const r = await window.lt.todo.get(row.todo.id)
          if (run !== generation.current) break
          if (!r.ok || !r.todo || r.todo.id !== row.todo.id) throw new Error(r.error || '할일 조회 실패')
          updateRow(row.todo.id, { detail: r.todo })
        } catch (e) {
          if (run === generation.current) updateRow(row.todo.id, { error: e instanceof Error ? e.message : String(e) })
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
      // ponytail: one-todo API; retain partial results until server-side batch transactions exist.
      for (const row of rows.filter(eligible)) {
        if (run !== generation.current) break
        try {
          const r = await window.lt.todo.get(row.todo.id)
          if (run !== generation.current) break
          if (!r.ok || !r.todo || r.todo.id !== row.todo.id) throw new Error(r.error || '할일 재확인 실패')
          updateRow(row.todo.id, { detail: r.todo })
          if (!eligible({ ...row, detail: r.todo })) continue
          const result = await window.lt.todo.archive(row.todo.id, { version: r.todo.version })
          if (!result.ok) throw new Error(result.error || '종료 실패 · 다시 확인 후 재시도하세요.')
          if (run === generation.current) updateRow(row.todo.id, { closed: true })
        } catch (e) {
          if (run === generation.current) updateRow(row.todo.id, { detail: undefined, error: e instanceof Error ? e.message : String(e) })
        }
      }
    } finally {
      if (run === generation.current) { busyRef.current = false; setBusy(false) }
      onChanged()
    }
  }
  const count = rows.filter(eligible).length
  const done = rows.filter((row) => row.closed).length
  return <TodoDialog title="완료된 할일 일괄 종료" onClose={close}>
    <p>현재 완료 목록에 표시된 할일 {rows.length}건을 종료합니다. 열린 하위 할일이 있는 항목은 개별 검토가 필요합니다.</p>
    <p className="muted small">할일만 종료하며 사건 상태는 변경하지 않습니다.</p>
    <p role="status">종료 완료 {done}건 · 종료 가능 {count}건{busy ? ' · 처리 중…' : ''}</p>
    {rows.map((row) => <div className="todo-evidence bulk-todo-row" key={row.todo.id}>
      <strong>{row.todo.title || '(제목 없음)'}</strong>
      <span className="muted small">{[row.todo.caseNumber, row.todo.caseName].filter(Boolean).join(' · ') || '사건 미연결'}</span>
      <span role={row.error ? 'alert' : undefined}>{row.closed ? '종료 완료' : row.error ? row.error : !row.detail ? '확인 중…' :
        row.detail.type && row.detail.type !== 'todo' ? '할일이 아닌 항목은 제외' : !['completed', 'done'].includes(row.detail.status) ? '완료 상태가 아니므로 제외' :
          openChildren(row.detail) ? '열린 하위 할일 · 개별 검토 필요' : '종료 가능'}</span>
    </div>)}
    <div className="todo-actions">
      <button className="todo-small" disabled={busy || done === rows.length} onClick={() => void load()}>다시 확인</button>
      <button className="todo-primary" disabled={busy || !count} onClick={() => void save()}>{count}건 일괄 종료</button>
    </div>
    {busy && <p className="muted small">요청 간격을 두고 순서대로 처리하며, 호출 제한 시 잠시 기다린 뒤 자동으로 재시도합니다. 닫으면 남은 처리를 중단합니다. 이미 요청한 할일은 종료될 수 있습니다.</p>}
  </TodoDialog>
}
