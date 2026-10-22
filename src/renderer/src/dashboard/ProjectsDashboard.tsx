import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Project, ProjectCaseLink, ProjectFolderLink, ProjectInput } from '../../../shared/project'
import type { SshProfile } from '../env'
import { listCasesCached } from './caseListCache'
import './ProjectsDashboard.css'

interface ProjectsDashboardProps {
  cases: ProjectCaseLink[]
  sshProfiles: SshProfile[]
  defaultExecutionProfileId?: string
  onOpenCase: (item: ProjectCaseLink) => Promise<void>
  onAddCase: () => void
  onPickFolder: () => Promise<ProjectFolderLink | null>
  onOpenFolder: (folder: ProjectFolderLink) => Promise<void>
  onOpenWork: (project: Project, newConversation?: boolean) => Promise<void>
  workOpen?: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
}

type ProjectTextField = 'goal' | 'nextAction' | 'notes'
type EditorTarget = ProjectTextField | 'cases' | 'folders' | 'workspace'

// Keep an unfinished form when the user temporarily opens an individual case.
let sessionDraft: { project: Project | null; input: ProjectInput; target?: EditorTarget } | null = null

const sameCase = (a: ProjectCaseLink, b: ProjectCaseLink): boolean =>
  a.key === b.key || Boolean(a.jsId && a.jsId === b.jsId)
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '작업을 완료하지 못했습니다. 다시 시도해 주세요.'
const caseSource = (item: ProjectCaseLink): string =>
  item.profileId || item.remotePath || item.drafts?.startsWith('ssh://')
    ? '원격' : item.jsId ? 'JuriSupport' : '로컬'
const caseSubtitle = (item: ProjectCaseLink): string =>
  [item.court, item.caseNumber].filter(Boolean).join(' · ') || `${caseSource(item)} 사건`
const folderKey = (path: string): string => {
  const normalized = path.normalize('NFC')
  const windows = /^[a-z]:[\\/]/i.test(normalized) || normalized.startsWith('\\\\')
  return (windows ? normalized.replace(/\\/g, '/').toLowerCase() : normalized).replace(/\/+$/, '') || '/'
}

function uniqueCases(items: ProjectCaseLink[]): ProjectCaseLink[] {
  const keys = new Set<string>()
  const ids = new Set<string>()
  return items.filter((item) => {
    if (keys.has(item.key) || (item.jsId && ids.has(item.jsId))) return false
    keys.add(item.key)
    if (item.jsId) ids.add(item.jsId)
    return true
  })
}

function ProjectWorkspaceSection({ project, disabled, opening, onEdit, onOpen }: {
  project: Project
  disabled: boolean
  opening: boolean
  onEdit: () => void
  onOpen: () => void
}): JSX.Element {
  const [path, setPath] = useState(project.workingFolder?.path ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const showLocation = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const workspace = await window.lt.projects.workspace(project.id)
      setPath(workspace.cwd)
    } catch (err) { setError(errorMessage(err)) }
    finally { setLoading(false) }
  }

  return <section className="project-workspace-section" aria-label="프로젝트 작업 폴더">
    <div className="project-section-heading"><h3>프로젝트 작업 폴더</h3><span className="project-count">{project.workingFolder?.path?.startsWith('ssh://') ? '직접 지정 · 원격 서버' : project.workingFolder?.path ? '직접 지정 · 이 컴퓨터' : project.executionProfileId ? '기본 위치 · 원격 서버' : '기본 위치 · 이 컴퓨터'}</span></div>
    <p className="project-muted">이 폴더를 기준으로 AI와 작업하고 새 문서와 결과물을 저장합니다.</p>
    {path && <p className="project-folder-path">{path}</p>}
    <div className="project-workspace-actions">
      {!path && <button className="dash-btn" type="button" disabled={disabled || loading} onClick={() => void showLocation()}>{loading ? '확인 중…' : '저장 위치 확인'}</button>}
      <button className="dash-btn" type="button" disabled={disabled} onClick={onOpen}>{opening ? '여는 중…' : '작업 폴더 열기'}</button>
      <button className="dash-btn" type="button" disabled={disabled} onClick={onEdit}>작업 폴더 변경</button>
    </div>
    {error && <p className="project-inline-error" role="alert">{error}</p>}
  </section>
}

function ProjectTextEditor({ project, field, label, saving, error, onSave, onCancel }: {
  project: Project
  field: ProjectTextField
  label: string
  saving: boolean
  error: string
  onSave: (input: ProjectInput) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(() => sessionDraft?.project?.id === project.id && sessionDraft.target === field
    ? sessionDraft.input[field] : project[field])
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest' }) }, [])
  useEffect(() => {
    sessionDraft = { project, input: { ...project, [field]: value }, target: field }
  }, [project, field, value])

  return <form ref={formRef} className="project-inline-editor" aria-label={`${label} 수정`} onSubmit={(event) => {
    event.preventDefault()
    if (!saving) void onSave({ ...project, [field]: value.trim(), expectedUpdatedAt: project.updatedAt })
  }}>
    <label className="project-field"><span className="sr-only">{label}</span>
      <textarea autoFocus name={field} aria-label={label} rows={field === 'notes' ? 6 : 3} maxLength={field === 'notes' ? 50000 : 4000} disabled={saving} value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
    {error && <p className="project-inline-error" role="alert">{error}</p>}
    <div className="project-actions"><button className="dash-btn" type="button" disabled={saving} onClick={onCancel}>취소</button><button className="dash-btn project-primary" type="submit" disabled={saving}>{saving ? '저장 중…' : '저장'}</button></div>
  </form>
}

function ProjectEditor({ project, target, cases, sshProfiles, defaultExecutionProfileId, saving, error, onPickFolder, onSave, onCancel }: {
  project: Project | null
  target?: EditorTarget
  cases: ProjectCaseLink[]
  sshProfiles: SshProfile[]
  defaultExecutionProfileId?: string
  saving: boolean
  error: string
  onPickFolder: () => Promise<ProjectFolderLink | null>
  onSave: (input: ProjectInput) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const initial = sessionDraft?.project?.id === project?.id ? sessionDraft?.input : project
  const [name, setName] = useState(initial?.name ?? '')
  const [goal, setGoal] = useState(initial?.goal ?? '')
  const [nextAction, setNextAction] = useState(initial?.nextAction ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [status, setStatus] = useState<Project['status']>(initial?.status ?? 'active')
  const [members, setMembers] = useState<ProjectCaseLink[]>(initial?.cases ?? [])
  const [folders, setFolders] = useState<ProjectFolderLink[]>(initial?.folders ?? [])
  const [workingFolder, setWorkingFolder] = useState(initial?.workingFolder)
  const [executionProfileId, setExecutionProfileId] = useState(initial ? initial.executionProfileId ?? '' : defaultExecutionProfileId ?? '')
  const workspacePath = workingFolder?.path
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [pickingFolder, setPickingFolder] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [folderNotice, setFolderNotice] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [remoteCases, setRemoteCases] = useState<ProjectCaseLink[]>([])
  const [tokenStatus, setTokenStatus] = useState<'ok' | 'missing' | 'locked' | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [retry, setRetry] = useState(0)
  const caseSearchRef = useRef<HTMLInputElement>(null)
  const folderButtonRef = useRef<HTMLButtonElement>(null)
  const workspaceButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const control = target === 'cases' ? caseSearchRef.current : target === 'folders' ? folderButtonRef.current : target === 'workspace' ? workspaceButtonRef.current : null
    if (!control) return
    control.focus({ preventScroll: true })
    control.closest('section')?.scrollIntoView({ block: 'start' })
  }, [target])

  useEffect(() => {
    sessionDraft = { project, input: { name, goal, nextAction, notes, status, cases: members, folders, workingFolder, ...(executionProfileId ? { executionProfileId } : {}) }, target }
  }, [project, name, goal, nextAction, notes, status, members, folders, workingFolder, executionProfileId, target])

  useEffect(() => {
    let active = true
    const check = (): void => {
      Promise.resolve(window.lt.js?.tokenStatus?.() ?? 'missing')
        .then((value) => { if (active) setTokenStatus(value) })
        .catch(() => { if (active) setTokenStatus('missing') })
    }
    check()
    window.addEventListener('lt-js-token-updated', check)
    return () => {
      active = false
      window.removeEventListener('lt-js-token-updated', check)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (tokenStatus !== 'ok') {
      setRemoteCases([])
      setHasMore(false)
      setRemoteLoading(false)
      setRemoteError('')
      return
    }
    let active = true
    setRemoteLoading(true)
    setRemoteError('')
    if (page === 1) setRemoteCases([])
    listCasesCached({ search: query, page, limit: 30, ...(retry ? { refresh: true } : {}) })
      .then((result) => {
        if (!active) return
        if (!result.ok) throw new Error(result.error || 'JuriSupport 사건을 불러오지 못했습니다.')
        const found = (result.cases ?? []).map((item): ProjectCaseLink => ({
          key: `js:${item.id}`,
          jsId: item.id,
          name: item.caseName || item.caseNumber || '이름 없는 사건',
          ...(item.caseNumber ? { caseNumber: item.caseNumber } : {}),
          ...(item.court ? { court: item.court } : {})
        }))
        setRemoteCases((previous) => uniqueCases(page === 1 ? found : [...previous, ...found]))
        setHasMore(found.length === 30)
      })
      .catch((err) => { if (active) setRemoteError(errorMessage(err)) })
      .finally(() => { if (active) setRemoteLoading(false) })
    return () => { active = false }
  }, [tokenStatus, query, page, retry])

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const options = uniqueCases([...cases, ...members, ...remoteCases]).filter((item) =>
    [item.name, item.caseNumber, item.court].join(' ').toLocaleLowerCase().includes(normalizedSearch)
  )
  const toggleMember = (item: ProjectCaseLink): void => {
    setMembers((current) => current.some((member) => sameCase(member, item))
      ? current.filter((member) => !sameCase(member, item))
      : [...current, item])
  }
  const addFolder = async (): Promise<void> => {
    setPickingFolder(true)
    setFolderError('')
    setFolderNotice('')
    try {
      const folder = await onPickFolder()
      if (!folder) return
      if (folders.some((item) => folderKey(item.path) === folderKey(folder.path))) {
        setFolderNotice('이미 연결된 폴더입니다.')
      } else setFolders((current) => [...current, folder])
    } catch (err) { setFolderError(errorMessage(err)) }
    finally { setPickingFolder(false) }
  }
  const pickWorkspace = async (): Promise<void> => {
    setPickingWorkspace(true)
    setWorkspaceError('')
    try {
      const folder = await onPickFolder()
      if (folder) {
        setWorkingFolder(folder)
        setExecutionProfileId(/^ssh:\/\/([^/]+)\//.exec(folder.path)?.[1] ?? '')
      }
    } catch (err) { setWorkspaceError(errorMessage(err)) }
    finally { setPickingWorkspace(false) }
  }
  const picking = pickingFolder || pickingWorkspace
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim() || saving || picking) return
    void onSave({
      ...(project ? { id: project.id, expectedUpdatedAt: project.updatedAt } : {}),
      name: name.trim(), goal: goal.trim(), nextAction: nextAction.trim(), notes: notes.trim(),
      status, cases: members, folders, workingFolder, ...(executionProfileId ? { executionProfileId } : {})
    })
  }

  return (
    <form className="project-editor" onSubmit={submit}>
      <div className="project-section-heading">
        <div><span className="project-eyebrow">프로젝트 설정</span><h2>{project ? '프로젝트 수정' : '새 프로젝트'}</h2></div>
      </div>
      <p className="project-muted">프로젝트를 진행할 작업 폴더를 정하고, 목표와 함께 참고할 사건·자료를 연결하세요.</p>
      <fieldset disabled={saving}>
        <div className="project-form-row">
          <label className="project-field project-name-field">프로젝트 이름 <span className="project-required">필수</span>
            <input name="name" autoFocus={!target} required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="예: A사 거래대금 회수" />
          </label>
          <label className="project-field">상태
            <select name="status" value={status} onChange={(event) => setStatus(event.target.value as Project['status'])}>
              <option value="active">진행 중</option><option value="completed">완료</option>
            </select>
          </label>
        </div>
        <label className="project-field">AI 실행 위치
          <select name="executionProfileId" value={executionProfileId} onChange={(event) => { setExecutionProfileId(event.target.value); if (!project) setWorkingFolder(undefined) }}>
            <option value="">이 PC (로컬)</option>
            {sshProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} (원격)</option>)}
            {executionProfileId && !sshProfiles.some((profile) => profile.id === executionProfileId) && <option value={executionProfileId}>연결 설정 없음 · {executionProfileId}</option>}
          </select>
          <span className="project-muted">{executionProfileId ? '선택한 원격 컴퓨터에서 AI를 실행합니다. 프로젝트 도구를 사용하려면 이 앱을 열어 두세요. 앱을 닫으면 실행 중인 요청은 종료되며, 저장된 대화는 다시 이어갈 수 있습니다.' : '이 PC에서 AI를 실행합니다. 설정에 저장한 원격 연결도 선택할 수 있습니다.'}</span>
        </label>
        <section className="project-workspace-picker" aria-labelledby="project-workspace-heading">
          <div className="project-section-heading"><h3 id="project-workspace-heading">프로젝트 작업 폴더</h3><span className="project-count">{executionProfileId ? '원격 서버' : '이 컴퓨터'}</span></div>
          <p className="project-muted">AI가 작업하고 문서·결과물을 저장할 기본 폴더입니다. 이 폴더의 기존 파일도 작업에 사용할 수 있습니다.</p>
          <p className="project-muted">원격 폴더는 설정에 등록한 SSH 서버에서 선택할 수 있습니다.</p>
          {workspacePath?.startsWith('ssh://') && <p className="project-muted">선택한 SSH 서버에서 AI를 실행하고 파일을 저장합니다. 서버에 사용할 Claude 또는 Codex의 설치·로그인이 필요합니다.</p>}
          {workspacePath ? <p className="project-folder-path">{workspacePath}</p> : <p className="project-muted">기본 위치 사용 · 앱이 프로젝트 전용 폴더를 자동으로 만듭니다.</p>}
          {!project && <div className="project-workspace-actions">
            <button ref={workspaceButtonRef} className="dash-btn" type="button" disabled={picking} onClick={() => void pickWorkspace()}>{pickingWorkspace ? '선택 중…' : workspacePath ? '폴더 변경' : '작업 폴더 선택'}</button>
            {workspacePath && <button className="project-text-button" type="button" disabled={picking} onClick={() => { setWorkingFolder(undefined); setWorkspaceError('') }}>기본 위치 사용</button>}
          </div>}
          {project && <p className="project-workspace-notice">작업 폴더는 프로젝트 상세 화면의 ‘작업 폴더 변경’에서 바꿀 수 있습니다. 기존 파일은 이동하지 않습니다.</p>}
          {workspaceError && <p className="project-inline-error" role="alert">{workspaceError}</p>}
        </section>
        <label className="project-field">공통 목표
          <textarea name="goal" rows={3} maxLength={4000} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="이 프로젝트를 통해 무엇을 달성하려고 하나요?" />
        </label>
        <label className="project-field">다음 행동
          <textarea name="nextAction" rows={2} maxLength={4000} value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="지금 가장 먼저 진행할 일과 사건 사이의 순서를 적어 주세요." />
        </label>
        <section className="project-case-picker" aria-labelledby="project-cases-heading">
          <div className="project-section-heading"><h3 id="project-cases-heading">연결할 사건</h3><span className="project-count">{members.length}개 선택</span></div>
          <p className="project-muted">사건에 등록된 작성서류·소송기록 폴더도 함께 참고합니다. 같은 폴더를 아래에 다시 연결할 필요는 없습니다.</p>
          <input ref={caseSearchRef} type="search" className="dash-search" aria-label="연결할 사건 검색" placeholder="사건명, 사건번호, 법원으로 검색" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="project-case-options">
            {options.map((item) => <label className="project-case-option" key={item.key}>
              <input type="checkbox" value={item.key} checked={members.some((member) => sameCase(member, item))} onChange={() => toggleMember(item)} />
              <span><strong>{item.name}</strong><small>{caseSubtitle(item)}</small></span>
              <span className="project-source">{caseSource(item)}</span>
            </label>)}
            {!options.length && !remoteLoading && <p className="project-picker-empty">{search ? '검색에 맞는 사건이 없습니다.' : '연결할 사건이 없습니다. 사건 없이 프로젝트를 먼저 만들 수 있습니다.'}</p>}
            {remoteLoading && <p className="project-muted" role="status">JuriSupport 사건을 불러오는 중…</p>}
          </div>
          {remoteError && <div className="project-inline-error" role="alert"><span>{remoteError}</span><button type="button" className="dash-btn" onClick={() => setRetry((value) => value + 1)}>다시 시도</button></div>}
          {hasMore && <button className="dash-btn project-load-more" type="button" disabled={remoteLoading || Boolean(remoteError)} onClick={() => setPage((value) => value + 1)}>사건 더 보기</button>}
          {tokenStatus === 'missing' && <p className="project-muted project-connection-note">설정에서 JuriSupport를 연결하면 해당 사건도 선택할 수 있습니다.</p>}
          {tokenStatus === 'locked' && <p className="project-muted project-connection-note">JuriSupport 연결을 확인할 수 없습니다. 설정에서 토큰을 다시 입력하면 해당 사건도 선택할 수 있습니다.</p>}
        </section>
        <section className="project-folder-picker" aria-labelledby="project-folders-heading">
          <div className="project-section-heading"><div className="project-heading-with-count"><h3 id="project-folders-heading">참고 자료 폴더</h3><span className="project-count">{folders.length}개</span></div><button ref={folderButtonRef} className="dash-btn" type="button" disabled={picking} onClick={() => void addFolder()}>{pickingFolder ? '선택 중…' : '자료 폴더 연결'}</button></div>
          <p className="project-muted">AI가 읽고 비교할 기존 자료가 있는 폴더를 연결하세요. 연결은 저장 위치를 바꾸거나 파일을 복사하지 않습니다. 연결 해제해도 원본은 그대로 남습니다.</p>
          {folders.length ? <div className="project-members">{folders.map((folder) => <div className="project-folder-option" key={folder.path}>
            <div className="project-member-info"><strong>{folder.name} <small className="project-source">{folder.path.startsWith('ssh://') ? '원격' : '로컬'}</small></strong><span className="project-folder-path">{folder.path}</span></div>
            <button className="dash-btn" type="button" aria-label={`${folder.name} 폴더 연결 해제`} onClick={() => { setFolders((current) => current.filter((item) => item.path !== folder.path)); setFolderNotice('') }}>연결 해제</button>
          </div>)}</div> : <p className="project-folder-empty">계약서·증거·리서치 자료가 있는 폴더를 연결할 수 있습니다. 추가 자료가 없으면 비워 두어도 됩니다.</p>}
          {folderError && <p className="project-inline-error" role="alert">{folderError}</p>}
          {folderNotice && <p className="project-muted" role="status">{folderNotice}</p>}
        </section>
        <label className="project-field">공통 메모
          <textarea name="notes" rows={5} maxLength={50000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="공통 사실관계, 전략, 사건 간 관계와 결정 사항을 정리하세요." />
        </label>
      </fieldset>
      <div className="project-form-footer">
        {error && <p className="project-inline-error" role="alert">{error}</p>}
        <div className="project-form-actions"><span className="project-muted">이 기기에 저장</span><div className="project-actions"><button className="dash-btn" type="button" onClick={onCancel} disabled={saving || picking}>취소</button><button className="dash-btn project-primary" type="submit" disabled={saving || picking || !name.trim()}>{saving ? '저장 중…' : project ? '변경사항 저장' : '프로젝트 만들기'}</button></div></div>
      </div>
    </form>
  )
}

export default function ProjectsDashboard({ cases, sshProfiles, defaultExecutionProfileId, onOpenCase, onAddCase, onPickFolder, onOpenFolder, onOpenWork, workOpen = false, selectedId, onSelect }: ProjectsDashboardProps): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [filter, setFilter] = useState<'active' | 'completed' | 'all'>('active')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<{ project: Project | null; target?: EditorTarget } | null>(() => sessionDraft ? { project: sessionDraft.project, target: sessionDraft.target } : null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [openingCase, setOpeningCase] = useState<string | null>(null)
  const [openingFolder, setOpeningFolder] = useState<string | null>(null)
  const [openingWork, setOpeningWork] = useState<'continue' | 'new' | null>(null)
  const [openingWorkspace, setOpeningWorkspace] = useState(false)
  const loadSequence = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    const api = window.lt.projects
    if (!api) { setLoading(false); return }
    setLoading(true)
    try {
      const result = await api.list()
      if (sequence !== loadSequence.current) return
      setProjects(result)
      setLoadError('')
    } catch (err) {
      if (sequence === loadSequence.current) setLoadError(errorMessage(err))
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const unsubscribe = window.lt.projects?.onChanged?.(() => { void load() })
    return () => { ++loadSequence.current; unsubscribe?.() }
  }, [load])

  useEffect(() => { setConfirmDelete(false); setActionError('') }, [selectedId])

  const startEditor = (project: Project | null, target?: EditorTarget): void => {
    sessionDraft = null
    setActionError('')
    setConfirmDelete(false)
    setEditor({ project, target })
  }
  const cancelEditor = (): void => { sessionDraft = null; setEditor(null); setActionError('') }
  const save = async (input: ProjectInput): Promise<void> => {
    setSaving(true)
    setActionError('')
    try {
      if (!window.lt.projects) throw new Error('프로젝트 저장 기능을 사용할 수 없습니다. 앱을 다시 실행해 주세요.')
      const result = await window.lt.projects.save(input)
      ++loadSequence.current
      setLoading(false)
      setProjects((current) => [result, ...current.filter((item) => item.id !== result.id)])
      sessionDraft = null
      setEditor(null)
      onSelect(result.id)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally { setSaving(false) }
  }
  const inlineField = editor?.target === 'goal' || editor?.target === 'nextAction' || editor?.target === 'notes' ? editor.target : null
  const selected = projects.find((project) => project.id === (editor?.project?.id ?? selectedId))
    ?? (inlineField ? editor?.project : undefined)
  const detailBusy = Boolean(editor || saving || deleting || openingWork || openingCase || openingFolder || openingWorkspace)
  const projectText = (project: Project, field: ProjectTextField, label: string, empty: string): JSX.Element => <>
    <div className="project-section-heading"><h3>{label}</h3>{inlineField !== field && <button className="project-text-button" disabled={detailBusy} aria-label={`${label} 수정`} onClick={() => startEditor(project, field)}>수정</button>}</div>
    {inlineField === field && editor?.project ? <ProjectTextEditor key={`${project.id}:${field}`} project={editor.project} field={field} label={label} saving={saving} error={actionError} onSave={save} onCancel={cancelEditor} />
      : <p className={project[field] ? '' : 'project-muted'}>{project[field] || empty}</p>}
  </>
  const remove = async (): Promise<void> => {
    if (!selected || deleting) return
    setDeleting(true)
    setActionError('')
    try {
      await window.lt.projects.remove(selected.id, selected.updatedAt)
      ++loadSequence.current
      setLoading(false)
      setProjects((current) => current.filter((item) => item.id !== selected.id))
      setConfirmDelete(false)
      onSelect(null)
    } catch (err) { setActionError(errorMessage(err)) }
    finally { setDeleting(false) }
  }
  const openCase = async (item: ProjectCaseLink): Promise<void> => {
    setOpeningCase(item.key)
    setActionError('')
    try { await onOpenCase(item) }
    catch (err) { setActionError(errorMessage(err)) }
    finally { setOpeningCase(null) }
  }
  const openFolder = async (folder: ProjectFolderLink): Promise<void> => {
    setOpeningFolder(folder.path)
    setActionError('')
    try { await onOpenFolder(folder) }
    catch (err) { setActionError(errorMessage(err)) }
    finally { setOpeningFolder(null) }
  }
  const changeWorkspace = async (): Promise<void> => {
    if (!selected || detailBusy) return
    setOpeningWorkspace(true)
    setActionError('')
    try {
      const folder = await onPickFolder()
      if (!folder) return
      const workspace = await window.lt.projects.setWorkingFolder(selected.id, folder, selected.updatedAt)
      ++loadSequence.current
      setLoading(false)
      setProjects((current) => [workspace.project, ...current.filter((item) => item.id !== workspace.project.id)])
    } catch (err) { setActionError(errorMessage(err)) }
    finally { setOpeningWorkspace(false) }
  }
  const openWorkspace = async (): Promise<void> => {
    if (!selected || openingWorkspace) return
    setOpeningWorkspace(true)
    setActionError('')
    try { await onOpenWork(selected) }
    catch (err) { setActionError(errorMessage(err)) }
    finally { setOpeningWorkspace(false) }
  }
  const openWork = async (newConversation = false): Promise<void> => {
    if (!selected || openingWork) return
    setOpeningWork(newConversation ? 'new' : 'continue')
    setActionError('')
    try { await onOpenWork(selected, newConversation) }
    catch (err) { setActionError(errorMessage(err)) }
    finally { setOpeningWork(null) }
  }
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filtered = projects.filter((project) =>
    (filter === 'all' || project.status === filter) &&
    [project.name, project.goal, ...project.cases.flatMap((item) => [item.name, item.caseNumber]), ...(project.folders ?? []).flatMap((folder) => [folder.name, folder.path])]
      .join(' ').toLocaleLowerCase().includes(normalizedSearch)
  )
  const activeCount = projects.filter((project) => project.status === 'active').length
  const linkedCount = uniqueCases(projects.flatMap((project) => project.cases)).length
  const folderCount = new Set(projects.flatMap((project) => (project.folders ?? []).map((folder) => folderKey(folder.path)))).size

  return (
    <div className="project-dashboard">
      <div className="project-content">
        <header className="project-header">
          <div><span className="project-eyebrow">사건과 폴더를 연결하고, 목표를 함께 관리하세요</span><h1>프로젝트</h1><p>관련 사건과 참고 폴더, 공통 목표와 다음 행동을 한곳에 모읍니다.</p></div>
          <span className="project-local-badge">이 기기에 저장</span>
        </header>
        {loadError && <div className="project-inline-error" role="alert"><span>{loadError}</span><button className="dash-btn" onClick={() => void load()}>다시 시도</button></div>}
        {editor && !inlineField ? <ProjectEditor key={editor.project?.id ?? 'new'} project={editor.project} target={editor.target} cases={cases} sshProfiles={sshProfiles} defaultExecutionProfileId={defaultExecutionProfileId} saving={saving} error={actionError} onPickFolder={onPickFolder} onSave={save} onCancel={cancelEditor} />
          : selected ? <section className="project-detail" aria-label={selected.name}>
            <button className="project-back" disabled={detailBusy} onClick={() => onSelect(null)}>← 프로젝트 목록</button>
            <div className="project-detail-title">
              <div><span className={`project-status ${selected.status}`}>{selected.status === 'active' ? '진행 중' : '완료'}</span><h2>{selected.name}</h2><span className="project-muted">사건 {selected.cases.length}개 · 폴더 {(selected.folders ?? []).length}개 연결 · {new Date(selected.updatedAt).toLocaleDateString('ko-KR')} 수정</span></div>
              <button className="dash-btn" disabled={detailBusy} onClick={() => startEditor(selected)}>프로젝트 수정</button>
            </div>
            <ProjectWorkspaceSection key={`${selected.id}:${selected.executionProfileId ?? ''}:${selected.workingFolder?.path ?? ''}`} project={selected} disabled={detailBusy} opening={openingWorkspace} onEdit={() => void changeWorkspace()} onOpen={() => void openWorkspace()} />
            <section className="project-work" aria-labelledby="project-work-heading" aria-busy={openingWork !== null}>
              <div className="project-work-description">
                <p className="project-execution-location">AI 실행 위치 · {selected.executionProfileId ? `${sshProfiles.find((profile) => profile.id === selected.executionProfileId)?.label ?? '연결 설정 없음'} (원격)` : '이 PC (로컬)'}</p>
                <h3 id="project-work-heading">프로젝트 맥락으로 함께 검토하세요</h3>
                <p>목표·메모·연결된 사건과 폴더를 함께 참고합니다. 근거는 출처별로 구분하고, 접근할 수 없는 자료는 따로 알려드립니다.</p>
              </div>
              {selected.executionProfileId && <p>원격 프로젝트 도구를 사용하려면 이 앱을 열어 두세요. 앱을 닫으면 실행 중인 요청은 종료되며, 저장된 대화는 다시 이어갈 수 있습니다.</p>}
              <div className="project-work-actions">
                <button className="dash-btn project-primary" disabled={detailBusy} aria-label={workOpen ? '프로젝트 대화 이어가기' : '프로젝트 AI 작업'} onClick={() => void openWork()}>{openingWork === 'continue' ? '대화 여는 중…' : workOpen ? '대화 이어가기' : '프로젝트 AI 작업'}</button>
                <button className="dash-btn" disabled={detailBusy} aria-label="프로젝트 새 대화" onClick={() => void openWork(true)}>{openingWork === 'new' ? '대화 여는 중…' : '새 대화'}</button>
              </div>
            </section>
            {actionError && !inlineField && <p className="project-inline-error" role="alert">{actionError}</p>}
            <div className="project-focus-grid">
              <section className="project-focus"><span className="project-section-number">01</span>{projectText(selected, 'goal', '공통 목표', '이 프로젝트로 이루려는 목표를 적어 주세요.')}</section>
              <section className="project-focus project-next"><span className="project-section-number">02</span>{projectText(selected, 'nextAction', '다음 행동', '지금 가장 먼저 진행할 일을 정해 보세요.')}</section>
            </div>
            <section className="project-members-section">
              <div className="project-section-heading"><div className="project-heading-with-count"><h3>연결된 사건</h3><span className="project-count">{selected.cases.length}</span></div><button className="dash-btn" disabled={detailBusy} onClick={() => startEditor(selected, 'cases')}>사건 연결 관리</button></div>
              <p className="project-muted">사건을 열면 해당 사건의 기록과 서면 작업으로 이동합니다.</p>
              {selected.cases.length ? <div className="project-members">{selected.cases.map((item) => <div className="project-member" key={item.key}><div className="project-member-icon" aria-hidden="true">↗</div><div className="project-member-info"><strong>{item.name}</strong><span>{caseSubtitle(item)}</span></div><button className="dash-btn" disabled={detailBusy} onClick={() => void openCase(item)} aria-label={`${item.name} 사건 열기`}>{openingCase === item.key ? '여는 중…' : '사건 열기 →'}</button></div>)}</div>
                : <div className="project-member-empty"><p>아직 연결된 사건이 없습니다.</p><button className="dash-btn" disabled={detailBusy} onClick={() => startEditor(selected, 'cases')}>기존 사건 연결</button><button className="dash-btn" disabled={detailBusy} onClick={onAddCase}>새 사건 추가</button></div>}
            </section>
            <section className="project-members-section project-folders-section">
              <div className="project-section-heading"><div className="project-heading-with-count"><h3>참고 자료 폴더</h3><span className="project-count">{(selected.folders ?? []).length}</span></div><button className="dash-btn" disabled={detailBusy} onClick={() => startEditor(selected, 'folders')}>폴더 연결 관리</button></div>
              <p className="project-muted">프로젝트 AI가 읽고 비교할 자료입니다. 아래 이동 버튼은 프로젝트 화면을 벗어나 해당 폴더의 파일 작업을 엽니다.</p>
              {(selected.folders ?? []).length ? <div className="project-members">{selected.folders.map((folder) => <div className="project-folder" key={folder.path}>
                <div className="project-member-icon" aria-hidden="true">↗</div><div className="project-member-info"><strong>{folder.name} <small className="project-source">{folder.path.startsWith('ssh://') ? '원격' : '로컬'}</small></strong><span className="project-folder-path">{folder.path}</span></div>
                <button className="dash-btn" disabled={detailBusy} onClick={() => void openFolder(folder)} aria-label={`${folder.name} 폴더 작업으로 이동`}>{openingFolder === folder.path ? '여는 중…' : '폴더 작업으로 이동 →'}</button>
              </div>)}</div> : <div className="project-member-empty"><p>아직 연결된 참고 자료 폴더가 없습니다.</p><button className="dash-btn" disabled={detailBusy} onClick={() => startEditor(selected, 'folders')}>참고 자료 폴더 연결</button></div>}
            </section>
            <section className="project-notes">{projectText(selected, 'notes', '공통 메모', '공통 사실관계와 전략, 사건 간 관계를 기록해 두세요.')}</section>
            <footer className="project-detail-footer"><span className="project-muted">사건과 참고 폴더의 파일은 원래 위치에서 관리됩니다.</span><button className="project-text-button" onClick={() => setConfirmDelete(true)} disabled={detailBusy}>프로젝트 삭제</button></footer>
            {confirmDelete && <div className="project-delete-confirm" role="alertdialog" aria-labelledby="project-delete-title" aria-describedby="project-delete-description"><h3 id="project-delete-title">프로젝트를 삭제할까요?</h3><p id="project-delete-description">프로젝트의 목표와 메모, 사건·폴더 연결만 삭제합니다. 연결된 사건과 폴더, 파일은 그대로 남습니다.</p><div className="project-actions"><button className="dash-btn" disabled={deleting} onClick={() => setConfirmDelete(false)}>취소</button><button className="dash-btn project-danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '삭제 중…' : '프로젝트만 삭제'}</button></div></div>}
          </section>
          : selectedId && !loading ? <div className="project-empty"><h2>프로젝트를 찾을 수 없습니다.</h2><p>다른 창에서 삭제되었을 수 있습니다.</p><button className="dash-btn" onClick={() => onSelect(null)}>프로젝트 목록</button></div>
          : <>
            <div className="project-stats" aria-label="프로젝트 현황"><div><span>진행 중인 프로젝트</span><strong>{activeCount}<small>개</small></strong></div><div><span>연결된 사건</span><strong>{linkedCount}<small>개</small></strong></div><div><span>참고 폴더</span><strong>{folderCount}<small>개</small></strong></div><div><span>완료한 프로젝트</span><strong>{projects.length - activeCount}<small>개</small></strong></div></div>
            <div className="project-toolbar"><div className="project-filters" aria-label="프로젝트 상태">{(['active', 'completed', 'all'] as const).map((value) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'active' ? '진행 중' : value === 'completed' ? '완료' : '전체'}<span>{value === 'active' ? activeCount : value === 'completed' ? projects.length - activeCount : projects.length}</span></button>)}</div><button className="dash-btn project-primary" onClick={() => startEditor(null)}>+ 새 프로젝트</button></div>
            <input className="dash-search project-search" type="search" placeholder="프로젝트 이름, 목표, 연결된 사건·폴더 검색" aria-label="프로젝트 검색" value={search} onChange={(event) => setSearch(event.target.value)} />
            {loading && !projects.length ? <p className="project-loading" role="status">프로젝트를 불러오는 중…</p>
              : !filtered.length ? <div className="project-empty"><div className="project-empty-icon" aria-hidden="true">▦</div><h2>{projects.length ? '표시할 프로젝트가 없습니다.' : '함께 참고할 사건과 폴더를 모아 보세요'}</h2><p>{projects.length ? '검색어나 상태 필터를 바꾸어 확인해 보세요.' : '관련 사건과 자료 폴더를 하나의 목표 아래 정리하세요.\n사건 없이 폴더만 연결해도 프로젝트를 만들 수 있습니다.'}</p>{!projects.length && <button className="dash-btn project-primary" onClick={() => startEditor(null)}>첫 프로젝트 만들기</button>}</div>
              : <div className="project-grid">{filtered.map((project) => <button className="project-card" key={project.id} onClick={() => onSelect(project.id)}><div className="project-card-top"><span className={`project-status ${project.status}`}>{project.status === 'active' ? '진행 중' : '완료'}</span><span className="project-card-arrow" aria-hidden="true">↗</span></div><h2>{project.name}</h2><p className="project-card-goal">{project.goal || '공통 목표를 설정해 보세요.'}</p><div className="project-card-next"><span>다음 행동</span><p>{project.nextAction || '다음 행동을 정해 보세요.'}</p></div><div className="project-card-footer"><span>사건 <strong>{project.cases.length}</strong> · 폴더 <strong>{(project.folders ?? []).length}</strong></span><span>{[...project.cases, ...(project.folders ?? [])].slice(0, 2).map((item) => item.name).join(' · ') || '사건과 폴더 연결 가능'}</span></div></button>)}</div>}
          </>}
      </div>
    </div>
  )
}
