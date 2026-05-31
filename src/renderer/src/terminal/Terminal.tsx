import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { LT_PATH } from '../filetree/FileTree'

// D2Coding(번들, 한글:영문=2:1 고정폭)을 우선 — 한글/영문 폭이 한 폰트로 통일되어 정렬이 맞는다.
const DEFAULT_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"

/**
 * 하나의 사건 터미널. main의 node-pty(powershell)를 띄우고 자동으로 `claude`를 실행한다.
 * 폰트/글자크기는 설정(termFont, termFontSize)에서 읽는다(새 터미널에 적용).
 */
export default function Terminal({
  id,
  cwd,
  visible,
  autoClaude = false,
  resumeSessionId,
  onDropPaths,
  onNewTerminal,
  onStatus,
  onCycleTab
}: {
  id: string
  cwd?: string
  visible: boolean
  autoClaude?: boolean
  resumeSessionId?: string
  onDropPaths?: (paths: string[]) => void
  onNewTerminal?: () => void
  onStatus?: (status: 'working' | 'done' | 'question') => void
  onCycleTab?: (dir: number) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onDropRef = useRef(onDropPaths)
  onDropRef.current = onDropPaths
  const onNewTermRef = useRef(onNewTerminal)
  onNewTermRef.current = onNewTerminal
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onCycleRef = useRef(onCycleTab)
  onCycleRef.current = onCycleTab

  // 파일 드롭(탐색기/OS) → 경로 추출 후 콜백. xterm 내부보다 먼저 잡도록 캡처 단계 네이티브 리스너.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wanted = (dt: DataTransfer | null): boolean =>
      !!dt && (dt.types.includes(LT_PATH) || dt.types.includes('Files'))
    const allow = (e: DragEvent): void => {
      if (!wanted(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer
      if (!wanted(dt)) return
      e.preventDefault()
      e.stopPropagation()
      const internal = dt!.getData(LT_PATH)
      const paths = internal
        ? [internal]
        : Array.from(dt!.files)
            .map((f) => window.lt.fs.pathForFile(f))
            .filter(Boolean)
      if (paths.length) onDropRef.current?.(paths)
    }
    host.addEventListener('dragenter', allow, true)
    host.addEventListener('dragover', allow, true)
    host.addEventListener('drop', onDrop, true)
    return () => {
      host.removeEventListener('dragenter', allow, true)
      host.removeEventListener('dragover', allow, true)
      host.removeEventListener('drop', onDrop, true)
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let cleanup: () => void = () => {}

    window.lt.settings.get().then(async (s) => {
      const fontSize = s.termFontSize || 13
      // 번들 폰트가 로드된 뒤 xterm을 생성해야 글자 폭 측정이 정확하다.
      try {
        await document.fonts.load(`${fontSize}px "D2Coding"`)
      } catch {
        /* 폰트 로드 실패 시 폴백 폰트 사용 */
      }
      const mount = hostRef.current
      if (disposed || !mount) return

      const term = new XTerm({
        fontFamily: s.termFont || DEFAULT_FONT,
        fontSize: fontSize,
        cursorBlink: true,
        allowProposedApi: true,
        // ConPTY(node-pty) 백엔드임을 알려 커서 열 추적/리플로우를 정확히 (IME 조합 위치 어긋남 완화)
        windowsPty: { backend: 'conpty', buildNumber: 22621 },
        theme: { background: '#181818', foreground: '#cccccc', cursor: '#cccccc' }
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(mount)
      // 렌더러: VS Code 터미널과 동일하게 WebGL 우선(한글 정렬·IME 처리 우수), 실패 시 Canvas → DOM
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        try {
          term.loadAddon(new CanvasAddon())
        } catch {
          /* 기본 DOM 렌더러 유지 */
        }
      }
      fit.fit()
      termRef.current = term
      fitRef.current = fit
      // 새 터미널 생성 직후 활성 탭이면 바로 포커스 (커서가 그 터미널 안에 들어가게)
      if (visible) term.focus()

      // 붙여넣기: 셸/claude가 줄바꿈을 즉시 실행하지 않도록 bracketed paste로 감싼다.
      const pasteFromClipboard = (): void => {
        navigator.clipboard.readText().then((txt) => {
          if (txt) window.lt.pty.write(id, `\x1b[200~${txt}\x1b[201~`)
        })
      }
      // 복사/붙여넣기 키 처리. true=xterm/pty로 전달, false=가로채서 기본동작 차단.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown' || !e.ctrlKey) return true
        const k = e.key.toLowerCase()
        if (k === 't' && !e.shiftKey && !e.altKey) {
          // Ctrl+T: 새 터미널 (같은 사건, claude 실행)
          e.stopPropagation()
          onNewTermRef.current?.()
          return false
        }
        if (k === 'tab') {
          // Ctrl+Tab / Ctrl+Shift+Tab: 터미널 탭 순환
          e.stopPropagation()
          onCycleRef.current?.(e.shiftKey ? -1 : 1)
          return false
        }
        if (k === 'pageup' || k === 'pagedown') {
          // Ctrl+PageUp/PageDown: 터미널 탭 이동
          e.stopPropagation()
          onCycleRef.current?.(k === 'pageup' ? -1 : 1)
          return false
        }
        if (k === 'c') {
          const sel = term.getSelection()
          if (sel && (e.shiftKey || !e.altKey)) {
            // 선택이 있으면 복사하고 차단 (선택 없을 땐 통과 → Ctrl+C 인터럽트 유지)
            navigator.clipboard.writeText(sel)
            return false
          }
          if (e.shiftKey) return false // Ctrl+Shift+C: 선택 없으면 무동작
          return true // 선택 없는 Ctrl+C → 인터럽트
        }
        if (k === 'v') {
          pasteFromClipboard()
          return false
        }
        return true
      })
      // 우클릭: 선택 있으면 복사, 없으면 붙여넣기 (VS Code 터미널과 동일)
      const onCtx = (ev: MouseEvent): void => {
        ev.preventDefault()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
          term.clearSelection()
        } else {
          pasteFromClipboard()
        }
      }
      mount.addEventListener('contextmenu', onCtx)

      window.lt.pty.create({
        id,
        cwd,
        cols: term.cols,
        rows: term.rows,
        autoLaunchClaude: autoClaude,
        resumeSessionId
      })

      // 진행중/완료 감지:
      // claude는 작업 중 "esc to interrupt" 스피너를 계속 그린다 → 그게 보이면 working,
      // 출력이 멈추면(스피너 사라짐) done. 완료(working→done) 전이에서만 onStatus('done').
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let working = false
      let recent = '' // 최근 출력(ANSI 제거 전) — 질문/확인 프롬프트 감지용
      const BUSY_RE = /to interrupt/i
      // claude 권한/확인 프롬프트 패턴
      const QUESTION_RE = /(do you want to|❯\s*1\.|\b1\.\s*yes\b|\(y\/n\)|\by\/n\b)/i
      const stripAnsi = (s: string): string => s.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
      const goIdle = (): void => {
        if (!working) return
        working = false
        const isQuestion = QUESTION_RE.test(stripAnsi(recent))
        onStatusRef.current?.(isQuestion ? 'question' : 'done')
      }
      const offData = window.lt.pty.onData((p) => {
        if (p.id !== id) return
        term.write(p.data)
        const busy = BUSY_RE.test(p.data)
        if (busy && !working) {
          working = true
          recent = ''
          onStatusRef.current?.('working')
        }
        if (busy || working) {
          recent = (recent + p.data).slice(-4000)
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(goIdle, 1200)
        }
      })
      const offExit = window.lt.pty.onExit((p) => {
        if (p.id === id) term.write(`\r\n\x1b[90m[프로세스 종료: ${p.exitCode}]\x1b[0m\r\n`)
      })
      const onInput = term.onData((data) => window.lt.pty.write(id, data))
      // claude가 벨(BEL)을 보내면 즉시 완료 판정(질문 여부 포함)
      const onBellDisp = term.onBell(() => {
        if (working) goIdle()
        else onStatusRef.current?.('done')
      })

      const doResize = (): void => {
        // 숨겨진(display:none) 동안엔 크기가 0으로 측정돼 pty가 좁게 줄어든다 → 건너뛴다.
        if (!mount.offsetWidth || !mount.offsetHeight) return
        try {
          fit.fit()
          window.lt.pty.resize(id, term.cols, term.rows)
        } catch {
          /* 무시 */
        }
      }
      const ro = new ResizeObserver(doResize)
      ro.observe(mount)

      cleanup = (): void => {
        offData()
        offExit()
        onInput.dispose()
        onBellDisp.dispose()
        if (idleTimer) clearTimeout(idleTimer)
        mount.removeEventListener('contextmenu', onCtx)
        ro.disconnect()
        window.lt.pty.kill(id)
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    })

    return () => {
      disposed = true
      cleanup()
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 보이게 될 때 재핏 + 포커스
  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      try {
        fit.fit()
        window.lt.pty.resize(id, term.cols, term.rows)
        term.focus()
      } catch {
        /* 무시 */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, id])

  return <div className="xterm-host" ref={hostRef} />
}
