import { useEffect, useRef, useState } from 'react'
import Terminal from './terminal/Terminal'
import FileTree, { LT_PATH } from './filetree/FileTree'
import PdfViewer from './viewer/PdfViewer'
import RecordViewer from './viewer/RecordViewer'
import { parseRecordFiles, type ParsedRecord, type OutlineItem } from './viewer/recordOutline'
import { IconExplorer, IconCases, IconViewer, IconSettings } from './icons/Icons'
import MarkdownEditor from './editor/MarkdownEditor'
import CasesDashboard from './dashboard/CasesDashboard'
import UpcomingHearings from './dashboard/UpcomingHearings'
import type { JsCase } from './env'

type Mode = 'explorer' | 'cases' | 'viewer'

interface ActivityItem {
  id: Mode
  label: string
  Icon: (props: { size?: number }) => JSX.Element
}
const ACTIVITY: ActivityItem[] = [
  { id: 'explorer', label: '탐색기', Icon: IconExplorer },
  { id: 'cases', label: '사건', Icon: IconCases },
  { id: 'viewer', label: '기록뷰어', Icon: IconViewer }
]

interface DocTab {
  id: string
  title: string
  kind: 'welcome' | 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'csv' | 'settings'
  path?: string
}
/**
 * 터미널 1개 = 사건 1개.
 * cwd = 작성서류 폴더(claude 작업·탐색기 기준). recordsFolder = 소송기록 폴더(뷰어 기준, 별도 지정).
 */
interface TermTab {
  id: string
  title: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string // 페어링으로 추천된 소송기록 폴더 (사용자가 '열기' 눌러야 적용)
  autoClaude?: boolean // 사건 열기 = claude 자동 실행, + 새 터미널 = 빈 셸
  // JuriSupport 사건에서 연 세션의 메타 (자동 명명·사건별 필터용)
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  sessionTitle?: string // claude 세션 제목(ai-title) — transcript에서 자동 반영
  renamed?: boolean // 사용자가 직접 이름 변경 → 자동 반영 중단
  createdAt?: number // 세션 시작 시각 — 이 이후의 transcript만 현재 세션으로 매칭
  resumeSessionId?: string // 과거 세션 이어서 열기
}
interface CaseMeta {
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
}
// 법원명 약칭 (탭 제목 길이 절약)
function abbrevCourt(court: string): string {
  return court
    .replace('지방법원', '지법')
    .replace('고등법원', '고법')
    .replace('지원', '지원')
    .trim()
}

// 완료 알림음 (외부 파일 없이 WebAudio로 짧은 두 톤). 컨텍스트를 1개만 만들어 재사용하고
// 자동재생 정책 때문에 사용자 제스처(클릭)에서 resume 해 둔다.
let _actx: AudioContext | null = null
function getAudioCtx(): AudioContext | null {
  try {
    if (!_actx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      _actx = new Ctx()
    }
    if (_actx.state === 'suspended') void _actx.resume()
    return _actx
  } catch {
    return null
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => void getAudioCtx(), { capture: true })
}
function beep(): void {
  const ctx = getAudioCtx()
  if (!ctx) return
  const play = (freq: number, start: number, dur: number): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    o.connect(g)
    g.connect(ctx.destination)
    const t0 = ctx.currentTime + start
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.start(t0)
    o.stop(t0 + dur)
  }
  play(880, 0, 0.12)
  play(1320, 0.12, 0.15)
}

let docSeq = 0
const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${++docSeq}`

export default function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>('explorer')
  const [info, setInfo] = useState<string>('')

  const [docTabs, setDocTabs] = useState<DocTab[]>([
    { id: 'doc-welcome', title: '시작하기.md', kind: 'welcome' }
  ])
  const [activeDoc, setActiveDoc] = useState<string>('doc-welcome')

  const [termTabs, setTermTabs] = useState<TermTab[]>([])
  const [activeTerm, setActiveTerm] = useState<string>('')
  const [draftsRoot, setDraftsRoot] = useState<string | undefined>()
  const [recordsRoot, setRecordsRoot] = useState<string | undefined>()

  // 활성 PDF의 목차 분류 결과 + 페이지 점프 신호
  const [pdfRecord, setPdfRecord] = useState<{ path: string; parsed: ParsedRecord } | null>(null)
  const [pdfJump, setPdfJump] = useState<{ page: number; nonce: number } | undefined>()
  const jumpNonce = useRef(0)


  // 소송기록 폴더의 PDF 파일명을 파싱한 분류 결과 (폴더 기반 기록)
  const [folderRecord, setFolderRecord] = useState<ParsedRecord | null>(null)

  // 여백 자르기는 앱 전역으로 유지 (문서 바꿔도 적용 지속)
  const [cropOn, setCropOn] = useState(false)
  const [cropRatio, setCropRatio] = useState(0.05)

  // 최근 사건 히스토리
  const [recent, setRecent] = useState<{ drafts: string; records?: string; name: string; ts: number }[]>(
    []
  )

  // 탐색기 트리 새로고침 트리거 (드래그드롭 복사 후)
  const [treeRefresh, setTreeRefresh] = useState(0)

  // 탐색기 인라인 생성 (VS Code식: 트리에 입력칸이 떠서 이름 입력)
  const [pendingCreate, setPendingCreate] = useState<'file' | 'folder' | null>(null)

  useEffect(() => {
    window.lt?.app
      .info()
      .then((i) =>
        setInfo(`Electron ${i.versions.electron} · Node ${i.versions.node} · ${i.platform}`)
      )
      .catch(() => setInfo('preload 브리지 미연결'))
    window.lt?.settings.get().then((s) => {
      setDraftsRoot(s.draftsRoot)
      setRecordsRoot(s.recordsRoot)
    })
    window.lt?.case.history().then(setRecent)
  }, [])

  // ── 본문(문서) 탭 ──
  // 활성 사건 폴더가 있으면 거기에 실제 파일을 만들어 연다(VS Code식). 없으면 메모리 스크래치.
  const addDoc = (): void => {
    const dir = termTabs.find((t) => t.id === activeTerm)?.cwd
    if (dir) {
      window.lt.fs.createFile(dir, '새 문서.md').then((r) => {
        if (r.ok && r.path) {
          setTreeRefresh((x) => x + 1)
          openFile(r.path, r.path.split(/[\\/]/).pop() ?? '새 문서.md')
        }
      })
      return
    }
    const n = ++docSeq
    const tab: DocTab = { id: `doc-${n}`, title: `새 문서 ${n}.md`, kind: 'mdview' }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
  }
  const setDocPath = (id: string, path: string): void =>
    setDocTabs((tabs) =>
      tabs.map((t) =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() ?? t.title } : t
      )
    )
  const closeDoc = (id: string): void =>
    setDocTabs((tabs) => closeTab(tabs, id, activeDoc, setActiveDoc))

  // 단축키: Ctrl+W 탭 닫기 / Ctrl+N 새 문서 / Ctrl+Shift+N 새 터미널
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      const inTerm = (document.activeElement as HTMLElement | null)?.closest?.('.term-col')
      if (k === 'w' && !e.shiftKey) {
        if (inTerm) return // 터미널 포커스 시 claude로 (단어 삭제)
        e.preventDefault()
        if (activeDoc) closeDoc(activeDoc)
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault()
        void window.lt.app.newWindow() // 새 창(새 작업환경)
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        addDoc()
      } else if (k === 'tab') {
        // Ctrl+Tab: 문서 탭 순환 (터미널 포커스 시엔 터미널이 자체 처리)
        if (inTerm) return
        e.preventDefault()
        cycleDoc(e.shiftKey ? -1 : 1)
      } else if (k === 'pageup' || k === 'pagedown') {
        // Ctrl+PageUp/PageDown: 문서 탭 이동 (터미널 포커스 시엔 터미널이 자체 처리)
        if (inTerm) return
        e.preventDefault()
        cycleDoc(k === 'pageup' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDoc, activeTerm, termTabs, docTabs]) // eslint-disable-line react-hooks/exhaustive-deps

  const openSettings = (): void => {
    const existing = docTabs.find((t) => t.kind === 'settings')
    if (existing) {
      setActiveDoc(existing.id)
      return
    }
    const tab: DocTab = { id: 'settings', title: '설정', kind: 'settings' }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
  }

  const openFile = (path: string, name: string): void => {
    const existing = docTabs.find((t) => t.path === path)
    if (existing) {
      setActiveDoc(existing.id)
      return
    }
    const lower = path.toLowerCase()
    let kind: DocTab['kind'] = 'file'
    if (lower.endsWith('.pdf')) kind = 'pdf'
    else if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/.test(lower)) kind = 'image'
    else if (/\.(hwp|hwpx)$/.test(lower)) kind = 'hwp'
    else if (/\.(md|markdown)$/.test(lower)) kind = 'mdview'
    else if (lower.endsWith('.csv')) kind = 'csv'
    const tab: DocTab = { id: `file-${++docSeq}`, title: name, kind, path }
    setDocTabs((t) => [...t, tab])
    setActiveDoc(tab.id)
  }

  // 이미지 뷰어: 같은 폴더의 정렬순 이전/다음 이미지로 현재 탭에서 이동
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/i
  const navigateImage = async (curPath: string, dir: 1 | -1): Promise<void> => {
    const parent = curPath.replace(/[\\/][^\\/]*$/, '')
    if (!parent || parent === curPath) return
    try {
      const list = await window.lt.fs.list(parent)
      const imgs = list.filter((e) => !e.isDir && IMG_RE.test(e.name))
      const i = imgs.findIndex((e) => e.path === curPath)
      if (i < 0) return
      const next = imgs[i + dir]
      if (!next) return
      setDocTabs((tabs) =>
        tabs.map((t) =>
          t.kind === 'image' && t.path === curPath ? { ...t, path: next.path, title: next.name } : t
        )
      )
    } catch {
      /* 무시 */
    }
  }

  // 다른 창에서 찢겨/이동돼 온 탭 수신 → 파일 열기 (최신 openFile 클로저를 ref로 사용)
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  useEffect(() => {
    const off = window.lt.tabs.onReceive((p) => openFileRef.current(p.path, p.title))
    window.lt.tabs.ready() // 큐잉된 페이로드 flush 요청
    return off
  }, [])

  // claude 세션 제목(ai-title)을 주기적으로 읽어 탭 이름에 반영 (수동 변경한 탭 제외)
  const termKey = termTabs.map((t) => t.id + ':' + t.cwd).join('|')
  useEffect(() => {
    if (termTabs.length === 0) return
    let alive = true
    const tick = (): void => {
      termTabs.forEach((t) => {
        if (t.renamed) return
        // 이 터미널이 시작된 이후의 세션만 매칭 (과거 세션 제목 방지)
        window.lt.sessions.current(t.cwd, (t.createdAt ?? 0) - 3000).then((r) => {
          if (!alive || !r?.title) return
          setTermTabs((tabs) =>
            tabs.map((x) =>
              x.id === t.id && !x.renamed && x.sessionTitle !== r.title
                ? { ...x, sessionTitle: r.title }
                : x
            )
          )
        })
      })
    }
    tick()
    const iv = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey])

  // 문서 탭 순서 변경 (탭 바 안에서 드래그 재정렬)
  const reorderDocs = (fromId: string, toId: string): void => {
    setDocTabs((ts) => {
      const a = [...ts]
      const fi = a.findIndex((x) => x.id === fromId)
      const ti = a.findIndex((x) => x.id === toId)
      if (fi < 0 || ti < 0 || fi === ti) return ts
      const [m] = a.splice(fi, 1)
      a.splice(ti, 0, m)
      return a
    })
  }

  // ── 사건 터미널 탭 (작성서류 폴더 = cwd로 claude 실행) ──
  const createCase = (
    drafts: string,
    name: string,
    records?: string,
    suggested?: string,
    caseMeta?: CaseMeta
  ): void => {
    const tab: TermTab = {
      id: newId(),
      title: name,
      cwd: drafts,
      recordsFolder: records,
      suggestedRecords: suggested,
      autoClaude: true, // 사건 열기 → claude 자동 실행
      createdAt: Date.now(),
      ...caseMeta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
    setCurrentCase({ drafts, records, name, meta: caseMeta })
    window.lt.case.addHistory({ drafts, records, name }).then(setRecent)
  }

  const addTerm = async (): Promise<void> => {
    const picked = await window.lt.dialog.pickFolder({
      title: '사건(작성서류) 폴더 선택',
      defaultPath: draftsRoot
    })
    if (!picked) return
    // 이전에 페어링한 소송기록 폴더가 있으면 '추천'만 (자동 적용하지 않고 물어봄)
    const paired = await window.lt.case.getPairing(picked.path)
    createCase(picked.path, picked.name, undefined, paired ?? undefined)
  }

  // 최근 사건은 사용자가 명시적으로 고른 것이므로 연결된 소송기록을 바로 적용
  const openRecent = (entry: { drafts: string; records?: string; name: string }): void =>
    createCase(entry.drafts, entry.name, entry.records)

  // 과거 claude 세션 이어서 열기 (claude --resume). 지정한 cwd/사건 컨텍스트에서.
  const openPastSession = (sessionId: string, cwd: string, title?: string): void => {
    const base = currentCase && currentCase.drafts === cwd ? currentCase : undefined
    const meta = base?.meta
    const tab: TermTab = {
      id: newId(),
      title: title ? title : base?.name ?? cwd.split(/[\\/]/).pop() ?? '세션',
      cwd,
      recordsFolder: base?.records,
      autoClaude: true,
      createdAt: Date.now(),
      resumeSessionId: sessionId,
      renamed: !!title, // 과거 세션 제목을 그대로 쓰면 자동 갱신 안 함
      ...meta
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
  }

  // + / Ctrl+T : 같은 사건에서 새 터미널(claude 실행). 활성 터미널이 없으면 마지막 사건에서, 그것도 없으면 폴더 선택.
  const addTermSame = (): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    if (!cur) {
      if (currentCase) {
        createCase(currentCase.drafts, currentCase.name, currentCase.records, undefined, currentCase.meta)
      } else {
        void addTerm()
      }
      return
    }
    const tab: TermTab = {
      id: newId(),
      title: cur.title,
      cwd: cur.cwd,
      recordsFolder: cur.recordsFolder,
      autoClaude: true, // 새 터미널도 일괄적으로 claude 실행
      createdAt: Date.now(),
      jsId: cur.jsId,
      court: cur.court,
      caseNumber: cur.caseNumber,
      caseName: cur.caseName,
      client: cur.client
    }
    setTermTabs((t) => [...t, tab])
    setActiveTerm(tab.id)
  }

  // 추천 소송기록 폴더 적용 ('열기' 클릭 시)
  const applySuggested = (): void => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    if (!cur?.suggestedRecords) return
    const rec = cur.suggestedRecords
    setTermTabs((tabs) =>
      tabs.map((t) =>
        t.id === activeTerm ? { ...t, recordsFolder: rec, suggestedRecords: undefined } : t
      )
    )
    window.lt.case.setPairing(cur.cwd, rec)
    window.lt.case.addHistory({ drafts: cur.cwd, records: rec, name: cur.title }).then(setRecent)
  }

  const closeTerm = (id: string): void =>
    setTermTabs((tabs) => closeTab(tabs, id, activeTerm, setActiveTerm))

  // 터미널 선택 → 활성화 + 완료(주목) 표시 해제
  const selectTerm = (id: string): void => {
    setActiveTerm(id)
    setTermAttention((s) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  // 터미널 작업 상태(진행중/완료/질문대기). 완료·질문 전이에서만 소리.
  const onTermStatus = (id: string, status: 'working' | 'done' | 'question'): void => {
    setTermStatus((m) => {
      const n = new Map(m)
      n.set(id, status)
      return n
    })
    if (status === 'working') {
      setTermAttention((s) => {
        if (!s.has(id)) return s
        const n = new Set(s)
        n.delete(id)
        return n
      })
    } else {
      beep()
      const bg = id !== activeTermRef.current
      if (bg) setTermAttention((s) => new Set(s).add(id))
      if (status === 'question' && bg) pushToast(id)
    }
  }

  // 질문/확인 대기 팝업(토스트)
  const toastSeq = useRef(0)
  const pushToast = (termId: string): void => {
    const t = termTabs.find((x) => x.id === termId)
    const key = ++toastSeq.current
    setToasts((ts) => [...ts.filter((x) => x.termId !== termId), { key, termId, title: t?.title ?? '세션' }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 12000)
  }
  const dismissToast = (key: number): void => setToasts((ts) => ts.filter((x) => x.key !== key))

  // Ctrl+Tab: 같은 종류 탭 순환 (터미널끼리 / 문서끼리)
  const cycleTerm = (dir: number): void => {
    if (termTabs.length < 2) return
    const i = termTabs.findIndex((t) => t.id === activeTerm)
    const ni = (((i < 0 ? 0 : i) + dir) % termTabs.length + termTabs.length) % termTabs.length
    selectTerm(termTabs[ni].id)
  }
  const cycleDoc = (dir: number): void => {
    if (docTabs.length < 2) return
    const i = docTabs.findIndex((t) => t.id === activeDoc)
    const ni = (((i < 0 ? 0 : i) + dir) % docTabs.length + docTabs.length) % docTabs.length
    setActiveDoc(docTabs[ni].id)
  }

  // 활성 사건(또는 마지막 사건)에 소송기록 폴더를 지정/탐색 → 뷰어 연결 + 페어링 기억.
  // 터미널이 닫혀 있어도 현재 사건 컨텍스트에 적용된다.
  const pickRecords = async (): Promise<void> => {
    const cur = termTabs.find((t) => t.id === activeTerm)
    const draftsForPair = cur?.cwd ?? currentCase?.drafts
    const r = await window.lt.dialog.pickFolder({
      title: '소송기록 폴더 선택',
      defaultPath: recordsRoot ?? currentCase?.records
    })
    if (!r) return
    if (cur) {
      setTermTabs((tabs) =>
        tabs.map((t) => (t.id === activeTerm ? { ...t, recordsFolder: r.path } : t))
      )
    }
    // 터미널 유무와 무관하게 현재 사건 컨텍스트에도 반영(뷰어가 이걸 참조)
    setCurrentCase((c) => (c ? { ...c, records: r.path } : c))
    if (draftsForPair) {
      window.lt.case.setPairing(draftsForPair, r.path)
      window.lt.case
        .addHistory({ drafts: draftsForPair, records: r.path, name: cur?.title ?? currentCase?.name ?? '사건' })
        .then(setRecent)
    }
  }

  const onOutline = (path: string, parsed: ParsedRecord): void => setPdfRecord({ path, parsed })
  const jumpToPage = (page: number): void => {
    jumpNonce.current += 1
    setPdfJump({ page, nonce: jumpNonce.current })
  }

  // 마지막으로 연 사건 컨텍스트 — 터미널을 모두 닫아도 유지(탐색기·뷰어·새 터미널 기준)
  const [currentCase, setCurrentCase] = useState<{
    drafts: string
    records?: string
    name: string
    meta?: CaseMeta
  } | null>(null)

  const activeDocTab = docTabs.find((t) => t.id === activeDoc)
  const activeTermTab = termTabs.find((t) => t.id === activeTerm)
  // 활성 터미널이 있으면 그 사건, 없으면(터미널 다 닫힘) 마지막 사건 컨텍스트 유지
  const activeDraftsFolder = activeTermTab?.cwd ?? currentCase?.drafts
  const activeRecordsFolder = activeTermTab?.recordsFolder ?? currentCase?.records
  const activeSuggestedRecords = activeTermTab?.suggestedRecords
  const isViewer = mode === 'viewer'

  // 외부 파일을 특정 폴더로 복사 (드래그앤드롭)
  const copyFilesTo = (dir: string, files: FileList): void => {
    const paths = Array.from(files)
      .map((f) => window.lt.fs.pathForFile(f))
      .filter(Boolean)
    if (!paths.length) return
    window.lt.fs.copyInto(dir, paths).then(() => setTreeRefresh((n) => n + 1))
  }
  const onDropFiles = (files: FileList): void => {
    if (activeDraftsFolder) copyFilesTo(activeDraftsFolder, files)
  }
  // 트리 내부 이동 (드래그앤드롭)
  const moveEntry = (src: string, destDir: string): void => {
    window.lt.fs.move(src, destDir).then((r) => {
      if (r.ok) setTreeRefresh((n) => n + 1)
      else if (r.error) console.warn('[move]', r.error)
    })
  }

  // 탐색기 인라인 생성: 버튼 → 트리에 입력칸 표시
  const newFile = (): void => (activeDraftsFolder ? setPendingCreate('file') : addDoc())
  const newFolder = (): void => {
    if (activeDraftsFolder) setPendingCreate('folder')
  }

  const onCreateEntry = (name: string, type: 'file' | 'folder'): void => {
    setPendingCreate(null)
    const dir = activeDraftsFolder
    if (!dir) return
    const n = name.trim()
    if (type === 'folder') {
      if (n) window.lt.fs.mkdir(dir, n).then(() => setTreeRefresh((x) => x + 1))
      return
    }
    // 파일: 이름 없으면 무제 스크래치(저장 시 이름 물어봄)
    if (!n) {
      const id = `doc-${++docSeq}`
      setDocTabs((t) => [...t, { id, title: '무제.md', kind: 'mdview' }])
      setActiveDoc(id)
      return
    }
    const fn = /\.[^.]+$/.test(n) ? n : n + '.md'
    window.lt.fs.createFile(dir, fn).then((r) => {
      if (r.ok && r.path) {
        setTreeRefresh((x) => x + 1)
        openFile(r.path, r.path.split(/[\\/]/).pop() ?? fn)
      }
    })
  }

  const activePdfPath = activeDocTab?.kind === 'pdf' ? activeDocTab.path : undefined
  const outlineRecord = pdfRecord && pdfRecord.path === activePdfPath ? pdfRecord.parsed : null
  // 패널 표시: 소송기록 폴더 분류(우선) → 없으면 열린 PDF의 목차
  const panelRecord = folderRecord ?? outlineRecord

  // 활성 PDF가 바뀌면 이전 점프 신호 제거 (새 뷰어에 stale 점프 방지)
  useEffect(() => {
    setPdfJump(undefined)
  }, [activePdfPath])

  // 소송기록 폴더의 PDF 파일명 파싱 → 문서/서증/첨부 분류
  useEffect(() => {
    if (!isViewer || !activeRecordsFolder) {
      setFolderRecord(null)
      return
    }
    let alive = true
    window.lt.fs.listPdfs(activeRecordsFolder).then((files) => {
      if (alive) setFolderRecord(parseRecordFiles(files))
    })
    return () => {
      alive = false
    }
  }, [isViewer, activeRecordsFolder])

  // 문서(파일) 순서: 본안 → 서증 → 첨부
  const recordOrder: OutlineItem[] = panelRecord
    ? [...panelRecord.documents, ...panelRecord.evidences, ...panelRecord.attachments].filter(
        (it) => it.path
      )
    : []
  const recordItems = recordOrder.map((it) => ({ path: it.path as string, label: it.label }))

  // 목록 항목 열기: 폴더 기록이면 그 문서를 '새 탭'으로 열기(이미 열렸으면 포커스),
  // 단일 PDF 목차면 현재 PDF 페이지 점프.
  const onOpenItem = (it: OutlineItem): void => {
    if (it.path) openFile(it.path, it.label)
    else if (it.page > 0) jumpToPage(it.page)
  }

  // 임의 터미널에 bracketed paste로 텍스트 주입 (줄바꿈이 바로 제출되지 않게).
  const pasteToTerm = (termId: string, payload: string): void => {
    window.lt.pty.write(termId, `\x1b[200~${payload}\x1b[201~`)
  }

  // Claude 질문 전송: 이 창에 터미널이 있으면 직접, 없으면(문서 전용 창) 메인 창 터미널로 IPC 전달.
  const activeTermRef = useRef(activeTerm)
  activeTermRef.current = activeTerm
  const sendClaude = (payload: string): void => {
    if (activeTerm) pasteToTerm(activeTerm, payload)
    else window.lt.claude.ask(payload)
  }
  // 메인 창: 다른 창에서 온 Claude 질문을 활성 터미널에 주입.
  useEffect(
    () =>
      window.lt.claude.onIncoming((payload) => {
        const term = activeTermRef.current
        if (term) pasteToTerm(term, payload)
      }),
    []
  )

  // 파일 1개를 "물어보기" 형태로 전송 (경로 포함 → claude가 실제 파일을 읽음).
  const askAboutFile = (termId: string, path: string, label: string): void => {
    pasteToTerm(termId, `「${label}」(${path}) 파일에 대해 `)
  }

  // 활성 문서명+경로 + (있으면) 선택 텍스트로 claude 프롬프트 주입. 텍스트 없으면 문서 전체에 대해 묻기.
  const askClaude = (text: string): void => {
    const d = docTabs.find((x) => x.id === activeDoc)
    const docName = d?.title
    const docPath = d?.path
    const ref = docName ? `「${docName}」${docPath ? `(${docPath})` : ''}` : ''
    const t = text.trim()
    let payload: string
    if (t) {
      payload = ref ? `${ref} 중 다음 부분:\n"${t}"\n\n` : `"${t}"\n\n`
    } else if (docName) {
      payload = `${ref} 파일에 대해 `
    } else return
    sendClaude(payload)
  }

  // ── 사건 대시보드 동작 ──
  // 토큰 변경 등으로 좌측 '다가오는 기일' 패널을 새로고침하기 위한 nonce
  const [jsNonce, setJsNonce] = useState(0)
  // 세션 목록 드롭다운 + 사건 필터('all' | jsId | '__folder__')
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  // claude 완료 주목 표시가 필요한 터미널 id 집합 + 진행중/완료 상태
  const [termAttention, setTermAttention] = useState<Set<string>>(new Set())
  const [termStatus, setTermStatus] = useState<Map<string, 'working' | 'done' | 'question'>>(
    new Map()
  )
  const [toasts, setToasts] = useState<{ key: number; termId: string; title: string }[]>([])
  const caseRef = (c: JsCase): string => `${c.caseNumber ?? ''} ${c.caseName ?? ''}`.trim() || c.id

  // 폴더명 자동 매칭 (사건번호 우선 → 사건명/당사자명 부분일치)
  const matchCaseFolder = async (root: string, c: JsCase): Promise<string | undefined> => {
    try {
      const list = await window.lt.fs.list(root)
      const dirs = list.filter((e) => e.isDir)
      const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
      if (c.caseNumber) {
        const no = norm(c.caseNumber)
        const hit = dirs.find((d) => norm(d.name).includes(no))
        if (hit) return hit.path
      }
      const keys = [c.caseName, ...c.parties.map((p) => p.party.name)]
        .filter(Boolean)
        .map((s) => norm(s as string))
        .filter((s) => s.length >= 2)
      const hit = dirs.find((d) => keys.some((k) => norm(d.name).includes(k)))
      return hit?.path
    } catch {
      return undefined
    }
  }

  // 좌클릭: 사건 작업환경 열기 (폴더 매칭 → 없으면 직접 지정 → 터미널/뷰어 연결)
  const openCaseWorkspace = async (c: JsCase): Promise<void> => {
    const saved = await window.lt.case.getJsPairing(c.id)
    let drafts = saved?.drafts
    let records = saved?.records
    if (!drafts && draftsRoot) drafts = await matchCaseFolder(draftsRoot, c)
    if (!records && recordsRoot) records = await matchCaseFolder(recordsRoot, c)
    if (!drafts) {
      // 자동 매칭 실패 → 사용자가 직접 작성서류 폴더 지정
      const picked = await window.lt.dialog.pickFolder({
        title: `「${caseRef(c)}」 작성서류 폴더 선택`,
        defaultPath: draftsRoot
      })
      if (!picked) return
      drafts = picked.path
    }
    await window.lt.case.setJsPairing(c.id, drafts, records)
    // 세션 자동 명명: 법원(약칭) · 사건번호 · 사건명
    const court = c.court || ''
    const client = c.parties
      .filter((p) => p.role === 'client')
      .map((p) => p.party.name)
      .join(', ')
    const name =
      [court && abbrevCourt(court), c.caseNumber, c.caseName, client].filter(Boolean).join(' ') ||
      caseRef(c)
    const meta: CaseMeta = {
      jsId: c.id,
      court: court || undefined,
      caseNumber: c.caseNumber || undefined,
      caseName: c.caseName || undefined,
      client: client || undefined
    }
    setCurrentCase({ drafts, records, name, meta })
    const existing = termTabs.find((t) => t.cwd === drafts || (t.jsId && t.jsId === c.id))
    if (existing) {
      setActiveTerm(existing.id)
      setTermTabs((tabs) =>
        tabs.map((t) =>
          t.id === existing.id
            ? { ...t, ...meta, title: name, recordsFolder: records ?? t.recordsFolder }
            : t
        )
      )
    } else {
      createCase(drafts, name, records, undefined, meta)
    }
    setMode('explorer')
  }

  // 우클릭: Claude에 사건 브리핑 요청
  const briefCaseToClaude = (c: JsCase): void => {
    sendClaude(
      `「${caseRef(c)}」 사건(JuriSupport id: ${c.id})의 다가오는 기일과 진행상황을 정리해줘.\n`
    )
  }
  // 우클릭: 준비서면 초안 시작 (/brief-protocol 슬래시커맨드)
  const draftCaseWithClaude = (c: JsCase): void => {
    sendClaude(`/brief-protocol ${caseRef(c)} `)
  }

  // 탐색기/외부에서 터미널로 드래그드롭한 파일들을 그 터미널 프롬프트에 주입.
  const dropFilesToTerm = (termId: string, paths: string[]): void => {
    if (!paths.length) return
    setActiveTerm(termId)
    if (paths.length === 1) {
      const p = paths[0]
      askAboutFile(termId, p, p.split(/[\\/]/).pop() ?? p)
    } else {
      pasteToTerm(termId, `다음 파일들에 대해:\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`)
    }
  }

  // 찢어낸 '문서 전용 창' 여부 (main이 새 창 URL에 #docOnly 해시를 붙임)
  const docOnly = window.location.hash.includes('docOnly')

  // 탭 드래그 중 여부 — 창 전체에서 '이동' 커서를 보이게 해 '금지' 표시를 막는다.
  const [tabDragging, setTabDragging] = useState(false)
  // 탭 드래그 중일 때 셸 어디서든 dragover를 허용(이동 커서) — 실제 찢기는 onDragEnd가 처리.
  const shellDragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!tabDragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: React.DragEvent) => {
      if (tabDragging) e.preventDefault()
    }
  }

  // 본문(문서) 렌더 — 전체 셸과 '문서 전용 창' 양쪽에서 재사용
  const docContent = (
    <>
      {!activeDocTab && <Empty label="열린 문서가 없습니다" actionLabel="새 문서" onAction={addDoc} />}
      {activeDocTab?.kind === 'welcome' && <Welcome recent={recent} onOpen={openRecent} />}
      {activeDocTab?.kind === 'markdown' && <DocPlaceholder title={activeDocTab.title} />}
      {activeDocTab?.kind === 'file' && (
        <FileView key={activeDocTab.path} path={activeDocTab.path as string} />
      )}
      {activeDocTab?.kind === 'image' && (
        <ImageViewer
          key={activeDocTab.path}
          path={activeDocTab.path as string}
          onNavigate={(dir) => navigateImage(activeDocTab.path as string, dir)}
        />
      )}
      {activeDocTab?.kind === 'hwp' && (
        <HwpView key={activeDocTab.path} path={activeDocTab.path as string} />
      )}
      {activeDocTab?.kind === 'csv' && (
        <CsvView key={activeDocTab.path} path={activeDocTab.path as string} />
      )}
      {activeDocTab?.kind === 'mdview' && (
        <MarkdownEditor
          key={activeDocTab.id}
          path={activeDocTab.path}
          defaultDir={draftsRoot}
          onPath={(p) => setDocPath(activeDocTab.id, p)}
          onAsk={() => askClaude('')}
        />
      )}
      {activeDocTab?.kind === 'pdf' &&
        (recordItems.some((i) => i.path === activeDocTab.path) ? (
          <RecordViewer
            key={activeDocTab.id}
            items={recordItems}
            startPath={activeDocTab.path as string}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onCurrent={(it) =>
              setDocTabs((tabs) =>
                tabs.map((t) =>
                  t.id === activeDocTab.id ? { ...t, path: it.path, title: it.label } : t
                )
              )
            }
            onAskDoc={() => askClaude('')}
          />
        ) : (
          <PdfViewer
            key={activeDocTab.path}
            path={activeDocTab.path as string}
            onOutline={onOutline}
            jumpTo={pdfJump}
            cropOn={cropOn}
            cropRatio={cropRatio}
            onCropOn={setCropOn}
            onCropRatio={setCropRatio}
            onAskDoc={() => askClaude('')}
          />
        ))}
      {activeDocTab?.kind === 'settings' && <SettingsView />}
    </>
  )

  const docTabBar = (
    <TabBar
      tabs={docTabs.map((t) => ({ id: t.id, title: t.title, tooltip: t.path, path: t.path }))}
      activeId={activeDoc}
      onSelect={setActiveDoc}
      onClose={closeDoc}
      onAdd={addDoc}
      addTitle="새 문서"
      onReorder={reorderDocs}
      onTearOut={closeDoc}
      onDragActive={setTabDragging}
    />
  )

  // 탭을 창 밖으로 찢어낸 '문서 전용 창': 터미널·탐색기·액티비티바 없이 문서만.
  if (docOnly) {
    return (
      <div className="shell-doconly" {...shellDragProps}>
        <div className="body-col">
          {docTabBar}
          <div className="doc-content">{docContent}</div>
        </div>
        <SelectionAsk onAsk={askClaude} />
        <SelectionMenu onAsk={askClaude} />
      </div>
    )
  }

  return (
    <div className={`shell ${isViewer ? 'mode-viewer' : 'mode-default'}`} {...shellDragProps}>
      {/* ── 액티비티바 (모드 전환) ── */}
      <div className="activitybar" key="activity">
        <div className="activitybar-top">
          {ACTIVITY.map((item) => (
            <button
              key={item.id}
              className={`activity-item ${mode === item.id ? 'active' : ''}`}
              title={item.label}
              onClick={() => setMode(item.id)}
            >
              <item.Icon />
            </button>
          ))}
        </div>
        <div className="activitybar-bottom">
          <button className="activity-item" title="설정" onClick={openSettings}>
            <IconSettings />
          </button>
        </div>
      </div>

      {/* ── 문서(좌측 목록) — 모드별 내용 ── */}
      <DocsPanel
        key="docs"
        mode={mode}
        draftsFolder={activeDraftsFolder}
        recordsFolder={activeRecordsFolder}
        suggestedRecords={activeSuggestedRecords}
        record={panelRecord}
        refreshNonce={treeRefresh}
        onOpenFile={openFile}
        onDropTo={copyFilesTo}
        onMove={moveEntry}
        onPickRecords={pickRecords}
        onApplySuggested={applySuggested}
        onOpenItem={onOpenItem}
        onDropFiles={onDropFiles}
        onNewFolder={newFolder}
        onNewFile={newFile}
        onOpenCase={openCaseWorkspace}
        jsNonce={jsNonce}
        pendingCreate={pendingCreate}
        onCreateEntry={onCreateEntry}
        onCancelCreate={() => setPendingCreate(null)}
      />

      {/* ── 본문(가운데) — 사건 모드는 대시보드, 그 외엔 문서 탭 ── */}
      <div className="body-col" key="body">
        {mode === 'cases' ? (
          <CasesDashboard
            onOpenWorkspace={openCaseWorkspace}
            onBrief={briefCaseToClaude}
            onDraft={draftCaseWithClaude}
            onChanged={() => setJsNonce((n) => n + 1)}
          />
        ) : (
          <>
            {docTabBar}
            <div className="doc-content">{docContent}</div>
          </>
        )}
      </div>

      {/* ── 서증·첨부서류 (뷰어 모드에서만) ── */}
      {isViewer && <EvidencePanel key="evid" record={panelRecord} onOpenItem={onOpenItem} />}

      {/* ── 터미널 (항상 동일 위치·세션 유지) ── */}
      <div className="term-col" key="terminal">
        <TabBar
          tabs={termTabs.map((t) => ({
            id: t.id,
            title: t.renamed
              ? t.title
              : t.sessionTitle
                ? `${t.title} · ${t.sessionTitle}`
                : t.title,
            attention: termAttention.has(t.id) && termStatus.get(t.id) !== 'question',
            working: termStatus.get(t.id) === 'working',
            question: termStatus.get(t.id) === 'question' && termAttention.has(t.id),
            tooltip: [
              t.court && `${t.court}`,
              t.caseNumber,
              t.caseName,
              t.client && `의뢰인 ${t.client}`,
              t.cwd
            ]
              .filter(Boolean)
              .join('\n')
          }))}
          activeId={activeTerm}
          onSelect={selectTerm}
          onClose={closeTerm}
          onAdd={addTermSame}
          addTitle="새 터미널"
          onRename={(id, title) =>
            setTermTabs((tabs) =>
              tabs.map((t) => (t.id === id ? { ...t, title, renamed: true } : t))
            )
          }
          extraLeft={{
            label: '☰',
            title: '세션 목록',
            active: sessionListOpen,
            onClick: () => {
              // 열 때 현재 세션의 사건으로 기본 필터
              const cur = termTabs.find((t) => t.id === activeTerm)
              setSessionFilter(cur?.jsId ?? 'all')
              setSessionListOpen((v) => !v)
            }
          }}
          extra={{ label: '📁', title: '사건 폴더 열기', onClick: () => void addTerm() }}
        />
        {sessionListOpen && (
          <SessionList
            sessions={termTabs}
            activeId={activeTerm}
            filter={sessionFilter}
            onFilter={setSessionFilter}
            caseCwd={currentCase?.drafts}
            onSelect={(id) => {
              selectTerm(id)
              setSessionListOpen(false)
            }}
            onResume={(sid, cwd, title) => {
              openPastSession(sid, cwd, title)
              setSessionListOpen(false)
            }}
            onClose={() => setSessionListOpen(false)}
          />
        )}
        <div className="term-stack">
          {termTabs.length === 0 &&
            (currentCase ? (
              <Empty
                label={`「${currentCase.name}」 — 터미널이 모두 닫혔습니다`}
                actionLabel="이 사건에서 터미널 열기"
                onAction={addTermSame}
              />
            ) : (
              <Empty
                label="사건 폴더를 열어 시작하세요 (작성문서 또는 사건기록 폴더)"
                actionLabel="사건 폴더 열기"
                onAction={addTerm}
              />
            ))}
          {termTabs.map((t) => (
            <div
              key={t.id}
              className="term-pane"
              style={{ display: t.id === activeTerm ? 'block' : 'none' }}
            >
              <Terminal
                id={t.id}
                cwd={t.cwd}
                autoClaude={t.autoClaude ?? false}
                resumeSessionId={t.resumeSessionId}
                visible={t.id === activeTerm}
                onDropPaths={(paths) => dropFilesToTerm(t.id, paths)}
                onNewTerminal={addTermSame}
                onStatus={(s) => onTermStatus(t.id, s)}
                onCycleTab={cycleTerm}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="statusbar" key="status">
        <span className="status-left">legal-terminal · {modeLabel(mode)}</span>
        <span className="status-right">{info}</span>
      </div>

      <SelectionAsk onAsk={askClaude} />
      <SelectionMenu onAsk={askClaude} />

      {/* claude 질문/확인 대기 팝업 */}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div
              key={t.key}
              className="toast"
              onClick={() => {
                selectTerm(t.termId)
                dismissToast(t.key)
              }}
            >
              <span className="toast-icon">❓</span>
              <span className="toast-body">
                <b>{t.title}</b>
                <span className="toast-sub">claude가 확인/입력을 기다립니다 — 클릭하여 이동</span>
              </span>
              <button
                className="toast-x"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissToast(t.key)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 본문에서 텍스트 선택 후 우클릭 → 컨텍스트 메뉴 (Claude/법제처/법고을/엘박스)
function SelectionMenu({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const onCtx = (e: MouseEvent): void => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      const node = sel?.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!text || !el?.closest?.('.body-col')) return // 선택 없으면 기본 메뉴
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, text })
    }
    const close = (): void => setMenu(null)
    document.addEventListener('contextmenu', onCtx)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('contextmenu', onCtx)
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  if (!menu) return null
  const q = encodeURIComponent(menu.text)
  const open = (url: string): void => void window.lt.app.openExternal(url)
  const items: { label: string; act: () => void }[] = [
    { label: '✳ Claude에 물어보기', act: () => onAsk(menu.text) },
    { label: '법제처 검색', act: () => open(`https://www.law.go.kr/LSW/lsSc.do?menuId=1&query=${q}`) },
    {
      label: '법고을 검색',
      act: () => open(`https://lx.scourt.go.kr/sc/krcom/sc/cs/search/cmmnSearchList.do?searchWord=${q}`)
    },
    { label: '엘박스 검색', act: () => open(`https://lbox.kr/search?query=${q}`) }
  ]
  return (
    <ul
      className="ctx-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 150) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <li
          key={i}
          className="ctx-item"
          onClick={() => {
            it.act()
            setMenu(null)
          }}
        >
          {it.label}
        </li>
      ))}
    </ul>
  )
}

// 본문에서 텍스트를 드래그 선택하면 떠오르는 "Claude에 묻기" 버튼
function SelectionAsk({ onAsk }: { onAsk: (text: string) => void }): JSX.Element | null {
  const [box, setBox] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const onUp = (): void => {
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      if (!sel || sel.rangeCount === 0 || !text.trim()) {
        setBox(null)
        return
      }
      const node = sel.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!el?.closest?.('.body-col')) {
        setBox(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setBox(null)
        return
      }
      setBox({ x: rect.left + rect.width / 2, y: rect.top - 6, text })
    }
    const onDown = (): void => setBox(null)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  if (!box) return null
  return (
    <button
      className="sel-ask"
      style={{ left: box.x, top: box.y }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={() => {
        onAsk(box.text)
        setBox(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      ✳ Claude에 묻기
    </button>
  )
}

function modeLabel(mode: Mode): string {
  return { explorer: '탐색기', cases: '사건', viewer: '기록뷰어' }[mode]
}

/** 탭 닫기 공통: 닫힌 탭이 활성이면 이웃으로 활성 이동 */
function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void
): T[] {
  const idx = tabs.findIndex((t) => t.id === id)
  const next = tabs.filter((t) => t.id !== id)
  if (id === activeId && next.length > 0) setActive(next[Math.min(idx, next.length - 1)].id)
  return next
}

// ── 좌측 문서 패널 (모드별) ──
// 탐색기 모드 = 작성서류 폴더 트리. 뷰어 모드 = 열린 PDF의 본안 문서 목차(없으면 소송기록 폴더 트리).
function DocsPanel({
  mode,
  draftsFolder,
  recordsFolder,
  suggestedRecords,
  record,
  refreshNonce,
  onOpenFile,
  onDropTo,
  onMove,
  onPickRecords,
  onApplySuggested,
  onOpenItem,
  onDropFiles,
  onNewFolder,
  onNewFile,
  onOpenCase,
  jsNonce,
  pendingCreate,
  onCreateEntry,
  onCancelCreate
}: {
  mode: Mode
  draftsFolder?: string
  recordsFolder?: string
  suggestedRecords?: string
  record: ParsedRecord | null
  refreshNonce: number
  onOpenFile: (path: string, name: string) => void
  onDropTo: (dir: string, files: FileList) => void
  onMove: (src: string, destDir: string) => void
  onPickRecords: () => void
  onApplySuggested: () => void
  onOpenItem: (it: OutlineItem) => void
  onDropFiles: (files: FileList) => void
  onNewFolder: () => void
  onNewFile: () => void
  onOpenCase: (c: JsCase) => void
  jsNonce: number
  pendingCreate: 'file' | 'folder' | null
  onCreateEntry: (name: string, type: 'file' | 'folder') => void
  onCancelCreate: () => void
}): JSX.Element {
  const title = { explorer: '탐색기', cases: '다가오는 기일', viewer: '문서' }[mode]
  const [dragOver, setDragOver] = useState(false)
  const canDrop = mode === 'explorer' && !!draftsFolder
  return (
    <div
      className={`sidebar ${dragOver ? 'drag-over' : ''}`}
      style={{ gridArea: 'docs' }}
      onDragOver={(e) => {
        if (!canDrop) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!canDrop) return
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files)
      }}
    >
      <div className="sidebar-header">
        <span>{title}</span>
        {mode === 'explorer' && draftsFolder && (
          <span className="header-actions">
            <button className="header-btn" title="새 파일" onClick={onNewFile}>
              ＋파일
            </button>
            <button className="header-btn" title="새 폴더" onClick={onNewFolder}>
              ＋폴더
            </button>
          </span>
        )}
        {mode === 'viewer' && recordsFolder && (
          <button className="header-btn" title="소송기록 폴더 변경" onClick={onPickRecords}>
            변경
          </button>
        )}
      </div>
      <div className="sidebar-body">
        {mode === 'explorer' &&
          (draftsFolder ? (
            <FileTree
              root={draftsFolder}
              refreshNonce={refreshNonce}
              onOpenFile={onOpenFile}
              onDropTo={onDropTo}
              onMove={onMove}
              pendingCreate={pendingCreate}
              onCreate={onCreateEntry}
              onCancelCreate={onCancelCreate}
            />
          ) : (
            <p className="muted pad">활성 사건이 없습니다. 오른쪽에서 사건 폴더를 여세요.</p>
          ))}
        {mode === 'viewer' &&
          (record ? (
            <>
              <CaseHeader record={record} />
              {record.documents.length ? (
                <OutlineList items={record.documents} onOpen={onOpenItem} />
              ) : (
                <p className="muted pad small">본안 문서가 없습니다.</p>
              )}
            </>
          ) : (
            <RecordsBody {...{ draftsFolder, suggestedRecords, onPickRecords, onApplySuggested }} />
          ))}
        {mode === 'cases' && <UpcomingHearings nonce={jsNonce} onPick={onOpenCase} />}
      </div>
    </div>
  )
}

// ── 서증·첨부서류 패널 (뷰어 모드) ──
function EvidencePanel({
  record,
  onOpenItem
}: {
  record: ParsedRecord | null
  onOpenItem: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <div className="evid-panel">
      <div className="sidebar-header">서증 · 첨부서류</div>
      <div className="sidebar-body">
        {record ? (
          <>
            <SectionLabel text={`서증 (${record.evidences.length})`} />
            {record.evidences.length ? (
              <OutlineList items={record.evidences} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">서증 없음</p>
            )}
            <SectionLabel text={`첨부서류 (${record.attachments.length})`} />
            {record.attachments.length ? (
              <OutlineList items={record.attachments} onOpen={onOpenItem} />
            ) : (
              <p className="muted pad small">첨부서류 없음</p>
            )}
          </>
        ) : (
          <p className="muted pad">소송기록 폴더를 지정하면 서증·첨부서류가 분류됩니다.</p>
        )}
      </div>
    </div>
  )
}

// 법원·사건번호 한 줄 (상단 1회 표시)
function CaseHeader({ record }: { record: ParsedRecord }): JSX.Element {
  return (
    <div className="case-header">
      {[record.court, record.caseNo].filter(Boolean).join(' · ') || '사건 정보 없음'}
    </div>
  )
}

function SectionLabel({ text }: { text: string }): JSX.Element {
  return <div className="section-label">{text}</div>
}

// 목차/서증 항목 리스트 — 클릭 시 파일 열기(폴더 기반) 또는 페이지 점프(목차 기반)
function OutlineList({
  items,
  onOpen
}: {
  items: OutlineItem[]
  onOpen: (it: OutlineItem) => void
}): JSX.Element {
  return (
    <ul className="outline-list">
      {items.map((it, i) => (
        <li
          key={i}
          className={`outline-item ${it.party ? 'party-' + it.party : ''}`}
          title={it.path ? `${it.rawTitle}\n(끌어서 터미널에 놓으면 Claude에 질문)` : it.rawTitle}
          onClick={() => onOpen(it)}
          draggable={!!it.path}
          onDragStart={
            it.path
              ? (e) => {
                  e.dataTransfer.setData(LT_PATH, it.path as string)
                  e.dataTransfer.effectAllowed = 'copyMove'
                }
              : undefined
          }
        >
          <span className="outline-label">{it.label}</span>
          {it.page > 0 && <span className="outline-page">{it.page}</span>}
        </li>
      ))}
    </ul>
  )
}

// 뷰어 모드: 소송기록 미지정 시 — 추천 폴더 제안(있으면) 또는 선택 버튼
function RecordsBody({
  draftsFolder,
  suggestedRecords,
  onPickRecords,
  onApplySuggested
}: {
  draftsFolder?: string
  suggestedRecords?: string
  onPickRecords: () => void
  onApplySuggested: () => void
}): JSX.Element {
  if (suggestedRecords)
    return (
      <div className="suggest pad">
        <p className="muted small">이전에 연결한 소송기록 폴더가 있습니다:</p>
        <p className="suggest-path">{suggestedRecords}</p>
        <div className="suggest-actions">
          <button className="empty-action" onClick={onApplySuggested}>
            이 폴더 열기
          </button>
          <button className="header-btn" onClick={onPickRecords}>
            다른 폴더…
          </button>
        </div>
      </div>
    )
  if (draftsFolder)
    return (
      <Empty
        label="이 사건의 소송기록 폴더가 지정되지 않았습니다"
        actionLabel="소송기록 폴더 선택"
        onAction={onPickRecords}
      />
    )
  return <p className="muted pad">사건을 먼저 여세요 (오른쪽 터미널의 ＋).</p>
}

interface TabBarProps {
  tabs: {
    id: string
    title: string
    tooltip?: string
    path?: string
    attention?: boolean
    working?: boolean
    question?: boolean
  }[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
  addTitle: string
  extra?: { label: string; title: string; onClick: () => void }
  extraLeft?: { label: string; title: string; active?: boolean; onClick: () => void }
  // 탭 재정렬(같은 창) + 창 간 이동/찢기. 둘 다 주어질 때만 탭이 draggable.
  onReorder?: (fromId: string, toId: string) => void
  onTearOut?: (id: string) => void
  onDragActive?: (active: boolean) => void
  onRename?: (id: string, title: string) => void
}
function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onAdd,
  addTitle,
  extra,
  extraLeft,
  onReorder,
  onTearOut,
  onDragActive,
  onRename
}: TabBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const dragId = useRef<string | null>(null)
  const draggable = !!onTearOut

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = (): void => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length])

  const scrollBy = (d: number): void => scrollRef.current?.scrollBy({ left: d, behavior: 'smooth' })

  return (
    <div className="tabs">
      {extraLeft && (
        <button
          className={`tab-add ${extraLeft.active ? 'on' : ''}`}
          title={extraLeft.title}
          onClick={(e) => {
            e.stopPropagation()
            extraLeft.onClick()
          }}
        >
          {extraLeft.label}
        </button>
      )}
      {overflow && (
        <button className="tab-scroll" title="왼쪽" onClick={() => scrollBy(-180)}>
          ‹
        </button>
      )}
      <div className="tabs-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''} ${t.attention ? 'attention' : ''} ${t.working ? 'working' : ''} ${t.question ? 'question' : ''}`}
            onClick={() => onSelect(t.id)}
            title={
              t.working
                ? `${t.tooltip ?? t.title}\n⟳ 작업 중`
                : t.question
                  ? `${t.tooltip ?? t.title}\n❓ 확인/질문 대기`
                  : t.attention
                    ? `${t.tooltip ?? t.title}\n✓ 완료`
                    : (t.tooltip ?? t.title)
            }
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    dragId.current = t.id
                    e.dataTransfer.effectAllowed = 'move'
                    onDragActive?.(true)
                    // 파일 기반 탭만 창 간 이동/찢기 가능 (경로 없으면 재정렬만)
                    if (t.path) window.lt.tabs.beginDrag({ path: t.path, title: t.title })
                  }
                : undefined
            }
            onDragOver={
              draggable
                ? (e) => {
                    if (dragId.current && dragId.current !== t.id) e.preventDefault()
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault()
                    if (dragId.current && dragId.current !== t.id) onReorder?.(dragId.current, t.id)
                    dragId.current = null
                  }
                : undefined
            }
            onDragEnd={
              draggable
                ? async () => {
                    const id = dragId.current
                    dragId.current = null
                    onDragActive?.(false)
                    if (!id || !t.path) return
                    const r = await window.lt.tabs.endDrag()
                    if (r?.action === 'moved') onTearOut?.(id)
                  }
                : undefined
            }
            onDoubleClick={
              onRename
                ? (e) => {
                    e.stopPropagation()
                    setEditing({ id: t.id, value: t.title })
                  }
                : undefined
            }
          >
            {t.working ? (
              <span className="tab-spin" title="작업 중">
                ⟳
              </span>
            ) : t.question ? (
              <span className="tab-q" title="확인/질문 대기">
                ❓
              </span>
            ) : (
              t.attention && (
                <span className="tab-dot" title="완료">
                  ●
                </span>
              )
            )}
            {editing?.id === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                value={editing.value}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename?.(t.id, editing.value.trim() || t.title)
                    setEditing(null)
                  } else if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => {
                  onRename?.(t.id, editing.value.trim() || t.title)
                  setEditing(null)
                }}
              />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            <button
              className="tab-close"
              title="닫기"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {overflow && (
        <button className="tab-scroll" title="오른쪽" onClick={() => scrollBy(180)}>
          ›
        </button>
      )}
      {extra && (
        <button className="tab-add" title={extra.title} onClick={extra.onClick}>
          {extra.label}
        </button>
      )}
      <button className="tab-add" title={addTitle} onClick={onAdd}>
        ＋
      </button>
    </div>
  )
}

// 세션(터미널) 목록 드롭다운 — 사건별 필터 + 선택
function SessionList({
  sessions,
  activeId,
  filter,
  onFilter,
  caseCwd,
  onSelect,
  onResume,
  onClose
}: {
  sessions: TermTab[]
  activeId: string
  filter: string
  onFilter: (f: string) => void
  caseCwd?: string
  onSelect: (id: string) => void
  onResume: (sessionId: string, cwd: string, title?: string) => void
  onClose: () => void
}): JSX.Element {
  const [past, setPast] = useState<{ sessionId: string; title?: string; mtime: number }[] | null>(
    null
  )

  useEffect(() => {
    const close = (): void => onClose()
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [onClose])

  // 필터 옵션: 전체 + 사건별(jsId) + 폴더 세션
  const caseOpts: { value: string; label: string }[] = []
  const seen = new Set<string>()
  let hasFolder = false
  for (const s of sessions) {
    if (s.jsId) {
      if (!seen.has(s.jsId)) {
        seen.add(s.jsId)
        caseOpts.push({
          value: s.jsId,
          label: [s.caseNumber, s.caseName].filter(Boolean).join(' ') || s.title
        })
      }
    } else hasFolder = true
  }
  const shown = sessions.filter((s) =>
    filter === 'all' ? true : filter === '__folder__' ? !s.jsId : s.jsId === filter
  )

  // 과거 세션을 읽을 cwd: 필터된 사건의 열린 세션 cwd → 없으면 현재 사건 cwd
  const filterCwd =
    filter !== 'all' && filter !== '__folder__'
      ? (sessions.find((s) => s.jsId === filter)?.cwd ?? caseCwd)
      : caseCwd

  useEffect(() => {
    if (!filterCwd) {
      setPast([])
      return
    }
    let alive = true
    setPast(null)
    window.lt.sessions.list(filterCwd).then((r) => alive && setPast(r))
    return () => {
      alive = false
    }
  }, [filterCwd])

  const fmt = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  }

  return (
    <div
      className="session-list"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sl-head">
        <span className="sl-title">세션</span>
        <select className="sl-filter" value={filter} onChange={(e) => onFilter(e.target.value)}>
          <option value="all">전체 사건</option>
          {caseOpts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {hasFolder && <option value="__folder__">폴더 세션</option>}
        </select>
      </div>
      <ul className="sl-list">
        <li className="sl-section">열린 세션</li>
        {shown.length === 0 && <li className="muted pad small">열린 세션이 없습니다.</li>}
        {shown.map((s) => (
          <li
            key={s.id}
            className={`sl-row ${s.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.cwd}
          >
            <span className="sl-name">{s.title}</span>
            <span className="sl-sub">
              {[s.client && `의뢰인 ${s.client}`, s.court].filter(Boolean).join(' · ') || s.cwd}
            </span>
          </li>
        ))}

        <li className="sl-section">과거 세션 (이어서 열기)</li>
        {!filterCwd && <li className="muted pad small">사건을 먼저 여세요.</li>}
        {filterCwd && past === null && <li className="muted pad small">불러오는 중…</li>}
        {filterCwd && past && past.length === 0 && (
          <li className="muted pad small">과거 세션이 없습니다.</li>
        )}
        {filterCwd &&
          past?.map((p) => (
            <li
              key={p.sessionId}
              className="sl-row past"
              onClick={() => onResume(p.sessionId, filterCwd, p.title)}
              title={`${p.sessionId}\nclaude --resume 로 이어서 열기`}
            >
              <span className="sl-name">↻ {p.title || '(제목 없음)'}</span>
              <span className="sl-sub">{fmt(p.mtime)}</span>
            </li>
          ))}
      </ul>
    </div>
  )
}

function Welcome({
  recent,
  onOpen
}: {
  recent: { drafts: string; records?: string; name: string; ts: number }[]
  onOpen: (e: { drafts: string; records?: string; name: string }) => void
}): JSX.Element {
  return (
    <div className="welcome">
      <h1>legal-terminal</h1>
      <p className="subtitle">Claude Code · Markdown 준비서면 · 전자소송기록 뷰어 — 한 화면에서</p>

      {recent.length > 0 && (
        <div className="recent">
          <h2 className="recent-title">최근 사건</h2>
          <ul className="recent-list">
            {recent.map((r) => (
              <li key={r.drafts} className="recent-item" onClick={() => onOpen(r)} title={r.drafts}>
                <span className="recent-name">⚖️ {r.name}</span>
                {r.records && <span className="recent-tag">기록 연결됨</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="welcome-list">
        <li>📁 <b>탐색기 모드</b> — 작성서류 폴더의 파일트리에서 문서를 본문에 엽니다</li>
        <li>📄 <b>기록뷰어 모드</b> — 문서 | 본문 | 서증·첨부서류 | 터미널</li>
        <li>✳️ <b>Claude</b> — 오른쪽 터미널에서 <code>/brief-protocol</code> 실행 (모드 전환에도 유지)</li>
      </ul>
    </div>
  )
}

function DocPlaceholder({ title }: { title: string }): JSX.Element {
  return (
    <div className="welcome">
      <h2>{title}</h2>
      <p className="muted">M2에서 Monaco Markdown 에디터 + 라이브 프리뷰가 여기에 들어갑니다.</p>
    </div>
  )
}

/** 텍스트 문서 표시 — 자동 줄바꿈 기본 ON(토글) */
function TextDoc({ text, note }: { text: string; note?: string }): JSX.Element {
  const [wrap, setWrap] = useState(true)
  return (
    <div className="text-doc">
      <div className="text-toolbar">
        <button
          className={`tb-btn ${wrap ? 'on' : ''}`}
          title="자동 줄바꿈"
          onClick={() => setWrap((w) => !w)}
        >
          줄바꿈
        </button>
      </div>
      <pre className={`file-view ${wrap ? 'wrap' : ''}`}>
        {text}
        {note ? '\n\n' + note : ''}
      </pre>
    </div>
  )
}

/** 텍스트 파일 미리보기 (md/txt/csv/json…). MD 옵시디언식 라이브 프리뷰는 추후 CodeMirror로. */
function FileView({ path }: { path: string }): JSX.Element {
  const [state, setState] = useState<{
    loading: boolean
    text: string
    binary: boolean
    truncated: boolean
    err: string
  }>({ loading: true, text: '', binary: false, truncated: false, err: '' })

  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', binary: false, truncated: false, err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          text: r.text,
          binary: r.kind === 'binary',
          truncated: !!r.truncated,
          err: ''
        })
      })
      .catch((e) => alive && setState((s) => ({ ...s, loading: false, err: String(e) })))
    return () => {
      alive = false
    }
  }, [path])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>
  if (state.binary)
    return (
      <div className="welcome">
        <p className="muted">텍스트로 미리볼 수 없는 형식입니다.</p>
      </div>
    )
  return <TextDoc text={state.text} note={state.truncated ? '… (이하 생략, 2MB 초과)' : undefined} />
}

/** HWP(.hwp) — 텍스트만 추출해 표시 */
function HwpView({ path }: { path: string }): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; text: string; err: string }>({
    loading: true,
    text: '',
    err: ''
  })
  useEffect(() => {
    let alive = true
    setState({ loading: true, text: '', err: '' })
    window.lt.fs
      .readHwpText(path)
      .then((r) => {
        if (!alive) return
        setState({ loading: false, text: r.text, err: r.ok ? '' : r.error || '추출 실패' })
      })
      .catch((e) => alive && setState({ loading: false, text: '', err: String(e) }))
    return () => {
      alive = false
    }
  }, [path])
  if (state.loading) return <div className="welcome"><p className="muted">HWP 텍스트 추출 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">{state.err}</p></div>
  return <TextDoc text={state.text} />
}

// CSV 파싱 (따옴표·구분자 처리)
function parseCsv(text: string, delim: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.length))
}

function detectDelim(firstLine: string): string {
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ','
}

/** CSV — 표(기본) / 색상 텍스트(열별 색상) */
function CsvView({ path }: { path: string }): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; rows: string[][]; err: string }>({
    loading: true,
    rows: [],
    err: ''
  })
  const [mode, setMode] = useState<'table' | 'color'>('table')

  useEffect(() => {
    let alive = true
    setState({ loading: true, rows: [], err: '' })
    window.lt.fs
      .readText(path)
      .then((r) => {
        if (!alive) return
        const text = r.text.replace(/^﻿/, '')
        const delim = detectDelim(text.split('\n')[0] ?? '')
        setState({ loading: false, rows: parseCsv(text, delim), err: '' })
      })
      .catch((e) => alive && setState({ loading: false, rows: [], err: String(e) }))
    return () => {
      alive = false
    }
  }, [path])

  if (state.loading) return <div className="welcome"><p className="muted">불러오는 중…</p></div>
  if (state.err) return <div className="welcome"><p className="muted">열기 실패: {state.err}</p></div>

  const [header, ...body] = state.rows
  return (
    <div className="text-doc">
      <div className="text-toolbar">
        <button className={`tb-btn ${mode === 'table' ? 'on' : ''}`} onClick={() => setMode('table')}>
          표
        </button>
        <button className={`tb-btn ${mode === 'color' ? 'on' : ''}`} onClick={() => setMode('color')}>
          색상
        </button>
        <span className="tb-sep-text">{state.rows.length}행</span>
      </div>
      <div className="csv-wrap">
        {mode === 'table' ? (
          <table className="csv-table">
            {header && (
              <thead>
                <tr>
                  {header.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={`csv-c${ci % 8}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="csv-color">
            {state.rows.map((r, ri) => (
              <div key={ri}>
                {r.map((c, ci) => (
                  <span key={ci}>
                    <span className={`csv-c${ci % 8}`}>{c}</span>
                    {ci < r.length - 1 && <span className="csv-delim">,</span>}
                  </span>
                ))}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 이미지 뷰어 — 폭맞춤(기본)/원본, Ctrl+휠 줌 */
function ImageViewer({
  path,
  onNavigate
}: {
  path: string
  onNavigate?: (dir: 1 | -1) => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'fit_page' | 'fit_width' | 'custom'>('fit_page')
  const [scale, setScale] = useState(1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navLock = useRef(false)

  useEffect(() => {
    let alive = true
    let made = ''
    setErr('')
    window.lt.fs
      .readBytes(path)
      .then((ab) => {
        if (!alive) return
        made = URL.createObjectURL(new Blob([ab]))
        setUrl(made)
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [path])

  const zoomBy = (f: number): void => {
    setMode('custom')
    setScale((s) => Math.max(0.1, Math.min(8, +(s * f).toFixed(3))))
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
      return
    }
    // 스크롤이 끝(위/아래)에 닿으면 정렬순 이전/다음 이미지로 이동
    const el = wrapRef.current
    if (!el || !onNavigate) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const atTop = el.scrollTop <= 2
    if (e.deltaY > 0 && atBottom && !navLock.current) {
      navLock.current = true
      onNavigate(1)
      setTimeout(() => (navLock.current = false), 400)
    } else if (e.deltaY < 0 && atTop && !navLock.current) {
      navLock.current = true
      onNavigate(-1)
      setTimeout(() => (navLock.current = false), 400)
    }
  }

  const imgStyle: React.CSSProperties =
    mode === 'fit_page'
      ? { maxWidth: '100%', maxHeight: '100%' }
      : mode === 'fit_width'
        ? { width: '100%', height: 'auto' }
        : { width: `${scale * 100}%`, height: 'auto' }

  if (err) return <div className="welcome"><p className="muted">이미지 열기 실패: {err}</p></div>
  return (
    <div className="image-doc">
      <div className="pdf-toolbar">
        <button
          className={`tb-btn ${mode === 'fit_page' ? 'on' : ''}`}
          title="쪽 맞춤"
          onClick={() => setMode('fit_page')}
        >
          쪽맞춤
        </button>
        <button
          className={`tb-btn ${mode === 'fit_width' ? 'on' : ''}`}
          title="폭 맞춤"
          onClick={() => setMode('fit_width')}
        >
          폭맞춤
        </button>
        <button className="tb-btn" title="축소" onClick={() => zoomBy(1 / 1.1)}>
          －
        </button>
        <button className="tb-btn pct" onClick={() => setMode('fit_page')}>
          {mode === 'custom' ? `${Math.round(scale * 100)}%` : '맞춤'}
        </button>
        <button className="tb-btn" title="확대" onClick={() => zoomBy(1.1)}>
          ＋
        </button>
      </div>
      <div className={`image-wrap ${mode === 'fit_page' ? 'center' : ''}`} ref={wrapRef} onWheel={onWheel}>
        {url && <img src={url} style={imgStyle} alt="" />}
      </div>
    </div>
  )
}

function SettingsView(): JSX.Element {
  const [s, setS] = useState<{
    draftsRoot?: string
    recordsRoot?: string
    pdfZoom?: string
    termFont?: string
    termFontSize?: number
    mdFont?: string
    mdFontSize?: number
  }>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.lt.settings.get().then((v) => {
      setS(v)
      setLoaded(true)
    })
  }, [])

  const pick = async (key: 'draftsRoot' | 'recordsRoot'): Promise<void> => {
    const title =
      key === 'draftsRoot'
        ? '작성서류 루트 폴더 선택 (모든 사건)'
        : '소송기록 루트 폴더 선택 (사건별 전자소송기록)'
    const r = await window.lt.dialog.pickFolder({ title, defaultPath: s[key] })
    if (!r) return
    const next = await window.lt.settings.set({ [key]: r.path })
    setS(next)
  }

  return (
    <div className="settings">
      <h1>설정</h1>
      <p className="muted">사건을 열 때 두 폴더를 자동으로 짝지으려면 아래 두 루트를 지정하세요.</p>

      <section className="setting-row">
        <div className="setting-label">
          작성서류 루트 <span className="muted small">— 모든 사건의 작성서류 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.draftsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('draftsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          소송기록 루트 <span className="muted small">— 사건별 전자소송기록 상위 폴더</span>
        </div>
        <div className="setting-value">
          <code>{s.recordsRoot ?? '미설정'}</code>
          <button className="empty-action" onClick={() => pick('recordsRoot')}>
            폴더 선택
          </button>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          PDF 기본 배율 <span className="muted small">— 전자소송기록을 열 때 적용</span>
        </div>
        <div className="setting-value">
          <select
            className="setting-select"
            value={s.pdfZoom ?? 'fit_page'}
            onChange={async (e) => {
              const next = await window.lt.settings.set({ pdfZoom: e.target.value })
              setS(next)
            }}
          >
            <option value="fit_page">쪽 맞춤</option>
            <option value="fit_width">폭 맞춤</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
            <option value="200">200%</option>
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          터미널 폰트 <span className="muted small">— 새 터미널부터 적용</span>
        </div>
        <div className="setting-value">
          <input
            className="setting-input"
            placeholder="예: Cascadia Mono, D2Coding, Consolas"
            defaultValue={s.termFont ?? ''}
            onBlur={async (e) => {
              const next = await window.lt.settings.set({ termFont: e.target.value.trim() })
              setS(next)
            }}
          />
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">터미널 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={s.termFontSize ?? 13}
            onChange={async (e) => {
              const n = parseInt(e.target.value, 10)
              if (Number.isNaN(n)) return
              const next = await window.lt.settings.set({ termFontSize: Math.min(32, Math.max(8, n)) })
              setS(next)
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          마크다운 폰트 <span className="muted small">— 편집기(원본/서식)에 적용</span>
        </div>
        <div className="setting-value">
          <input
            className="setting-input"
            placeholder="예: D2Coding, Malgun Gothic, Consolas"
            defaultValue={s.mdFont ?? ''}
            onBlur={async (e) => {
              const next = await window.lt.settings.set({ mdFont: e.target.value.trim() })
              setS(next)
            }}
          />
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">마크다운 글자 크기</div>
        <div className="setting-value">
          <input
            className="setting-input narrow"
            type="number"
            min={8}
            max={32}
            value={s.mdFontSize ?? 14}
            onChange={async (e) => {
              const n = parseInt(e.target.value, 10)
              if (Number.isNaN(n)) return
              const next = await window.lt.settings.set({ mdFontSize: Math.min(32, Math.max(8, n)) })
              setS(next)
            }}
          />
          <span className="muted small">px</span>
        </div>
      </section>

      <p className="muted small">{loaded ? '변경 즉시 저장됩니다 (마크다운은 새로 열 때 적용).' : '불러오는 중…'}</p>
    </div>
  )
}

function Empty({
  label,
  actionLabel,
  onAction
}: {
  label: string
  actionLabel: string
  onAction: () => void
}): JSX.Element {
  return (
    <div className="empty">
      <p className="muted">{label}</p>
      <button className="empty-action" onClick={onAction}>
        ＋ {actionLabel}
      </button>
    </div>
  )
}
