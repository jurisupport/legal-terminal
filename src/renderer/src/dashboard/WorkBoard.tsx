import { boardDelegates, isBoardDepartmentTask, boardFollowUpRevision, boardRequestsTodoRead, boardResultKind, isBoardReport, isBoardDecisionPending, canRetryAsReport, boardReferencePaths, boardDocumentPaths, boardMutationIssue, boardReportAvailable, boardRevision, requestsCurrentBoardCase, isBoardTodoReview } from '../../../shared/workBoard'
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

export type WorkBoardView = 'board' | 'reports' | 'approvals' | 'daily' | 'bulk'
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
  delegated: '부서원 수행 중',
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
  { title: '수행 중', statuses: ['running', 'delegated', 'in_review', 'reported'] },
  { title: '확인 필요', statuses: ['blocked', 'failed', 'rejected'] },
  { title: '결재 대기', statuses: ['awaiting_approval'] },
  { title: '완료', statuses: ['done', 'approved'] }
]
const stats = [
  { label: '수행 중', matches: isBoardRunning, color: '#2161c7' },
  { label: '결재 대기', matches: isBoardDecisionPending, color: '#ad660d' },
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

type FormDraft = BoardDraft & { resultKind: ReturnType<typeof boardResultKind> }
const resultLabels = { report: '보고서 받기', final: '최종안 승인받기', action: '승인 후 실행' } as const

function approvalLabel(instruction: string) {
  // Label only an explicit delivery request. This never changes the allowed tools.
  const send = /(?:발송|전송|송부)(?:하기|한다|합니다|하세요|해(?:라|줘|주세요|주십시오)?|할것)?[.!]?$/u
  const compact = instruction.replace(/\s+/gu, '')
  return send.test(compact) && !/(?:금지|말고|마세요|보류|모의)/u.test(compact)
    ? '승인하고 발송 요청' : '승인하고 실행 요청'
}

function InstructionForm({
  agents,
  teams = [],
  seed,
  existing,
  followUp = false,
  issue,
  scopeOptions,
  submit
}: {
  agents: BoardAgent[]
  teams?: BoardTeam[]
  seed?: string
  existing?: BoardTask
  followUp?: boolean
  issue?: string
  scopeOptions: ScopeOptions
  submit: (drafts: BoardDraft[], batchId: string) => Promise<void>
}) {
  const [batchId] = useState(() => crypto.randomUUID())
  const [raw, setRaw] = useState(seed || '')
  const [blocks, setBlocks] = useState(false)
  const [drafts, setDrafts] = useState<FormDraft[]>(() => existing ? [{
    resultKind: boardResultKind(existing),
    title: existing.title, body: existing.body, agent: existing.agent, team: existing.team, due: existing.due,
    approval: existing.approval ?? 'required', review_agent: existing.review_agent,
    depends_on: existing.depends_on,
    after_approval: boardResultKind(existing) === 'action' ? existing.after_approval : undefined,
    allowed_tools: boardResultKind(existing) === 'action' ? existing.allowed_tools : undefined
  }] : followUp ? [{ title: '', body: '', resultKind: 'report' }] : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const update = (index: number, patch: Partial<FormDraft>) =>
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  const reviewRows = drafts.map(d => !existing && isBoardTodoReview(d.body))
  const scopes = useTodoScopeOptions(reviewRows.includes(true), scopeOptions, () => {
    setDrafts(rows => rows.map(({ todoScope, ...draft }) => draft))
  })
  const DraftSettings = followUp ? 'details' : 'div'
  const ready: BoardDraft[] = drafts.map(({ resultKind, todoScope, after_approval, allowed_tools, ...draft }, i) => {
    const originalMode = existing && resultKind === boardResultKind(existing)
    return {
      ...draft,
      title: followUp ? draft.body.trim().split(/\r?\n/, 1)[0].slice(0, 120) : draft.title,
      approval: resultKind === 'report' ? 'none' : 'required',
      after_approval: resultKind === 'action' ? after_approval : originalMode ? existing.after_approval : undefined,
      allowed_tools: resultKind === 'action' ? allowed_tools : originalMode ? existing.allowed_tools : undefined,
      todoScope: reviewRows[i] ? selectedScope(scopes, todoScope, !requestsCurrentBoardCase(draft.body) && (!followUp || /전체|모든/u.test(draft.body.replace(/\s+/gu, '')))) : undefined
    }
  })
  const emptyFollowUp = followUp && !drafts[0]?.body.trim()
  const missingAction = drafts.some(d => d.resultKind === 'action' && !d.after_approval?.trim())
  const missingScope = ready.some((d, i) => reviewRows[i] && !d.todoScope)
  const options = agents.map((a) => (
    <option key={a.name} value={a.name} title={a.description}>
      {a.name}
      {a.description && ' · ' + a.description}
    </option>
  ))
  return (
    <form className={followUp ? 'wb-followup-form' : undefined}
      onSubmit={async (e) => {
        e.preventDefault()
        if (!drafts.length) {
          const parts = raw
            .trim()
            .split(blocks ? /\r?\n\s*\r?\n/ : /\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
          setDrafts(
            parts.map((body) => ({ body, title: body.split('\n')[0].slice(0, 120), resultKind: 'report' }))
          )
          return
        }
        if (busy || issue || emptyFollowUp || missingScope || missingAction) return
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
            {!followUp && <legend>{existing ? '지시 내용' : `${i + 1}. ${d.title}`}</legend>}
            <div className="wb-fields">
              {!followUp && <label className="wb-wide">
                제목
                <input required value={d.title} onChange={(e) => update(i, { title: e.target.value })} />
              </label>}
              <label className="wb-wide">
                {followUp ? '추가 지시 내용' : '지시 본문'}
                <textarea required ref={el => { if (followUp && el) el.autofocus = true }} rows={followUp ? 4 : 2} value={d.body}
                  placeholder={followUp ? '예: 기한 초과 건의 안내문 초안을 작성해 줘' : undefined}
                  onChange={(e) => update(i, { body: e.target.value })} />
              </label>
              {reviewRows[i] && <ScopeField options={scopes} value={ready[i].todoScope}
                change={todoScope => update(i, { todoScope })} />}
            </div>
            <DraftSettings className="wb-draft-options">
              {followUp && <summary>업무 설정 · {resultLabels[d.resultKind]}</summary>}
              <div className="wb-fields">
              <label>
                담당
                <select value={d.team ? 'team:' + d.team : d.agent || ''} onChange={(e) => {
                  const value = e.target.value
                  update(i, value.startsWith('team:') ? { team: value.slice(5), agent: undefined } : { agent: value || undefined, team: undefined })
                }}>
                  <option value="">기본 세션</option>
                  {!existing?.delegatedBy && (teams.length > 0 || d.team) && <optgroup label="부서 · 부서장이 나눠 맡김">
                    {d.team && !teams.some(team => team.name === d.team) && <option value={'team:' + d.team}>{d.team} (현재 미등록)</option>}
                    {teams.map(team => <option key={team.name} value={'team:' + team.name}>
                      {team.name} · 부서장 {team.lead || '기본 세션'} · 부서원 {team.agents.length}명
                    </option>)}
                  </optgroup>}
                  <optgroup label="개별 담당 에이전트">
                    {d.agent && !agents.some(a => a.name === d.agent) && <option value={d.agent}>{d.agent} (현재 미등록)</option>}
                    {options}
                  </optgroup>
                </select>
                {d.team && <small>부서장이 업무를 나눠 부서원에게 하위 업무로 맡기고, 부서원 보고서를 모아 최종 보고서를 씁니다.</small>}
              </label>
              <label>
                기한
                <input type="date" value={d.due || ''} onChange={(e) => update(i, { due: e.target.value })} />
              </label>
              <label className="wb-wide">
                업무 결과
                <select value={d.resultKind} onChange={e => update(i, { resultKind: e.target.value as FormDraft['resultKind'] })}>
                  {(['report', 'final', 'action'] as const).map(kind => <option key={kind} value={kind}>{resultLabels[kind]}</option>)}
                </select>
                <small>{d.resultKind === 'report' ? '업무가 끝나면 보고서함에서 결과를 확인합니다.'
                  : d.resultKind === 'final' ? '결재함에서 보고서와 산출물을 읽고 최종안을 승인하거나 수정을 요청합니다.'
                  : '승인하면 아래에 적은 후속 작업을 대기열에 넣습니다.'}</small>
              </label>
              {d.resultKind === 'action' && (
                <>
                  <label className="wb-wide">
                    승인 후 실행할 지시
                    <textarea
                      required value={d.after_approval || ''}
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
            <details>
              <summary>검토 · 선행 지시</summary>
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
              </div>
            </details>
            </DraftSettings>
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
        <button disabled={busy || !!issue || emptyFollowUp || (!existing && !followUp && !raw.trim()) || missingScope || missingAction} className="wb-btn wb-primary">
          {existing ? '변경 저장' : followUp ? '추가 지시 등록' : drafts.length ? drafts.length + '건 등록' : '지시 내용 확인'}
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

function Organization({ data, edit }: { data: BoardSnapshot; edit?: () => void }) {
  const seen = new Set(data.teams.flatMap((t) => [...t.agents, ...(t.lead ? [t.lead] : [])]))
  const extra = new Set(
    [...data.agents.map((a) => a.name), ...data.tasks.filter(t => !t.team).map(agentName)].filter((a) => !seen.has(a))
  )
  const active = (t: BoardTask) => !['done', 'approved', 'rejected', 'failed'].includes(t.status)
  const member = (name: string) => {
    const tasks = data.tasks.filter(
      (t) => (!t.team && agentName(t) === name) || (t.status === 'in_review' && t.review_agent === name)
    )
    const open = tasks.filter(active)
    const recent = tasks
      .filter((t) => !active(t))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const running = open.some((t) =>
      t.status === 'in_review' ? t.review_agent === name : t.status === 'running'
    )
    return (
      <div className="wb-split-label" key={name}>
        <span>
          {running && <i className="wb-dot" aria-label="수행 중" />}
          {name}
        </span>
        <span>
          {open.length}건{recent && ' · ' + statusLabel[recent.status]}
        </span>
      </div>
    )
  }
  return (
    <aside className="wb-org" aria-label="조직도">
      <h3 className="wb-split-label">
        조직도
        {edit && <button type="button" className="wb-btn" onClick={edit}>부서 관리</button>}
      </h3>
      <div className="wb-org-head">대표 (결재)</div>
      {!data.teams.length && (
        <p className="wb-muted">
          아직 부서가 없습니다. 부서를 만들면 큰 업무를 부서에 맡기고, 부서장이 부서원에게 나눠 맡깁니다.
        </p>
      )}
      {data.teams.map((team) => {
        const work = data.tasks.filter((t) => t.team === team.name && !t.delegatedBy)
        const leading = work.some((t) => t.status === 'running')
        return (
          <section key={team.name} className="wb-team">
            <h4>
              <i style={{ backgroundColor: team.color }} />
              {team.name}
            </h4>
            <div className="wb-split-label wb-org-lead">
              <span>
                {leading && <i className="wb-dot" aria-label="부서장 수행 중" />}
                부서장 · {team.lead || '기본 세션'}
              </span>
              <span>부서 업무 {work.filter(active).length}건</span>
            </div>
            {team.agents.map(member)}
            {!team.agents.length && <p className="wb-muted">부서원이 없습니다.</p>}
          </section>
        )
      })}
      {extra.size > 0 && (
        <section className="wb-team">
          <h4>
            <i style={{ backgroundColor: '#64748b' }} />
            부서 미지정
          </h4>
          {[...extra].sort().map(member)}
        </section>
      )}
    </aside>
  )
}

const teamColors = ['#376ac6', '#148369', '#c65f16', '#8c44bb', '#c42c32', '#168097']

function TeamEditor({ data, save, close }: {
  data: BoardSnapshot
  save: (teams: BoardTeam[]) => Promise<void>
  close: () => void
}) {
  const [rows, setRows] = useState<BoardTeam[]>(() => data.teams.map((team) => ({ ...team, agents: [...team.agents] })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const names = data.agents.map((agent) => agent.name)
  const describe = (name: string) => data.agents.find((agent) => agent.name === name)?.description
  const update = (index: number, patch: Partial<BoardTeam>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const inUse = data.teams
    .filter((team) => !rows.some((row) => row.name.trim() === team.name))
    .filter((team) => data.tasks.some((t) => t.team === team.name && !['done', 'approved', 'rejected', 'failed'].includes(t.status)))
  const issue = inUse.length
    ? `진행 중인 업무가 있는 부서는 삭제하거나 이름을 바꿀 수 없습니다: ${inUse.map((team) => team.name).join(', ')}`
    : undefined
  return (
    <Dialog title="부서 관리" close={() => { if (!busy) close() }}>
      <form onSubmit={async (e) => {
        e.preventDefault()
        if (busy || issue) return
        setBusy(true)
        setError('')
        try {
          await save(rows.map((row) => ({ ...row, name: row.name.trim(), lead: row.lead || undefined })))
          close()
        } catch (err) {
          setError(errMsg(err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
        } finally {
          setBusy(false)
        }
      }}>
        <p className="wb-muted">
          부서에 업무를 맡기면 부서장이 업무를 나눠 부서원에게 하위 업무로 배분합니다. 부서원 보고서가 모두 도착하면 부서장이 최종 보고서를 써서 보고서함이나 결재함으로 보냅니다.
        </p>
        {!names.length && (
          <p className="wb-muted">
            등록된 에이전트가 없습니다. Claude 설정 폴더의 agents 폴더(예: ~/.claude/agents)에 에이전트 정의 파일(.md)을 넣으면 부서장·부서원으로 고를 수 있습니다.
          </p>
        )}
        {rows.map((row, i) => (
          <fieldset className="wb-draft" key={i} disabled={busy}>
            <legend>{row.name.trim() || '새 부서'}</legend>
            <div className="wb-fields">
              <label>
                부서 이름
                <input required maxLength={40} value={row.name} onChange={(e) => update(i, { name: e.target.value })} />
              </label>
              <label>
                색상
                <input type="color" value={row.color} onChange={(e) => update(i, { color: e.target.value })} />
              </label>
              <label className="wb-wide">
                부서장
                <select value={row.lead || ''} onChange={(e) => update(i, { lead: e.target.value || undefined })}>
                  <option value="">기본 세션</option>
                  {row.lead && !names.includes(row.lead) && <option value={row.lead}>{row.lead} (현재 미등록)</option>}
                  {names.map((name) => <option key={name} value={name} title={describe(name)}>{name}</option>)}
                </select>
              </label>
              <div className="wb-wide wb-members" role="group" aria-label={(row.name.trim() || '새 부서') + ' 부서원'}>
                <span>부서원</span>
                {[...new Set([...names, ...row.agents])].map((name) => (
                  <label className="wb-check" key={name} title={describe(name)}>
                    <input type="checkbox" checked={row.agents.includes(name)} onChange={(e) =>
                      update(i, { agents: e.target.checked ? [...row.agents, name] : row.agents.filter((agent) => agent !== name) })} />
                    {name}{!names.includes(name) && ' (현재 미등록)'}{describe(name) && <small> · {describe(name)}</small>}
                  </label>
                ))}
                {!names.length && !row.agents.length && <small>고를 수 있는 에이전트가 없습니다.</small>}
              </div>
            </div>
            <div className="wb-actions">
              <button type="button" className="wb-btn wb-remove" onClick={() => setRows((current) => current.filter((_, j) => j !== i))}>
                부서 삭제
              </button>
            </div>
          </fieldset>
        ))}
        <div className="wb-actions">
          <button type="button" className="wb-btn" disabled={busy} onClick={() =>
            setRows((current) => [...current, { name: '', color: teamColors[current.length % teamColors.length], agents: [] }])}>
            ＋ 부서 추가
          </button>
        </div>
        {issue && <p className="wb-error" role="status">{issue}</p>}
        {error && <p className="wb-error" role="alert">{error}</p>}
        <div className="wb-actions">
          <button type="button" className="wb-btn" disabled={busy} onClick={close}>취소</button>
          <button className="wb-btn wb-primary" disabled={busy || !!issue}>부서 저장</button>
        </div>
      </form>
    </Dialog>
  )
}

function TaskCard({
  task: t,
  team,
  progress,
  open,
  move,
  dragging
}: {
  task: BoardTask
  team?: BoardTeam
  progress?: string
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
        {isBoardReport(t) && t.reportReceipt?.state === 'unread' && <span className="wb-report-unread">미확인</span>}
      </strong>
      <div className="wb-split-label">
        <span className="wb-team-label">{t.team ? t.team + ' 부서' : team?.name || agentName(t)}</span>
        <span className={isBoardDueSoon(t) ? 'wb-due' : ''}>{t.due || '기한 미지정'}</span>
      </div>
      <small>
        {t.delegatedBy ? '↳ 부서원 ' + agentName(t) + ' · ' : team && !t.team ? agentName(t) + ' · ' : ''}
        {t.status === 'approved' && boardResultKind(t) === 'action' ? '승인됨 · 실행 결과 대기' : statusLabel[t.status]} · {progress ? progress + ' · ' : ''}{elapsed(t)}
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

function DownloadButton({ name, report = false, save }: { name: string; report?: boolean; save: () => Promise<boolean> }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  return <div className="wb-download">
    <button type="button" className="wb-btn" aria-label={name + ' 다운로드'} disabled={saving} onClick={async () => {
      if (saving) return
      setSaving(true)
      setMessage('')
      setError('')
      try {
        setMessage(await save() ? '다운로드했습니다.' : '다운로드를 취소했습니다.')
      } catch (err) {
        setError('다운로드하지 못했습니다. ' + errMsg(err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
      } finally { setSaving(false) }
    }}>{saving ? '저장 중…' : report ? '보고서 다운로드' : '다운로드'}</button>
    {message && <small role="status">{message}</small>}
    {error && <small role="alert" className="wb-error">{error}</small>}
  </div>
}

function DocumentList({ workspace, id, paths, references = false, previous = false, reportOnly = false, onOpenFile }: {
  workspace: string; id: string; paths: string[]; references?: boolean; previous?: boolean; reportOnly?: boolean; onOpenFile: Props['onOpenFile']
}) {
  const [selected, setSelected] = useState(references ? '' : paths[0])
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

  const heading = references ? '작업 중 읽은 참고 문서' : reportOnly ? (previous ? '수정 전 산출물' : '보고 산출물') : previous ? '수정 전 결재 대상 문서' : '결재 대상 문서'
  return <section className={references ? 'wb-reference-documents' : 'wb-target-documents'} aria-label={heading}>
    <h3>{heading}</h3>
    <div className="wb-target-list">
      {paths.map(path => <div className="wb-document-row" key={path}>
        <button type="button" className="wb-btn"
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
        </button>
        <DownloadButton name={label(path)} save={() => window.lt.workBoard.downloadDocument(workspace, id, path)} />
      </div>)}
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
  folder,
  readOnly,
  tasks,
  agents,
  teams,
  refresh,
  manageHere,
  scopeOptions,
  onOpenFile,
  selectTask,
  onDecision,
  close,
  reorder
}: {
  task: BoardTask
  workspace: string
  folder: string
  readOnly: boolean
  tasks: BoardTask[]
  agents: BoardAgent[]
  teams: BoardTeam[]
  refresh: () => Promise<void>
  manageHere?: () => void
  scopeOptions: ScopeOptions
  onOpenFile: Props['onOpenFile']
  selectTask: (id: string) => void
  close: () => void
  onDecision: (task: BoardTask, action: BoardDecision, reason: string, revision?: string, todoScope?: BoardTodoScope) => Promise<void>
  reorder?: () => Promise<void>
}) {
  const detailKey = JSON.stringify([workspace, task.id, task.updatedAt, task.reportReceipt?.digest])
  const [loaded, setLoaded] = useState<{ key: string; report: string; review: string } | null>(null)
  const [readError, setReadError] = useState('')
  const [readAttempt, setReadAttempt] = useState(0)
  const files = loaded?.key === detailKey ? loaded : null
  const reportAvailable = !!files && boardReportAvailable(files.report)
  const resultKind = boardResultKind(task)
  const retryAsReport = canRetryAsReport(task, tasks)
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
  const [followUp, setFollowUp] = useState<{ revision: string; title: string } | null>(null)
  const [newFollowUpId, setNewFollowUpId] = useState('')
  const followUps = tasks.filter(item => item.followUp?.id === task.id)
  const sourceTask = task.followUp && tasks.find(item => item.id === task.followUp?.id)
  const sourceRevision = useMemo(() => files ? boardFollowUpRevision(task, files) : null, [task, files])
  const beginFollowUp = () => {
    if (sourceRevision) setFollowUp({ revision: sourceRevision, title: task.title })
  }
  const delegates = boardDelegates(task, tasks)
  const departmentHead = task.delegatedBy ? tasks.find(item => item.id === task.delegatedBy) : undefined
  const [reason, setReason] = useState('')
  const [chosenScope, setChosenScope] = useState<BoardTodoScope>()
  const retryTodo = !readOnly && canRetry && isBoardTodoReview(task.body)
  const grantTodoRead = !readOnly && boardRequestsTodoRead(task) && !tasks.some(child => child.parentId === task.id)
  const scopes = useTodoScopeOptions(retryTodo || grantTodoRead, scopeOptions, () => setChosenScope(undefined))
  const retryScope = retryTodo || grantTodoRead ? selectedScope(scopes, chosenScope) : undefined
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
  const act = async (fn: () => Promise<void>, keepOpen = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      if (keepOpen) setReason('')
      else close()
    } catch (err) {
      setError(errMsg(err))
      setReadAttempt(n => n + 1)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const history = task.log.filter(l => /^(?:(?:승인|최종안 승인|승인 후 실행 요청)$|반려 · |수정 지시 등록 · )/.test(l.text))
  const permissions = task.log.filter(l => /^(?:결재 필요 · |권한 확인 또는 추가 답변 필요$|승인된 실행 · |JuriSupport 할일 조회 허용 · )/.test(l.text))
  const todoReview = isBoardTodoReview(task.body)
  const storedReason = files && !reportAvailable ? files.report.trim().replace(/^#{1,6}\s*(?:결재 필요|할\s*일 조회 확인 필요)\s*(?:\n+|$)/u, '').trim() : ''
  const lastEntry = task.log.at(-1)?.text || ''
  const lastPermission = lastEntry === '권한 확인 또는 추가 답변 필요'
    ? [...task.log].reverse().find(l => /^(?:결재 필요 · |수행 시작 · |검토 시작 · )/.test(l.text))?.text
    : undefined
  const diagnostic = storedReason || (['blocked', 'failed'].includes(task.status)
    ? (lastPermission?.startsWith('결재 필요 · ') ? lastPermission : lastEntry).replace(/^결재 필요 · /, '') : '')
  const bashBlocked = /(?:^|\n)\s*Bash\s*\(/i.test(diagnostic)
  const toolBlocked = /^mcp__[\w.-]+__[\w.-]+$/u.test(diagnostic)
  const blockReason = bashBlocked
    ? (todoReview
      ? '이전 실행에서 터미널 명령이 차단됐습니다. 조회 범위를 선택해 할일 정리를 다시 실행할 수 있습니다.'
      : '요청한 터미널 명령이 이 지시에 허용되지 않아 실행이 중단됐습니다.')
    : toolBlocked
      ? (todoReview ? '이전 실행은 할일 목록 조회 단계에서 멈췄습니다.' : '요청한 도구를 사용할 권한이 없어 실행이 중단됐습니다.')
      : diagnostic
  const targetReport = !todoReview && reportAvailable ? files?.report : undefined
  const paths = useMemo(() => targetReport ? boardDocumentPaths(targetReport, workspace, folder, task.id) : [], [targetReport, workspace, folder, task.id])
  const referencePaths = useMemo(() => {
    const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(workspace)
    const key = (path: string) => windows ? path.toLowerCase() : path
    const outputs = new Set(paths.map(key))
    return boardReferencePaths(task.log, workspace, task.id, folder).filter(path => !outputs.has(key(path)))
  }, [task.log, workspace, task.id, folder, paths])
  const reconcile = !!task.parentId && ['failed', 'blocked'].includes(task.status)
  const recovery = canRetry || reconcile
  const pendingChildren = !task.parentId && recovery
    ? tasks.filter(t => t.parentId === task.id && ['failed', 'blocked'].includes(t.status)) : []
  const canSubmit = !task.parentId && task.status === 'blocked' && !task.editedNeedsRun && reportAvailable && !!files && (!todoReview || !!task.review_agent)
  const ApprovalControls = missingApprovalReport ? 'details' : 'div'
  const reportIsTarget = resultKind !== 'report' && reportAvailable && paths.length === 0 && !task.editedNeedsRun
  const receipt = isBoardReport(task) ? task.reportReceipt : undefined
  const actionChild = resultKind === 'action' ? tasks.filter(t => t.parentId === task.id)
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined
  const nearReport = isBoardReport(task) && reportAvailable && !task.editedNeedsRun
  const nearDecision = !readOnly && isBoardDecisionPending(task) && !recovery
  const followUpActions = <nav className="wb-followups" aria-label="추가 업무">
    <button className="wb-btn wb-followup-open" type="button" disabled={busy || !files} onClick={beginFollowUp}>추가 업무 지시</button>
    {task.followUp && (sourceTask
      ? <button className="wb-btn" type="button" title={sourceTask.title} onClick={() => selectTask(sourceTask.id)}>원 지시 · {task.followUp.title}</button>
      : <details className="wb-followup-snapshot">
          <summary>원 지시 · {task.followUp.title} (보관된 내용)</summary>
          <p>원 지시가 현재 보드에 없어 등록 당시 보관한 내용을 표시합니다.</p>
          <p className="wb-notes">{task.followUp.body}</p>
          {task.followUp.report && <><strong>당시 보고서</strong><p className="wb-notes">{task.followUp.report}</p></>}
        </details>)}
    {followUps.map(item => <button className={item.id === newFollowUpId ? 'wb-btn wb-followup-added' : 'wb-btn'} type="button" key={item.id} onClick={() => selectTask(item.id)}>
      추가 지시 · {item.title}
    </button>)}
    {newFollowUpId && <span role="status">추가 지시를 등록했습니다.</span>}
    {newFollowUpId && !followUps.some(item => item.id === newFollowUpId) && <button type="button" className="wb-btn" onClick={() => void refresh()}>추가 지시 목록 다시 조회</button>}
  </nav>
  return (
    <Dialog title={task.title} close={close}>
      <div className="wb-detail-meta">
        <span className={recovery ? 'wb-needs-action' : ''}>{resultKind === 'action' && task.status === 'approved' ? '승인됨 · 실행 결과 대기' : statusLabel[task.status]}</span>
        {task.team && <span>{task.team} 부서 · 부서장 {teams.find(team => team.name === task.team)?.lead || '기본 세션'}</span>}
        {task.agent && <span>{task.delegatedBy ? '부서원 ' : ''}{agentName(task)}</span>}
        {task.due && <span>기한 {task.due}</span>}
      </div>
      {!nearReport && !nearDecision && followUpActions}
      {(isBoardDepartmentTask(task) || task.delegatedBy) && <section className="wb-delegates" aria-label="부서 배분">
        {task.delegatedBy ? <>
          <h3>부서장이 맡긴 하위 업무</h3>
          {departmentHead
            ? <button type="button" className="wb-btn" onClick={() => selectTask(departmentHead.id)}>부서 지시 · {departmentHead.title} · {statusLabel[departmentHead.status]}</button>
            : <p className="wb-muted">부서 지시가 현재 보드에 없습니다.</p>}
          <p className="wb-muted">이 업무가 끝나면 보고서가 부서장에게 전달됩니다. 보고서함에는 부서장의 최종 보고서만 도착합니다.</p>
        </> : <>
          <h3>부서 배분 · {task.team}</h3>
          {delegates.length ? <ol>
            {delegates.map(child => <li key={child.id}>
              <button type="button" className={['blocked', 'failed'].includes(child.status) ? 'wb-btn wb-needs-action' : 'wb-btn'} onClick={() => selectTask(child.id)}>
                {child.title} · {agentName(child)} · {statusLabel[child.status]}
              </button>
            </li>)}
          </ol> : <p className="wb-muted">{task.status === 'running' ? '부서장이 업무를 나누고 있습니다.' : task.status === 'queued' ? '부서장이 업무를 나눌 차례를 기다리고 있습니다.' : '배분한 하위 업무가 없습니다.'}</p>}
          {task.status === 'delegated' && <p className="wb-muted">
            하위 업무 {delegates.filter(child => child.status === 'done').length}/{delegates.length}건 완료. 모두 끝나면 부서장이 보고서를 취합합니다.
            {delegates.some(child => ['blocked', 'failed'].includes(child.status)) && ' 확인 필요 상태인 하위 업무를 먼저 처리하세요.'}
          </p>}
        </>}
      </section>}
      {recovery && files && <section className="wb-recovery" aria-label="다음 행동">
        {readOnly ? <>
          <h3>이 PC에서 업무를 처리하려면</h3>
          <p>현재 관리 기기를 이 PC로 변경하면 이 지시를 처리할 수 있습니다.</p>
          {manageHere && <button className="wb-btn wb-primary" onClick={manageHere}>이 PC에서 관리</button>}
        </> : pendingChildren.length ? <>
          <h3>승인 후 실행 결과를 확인하세요</h3>
          <p>외부에서 처리됐는지 먼저 확인할 지시가 있습니다.</p>
          {pendingChildren.map(child => <button key={child.id} className="wb-btn wb-primary" onClick={() => selectTask(child.id)}>{child.title} · 결과 확인</button>)}
        </> : reconcile ? <>
          <h3>외부 실행 결과를 확인하세요</h3>
          <p>실제 발송 또는 처리 여부를 확인한 뒤 결과를 기록하세요.</p>
          <label>확인한 내용<textarea value={reason} rows={2} onChange={e => setReason(e.target.value)} /></label>
          <div className="wb-actions">
            <button className="wb-btn" disabled={busy || !reason.trim()} onClick={() => act(() => onDecision(task, 'reject', reason.trim()))}>미실행 확인 · 결재함으로</button>
            <button className="wb-btn wb-primary" disabled={busy || !reason.trim()} onClick={() => act(() => onDecision(task, 'complete', reason.trim()))}>실행 확인 · 완료 처리</button>
          </div>
        </> : grantTodoRead ? <form onSubmit={e => {
          e.preventDefault()
          if (busy || !retryScope || !files) return
          void act(() => onDecision(task, 'allowTodoRead', '', boardRevision(task, files), retryScope), true)
        }}>
          <h3>담당자가 쥬리서포트 할일 조회를 요청했습니다</h3>
          <p>이번 실행에서 {workspace.startsWith('ssh://') ? 'SSH 서버의 ' : ''}담당 에이전트가 현재 계정의 미완료 할일을 읽고 원래 지시를 수행합니다. 작성한 보고서는 이 보드 폴더에 저장됩니다.</p>
          <div className="wb-recovery-action">
            <ScopeField options={scopes} value={retryScope} change={setChosenScope} />
            <button type="submit" className="wb-btn wb-primary" disabled={busy || !retryScope || !files}>조회 허용하고 다시 실행</button>
          </div>
        </form> : <form onSubmit={e => {
          e.preventDefault()
          if (busy || (retryTodo && !retryScope)) return
          void act(() => onDecision(task, retryAsReport ? 'retryReport' : 'retry', reason.trim(), retryAsReport ? boardRevision(task, files) : undefined, retryScope), true)
        }}>
          <h3>{retryTodo ? (retryScope ? '할일을 다시 조회하세요' : '조회할 할일을 선택하세요') : canSubmit ? '지금까지의 결과를 확인하세요' : '업무를 다시 실행하세요'}</h3>
          <p>{retryTodo && (toolBlocked || bashBlocked)
            ? (retryAsReport ? '이전 실행은 할일 목록 조회 단계에서 멈췄습니다.' : '할일 목록을 가져오기 전에 멈췄습니다. 다시 조회하면 이 카드에 보고서가 표시됩니다.')
            : blockReason || (task.editedNeedsRun ? '저장한 수정 내용으로 실행합니다.' :
              missingApprovalReport ? '보고서가 없어 결재를 진행할 수 없습니다.' :
              task.status === 'rejected' ? '반려 사유를 확인한 뒤 필요한 내용을 보완하세요.' :
              canSubmit ? '보고서를 읽고 결재를 요청하거나 남은 작업을 다시 실행할 수 있습니다.' : '필요한 답변이나 수정 사항을 반영해 다시 시작할 수 있습니다.')}</p>
          {retryAsReport && <p>다시 조회한 결과는 보고서함에 도착합니다. 원본 할일 상태는 그대로 유지됩니다.</p>}
          <div className="wb-recovery-action">
            {retryTodo && <ScopeField options={scopes} value={retryScope} change={setChosenScope} />}
            <button type="submit" className="wb-btn wb-primary" disabled={busy}>{retryTodo ? '할일 다시 조회' : '다시 실행'}</button>
          </div>
          {retryScope?.kind === 'all' && <small>{allTodosNotice}</small>}
          <details><summary>{retryTodo ? '메모 추가' : '추가 답변 또는 지시 입력'}</summary>
            <textarea aria-label={retryTodo ? '재조회 메모' : '추가 답변 또는 재수행 지시'} value={reason} rows={2} onChange={e => setReason(e.target.value)} />
          </details>
        </form>}
        {diagnostic && <details className="wb-recovery-diagnostic"><summary>중단 사유 자세히</summary><pre className="wb-notes">{diagnostic}</pre></details>}
        {error && <p className="wb-error" role="alert">{error}</p>}
      </section>}
      {paths.length > 0 && <DocumentList key={JSON.stringify([detailKey, paths])}
        workspace={workspace} id={task.id} paths={paths} previous={!!task.editedNeedsRun} reportOnly={resultKind === 'report'} onOpenFile={onOpenFile} />}
      {(!files || reportAvailable || !recovery) && <section className={reportIsTarget ? 'wb-report-preview wb-target-documents' : 'wb-report-preview'}
        aria-label={reportIsTarget ? '결재 대상 문서' : '업무 보고서'}>
        <h3>{reportIsTarget ? '결재 대상 문서' : task.editedNeedsRun && reportAvailable ? '수정 전 보고서' : '업무 보고서'}</h3>
        {reportIsTarget && <p className="wb-target-title">업무 보고서 · {task.title}</p>}
        {readError ? <div className="wb-error" role="alert">
          보고서와 검토 결과를 불러오지 못했습니다. {readError}
          <button type="button" className="wb-btn" onClick={() => setReadAttempt(n => n + 1)}>보고서 다시 불러오기</button>
        </div> : !files ? <p role="status">보고서를 불러오는 중…</p>
          : reportAvailable ? <ReportMarkdown text={files.report} todo={todoReview} />
          : <p className="wb-muted" role="status">{task.status === 'queued' ? '실행을 기다리는 중입니다.' :
            task.status === 'delegated' ? '부서원이 하위 업무를 수행하고 있습니다. 모두 끝나면 부서장이 보고서를 취합합니다.' :
            task.status === 'running' ? (todoReview ? '할일을 조회하고 있습니다.' : '업무를 수행하고 있습니다.') : resultKind === 'report' ? '아직 도착한 업무 보고서가 없습니다.' : '아직 결재할 업무 보고서가 없습니다.'}</p>}
        {reportAvailable && !task.editedNeedsRun && (receipt || (resultKind === 'report' && todoReview)) && <div className="wb-receipt">
          {todoReview && <p>조회 결과를 확인해도 원본 할일 상태는 그대로 유지됩니다.</p>}
          {receipt?.state === 'unread' && files && <button type="button" className="wb-btn wb-primary" disabled={busy} onClick={() => act(() => onDecision(task, 'acknowledge', '', boardRevision(task, files)), true)}>보고서 확인</button>}
          {receipt?.state === 'read' && <span role="status">보고서 확인됨</span>}
        </div>}
        {reportAvailable && !task.editedNeedsRun && <DownloadButton key={detailKey} name="보고서" report save={() => window.lt.workBoard.downloadReport(workspace, task.id)} />}
        {nearReport && followUpActions}
        {task.editedNeedsRun && <p className="wb-muted">수정된 지시의 보고서는 다시 수행한 뒤 확인할 수 있습니다.</p>}
      </section>}
      {files && (files.review || task.review_agent) && <section className="wb-review-preview">
        <h3>{task.editedNeedsRun && files.review ? '수정 전 검토 결과' : '검토 결과'}{task.review_agent && ' · ' + task.review_agent}</h3>
        <p className="wb-notes">{files.review || '검토 결과 대기 중'}</p>
      </section>}
      {referencePaths.length > 0 && <DocumentList key={JSON.stringify([detailKey, referencePaths])}
        workspace={workspace} id={task.id} paths={referencePaths} references onOpenFile={onOpenFile} />}
      {resultKind === 'action' && task.after_approval && (
        <section>
          <h3>승인 후 실행할 작업</h3>
          <p className="wb-notes">{task.after_approval}</p>
          <strong>허용 도구</strong>
          <p className="wb-notes">{task.allowed_tools?.join('\n') || '추가 허용 없음'}</p>
          {task.status === 'awaiting_approval' && <p className="wb-muted">승인하면 위 작업을 새 지시로 등록합니다. 실행 결과는 후속 지시에서 확인할 수 있습니다.</p>}
          {actionChild && <button type="button" className="wb-btn" onClick={() => selectTask(actionChild.id)}>
            후속 지시 확인 · {statusLabel[actionChild.status]}
          </button>}
        </section>
      )}
      {!readOnly && (
        <div className="wb-form">
          {isBoardDecisionPending(task) && (
            <ApprovalControls className="wb-approval-controls">
              {missingApprovalReport && <summary>반려 또는 수정 요청</summary>}
              {reportAvailable && resultKind === 'final' && <p className="wb-muted">최종안 승인 이력이 남고 이 지시가 완료됩니다.</p>}
              <label>
                반려 사유 또는 수정 요청
                <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="wb-actions">
                <button
                  className="wb-btn"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => onDecision(task, 'revise', reason.trim()))}
                >
                  수정 요청
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
                  onClick={() => act(() => onDecision(task, 'approve', '', boardRevision(task, files)), resultKind === 'action')}
                >
                  {resultKind === 'action' ? approvalLabel(task.after_approval || '') : '최종안 승인'}
                </button>}
              </div>
            </ApprovalControls>
          )}
          {nearDecision && followUpActions}
          {canSubmit && files && !pendingChildren.length && <div className="wb-actions">
            <small className="wb-muted">{resultKind === 'action' ? '부분 보고서를 결재함에 보냅니다. 후속 작업은 승인 뒤에 요청됩니다.'
              : '부분 보고서를 최종안 승인 대상으로 결재함에 보냅니다.'}</small>
            <button className="wb-btn" disabled={busy} onClick={() => act(() => onDecision(task, 'submit', '', boardRevision(task, files)))}>
              부분 보고서로 결재 요청
            </button>
          </div>}
          {reorder && (
            <div className="wb-actions">
              <button className="wb-btn" disabled={busy} onClick={() => act(reorder)}>
                대기열 맨 앞으로
              </button>
            </div>
          )}
        </div>
      )}
      {error && (!recovery || !files) && (
        <p className="wb-error" role="alert">
          {error}
        </p>
      )}
      <div className="wb-detail-history">
        <details>
          <summary>지시 본문</summary>
          <p className="wb-notes">{task.body}</p>
          <small className="wb-muted">지시 ID · {task.id}</small>
        </details>
        <details>
          <summary>진행 로그 ({task.log.length})</summary>
          <ol>{task.log.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}</li>)}</ol>
        </details>
        {permissions.length > 0 && <details>
          <summary>도구 권한 기록 ({permissions.length})</summary>
          <ol>{permissions.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}</li>)}</ol>
        </details>}
        <details>
          <summary>결재 이력 ({history.length})</summary>
          {history.length ? <ol>{history.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}</li>)}</ol>
          : <p className="wb-muted">결재 이력이 없습니다.</p>}
        </details>
      </div>
      {readOnly ? !recovery && <div className="wb-management">
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
      {followUp && <Dialog title="추가 업무 지시" close={() => { if (!busy) setFollowUp(null) }}>
        <p className="wb-followup-source">원 지시 · {followUp.title}</p>
        <p className="wb-muted">원 지시의 자료를 참고하고 결과는 새 지시에 저장합니다.</p>
        {files && followUp.revision !== sourceRevision && <details className="wb-followup-review">
          <summary>작성 중 변경된 원 지시 확인</summary>
          <strong>{task.title}</strong><p className="wb-notes">{task.body}</p>
          {files.report && <><strong>현재 보고서</strong><p className="wb-notes">{files.report}</p></>}
          {files.review && <><strong>현재 검토 결과</strong><p className="wb-notes">{files.review}</p></>}
          <button type="button" className="wb-btn" onClick={beginFollowUp}>이 내용을 참고해 계속 작성</button>
        </details>}
        <InstructionForm agents={agents} teams={teams} followUp scopeOptions={scopeOptions}
          issue={sourceRevision && followUp.revision !== sourceRevision ? '변경된 원 지시를 확인한 뒤 등록하세요.' : undefined}
          submit={async ([draft], requestId) => {
            setBusy(true)
            try {
              const childId = await window.lt.workBoard.addFollowUp(workspace, task.id, draft, requestId, followUp.revision)
              setFollowUp(null)
              setNewFollowUpId(childId)
              await refresh()
            } catch (err) {
              setReadAttempt(n => n + 1)
              await refresh()
              throw err
            } finally { setBusy(false) }
          }} />
      </Dialog>}
      {mutation?.kind === 'update' && <Dialog title="지시 수정" close={() => { if (!busy) setMutation(null) }}>
        <InstructionForm agents={agents} teams={teams} existing={mutation.task} scopeOptions={scopeOptions} issue={changeIssue}
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
  const [editingTeams, setEditingTeams] = useState(false)
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
  const teamOf = (t: BoardTask): BoardTeam | undefined => {
    const teams = data?.teams ?? []
    const head = t.delegatedBy ? ordered.find((item) => item.id === t.delegatedBy) : undefined
    const name = t.team || head?.team
    return name ? teams.find((team) => team.name === name) : teams.find((team) => team.agents.includes(agentName(t)))
  }
  const progressOf = (t: BoardTask) => {
    const delegates = isBoardDepartmentTask(t) ? boardDelegates(t, ordered) : []
    return delegates.length ? `하위 업무 ${delegates.filter((child) => child.status === 'done').length}/${delegates.length}` : undefined
  }
  const card = (t: BoardTask) => (
    <TaskCard
      key={t.id}
      task={t}
      team={teamOf(t)}
      progress={progressOf(t)}
      open={() => setSelected(t.id)}
      dragging={drag}
      move={
        t.status === 'queued' && !data?.readOnly
          ? (id) => void reorder(id, t.id).catch((e) => setError(errMsg(e)))
          : undefined
      }
    />
  )
  const approvals = ordered.filter(isBoardDecisionPending)
  const approvalCount = approvals.length
  const reports = ordered.filter(isBoardReport).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
  const unreadCount = reports.filter(t => t.reportReceipt?.state === 'unread').length
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
                  ['reports', '보고서함'],
                  ['approvals', '결재함'],
                  ['daily', '일일 보고']
                ] as const
              ).map(([key, label]) => (
                <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => navigate(key)}>
                  {label}{' '}
                  {key === 'reports' && unreadCount > 0 && <span className="wb-count">{unreadCount}</span>}
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
                      (t) => {
                        const status = t.status === 'approved' && boardResultKind(t) === 'action' ? 'running' : t.status
                        return lane.statuses.includes(status) && (filter === null || stats[filter].matches(t))
                      }
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
              <Organization data={data} edit={data.readOnly ? undefined : () => setEditingTeams(true)} />
            </div>
          )}
          {tab === 'reports' && <main className="wb-page" aria-label="보고서함">
            <div className="wb-page-head"><h2>보고서함 · {reports.length}건</h2>{unreadCount > 0 && <span className="wb-report-unread">미확인 {unreadCount}건</span>}</div>
            {reports.map(card)}
            {!reports.length && <p className="wb-muted">아직 도착한 보고서가 없습니다.</p>}
          </main>}
          {tab === 'approvals' && (
            <main className="wb-page">
              <div className="wb-page-head">
                <h2>결재함 · {approvalCount}건</h2>
              </div>
              {approvals.map(card)}
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
                teams={data.teams}
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
          {editingTeams && (
            <TeamEditor
              data={data}
              close={() => setEditingTeams(false)}
              save={async (teams) => {
                await api.saveTeams(workspace, teams)
                await refresh()
              }}
            />
          )}
          {task && (
            <Details
              key={task.id}
              task={task}
              scopeOptions={scopeOptions}
              workspace={data.workspace || workspace}
              folder={data.folder}
              readOnly={!!data.readOnly}
              tasks={data.tasks}
              selectTask={setSelected}
              agents={data.agents}
              teams={data.teams}
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
