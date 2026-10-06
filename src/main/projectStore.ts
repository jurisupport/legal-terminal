import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import type { Project, ProjectCaseLink, ProjectFolderLink, ProjectInput } from '../shared/project'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('프로젝트 정보의 형식이 올바르지 않습니다.')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, required = false, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) {
    throw new Error(`${field}을(를) 확인해 주세요.`)
  }
  return value
}

function folderKey(path: string): string {
  const remote = /^ssh:\/\/([^/\\\s]+)(\/.*)$/s.exec(path)
  const windows = /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)
  if (path.includes('\0') || (!remote && !windows && !path.startsWith('/'))) {
    throw new Error('컨텍스트 폴더의 절대 경로 또는 원격 경로를 확인해 주세요.')
  }
  const sourcePath = remote?.[2] ?? path
  const parsedRoot = windows ? win32.parse(sourcePath).root : '/'
  const root = (parsedRoot.startsWith('\\\\') ? parsedRoot.replace(/[\\/]+$/, '') : parsedRoot).normalize('NFC')
  const key = sourcePath.normalize('NFC').replace(windows ? /[\\/]+$/ : /\/+$/, '')
  return `${remote ? `ssh://${remote[1]}` : ''}${key.length < root.length ? root : key}`
}

function inputFields(value: unknown): ProjectInput & Pick<Project, 'folders'> {
  const row = object(value)
  if (row.status !== 'active' && row.status !== 'completed') {
    throw new Error('프로젝트 상태를 확인해 주세요.')
  }
  if (!Array.isArray(row.cases) || row.cases.length > 1000) {
    throw new Error('연결 사건 목록을 확인해 주세요. 한 프로젝트에 최대 1,000건을 연결할 수 있습니다.')
  }
  const cases: ProjectCaseLink[] = []
  const keys = new Set<string>()
  for (const item of row.cases) {
    const entry = object(item)
    const link: ProjectCaseLink = {
      key: text(entry.key, '사건 식별자', true),
      name: text(entry.name, '사건명', true).trim()
    }
    for (const key of ['jsId', 'caseNumber', 'court', 'drafts', 'records', 'profileId', 'remotePath'] as const) {
      if (entry[key] !== undefined) {
        const value = text(entry[key], key)
        if (value.trim()) link[key] = value
      }
    }
    if (!link.jsId && !link.drafts && !(link.profileId && link.remotePath)) {
      throw new Error('연결 사건의 사건 ID 또는 작업 폴더를 확인해 주세요.')
    }
    if (!keys.has(link.key)) {
      keys.add(link.key)
      cases.push(link)
    }
  }
  const folderEntries = row.folders === undefined ? [] : row.folders
  if (!Array.isArray(folderEntries) || folderEntries.length > 1000) {
    throw new Error('컨텍스트 폴더 목록을 확인해 주세요. 한 프로젝트에 최대 1,000개를 연결할 수 있습니다.')
  }
  const folders: ProjectFolderLink[] = []
  const folderKeys = new Set<string>()
  for (const item of folderEntries) {
    const entry = object(item)
    const folder = { name: text(entry.name, '폴더 이름', true).trim(), path: text(entry.path, '폴더 경로', true) }
    const key = folderKey(folder.path)
    if (!folderKeys.has(key)) {
      folderKeys.add(key)
      folders.push(folder)
    }
  }
  return {
    name: text(row.name, '프로젝트 이름', true, 200).trim(),
    goal: text(row.goal, '목표', false, 4000),
    nextAction: text(row.nextAction, '다음 행동', false, 4000),
    notes: text(row.notes, '공통 메모', false, 50000),
    status: row.status,
    cases,
    folders,
    ...(row.id !== undefined ? { id: text(row.id, '프로젝트 식별자', true) } : {}),
    ...(row.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: text(row.expectedUpdatedAt, '수정 시각', true) }
      : {})
  }
}

function timestamp(value: unknown): string {
  const result = text(value, '저장 시각', true)
  if (!Number.isFinite(Date.parse(result))) throw new Error('저장 시각이 올바르지 않습니다.')
  return result
}

export class ProjectStore {
  private file: string
  // ponytail: one file and one queue; use a transactional store if project volume outgrows it.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<Project[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('프로젝트 파일을 읽을 수 없습니다. 기존 파일은 변경하지 않았습니다.', { cause: error })
    }
    try {
      const store = object(JSON.parse(raw))
      if (store.version !== 1 || !Array.isArray(store.projects)) throw new Error('알 수 없는 저장 형식')
      const ids = new Set<string>()
      return store.projects.map((value) => {
        const row = object(value)
        const { id: _id, expectedUpdatedAt: _expected, ...fields } = inputFields(row)
        const id = text(row.id, '프로젝트 식별자', true)
        if (ids.has(id)) throw new Error('중복 프로젝트 식별자')
        ids.add(id)
        return { ...fields, id, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }
      })
    } catch (error) {
      throw new Error('프로젝트 파일이 손상되었거나 지원하지 않는 형식입니다. 기존 파일은 변경하지 않았습니다.', { cause: error })
    }
  }

  private async write(projects: Project[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, projects }, null, 2), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  list(): Promise<Project[]> {
    return this.serialized(() => this.read())
  }

  async save(input: ProjectInput): Promise<Project> {
    const { id, expectedUpdatedAt, ...fields } = inputFields(input)
    return this.serialized(async () => {
      const projects = await this.read()
      const previous = id ? projects.find((project) => project.id === id) : undefined
      if (id && !previous) throw new Error('프로젝트가 삭제되었거나 존재하지 않습니다. 목록을 새로고침해 주세요.')
      if (previous && expectedUpdatedAt !== previous.updatedAt) {
        throw new Error('다른 창에서 프로젝트가 변경되었습니다. 새로고침 후 다시 저장해 주세요.')
      }
      const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString()
      const project: Project = {
        ...fields,
        id: previous?.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      }
      await this.write([project, ...projects.filter((entry) => entry.id !== project.id)])
      return project
    })
  }

  async remove(id: string, expectedUpdatedAt?: string): Promise<void> {
    text(id, '프로젝트 식별자', true)
    if (expectedUpdatedAt !== undefined) text(expectedUpdatedAt, '수정 시각', true)
    return this.serialized(async () => {
      const projects = await this.read()
      const previous = projects.find((project) => project.id === id)
      if (!previous) throw new Error('프로젝트가 삭제되었거나 존재하지 않습니다. 목록을 새로고침해 주세요.')
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== previous.updatedAt) {
        throw new Error('다른 창에서 프로젝트가 변경되었습니다. 새로고침 후 다시 삭제해 주세요.')
      }
      await this.write(projects.filter((project) => project.id !== id))
    })
  }
}
