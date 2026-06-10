import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Decoration, EditorView, keymap, drawSelection, dropCursor, type DecorationSet } from '@codemirror/view'
import {
  EditorSelection,
  EditorState,
  Compartment,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { livePreview } from './livePreview'
import { mdToPrintHtml, type PrintLayoutProfile } from './mdExport'
import FindBar from '../search/FindBar'
import { IconSave, IconSaveAs, IconSearch } from '../icons/Icons'
import { writeMarkdownDataTransfer } from '../markdownClipboard'

const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"
const DEFAULT_UNTITLED_NAME = '무제.md'
export const TEXT_SELECTION_OVERLAY_EVENT = 'lt:text-selection-overlay'

export interface TextSelectionOverlayDetail {
  x: number
  y: number
  text: string
  markdown?: string
  count: number
}

interface TextReplacement {
  from: number
  to: number
  insert: string
}

interface PositionBookmark {
  line: number
  column: number
}

interface SelectionBookmark {
  ranges: { anchor: PositionBookmark; head: PositionBookmark }[]
  mainIndex: number
}

interface ViewportBookmark {
  pos: number
  topOffset: number | null
  scrollTop: number
  scrollLeft: number
}

interface EditorFindRange {
  from: number
  to: number
  active: boolean
}

const setFindDecorations = StateEffect.define<EditorFindRange[]>()

const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFindDecorations)) continue
      const builder = new RangeSetBuilder<Decoration>()
      for (const range of effect.value) {
        builder.add(
          range.from,
          range.to,
          Decoration.mark({ class: range.active ? 'cm-find-match cm-find-active' : 'cm-find-match' })
        )
      }
      next = builder.finish()
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

function findEditorRanges(text: string, query: string): { from: number; to: number }[] {
  const needle = query.trim()
  if (!needle) return []
  const haystack = text.toLocaleLowerCase('ko-KR')
  const target = needle.toLocaleLowerCase('ko-KR')
  const out: { from: number; to: number }[] = []
  let index = haystack.indexOf(target)
  while (index >= 0 && out.length < 2000) {
    out.push({ from: index, to: index + needle.length })
    index = haystack.indexOf(target, index + Math.max(needle.length, 1))
  }
  return out
}

export interface MarkdownDocumentPayload {
  title: string
  path?: string
  markdown: string
}

function makeTheme(family: string, size: number): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': { height: '100%', fontSize: `${size}px` },
      '.cm-scroller': { fontFamily: family, lineHeight: '1.7', overflow: 'auto' },
      '.cm-content': { padding: '12px 16px', caretColor: '#fff' },
      '.cm-gutters': { display: 'none' },
      '&.cm-focused': { outline: 'none' }
    },
    { dark: true }
  )
}

function isRemotePath(value?: string): boolean {
  return !!value && value.startsWith('ssh://')
}

function fileNameOf(value?: string): string | undefined {
  return value?.split(/[\\/]/).pop() || undefined
}

function joinDefaultPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

function defaultSaveName(title?: string): string {
  const name = title?.trim().replace(/[\\/]+/g, '-')
  return name || DEFAULT_UNTITLED_NAME
}

function saveAsDefaultPath(
  currentPath?: string,
  defaultDir?: string,
  title?: string
): string | undefined {
  if (currentPath && !isRemotePath(currentPath)) return currentPath
  const name = fileNameOf(currentPath) ?? defaultSaveName(title)
  if (defaultDir && !isRemotePath(defaultDir)) return joinDefaultPath(defaultDir, name)
  return name
}

function findMinimalReplacement(current: string, next: string): TextReplacement | null {
  if (current === next) return null
  const limit = Math.min(current.length, next.length)
  let prefix = 0
  while (prefix < limit && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++

  let currentSuffix = current.length
  let nextSuffix = next.length
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    current.charCodeAt(currentSuffix - 1) === next.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix--
    nextSuffix--
  }

  return { from: prefix, to: currentSuffix, insert: next.slice(prefix, nextSuffix) }
}

function bookmarkPosition(state: EditorState, pos: number): PositionBookmark {
  const line = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)))
  return { line: line.number, column: pos - line.from }
}

function restorePosition(state: EditorState, bookmark: PositionBookmark): number {
  const line = state.doc.line(Math.max(1, Math.min(bookmark.line, state.doc.lines)))
  return Math.min(line.from + bookmark.column, line.to)
}

function bookmarkSelection(state: EditorState): SelectionBookmark {
  return {
    mainIndex: state.selection.mainIndex,
    ranges: state.selection.ranges.map((range) => ({
      anchor: bookmarkPosition(state, range.anchor),
      head: bookmarkPosition(state, range.head)
    }))
  }
}

function restoreSelection(state: EditorState, bookmark: SelectionBookmark): EditorSelection {
  const ranges = bookmark.ranges.map((range) =>
    EditorSelection.range(restorePosition(state, range.anchor), restorePosition(state, range.head))
  )
  return EditorSelection.create(ranges, Math.min(bookmark.mainIndex, ranges.length - 1))
}

function changeCoversSelection(changes: ChangeDesc, selection: EditorSelection): boolean {
  return selection.ranges.some((range) => changes.touchesRange(range.from, range.to) === 'cover')
}

function editorSelectionOverlay(view: EditorView): TextSelectionOverlayDetail | null {
  const text = selectedMarkdown(view)
  const visibleText = text.trim()
  if (!visibleText) return null

  const main = view.state.selection.main
  const from = Math.min(main.from, main.to)
  const to = Math.max(main.from, main.to)
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to)
  const first = start ?? end
  if (!first) return null

  const editorRect = view.scrollDOM.getBoundingClientRect()
  const sameLine = !!start && !!end && Math.abs(start.top - end.top) < 4
  const rawX = sameLine && start && end ? (start.left + end.right) / 2 : first.left + 16
  return {
    x: Math.min(Math.max(rawX, editorRect.left + 8), editorRect.right - 8),
    y: first.top - 6,
    text,
    markdown: text,
    count: Array.from(visibleText).length
  }
}

function selectedMarkdown(view: EditorView): string {
  const ranges = view.state.selection.ranges.filter((range) => !range.empty)
  return ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join('\n')
}

function emitEditorSelectionOverlay(view: EditorView): void {
  window.dispatchEvent(
    new CustomEvent<TextSelectionOverlayDetail | null>(TEXT_SELECTION_OVERLAY_EVENT, {
      detail: editorSelectionOverlay(view)
    })
  )
}

function captureViewport(view: EditorView): ViewportBookmark {
  const scroller = view.scrollDOM
  const rect = scroller.getBoundingClientRect()
  const pos = view.posAtCoords({ x: rect.left + Math.min(24, rect.width / 2), y: rect.top + 8 }, false)
  const coords = view.coordsAtPos(pos)
  return {
    pos,
    topOffset: coords ? coords.top - rect.top : null,
    scrollTop: scroller.scrollTop,
    scrollLeft: scroller.scrollLeft
  }
}

function restoreViewport(view: EditorView, bookmark: ViewportBookmark, changes: ChangeDesc): void {
  const mappedPos = Math.max(0, Math.min(changes.mapPos(bookmark.pos, 1), view.state.doc.length))
  window.requestAnimationFrame(() => {
    const scroller = view.scrollDOM
    scroller.scrollLeft = bookmark.scrollLeft
    if (bookmark.topOffset == null) {
      scroller.scrollTop = bookmark.scrollTop
      return
    }
    const rect = scroller.getBoundingClientRect()
    const coords = view.coordsAtPos(mappedPos)
    if (!coords) {
      scroller.scrollTop = bookmark.scrollTop
      return
    }
    scroller.scrollTop += coords.top - rect.top - bookmark.topOffset
  })
}

/**
 * 마크다운 편집기 (CodeMirror 6). 서식(라이브 프리뷰)·원본 두 모드 모두 편집 가능.
 * 입력 후 자동 작업은 복구용 임시저장만 수행한다. 실제 파일 저장은 Ctrl+S/저장 버튼에서만 한다.
 */
export default function MarkdownEditor({
  title,
  path,
  draftId,
  defaultDir,
  onPath,
  onAsk,
  onSendToJuriSupport,
  onDirty
}: {
  title?: string
  path?: string
  draftId: string
  defaultDir?: string
  onPath?: (path: string) => void
  onAsk?: (savedPath?: string) => void
  onSendToJuriSupport?: (doc: MarkdownDocumentPayload) => void
  // 실제 파일에 저장되지 않은 변경사항이 있으면 닫기 전 알린다
  onDirty?: (dirty: boolean) => void
}): JSX.Element {
  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const previewComp = useRef(new Compartment())
  const pathRef = useRef<string | undefined>(path)
  const titleRef = useRef(title)
  const draftIdRef = useRef(draftId)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRef = useRef(!!path)
  const savedContentRef = useRef('')
  const localDirtyRef = useRef(false)
  const applyingRemoteRef = useRef(false)
  const remoteSigRef = useRef('')
  const remoteAppliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const findOpenRef = useRef(false)
  const findQueryRef = useRef('')
  const findIndexRef = useRef(-1)
  const applyFindRef = useRef<(query: string, requestedIndex: number) => void>(() => {})
  const openFindRef = useRef<() => void>(() => {})
  const [preview, setPreview] = useState(true)
  const [err, setErr] = useState('')
  const [saveError, setSaveError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [remoteApplied, setRemoteApplied] = useState(false)
  const [saved, setSaved] = useState(!!path)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIndex, setFindIndex] = useState(-1)
  const [printLayout, setPrintLayout] = useState<PrintLayoutProfile>('default')

  const setSavedState = (value: boolean): void => {
    savedRef.current = value
    setSaved(value)
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

  const pulseRemoteApplied = (): void => {
    setRemoteApplied(true)
    if (remoteAppliedTimer.current) clearTimeout(remoteAppliedTimer.current)
    remoteAppliedTimer.current = setTimeout(() => {
      remoteAppliedTimer.current = null
      setRemoteApplied(false)
    }, 1200)
  }

  const clearFindDecorations = (): void => {
    viewRef.current?.dispatch({ effects: setFindDecorations.of([]) })
    setFindCount(0)
    setFindIndexState(-1)
  }

  const applyFind = (query: string, requestedIndex: number): void => {
    const view = viewRef.current
    if (!view) return
    const ranges = findEditorRanges(view.state.doc.toString(), query)
    const index = ranges.length
      ? (requestedIndex < 0 ? 0 : (requestedIndex + ranges.length) % ranges.length)
      : -1
    setFindCount(ranges.length)
    setFindIndexState(index)
    view.dispatch({
      effects: setFindDecorations.of(
        ranges.map((range, i) => ({ ...range, active: i === index }))
      ),
      ...(index >= 0
        ? {
            selection: EditorSelection.range(ranges[index].from, ranges[index].to),
            scrollIntoView: true
          }
        : {})
    })
  }
  applyFindRef.current = applyFind

  const openFind = (): void => {
    const view = viewRef.current
    if (view) {
      const sel = view.state.selection.main
      if (!sel.empty) {
        const selected = view.state.sliceDoc(sel.from, sel.to)
        if (selected.length <= 120 && !/[\r\n]/.test(selected)) setFindQueryState(selected)
      }
    }
    setFindOpenState(true)
    setFindIndexState(0)
  }
  openFindRef.current = openFind

  const refreshSavedSignature = (targetPath: string): void => {
    window.lt.fs.stat(targetPath).then((s) => {
      if (s.ok && pathRef.current === targetPath) remoteSigRef.current = `${s.size}:${s.mtimeMs ?? 0}`
    })
  }

  const draftIdentity = (targetPath = pathRef.current): { path?: string; draftId: string } => ({
    path: targetPath,
    draftId: draftIdRef.current
  })

  const deleteDraft = (targetPath = pathRef.current): void => {
    void window.lt.fs.deleteDocumentDraft(draftIdentity(targetPath)).catch(() => {})
  }

  const deleteScratchDraft = (): void => {
    void window.lt.fs.deleteDocumentDraft({ draftId: draftIdRef.current }).catch(() => {})
  }

  const setDirtyState = (value: boolean): void => {
    localDirtyRef.current = value
    setDirty(value)
    onDirtyRef.current?.(value)
  }

  const markSaved = (targetPath: string, content: string): void => {
    savedContentRef.current = content
    localDirtyRef.current = false
    setDirty(false)
    setSaveError('')
    setDraftSaved(false)
    setDraftSaving(false)
    setSavedState(true)
    onDirtyRef.current?.(false)
    refreshSavedSignature(targetPath)
    deleteDraft(targetPath)
  }

  const saveAsNow = (): Promise<string | undefined> => {
    const v = viewRef.current
    if (!v) return Promise.resolve(undefined)
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const content = v.state.doc.toString()
    const previousPath = pathRef.current
    setSaveError('')
    return window.lt.fs.saveAs(content, saveAsDefaultPath(pathRef.current, defaultDir, title)).then((r) => {
      if (r.ok && r.path) {
        pathRef.current = r.path
        onPath?.(r.path)
        markSaved(r.path, content)
        if (previousPath && previousPath !== r.path) deleteDraft(previousPath)
        if (!previousPath) deleteScratchDraft()
        return r.path
      }
      if (r.error) setSaveError(r.error)
      return undefined
    })
  }

  const saveNow = (): Promise<string | undefined> => {
    const v = viewRef.current
    if (!v) return Promise.resolve(undefined)
    if (!pathRef.current) {
      return saveAsNow()
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const targetPath = pathRef.current
    const content = v.state.doc.toString()
    setSaveError('')
    return window.lt.fs.writeText(targetPath, content).then((r) => {
      if (pathRef.current !== targetPath) return undefined
      if (!r.ok) {
        setSaveError(r.error ?? '저장 실패')
        setSavedState(false)
        return undefined
      }
      markSaved(targetPath, content)
      return targetPath
    })
  }
  const saveDraftNow = (updateState = true): Promise<void> => {
    const v = viewRef.current
    if (!v || !localDirtyRef.current) return Promise.resolve()
    const content = v.state.doc.toString()
    if (!content && !pathRef.current) {
      deleteDraft()
      if (updateState) {
        setDraftSaved(false)
        setDraftSaving(false)
      }
      return Promise.resolve()
    }
    if (updateState) setDraftSaving(true)
    return window.lt.fs
      .saveDocumentDraft({
        ...draftIdentity(),
        title: titleRef.current,
        content
      })
      .then((r) => {
        if (!r.ok) {
          if (updateState) {
            setSaveError(r.error ? `임시저장 실패: ${r.error}` : '임시저장 실패')
            setDraftSaved(false)
          }
          return
        }
        if (updateState) {
          setSaveError('')
          setDraftSaved(true)
        }
      })
      .catch((e) => {
        if (updateState) {
          setSaveError(`임시저장 실패: ${String(e)}`)
          setDraftSaved(false)
        }
      })
      .finally(() => {
        if (updateState) setDraftSaving(false)
      })
  }
  const scheduleDraftSave = (): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveDraftNow(), 700)
  }

  useEffect(() => {
    if (pathRef.current === path) return
    pathRef.current = path
    if (!localDirtyRef.current) setSavedState(!!path)
    if (path) refreshSavedSignature(path)
  }, [path])

  useEffect(() => {
    titleRef.current = title
  }, [title])

  useEffect(() => {
    let alive = true
    setErr('')
    const init = pathRef.current ? window.lt.fs.readText(pathRef.current) : Promise.resolve({ text: '' })
    Promise.all([init, window.lt.settings.get()])
      .then(async ([r, s]) => {
        if (!alive || !hostRef.current) return
        const baseText = (r as { text: string }).text
        let docText = baseText
        let restoredDraft = false
        const draftResult = await window.lt.fs.loadDocumentDraft(draftIdentity()).catch(() => null)
        if (!alive || !hostRef.current) return
        const draft = draftResult?.ok ? draftResult.draft : null
        if (draft && draft.content !== baseText) {
          const shouldRestore = pathRef.current
            ? window.confirm(
                `이 문서의 임시저장본이 있습니다.\n\n${draft.title}\n임시저장 시각: ${new Date(draft.savedAt).toLocaleString('ko-KR')}\n\n가져올까요?`
              )
            : true
          if (shouldRestore) {
            docText = draft.content
            restoredDraft = true
          } else {
            deleteDraft()
          }
        }
        savedContentRef.current = baseText
        const family = s.mdFont || DEFAULT_MD_FONT
        const size = s.mdFontSize || 14
        const state = EditorState.create({
          doc: docText,
          extensions: [
            history(),
            drawSelection(),
            dropCursor(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
              { key: 'Mod-f', run: () => (openFindRef.current(), true) },
              { key: 'Shift-Mod-s', run: () => (void saveAsNow(), true) },
              { key: 'Mod-s', run: () => (void saveNow(), true) }
            ]),
            markdown({ extensions: GFM }),
            syntaxHighlighting(defaultHighlightStyle),
            EditorView.lineWrapping,
            findHighlightField,
            makeTheme(family, size),
            previewComp.current.of(preview ? livePreview : []),
            EditorView.domEventHandlers({
              copy(event, view) {
                if (!event.clipboardData) return false
                const markdownText = selectedMarkdown(view)
                if (!writeMarkdownDataTransfer(event.clipboardData, markdownText, 'rich')) return false
                event.preventDefault()
                return true
              }
            }),
            EditorView.updateListener.of((u) => {
              if (u.selectionSet || u.docChanged || u.viewportChanged) emitEditorSelectionOverlay(u.view)
              if (u.docChanged) {
                if (applyingRemoteRef.current) {
                  savedContentRef.current = u.state.doc.toString()
                  setDirtyState(false)
                  setSavedState(true)
                  return
                }
                const current = u.state.doc.toString()
                const nextDirty = current !== savedContentRef.current
                setDirtyState(nextDirty)
                setSavedState(!nextDirty && !!pathRef.current)
                if (nextDirty) {
                  setDraftSaved(false)
                  scheduleDraftSave()
                } else {
                  if (saveTimer.current) {
                    clearTimeout(saveTimer.current)
                    saveTimer.current = null
                  }
                  setDraftSaved(false)
                  deleteDraft()
                }
                if (findOpenRef.current) {
                  window.setTimeout(
                    () => applyFindRef.current(findQueryRef.current, findIndexRef.current),
                    0
                  )
                }
              }
            })
          ]
        })
        setDirtyState(restoredDraft)
        setDraftSaved(restoredDraft)
        setSavedState(!restoredDraft && !!pathRef.current)
        viewRef.current = new EditorView({ state, parent: hostRef.current })
        viewRef.current.focus()
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      if (localDirtyRef.current) void saveDraftNow(false)
      if (remoteAppliedTimer.current) clearTimeout(remoteAppliedTimer.current)
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pathRef.current) return
    let alive = true
    const tick = (): void => {
      const currentPath = pathRef.current
      if (!currentPath) return
      window.lt.fs
        .stat(currentPath)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = `${s.size}:${s.mtimeMs ?? 0}`
          if (!remoteSigRef.current) {
            remoteSigRef.current = sig
            return
          }
          if (sig === remoteSigRef.current) return
          window.lt.fs
            .readText(currentPath)
            .then((r) => {
              if (!alive || r.kind !== 'text' || r.truncated) return
              const v = viewRef.current
              remoteSigRef.current = sig
              if (!v) return
              const next = r.text
              const current = v.state.doc.toString()
              if (next === current) {
                savedContentRef.current = next
                setDirtyState(false)
                setSavedState(true)
                return
              }
              if (localDirtyRef.current || !savedRef.current) return
              const replacement = findMinimalReplacement(current, next)
              if (!replacement) return
              const viewport = captureViewport(v)
              const selectionBookmark = bookmarkSelection(v.state)
              const previewTransaction = v.state.update({ changes: replacement })
              const scrollEffect = v.scrollSnapshot().map(previewTransaction.changes)
              const selection = changeCoversSelection(previewTransaction.changes, v.state.selection)
                ? restoreSelection(previewTransaction.state, selectionBookmark)
                : undefined
              applyingRemoteRef.current = true
              try {
                v.dispatch({
                  changes: previewTransaction.changes,
                  ...(selection ? { selection } : {}),
                  ...(scrollEffect ? { effects: [scrollEffect] } : {})
                })
                restoreViewport(v, viewport, previewTransaction.changes)
              } finally {
                applyingRemoteRef.current = false
              }
              savedContentRef.current = next
              setDirtyState(false)
              setSavedState(true)
              setDraftSaved(false)
              deleteDraft()
              pulseRemoteApplied()
            })
            .catch(() => {})
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: previewComp.current.reconfigure(preview ? livePreview : [])
    })
  }, [preview])

  useEffect(() => {
    if (findOpen) applyFind(findQuery, 0)
    else clearFindDecorations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery])

  if (err)
    return (
      <div className="welcome">
        <p className="muted">열기 실패: {err}</p>
      </div>
    )

  const onEditorKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLocaleLowerCase() !== 's') return
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) void saveAsNow()
    else void saveNow()
  }
  const saveStatus = saveError
    ? '저장 실패'
    : remoteApplied
      ? '외부 수정 반영됨'
      : dirty
        ? draftSaving
          ? '임시저장 중…'
          : draftSaved
            ? '임시저장됨 (Ctrl+S로 저장)'
            : '변경됨 (Ctrl+S로 저장)'
        : saved
          ? '저장됨'
          : '미저장 (Ctrl+S)'
  const isProofOfContentPrint = printLayout === 'proof-of-content'
  const printLayoutTitle = isProofOfContentPrint
    ? "내용증명 양식: 인쇄할 때 PDF 뷰어/프린터 옵션에서 '이미지로 인쇄'를 선택하세요."
    : 'PDF 출력 양식'
  const exportPdfTitle = isProofOfContentPrint
    ? "내용증명 PDF로 내보내기. 인쇄할 때 '이미지로 인쇄'를 선택하세요."
    : 'PDF로 내보내기'
  const exportPdfNow = (): void => {
    const v = viewRef.current
    if (!v) return
    const layout = printLayout
    const name = (pathRef.current?.split(/[\\/]/).pop() ?? '문서').replace(/\.[^.]+$/, '')
    const def =
      (pathRef.current?.replace(/\.[^.]+$/, '') ?? (defaultDir ? defaultDir + '\\' + name : name)) + '.pdf'
    void window.lt.export
      .mdToPdf(mdToPrintHtml(v.state.doc.toString(), name, layout), def)
      .then((r) => {
        if (!r.ok) {
          if (r.error) window.alert(`PDF 내보내기 실패: ${r.error}`)
          return
        }
        if (layout === 'proof-of-content') {
          window.alert("내용증명 PDF를 인쇄할 때는 PDF 뷰어/프린터 옵션에서 '이미지로 인쇄'를 선택하세요.")
        }
      })
      .catch((e) => window.alert(`PDF 내보내기 실패: ${String(e)}`))
  }

  return (
    <div className="text-doc" onKeyDown={onEditorKeyDown}>
      <div className="text-toolbar">
        <button className={`tb-btn ${preview ? 'on' : ''}`} title="서식(라이브 프리뷰)" onClick={() => setPreview(true)}>
          서식
        </button>
        <button className={`tb-btn ${!preview ? 'on' : ''}`} title="원본(소스)" onClick={() => setPreview(false)}>
          원본
        </button>
        <span className="tb-divider" />
        <button className="tb-btn" title="저장 (Ctrl/Cmd+S)" aria-label="저장" onClick={() => void saveNow()}>
          <IconSave size={14} />
        </button>
        <button
          className="tb-btn"
          title="다른 이름으로 저장 (Ctrl/Cmd+Shift+S)"
          aria-label="다른 이름으로 저장"
          onClick={() => void saveAsNow()}
        >
          <IconSaveAs size={14} />
        </button>
        <span className="tb-divider" />
        <select
          className="tb-select"
          title={printLayoutTitle}
          aria-label={printLayoutTitle}
          value={printLayout}
          onChange={(e) => setPrintLayout(e.target.value as PrintLayoutProfile)}
        >
          <option value="default">일반</option>
          <option value="proof-of-content">내용증명</option>
        </select>
        <button
          className="tb-btn"
          title={exportPdfTitle}
          onClick={exportPdfNow}
        >
          PDF
        </button>
        <button
          className={`tb-btn ${findOpen ? 'on' : ''}`}
          title="문서에서 찾기"
          onClick={openFind}
        >
          <IconSearch size={14} />
          <span className="sr-only">문서에서 찾기</span>
        </button>
        {onAsk && (
          <>
            <span className="tb-divider" />
            <button
              className="tb-btn"
              title="이 문서에 대해 Claude에 물어보기"
              onClick={() => {
                if (localDirtyRef.current) {
                  const ok = window.confirm(
                    '저장하지 않은 변경사항은 실제 파일에 저장되지 않았습니다.\n현재 저장본 기준으로 Claude에 물어볼까요?'
                  )
                  if (!ok) return
                }
                onAsk(pathRef.current)
              }}
            >
              ✳ Claude
            </button>
          </>
        )}
        {onSendToJuriSupport && (
          <>
            <span className="tb-divider" />
            <button
              className="tb-btn"
              title="JuriSupport 소송문서 작성 요청"
              onClick={() => {
                const v = viewRef.current
                if (!v) return
                const title = pathRef.current?.split(/[\\/]/).pop() ?? '무제.md'
                onSendToJuriSupport({
                  title,
                  path: pathRef.current,
                  markdown: v.state.doc.toString()
                })
              }}
            >
              JS 문서
            </button>
          </>
        )}
        <span
          className={`tb-sep-text ${saveError ? 'error' : remoteApplied ? 'remote' : ''}`}
          title={saveError || saveStatus}
        >
          {saveStatus}
        </span>
      </div>
      {findOpen && (
        <FindBar
          value={findQuery}
          placeholder="문서에서 찾기"
          resultLabel={findQuery.trim() ? (findCount ? `${findIndex + 1}/${findCount}` : '0/0') : ''}
          onChange={(value) => {
            setFindQueryState(value)
            setFindIndexState(0)
          }}
          onPrev={() => applyFind(findQuery, findIndex - 1)}
          onNext={() => applyFind(findQuery, findIndex + 1)}
          onClose={() => {
            setFindOpenState(false)
            viewRef.current?.focus()
          }}
        />
      )}
      <div
        className={`cm-host ${preview ? 'preview' : 'source'} ${remoteApplied ? 'remote-applied' : ''}`}
        ref={hostRef}
      />
    </div>
  )
}
