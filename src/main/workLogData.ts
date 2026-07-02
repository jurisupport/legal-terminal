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

export interface DayActivity {
  date: string // YYYY-MM-DD (로컬 기준)
  count: number // 그날 사용자 지시 수
  firstText?: string // 그날 첫 지시 (정리본, 200자)
  lastTs: number // 그날 마지막 지시 시각 (ms)
}

export interface SessionDayScan {
  sessionId: string
  cwd?: string
  days: DayActivity[]
}

export interface WorkLogScanSource {
  sourceKey: string // 'local' | 'ssh:user@host:port' — 세션 인덱스 sourceKey와 동일 규칙
  profileId?: string
  sshLabel?: string
  sessions: SessionDayScan[]
}

export interface WorkLogItem {
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
  lastTs: number
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
  return /^\/(private\/)?(var\/folders|tmp)\//.test(cwd) || /[\\/]Temp[\\/]/i.test(cwd)
}

// 내부 태그·명령 래퍼를 걷어낸 사용자 지시 텍스트. 지시가 아니면 undefined.
export function cleanUserInstruction(raw: string): string | undefined {
  const command = /<command-name>\s*([^<\n]+?)\s*<\/command-name>/.exec(raw)
  if (command) {
    if (NOISE_COMMANDS.has(command[1].trim().toLowerCase())) return undefined
    const args = /<command-args>\s*([^<\n]*?)\s*<\/command-args>/.exec(raw)?.[1]
    return [command[1], args].filter(Boolean).join(' ')
  }
  if (NOISE_COMMANDS.has(raw.trim().toLowerCase())) return undefined
  if (/<local-command-caveat>|<local-command-stdout>|<command-message>/.test(raw)) return undefined
  if (/원본 대화 transcript입니다|진행하던 대화 transcript입니다/.test(raw)) return undefined
  if (/^\[Request interrupted/.test(raw.trim())) return undefined
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
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

// 트랜스크립트 원문 → 날짜별 지시 집계. 서브에이전트(isSidechain)·메타 메시지는 제외.
export function daysFromTranscriptContent(content: string): { cwd?: string; days: DayActivity[] } {
  let cwd: string | undefined
  const days = new Map<string, DayActivity>()
  for (const line of content.split('\n')) {
    if (!line.includes('{')) continue
    const isUser = line.includes('"type":"user"')
    if (!isUser && (cwd || !line.includes('"cwd"'))) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (d.type !== 'user' || d.isMeta === true || d.isSidechain === true) continue
    const ts = Date.parse(typeof d.timestamp === 'string' ? d.timestamp : '')
    if (!Number.isFinite(ts)) continue
    const text = cleanUserInstruction(entryUserText(d) ?? '')
    if (!text) continue
    const key = dateKeyLocal(ts)
    const day = days.get(key)
    if (day) {
      day.count += 1
      day.lastTs = Math.max(day.lastTs, ts)
    } else {
      days.set(key, { date: key, count: 1, firstText: text.slice(0, 200), lastTs: ts })
    }
  }
  return { cwd, days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) }
}

type IndexedMeta = CaseActivityMetaLike & { sourceKey?: string }

function metaTitle(meta?: IndexedMeta): string | undefined {
  if (!meta) return undefined
  return cleanTitle(meta.generatedTitle) || cleanTitle(meta.transcriptTitle) || cleanTitle(meta.title)
}

// 스캔 결과(날짜별) + 세션 인덱스(메타·폴백)를 합쳐 날짜 내림차순 일지로 만든다.
// 스캔이 닿지 못한 세션(원격 실패 등)은 인덱스의 마지막 활동 날짜에 폴백 행으로 넣는다.
export function mergeWorkLog(
  scans: WorkLogScanSource[],
  indexEntries: IndexedMeta[],
  now: number,
  days = 30
): WorkLogDay[] {
  const cutoffKey = dateKeyLocal(now - days * 86_400_000)
  const metaByKey = new Map<string, IndexedMeta>()
  for (const meta of indexEntries) {
    metaByKey.set(`${meta.sourceKey ?? 'local'}:${meta.sessionId}`, meta)
  }
  const byDate = new Map<string, WorkLogItem[]>()
  const covered = new Set<string>()
  const push = (date: string, item: WorkLogItem): void => {
    const list = byDate.get(date)
    if (list) list.push(item)
    else byDate.set(date, [item])
  }

  for (const scan of scans) {
    for (const s of scan.sessions) {
      const key = `${scan.sourceKey}:${s.sessionId}`
      covered.add(key)
      if (isEphemeralCwd(s.cwd)) continue
      const meta = metaByKey.get(key)
      const inWindow = s.days.filter((d) => d.date >= cutoffKey)
      const lastDate = inWindow[inWindow.length - 1]?.date
      for (const day of inWindow) {
        push(day.date, {
          sessionId: s.sessionId,
          cwd: s.cwd ?? meta?.cwd,
          profileId: scan.profileId,
          sshLabel: scan.sshLabel,
          caseNumber: meta?.caseNumber,
          caseName: meta?.caseName,
          folderName: meta?.folderName || pathLeaf(s.cwd ?? meta?.cwd),
          title: metaTitle(meta),
          // "한 일/다음" 요약은 세션의 마지막 활동 날짜에만 붙인다 (과거 날짜엔 그날의 지시가 더 정확)
          workSummary: day.date === lastDate ? meta?.workSummary : undefined,
          count: day.count,
          firstText: day.firstText,
          lastTs: day.lastTs
        })
      }
    }
  }

  for (const meta of indexEntries) {
    const key = `${meta.sourceKey ?? 'local'}:${meta.sessionId}`
    if (covered.has(key) || isEphemeralCwd(meta.cwd)) continue
    const ts =
      typeof meta.mtime === 'number' && meta.mtime > 0 ? meta.mtime : Date.parse(meta.updatedAt)
    if (!Number.isFinite(ts)) continue
    const date = dateKeyLocal(ts)
    if (date < cutoffKey) continue
    push(date, {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      profileId: meta.profileId,
      sshLabel: meta.sshLabel,
      caseNumber: meta.caseNumber,
      caseName: meta.caseName,
      folderName: meta.folderName || pathLeaf(meta.cwd),
      title: metaTitle(meta),
      workSummary: meta.workSummary,
      count: 0,
      lastTs: ts
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
