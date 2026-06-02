import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { LT_PATH } from '../filetree/FileTree'
import type { SshConn } from '../env'
import FindBar from '../search/FindBar'

// D2Coding(번들, 한글:영문=2:1 고정폭)을 우선 — 한글/영문 폭이 한 폰트로 통일되어 정렬이 맞는다.
const DEFAULT_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"

// PTY 입력에서 Enter는 LF(\n)가 아니라 CR(\r)이다. LF만 보내면 다음 줄이 같은
// 커서 열에서 시작해 멀티라인 paste가 들여쓰기처럼 보일 수 있다.
const normalizePasteForPty = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r')

const WIN_IME_FIX_CLASS = 'lt-win-ime-fix'
const WIN_IME_COMPOSING_CLASS = 'lt-ime-composing'

interface TerminalFindMatch {
  row: number
  col: number
  length: number
}

const charCellWidth = (ch: string): number => (ch.charCodeAt(0) <= 0x7f ? 1 : 2)
const textCellWidth = (text: string): number => Array.from(text).reduce((n, ch) => n + charCellWidth(ch), 0)
const stringIndexToCell = (text: string, index: number): number => textCellWidth(text.slice(0, index))

const getTerminalMatches = (term: XTerm, query: string): TerminalFindMatch[] => {
  const needle = query.trim()
  if (!needle) return []
  const target = needle.toLocaleLowerCase('ko-KR')
  const out: TerminalFindMatch[] = []
  const buffer = term.buffer.active
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)?.translateToString(true) ?? ''
    const haystack = line.toLocaleLowerCase('ko-KR')
    let index = haystack.indexOf(target)
    while (index >= 0 && out.length < 2000) {
      out.push({ row, col: stringIndexToCell(line, index), length: textCellWidth(needle) })
      index = haystack.indexOf(target, index + Math.max(needle.length, 1))
    }
  }
  return out
}

const measureCellWidth = (term: XTerm): number | null => {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const width = screen?.getBoundingClientRect().width ?? 0
  if (!width || !term.cols) return null
  return width / term.cols
}

const installWindowsImeCorrection = (term: XTerm, platform: string): (() => void) => {
  if (platform !== 'win32' || !term.element || !term.textarea) return () => {}

  const element = term.element
  const textarea = term.textarea
  let active = true
  element.classList.add(WIN_IME_FIX_CLASS)

  const syncCorrection = (): void => {
    if (!active || !element.classList.contains(WIN_IME_COMPOSING_CLASS)) return
    const cellWidth = measureCellWidth(term)
    const cursorX = term.buffer.active.cursorX
    const offset = cellWidth && cursorX > 0 ? cellWidth : 0
    element.style.setProperty('--lt-ime-cell-width', `${offset}px`)
  }

  const scheduleCorrection = (): void => {
    syncCorrection()
    requestAnimationFrame(syncCorrection)
    window.setTimeout(syncCorrection, 0)
  }

  const onCompositionStart = (): void => {
    element.classList.add(WIN_IME_COMPOSING_CLASS)
    scheduleCorrection()
  }
  const onCompositionUpdate = (): void => scheduleCorrection()
  const onCompositionEnd = (): void => {
    element.classList.remove(WIN_IME_COMPOSING_CLASS)
    element.style.setProperty('--lt-ime-cell-width', '0px')
  }

  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionupdate', onCompositionUpdate)
  textarea.addEventListener('compositionend', onCompositionEnd)
  textarea.addEventListener('blur', onCompositionEnd)
  const renderSync = term.onRender(syncCorrection)
  const resizeSync = term.onResize(syncCorrection)

  return () => {
    active = false
    textarea.removeEventListener('compositionstart', onCompositionStart)
    textarea.removeEventListener('compositionupdate', onCompositionUpdate)
    textarea.removeEventListener('compositionend', onCompositionEnd)
    textarea.removeEventListener('blur', onCompositionEnd)
    renderSync.dispose()
    resizeSync.dispose()
    element.classList.remove(WIN_IME_FIX_CLASS, WIN_IME_COMPOSING_CLASS)
    element.style.removeProperty('--lt-ime-cell-width')
  }
}

/**
 * 하나의 사건 터미널. main의 node-pty(플랫폼 기본 셸)를 띄우고 자동으로 `claude`를 실행한다.
 * 폰트/글자크기는 설정(termFont, termFontSize)에서 읽는다(새 터미널에 적용).
 */
export default function Terminal({
  id,
  cwd,
  visible,
  autoClaude = false,
  resumeSessionId,
  ssh,
  focusNonce = 0,
  onDropPaths,
  onNewTerminal,
  onRequestClose,
  onStatus,
  onCycleTab
}: {
  id: string
  cwd?: string
  visible: boolean
  autoClaude?: boolean
  resumeSessionId?: string
  ssh?: SshConn
  focusNonce?: number
  onDropPaths?: (paths: string[]) => void
  onNewTerminal?: () => void
  onRequestClose?: () => void
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
  const onCloseRef = useRef(onRequestClose)
  onCloseRef.current = onRequestClose
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onCycleRef = useRef(onCycleTab)
  onCycleRef.current = onCycleTab
  const findOpenRef = useRef(false)
  const findQueryRef = useRef('')
  const findIndexRef = useRef(-1)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIndex, setFindIndex] = useState(-1)

  const setFindOpenState = (value: boolean): void => {
    findOpenRef.current = value
    setFindOpen(value)
  }
  const setFindQueryState = (value: string): void => {
    findQueryRef.current = value
    setFindQuery(value)
  }
  const setFindIndexState = (value: number): void => {
    findIndexRef.current = value
    setFindIndex(value)
  }

  const applyFind = (query: string, requestedIndex: number): void => {
    const term = termRef.current
    if (!term) return
    const matches = getTerminalMatches(term, query)
    const index = matches.length
      ? (requestedIndex < 0 ? 0 : (requestedIndex + matches.length) % matches.length)
      : -1
    setFindCount(matches.length)
    setFindIndexState(index)
    if (index >= 0) {
      const match = matches[index]
      term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 3)))
      term.select(match.col, match.row, match.length)
    } else {
      term.clearSelection()
    }
  }

  const openFind = (): void => {
    const selected = termRef.current?.getSelection().trim()
    if (selected && selected.length <= 120 && !/[\r\n]/.test(selected)) setFindQueryState(selected)
    setFindOpenState(true)
    setFindIndexState(0)
  }

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

    Promise.all([window.lt.settings.get(), window.lt.app.info()]).then(async ([s, appInfo]) => {
      const fontSize = s.termFontSize || 13
      const isMac = appInfo.platform === 'darwin'
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
        ...(appInfo.platform === 'win32'
          ? {
              // ConPTY(node-pty) 백엔드임을 알려 커서 열 추적/리플로우를 정확히 (IME 조합 위치 어긋남 완화)
              windowsPty: { backend: 'conpty' as const, buildNumber: 22621 }
            }
          : {}),
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
      const cleanupWindowsImeCorrection = installWindowsImeCorrection(term, appInfo.platform)
      // 새 터미널 생성 직후 활성 탭이면 바로 포커스 (커서가 그 터미널 안에 들어가게)
      if (visible) term.focus()

      // 붙여넣기: 셸/claude가 줄바꿈을 즉시 실행하지 않도록 bracketed paste로 감싼다.
      const pasteText = (txt: string): void => {
        const normalized = normalizePasteForPty(txt)
        if (normalized) window.lt.pty.write(id, `\x1b[200~${normalized}\x1b[201~`)
      }
      const pasteFromClipboard = (): void => {
        navigator.clipboard.readText().then((txt) => {
          pasteText(txt)
        })
      }
      // 복사/붙여넣기 키 처리. true=xterm/pty로 전달, false=가로채서 기본동작 차단.
      term.attachCustomKeyEventHandler((e) => {
        const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey
        if (e.type !== 'keydown' || !primary) return true
        const k = e.key.toLowerCase()
        if (k === 't' && !e.shiftKey && !e.altKey) {
          // Ctrl/Cmd+T: 새 터미널 (같은 사건, claude 실행)
          e.stopPropagation()
          onNewTermRef.current?.()
          return false
        }
        if (k === 'w' && !e.shiftKey && !e.altKey) {
          // Ctrl/Cmd+W: 이 터미널 닫기 (작업 중이면 App에서 확인).
          e.stopPropagation()
          onCloseRef.current?.()
          return false
        }
        if (k === 'tab') {
          // Ctrl/Cmd+Tab / Ctrl/Cmd+Shift+Tab: 터미널 탭 순환
          e.stopPropagation()
          onCycleRef.current?.(e.shiftKey ? -1 : 1)
          return false
        }
        if (k === 'pageup' || k === 'pagedown') {
          // Ctrl/Cmd+PageUp/PageDown: 터미널 탭 이동
          e.stopPropagation()
          onCycleRef.current?.(k === 'pageup' ? -1 : 1)
          return false
        }
        if (k === 'f' && !e.shiftKey && !e.altKey) {
          e.stopPropagation()
          openFind()
          return false
        }
        if (k === 'c') {
          const sel = term.getSelection()
          if (sel && (e.shiftKey || !e.altKey)) {
            // 선택이 있으면 복사하고 차단 (선택 없을 땐 통과 → Ctrl+C 인터럽트 유지)
            navigator.clipboard.writeText(sel)
            return false
          }
          if (isMac) return false // 선택 없는 Cmd+C는 셸 인터럽트로 보내지 않는다. Ctrl+C는 위 primary 조건 밖이라 통과.
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
      const onPaste = (ev: ClipboardEvent): void => {
        const txt = ev.clipboardData?.getData('text/plain')
        if (!txt) return
        ev.preventDefault()
        ev.stopPropagation()
        pasteText(txt)
      }
      mount.addEventListener('paste', onPaste, true)

      // 진행중/완료 감지:
      // claude는 작업 중 "esc to interrupt" 스피너를 계속 그린다 → 그게 보이면 working.
      // 원격 SSH에서는 화면 갱신이 뭉쳐 도착할 수 있으므로 충분히 조용해진 뒤에만 done으로 본다.
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let working = false
      let recent = '' // 최근 출력(ANSI 제거 전) — 질문/확인 프롬프트 감지용
      let lastBusyAt = 0
      const idleMs = ssh ? 6000 : 2500
      const BUSY_RE = /to interrupt/i
      // claude 권한/확인 프롬프트 패턴
      const QUESTION_RE =
        /(do you want to|would you like to|continue\?|❯\s*1\.|\b1\.\s*yes\b|\(y\/n\)|\by\/n\b)/i
      const stripAnsi = (s: string): string => s.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
      const scheduleIdle = (delay = idleMs): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(goIdle, delay)
      }
      const goIdle = (): void => {
        if (!working) return
        const isQuestion = QUESTION_RE.test(stripAnsi(recent))
        if (!isQuestion && Date.now() - lastBusyAt < idleMs) {
          scheduleIdle(idleMs - (Date.now() - lastBusyAt))
          return
        }
        working = false
        onStatusRef.current?.(isQuestion ? 'question' : 'done')
      }
      const offData = window.lt.pty.onData((p) => {
        if (p.id !== id) return
        term.write(p.data)
        if (findOpenRef.current && findQueryRef.current.trim()) {
          window.setTimeout(() => applyFind(findQueryRef.current, findIndexRef.current), 0)
        }
        const busy = BUSY_RE.test(stripAnsi(p.data))
        if (busy && !working) {
          working = true
          recent = ''
          onStatusRef.current?.('working')
        }
        if (busy || working) {
          if (busy) lastBusyAt = Date.now()
          recent = (recent + p.data).slice(-4000)
          scheduleIdle(QUESTION_RE.test(stripAnsi(recent)) ? 500 : idleMs)
        }
      })
      const offExit = window.lt.pty.onExit((p) => {
        if (p.id === id) term.write(`\r\n\x1b[90m[프로세스 종료: ${p.exitCode}]\x1b[0m\r\n`)
      })
      const onInput = term.onData((data) => window.lt.pty.write(id, data))
      // Claude의 BEL은 완료뿐 아니라 권한/확인 프롬프트에서도 울릴 수 있으므로 즉시 완료로 보지 않는다.
      const onBellDisp = term.onBell(() => {
        if (working) scheduleIdle(QUESTION_RE.test(stripAnsi(recent)) ? 500 : idleMs)
      })

      window.lt.pty.create({
        id,
        cwd,
        cols: term.cols,
        rows: term.rows,
        autoLaunchClaude: autoClaude,
        resumeSessionId,
        ssh
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
        mount.removeEventListener('paste', onPaste, true)
        ro.disconnect()
        cleanupWindowsImeCorrection()
        window.lt.pty.detach(id)
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

  useEffect(() => {
    if (!visible || focusNonce === 0) return
    const raf = requestAnimationFrame(() => {
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [focusNonce, visible])

  useEffect(() => {
    if (findOpen) applyFind(findQuery, 0)
    else termRef.current?.clearSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery])

  return (
    <div className="terminal-surface">
      <div className="xterm-host" ref={hostRef} />
      {findOpen && (
        <FindBar
          value={findQuery}
          placeholder="터미널에서 찾기"
          resultLabel={findQuery.trim() ? (findCount ? `${findIndex + 1}/${findCount}` : '0/0') : ''}
          onChange={(value) => {
            setFindQueryState(value)
            setFindIndexState(0)
          }}
          onPrev={() => applyFind(findQuery, findIndex - 1)}
          onNext={() => applyFind(findQuery, findIndex + 1)}
          onClose={() => {
            setFindOpenState(false)
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
