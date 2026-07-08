import type { SessionTranscript, SshConn } from '../env'

// 과거 세션 transcript 캐시. 사건/폴더를 열 때 최근 세션 몇 개를 미리 받아둬,
// 에이전트가 열려 있지 않아도 이어서 열기·fork 시 히스토리가 즉시 뜨게 한다.
// 원격 세션은 호출마다 새 SSH 접속이므로 프리로드는 순차로 돌린다.
const FRESH_MS = 10 * 60 * 1000
const MAX_ENTRIES = 24

interface CacheEntry {
  transcript: SessionTranscript | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<SessionTranscript | null>>()

export const transcriptSourceKey = (ssh?: SshConn): string =>
  ssh ? `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.identityFile ?? ''}` : 'local'

const keyOf = (sessionId: string, ssh?: SshConn): string =>
  `${transcriptSourceKey(ssh)}:${sessionId}`

// 캐시가 신선하면 즉시, 아니면 받아온 뒤 반환. 실패 시 만료된 캐시라도 있으면 그걸 쓴다.
// refresh: 세션이 방금까지 이어졌을 수 있어 최신본이 필요할 때 (fork 맥락 등).
export function loadSessionTranscript(
  sessionId: string,
  ssh?: SshConn,
  opts?: { refresh?: boolean }
): Promise<SessionTranscript | null> {
  const key = keyOf(sessionId, ssh)
  const cached = cache.get(key)
  if (!opts?.refresh && cached && Date.now() - cached.fetchedAt < FRESH_MS)
    return Promise.resolve(cached.transcript)
  const pending = inflight.get(key)
  if (pending) return pending
  const request = window.lt.sessions
    .transcript(sessionId, ssh)
    .then((transcript) => {
      cache.delete(key)
      cache.set(key, { transcript, fetchedAt: Date.now() })
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return transcript
    })
    .catch(() => cached?.transcript ?? null)
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, request)
  return request
}

// 세션을 실제로 이어 열었으면 그 뒤로 대화가 늘어나므로, 프리로드본은 한 번 쓰고 버린다.
export function invalidateSessionTranscript(sessionId: string, ssh?: SshConn): void {
  cache.delete(keyOf(sessionId, ssh))
}

export function preloadSessionTranscripts(sessionIds: string[], ssh?: SshConn): void {
  void sessionIds.reduce(
    (chain, sessionId) =>
      chain.then(() => loadSessionTranscript(sessionId, ssh)).then(
        () => undefined,
        () => undefined
      ),
    Promise.resolve<void | undefined>(undefined)
  )
}
