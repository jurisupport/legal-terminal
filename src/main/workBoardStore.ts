import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import type { BoardStatus, BoardTask, BoardTeam } from '../shared/workBoard'

const statuses: BoardStatus[] = ['queued', 'running', 'blocked', 'reported', 'in_review', 'awaiting_approval', 'approved', 'rejected', 'done', 'failed']
const template = ['결론', '한 일', '산출물 경로', '결재 요청 사항', '미확인 사항', '기한·위험'].map(s => '## ' + s + '\n\n').join('')
const teams: BoardTeam[] = [
  { name: '준법감시', color: '#c42c32', agents: ['compliance', 'compliance-review'] },
  { name: '법무팀', color: '#376ac6', agents: ['contract-review', 'evidence-synthesis', 'exec-summary'] },
  { name: '콘텐츠팀', color: '#8c44bb', agents: ['sns-curator', 'content-planner', 'youtube-optimizer'] },
  { name: '마케팅팀', color: '#c65f16', agents: ['marketing-ad-creative', 'ad-creative', 'search-ads', 'seo', 'ai-search', 'social-ads'] },
  { name: '영업·홍보팀', color: '#148369', agents: ['newsletter', 'pr', 'proposal', 'lead-gen'] },
  { name: '플랫폼운영팀', color: '#168097', agents: ['platform-manager'] }
]

const idPattern = /^[a-z\d][a-z\d_-]{0,127}$/i
function validId(id: unknown): id is string {
  return typeof id === 'string' && idPattern.test(id) && !/^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9])$/i.test(id)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('속성 형식을 확인해 주세요.')
  return value as Record<string, unknown>
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseTask(id: string, source: string, fallbackDate = new Date().toISOString()): BoardTask | null {
  if (!/^\uFEFF?---\r?\n/.test(source)) return null
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new Error('지시서 머리말을 닫는 ---가 없습니다.')
  const v = record(load(match[1], {schema: JSON_SCHEMA}))
  if (v.id !== id || !validId(id) || typeof v.title !== 'string' || !v.title.trim() || typeof v.cwd !== 'string' || !v.cwd) {
    throw new Error('지시서 파일명·id·제목·작업 폴더를 확인해 주세요.')
  }
  if (!statuses.includes(v.status as BoardStatus)) throw new Error('알 수 없는 업무 상태입니다.')
  for (const field of ['agent', 'review_agent', 'due', 'after_approval', 'sessionId', 'parentId']) {
    if (v[field] != null && typeof v[field] !== 'string') throw new Error('문자열 속성을 확인해 주세요: ' + field)
  }
  if (typeof v.due === 'string' && v.due && !/^\d{4}-\d\d-\d\d$/.test(v.due)) throw new Error('기한 형식을 확인해 주세요.')
  if (v.approval != null && v.approval !== 'required' && v.approval !== 'none') throw new Error('결재 설정을 확인해 주세요.')
  if (v.depends_on != null && (!strings(v.depends_on) || !v.depends_on.every(validId))) throw new Error('선행 지시 목록을 확인해 주세요.')
  if (v.allowed_tools != null && !strings(v.allowed_tools)) throw new Error('허용 도구 목록을 확인해 주세요.')
  if (v.parentId != null && !validId(v.parentId)) throw new Error('상위 지시 ID를 확인해 주세요.')
  for (const key of ['order', 'attempts']) {
    if (v[key] != null && (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0)) throw new Error('숫자 속성을 확인해 주세요: ' + key)
  }
  for (const key of ['createdAt', 'updatedAt']) if (v[key] != null && !date(v[key])) throw new Error('날짜 속성을 확인해 주세요: ' + key)
  if (v.log != null && (!Array.isArray(v.log) || !v.log.every(e => e && date(e.at) && typeof e.text === 'string'))) throw new Error('진행 기록의 형식을 확인해 주세요.')
  // YAML null is common in unfilled optional fields.
  const optionalKeys = ['agent', 'review_agent', 'due', 'after_approval', 'sessionId', 'parentId', 'depends_on', 'allowed_tools', 'approval', 'order', 'attempts', 'createdAt', 'updatedAt']
  const fields = Object.fromEntries(optionalKeys.filter(k => v[k] != null).map(k => [k, v[k]]))
  if (Array.isArray(v.log)) fields.log = v.log.map(({at, text}) => ({at, text}))
  return { approval: 'required', order: 0, attempts: 0, log: [], createdAt: fallbackDate, updatedAt: fallbackDate, ...fields,
    id, title: v.title, cwd: v.cwd, status: v.status as BoardStatus, body: match[2] } as BoardTask
}

function revision(source: string) {
  return createHash('sha256').update(source).digest('hex')
}

interface ArchivedTask {
  task: BoardTask
  signature: string
  checkedAt: number
}
class BoardFileError extends Error {}
const maxBytes = 16 * 1024 * 1024

export class WorkBoardStore {
  readonly root: string
  private readonly remote: boolean
  private readonly archived = new Map<string, ArchivedTask>()
  readonly warnings: string[] = []
  private readonly revisions = new Map<string, string>()

  constructor(root: string) {
    this.remote = root.startsWith('ssh://')
    if (this.remote ? !/^ssh:\/\/[^/\\\s]+\//.test(root) : !isAbsolute(root)) throw new Error('업무지시 폴더의 절대 경로가 필요합니다.')
    this.root = root
  }

  private path(name: string): string {
    const taskName = /^([A-Za-z0-9_-]+)(?:\.(?:report|review))?\.md$/.exec(name)
    if (!(taskName && validId(taskName[1])) && name !== '_보고서양식.md' && name !== 'teams.yaml' && name !== '_배분기' && !/^_일일보고\/\d{4}-\d\d-\d\d\.(?:md|html)$/.test(name)) {
      throw new Error('올바르지 않은 보드 파일 이름입니다.')
    }
    return this.remote ? this.root.replace(/\/+$/, '') + '/' + name : join(this.root, name)
  }

  private async stat(path: string) {
    if (this.remote) return (await import('./remoteFs')).rfsBoardStat(path)
    try {
      const stat = await lstat(path)
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('보드 파일에 심볼릭 링크를 사용할 수 없습니다.')
      return { size: stat.size, directory: stat.isDirectory(), mtimeMs: stat.mtimeMs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async ensureDir(path: string): Promise<void> {
    const stat = await this.stat(path)
    if (stat?.directory) return
    if (stat) throw new Error('보드 저장 경로가 폴더가 아닙니다.')
    if (this.remote) {
      const fs = await import('./remoteFs')
      const { profileId, path: remotePath } = fs.parseRemote(path)
      try {
        await fs.rfsMkdir(fs.makeRemote(profileId, posix.dirname(remotePath)), posix.basename(remotePath))
      } catch (error) {
        if (!(await this.stat(path))?.directory) throw error
      }
    } else await mkdir(path, {recursive: true, mode: 0o700})
  }

  async init(): Promise<void> {
    await this.ensureDir(this.root)
    for (const [name, content] of [['_보고서양식.md', template], ['teams.yaml', dump({teams})]]) {
      if (await this.readText(name) === null) {
        try { await this.writeText(name, content, true) }
        catch (error) { if (await this.readText(name) === null) throw error }
      }
    }
  }

  async claimOwner(token: string): Promise<boolean> {
    if (!token.trim()) throw new Error('배분기 식별자가 필요합니다.')
    const previous = await this.readText('_배분기')
    if (previous !== null) return previous === token
    try {
      await this.writeText('_배분기', token, true)
      return true
    } catch (error) {
      const existing = await this.readText('_배분기')
      if (existing === null) throw error
      return existing === token
    }
  }

  private async filePath(name: string, createDirectory: boolean): Promise<string> {
    const path = this.path(name)
    if (!(await this.stat(this.root))?.directory) throw new Error('업무지시 폴더가 없습니다.')
    if (name.includes('/')) {
      const dir = this.remote ? path.slice(0, path.lastIndexOf('/')) : dirname(path)
      if (createDirectory) await this.ensureDir(dir)
      else await this.stat(dir)
    }
    return path
  }

  private async read(name: string): Promise<{text: string; mtimeMs: number} | null> {
    const path = await this.filePath(name, false)
    const stat = await this.stat(path)
    if (!stat) return null
    if (stat.directory || stat.size > maxBytes) throw new BoardFileError('보드 파일의 종류나 크기를 확인해 주세요.')
    if (this.remote) {
      return {text: await (await import('./remoteFs')).rfsReadBoardText(path), mtimeMs: stat.mtimeMs}
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return {text: await handle.readFile('utf8'), mtimeMs: stat.mtimeMs} } finally { await handle.close() }
  }

  async readText(name: string): Promise<string | null> {
    return (await this.read(name))?.text ?? null
  }

  async writeText(name: string, content: string, exclusive = false): Promise<void> {
    const path = await this.filePath(name, true)
    const stat = await this.stat(path)
    if (stat?.directory || Buffer.byteLength(content) > maxBytes) throw new BoardFileError('보드 파일의 종류나 크기를 확인해 주세요.')
    if (this.remote) {
      await (await import('./remoteFs')).rfsWriteText(path, content, exclusive ? null : undefined, false)
      return
    }
    const tmp = join(dirname(path), '.board-' + randomUUID() + '.tmp')
    const handle = await open(tmp, 'wx', 0o600)
    try {
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      if (exclusive) await link(tmp, path)
      else await rename(tmp, path)
    } finally { await rm(tmp, {force: true}) }
  }

  async list(): Promise<BoardTask[]> {
    this.warnings.length = 0
    const entries: {name: string; size?: number; mtimeMs?: number}[] = this.remote
      ? (await (await import('./remoteFs')).rfsList(this.root, {refresh: true, prefetch: false, followSymlinks: false})).filter(e => !e.isDir)
      : (await readdir(this.root, {withFileTypes: true})).filter(e => e.isFile())
    const tasks: BoardTask[] = []
    const present = new Set<string>()
    const now = Date.now()
    // Audit the oldest four archives per poll for sync clients that preserve size and mtime.
    const audit = new Set([...this.archived].filter(([, entry]) => now - entry.checkedAt >= 60_000)
      .sort((a, b) => a[1].checkedAt - b[1].checkedAt).slice(0, 4).map(([id]) => id))
    for (const entry of entries) {
      const name = entry.name
      const id = name.endsWith('.md') ? name.slice(0, -3) : ''
      if (!validId(id)) continue
      present.add(id)
      const signature = entry.size !== undefined && entry.mtimeMs !== undefined ? entry.size + '/' + entry.mtimeMs : ''
      const cached = this.archived.get(id)
      if (signature && cached?.signature === signature && !audit.has(id)) {
        tasks.push(structuredClone(cached.task))
        continue
      }
      this.archived.delete(id)
      try {
        const file = await this.read(name)
        if (!file) continue
        let task: BoardTask | null
        try { task = parseTask(id, file.text, new Date(file.mtimeMs).toISOString()) }
        catch (error) { throw new BoardFileError(error instanceof Error ? error.message : String(error)) }
        if (!task) continue
        tasks.push(task)
        this.revisions.set(id, revision(file.text))
        if (signature && ['done', 'rejected', 'failed'].includes(task.status)) {
          this.archived.set(id, {task: structuredClone(task), signature, checkedAt: now})
        }
      } catch (error) {
        const code = (error as {code?: string | number}).code
        if (!(error instanceof BoardFileError) && code !== 'EACCES' && code !== 'EPERM' && code !== 3) throw error
        this.revisions.delete(id)
        this.warnings.push(name + ' · ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    for (const id of this.revisions.keys()) {
      if (!present.has(id)) { this.revisions.delete(id); this.archived.delete(id) }
    }
    return tasks.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  async save(task: BoardTask): Promise<void> {
    if (!validId(task.id)) throw new Error('올바르지 않은 지시 ID입니다.')
    const {body, ...fields} = task
    const source = '---\n' + dump(fields, {noRefs: true, lineWidth: -1}) + '---\n' + body
    parseTask(task.id, source)
    const name = task.id + '.md'
    const current = await this.readText(name)
    if ((current === null ? undefined : revision(current)) !== this.revisions.get(task.id)) throw new Error('지시 파일이 외부에서 변경되었습니다. 새로 고침해 주세요.')
    await this.writeText(name, source, current === null)
    this.revisions.set(task.id, revision(source))
    this.archived.delete(task.id)
  }

  async teams(): Promise<BoardTeam[]> {
    const source = await this.readText('teams.yaml')
    if (source === null) return []
    try {
      const data = load(source, {schema: JSON_SCHEMA})
      const rows = Array.isArray(data) ? data : record(data).teams
      if (!Array.isArray(rows) || !rows.every(row => row && typeof row.name === 'string' && typeof row.color === 'string' && /^#[\da-f]{6}$/i.test(row.color) && strings(row.agents))) {
        throw new Error('팀 이름·색상(#RRGGBB)·에이전트 목록을 확인해 주세요.')
      }
      return rows.map(({name, color, agents}) => ({name, color, agents}))
    } catch (error) {
      this.warnings.push('teams.yaml · ' + (error instanceof Error ? error.message : String(error)))
      return []
    }
  }
}
