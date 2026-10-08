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

// Keep an unfinished form when the user temporarily opens an individual case.
let sessionDraft: { project: Project | null; input: ProjectInput } | null = null

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

function ProjectEditor({ project, cases, sshProfiles, defaultExecutionProfileId, saving, error, onPickFolder, onSave, onCancel }: {
  project: Project | null
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
  const [executionProfileId, setExecutionProfileId] = useState(initial ? initial.executionProfileId ?? '' : defaultExecutionProfileId ?? '')
  const [folders, setFolders] = useState<ProjectFolderLink[]>(initial?.folders ?? [])
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

  useEffect(() => {
    sessionDraft = { project, input: { name, goal, nextAction, notes, status, cases: members, folders, ...(executionProfileId ? { executionProfileId } : {}) } }
  }, [project, name, goal, nextAction, notes, status, members, folders, executionProfileId])

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
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim() || saving || pickingFolder) return
    void onSave({
      ...(project ? { id: project.id, expectedUpdatedAt: project.updatedAt } : {}),
      name: name.trim(), goal: goal.trim(), nextAction: nextAction.trim(), notes: notes.trim(),
      status, cases: members, folders, ...(executionProfileId ? { executionProfileId } : {})
    })
  }

  return (
    <form className="project-editor" onSubmit={submit}>
      <div className="project-section-heading">
        <div><span className="project-eyebrow">프로젝트 설정</span><h2>{project ? '프로젝트 수정' : '새 프로젝트'}</h2></div>
        <button className="dash-btn" type="button" onClick={onCancel} disabled={saving || pickingFolder}>취소</button>
      </div>
      <p className="project-muted">함께 이루려는 목표를 적고 관련 사건과 참고 폴더를 연결하세요. 폴더만으로 프로젝트를 구성해도 됩니다.</p>
      <fieldset disabled={saving}>
        <div className="project-form-row">
          <label className="project-field project-name-field">프로젝트 이름 <span className="project-required">필수</span>
            <input name="name" autoFocus required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="예: A사 거래대금 회수" />
          </label>
          <label className="project-field">상태
            <select name="status" value={status} onChange={(event) => setStatus(event.target.value as Project['status'])}>
              <option value="active">진행 중</option><option value="completed">완료</option>
            </select>
          </label>
        </div>
        <label className="project-field">AI 실행 위치
          <select name="executionProfileId" value={executionProfileId} onChange={(event) => setExecutionProfileId(event.target.value)}>
            <option value="">이 PC (로컬)</option>
            {sshProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} (원격)</option>)}
            {executionProfileId && !sshProfiles.some((profile) => profile.id === executionProfileId) && <option value={executionProfileId}>연결 설정 없음 · {executionProfileId}</option>}
          </select>
          <span className="project-muted">{executionProfileId ? '선택한 원격 컴퓨터에서 AI를 실행합니다. 프로젝트 도구를 사용하려면 이 앱을 열어 두세요. 앱을 닫으면 실행 중인 요청은 종료되며, 저장된 대화는 다시 이어갈 수 있습니다.' : '이 PC에서 AI를 실행합니다. 설정에 저장한 원격 연결도 선택할 수 있습니다.'}</span>
        </label>
        <label className="project-field">공통 목표
          <textarea name="goal" rows={3} maxLength={4000} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="이 프로젝트를 통해 무엇을 달성하려고 하나요?" />
        </label>
        <label className="project-field">다음 행동
          <textarea name="nextAction" rows={2} maxLength={4000} value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="지금 가장 먼저 진행할 일과 사건 사이의 순서를 적어 주세요." />
        </label>
        <section className="project-case-picker" aria-labelledby="project-cases-heading">
          <div className="project-section-heading"><h3 id="project-cases-heading">연결할 사건</h3><span className="project-count">{members.length}개 선택</span></div>
          <p className="project-muted">연결된 사건도 개별 사건 화면에서 그대로 작업할 수 있습니다.</p>
          <input type="search" className="dash-search" aria-label="연결할 사건 검색" placeholder="사건명, 사건번호, 법원으로 검색" value={search} onChange={(event) => setSearch(event.target.value)} />
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
          <div className="project-section-heading"><div className="project-heading-with-count"><h3 id="project-folders-heading">참고 폴더</h3><span className="project-count">{folders.length}개</span></div><button className="dash-btn" type="button" disabled={pickingFolder} onClick={() => void addFolder()}>{pickingFolder ? '선택 중…' : '폴더 추가'}</button></div>
          <p className="project-muted">프로젝트에서 함께 참고할 폴더를 연결합니다. 폴더의 파일은 원래 위치에 유지됩니다.</p>
          {folders.length ? <div className="project-members">{folders.map((folder) => <div className="project-folder-option" key={folder.path}>
            <div className="project-member-info"><strong>{folder.name} <small className="project-source">{folder.path.startsWith('ssh://') ? '원격' : '로컬'}</small></strong><span className="project-folder-path">{folder.path}</span></div>
            <button className="dash-btn" type="button" aria-label={`${folder.name} 폴더 연결 해제`} onClick={() => { setFolders((current) => current.filter((item) => item.path !== folder.path)); setFolderNotice('') }}>연결 해제</button>
          </div>)}</div> : <p className="project-folder-empty">아직 연결된 참고 폴더가 없습니다.</p>}
          {folderError && <p className="project-inline-error" role="alert">{folderError}</p>}
          {folderNotice && <p className="project-muted" role="status">{folderNotice}</p>}
        </section>
        <label className="project-field">공통 메모
          <textarea name="notes" rows={5} maxLength={50000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="공통 사실관계, 전략, 사건 간 관계와 결정 사항을 정리하세요." />
        </label>
      </fieldset>
      {error && <p className="project-inline-error" role="alert">{error}</p>}
      <div className="project-form-footer"><span className="project-muted">이 기기에 저장</span><button className="dash-btn project-primary" type="submit" disabled={saving || pickingFolder || !name.trim()}>{saving ? '저장 중…' : project ? '변경사항 저장' : '프로젝트 만들기'}</button></div>
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
  const [editor, setEditor] = useState<{ project: Project | null } | null>(() => sessionDraft ? { project: sessionDraft.project } : null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [openingCase, setOpeningCase] = useState<string | null>(null)
  const [openingFolder, setOpeningFolder] = useState<string | null>(null)
  const [openingWork, setOpeningWork] = useState<'continue' | 'new' | null>(null)
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

  const startEditor = (project: Project | null): void => {
    sessionDraft = null
    setActionError('')
    setConfirmDelete(false)
    setEditor({ project })
  }
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
  const selected = projects.find((project) => project.id === selectedId)
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
        {editor ? <ProjectEditor key={editor.project?.id ?? 'new'} project={editor.project} cases={cases} sshProfiles={sshProfiles} defaultExecutionProfileId={defaultExecutionProfileId} saving={saving} error={actionError} onPickFolder={onPickFolder} onSave={save} onCancel={() => { sessionDraft = null; setEditor(null); setActionError('') }} />
          : selected ? <section className="project-detail" aria-label={selected.name}>
            <button className="project-back" onClick={() => onSelect(null)}>← 프로젝트 목록</button>
            <div className="project-detail-title">
              <div><span className={`project-status ${selected.status}`}>{selected.status === 'active' ? '진행 중' : '완료'}</span><h2>{selected.name}</h2><span className="project-muted">사건 {selected.cases.length}개 · 폴더 {(selected.folders ?? []).length}개 연결 · {new Date(selected.updatedAt).toLocaleDateString('ko-KR')} 수정</span></div>
              <button className="dash-btn" onClick={() => startEditor(selected)}>프로젝트 수정</button>
            </div>
            <section className="project-work" aria-labelledby="project-work-heading" aria-busy={openingWork !== null}>
              <div className="project-work-description">
                <p className="project-execution-location">AI 실행 위치 · {selected.executionProfileId ? `${sshProfiles.find((profile) => profile.id === selected.executionProfileId)?.label ?? '연결 설정 없음'} (원격)` : '이 PC (로컬)'}</p>
                <h3 id="project-work-heading">프로젝트 맥락으로 함께 검토하세요</h3>
                <p>목표·메모·연결된 사건과 폴더를 함께 참고합니다. 근거는 출처별로 구분하고, 접근할 수 없는 자료는 따로 알려드립니다.</p>
              </div>
              {selected.executionProfileId && <p>원격 프로젝트 도구를 사용하려면 이 앱을 열어 두세요. 앱을 닫으면 실행 중인 요청은 종료되며, 저장된 대화는 다시 이어갈 수 있습니다.</p>}
              <div className="project-work-actions">
                <button className="dash-btn project-primary" disabled={openingWork !== null || deleting} aria-label={workOpen ? '프로젝트 대화 이어가기' : '프로젝트 AI 작업'} onClick={() => void openWork()}>{openingWork === 'continue' ? '대화 여는 중…' : workOpen ? '대화 이어가기' : '프로젝트 AI 작업'}</button>
                <button className="dash-btn" disabled={openingWork !== null || deleting} aria-label="프로젝트 새 대화" onClick={() => void openWork(true)}>{openingWork === 'new' ? '대화 여는 중…' : '새 대화'}</button>
              </div>
            </section>
            {actionError && <p className="project-inline-error" role="alert">{actionError}</p>}
            <div className="project-focus-grid">
              <section className="project-focus"><span className="project-section-number">01</span><h3>공통 목표</h3><p className={selected.goal ? '' : 'project-muted'}>{selected.goal || '이 프로젝트로 이루려는 목표를 적어 주세요.'}</p></section>
              <section className="project-focus project-next"><span className="project-section-number">02</span><h3>다음 행동</h3><p className={selected.nextAction ? '' : 'project-muted'}>{selected.nextAction || '지금 가장 먼저 진행할 일을 정해 보세요.'}</p></section>
            </div>
            <section className="project-members-section">
              <div className="project-section-heading"><div className="project-heading-with-count"><h3>연결된 사건</h3><span className="project-count">{selected.cases.length}</span></div><button className="dash-btn" onClick={() => startEditor(selected)}>사건 연결 관리</button></div>
              <p className="project-muted">사건을 열면 해당 사건의 기록과 서면 작업으로 이동합니다.</p>
              {selected.cases.length ? <div className="project-members">{selected.cases.map((item) => <div className="project-member" key={item.key}><div className="project-member-icon" aria-hidden="true">↗</div><div className="project-member-info"><strong>{item.name}</strong><span>{caseSubtitle(item)}</span></div><button className="dash-btn" disabled={openingCase !== null} onClick={() => void openCase(item)} aria-label={`${item.name} 사건 열기`}>{openingCase === item.key ? '여는 중…' : '사건 열기 →'}</button></div>)}</div>
                : <div className="project-member-empty"><p>아직 연결된 사건이 없습니다.</p><button className="dash-btn" onClick={() => startEditor(selected)}>기존 사건 연결</button><button className="dash-btn" onClick={onAddCase}>새 사건 추가</button></div>}
            </section>
            <section className="project-members-section project-folders-section">
              <div className="project-section-heading"><div className="project-heading-with-count"><h3>참고 폴더</h3><span className="project-count">{(selected.folders ?? []).length}</span></div><button className="dash-btn" onClick={() => startEditor(selected)}>폴더 연결 관리</button></div>
              <p className="project-muted">프로젝트에서 함께 참고할 폴더입니다. 폴더를 열면 해당 폴더의 작업 공간으로 이동합니다.</p>
              {(selected.folders ?? []).length ? <div className="project-members">{selected.folders.map((folder) => <div className="project-folder" key={folder.path}>
                <div className="project-member-icon" aria-hidden="true">↗</div><div className="project-member-info"><strong>{folder.name} <small className="project-source">{folder.path.startsWith('ssh://') ? '원격' : '로컬'}</small></strong><span className="project-folder-path">{folder.path}</span></div>
                <button className="dash-btn" disabled={openingFolder !== null || openingCase !== null} onClick={() => void openFolder(folder)} aria-label={`${folder.name} 폴더 열기`}>{openingFolder === folder.path ? '여는 중…' : '폴더 열기 →'}</button>
              </div>)}</div> : <div className="project-member-empty"><p>아직 연결된 참고 폴더가 없습니다.</p><button className="dash-btn" onClick={() => startEditor(selected)}>참고 폴더 연결</button></div>}
            </section>
            <section className="project-notes"><h3>공통 메모</h3><p className={selected.notes ? '' : 'project-muted'}>{selected.notes || '공통 사실관계와 전략, 사건 간 관계를 기록해 두세요.'}</p></section>
            <footer className="project-detail-footer"><span className="project-muted">사건과 참고 폴더의 파일은 원래 위치에서 관리됩니다.</span><button className="project-text-button" onClick={() => setConfirmDelete(true)} disabled={deleting}>프로젝트 삭제</button></footer>
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
