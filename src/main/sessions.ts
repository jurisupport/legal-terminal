import { homedir } from 'os'
import { join } from 'path'
import { readdir, stat, open } from 'fs/promises'

// claude Code 세션 transcript: ~/.claude/projects/<인코딩폴더>/<sessionId>.jsonl
// 폴더 인코딩이 비영숫자→'-'(한글 충돌)이라, 폴더명 계산 대신 transcript 내부 cwd로 매칭한다.
const projectsDir = join(homedir(), '.claude', 'projects')

interface TranscriptRef {
  file: string
  sessionId: string
  mtime: number
}

async function listTranscripts(): Promise<TranscriptRef[]> {
  const out: TranscriptRef[] = []
  let dirs
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = join(projectsDir, d.name)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const s = await stat(join(dir, f))
        out.push({ file: join(dir, f), sessionId: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs })
      } catch {
        /* skip */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// 파일 앞부분만 읽어 cwd·제목 파싱 (transcript는 클 수 있음)
async function readHead(file: string, bytes = 65536): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function parseHead(content: string): { cwd?: string; title?: string } {
  let cwd: string | undefined
  let aiTitle: string | undefined
  let firstUser: string | undefined
  for (const line of content.split('\n')) {
    if (!line.trim() || !line.includes('{')) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') aiTitle = d.aiTitle
    if (!firstUser && d.type === 'user') {
      const m = d.message as { content?: unknown } | undefined
      const c = m?.content
      if (typeof c === 'string') firstUser = c
      else if (Array.isArray(c))
        firstUser = c
          .filter((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'text')
          .map((x) => (x as { text?: string }).text ?? '')
          .join(' ')
    }
  }
  const title = aiTitle || (firstUser ? firstUser.trim().slice(0, 40) : undefined)
  return { cwd, title }
}

// 주어진 cwd의 모든 과거 claude 세션 목록 (최신순). 제목·시각 포함.
export async function listSessions(
  cwd: string,
  limit = 40
): Promise<{ sessionId: string; title?: string; mtime: number }[]> {
  const ts = await listTranscripts()
  const out: { sessionId: string; title?: string; mtime: number }[] = []
  for (const t of ts) {
    if (out.length >= limit) break
    let head: string
    try {
      head = await readHead(t.file)
    } catch {
      continue
    }
    const p = parseHead(head)
    if (p.cwd && p.cwd === cwd) {
      out.push({ sessionId: t.sessionId, title: p.title, mtime: t.mtime })
    }
  }
  return out
}

// 주어진 cwd의 claude 세션 제목. since가 주어지면 그 시각 이후 갱신된 transcript만 본다
// (터미널을 연 뒤 시작된 세션 = 현재 세션. 과거 세션 제목이 잡히는 것을 방지).
export async function currentSession(
  cwd: string,
  since = 0
): Promise<{ sessionId: string; title?: string } | null> {
  const ts = await listTranscripts()
  for (const t of ts) {
    if (since && t.mtime < since) continue // 과거 세션 제외
    let head: string
    try {
      head = await readHead(t.file)
    } catch {
      continue
    }
    const p = parseHead(head)
    if (p.cwd && p.cwd === cwd) {
      return { sessionId: t.sessionId, title: p.title }
    }
  }
  return null
}
