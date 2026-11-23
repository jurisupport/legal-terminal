import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BoardAgent, BoardDecision, BoardDraft, BoardSettings, BoardSnapshot, BoardTask, BoardTeam } from '../shared/workBoard'
import { boardRevision } from '../shared/workBoard'
import { kstDateKey } from '../shared/todoSummary'
import { WorkBoardStore } from './workBoardStore'
import { runBoardAgent, listBoardAgents } from './workBoardRunner'
import { buildBoardDaily, boardReportDue } from './workBoardDaily'

const defaults: BoardSettings = { concurrency: 1, restart: 'requeue', maxReviews: 2, dailyTime: '18:00' }

function settings(patch: Partial<BoardSettings>): BoardSettings {
  const s = { ...defaults, ...patch }
  if (!Number.isInteger(s.concurrency) || s.concurrency < 1 || s.concurrency > 8 ||
    !Number.isInteger(s.maxReviews) || s.maxReviews < 0 || s.maxReviews > 20 ||
    !['requeue', 'resume'].includes(s.restart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyTime))
    throw new Error('동시 실행 수(1~8), 검토 재작업 횟수(0~20), 재시작 방식과 보고 시각을 확인해 주세요.')
  return { concurrency: s.concurrency, restart: s.restart, maxReviews: s.maxReviews, dailyTime: s.dailyTime }
}

function draft(input: BoardDraft): BoardDraft {
  function optional(value: unknown) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error('지시 입력 형식을 확인해 주세요.')
    return value.trim() || undefined
  }
  function strings(value: unknown) {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error('목록 형식을 확인해 주세요.')
    return [...new Set(value.map(v => v.trim()))]
  }
  const title = optional(input.title), body = optional(input.body), due = optional(input.due)
  if (!title || !body) throw new Error('지시 제목과 본문을 입력해 주세요.')
  if (due && (due.length !== 10 || due !== kstDateKey(due))) throw new Error('기한 형식을 확인해 주세요.')
  if (input.approval !== undefined && !['required', 'none'].includes(input.approval)) throw new Error('결재 방식을 확인해 주세요.')
  return {
    title, body, due, approval: input.approval ?? 'required', agent: optional(input.agent),
    review_agent: optional(input.review_agent), after_approval: optional(input.after_approval),
    allowed_tools: strings(input.allowed_tools), depends_on: strings(input.depends_on)
  }
}

async function privateText(file: string) {
  try { return await readFile(file, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

async function replace(file: string, text: string) {
  const tmp = file + '.' + randomUUID()
  await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
  await rename(tmp, file)
}

function append(task: BoardTask, text: string) {
  task.updatedAt = new Date().toISOString()
  task.log.push({ at: task.updatedAt, text })
}

export class WorkBoard {
  private readonly store: WorkBoardStore
  private readonly privatePath: string
  private prefs = defaults
  private agents: BoardAgent[] = []
  private teams: BoardTeam[] = []
  private tasks: BoardTask[] = []
  private owner = ''
  private writable = false
  private warnings = ''
  private lastDaily: string | null = null
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private tail: Promise<unknown> = Promise.resolve()
  private active = new Map<string, AbortController>()
  private ticking = false

  constructor(private readonly workspace: string, readonly folder: string, privateDir: string,
    private readonly changed: (message?: string) => void) {
    this.store = new WorkBoardStore(folder)
    this.privatePath = join(privateDir, createHash('sha256').update(JSON.stringify([workspace, folder])).digest('hex'))
  }

  // Serialize file mutations; provider sessions themselves run outside this queue.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => { })
    return result
  }

  async start() {
    await mkdir(this.privatePath, { recursive: true, mode: 0o700 })
    const ownerFile = join(this.privatePath, 'owner')
    this.owner = randomUUID()
    try { await writeFile(ownerFile, this.owner, { flag: 'wx', mode: 0o600 }) }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      this.owner = await readFile(ownerFile, 'utf8')
    }
    if (!/^[\da-f-]{36}$/i.test(this.owner)) throw new Error('업무 보드의 기기 식별 파일을 확인해 주세요.')
    const config = await privateText(join(this.privatePath, 'settings.json'))
    this.prefs = settings(config ? JSON.parse(config) : {})
    this.lastDaily = await privateText(join(this.privatePath, 'daily-date')) ?? null
    await this.store.init()
    await this.refresh()
    if (this.writable) {
      for (const task of this.tasks.filter(t => t.status === 'running' || t.status === 'in_review')) {
        if (task.parentId) {
          await this.transition(task, 'blocked', '앱 종료 전 실행 결과를 확인해 주세요. 승인 후 실행은 자동 반복하지 않습니다.')
        } else {
          const wasReview = task.status === 'in_review'
          if (this.prefs.restart !== 'resume') delete task.sessionId
          await this.transition(task, wasReview ? 'reported' : 'queued', task.sessionId ? '저장된 세션에서 재개' : '앱 재시작 후 재배분')
        }
      }
    }
    if (this.closed) return
    this.timer = setInterval(() => this.tick(true), 30_000)
    this.timer.unref()
    this.tick()
  }

  stop() {
    this.closed = true
    clearInterval(this.timer)
    for (const controller of this.active.values()) controller.abort()
  }

  private async refresh() {
    const wasWritable = this.writable
    this.writable = await this.store.claimOwner(this.owner)
    if (wasWritable && !this.writable) for (const controller of this.active.values()) controller.abort()
    const tasks = await this.store.list()
    const teams = await this.store.teams()
    const agents = await listBoardAgents()
    const warnings = this.store.warnings.join('\n')
    if (warnings !== this.warnings) {
      this.warnings = warnings
      if (warnings) this.changed(warnings)
    }
    if (wasWritable !== this.writable || JSON.stringify([tasks, teams, agents]) !== JSON.stringify([this.tasks, this.teams, this.agents])) {
      this.tasks = tasks
      this.teams = teams
      this.agents = agents
      this.changed()
    }
  }

  async snapshot(): Promise<BoardSnapshot> {
    await this.tail
    return {
      workspace: this.workspace, tasks: structuredClone(this.tasks), settings: { ...this.prefs }, agents: this.agents,
      teams: this.teams, folder: this.folder, warnings: [...this.store.warnings], readOnly: !this.writable
    }
  }

  approvalCount() { return this.tasks.filter(t => t.status === 'awaiting_approval').length }

  private find(id: string) {
    const t = this.tasks.find(t => t.id === id)
    if (!t) throw new Error('지시를 찾을 수 없습니다.')
    return t
  }

  private async save(task: BoardTask) {
    await this.store.save(task)
    this.tasks = [...this.tasks.filter(t => t.id !== task.id), task].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    this.changed()
  }

  private async transition(previous: BoardTask, status: BoardTask['status'], text: string) {
    const task = structuredClone(previous)
    task.status = status
    append(task, text)
    await this.save(task)
  }

  private newTask(input: BoardDraft): BoardTask {
    const now = new Date().toISOString()
    return {
      ...draft(input), id: kstDateKey(now)!.replaceAll('-', '') + '-' + randomUUID(), cwd: this.writable ? this.workspace : '.',
      status: 'queued', order: this.tasks.reduce((n, t) => Math.max(n, t.order), 0) + 1, createdAt: now, updatedAt: now,
      attempts: 0, log: [{ at: now, text: '지시 등록' }]
    }
  }

  async add(inputs: BoardDraft[], batchId?: string) {
    await this.serial(async () => {
      if (!Array.isArray(inputs) || !inputs.length) throw new Error('한 건 이상 입력해 주세요.')
      if (batchId !== undefined && (typeof batchId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(batchId)))
        throw new Error('일괄 지시 번호를 확인해 주세요.')
      const validated = inputs.map(draft)
      for (const input of validated) for (const dependency of input.depends_on ?? []) this.find(dependency)
      for (const [index, input] of validated.entries()) {
        const task = this.newTask(input)
        if (batchId) {
          task.id = 'batch-' + createHash('sha256').update(JSON.stringify([batchId, index, input])).digest('hex')
          if (this.tasks.some(t => t.id === task.id)) continue
        }
        await this.save(task)
      }
    })
    this.tick()
  }

  private async ownerOnly() {
    this.writable = await this.store.claimOwner(this.owner)
    if (!this.writable) throw new Error('이 보드를 배분하는 기기에서 변경해 주세요.')
  }

  async configure(patch: Partial<BoardSettings>) {
    await this.serial(async () => {
      await this.ownerOnly()
      const next = settings({ ...this.prefs, ...patch })
      await replace(join(this.privatePath, 'settings.json'), JSON.stringify(next, null, 2))
      this.prefs = next
      this.changed()
    })
    this.tick()
  }

  async reorder(ids: string[]) {
    await this.serial(async () => {
      await this.ownerOnly()
      const queue = this.tasks.filter(t => t.status === 'queued')
      if (ids.length !== queue.length || new Set(ids).size !== ids.length || ids.some(id => !queue.some(t => t.id === id)))
        throw new Error('대기 목록이 바뀌었습니다. 다시 정렬해 주세요.')
      for (const [index, id] of ids.entries()) await this.save({ ...this.find(id), order: index + 1 })
    })
    this.tick()
  }

  async detail(id: string) {
    this.find(id)
    return { report: (await this.store.readText(id + '.report.md')) ?? '', review: (await this.store.readText(id + '.review.md')) ?? '' }
  }

  private grantFile(parent: string) {
    return join(this.privatePath, 'approval-' + createHash('sha256').update(parent).digest('hex') + '.json')
  }

  async decide(id: string, action: BoardDecision, reason = '', expectedRevision?: string) {
    await this.serial(async () => {
      await this.ownerOnly()
      const task = structuredClone(this.find(id))
      if (task.parentId && ['blocked', 'failed'].includes(task.status) && (action === 'complete' || action === 'reject')) {
        if (!reason.trim()) throw new Error('외부 실행 결과를 확인하고 근거를 입력해 주세요.')
        const parent = this.find(task.parentId)
        if (!['approved', 'blocked'].includes(parent.status)) throw new Error('상위 지시의 결재 상태를 확인해 주세요.')
        await this.transition(task, action === 'complete' ? 'done' : 'rejected', '사용자 확인 · ' + reason.trim())
        await this.settleChild(parent, this.find(id))
        return
      }
      if (action === 'submit') {
        if (task.parentId || task.status !== 'blocked' || !(await this.detail(id)).report.trim())
          throw new Error('보고서가 있는 일반 확인 대기 지시만 결재 요청할 수 있습니다.')
        task.approval = 'required'
        delete task.sessionId
        await this.transition(task, 'reported', '저장된 보고서로 검토·결재 요청')
        return
      }
      if (action === 'retry') {
        if (this.tasks.some(t => t.parentId === id && ['failed', 'blocked'].includes(t.status)))
          throw new Error('승인 후 실행 지시에서 외부 실행 여부를 먼저 확인해 주세요.')
        if (!['failed', 'blocked', 'rejected'].includes(task.status) || task.parentId) throw new Error('이 지시는 재실행할 수 없습니다.')
        if (reason.trim()) task.body += '\n\n추가 지시\n' + reason.trim()
        delete task.sessionId
        await this.transition(task, 'queued', '재시도 요청' + (reason.trim() ? ' · ' + reason.trim() : ''))
        return
      }
      if (task.status !== 'awaiting_approval') throw new Error('결재 대기 상태에서 처리할 수 있습니다.')
      if (action === 'reject' || action === 'revise') {
        if (!reason.trim()) throw new Error('사유를 입력해 주세요.')
        if (action === 'revise') {
          const next = this.newTask({ ...task, body: task.body + '\n\n수정 지시\n' + reason.trim() })
          next.id = 'rev-' + createHash('sha256').update(task.id + task.updatedAt).digest('hex')
          if (!this.tasks.some(t => t.id === next.id)) await this.save(next)
        }
        await this.transition(task, 'rejected', (action === 'revise' ? '수정 지시 등록 · ' : '반려 · ') + reason.trim())
      } else if (action === 'approve') {
        if (expectedRevision !== boardRevision(task, await this.detail(task.id))) throw new Error('현재 지시 내용과 승인 후 실행 단계를 다시 확인해 주세요.')
        if (task.after_approval?.trim()) {
          const child = this.newTask({
            title: '승인 후 실행 · ' + task.title, body: task.after_approval,
            agent: task.agent, approval: 'none', allowed_tools: task.allowed_tools
          })
          child.parentId = task.id
          // Only the local approver can issue a grant. The runner later consumes it exactly once.
          const file = this.grantFile(task.id)
          await replace(file + '.pending', JSON.stringify(child))
          await this.transition(task, 'approved', '승인')
          await rename(file + '.pending', file)
          return
        }
        await this.transition(task, 'approved', '승인')
      } else throw new Error('결재 동작을 확인해 주세요.')
    })
    this.tick()
  }

  private async writeDaily(scheduled: boolean) {
    const { date, markdown, html } = buildBoardDaily(this.tasks)
    await this.store.writeText('_일일보고/' + date + '.md', markdown)
    await this.store.writeText('_일일보고/' + date + '.html', html)
    if (scheduled) {
      await replace(join(this.privatePath, 'daily-date'), date)
      this.lastDaily = date
    }
    return markdown
  }

  daily() {
    return this.serial(async () => {
      if (!this.writable) return buildBoardDaily(this.tasks).markdown
      return this.writeDaily(false)
    })
  }

  private tick(refresh = false) {
    if (this.closed || this.ticking) return
    this.ticking = true
    void this.serial(async () => {
      if (refresh) await this.refresh()
      if (!this.writable || this.closed) return
      for (const task of this.tasks.filter(t => t.status === 'approved' || (t.status === 'blocked' && t.after_approval))) await this.followApproval(task)
      for (const task of this.tasks.filter(t => t.status === 'reported' && !t.review_agent)) await this.finishReport(task)
      for (const task of this.tasks) {
        if (this.closed || this.active.size >= this.prefs.concurrency) break
        if (this.active.has(task.id)) continue
        if (task.status === 'reported' && task.review_agent) await this.launch(task, 'review')
        if (task.status === 'queued' && (task.depends_on ?? []).every(id => this.tasks.some(t => t.id === id && t.status === 'done')))
          await this.launch(task, task.parentId ? 'execute' : 'work')
      }
      if (boardReportDue(this.prefs.dailyTime, this.lastDaily)) await this.writeDaily(true)
    }).catch(err => this.changed('업무 보드 · ' + String(err))).finally(() => { this.ticking = false })
  }

  private async followApproval(task: BoardTask) {
    if (!task.after_approval) { await this.transition(task, 'done', '결재 완료'); return }
    const file = this.grantFile(task.id)
    const grant = await privateText(file) ?? await privateText(file + '.used')
    if (!grant) {
      if (task.status === 'approved') await this.transition(task, 'blocked', '이 기기의 결재 이력이 없습니다.')
      return
    }
    const child: BoardTask = JSON.parse(grant)
    const current = this.tasks.find(t => t.id === child.id)
    if (!current && task.status === 'approved') await this.save(child)
    else if (current) await this.settleChild(task, current)
  }

  private async settleChild(task: BoardTask, child: BoardTask) {
    if (child.status === 'done') await this.transition(task, 'done', '승인 후 실행 완료')
    else if (child.status === 'rejected') await this.transition(task, 'awaiting_approval', '승인 후 실행 미수행 확인 · 새 결재 요청')
    else if (task.status === 'approved' && (child.status === 'failed' || child.status === 'blocked'))
      await this.transition(task, 'blocked', '승인 후 실행 결과 확인 필요')
  }

  private async finishReport(task: BoardTask) {
    const needsApproval = task.approval !== 'none' || !!task.after_approval
    await this.transition(task, needsApproval ? 'awaiting_approval' : 'done', needsApproval ? '결재 요청' : '업무 완료')
  }

  private async launch(task: BoardTask, phase: 'execute' | 'work' | 'review') {
    // A viewer may enqueue from a differently mounted copy of the same board.
    if (task.cwd === '.' || (this.workspace.startsWith('ssh://') && task.cwd === this.workspace.replace(/^ssh:\/\/[^/]+/, ''))) {
      task = { ...task, cwd: this.workspace }
    }
    if (task.cwd !== this.workspace) {
      await this.transition(task, 'blocked', '지시의 작업 폴더가 이 보드의 작업 폴더와 다릅니다.')
      return
    }
    let approvedTools: string[] = []
    let prompt = task.body
    if (phase === 'execute') {
      const parent = this.tasks.find(t => t.id === task.parentId && t.status === 'approved')
      const file = this.grantFile(task.parentId!)
      const raw = parent && await privateText(file)
      const sealed: BoardTask | undefined = raw ? JSON.parse(raw) : undefined
      if (!sealed || sealed.id !== task.id || sealed.body !== task.body || sealed.agent !== task.agent ||
        sealed.cwd !== task.cwd || JSON.stringify(sealed.allowed_tools) !== JSON.stringify(task.allowed_tools)) {
        await this.transition(task, 'blocked', '유효한 일회성 결재가 없습니다. 승인 후 실행 내용을 확인해 주세요.')
        return
      }
      // Claim before starting the provider. Crashes leave the externally visible outcome uncertain.
      await rename(file, file + '.used')
      task = sealed
      approvedTools = sealed.allowed_tools ?? []
      prompt = sealed.body
    } else if (phase === 'review') {
      prompt += '\n\n보고서와 산출물을 점검해 주세요.\n' + (await this.detail(task.id)).report
    } else {
      prompt += '\n\n아래 양식으로 최종 보고서를 작성해 주세요.\n' + (await this.store.readText('_보고서양식.md') ?? '')
      if (task.after_approval) prompt += '\n\n다음 단계는 별도 결재 후 수행합니다. 현재는 준비 상황만 보고하세요.\n' + task.after_approval
      if (task.attempts) prompt += '\n\n앞선 검토의 반려 사유\n' + (await this.detail(task.id)).review
    }
    const controller = new AbortController()
    await this.transition(task, phase === 'review' ? 'in_review' : 'running',
      (phase === 'review' ? '검토 시작 · ' + task.review_agent : '수행 시작 · ' + (task.agent || '기본 에이전트')))
    if (this.closed) return
    this.active.set(task.id, controller)
    const onProgress = (message: string, sessionId?: string) => {
      if (controller.signal.aborted) return
      void this.serial(async () => {
        if (this.active.get(task.id) !== controller || controller.signal.aborted) return
        const current = structuredClone(this.find(task.id))
        if (sessionId) current.sessionId = sessionId
        if (message) append(current, message.slice(0, 1200))
        await this.save(current)
      }).catch(err => this.changed('진행 기록 저장 오류 · ' + String(err)))
    }
    void (async () => {
      try {
        const result = await runBoardAgent({
          task, phase, prompt, approvedTools, resume: phase === 'execute' ? undefined : task.sessionId,
          signal: controller.signal, onProgress, policyDir: this.privatePath
        })
        await this.serial(async () => {
          if (controller.signal.aborted) return
          const current = structuredClone(this.find(task.id))
          if (current.status !== (phase === 'review' ? 'in_review' : 'running')) return
          if (JSON.stringify(draft(current)) !== JSON.stringify(draft(task)) || current.cwd !== task.cwd || current.parentId !== task.parentId) {
            await this.transition(current, 'blocked', '수행 중 지시서가 변경되었습니다. 결과를 확인해 주세요.')
            return
          }
          delete current.sessionId
          await this.store.writeText(task.id + (phase === 'review' ? '.review.md' : '.report.md'), result.text)
          if (result.blocked) {
            await this.transition(current, 'blocked', '권한 확인 또는 추가 답변 필요')
            this.changed('확인 필요 · ' + current.title)
          } else if (phase === 'review' && result.rejected) {
            current.attempts++
            await this.transition(current, current.attempts <= this.prefs.maxReviews ? 'queued' : 'failed',
              current.attempts <= this.prefs.maxReviews ? '검토 반려 · 사유를 첨부해 재배분' : '검토 반려 · 재배분 상한 도달')
          } else if (phase === 'review') await this.finishReport(current)
          else await this.transition(current, phase === 'execute' ? 'done' : 'reported', '보고서 저장')
        })
      } catch (err) {
        if (!controller.signal.aborted) await this.serial(async () => {
          const text = err instanceof Error ? err.message : String(err)
          await this.transition(this.find(task.id), phase === 'execute' ? 'blocked' : 'failed', text)
          this.changed('업무 확인 필요 · ' + task.title)
        })
      } finally {
        this.active.delete(task.id)
        this.tick()
      }
    })().catch(err => this.changed('업무 보드 저장 오류 · ' + String(err)))
  }
}
