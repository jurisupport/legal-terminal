import { useCallback, useEffect, useRef, useState } from 'react'
import type { JsTodo } from '../env'
import { kstDateKey } from '../../../shared/todoSummary'

export interface TodoSnapshot {
  todos: JsTodo[] | null
  loading: boolean
  error: string
  fetchedAt: string | null
  hasToken: boolean | null
  refresh: () => void
}
type SnapshotState = Omit<TodoSnapshot, 'refresh'>
const emptyState: SnapshotState = { todos: null, loading: false, error: '', fetchedAt: null, hasToken: null }

/** App owns one instance so summaries, sidebar and the open list share the same result. */
export function useTodoSnapshot(nonce = 0): TodoSnapshot {
  const [state, setState] = useState<SnapshotState>(emptyState)
  const generation = useRef(0)
  const inflight = useRef<Promise<void> | null>(null)
  const refreshPending = useRef(false)
  const mounted = useRef(false)
  const load = useCallback((afterMutation = false): void => {
    if (inflight.current) { if (afterMutation) refreshPending.current = true; return }
    const expected = generation.current
    const current = (): boolean => mounted.current && expected === generation.current
    setState((old) => ({ ...old, loading: true, error: '' }))
    const request = Promise.resolve().then(async () => {
      try {
        const hasToken = await window.lt.js.hasToken()
        if (!current()) return
        if (!hasToken) { setState({ ...emptyState, hasToken: false }); return }
        setState((old) => ({ ...old, hasToken: true }))
        const result = await window.lt.todo.list({ openOnly: true, enrichCaseDetails: false, fields: 'compact' })
        if (!current()) return
        if (!result.ok || !Array.isArray(result.todos)) throw new Error(result.error || '할일을 불러오지 못했습니다.')
        setState({ todos: result.todos, hasToken: true, fetchedAt: new Date().toISOString(), error: '', loading: false })
      } catch (error) {
        if (current()) setState((old) => ({ ...old, loading: false, error: error instanceof Error ? error.message : String(error) }))
      } finally {
        if (inflight.current === request) {
          inflight.current = null
          if (refreshPending.current && mounted.current) { refreshPending.current = false; load() }
        }
      }
    })
    inflight.current = request
  }, [])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const scheduleDateRefresh = (): void => {
      const today = kstDateKey(new Date())!
      const nextMidnight = Date.parse(`${today}T00:00:00+09:00`) + 86_400_000
      timer = setTimeout(() => { load(); scheduleDateRefresh() }, Math.max(1000, nextMidnight - Date.now() + 100))
    }
    const accountChanged = (): void => {
      generation.current++
      inflight.current = null
      refreshPending.current = false
      setState(emptyState)
      load()
    }
    const focus = (): void => { clearTimeout(timer); scheduleDateRefresh(); load() }
    window.addEventListener('lt-js-token-updated', accountChanged)
    window.addEventListener('focus', focus)
    scheduleDateRefresh()
    return () => {
      mounted.current = false
      generation.current++
      inflight.current = null
      refreshPending.current = false
      clearTimeout(timer)
      window.removeEventListener('lt-js-token-updated', accountChanged)
      window.removeEventListener('focus', focus)
    }
  }, [load])
  useEffect(() => { load(true) }, [nonce, load])
  const refresh = useCallback(() => load(true), [load])
  return { ...state, refresh }
}
