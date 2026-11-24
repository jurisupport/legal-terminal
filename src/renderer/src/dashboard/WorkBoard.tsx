import { boardDocumentPaths, boardMutationIssue, boardReportAvailable, boardRevision, requestsCurrentBoardCase, isBoardTodoReview } from '../../../shared/workBoard'
import DOMPurify from 'dompurify'
import { marked, Renderer } from 'marked'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  BoardAgent,
  BoardDecision,
  BoardDraft,
  BoardSettings,
  BoardSnapshot,
  BoardStatus,
  BoardTask,
  BoardTeam,
  BoardTodoScope
} from '../../../shared/workBoard'
import { isBoardDueSoon, isBoardRunning } from '../../../shared/workBoardSummary'
import { JS_TOKEN_UPDATED_EVENT } from './CasesDashboard'
import './WorkBoard.css'

export type WorkBoardView = 'board' | 'approvals' | 'daily' | 'bulk'
interface Props {
  workspace: string
  view: WorkBoardView
  onView?: (view: WorkBoardView) => void
  onOpenFile: (path: string) => Promise<void>
  bulkSeed?: string
  boundCase?: { id: string; label: string }
}
const statusLabel: Record<BoardStatus, string> = {
  queued: '대기',
  running: '수행 중',
  blocked: '확인 필요',
  reported: '보고 완료',
  in_review: '검토 중',
  awaiting_approval: '결재 대기',
  approved: '승인',
  rejected: '반려',
  done: '완료',
  failed: '실패'
}
const lanes: { title: string; statuses: BoardStatus[] }[] = [
  { title: '대기', statuses: ['queued'] },
  { title: '수행 중', statuses: ['running', 'in_review', 'reported'] },
  { title: '확인 필요', statuses: ['blocked', 'failed', 'rejected'] },
  { title: '결재 대기', statuses: ['awaiting_approval'] },
  { title: '완료', statuses: ['done', 'approved'] }
]
const stats = [
  { label: '수행 중', matches: isBoardRunning, color: '#2161c7' },
  { label: '결재 대기', matches: (t: BoardTask) => t.status === 'awaiting_approval', color: '#ad660d' },
  { label: '기한 임박 (3일 이내)', matches: (t: BoardTask) => isBoardDueSoon(t), color: '#bd3037' },
  { label: '실패', matches: (t: BoardTask) => t.status === 'failed', color: '#172033' }
]
const agentName = (t: BoardTask) => t.agent || '기본 세션'
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
function elapsed(t: BoardTask) {
  const ms = Date.now() - Date.parse(t.createdAt)
  if (!Number.isFinite(ms)) return ''
  const mins = Math.max(0, Math.floor(ms / 60000))
  return mins < 1
    ? '방금'
    : mins < 60
      ? mins + '분 경과'
      : mins < 1440
        ? Math.floor(mins / 60) + '시간 경과'
        : Math.floor(mins / 1440) + '일 경과'
}

function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    d.showModal()
    return () => d.close()
  }, [])
  return (
    <dialog
      className="wb-dialog"
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        close()
      }}
    >
      <div className="wb-dialog-head">
        <h2>{title}</h2>
        <button className="wb-btn" type="button" onClick={close}>
          닫기
        </button>
      </div>
      {children}
    </dialog>
  )
}

function ConfirmAction({ title, confirmLabel, close, confirm, issue, children }: {
  title: string; confirmLabel: string; close: () => void; confirm: () => Promise<void>; issue?: string; children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <Dialog title={title} close={() => { if (!busy) close() }}>
    {children}
    {issue && <p role="status" className="wb-muted">{issue}</p>}
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-actions">
      <button className="wb-btn" disabled={busy} onClick={close}>취소</button>
      <button className="wb-btn wb-primary" disabled={busy || !!issue} onClick={async () => {
        if (busy || issue) return
        setBusy(true)
        setError('')
        try { await confirm(); close() }
        catch (err) { setError(errMsg(err)) }
        finally { setBusy(false) }
      }}>{confirmLabel}</button>
    </div>
  </Dialog>
}

interface ScopeOptions {
  caseIds: string[]
  boundCase?: Props['boundCase']
}

function useTodoScopeOptions(needed: boolean, { caseIds, boundCase }: ScopeOptions, clearSelection: () => void) {
  const clearSelectionRef = useRef(clearSelection)
  clearSelectionRef.current = clearSelection
  const pinned = boundCase
    ? (caseIds.includes(boundCase.id) ? boundCase.id : undefined)
    : (caseIds.length === 1 ? caseIds[0] : undefined)
  const [cases, setCases] = useState<{ id: string; label: string }[]>([])
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  const [accountChanged, setAccountChanged] = useState(false)
  useEffect(() => {
    if (!needed || pinned) return
    let live = true
    const refresh = () => {
      setCases([])
      setAccountChanged(true)
      clearSelectionRef.current()
      setRequest(n => n + 1)
    }
    setCases([])
    setError('')
    window.lt.js.listCases({ refresh: true }).then(result => {
      if (!live) return
      if (!result.ok) throw new Error(result.error || '사건 목록을 불러오지 못했습니다.')
      setCases((result.cases ?? []).map(c => ({ id: c.id, label: [c.caseNumber, c.caseName].filter(Boolean).join(' · ') || c.id })))
    }).catch(err => { if (live) setError(errMsg(err)) })
    window.addEventListener(JS_TOKEN_UPDATED_EVENT, refresh)
    return () => { live = false; window.removeEventListener(JS_TOKEN_UPDATED_EVENT, refresh) }
  }, [needed, pinned, request])
  return {
    pinned,
    pinnedLabel: boundCase?.id === pinned ? boundCase?.label : pinned,
    cases: caseIds.length ? cases.filter(c => caseIds.includes(c.id)) : cases,
    allowAll: caseIds.length === 0,
    accountChanged,
    error, retry: () => setRequest(n => n + 1)
  }
}

type ScopeList = ReturnType<typeof useTodoScopeOptions>
function selectedScope(options: ScopeList, choice?: BoardTodoScope, defaultToAll = false): BoardTodoScope | undefined {
  if (options.pinned) return { kind: 'case', caseId: options.pinned }
  if (choice?.kind === 'case') return options.cases.some(c => c.id === choice.caseId) ? choice : undefined
  if (options.allowAll && (choice?.kind === 'all' || (defaultToAll && !options.accountChanged))) return { kind: 'all' }
}

const allTodosNotice = '현재 계정에서 볼 수 있는 전체 미완료 할일을 이 보드 폴더에 보고서로 저장합니다.'

function ScopeField({ options, value, change }: { options: ScopeList; value?: BoardTodoScope; change: (scope: BoardTodoScope) => void }) {
  if (options.pinned) return <p className="wb-wide">할일 검토 범위 · {options.pinnedLabel}</p>
  return (
    <div className="wb-wide">
      <label>할일 검토 범위
        <select required value={value?.kind === 'case' ? 'case:' + value.caseId : value?.kind || ''}
          onChange={e => change(e.target.value === 'all' ? { kind: 'all' } : { kind: 'case', caseId: e.target.value.slice(5) })}>
          <option value="" disabled>검토할 범위 선택</option>
          {options.cases.map(c => <option key={c.id} value={'case:' + c.id}>{c.label}</option>)}
          {options.allowAll && <option value="all">전체 미완료 할일</option>}
        </select>
      </label>
      {options.error && <p role="alert">{options.error} <button type="button" className="wb-btn" onClick={options.retry}>다시 조회</button></p>}
    </div>
  )
}

function InstructionForm({
  agents,
  seed,
  existing,
  issue,
  scopeOptions,
  submit
}: {
  agents: BoardAgent[]
  seed?: string
  existing?: BoardTask
  issue?: string
  scopeOptions: ScopeOptions
  submit: (drafts: BoardDraft[], batchId: string) => Promise<void>
}) {
  const [batchId] = useState(() => crypto.randomUUID())
  const [raw, setRaw] = useState(seed || '')
  const [blocks, setBlocks] = useState(false)
  const [drafts, setDrafts] = useState<BoardDraft[]>(() => existing ? [{
    title: existing.title, body: existing.body, agent: existing.agent, due: existing.due,
    approval: existing.approval ?? 'required', review_agent: existing.review_agent,
    depends_on: existing.depends_on, after_approval: existing.after_approval, allowed_tools: existing.allowed_tools
  }] : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const update = (index: number, patch: Partial<BoardDraft>) =>
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  const reviewRows = drafts.map(d => !existing && isBoardTodoReview(d.body))
  const scopes = useTodoScopeOptions(reviewRows.includes(true), scopeOptions, () => {
    setDrafts(rows => rows.map(({ todoScope, ...draft }) => draft))
  })
  const ready: BoardDraft[] = drafts.map((d, i) => {
    if (!reviewRows[i]) {
      const { todoScope, ...draft } = d
      return draft
    }
    return { ...d, todoScope: selectedScope(scopes, d.todoScope, !requestsCurrentBoardCase(d.body)) }
  })
  const missingScope = ready.some((d, i) => reviewRows[i] && !d.todoScope)
  const options = agents.map((a) => (
    <option key={a.name} value={a.name} title={a.description}>
      {a.name}
      {a.description && ' · ' + a.description}
    </option>
  ))
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (!drafts.length) {
          const parts = raw
            .trim()
            .split(blocks ? /\r?\n\s*\r?\n/ : /\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
          setDrafts(
            parts.map((body) => ({ body, title: body.split('\n')[0].slice(0, 120), approval: 'required' }))
          )
          return
        }
        if (busy || issue || missingScope) return
        setBusy(true)
        setError('')
        try {
          await submit(ready, batchId)
        } catch (err) {
          setError(errMsg(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      {!drafts.length ? (
        <>
          <label>
            지시 나누기
            <select value={blocks ? 'block' : 'line'} onChange={(e) => setBlocks(e.target.value === 'block')}>
              <option value="line">한 줄에 하나씩</option>
              <option value="block">빈 줄로 구분</option>
            </select>
          </label>
          <label>
            업무 지시
            <textarea autoFocus required rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} />
          </label>
        </>
      ) : (
        drafts.map((d, i) => (
          <fieldset key={i} className="wb-draft" disabled={busy}>
            <legend>
              {existing ? '지시 내용' : `${i + 1}. ${d.title}`}
            </legend>
            <div className="wb-fields">
              <label className="wb-wide">
                제목
                <input required value={d.title} onChange={(e) => update(i, { title: e.target.value })} />
              </label>
              <label className="wb-wide">
                지시 본문
                <textarea required rows={2} value={d.body} onChange={(e) => update(i, { body: e.target.value })} />
              </label>
              {reviewRows[i] && <ScopeField options={scopes} value={ready[i].todoScope}
                change={todoScope => update(i, { todoScope })} />}
              <label>
                담당 에이전트
                <select value={d.agent || ''} onChange={(e) => update(i, { agent: e.target.value })}>
                  <option value="">기본 세션</option>
                  {d.agent && !agents.some(a => a.name === d.agent) && <option value={d.agent}>{d.agent} (현재 미등록)</option>}
                  {options}
                </select>
              </label>
              <label>
                기한
                <input type="date" value={d.due || ''} onChange={(e) => update(i, { due: e.target.value })} />
              </label>
            </div>
            <details>
              <summary>검토 · 결재 · 선행 지시</summary>
              <div className="wb-fields">
                <label>
                  검토 담당
                  <select
                    value={d.review_agent || ''}
                    onChange={(e) => update(i, { review_agent: e.target.value })}
                  >
                    <option value="">검토 생략</option>
                    {d.review_agent && !agents.some(a => a.name === d.review_agent) && <option value={d.review_agent}>{d.review_agent} (현재 미등록)</option>}
                    {options}
                  </select>
                </label>
                <label>
                  결재
                  <select
                    value={d.approval}
                    onChange={(e) =>
                      update(i, {
                        approval: e.target.value as BoardDraft['approval'],
                        ...(e.target.value === 'none'
                          ? { after_approval: undefined, allowed_tools: undefined }
                          : {})
                      })
                    }
                  >
                    <option value="required">필요</option>
                    <option value="none">생략</option>
                  </select>
                </label>
                <label className="wb-wide">
                  선행 지시 ID (쉼표 구분)
                  <input
                    defaultValue={d.depends_on?.join(', ')}
                    onChange={(e) =>
                      update(i, {
                        depends_on: e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </label>
                {d.approval === 'required' && (
                  <>
                    <label className="wb-wide">
                      승인 후 실행할 지시
                      <textarea
                        value={d.after_approval || ''}
                        onChange={(e) => update(i, { after_approval: e.target.value })}
                      />
                    </label>
                    <label className="wb-wide">
                      승인 후 허용할 도구 (정확한 MCP 도구명 또는 Bash(명령), 한 줄씩)
                      <textarea
                        defaultValue={d.allowed_tools?.join('\n')}
                        onChange={(e) =>
                          update(i, {
                            allowed_tools: e.target.value
                              .split('\n')
                              .map((x) => x.trim())
                              .filter(Boolean)
                          })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            </details>
          </fieldset>
        ))
      )}
      {error && (
        <div role="alert" className="wb-error">
          {error}
        </div>
      )}
      {issue && <p role="status" className="wb-error">{issue}</p>}
      {existing && <p className="wb-muted">내용을 변경하면 확인 필요 상태로 저장됩니다. 수정한 지시를 수행하려면 다시 대기열에 넣으세요.</p>}
      <div className="wb-actions">
        {ready.some(d => d.todoScope?.kind === 'all') && <small>{allTodosNotice}</small>}
        <button disabled={busy || !!issue || (!existing && !raw.trim()) || missingScope} className="wb-btn wb-primary">
          {existing ? '변경 저장' : drafts.length ? drafts.length + '건 등록' : '지시별 담당 지정'}
        </button>
      </div>
    </form>
  )
}

function Settings({
  data,
  submit
}: {
  data: BoardSnapshot
  submit: (folder: string, settings: BoardSettings) => Promise<void>
}) {
  const [folder, setFolder] = useState(data.folder)
  const [values, set] = useState(data.settings)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        try {
          await submit(folder.trim(), values)
        } catch (err) {
          setError(errMsg(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        업무지시 폴더
        <input required value={folder} onChange={(e) => setFolder(e.target.value)} />
      </label>
      <div className="wb-fields">
        <label>
          동시 실행 수
          <input
            required
            type="number"
            min={1}
            max={8}
            value={values.concurrency}
            onChange={(e) => set({ ...values, concurrency: e.target.valueAsNumber || 1 })}
          />
        </label>
        <label>
          검토 반려 후 최대 재수행 횟수
          <input
            required
            type="number"
            min={0}
            max={20}
            value={values.maxReviews}
            onChange={(e) => set({ ...values, maxReviews: e.target.valueAsNumber || 0 })}
          />
        </label>
        <label>
          재시작 시 수행 중 지시
          <select
            value={values.restart}
            onChange={(e) => set({ ...values, restart: e.target.value as BoardSettings['restart'] })}
          >
            <option value="requeue">처음부터 다시 수행</option>
            <option value="resume">기존 세션 이어서 수행</option>
          </select>
        </label>
        <label>
          일일 보고 시각 (한국 시간)
          <input
            required
            type="time"
            value={values.dailyTime}
            onChange={(e) => set({ ...values, dailyTime: e.target.value })}
          />
        </label>
      </div>
      {error && (
        <div className="wb-error" role="alert">
          {error}
        </div>
      )}
      <div className="wb-actions">
        <button disabled={busy} className="wb-btn wb-primary">
          저장
        </button>
      </div>
    </form>
  )
}

function Organization({ data }: { data: BoardSnapshot }) {
  const seen = new Set(data.teams.flatMap((t) => t.agents))
  const extra = new Set(
    [...data.agents.map((a) => a.name), ...data.tasks.map(agentName)].filter((a) => !seen.has(a))
  )
  const teams = extra.size
    ? [...data.teams, { name: '미분류', color: '#64748b', agents: [...extra].sort() }]
    : data.teams
  return (
    <aside className="wb-org" aria-label="조직도">
      <h3>조직도</h3>
      <div className="wb-org-head">대표 (결재)</div>
      <div className="wb-org-head wb-org-sub">비서실장 · 배분·취합</div>
      {teams.map((team) => (
        <section key={team.name} className="wb-team">
          <h4>
            <i style={{ backgroundColor: team.color }} />
            {team.name}
          </h4>
          {team.agents.map((name) => {
            const tasks = data.tasks.filter(
              (t) => agentName(t) === name || (t.status === 'in_review' && t.review_agent === name)
            )
            const active = tasks.filter((t) => !['done', 'approved', 'rejected', 'failed'].includes(t.status))
            const recent = tasks
              .filter((t) => ['done', 'approved', 'rejected', 'failed'].includes(t.status))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
            const running = active.some((t) =>
              t.status === 'in_review' ? t.review_agent === name : t.status === 'running'
            )
            return (
              <div className="wb-split-label" key={name}>
                <span>
                  {running && <i className="wb-dot" aria-label="수행 중" />}
                  {name}
                </span>
                <span>
                  {active.length}건{recent && ' · ' + statusLabel[recent.status]}
                </span>
              </div>
            )
          })}
        </section>
      ))}
    </aside>
  )
}

function TaskCard({
  task: t,
  team,
  open,
  move,
  dragging
}: {
  task: BoardTask
  team?: BoardTeam
  open: () => void
  move?: (id: string) => void
  dragging: React.MutableRefObject<string | null>
}) {
  return (
    <button
      className="wb-card"
      style={{ '--wb-team': team?.color || '#5e7089' } as CSSProperties}
      onClick={open}
      draggable={t.status === 'queued'}
      onDragStart={(e) => {
        dragging.current = t.id
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', t.id)
      }}
      onDragEnd={() => {
        dragging.current = null
      }}
      onDragOver={(e) => {
        if (move && dragging.current) e.preventDefault()
      }}
      onDrop={(e) => {
        if (move && dragging.current) {
          e.preventDefault()
          move(dragging.current)
          dragging.current = null
        }
      }}
    >
      <strong>
        {isBoardRunning(t) && <i className="wb-dot" />}
        {t.title}
      </strong>
      <div className="wb-split-label">
        <span className="wb-team-label">{team?.name || agentName(t)}</span>
        <span className={isBoardDueSoon(t) ? 'wb-due' : ''}>{t.due || '기한 미지정'}</span>
      </div>
      <small>
        {team && agentName(t) + ' · '}
        {statusLabel[t.status]} · {elapsed(t)}
      </small>
    </button>
  )
}

function ReportMarkdown({ text, todo = false }: { text: string; todo?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const renderer = new Renderer()
    const literal = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    renderer.html = token => literal(token.text)
    renderer.image = token => literal(token.text)
    renderer.link = function (token) { return this.parser.parseInline(token.tokens) }
    const html = marked.parse(text, { renderer, gfm: true, breaks: true, async: false })
    const report = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ALLOWED_ATTR: [], ALLOW_ARIA_ATTR: false, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true
    })
    for (const table of report.querySelectorAll('table')) {
      const scroll = document.createElement('div')
      scroll.className = 'wb-table-scroll'
      scroll.tabIndex = 0
      scroll.setAttribute('role', 'region')
      scroll.setAttribute('aria-label', table.previousElementSibling?.matches('h1,h2,h3,h4,h5,h6') ? table.previousElementSibling.textContent || '표' : '표')
      table.replaceWith(scroll)
      scroll.append(table)
    }
    container.current?.replaceChildren(report)
  }, [text])
  return <div className={todo ? 'wb-markdown wb-todo-report' : 'wb-markdown'} ref={container} />
}

const inlineDocument = /\.(?:md|markdown|mdx|txt|csv|json)$/i

function DocumentTargets({ workspace, id, paths, previous, onOpenFile }: {
  workspace: string; id: string; paths: string[]; previous: boolean; onOpenFile: Props['onOpenFile']
}) {
  const [selected, setSelected] = useState(paths[0])
  const [offsets, setOffsets] = useState([0])
  const [attempt, setAttempt] = useState(0)
  const [page, setPage] = useState<{ path: string; offset: number; text: string; nextOffset: number | null } | null>(null)
  const [readError, setReadError] = useState('')
  const [viewerError, setViewerError] = useState('')
  const [opening, setOpening] = useState(false)
  const request = useRef(0)
  const offset = offsets[offsets.length - 1]
  const markdown = /\.(?:md|markdown|mdx)$/i.test(selected)
  const inline = inlineDocument.test(selected)
  const content = page?.path === selected && page.offset === offset ? page : null
  const prefix = workspace.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  const label = (path: string) => path.replace(/\\/g, '/').startsWith(prefix)
    ? path.replace(/\\/g, '/').slice(prefix.length) : path

  const fileError = (path: string, err: unknown) => {
    const message = errMsg(err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    if (/ENOENT|no such file/i.test(message)) return `「${label(path)}」 파일을 찾을 수 없습니다.`
    return `「${label(path)}」 문서를 열지 못했습니다. ${message}`
  }

  useEffect(() => () => { request.current++ }, [])
  useEffect(() => {
    let live = true
    setPage(null)
    setReadError('')
    if (inline) {
      window.lt.workBoard.documentText(workspace, id, selected, offset).then(
        result => { if (live) setPage({ path: selected, offset, text: result.text, nextOffset: result.nextOffset }) },
        err => { if (live) setReadError(fileError(selected, err)) }
      )
    }
    return () => { live = false }
  }, [workspace, id, selected, offset, inline, attempt])

  async function openWindow(path: string) {
    const current = ++request.current
    setOpening(true)
    setViewerError('')
    try {
      const verified = await window.lt.workBoard.documentPath(workspace, id, path)
      if (current === request.current) await onOpenFile(verified)
    } catch (err) {
      if (current === request.current) setViewerError(fileError(path, err))
    } finally {
      if (current === request.current) setOpening(false)
    }
  }

  return <section className="wb-target-documents" aria-label="결재 대상 문서">
    <h3>{previous ? '수정 전 결재 대상 문서' : '결재 대상 문서'}</h3>
    <div className="wb-target-list">
      {paths.map(path => <button type="button" key={path} className="wb-btn"
        aria-pressed={path === selected} disabled={opening && path === selected} onClick={() => {
          request.current++
          setOpening(false)
          setSelected(path)
          setViewerError('')
          setOffsets([0])
          if (inlineDocument.test(path)) {
            if (selected === path) setAttempt(n => n + 1)
          } else void openWindow(path)
        }}>
        <span className="wb-target-type">{path.split('.').pop()?.toUpperCase()}</span>{label(path)} 열기
      </button>)}
    </div>
    {opening && <p role="status">문서 창을 여는 중…</p>}
    {viewerError && <p className="wb-error" role="alert">{viewerError} <button type="button" className="wb-btn" onClick={() => void openWindow(selected)}>다시 열기</button></p>}
    {inline && <div className="wb-artifact">
      <div className="wb-split-label">
        <strong>{label(selected)}</strong>
        {content && offsets.length === 1 && content.nextOffset === null && (
          <button type="button" className="wb-btn" disabled={opening} onClick={() => void openWindow(selected)}>문서 창에서 열기</button>
        )}
      </div>
      {readError ? <p className="wb-error" role="alert">{readError} <button type="button" className="wb-btn" onClick={() => setAttempt(n => n + 1)}>문서 다시 불러오기</button></p>
        : !content ? <p role="status">문서를 불러오는 중…</p>
        : !content.text ? <p className="wb-muted">본문이 비어 있습니다.</p>
        : <div className="wb-document-body" tabIndex={0} role="region" aria-label={label(selected) + ' 본문'}>
            {markdown ? <ReportMarkdown text={content.text} /> : <pre className="wb-notes">{content.text}</pre>}
          </div>}
      {(offsets.length > 1 || content?.nextOffset != null) && <div className="wb-actions">
        <span className="wb-muted">본문 {offsets.length}번째 부분</span>
        <button type="button" className="wb-btn" disabled={offsets.length < 2} onClick={() => setOffsets(parts => parts.slice(0, -1))}>이전 부분</button>
        <button type="button" className="wb-btn" disabled={content?.nextOffset == null} onClick={() => {
          if (content?.nextOffset != null && content.nextOffset > offset) setOffsets([...offsets, content.nextOffset])
        }}>다음 부분</button>
      </div>}
    </div>}
  </section>
}

function Details({
  task,
  workspace,
  readOnly,
  tasks,
  agents,
  refresh,
  manageHere,
  scopeOptions,
  onOpenFile,
  onDecision,
  close,
  reorder
}: {
  task: BoardTask
  workspace: string
  readOnly: boolean
  tasks: BoardTask[]
  agents: BoardAgent[]
  refresh: () => Promise<void>
  manageHere?: () => void
  scopeOptions: ScopeOptions
  onOpenFile: Props['onOpenFile']
  close: () => void
  onDecision: (task: BoardTask, action: BoardDecision, reason: string, revision?: string, todoScope?: BoardTodoScope) => Promise<void>
  reorder?: () => Promise<void>
}) {
  const detailKey = JSON.stringify([workspace, task.id, task.updatedAt])
  const [loaded, setLoaded] = useState<{ key: string; report: string; review: string } | null>(null)
  const [readError, setReadError] = useState('')
  const [readAttempt, setReadAttempt] = useState(0)
  const files = loaded?.key === detailKey ? loaded : null
  const reportAvailable = !!files && boardReportAvailable(files.report)
  const missingApprovalReport = task.status === 'awaiting_approval' && !!files && !reportAvailable
  const canRetry = !task.parentId && (['failed', 'blocked', 'rejected'].includes(task.status) || missingApprovalReport)
  const [mutation, setMutation] = useState<{ kind: 'update' | 'remove'; task: BoardTask; revision: string } | null>(null)
  const editIssue = boardMutationIssue(task, tasks, 'update')
  const removeIssue = boardMutationIssue(task, tasks, 'remove')
  const changeIssue = mutation && (
    (readOnly && '관리 기기가 변경되었습니다. 지시를 다시 열어 주세요.') ||
    (mutation.kind === 'update' ? editIssue : removeIssue) ||
    (readError && '상세 창에서 보고서 다시 불러오기를 눌러 주세요.') ||
    (!files && '지시 상태를 확인하고 있습니다.') ||
    (files && mutation.revision !== boardRevision(task, files) && '지시 내용이 바뀌었습니다. 변경된 지시를 확인한 뒤 다시 선택해 주세요.')
  ) || undefined
  const openMutation = (kind: 'update' | 'remove') => {
    if (files) setMutation({ kind, task, revision: boardRevision(task, files) })
  }
  const [reason, setReason] = useState('')
  const [chosenScope, setChosenScope] = useState<BoardTodoScope>()
  const retryTodo = !readOnly && canRetry && isBoardTodoReview(task.body)
  const scopes = useTodoScopeOptions(retryTodo, scopeOptions, () => setChosenScope(undefined))
  const retryScope = retryTodo ? selectedScope(scopes, chosenScope) : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLoaded(null)
    setReadError('')
    window.lt.workBoard.detail(workspace, task.id).then(
      f => { if (current) setLoaded({ ...f, key: detailKey }) },
      err => { if (current) setReadError(errMsg(err) || '보고서와 검토 결과를 불러오지 못했습니다.') }
    )
    return () => { current = false }
  }, [workspace, task.id, detailKey, readAttempt])
  const act = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      close()
    } catch (err) {
      setError(errMsg(err))
      setReadAttempt(n => n + 1)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const history = task.log.filter((l) => /결재|승인|반려|수정 지시/.test(l.text))
  const todoReview = isBoardTodoReview(task.body)
  const storedReason = files && !reportAvailable ? files.report.trim().replace(/^#{1,6}\s*(?:결재 필요|할\s*일 조회 확인 필요)\s*(?:\n+|$)/u, '').trim() : ''
  const blockReason = /^mcp__[\w.-]+__[\w.-]+$/u.test(storedReason)
    ? (todoReview ? '이전 실행은 할일 목록 조회 단계에서 멈췄습니다.' : '요청한 도구의 실행이 중단됐습니다.') + '\n요청한 도구 · ' + storedReason
    : storedReason || (['blocked', 'failed'].includes(task.status) ? task.log.at(-1)?.text : '')
  const targetReport = !todoReview && reportAvailable ? files?.report : undefined
  const paths = useMemo(() => targetReport ? boardDocumentPaths(targetReport, workspace) : [], [targetReport, workspace])
  const reportIsTarget = reportAvailable && paths.length === 0 && !task.editedNeedsRun
  return (
    <Dialog title={task.title} close={close}>
      <div className="wb-muted">
        {task.id} · {statusLabel[task.status]} · {agentName(task)}
        {task.due && ' · 기한 ' + task.due}
      </div>
      {paths.length > 0 && <DocumentTargets key={JSON.stringify([detailKey, paths])}
        workspace={workspace} id={task.id} paths={paths} previous={!!task.editedNeedsRun} onOpenFile={onOpenFile} />}
      <section className={reportIsTarget ? 'wb-report-preview wb-target-documents' : 'wb-report-preview'}
        aria-label={reportIsTarget ? '결재 대상 문서' : '업무 보고서'}>
        <h3>{reportIsTarget ? '결재 대상 문서' : task.editedNeedsRun && reportAvailable ? '수정 전 보고서' : '업무 보고서'}</h3>
        {reportIsTarget && <p className="wb-target-title">업무 보고서 · {task.title}</p>}
        {readError ? <div className="wb-error" role="alert">
          보고서와 검토 결과를 불러오지 못했습니다. {readError}
          <button type="button" className="wb-btn" onClick={() => setReadAttempt(n => n + 1)}>보고서 다시 불러오기</button>
        </div> : !files ? <p role="status">보고서를 불러오는 중…</p>
          : reportAvailable ? <ReportMarkdown text={files.report} todo={todoReview} />
          : <p className="wb-muted">아직 결재할 업무 보고서가 없습니다.</p>}
        {task.editedNeedsRun && <p className="wb-muted">수정된 지시의 보고서는 다시 수행한 뒤 확인할 수 있습니다.</p>}
      </section>
      {files && (files.review || task.review_agent) && <section className="wb-review-preview">
        <h3>{task.editedNeedsRun && files.review ? '수정 전 검토 결과' : '검토 결과'}{task.review_agent && ' · ' + task.review_agent}</h3>
        <p className="wb-notes">{files.review || '검토 결과 대기 중'}</p>
      </section>}
      {blockReason && <section className="wb-block-reason">
        <h3>{task.status === 'failed' ? '실패 사유' : '확인 사유'}</h3>
        <p className="wb-notes">{blockReason}</p>
      </section>}
      {task.after_approval && (
        <section>
          <h3>승인 후 실행</h3>
          <p className="wb-notes">{task.after_approval}</p>
          <strong>허용 도구</strong>
          <p className="wb-notes">{task.allowed_tools?.join('\n') || '추가 허용 없음'}</p>
        </section>
      )}
      {!readOnly && (
        <div className="wb-form">
          {task.status === 'awaiting_approval' && (
            <>
              <label>
                {missingApprovalReport ? '반려 사유·수정 지시 또는 재수행 메모' : '반려 사유 또는 수정 지시'}
                <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="wb-actions">
                <button
                  className="wb-btn"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => onDecision(task, 'revise', reason.trim()))}
                >
                  수정 지시
                </button>
                <button
                  className="wb-btn"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => onDecision(task, 'reject', reason.trim()))}
                >
                  반려
                </button>
                {reportAvailable && !task.editedNeedsRun && files && <button
                  className="wb-btn wb-primary"
                  disabled={busy}
                  onClick={() => act(() => onDecision(task, 'approve', '', boardRevision(task, files)))}
                >
                  승인
                </button>}
              </div>
            </>
          )}
          {task.parentId && ['failed', 'blocked'].includes(task.status) && (
            <>
              <label>
                외부 실행 결과 확인 기록
                <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="wb-actions">
                <button
                  className="wb-btn"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => onDecision(task, 'reject', reason.trim()))}
                >
                  미실행 확인 · 결재함으로
                </button>
                <button
                  className="wb-btn"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => onDecision(task, 'complete', reason.trim()))}
                >
                  실행 확인 · 완료 처리
                </button>
              </div>
            </>
          )}
          {canRetry && (
            <>
              {!missingApprovalReport && <label>
                {retryTodo ? '재조회 메모 (선택)' : '추가 답변 또는 재수행 지시'}
                <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
              </label>}
              {retryTodo && <>
                <p className="wb-muted">{scopes.pinned ? '연결된 사건을 확인한 뒤' : '아래에서 할일 검토 범위를 선택한 뒤'} ‘다시 대기열에 넣기’를 누르면 할일을 다시 조회합니다.</p>
                <ScopeField options={scopes} value={retryScope} change={setChosenScope} />
              </>}
              <div className="wb-actions">
                {retryScope?.kind === 'all' && <small>{allTodosNotice}</small>}
                <button
                  className="wb-btn"
                  disabled={busy || (retryTodo && !retryScope)}
                  onClick={() => act(() => onDecision(task, 'retry', reason.trim(), undefined, retryScope))}
                >
                  다시 대기열에 넣기
                </button>
                {task.status === 'blocked' && !task.editedNeedsRun && reportAvailable && files && (!todoReview || !!task.review_agent) && (
                  <button className="wb-btn" disabled={busy} onClick={() => act(() => onDecision(task, 'submit', '', boardRevision(task, files)))}>
                    현재 보고서로 결재 요청
                  </button>
                )}
              </div>
            </>
          )}
          {reorder && (
            <div className="wb-actions">
              <button className="wb-btn" disabled={busy} onClick={() => act(reorder)}>
                대기열 맨 앞으로
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="wb-error" role="alert">
          {error}
        </p>
      )}
      <div className="wb-detail-history">
        <details>
          <summary>지시 본문</summary>
          <p className="wb-notes">{task.body}</p>
        </details>
        <details>
          <summary>진행 로그 ({task.log.length})</summary>
          <ol>{task.log.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}</li>)}</ol>
        </details>
        <details>
          <summary>결재 이력 ({history.length})</summary>
          {history.length ? <ol>{history.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}</li>)}</ol>
          : <p className="wb-muted">결재 이력이 없습니다.</p>}
        </details>
      </div>
      {readOnly ? <div className="wb-management">
        <p>지시 수정·삭제와 결재는 관리 기기에서 할 수 있습니다.</p>
        {manageHere && <button className="wb-btn" onClick={manageHere}>이 PC에서 관리</button>}
      </div> : <div className="wb-management" aria-label="선택한 지시 관리">
        <div className="wb-actions">
          <button className="wb-btn" disabled={busy || !files || !!editIssue} title={editIssue} onClick={() => openMutation('update')}>지시 수정</button>
          <button className="wb-btn wb-remove" disabled={busy || !files || !!removeIssue} title={removeIssue} onClick={() => openMutation('remove')}>지시 삭제</button>
        </div>
        {editIssue && <p>{editIssue}</p>}
        {removeIssue && removeIssue !== editIssue && <p>{removeIssue}</p>}
      </div>}
      {mutation?.kind === 'update' && <Dialog title="지시 수정" close={() => { if (!busy) setMutation(null) }}>
        <InstructionForm agents={agents} existing={mutation.task} scopeOptions={scopeOptions} issue={changeIssue}
          submit={async ([draft]) => {
            setBusy(true)
            try {
              await window.lt.workBoard.updateTask(workspace, mutation.task.id, draft, mutation.revision)
              setMutation(null)
              await refresh()
            } finally { setBusy(false) }
          }} />
      </Dialog>}
      {mutation?.kind === 'remove' && <ConfirmAction title="지시 삭제" confirmLabel="삭제 확인" issue={changeIssue}
        close={() => setMutation(null)} confirm={async () => {
          await window.lt.workBoard.removeTask(workspace, mutation.task.id, mutation.revision)
          close()
          await refresh()
        }}>
        <p>「{mutation.task.title}」의 지시서·보고서·검토서를 이 보드의 <code>_보관</code> 폴더로 옮깁니다.</p>
      </ConfirmAction>}
    </Dialog>
  )
}

export function WorkBoard(props: Props) {
  return <BoardWorkspace key={props.workspace} {...props} />
}
function BoardWorkspace({ workspace, view, onView, bulkSeed, boundCase, onOpenFile }: Props) {
  const api = window.lt.workBoard
  const [data, setData] = useState<BoardSnapshot | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState(view)
  const [takeover, setTakeover] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<number | null>(null)
  const [report, setReport] = useState('')
  const [exporting, setExporting] = useState(false)
  const scopeOptions: ScopeOptions = {
    caseIds: data?.todoCaseIds?.length ? data.todoCaseIds : boundCase ? [boundCase.id] : [],
    boundCase
  }
  const drag = useRef<string | null>(null)
  const version = useRef(0)
  const mounted = useRef(true)
  const canonical = useRef(workspace)
  const refresh = async (open = false) => {
    const n = ++version.current
    try {
      const next = await (open ? api.open(workspace) : api.snapshot(workspace))
      if (mounted.current && n === version.current) {
        canonical.current = next.workspace || workspace
        setData(next)
        setError('')
      }
    } catch (err) {
      if (mounted.current && n === version.current) setError(errMsg(err))
    }
  }
  useEffect(() => {
    mounted.current = true
    if (!workspace) return
    let live = true,
      pending = false,
      refreshing = false
    const update = async () => {
      pending = true
      if (refreshing) return
      refreshing = true
      while (live && pending) {
        pending = false
        await refresh()
      }
      refreshing = false
    }
    let ready = false
    const off = api.onChange((key) => {
      if (key === workspace || key === canonical.current) {
        if (ready) void update()
        else pending = true
      }
    })
    void refresh(true).then(() => {
      ready = true
      if (live && pending) void update()
    })
    return () => {
      mounted.current = false
      live = false
      off()
    }
  }, [workspace, api])
  useEffect(() => {
    setTab(view)
    setSelected(null)
    setSettings(false)
  }, [view])
  const navigate = (next: WorkBoardView) => {
    setTab(next)
    setSelected(null)
    onView?.(next)
  }
  const ordered = [...(data?.tasks || [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const queued = ordered.filter((t) => t.status === 'queued')
  const task = ordered.find((t) => t.id === selected)
  const reorder = async (id: string, before: string) => {
    if (id === before) return
    const ids = queued.map((t) => t.id).filter((x) => x !== id)
    const at = ids.indexOf(before)
    if (at < 0 || !queued.some((t) => t.id === id)) return
    ids.splice(at, 0, id)
    await api.reorder(workspace, ids)
    await refresh()
  }
  const card = (t: BoardTask) => (
    <TaskCard
      key={t.id}
      task={t}
      team={data?.teams.find((team) => team.agents.includes(agentName(t)))}
      open={() => setSelected(t.id)}
      dragging={drag}
      move={
        t.status === 'queued' && !data?.readOnly
          ? (id) => void reorder(id, t.id).catch((e) => setError(errMsg(e)))
          : undefined
      }
    />
  )
  const approvalCount = ordered.filter(stats[1].matches).length
  const ownerRevision = data?.ownerRevision
  const requestTakeover = ownerRevision ? () => setTakeover(ownerRevision) : undefined
  const actionHost = onView && data ? document.getElementById('work-board-actions') : null
  const actions = (
    <div className="wb-actions">
      <button disabled={!data} onClick={() => navigate('bulk')}>
        ＋ 일괄 지시
      </button>
      <button disabled={!data || data.readOnly} onClick={() => setSettings(true)}>
        설정
      </button>
    </div>
  )
  return (
    <section className="work-board" aria-label="업무 보드">
      {actionHost ? (
        createPortal(actions, actionHost)
      ) : (
        <header className="wb-toolbar">
          {!onView && (
            <nav className="wb-tabs" aria-label="업무지시 메뉴">
              {(
                [
                  ['board', '업무 보드'],
                  ['approvals', '결재함'],
                  ['daily', '일일 보고']
                ] as const
              ).map(([key, label]) => (
                <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => navigate(key)}>
                  {label}{' '}
                  {key === 'approvals' && approvalCount > 0 && <span className="wb-count">{approvalCount}</span>}
                </button>
              ))}
            </nav>
          )}
          {actions}
        </header>
      )}
      {error && (
        <div className="wb-error" role="alert">
          {error}{' '}
          <button className="wb-btn" onClick={() => void refresh(!data)}>
            다시 불러오기
          </button>
        </div>
      )}
      {!workspace ? (
        <p className="wb-status">사건 또는 작업 폴더를 먼저 선택하세요.</p>
      ) : (
        !data &&
        !error && (
          <p className="wb-status" role="status">
            업무지시를 불러오는 중…
          </p>
        )
      )}
      {!!data?.warnings?.length && <details className="wb-error"><summary>읽지 못한 보드 파일 {data.warnings.length}개</summary>{data.warnings.map(warning => <div key={warning}>{warning}</div>)}</details>}
      {data?.readOnly && (
        <div className="wb-status wb-owner">
          <span>이 보드의 지시 수정과 결재는 관리 기기에서 할 수 있습니다.</span>
          {requestTakeover
            ? <button className="wb-btn" onClick={requestTakeover}>이 PC에서 관리</button>
            : <button className="wb-btn" onClick={() => void refresh()}>관리 기기 정보 다시 조회</button>}
        </div>
      )}
      {data && (
        <>
          {(tab === 'board' || tab === 'bulk') && (
            <div className="wb-layout">
              <main className="wb-main">
                <div className="wb-summary">
                  {stats.map((s, i) => (
                    <button
                      key={s.label}
                      className="wb-stat"
                      aria-pressed={filter === i}
                      onClick={() => setFilter(filter === i ? null : i)}
                    >
                      <strong style={{ color: s.color }}>{ordered.filter(s.matches).length}</strong>
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
                <div className="wb-columns">
                  {lanes.map((lane) => {
                    const items = ordered.filter(
                      (t) => lane.statuses.includes(t.status) && (filter === null || stats[filter].matches(t))
                    )
                    return (
                      <section key={lane.title} className="wb-lane">
                        <h3 className="wb-split-label">
                          {lane.title}
                          <span>{items.length}</span>
                        </h3>
                        <div className="wb-lane-scroll">{items.map(card)}</div>
                      </section>
                    )
                  })}
                </div>
              </main>
              <Organization data={data} />
            </div>
          )}
          {tab === 'approvals' && (
            <main className="wb-page">
              <div className="wb-page-head">
                <h2>결재함 · {approvalCount}건</h2>
              </div>
              {ordered.filter(stats[1].matches).map(card)}
              {!approvalCount && <p className="wb-muted">결재를 기다리는 지시가 없습니다.</p>}
            </main>
          )}
          {tab === 'daily' && (
            <main className="wb-page">
              <div className="wb-page-head">
                <h2>일일 보고</h2>
                <button
                  className="wb-btn"
                  disabled={exporting || data.readOnly}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      setReport(await api.daily(workspace))
                    } catch (e) {
                      setError(errMsg(e))
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  오늘 보고서 저장
                </button>
              </div>
              <p className="wb-muted">
                한국 시간 {data.settings.dailyTime} · {data.folder}/_일일보고/ · Markdown 및 HTML
              </p>
              {report ? (
                <p className="wb-notes">{report}</p>
              ) : (
                stats.map((s) => (
                  <section key={s.label}>
                    <h3>
                      {s.label} · {ordered.filter(s.matches).length}건
                    </h3>
                    {ordered.filter(s.matches).map(card)}
                  </section>
                ))
              )}
            </main>
          )}
          {tab === 'bulk' && (
            <Dialog title="일괄 지시" close={() => navigate('board')}>
              <InstructionForm
                agents={data.agents}
                seed={bulkSeed}
                scopeOptions={scopeOptions}
                submit={async (drafts, batchId) => {
                  await api.add(workspace, drafts, batchId)
                  navigate('board')
                  await refresh()
                }}
              />
            </Dialog>
          )}
          {settings && (
            <Dialog title="업무 보드 설정" close={() => setSettings(false)}>
              <Settings
                data={data}
                submit={async (folder, values) => {
                  if (folder !== data.folder) setData(await api.open(workspace, folder))
                  await api.configure(workspace, values)
                  setSettings(false)
                  await refresh()
                }}
              />
            </Dialog>
          )}
          {task && (
            <Details
              key={task.id}
              task={task}
              scopeOptions={scopeOptions}
              workspace={data.workspace || workspace}
              readOnly={!!data.readOnly}
              tasks={data.tasks}
              agents={data.agents}
              refresh={refresh}
              manageHere={requestTakeover}
              close={() => setSelected(null)}
              onOpenFile={onOpenFile}
              onDecision={async (t, action, reason, revision, todoScope) => {
                await api.decide(workspace, t.id, action, reason, revision, todoScope)
                await refresh()
              }}
              reorder={
                task.status === 'queued' && !data.readOnly && queued[0]?.id !== task.id
                  ? () => reorder(task.id, queued[0].id)
                  : undefined
              }
            />
          )}
        </>
      )}
      {takeover !== null && <ConfirmAction title="관리 기기 변경" confirmLabel="관리 기기 변경"
        issue={takeover !== ownerRevision || !data?.readOnly ? '관리 기기 정보가 바뀌었습니다. 창을 닫고 다시 확인해 주세요.' : undefined}
        close={() => setTakeover(null)} confirm={async () => {
          try { await api.takeOwnership(workspace, takeover) }
          finally { await refresh() }
        }}>
        <p>이전 관리 기기가 v0.1.350 이하이거나 버전을 모르면 그 기기의 앱을 먼저 종료하세요. 동기화 폴더는 양쪽 동기화가 끝난 뒤 변경하세요.</p>
        <p>대기 중인 지시는 이 PC에서 이어서 배분합니다. 중단된 수행·검토 지시는 재시도하고, 승인 후 실행은 실제 처리 결과를 먼저 확인하세요.</p>
        <p>할일 조회 동의와 승인 후 실행 권한은 이 PC에서 다시 확인하세요. 일일 보고 시각 등 배분 설정은 이 PC의 값을 사용합니다.</p>
      </ConfirmAction>}
    </section>
  )
}
