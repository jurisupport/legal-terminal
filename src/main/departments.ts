// Office-wide departments. One set lives on the machine that runs them (local or the SSH server),
// next to the specialist files in ~/.claude/agents, at ~/.legal-terminal/departments.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { boardDepartmentTools, descriptionsOverlap } from '../shared/workBoard.ts'
import type { BoardAgent, BoardTeam, BoardTeamVersion, BoardToolLevel } from '../shared/workBoard'

const maxRuleChars = 20_000
const maxHistory = 50
const levels: BoardToolLevel[] = ['allow', 'ask', 'off']

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(what + ' 형식을 확인해 주세요.')
  return value as Record<string, unknown>
}

function optionalText(value: unknown, what: string, max: number): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error(what + '을(를) 확인해 주세요.')
  return value.trim() ? value.replace(/\r\n/g, '\n') : undefined
}

function optionalUsd(value: unknown, what: string): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) throw new Error(what + '은(는) 0보다 큰 달러 금액이어야 합니다.')
  return Math.round(value * 100) / 100
}

/** Validates departments as edited by the lawyer. Rules and the head guide are inline texts here. */
export function validDepartments(rows: unknown[]): BoardTeam[] {
  const names = new Set<string>()
  return rows.map(row => {
    const value = record(row, '부서')
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name || name.length > 40 || names.has(name) || /[\x00-\x1f]/u.test(name)) throw new Error('부서 이름은 1~40자이고 서로 달라야 합니다.')
    names.add(name)
    if (typeof value.color !== 'string' || !/^#[\da-f]{6}$/i.test(value.color)) throw new Error('부서 색상(#RRGGBB)을 확인해 주세요: ' + name)
    if (!Array.isArray(value.agents) || value.agents.some(agent => typeof agent !== 'string' || !agent.trim())) throw new Error('부서원 목록을 확인해 주세요: ' + name)
    const tools: BoardTeam['tools'] = {}
    if (value.tools != null) {
      const given = record(value.tools, '도구 권한')
      for (const [key, level] of Object.entries(given)) {
        const tool = boardDepartmentTools.find(candidate => candidate.key === key)
        if (!tool) throw new Error('알 수 없는 도구입니다: ' + key)
        if (!levels.includes(level as BoardToolLevel)) throw new Error('도구 권한은 allow·ask·off 중 하나입니다: ' + key)
        if (level === 'allow' && !tool.readOnly) throw new Error('결재 없이 허용할 수 있는 도구는 읽기 전용 도구뿐입니다: ' + tool.label)
        if (level !== 'off') tools[tool.key] = level as BoardToolLevel
      }
    }
    const team: BoardTeam = { name, color: value.color.toLowerCase(), agents: [...new Set((value.agents as string[]).map(agent => agent.trim()))] }
    const description = optionalText(value.description, '부서 설명', 300)
    const rules = optionalText(value.rules, '부서 규칙', maxRuleChars)
    const leadGuide = optionalText(value.leadGuide, '부서장 추가 지침', maxRuleChars)
    const warnInstructionUsd = optionalUsd(value.warnInstructionUsd, '지시 1건 경고선')
    const warnMonthlyUsd = optionalUsd(value.warnMonthlyUsd, '월간 경고선')
    return {
      ...team, ...(description && { description: description.trim() }), ...(rules && { rules }), ...(leadGuide && { leadGuide }),
      ...(Object.keys(tools).length && { tools }), ...(warnInstructionUsd && { warnInstructionUsd }), ...(warnMonthlyUsd && { warnMonthlyUsd })
    }
  })
}

/** Department and member descriptions that overlap, so the wrong one may be chosen. */
export function departmentOverlaps(teams: BoardTeam[], agents: BoardAgent[]): string[] {
  const issues: string[] = []
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    if (descriptionsOverlap(teams[i].description ?? '', teams[j].description ?? '')) issues.push(`부서 설명이 겹칩니다: ${teams[i].name} · ${teams[j].name}`)
  }
  for (const team of teams) {
    const members = team.agents.map(name => agents.find(agent => agent.name === name)).filter(agent => !!agent)
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      if (descriptionsOverlap(members[i].description, members[j].description)) issues.push(`${team.name} 부서원 설명이 겹칩니다: ${members[i].name} · ${members[j].name}`)
    }
  }
  return issues
}

/** The departments proposed in the specialist design note (2026-11-25). The lawyer loads them on purpose. */
const proposal: BoardTeam[] = [
  { name: '법률지원', color: '#376ac6', description: '계약 검토, 증거 정리, 사건 요약 보고', agents: ['lawpid-contract-review', 'lawpid-evidence-synthesis', 'lawpid-exec-summary'], tools: { 'korean-law': 'allow' } },
  { name: '콘텐츠', color: '#148369', description: '콘텐츠 기획, 유튜브·SNS·뉴스레터 원고', agents: ['lawpid-content-planner', 'lawpid-youtube-optimizer', 'lawpid-sns-curator', 'lawpid-newsletter'] },
  { name: '마케팅', color: '#c65f16', description: '검색 노출, 홍보, 광고 기획과 소재', agents: ['lawpid-seo', 'lawpid-ai-search', 'lawpid-pr', 'lawpid-search-ads', 'lawpid-ad-creative', 'lawpid-social-ads'] },
  { name: '영업', color: '#8c44bb', description: '제안서 작성, 잠재 의뢰인 발굴', agents: ['lawpid-proposal', 'lawpid-lead-gen'] },
  { name: '플랫폼운영', color: '#168097', description: '로피들리 플랫폼 운영 관리', agents: ['lawpid-ly-manager'] }
]

/** Loads the proposal, leaving out members whose specialist file is not installed on the running machine. */
export function suggestedDepartments(agents: BoardAgent[]): { teams: BoardTeam[]; missing: string[] } {
  const installed = new Set(agents.map(agent => agent.name))
  const missing = proposal.flatMap(team => team.agents).filter(name => !installed.has(name))
  return { teams: proposal.map(team => ({ ...structuredClone(team), agents: team.agents.filter(name => installed.has(name)) })), missing }
}

/** Departments kept per board before v0.1.358 named a specialist as head; the app's own head replaces it. */
export function fromLegacyTeams(rows: { name: string; color: string; agents: string[] }[]): BoardTeam[] {
  return rows.map(({ name, color, agents }) => ({ name, color, agents: [...agents] }))
}

function seoulMonth(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(at).slice(0, 7)
}

function fileStem(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]/gu, '_').trim() || 'department'
}

interface Files {
  read(name: string): Promise<string | null>
  write(name: string, text: string): Promise<void>
}

function localFiles(root: string): Files {
  return {
    async read(name) {
      try {
        const info = await stat(join(root, name))
        if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('부서 파일의 종류나 크기를 확인해 주세요: ' + name)
        return await readFile(join(root, name), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(name, text) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = join(dirname(path), '.department-' + randomUUID() + '.tmp')
      const handle = await open(tmp, 'wx', 0o600)
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      await rename(tmp, path)
    }
  }
}

async function remoteFiles(root: string): Promise<Files> {
  const fs = await import('./remoteFs')
  const { profileId, path } = fs.parseRemote(root)
  const ensure = async (directory: string) => {
    const parts = directory.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const current = '/' + parts.slice(0, i).join('/')
      const info = await fs.rfsBoardStat(fs.makeRemote(profileId, current))
      if (info?.directory) continue
      if (info) throw new Error('부서 폴더 경로가 폴더가 아닙니다: ' + current)
      await fs.rfsMkdir(fs.makeRemote(profileId, '/' + parts.slice(0, i - 1).join('/')), parts[i - 1]).catch(async error => {
        if (!(await fs.rfsBoardStat(fs.makeRemote(profileId, current)))?.directory) throw error
      })
    }
  }
  return {
    async read(name) {
      const uri = fs.makeRemote(profileId, path + '/' + name)
      const info = await fs.rfsBoardStat(uri)
      if (!info) return null
      if (info.directory || info.size > 4 * 1024 * 1024) throw new Error('부서 파일의 종류나 크기를 확인해 주세요: ' + name)
      return fs.rfsReadBoardText(uri)
    },
    async write(name, text) {
      const full = path + '/' + name
      await ensure(full.slice(0, full.lastIndexOf('/')))
      await fs.rfsWriteText(fs.makeRemote(profileId, full), text, undefined, false)
    }
  }
}

const queues = new Map<string, Promise<unknown>>()

/** The office departments on the machine that runs the given workspace's agents. */
export class Departments {
  private constructor(readonly home: string, private readonly files: Files) {}

  static async forWorkspace(workspace: string): Promise<Departments> {
    if (workspace.startsWith('ssh://')) {
      const fs = await import('./remoteFs')
      const { profileId } = fs.parseRemote(workspace)
      const home = fs.makeRemote(profileId, (await fs.rfsRemoteHome(workspace)).replace(/\/+$/, '') + '/.legal-terminal/departments')
      return new Departments(home, await remoteFiles(home))
    }
    const home = process.env.LEGAL_TERMINAL_DEPARTMENTS_DIR || join(homedir(), '.legal-terminal', 'departments')
    return new Departments(home, localFiles(home))
  }

  // Several case boards on one machine share these files.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.home) ?? Promise.resolve()).then(work)
    queues.set(this.home, result.catch(() => {}))
    return result
  }

  async teams(warnings: string[] = []): Promise<BoardTeam[]> {
    const source = await this.files.read('teams.yaml')
    if (source === null) return []
    try {
      const data = load(source, { schema: JSON_SCHEMA })
      const rows = data == null ? [] : record(data, 'teams.yaml').teams ?? []
      if (!Array.isArray(rows)) throw new Error('teams 목록을 확인해 주세요.')
      const teams: unknown[] = []
      for (const row of rows) {
        const value = { ...record(row, '부서') }
        for (const [field, key] of [['rules', 'rules'], ['lead_guide', 'leadGuide']] as const) {
          const path = value[field]
          delete value[field]
          if (path == null) continue
          if (typeof path !== 'string' || !/^rules\/[^/\\]+\.md$/u.test(path)) throw new Error('규칙 파일은 rules/ 폴더의 .md 파일이어야 합니다: ' + String(path))
          const text = await this.files.read(path)
          if (text === null) warnings.push('부서 규칙 파일이 없습니다: ' + path)
          else value[key] = text
        }
        if (value.warn_instruction_usd != null) value.warnInstructionUsd = value.warn_instruction_usd
        if (value.warn_monthly_usd != null) value.warnMonthlyUsd = value.warn_monthly_usd
        delete value.warn_instruction_usd
        delete value.warn_monthly_usd
        delete value.lead
        teams.push(value)
      }
      return validDepartments(teams)
    } catch (error) {
      warnings.push('부서 설정 · ' + (error instanceof Error ? error.message : String(error)))
      return []
    }
  }

  async history(): Promise<BoardTeamVersion[]> {
    const source = await this.files.read('history/index.json')
    if (source === null) return []
    try {
      const rows = JSON.parse(source)
      return Array.isArray(rows) ? rows.filter(row => typeof row?.id === 'string' && typeof row.at === 'string' && typeof row.teams === 'number') : []
    } catch { return [] }
  }

  /** Saves the departments and keeps the previous version so it can be restored. */
  save(input: unknown): Promise<BoardTeam[]> {
    if (!Array.isArray(input)) return Promise.reject(new Error('부서 목록을 확인해 주세요.'))
    const teams = validDepartments(input)
    return this.serial(async () => {
      const previous = await this.teams()
      const source = await this.files.read('teams.yaml')
      if (source !== null) {
        const at = new Date().toISOString()
        const id = at.replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8)
        await this.files.write('history/' + id + '.json', JSON.stringify({ at, teams: previous }, null, 2))
        const history = [{ id, at, teams: previous.length }, ...await this.history()].slice(0, maxHistory)
        await this.files.write('history/index.json', JSON.stringify(history, null, 2))
      }
      const rows = []
      for (const team of teams) {
        const stem = fileStem(team.name)
        const row: Record<string, unknown> = { name: team.name, color: team.color }
        if (team.description) row.description = team.description
        if (team.rules) {
          row.rules = 'rules/' + stem + '.md'
          await this.files.write(row.rules as string, team.rules)
        }
        if (team.leadGuide) {
          row.lead_guide = 'rules/' + stem + '-부서장.md'
          await this.files.write(row.lead_guide as string, team.leadGuide)
        }
        if (team.tools) row.tools = team.tools
        if (team.warnInstructionUsd) row.warn_instruction_usd = team.warnInstructionUsd
        if (team.warnMonthlyUsd) row.warn_monthly_usd = team.warnMonthlyUsd
        row.agents = team.agents
        rows.push(row)
      }
      await this.files.write('teams.yaml', dump({ teams: rows }, { noRefs: true, lineWidth: -1 }))
      return teams
    })
  }

  async restore(id: string): Promise<BoardTeam[]> {
    if (!/^[\dTZ]+-[a-f\d]{8}$/.test(id)) throw new Error('되돌릴 판을 확인해 주세요.')
    const source = await this.files.read('history/' + id + '.json')
    if (source === null) throw new Error('보관된 판을 찾을 수 없습니다.')
    const { teams } = record(JSON.parse(source), '보관된 판')
    return this.save(teams)
  }

  async usage(month = seoulMonth()): Promise<Record<string, number>> {
    const source = await this.files.read('usage/' + month + '.json')
    if (source === null) return {}
    try {
      const data = record(JSON.parse(source), '사용량')
      return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) as Record<string, number>
    } catch { return {} }
  }

  /** Adds spend to the department's month and returns the new month total. */
  addUsage(team: string, usd: number, at = new Date()): Promise<number> {
    if (!(usd > 0) || !Number.isFinite(usd)) return this.usage(seoulMonth(at)).then(rows => rows[team] ?? 0)
    return this.serial(async () => {
      const month = seoulMonth(at)
      const rows = await this.usage(month)
      rows[team] = Math.round(((rows[team] ?? 0) + usd) * 10_000) / 10_000
      await this.files.write('usage/' + month + '.json', JSON.stringify(rows, null, 2))
      return rows[team]
    })
  }
}
