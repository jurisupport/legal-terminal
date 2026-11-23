import { boardRevision } from '../../../shared/workBoard'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  BoardAgent,
  BoardDecision,
  BoardDraft,
  BoardSettings,
  BoardSnapshot,
  BoardStatus,
  BoardTask,
  BoardTeam
} from '../../../shared/workBoard'
import { isBoardDueSoon, isBoardRunning } from '../../../shared/workBoardSummary'
import './WorkBoard.css'

export type WorkBoardView = 'board' | 'approvals' | 'daily' | 'bulk'
interface Props {
  workspace: string
  view: WorkBoardView
  onView?: (view: WorkBoardView) => void
  onOpenFile: (path: string) => void
  bulkSeed?: string
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

function BulkForm({
  agents,
  seed,
  submit
}: {
  agents: BoardAgent[]
  seed?: string
  submit: (drafts: BoardDraft[], batchId: string) => Promise<void>
}) {
  const [batchId] = useState(() => crypto.randomUUID())
  const [raw, setRaw] = useState(seed || '')
  const [blocks, setBlocks] = useState(false)
  const [drafts, setDrafts] = useState<BoardDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const update = (index: number, patch: Partial<BoardDraft>) =>
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
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
        if (busy) return
        setBusy(true)
        setError('')
        try {
          await submit(drafts, batchId)
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
              {i + 1}. {d.title}
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
              <label>
                담당 에이전트
                <select value={d.agent || ''} onChange={(e) => update(i, { agent: e.target.value })}>
                  <option value="">기본 세션</option>
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
      <div className="wb-actions">
        <button disabled={busy || !raw.trim()} className="wb-btn wb-primary">
          {drafts.length ? drafts.length + '건 등록' : '지시별 담당 지정'}
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

function reportPaths(report: string, cwd: string): string[] {
  const paths = new Set<string>()
  const section = report.match(/(?:^|\n)#{1,6}\s+산출물(?:\s*경로)?[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/)
  const recorded = [...report.matchAll(/^산출물 · (.+)$/gm)].map((match) => match[1])
  for (const line of [...(section?.[1] || '').split('\n'), ...recorded]) {
    const path = (
      line.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1] ||
      line.match(/`([^`]+)`/)?.[1] ||
      line.replace(/^\s*[-*]\s+/, '')
    ).trim()
    if (!/\.(?:pdf|md|txt|hwp|hwpx|json|csv|png|jpe?g|webp)$/i.test(path) || /[\x00-\x1f]/.test(path)) continue
    const base = cwd.replace(/\\/g, '/').replace(/\/$/, '')
    let normalized = path.replace(/\\/g, '/')
    if (normalized.startsWith(base + '/')) normalized = normalized.slice(base.length + 1)
    if (/^(?:[a-zA-Z][\w+.-]*:|\/)/.test(normalized) || normalized.split('/').includes('..')) continue
    paths.add(base + '/' + normalized.replace(/^\.\//, ''))
  }
  return [...paths]
}

function Details({
  task,
  workspace,
  readOnly,
  onOpenFile,
  onDecision,
  close,
  reorder
}: {
  task: BoardTask
  workspace: string
  readOnly: boolean
  onOpenFile: Props['onOpenFile']
  close: () => void
  onDecision: (task: BoardTask, action: BoardDecision, reason: string, revision?: string) => Promise<void>
  reorder?: () => Promise<void>
}) {
  const [files, setFiles] = useState<{ report: string; review: string } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setFiles(null)
    setError('')
    window.lt.workBoard.detail(workspace, task.id).then(
      (f) => {
        if (current) setFiles(f)
      },
      (err) => {
        if (current) setError(errMsg(err))
      }
    )
    return () => {
      current = false
    }
  }, [workspace, task.id, task.updatedAt])
  const act = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      close()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const history = task.log.filter((l) => /결재|승인|반려|수정 지시/.test(l.text))
  const paths = reportPaths(files?.report || '', workspace)
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null)
  const previewVersion = useRef(0)
  async function openArtifact(path: string) {
    if (!/\.(md|txt|csv|json)$/i.test(path)) {
      onOpenFile(path)
      return
    }
    const n = ++previewVersion.current
    setPreview({ path, text: '불러오는 중…' })
    try {
      const file = await window.lt.fs.readText(path)
      if (previewVersion.current === n)
        setPreview({ path, text: file.text + (file.truncated ? '\n[일부 생략]' : '') })
    } catch (err) {
      if (previewVersion.current === n) setPreview({ path, text: errMsg(err) })
    }
  }
  return (
    <Dialog title={task.title} close={close}>
      <div className="wb-muted">
        {task.id} · {statusLabel[task.status]} · {agentName(task)}
        {task.due && ' · 기한 ' + task.due}
      </div>
      <div className="wb-timeline">
        <section>
          <h3>지시 본문</h3>
          <p className="wb-notes">{task.body}</p>
        </section>
        <section>
          <h3>진행 로그</h3>
          <ol>
            {task.log.map((l, i) => (
              <li key={i}>
                <time>{new Date(l.at).toLocaleString('ko-KR')}</time> · {l.text}
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h3>보고서</h3>
          <p className="wb-notes">{files ? files.report || '아직 보고서가 없습니다.' : '불러오는 중…'}</p>
          {paths.map((path) => (
            <button className="wb-btn" key={path} onClick={() => void openArtifact(path)}>
              {path.split('/').pop()} 열기
            </button>
          ))}
          {preview && (
            <div className="wb-artifact">
              <div className="wb-split-label">
                <strong>{preview.path.split('/').pop()}</strong>
                <button className="wb-btn" onClick={() => onOpenFile(preview.path)}>
                  문서 창에서 열기
                </button>
              </div>
              <pre className="wb-notes">{preview.text}</pre>
            </div>
          )}
        </section>
        <section>
          <h3>검토 결과{task.review_agent && ' · ' + task.review_agent}</h3>
          <p className="wb-notes">{files?.review || (task.review_agent ? '검토 결과 대기 중' : '검토 생략')}</p>
        </section>
        <section>
          <h3>결재 이력</h3>
          {history.length ? (
            <ol>
              {history.map((l, i) => (
                <li key={i}>
                  {new Date(l.at).toLocaleString('ko-KR')} · {l.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="wb-muted">결재 이력이 없습니다.</p>
          )}
        </section>
      </div>
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
                반려 사유 또는 수정 지시
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
                <button
                  className="wb-btn wb-primary"
                  disabled={busy || !files}
                  onClick={() => act(() => onDecision(task, 'approve', '', boardRevision(task, files!)))}
                >
                  승인
                </button>
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
          {!task.parentId && ['failed', 'blocked', 'rejected'].includes(task.status) && (
            <>
              <label>
                추가 답변 또는 재수행 지시
                <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="wb-actions">
                <button
                  className="wb-btn"
                  disabled={busy}
                  onClick={() => act(() => onDecision(task, 'retry', reason.trim()))}
                >
                  다시 대기열에 넣기
                </button>
                {task.status === 'blocked' && files?.report && (
                  <button className="wb-btn" disabled={busy} onClick={() => act(() => onDecision(task, 'submit', ''))}>
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
    </Dialog>
  )
}

export function WorkBoard(props: Props) {
  return <BoardWorkspace key={props.workspace} {...props} />
}
function BoardWorkspace({ workspace, view, onView, bulkSeed, onOpenFile }: Props) {
  const api = window.lt.workBoard
  const [data, setData] = useState<BoardSnapshot | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState(view)
  const [settings, setSettings] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<number | null>(null)
  const [report, setReport] = useState('')
  const [exporting, setExporting] = useState(false)
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
        <div className="wb-status">
          다른 기기에서 수행 중인 보드입니다. 결재와 설정 변경은 해당 기기에서 할 수 있습니다.
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
              <BulkForm
                agents={data.agents}
                seed={bulkSeed}
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
              task={task}
              workspace={data.workspace || workspace}
              readOnly={!!data.readOnly}
              close={() => setSelected(null)}
              onOpenFile={onOpenFile}
              onDecision={async (t, action, reason, revision) => {
                await api.decide(workspace, t.id, action, reason, revision)
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
    </section>
  )
}
