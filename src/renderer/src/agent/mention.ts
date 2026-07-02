// @-멘션 파일 자동완성용 작업공간 파일 인덱스. fs.list를 BFS로 돌며 상한을 두고 수집한다.
export interface MentionEntry {
  name: string
  relPath: string
  absPath: string
  isDir: boolean
}

const MENTION_MAX_ENTRIES = 1500
const MENTION_MAX_DEPTH = 4
const MENTION_RESULT_LIMIT = 12
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', 'build', '.git', '__pycache__'])

export async function buildMentionIndex(root: string): Promise<MentionEntry[]> {
  const entries: MentionEntry[] = []
  const queue: { path: string; rel: string; depth: number }[] = [{ path: root, rel: '', depth: 0 }]
  while (queue.length > 0 && entries.length < MENTION_MAX_ENTRIES) {
    const current = queue.shift()!
    const listed = await window.lt.fs.list(current.path).catch(() => [])
    for (const item of listed) {
      if (entries.length >= MENTION_MAX_ENTRIES) break
      if (item.name.startsWith('.') || SKIP_DIR_NAMES.has(item.name)) continue
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name
      entries.push({ name: item.name, relPath: rel, absPath: item.path, isDir: item.isDir })
      if (item.isDir && current.depth + 1 < MENTION_MAX_DEPTH) {
        queue.push({ path: item.path, rel, depth: current.depth + 1 })
      }
    }
  }
  return entries
}

function mentionScore(entry: MentionEntry, query: string): number {
  if (!query) return entry.isDir ? 1 : 2
  const name = entry.name.toLowerCase()
  const rel = entry.relPath.toLowerCase()
  if (name === query) return 100
  if (name.startsWith(query)) return 80
  if (name.includes(query)) return 60
  if (rel.includes(query)) return 40
  // 경로 문자 순서 부분 일치(간단한 subsequence 매칭)
  let cursor = 0
  for (const char of rel) {
    if (char === query[cursor]) cursor += 1
    if (cursor === query.length) return 10
  }
  return -1
}

export function filterMentionEntries(entries: MentionEntry[], rawQuery: string): MentionEntry[] {
  const query = rawQuery.trim().toLowerCase()
  return entries
    .map((entry) => ({ entry, score: mentionScore(entry, query) }))
    .filter(({ score }) => score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.relPath.length - b.entry.relPath.length ||
        a.entry.relPath.localeCompare(b.entry.relPath, 'ko')
    )
    .slice(0, MENTION_RESULT_LIMIT)
    .map(({ entry }) => entry)
}

// 커서 바로 앞의 `@토큰`을 찾는다. 공백 없는 연속 문자열만 멘션 후보로 본다.
export function mentionTokenAt(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const match = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null
  return { query: match[1], start: caret - match[1].length - 1 }
}
