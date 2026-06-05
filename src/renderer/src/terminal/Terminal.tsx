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

const normalizeTerminalCopyText = (text: string): string => text.replace(/(^|[\r\n]) {2}/g, '$1')

const WIN_IME_FIX_CLASS = 'lt-win-ime-fix'
const WIN_IME_COMPOSING_CLASS = 'lt-ime-composing'
const WIN_IME_FIXED_CLASS = 'lt-ime-fixed'
const CLAUDE_INPUT_PROMPT_RE = /^\s*(?:[│┃]\s*)?[›>]\s/

interface TerminalFindMatch {
  row: number
  col: number
  length: number
}

interface CellMetrics {
  width: number
  height: number
}

interface ImeAnchor {
  row: number
  col: number
}

interface TerminalCopyFeedback {
  key: number
  kind: 'success' | 'error'
  text: string
}

const charCellWidth = (ch: string): number => (ch.charCodeAt(0) <= 0x7f ? 1 : 2)
const textCellWidth = (text: string): number => Array.from(text).reduce((n, ch) => n + charCellWidth(ch), 0)
const stringIndexToCell = (text: string, index: number): number => textCellWidth(text.slice(0, index))
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

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

const measureCellMetrics = (term: XTerm): CellMetrics | null => {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const bounds = screen?.getBoundingClientRect()
  const width = bounds?.width ?? 0
  const height = bounds?.height ?? 0
  if (!width || !height || !term.cols || !term.rows) return null
  return { width: width / term.cols, height: height / term.rows }
}

const cursorViewportRow = (term: XTerm): number => {
  const buffer = term.buffer.active
  return buffer.baseY + buffer.cursorY - buffer.viewportY
}

const cursorAnchor = (term: XTerm): ImeAnchor | null => {
  const row = cursorViewportRow(term)
  if (row < 0 || row >= term.rows) return null
  return {
    row,
    col: clamp(term.buffer.active.cursorX, 0, Math.max(0, term.cols - 1))
  }
}

const findClaudeInputAnchor = (
  term: XTerm,
  previous: ImeAnchor | null,
  preferCursor: boolean
): ImeAnchor | null => {
  const buffer = term.buffer.active
  const cursorRow = cursorViewportRow(term)
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    if (!CLAUDE_INPUT_PROMPT_RE.test(line)) continue

    const promptIndex = line.search(/[›>]/)
    const promptCol = promptIndex >= 0 ? stringIndexToCell(line, promptIndex + 2) : 2
    const col =
      preferCursor && cursorRow === row
        ? Math.max(promptCol, buffer.cursorX)
        : previous?.row === row
          ? previous.col
          : promptCol

    return {
      row,
      col: clamp(col, 0, Math.max(0, term.cols - 1))
    }
  }
  return null
}

interface WindowsImeCorrectionHandle {
  setClaudeWorking: (value: boolean) => void
  dispose: () => void
}

const installWindowsImeCorrection = (term: XTerm, platform: string): WindowsImeCorrectionHandle => {
  if (platform !== 'win32' || !term.element || !term.textarea) {
    return { setClaudeWorking: () => {}, dispose: () => {} }
  }

  const element = term.element
  const textarea = term.textarea
  let active = true
  let claudeWorking = false
  let inputAnchor: ImeAnchor | null = null
  element.classList.add(WIN_IME_FIX_CLASS)

  const refreshInputAnchor = (preferCursor: boolean): ImeAnchor | null => {
    const promptAnchor = findClaudeInputAnchor(term, inputAnchor, preferCursor)
    if (promptAnchor) {
      inputAnchor = promptAnchor
    } else if (preferCursor) {
      inputAnchor = cursorAnchor(term) ?? inputAnchor
    }
    return inputAnchor
  }

  const clearFixedAnchor = (): void => {
    element.classList.remove(WIN_IME_FIXED_CLASS)
    element.style.removeProperty('--lt-ime-anchor-left')
    element.style.removeProperty('--lt-ime-anchor-top')
  }

  const syncCorrection = (): void => {
    if (!active || !element.classList.contains(WIN_IME_COMPOSING_CLASS)) return
    const metrics = measureCellMetrics(term)
    const cursorX = term.buffer.active.cursorX
    const offset = metrics && cursorX > 0 ? metrics.width : 0
    element.style.setProperty('--lt-ime-cell-width', `${offset}px`)

    const anchor = refreshInputAnchor(!claudeWorking)
    if (claudeWorking && metrics && anchor) {
      const fixedRow = clamp(anchor.row, 0, Math.max(0, term.rows - 1))
      const fixedCol = clamp(anchor.col, 0, Math.max(0, term.cols - 1))
      element.classList.add(WIN_IME_FIXED_CLASS)
      element.style.setProperty('--lt-ime-anchor-left', `${fixedCol * metrics.width}px`)
      element.style.setProperty('--lt-ime-anchor-top', `${fixedRow * metrics.height}px`)
    } else {
      clearFixedAnchor()
    }
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
    clearFixedAnchor()
  }

  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionupdate', onCompositionUpdate)
  textarea.addEventListener('compositionend', onCompositionEnd)
  textarea.addEventListener('blur', onCompositionEnd)
  const renderSync = term.onRender(() => {
    refreshInputAnchor(!claudeWorking)
    syncCorrection()
  })
  const resizeSync = term.onResize(() => {
    refreshInputAnchor(!claudeWorking)
    syncCorrection()
  })

  return {
    setClaudeWorking: (value: boolean): void => {
      claudeWorking = value
      refreshInputAnchor(!value)
      if (!value) clearFixedAnchor()
      else scheduleCorrection()
    },
    dispose: (): void => {
      active = false
      textarea.removeEventListener('compositionstart', onCompositionStart)
      textarea.removeEventListener('compositionupdate', onCompositionUpdate)
      textarea.removeEventListener('compositionend', onCompositionEnd)
      textarea.removeEventListener('blur', onCompositionEnd)
      renderSync.dispose()
      resizeSync.dispose()
      element.classList.remove(WIN_IME_FIX_CLASS, WIN_IME_COMPOSING_CLASS, WIN_IME_FIXED_CLASS)
      element.style.removeProperty('--lt-ime-cell-width')
      element.style.removeProperty('--lt-ime-anchor-left')
      element.style.removeProperty('--lt-ime-anchor-top')
    }
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
  onBracketedPasteModeChange,
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
  onBracketedPasteModeChange?: (enabled: boolean) => void
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
  const onBracketedPasteModeChangeRef = useRef(onBracketedPasteModeChange)
  onBracketedPasteModeChangeRef.current = onBracketedPasteModeChange
  const onCycleRef = useRef(onCycleTab)
  onCycleRef.current = onCycleTab
  const findOpenRef = useRef(false)
  const findQueryRef = useRef('')
  const findIndexRef = useRef(-1)
  const copyFeedbackSeq = useRef(0)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileDropHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIndex, setFindIndex] = useState(-1)
  const [copyFeedback, setCopyFeedback] = useState<TerminalCopyFeedback | null>(null)
  const [fileDropHint, setFileDropHint] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      if (fileDropHintTimerRef.current) clearTimeout(fileDropHintTimerRef.current)
    }
  }, [])

  const showCopyFeedback = (kind: TerminalCopyFeedback['kind']): void => {
    if (!mountedRef.current) return
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    setCopyFeedback({
      key: ++copyFeedbackSeq.current,
      kind,
      text: kind === 'success' ? '복사 완료' : '복사 실패'
    })
    copyFeedbackTimerRef.current = setTimeout(
      () => {
        if (mountedRef.current) setCopyFeedback(null)
      },
      kind === 'success' ? 1400 : 2400
    )
  }
  const showFileDropHint = (): void => {
    if (!mountedRef.current) return
    setFileDropHint(true)
    if (fileDropHintTimerRef.current) clearTimeout(fileDropHintTimerRef.current)
    fileDropHintTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setFileDropHint(false)
    }, 200)
  }
  const clearFileDropHint = (): void => {
    if (fileDropHintTimerRef.current) clearTimeout(fileDropHintTimerRef.current)
    fileDropHintTimerRef.current = null
    if (mountedRef.current) setFileDropHint(false)
  }

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
      showFileDropHint()
    }
    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer
      if (!wanted(dt)) return
      e.preventDefault()
      e.stopPropagation()
      clearFileDropHint()
      const internal = dt!.getData(LT_PATH)
      const paths = internal
        ? [internal]
        : Array.from(dt!.files)
            .map((f) => window.lt.fs.pathForFile(f))
            .filter(Boolean)
      if (paths.length) onDropRef.current?.(paths)
    }
    const onLeave = (e: DragEvent): void => {
      if (host.contains(e.relatedTarget as Node | null)) return
      clearFileDropHint()
    }
    host.addEventListener('dragenter', allow, true)
    host.addEventListener('dragover', allow, true)
    host.addEventListener('dragleave', onLeave, true)
    host.addEventListener('drop', onDrop, true)
    return () => {
      host.removeEventListener('dragenter', allow, true)
      host.removeEventListener('dragover', allow, true)
      host.removeEventListener('dragleave', onLeave, true)
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
        theme: {
          background: '#181818',
          foreground: '#cccccc',
          cursor: '#cccccc',
          blue: '#8cc8ff',
          brightBlue: '#b9ddff'
        }
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
      const windowsImeCorrection = installWindowsImeCorrection(term, appInfo.platform)
      let bracketedPasteMode = term.modes.bracketedPasteMode
      onBracketedPasteModeChangeRef.current?.(bracketedPasteMode)
      const emitBracketedPasteMode = (): void => {
        const next = term.modes.bracketedPasteMode
        if (next === bracketedPasteMode) return
        bracketedPasteMode = next
        onBracketedPasteModeChangeRef.current?.(next)
      }
      const onWriteParsedDisp = term.onWriteParsed(emitBracketedPasteMode)
      // 새 터미널 생성 직후 활성 탭이면 바로 포커스 (커서가 그 터미널 안에 들어가게)
      if (visible) term.focus()

      // 붙여넣기는 xterm에 맡긴다. xterm은 대상 프로그램이 bracketed paste를 켠 경우에만 감싼다.
      const pasteText = (txt: string): void => {
        if (txt) term.paste(txt)
      }
      let suppressNativePasteEvent = false
      let suppressNativePasteTimer: ReturnType<typeof setTimeout> | null = null
      const suppressNextNativePasteEvent = (): void => {
        suppressNativePasteEvent = true
        if (suppressNativePasteTimer) clearTimeout(suppressNativePasteTimer)
        suppressNativePasteTimer = setTimeout(() => {
          suppressNativePasteEvent = false
          suppressNativePasteTimer = null
        }, 500)
      }
      const pasteFromClipboard = (): void => {
        navigator.clipboard.readText().then((txt) => {
          pasteText(txt)
        })
      }
      const copySelection = (): boolean => {
        const sel = normalizeTerminalCopyText(term.getSelection())
        if (!sel) return false
        if (!navigator.clipboard?.writeText) {
          showCopyFeedback('error')
          return true
        }
        void navigator.clipboard
          .writeText(sel)
          .then(() => showCopyFeedback('success'))
          .catch(() => showCopyFeedback('error'))
        return true
      }
      // 복사/붙여넣기 키 처리. true=xterm/pty로 전달, false=가로채서 기본동작 차단.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        const k = e.key.toLowerCase()
        if (k === 'c' && e.ctrlKey && !e.metaKey && term.hasSelection() && (e.shiftKey || !e.altKey)) {
          copySelection()
          return false
        }
        const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey
        if (!primary) return true
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
          if (term.hasSelection() && (e.shiftKey || !e.altKey)) {
            // 선택이 있으면 복사하고 차단 (선택 없을 땐 통과 → Ctrl+C 인터럽트 유지)
            copySelection()
            return false
          }
          if (isMac) return false // 선택 없는 Cmd+C는 셸 인터럽트로 보내지 않는다. Ctrl+C는 위 primary 조건 밖이라 통과.
          if (e.shiftKey) return false // Ctrl+Shift+C: 선택 없으면 무동작
          return true // 선택 없는 Ctrl+C → 인터럽트
        }
        if (k === 'v') {
          suppressNextNativePasteEvent()
          pasteFromClipboard()
          return false
        }
        return true
      })
      // 우클릭: 선택 있으면 복사, 없으면 붙여넣기 (VS Code 터미널과 동일)
      const onCtx = (ev: MouseEvent): void => {
        ev.preventDefault()
        if (copySelection()) {
          term.clearSelection()
        } else {
          pasteFromClipboard()
        }
      }
      mount.addEventListener('contextmenu', onCtx)
      const onCopy = (ev: ClipboardEvent): void => {
        const sel = normalizeTerminalCopyText(term.getSelection())
        if (!sel) return
        ev.preventDefault()
        ev.stopPropagation()
        if (!ev.clipboardData) {
          showCopyFeedback('error')
          return
        }
        ev.clipboardData.setData('text/plain', sel)
        showCopyFeedback('success')
      }
      mount.addEventListener('copy', onCopy, true)
      const onPaste = (ev: ClipboardEvent): void => {
        ev.preventDefault()
        ev.stopPropagation()
        if (suppressNativePasteEvent) {
          suppressNativePasteEvent = false
          if (suppressNativePasteTimer) {
            clearTimeout(suppressNativePasteTimer)
            suppressNativePasteTimer = null
          }
          return
        }
        const txt = ev.clipboardData?.getData('text/plain')
        if (!txt) return
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
        windowsImeCorrection.setClaudeWorking(false)
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
          windowsImeCorrection.setClaudeWorking(true)
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
        onWriteParsedDisp.dispose()
        if (idleTimer) clearTimeout(idleTimer)
        if (suppressNativePasteTimer) clearTimeout(suppressNativePasteTimer)
        mount.removeEventListener('contextmenu', onCtx)
        mount.removeEventListener('copy', onCopy, true)
        mount.removeEventListener('paste', onPaste, true)
        ro.disconnect()
        windowsImeCorrection.dispose()
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
    <div className={`terminal-surface ${fileDropHint ? 'file-drop-target' : ''}`}>
      <div className="xterm-host" ref={hostRef} />
      {fileDropHint && (
        <div className="drop-guide terminal-drop-guide" role="status" aria-live="polite">
          <strong>Claude에 파일 전달</strong>
          <span>파일 경로와 질문 초안을 현재 터미널에 삽입</span>
        </div>
      )}
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
      {copyFeedback && (
        <div
          key={copyFeedback.key}
          className={`terminal-copy-feedback ${copyFeedback.kind}`}
          role="status"
          aria-live="polite"
        >
          {copyFeedback.text}
        </div>
      )}
    </div>
  )
}
