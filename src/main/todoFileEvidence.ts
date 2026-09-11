import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, posix } from 'node:path'

interface Entry { name: string; path: string; isDir: boolean; mtimeMs?: number }
interface Folder { path: string; kind: 'records' | 'drafts'; caseSpecific?: boolean }
interface FileCandidate {
  kind: 'file'; id: string; uri: string; label: string; occurredAt?: string
  reason: string; status: 'candidate'
}
export const FILE_EVIDENCE_ENTRY_LIMIT = 200
export const FILE_EVIDENCE_CANDIDATE_LIMIT = 20
const supported = new Set(['.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.md', '.txt', '.rtf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.xlsx', '.csv'])

export function containsCaseNumber(text: string, caseNumber: string): boolean {
  const key = caseNumber.normalize('NFC').replace(/\s+/g, '')
  if (!/^\d{4}[가-힣]+\d+$/.test(key)) return false
  const normalized = text.normalize('NFC').replace(/\s+/g, '')
  return new RegExp(`(^|[^0-9])${key}(?![0-9])`).test(normalized)
}

/** Only immediate entries of explicit pairings; never infer folders or read file contents. */
export async function pairedFileEvidence(
  caseNumber: string | null | undefined,
  folders: Folder[],
  list: (folder: string) => Promise<Entry[]>
): Promise<{ candidates: FileCandidate[]; warnings: string[] }> {
  const candidates = new Map<string, FileCandidate>()
  const warnings: string[] = []
  if (!folders.length) return { candidates: [], warnings: ['연결된 기록·작성서류 폴더가 없어 파일 후보는 확인하지 못했습니다.'] }
  if (!caseNumber || !containsCaseNumber(caseNumber, caseNumber)) return { candidates: [], warnings: ['사건번호를 확인할 수 없어 다른 사건 파일이 섞이지 않도록 파일 후보 조회를 생략했습니다.'] }
  for (const folder of folders.slice(0, 2)) {
    const remote = folder.path.startsWith('ssh://')
    if ((!remote && !isAbsolute(folder.path)) || /[\r\n]/.test(folder.path)) { warnings.push('연결 폴더의 절대 경로를 확인할 수 없습니다.'); continue }
    try {
      const entries = await list(folder.path)
      const label = folder.kind === 'drafts' ? '작성서류' : '기록'
      if (entries.length > FILE_EVIDENCE_ENTRY_LIMIT) warnings.push(`${label} 폴더는 앞 ${FILE_EVIDENCE_ENTRY_LIMIT}개 항목만 확인했습니다.`)
      let count = 0
      for (const entry of entries.slice(0, FILE_EVIDENCE_ENTRY_LIMIT)) {
        const parent = remote ? posix.dirname(entry.path) : dirname(entry.path)
        const entryName = remote ? posix.basename(entry.path) : basename(entry.path)
        if (parent.normalize('NFC') !== folder.path.replace(/[\\/]$/, '').normalize('NFC') || entry.name !== entryName || entry.isDir || entry.name.startsWith('.') || !supported.has(extname(entry.name).toLowerCase())) continue
        if (entry.path.length > 2000 || /[\x00-\x1f\x7f]/.test(entry.path)) continue
        const uri = /^[A-Za-z]:\\/.test(entry.path) ? entry.path.replace(/\\/g, '/') : entry.path
        // Generic records are allowed only in a verified case-number folder; shared drafts require a filename match.
        if (!(folder.kind === 'records' && folder.caseSpecific) && !containsCaseNumber(entry.name, caseNumber)) continue
        if (count >= FILE_EVIDENCE_CANDIDATE_LIMIT) { warnings.push(`${label} 파일 후보는 ${FILE_EVIDENCE_CANDIDATE_LIMIT}개까지 표시합니다.`); break }
        const draft = folder.kind === 'drafts' || /초안|draft|제출대기/i.test(entry.name)
        const date = entry.mtimeMs === undefined ? null : new Date(entry.mtimeMs)
        candidates.set(entry.path, {
          kind: 'file', id: createHash('sha256').update(uri).digest('hex'), uri, label: entry.name.slice(0, 500),
          ...(date && Number.isFinite(date.getTime()) ? { occurredAt: date.toISOString() } : {}),
          reason: `${label} 연결 폴더의 파일 후보 · ${draft ? '초안·제출 여부 확인 필요' : '실제 제출·완료 여부 확인 필요'} (수정일 기준)`, status: 'candidate'
        })
        count++
      }
    } catch (error) { warnings.push(`${folder.kind === 'drafts' ? '작성서류' : '기록'} 폴더 조회 실패: ${error instanceof Error ? error.message : String(error)}`) }
  }
  warnings.push('연결 폴더 바로 아래의 파일만 확인했습니다. 하위 폴더·미연결 파일과 사건번호가 없는 공유 폴더 파일은 포함하지 않습니다.')
  return { candidates: [...candidates.values()], warnings }
}
