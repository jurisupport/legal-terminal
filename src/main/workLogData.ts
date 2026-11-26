// 날짜별 작업일지 순수 로직: 트랜스크립트를 메시지 타임스탬프 기준으로 날짜별로 쪼갠다.
// 세션 인덱스(마지막 활동 시각)와 달리, 한 세션을 여러 날 썼으면 각 날짜에 모두 나타난다.
// electron 의존이 없어 scripts/verify-case-activity.mjs에서 직접 검증한다.

import type { CaseActivityMetaLike } from './caseActivityData'

// caseActivityData의 pathLeaf/cleanTitle과 동일 — 값 import를 피해 verify 스크립트(strip-types)에서
// 이 모듈만 단독 로드할 수 있게 지역 사본을 둔다.
function pathLeaf(path?: string): string | undefined {
  if (!path) return undefined
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean
}

function cleanTitle(title?: string): string | undefined {
  if (!title) return undefined
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>|<system-reminder>/.test(title))
    return undefined
  return title
}

export interface WorkLogFile {
  path: string
  kind: 'write' | 'edit' // Write = 새로 쓰거나 덮어씀, Edit·MultiEdit·NotebookEdit = 수정
}

export interface DayActivity {
  date: string // YYYY-MM-DD (로컬 기준)
  count: number // 그날 사용자 지시 수
  firstText?: string // 그날 첫 지시 (정리본, 200자)
  firstTs?: number // 그날 첫 지시 시각 (ms)
  lastTs: number // 그날 마지막 지시 시각 (ms)
  files?: WorkLogFile[] // 그날 파일 쓰기·수정 도구로 바꾼 파일
}

// 세션 기록의 마지막 상태: 정상 응답으로 끝남 / 사용자가 중지 / 오류 / 턴이 끝나지 않음(진행 중이거나 끊김)
export interface SessionEnd {
  state: 'done' | 'interrupted' | 'error' | 'open'
  ts: number
}

export interface SessionDayScan {
  sessionId: string
  cwd?: string
  days: DayActivity[]
  end?: SessionEnd
}

export interface WorkLogScanSource {
  sourceKey: string // 'local' | 'ssh:user@host:port' — 세션 인덱스 sourceKey와 동일 규칙
  profileId?: string
  sshLabel?: string
  sessions: SessionDayScan[]
}

export type WorkLogStatus = 'done' | 'unfinished' | 'pending' | 'running' | 'continued'

export interface WorkLogBoardChild {
  cardId: string
  who: string
  title: string
  status: WorkLogStatus
  costUsd?: number
}

export interface WorkLogBoard {
  workspace: string // 업무 보드 작업 폴더(보드 키)
  cardId: string
  children: WorkLogBoardChild[]
}

export interface WorkLogItem {
  originDevice?: 'android' | 'desktop'
  sessionId: string
  cwd?: string
  profileId?: string
  sshLabel?: string
  caseNumber?: string
  caseName?: string
  folderName?: string
  title?: string
  workSummary?: string
  count: number // 그날 지시 수 (인덱스 폴백 행은 0)
  firstText?: string
  firstTs?: number
  lastTs: number
  who?: string // 일반 대화 / 업무 보드 · … / 정기 업무 · …
  departments?: string[]
  files?: WorkLogFile[]
  status?: WorkLogStatus
  statusReason?: string
  costUsd?: number
  board?: WorkLogBoard
}

// 업무 보드 카드 중 작업일지에 필요한 부분. 앱이 연 보드에서 모은다.
export interface WorkLogBoardCard {
  id: string
  rootId: string // 원 지시(비서실장·부서·승인 후 실행으로 이어진 카드 묶음의 맨 위)
  workspace: string
  title: string
  body: string
  status: string
  team?: string
  agent?: string
  chief?: boolean
  routine?: boolean
  delegatedBy?: string
  routedBy?: string
  parentId?: string
  delegatorTeam?: string // delegatedBy 카드의 부서
  cost?: number
  sessions: string[]
  createdAt: string
  report?: string // 원 지시 카드의 보고서 앞부분
}

export interface WorkLogDay {
  date: string
  epoch: number // 그날 00:00 로컬 (렌더러 라벨용)
  items: WorkLogItem[]
}

export function dateKeyLocal(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function epochOfDateKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

// 실제 작업 지시가 아닌 조회·유지관리성 슬래시 명령 — 일지에서 제외
const NOISE_COMMANDS = new Set([
  '/usage',
  '/context',
  '/cost',
  '/compact',
  '/clear',
  '/exit',
  '/login',
  '/logout',
  '/model',
  '/status',
  '/help',
  '/doctor',
  '/resume'
])

// 임시 폴더 세션(제목·요약 자동생성 등 앱 내부 호출) — 작업일지에서 제외
export function isEphemeralCwd(cwd?: string): boolean {
  if (!cwd) return false
  // Windows 임시 폴더는 끝에 구분자 없이 기록된다(C:\Users\…\AppData\Local\Temp).
  return /^\/(private\/)?(var\/folders|tmp)(\/|$)/.test(cwd) || /[\\/]Temp([\\/]|$)/i.test(cwd)
}

// 내부 태그·명령 래퍼를 걷어낸 사용자 지시 텍스트. 지시가 아니면 undefined.
export function cleanUserInstruction(raw: string, preserveFormatting = false): string | undefined {
  const command = /<command-name>\s*([^<\n]+?)\s*<\/command-name>/.exec(raw)
  if (command) {
    if (NOISE_COMMANDS.has(command[1].trim().toLowerCase())) return undefined
    const args = /<command-args>\s*([^<\n]*?)\s*<\/command-args>/.exec(raw)?.[1]
    return [command[1], args].filter(Boolean).join(' ')
  }
  if (NOISE_COMMANDS.has(raw.trim().toLowerCase())) return undefined
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>/.test(raw)) return undefined
  if (/원본 대화 transcript입니다/.test(raw)) return undefined
  if (/^\[Request interrupted/.test(raw.trim())) return undefined
  let visible = /<legal-terminal-user-request>\s*([\s\S]*?)\s*<\/legal-terminal-user-request>/i.exec(raw)?.[1] ?? raw
  visible = visible.replace(
    /^사용자가 진행 중인 작업을 중단하고 방향 전환을 요청했습니다\. 아래 지시를 최우선으로 반영하세요\.\s*/,
    ''
  )
  if (/진행하던 대화 transcript입니다/.test(visible)) {
    const marker = '지금 처리할 사용자 지시:'
    const markerAt = visible.lastIndexOf(marker)
    if (markerAt >= 0) visible = visible.slice(markerAt + marker.length)
  }
  if (/다음은 사용자가 인용한 이전 에이전트 답변입니다/.test(visible)) {
    const marker = '</quoted-agent-response>'
    const markerAt = visible.lastIndexOf(marker)
    if (markerAt >= 0) visible = visible.slice(markerAt + marker.length)
  }
  const text = visible
    .replace(/(?:^|(?:\r?\n){2,})\[legal-terminal attachments\][\s\S]*$/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ')
    .trim()
  return (preserveFormatting ? text : text.replace(/\s+/g, ' ').trim()) || undefined
}

function entryUserText(d: Record<string, unknown>): string | undefined {
  const m = d.message as { content?: unknown } | undefined
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .filter((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'text')
      .map((x) => (x as { text?: string }).text ?? '')
      .join(' ')
  return undefined
}

const FILE_TOOLS: Record<string, WorkLogFile['kind']> = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' }
const FILE_TOOL_LINE = /"name":"(?:Write|Edit|MultiEdit|NotebookEdit)"/
const MAX_DAY_FILES = 30

function addFile(day: DayActivity, file: WorkLogFile): void {
  const files = (day.files ??= [])
  const known = files.find((f) => f.path === file.path)
  // 한 번이라도 새로 쓴 파일은 '작성'으로 둔다.
  if (known) {
    if (file.kind === 'write') known.kind = 'write'
  } else if (files.length < MAX_DAY_FILES) files.push(file)
}

// 마지막 사용자·에이전트 기록으로 세션이 어떻게 끝났는지 판단한다. 추측성 판단은 하지 않는다.
export function sessionEndFromEntry(d: Record<string, unknown>): SessionEnd | undefined {
  const ts = Date.parse(typeof d.timestamp === 'string' ? d.timestamp : '')
  if (!Number.isFinite(ts)) return undefined
  if (d.type === 'user') {
    const text = (entryUserText(d) ?? '').trim()
    return { state: /^\[Request interrupted/.test(text) ? 'interrupted' : 'open', ts }
  }
  if (d.type !== 'assistant') return undefined
  if (d.isApiErrorMessage === true || typeof d.error === 'string') return { state: 'error', ts }
  const content = (d.message as { content?: unknown } | undefined)?.content
  const toolUse = Array.isArray(content) && content.some((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'tool_use')
  return { state: toolUse ? 'open' : 'done', ts }
}

// 트랜스크립트 원문 → 날짜별 지시 집계. 서브에이전트(isSidechain)·메타 메시지는 제외.
// 파일 쓰기·수정 도구 호출과 마지막 상태도 함께 모은다.
export function daysFromTranscriptContent(content: string): { cwd?: string; days: DayActivity[]; end?: SessionEnd } {
  let cwd: string | undefined
  let lastLine: string | undefined
  const days = new Map<string, DayActivity>()
  const dayOf = (ts: number): DayActivity => {
    const key = dateKeyLocal(ts)
    let day = days.get(key)
    if (!day) {
      day = { date: key, count: 0, lastTs: ts }
      days.set(key, day)
    }
    return day
  }
  for (const line of content.split('\n')) {
    if (!line.includes('{')) continue
    const isUser = line.includes('"type":"user"')
    const isAssistant = !isUser && line.includes('"type":"assistant"')
    // 슬래시 명령 출력만 담긴 줄(/usage 등)은 끝난 모습 판단에서 뺀다.
    const commandOnly = isUser && (line.includes('<local-command') || line.includes('<command-name>'))
    if ((isUser || isAssistant) && !commandOnly && !line.includes('"isSidechain":true') && !line.includes('"isMeta":true')) lastLine = line
    const fileLine = isAssistant && FILE_TOOL_LINE.test(line)
    if (!isUser && !fileLine && (cwd || !line.includes('"cwd"'))) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (d.isMeta === true || d.isSidechain === true) continue
    const ts = Date.parse(typeof d.timestamp === 'string' ? d.timestamp : '')
    if (!Number.isFinite(ts)) continue
    if (fileLine && d.type === 'assistant') {
      const blocks = (d.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        const b = block as { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }
        const kind = b?.type === 'tool_use' && b.name ? FILE_TOOLS[b.name] : undefined
        const path = b?.input?.file_path ?? b?.input?.notebook_path
        if (!kind || typeof path !== 'string' || !path) continue
        const day = dayOf(ts)
        addFile(day, { path, kind })
        day.lastTs = Math.max(day.lastTs, ts)
      }
      continue
    }
    if (d.type !== 'user') continue
    const text = cleanUserInstruction(entryUserText(d) ?? '')
    if (!text) continue
    const day = dayOf(ts)
    day.count += 1
    if (day.firstText === undefined || (day.firstTs !== undefined && ts < day.firstTs)) {
      day.firstText = text.slice(0, 200)
      day.firstTs = ts
    }
    day.lastTs = Math.max(day.lastTs, ts)
  }
  let end: SessionEnd | undefined
  if (lastLine) {
    try {
      end = sessionEndFromEntry(JSON.parse(lastLine))
    } catch {
      end = undefined
    }
  }
  // 지시가 없는 날(파일만 바뀐 날)은 일지에 남기되 첫 지시 시각은 비운다.
  return { cwd, days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), end }
}

type IndexedMeta = CaseActivityMetaLike & { sourceKey?: string; costByDay?: Record<string, number> }

function metaTitle(meta?: IndexedMeta): string | undefined {
  if (!meta) return undefined
  return cleanTitle(meta.generatedTitle) || cleanTitle(meta.transcriptTitle) || cleanTitle(meta.title)
}

// 세션이 끝난 모습 → 작업일지 상태. 턴이 끝나지 않은 채 10분이 지나면 끊긴 것으로 본다.
const OPEN_SESSION_GRACE_MS = 10 * 60_000

export function sessionStatus(end: SessionEnd | undefined, now: number): { status?: WorkLogStatus; reason?: string } {
  if (!end) return {}
  if (end.state === 'done') return { status: 'done' }
  if (end.state === 'interrupted') return { status: 'unfinished', reason: '사용자가 중지함' }
  if (end.state === 'error') return { status: 'unfinished', reason: '오류로 끝남' }
  return now - end.ts < OPEN_SESSION_GRACE_MS ? { status: 'running' } : { status: 'unfinished', reason: '응답 없이 끊김' }
}

export function boardCardStatus(status: string): { status: WorkLogStatus; reason?: string } {
  if (status === 'done') return { status: 'done' }
  if (status === 'awaiting_approval') return { status: 'pending' }
  if (status === 'blocked') return { status: 'unfinished', reason: '확인 필요로 멈춤' }
  if (status === 'failed') return { status: 'unfinished', reason: '실패' }
  if (status === 'rejected') return { status: 'unfinished', reason: '반려됨' }
  return { status: 'running' }
}

function rootWho(card: WorkLogBoardCard): string {
  if (card.chief) return '업무 보드 · 자동 배분(비서실장)'
  if (card.routine) return `정기 업무 · ${card.team ?? ''} 부서장`.replace('  ', ' ')
  if (card.team) return `업무 보드 · ${card.team} 부서장`
  if (card.agent) return `업무 보드 · ${card.agent}`
  return '업무 보드 · 기본 세션'
}

function childWho(card: WorkLogBoardCard): string {
  if (card.parentId) return '승인 후 실행'
  if (card.delegatedBy) return `${card.delegatorTeam ? card.delegatorTeam + ' ' : ''}부서원 · ${card.agent ?? '기본 세션'}`
  if (card.routedBy) return `${card.team} 부서장`
  return card.agent ?? '기본 세션'
}

function roundUsd(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

// 보고서 앞부분에서 한 일 요약을 뽑는다: "결론" 절이 있으면 그 첫 문단, 없으면 첫 문단.
export function reportSummary(report?: string): string | undefined {
  if (!report?.trim()) return undefined
  const section = /^#{1,3}\s*결론[^\n]*\n+([\s\S]*?)(?:\n#{1,3}\s|$)/m.exec(report)?.[1]
  const text = (section ?? report.replace(/^#{1,6}[^\n]*\n+/gm, '')).trim().split(/\n\s*\n/)[0]
  const clean = text?.replace(/[*_`>#-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 300) : undefined
}

// 스캔 결과(날짜별) + 세션 인덱스(메타·폴백) + 업무 보드 카드를 합쳐 날짜 내림차순 일지로 만든다.
// 스캔이 닿지 못한 세션(원격 실패 등)은 인덱스의 마지막 활동 날짜에 폴백 행으로 넣는다.
// 업무 보드 카드가 연 세션은 원 지시 카드 한 줄로 묶고, 하위 카드를 그 아래에 둔다.
export function mergeWorkLog(
  scans: WorkLogScanSource[],
  indexEntries: IndexedMeta[],
  now: number,
  days = 30,
  cards: WorkLogBoardCard[] = []
): WorkLogDay[] {
  const cutoffKey = dateKeyLocal(now - days * 86_400_000)
  const metaByKey = new Map<string, IndexedMeta>()
  for (const meta of indexEntries) {
    metaByKey.set(`${meta.sourceKey ?? 'local'}:${meta.sessionId}`, meta)
  }
  const cardBySession = new Map<string, WorkLogBoardCard>()
  const cardById = new Map<string, WorkLogBoardCard>()
  for (const card of cards) {
    cardById.set(card.id, card)
    for (const id of card.sessions) cardBySession.set(id, card)
  }
  const byDate = new Map<string, WorkLogItem[]>()
  const covered = new Set<string>()
  const push = (date: string, item: WorkLogItem): void => {
    const list = byDate.get(date)
    if (list) list.push(item)
    else byDate.set(date, [item])
  }
  // 원 지시 카드 × 날짜 → 그날 이 지시 아래에서 돈 세션들
  const groups = new Map<string, { root: WorkLogBoardCard; date: string; item: WorkLogItem }>()

  for (const scan of scans) {
    for (const s of scan.sessions) {
      const key = `${scan.sourceKey}:${s.sessionId}`
      covered.add(key)
      if (isEphemeralCwd(s.cwd)) continue
      const meta = metaByKey.get(key)
      const inWindow = s.days.filter((d) => d.date >= cutoffKey)
      const lastDate = s.days[s.days.length - 1]?.date
      const card = cardBySession.get(s.sessionId)
      for (const day of inWindow) {
        const base = {
          originDevice: meta?.originDevice === 'android' || meta?.originDevice === 'desktop' ? meta.originDevice : undefined,
          cwd: s.cwd ?? meta?.cwd,
          profileId: scan.profileId,
          sshLabel: scan.sshLabel,
          caseNumber: meta?.caseNumber,
          caseName: meta?.caseName,
          folderName: meta?.folderName || pathLeaf(s.cwd ?? meta?.cwd)
        }
        if (card) {
          const root = cardById.get(card.rootId) ?? card
          const groupKey = `${root.id}:${day.date}`
          const group = groups.get(groupKey)
          if (group) {
            const item = group.item
            item.firstTs = Math.min(item.firstTs ?? day.firstTs ?? day.lastTs, day.firstTs ?? day.lastTs)
            item.lastTs = Math.max(item.lastTs, day.lastTs)
            for (const file of day.files ?? []) {
              const known = item.files!.find((f) => f.path === file.path)
              if (!known) item.files!.push({ ...file })
              else if (file.kind === 'write') known.kind = 'write'
            }
            if (!item.caseNumber && base.caseNumber) Object.assign(item, { caseNumber: base.caseNumber, caseName: base.caseName })
          } else {
            groups.set(groupKey, {
              root,
              date: day.date,
              item: {
                ...base,
                sessionId: (root.sessions[root.sessions.length - 1] ?? s.sessionId),
                count: 0,
                firstTs: day.firstTs ?? day.lastTs,
                lastTs: day.lastTs,
                files: (day.files ?? []).map((f) => ({ ...f }))
              }
            })
          }
          continue
        }
        const status = day.date === lastDate ? sessionStatus(s.end, now) : { status: 'continued' as const }
        const cost = meta?.costByDay?.[day.date]
        push(day.date, {
          ...base,
          sessionId: s.sessionId,
          title: metaTitle(meta),
          // "한 일/다음" 요약은 세션의 마지막 활동 날짜에만 붙인다 (과거 날짜엔 그날의 지시가 더 정확)
          workSummary: day.date === lastDate ? meta?.workSummary : undefined,
          count: day.count,
          firstText: day.firstText,
          firstTs: day.firstTs,
          lastTs: day.lastTs,
          who: '일반 대화',
          files: day.files,
          status: status.status,
          statusReason: status.reason,
          costUsd: typeof cost === 'number' && cost > 0 ? roundUsd(cost) : undefined
        })
      }
    }
  }

  for (const { root, date, item } of groups.values()) {
    const tree = cards.filter((card) => card.rootId === root.id)
    const status = boardCardStatus(root.status)
    const cost = tree.reduce((sum, card) => sum + (card.cost ?? 0), 0)
    const departments = [...new Set(tree.map((card) => card.team).filter((team): team is string => !!team))]
    push(date, {
      ...item,
      cwd: item.cwd ?? root.workspace,
      title: root.title,
      firstText: root.body.replace(/\s+/g, ' ').trim().slice(0, 200) || root.title,
      count: tree.length,
      who: rootWho(root),
      departments: departments.length ? departments : undefined,
      workSummary: reportSummary(root.report),
      status: status.status,
      statusReason: status.reason,
      costUsd: cost > 0 ? roundUsd(cost) : undefined,
      files: item.files?.length ? item.files : undefined,
      board: {
        workspace: root.workspace,
        cardId: root.id,
        children: tree
          .filter((card) => card.id !== root.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((card) => ({
            cardId: card.id,
            who: childWho(card),
            title: card.title,
            status: boardCardStatus(card.status).status,
            costUsd: card.cost ? roundUsd(card.cost) : undefined
          }))
      }
    })
  }

  for (const meta of indexEntries) {
    const key = `${meta.sourceKey ?? 'local'}:${meta.sessionId}`
    if (covered.has(key) || isEphemeralCwd(meta.cwd) || cardBySession.has(meta.sessionId)) continue
    const ts =
      typeof meta.mtime === 'number' && meta.mtime > 0 ? meta.mtime : Date.parse(meta.updatedAt)
    if (!Number.isFinite(ts)) continue
    const date = dateKeyLocal(ts)
    if (date < cutoffKey) continue
    const cost = meta.costByDay?.[date]
    push(date, {
      sessionId: meta.sessionId,
      originDevice: meta.originDevice === 'android' || meta.originDevice === 'desktop' ? meta.originDevice : undefined,
      cwd: meta.cwd,
      profileId: meta.profileId,
      sshLabel: meta.sshLabel,
      caseNumber: meta.caseNumber,
      caseName: meta.caseName,
      folderName: meta.folderName || pathLeaf(meta.cwd),
      title: metaTitle(meta),
      workSummary: meta.workSummary,
      count: 0,
      lastTs: ts,
      who: '일반 대화',
      costUsd: typeof cost === 'number' && cost > 0 ? roundUsd(cost) : undefined
    })
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] > b[0] ? -1 : 1))
    .map(([date, items]) => ({
      date,
      epoch: epochOfDateKey(date),
      items: items.sort((a, b) => b.lastTs - a.lastTs)
    }))
}
