import { constants } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { hostname } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { boardReportAvailable, isBoardReport } from '../shared/workBoard.ts'
import type { BoardStatus, BoardTask, BoardTeam } from '../shared/workBoard'

const statuses: BoardStatus[] = ['queued', 'running', 'delegated', 'blocked', 'reported', 'in_review', 'awaiting_approval', 'approved', 'rejected', 'done', 'failed']
const template = ['결론', '한 일', '산출물 경로', '결재 요청 사항', '미확인 사항', '기한·위험'].map(s => '## ' + s + '\n\n').join('')
// Departments are the user's own organization. A new board starts without any.
const teams: BoardTeam[] = []

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

// Use the same text budget as an agent-panel context attachment. Never silently truncate a saved reference.
const maxFollowUpChars = 160_000

export function followUpSnapshot(input: unknown, childId: string): NonNullable<BoardTask['followUp']> {
  const value = record(input)
  if (!validId(value.id) || value.id === childId || typeof value.title !== 'string' || !value.title.trim() ||
      typeof value.body !== 'string' || (value.report !== undefined && typeof value.report !== 'string') ||
      Object.keys(value).some(key => !['id', 'title', 'body', 'report'].includes(key))) {
    throw new Error('후속 지시의 원 지시 자료 형식을 확인해 주세요.')
  }
  const report = value.report
  if (value.title.length + value.body.length + (report?.length ?? 0) > maxFollowUpChars) {
    throw new Error('원 지시의 제목·본문·보고서가 16만 자를 넘어 후속 지시의 참고자료로 저장할 수 없습니다.')
  }
  if (report !== undefined && !boardReportAvailable(report)) throw new Error('원 지시의 유효한 업무 보고서가 아닙니다.')
  return { id: value.id, title: value.title, body: value.body, ...(report !== undefined && {report}) }
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
  for (const field of ['agent', 'team', 'review_agent', 'due', 'after_approval', 'sessionId', 'parentId', 'delegatedBy']) {
    if (v[field] != null && typeof v[field] !== 'string') throw new Error('문자열 속성을 확인해 주세요: ' + field)
  }
  if (typeof v.due === 'string' && v.due && !/^\d{4}-\d\d-\d\d$/.test(v.due)) throw new Error('기한 형식을 확인해 주세요.')
  if (v.approval != null && v.approval !== 'required' && v.approval !== 'none') throw new Error('결재 설정을 확인해 주세요.')
  if (v.depends_on != null && (!strings(v.depends_on) || !v.depends_on.every(validId))) throw new Error('선행 지시 목록을 확인해 주세요.')
  if (v.allowed_tools != null && !strings(v.allowed_tools)) throw new Error('허용 도구 목록을 확인해 주세요.')
  if (v.parentId != null && !validId(v.parentId)) throw new Error('상위 지시 ID를 확인해 주세요.')
  if (v.delegatedBy != null && (!validId(v.delegatedBy) || v.delegatedBy === id || v.parentId != null)) throw new Error('부서 지시 ID를 확인해 주세요.')
  for (const key of ['order', 'attempts']) {
    if (v[key] != null && (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0)) throw new Error('숫자 속성을 확인해 주세요: ' + key)
  }
  for (const key of ['createdAt', 'updatedAt']) if (v[key] != null && !date(v[key])) throw new Error('날짜 속성을 확인해 주세요: ' + key)
  if (v.editedNeedsRun !== undefined && v.editedNeedsRun !== true) throw new Error('수정 후 재실행 상태를 확인해 주세요.')
  if (v.log != null && (!Array.isArray(v.log) || !v.log.every(e => e && date(e.at) && typeof e.text === 'string'))) throw new Error('진행 기록의 형식을 확인해 주세요.')
  // YAML null is common in unfilled optional fields.
  const optionalKeys = ['agent', 'team', 'delegatedBy', 'review_agent', 'due', 'after_approval', 'sessionId', 'parentId', 'depends_on', 'allowed_tools', 'approval', 'order', 'attempts', 'createdAt', 'updatedAt', 'editedNeedsRun']
  const fields = Object.fromEntries(optionalKeys.filter(k => v[k] != null).map(k => [k, v[k]]))
  if (v.followUp != null) fields.followUp = followUpSnapshot(v.followUp, id)
  if (v.reportReceipt != null) {
    const receipt = record(v.reportReceipt)
    if ((receipt.state !== 'read' && receipt.state !== 'unread') ||
        typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('보고서 확인 기록의 형식을 확인해 주세요.')
    fields.reportReceipt = { state: receipt.state, digest: receipt.digest }
  }
  if (Array.isArray(v.log)) fields.log = v.log.map(({at, text}) => ({at, text}))
  return { approval: 'required', order: 0, attempts: 0, log: [], createdAt: fallbackDate, updatedAt: fallbackDate, ...fields,
    id, title: v.title, cwd: v.cwd, status: v.status as BoardStatus, body: match[2] } as BoardTask
}

export function validTeams(rows: unknown[]): BoardTeam[] {
  const names = new Set<string>()
  return rows.map(row => {
    const value = record(row)
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name || name.length > 40 || names.has(name)) throw new Error('부서 이름은 1~40자이고 서로 달라야 합니다.')
    names.add(name)
    if (typeof value.color !== 'string' || !/^#[\da-f]{6}$/i.test(value.color)) throw new Error('부서 색상(#RRGGBB)을 확인해 주세요: ' + name)
    if (!strings(value.agents) || value.agents.some(agent => !agent.trim())) throw new Error('부서원 목록을 확인해 주세요: ' + name)
    if (value.lead != null && (typeof value.lead !== 'string' || !value.lead.trim())) throw new Error('부서장 이름을 확인해 주세요: ' + name)
    const agents = [...new Set(value.agents.map(agent => agent.trim()))]
    return {name, color: value.color, agents, ...(typeof value.lead === 'string' && {lead: value.lead.trim()})}
  })
}

function revision(source: string) {
  return createHash('sha256').update(source).digest('hex')
}

export function unreadReportReceipt(report: string) {
  return boardReportAvailable(report) ? {state:'unread' as const, digest:revision(report)} : undefined
}

interface ArchivedTask {
  task: BoardTask
  signature: string
  checkedAt: number
}
class BoardFileError extends Error {}
const maxBytes = 16 * 1024 * 1024
const lockDir = '.work-board-lock'
const staleLockMs = 120_000
const busy = () => Object.assign(new Error('다른 기기가 보드를 변경 중입니다. 작업이 끝난 뒤 다시 시도해 주세요.'), {code:'BOARD_BUSY'})
const ownerChanged = () => Object.assign(new Error('보드 배분 기기가 변경되었습니다. 새로 고침해 주세요.'), {code:'BOARD_OWNER_CHANGED'})
type Detail = {report:string; review:string}
type Control = Awaited<ReturnType<typeof import('./remoteFs').rfsBoardControl>>
const missing = (error: unknown) => ['ENOENT',2].includes((error as {code:string|number}).code)


export class WorkBoardStore {
  readonly root: string
  private readonly remote: boolean
  private readonly archived = new Map<string, ArchivedTask>()
  readonly warnings: string[] = []
  private readonly leases = new AsyncLocalStorage<{path:string; expected:string}>()
  private readonly transferClocks = new AsyncLocalStorage<string>()
  private get lease() { return this.leases.getStore()?.path }
  private readonly revisions = new Map<string, string>()

  constructor(root: string) {
    this.remote = root.startsWith('ssh://')
    if (this.remote ? !/^ssh:\/\/[^/\\\s]+\//.test(root) : !isAbsolute(root)) throw new Error('업무지시 폴더의 절대 경로가 필요합니다.')
    this.root = root
  }

  private path(name: string): string {
    const taskName = /^([A-Za-z0-9_-]+)(?:\.(?:report|review))?\.md$/.exec(name)
    const archived = /^_보관\/([a-zA-Z0-9_-]+)\/\1(?:\.(?:report|review))?\.md$/.exec(name)
    const edited = /^_보관\/수정-[a-f0-9]{64}\.(?:report|review)\.md$/.test(name)
    if (!edited && !(archived && validId(archived[1])) && !(taskName && validId(taskName[1])) && name !== '_보고서양식.md' && name !== 'teams.yaml' && name !== '_배분기' && name !== '_배분기-활동' && !/^_일일보고\/\d{4}-\d\d-\d\d\.(?:md|html)$/.test(name)) {
      throw new Error('올바르지 않은 보드 파일 이름입니다.')
    }
    return this.location(name)
  }

  private location(name: string) {
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

  private async control(): Promise<Control> {
    if (!(await this.stat(this.root))?.directory) throw new Error('업무지시 폴더가 없습니다.')
    if (this.remote) return (await import('./remoteFs')).rfsBoardControl(this.root)
    return {
      mkdir: name => mkdir(this.location(name), {mode:0o700}),
      rmdir: name => rmdir(this.location(name)),
      unlink: name => unlink(this.location(name)),
      move: (from,to) => rename(this.location(from),this.location(to)),
      create: (name,data) => writeFile(this.location(name),data,{flag:'wx',mode:0o600}),
      touch: name => writeFile(this.location(name),'1',{flag:'r+'}),
      names: name => readdir(this.location(name))
    }
  }

  private async assertLease() {
    const lease = this.leases.getStore()
    if (lease && (!(await this.stat(this.location(lease.path))) || await this.readText('_배분기') !== lease.expected)) throw ownerChanged()
  }

  // Each holder removes only its unique entry. rmdir cannot remove a new nonempty holder.
  private async releaseLock(fs: Control, entry?: string) {
    if (!(await this.stat(this.location(lockDir)))?.directory) return
    if (entry) await fs.unlink(lockDir + '/' + entry).catch(error => { if (!missing(error)) throw error })
    await fs.rmdir(lockDir).catch(async error => {
      if (missing(error)) return
      const entries = await fs.names(lockDir).catch(readError => {
        if (missing(readError)) return null
        throw readError
      })
      if (entries && !entries.length) throw error
    })
  }

  async activityAgeMs(name = '_배분기-활동'): Promise<number | null> {
    const clock = this.transferClocks.getStore()
    if (!clock || name !== '_배분기-활동') throw new Error('인계 확인 중에만 활동 시간을 조회할 수 있습니다.')
    const now = await this.stat(this.location(clock))
    if (!now) throw ownerChanged()
    const activity = await this.stat(this.path(name))
    return activity ? Math.max(0,now.mtimeMs - activity.mtimeMs) : null
  }

  private async runGuard(clock: string, guard: () => Promise<void>) {
    await this.transferClocks.run(clock,guard)
  }

  private async recoverLock(fs: Control, device: string, expected: string, clock: string, guard?: () => Promise<void>) {
    if (!(await this.stat(this.location(lockDir)))?.directory) return false
    const entries = await fs.names(lockDir).catch(error => {
      if (missing(error)) return null
      throw error
    })
    if (!entries) return true
    if (entries.length === 0) { await this.releaseLock(fs); return true }
    if (entries.length !== 1) return false
    const entry = entries[0]
    const parts = /^([a-f0-9-]{36})_([0-9a-f]{64})_(\d+)_([0-9a-f]{64})_([0-9a-f]{64})$/.exec(entry)
    if (!parts) return false
    let dead = false
    if (parts[2] === device) {
      try { process.kill(Number(parts[3]),0); return false }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
        dead = true
      }
    }
    if (!dead) {
      if (!guard || ![parts[4],parts[5]].includes(revision(expected)) || await this.readText('_배분기') !== expected) return false
      const path = this.location(lockDir + '/' + entry)
      const stamp = await this.stat(path)
      const fresh = await this.stat(this.location(clock))
      if (!fresh || !stamp || fresh.mtimeMs - stamp.mtimeMs < staleLockMs) return false
      await this.runGuard(clock,guard)
      if ((await this.stat(path))?.mtimeMs !== stamp.mtimeMs || await this.readText('_배분기') !== expected) return false
    }
    await this.releaseLock(fs,entry)
    return true
  }

  private async locked<T>(expected: string, localOwner: string, action: () => Promise<T>, recover?: () => Promise<void>): Promise<T> {
    const fs = await this.control()
    const nonce = randomUUID()
    const device = revision(hostname() + '\0' + localOwner)
    const entry = [nonce,device,process.pid,revision(expected),revision(localOwner)].join('_')
    const staging = '.work-board-lock-' + nonce
    const held = lockDir + '/' + entry
    await fs.mkdir(staging)
    try {
      await fs.create(staging + '/' + entry,'')
      try { await fs.move(staging,lockDir) }
      catch (error) {
        const existing = await this.stat(this.location(lockDir))
        if (!existing) {
          if (!['EEXIST','ENOTEMPTY',4].includes((error as {code:string|number}).code)) throw error
        } else if (!await this.recoverLock(fs,device,expected,staging + '/' + entry,recover)) throw busy()
        await fs.move(staging,lockDir).catch(async retryError => {
          const code = (retryError as {code:string|number}).code
          if (code === 'EEXIST' || code === 'ENOTEMPTY' || await this.stat(this.location(lockDir))) throw busy()
          throw retryError
        })
      }
    } catch (error) {
      await fs.unlink(staging + '/' + entry).catch(() => {})
      await fs.rmdir(staging).catch(() => {})
      throw error
    }
    const timer = setInterval(() => { void fs.touch(held).catch(() => {}) }, staleLockMs / 4)
    timer.unref()
    try {
      if (await this.readText('_배분기') !== expected) throw ownerChanged()
      return await this.leases.run({path:held,expected},action)
    } finally {
      clearInterval(timer)
      await this.releaseLock(fs,entry)
    }
  }

  withOwner<T>(token:string, action:() => Promise<T>, localDeviceToken = token):Promise<T> {
    if (!token?.trim()) throw ownerChanged()
    return this.locked(token,localDeviceToken,action)
  }

  async takeOwnership(expectedOwner:string, newOwner:string, guard:() => Promise<void>):Promise<void> {
    if (!expectedOwner?.trim() || !newOwner?.trim() || expectedOwner === newOwner) throw ownerChanged()
    await this.locked(expectedOwner,newOwner,async () => {
      await this.runGuard(this.lease!,guard)
      if (await this.readText('_배분기') !== expectedOwner) throw ownerChanged()
      await this.writeText('_배분기',newOwner)
    },guard)
  }

  private async filePath(name: string, createDirectory: boolean): Promise<string> {
    const path = this.path(name)
    if (!(await this.stat(this.root))?.directory) throw new Error('업무지시 폴더가 없습니다.')
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = this.location(parts.slice(0,i).join('/'))
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

  private async currentReceipt(task: BoardTask) {
    if (!task.reportReceipt) return
    const eligible = isBoardReport(task) && !task.editedNeedsRun
    const receipt = eligible ? unreadReportReceipt((await this.read(task.id + '.report.md'))?.text ?? '') : undefined
    if (!receipt) delete task.reportReceipt
    else if (receipt.digest !== task.reportReceipt.digest) task.reportReceipt = receipt
  }

  async readTask(id: string): Promise<BoardTask | null> {
    if (!validId(id)) throw new Error('올바르지 않은 지시 ID입니다.')
    const file = await this.read(id + '.md')
    if (!file || await this.isArchived(id)) return null
    const task = parseTask(id, file.text, new Date(file.mtimeMs).toISOString())
    if (task) await this.currentReceipt(task)
    return task
  }

  async readText(name: string): Promise<string | null> {
    const sidecar = /^([a-zA-Z0-9_-]+)\.(?:report|review)\.md$/.exec(name)
    if (sidecar && await this.isArchived(sidecar[1])) return null
    return (await this.read(name))?.text ?? null
  }

  async writeText(name: string, content: string, exclusive = false): Promise<void> {
    const path = await this.filePath(name, true)
    const activeFile = /^([a-zA-Z0-9_-]+)(?:\.(?:report|review))?\.md$/.exec(name)
    if (activeFile && await this.isArchived(activeFile[1])) throw new Error('이미 보관한 지시 번호입니다.')
    const stat = await this.stat(path)
    if (stat?.directory || Buffer.byteLength(content) > maxBytes) throw new BoardFileError('보드 파일의 종류나 크기를 확인해 주세요.')
    if (this.remote) {
      await (await import('./remoteFs')).rfsWriteText(path, content, exclusive ? null : undefined, false,this.lease ? () => this.assertLease() : undefined)
      return
    }
    const tmp = join(dirname(path), '.board-' + randomUUID() + '.tmp')
    const handle = await open(tmp, 'wx', 0o600)
    try {
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await this.assertLease()
      if (exclusive) await link(tmp, path)
      else await rename(tmp, path)
    } finally { await rm(tmp, {force: true}) }
  }

  async list(forceFresh = false): Promise<BoardTask[]> {
    this.warnings.length = 0
    const entries: {name: string; size?: number; mtimeMs?: number}[] = this.remote
      ? (await (await import('./remoteFs')).rfsList(this.root, {refresh: true, prefetch: false, followSymlinks: false})).filter(e => !e.isDir)
      : (await readdir(this.root, {withFileTypes: true})).filter(e => e.isFile())
    const reportEntries = new Map(entries.filter(entry => entry.name.endsWith('.report.md')).map(entry => [entry.name,entry]))
    const stored = (await this.stat(this.location('_보관')))?.directory
      ? new Set(await (await this.control()).names('_보관')) : new Set<string>()
    const tasks: BoardTask[] = []
    const present = new Set<string>()
    const now = Date.now()
    // Audit the oldest four archives per poll for sync clients that preserve size and mtime.
    const audit = new Set([...this.archived].filter(([, entry]) => now - entry.checkedAt >= 60_000)
      .sort((a, b) => a[1].checkedAt - b[1].checkedAt).slice(0, 4).map(([id]) => id))
    for (const entry of entries) {
      const name = entry.name
      const id = name.endsWith('.md') ? name.slice(0, -3) : ''
      if (!validId(id) || stored.has(id)) continue
      present.add(id)
      const report = reportEntries.get(id + '.report.md')
      const signature = entry.size !== undefined && entry.mtimeMs !== undefined
        ? [entry.size, entry.mtimeMs, report?.size, report?.mtimeMs].join('/') : ''
      const cached = this.archived.get(id)
      if (!forceFresh && signature && cached?.signature === signature && !audit.has(id)) {
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
        await this.currentReceipt(task)
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

  private async isArchived(id: string) {
    if (!(await this.stat(this.location('_보관')))?.directory) return false
    return !!(await this.stat(this.location('_보관/' + id)))
  }

  private async backup(name: string, content: string) {
    const existing = await this.readText(name)
    if (existing === content) return
    if (existing !== null) throw new Error('기존 보관 파일과 내용이 다릅니다. 저장 위치를 확인해 주세요.')
    try { await this.writeText(name,content,true) }
    catch (error) { if (await this.readText(name) !== content) throw error }
  }

  private async sidecars(id: string, expected?: Detail) {
    const result = []
    for (const key of ['report','review'] as const) {
      const name = id + '.' + key + '.md'
      const content = (await this.read(name))?.text ?? null
      if (expected && (content ?? '') !== expected[key]) throw new Error('보고서나 검토서가 변경되었습니다. 다시 확인해 주세요.')
      result.push({name,key,content})
    }
    return result
  }

  private async removeUnchanged(fs: Control, name: string, previous: string) {
    const current = await this.read(name)
    if (!current) return
    if (current.text !== previous) throw new Error('보관 중 파일이 변경되어 원본을 유지했습니다.')
    await this.assertLease()
    await fs.unlink(name).catch(error => { if (!missing(error)) throw error })
  }

  async saveEdit(task: BoardTask, expected: Detail): Promise<void> {
    if (!validId(task.id) || await this.isArchived(task.id)) throw new Error('수정할 지시를 찾을 수 없습니다.')
    const original = await this.read(task.id + '.md')
    if (!original || revision(original.text) !== this.revisions.get(task.id)) throw new Error('지시 파일이 변경되었습니다. 다시 확인해 주세요.')
    const previous = await this.sidecars(task.id,expected)
    const prefix = '_보관/수정-' + revision(JSON.stringify([original.text,expected.report,expected.review]))
    for (const {key,content} of previous) if (content !== null) await this.backup(prefix + '.' + key + '.md',content)
    await this.sidecars(task.id,expected)
    // Only a committed edited instruction can invalidate the live report; all bytes are already backed up.
    await this.save(task)
    const fs = await this.control()
    for (const {name,content} of previous) if (content !== null) await this.removeUnchanged(fs,name,content)
  }

  async archive(id: string, expected?: Detail): Promise<void> {
    if (!validId(id)) throw new Error('올바르지 않은 지시 ID입니다.')
    const name = id + '.md'
    const original = await this.read(name)
    const directory = '_보관/' + id
    const fs = await this.control()
    const stored = await this.isArchived(id)
    const previous = await this.sidecars(id,stored ? undefined : expected)
    if (stored) {
      const saved = await this.read(directory + '/' + name)
      if (!saved || (original && original.text !== saved.text)) throw new Error('같은 지시 번호의 다른 보관 기록이 있습니다.')
      for (const item of previous) {
        if (item.content !== null && (await this.read(directory + '/' + item.name))?.text !== item.content) {
          throw new Error('보관 자료와 현행 보고서가 달라 원본을 유지했습니다.')
        }
      }
    } else {
      if (!original || revision(original.text) !== this.revisions.get(id)) throw new Error('지시 파일이 변경되었습니다. 다시 확인해 주세요.')
      await this.ensureDir(this.location('_보관'))
      const staging = '_보관/.작업-' + randomUUID()
      await fs.mkdir(staging)
      try {
        await fs.create(staging + '/' + name,original.text)
        for (const item of previous) if (item.content !== null) await fs.create(staging + '/' + item.name,item.content)
        if ((await this.read(name))?.text !== original.text) throw new Error('보관 중 지시서가 변경되었습니다.')
        await this.sidecars(id,{report:previous[0].content ?? '',review:previous[1].content ?? ''})
        await this.assertLease()
        // Publishing a nonempty directory commits instruction and evidence together, before any removal.
        await fs.move(staging,directory)
      } catch (error) {
        for (const file of [name,...previous.map(item => item.name)]) await fs.unlink(staging + '/' + file).catch(() => {})
        await fs.rmdir(staging).catch(() => {})
        throw error
      }
    }
    this.revisions.delete(id)
    this.archived.delete(id)
    if (original) await this.removeUnchanged(fs,name,original.text)
    for (const {name:sidecar,content} of previous) if (content !== null) await this.removeUnchanged(fs,sidecar,content)
  }

  async teams(): Promise<BoardTeam[]> {
    const source = await this.readText('teams.yaml')
    if (source === null) return []
    try {
      const data = load(source, {schema: JSON_SCHEMA})
      const rows = data == null ? [] : Array.isArray(data) ? data : record(data).teams ?? []
      if (!Array.isArray(rows)) throw new Error('teams 목록을 확인해 주세요.')
      return validTeams(rows)
    } catch (error) {
      this.warnings.push('teams.yaml · ' + (error instanceof Error ? error.message : String(error)))
      return []
    }
  }

  async saveTeams(input: unknown): Promise<BoardTeam[]> {
    if (!Array.isArray(input)) throw new Error('부서 목록을 확인해 주세요.')
    const rows = validTeams(input)
    await this.writeText('teams.yaml', dump({teams: rows}, {noRefs: true, lineWidth: -1}))
    return rows
  }
}
